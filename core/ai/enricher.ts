/**
 * Criteria Enricher -- Anaho
 *
 * Enrichit un critere client avec des variantes lexicales (inclusions metier
 * et techniques) et des exclusions contextuelles, via un LLM local Ollama.
 *
 * Responsabilites UNIQUES de ce module :
 *   1. Valider l entree (EnricherInput via Zod)
 *   2. Verifier le cache avant tout appel LLM
 *   3. Construire un prompt structure demandant :
 *        business_signals / technical_signals / contextual_exclusions / evidence / confidence_score
 *   4. Appeler ILLMClient.call() et parser la reponse JSON
 *   5. Filtrer les exclusions naives (< 3 mots)
 *   6. Borner a MAX_AI_INCLUSIONS et MAX_AI_EXCLUSIONS
 *   7. Valider la sortie via EnricherOutputSchema
 *   8. Stocker en cache et retourner EnricherResult
 *
 * Ce module ne fait PAS :
 *   - D appel Supabase ou base de donnees
 *   - De mutation du critere entrant
 *   - De decision de scoring ou de branchement pipeline
 *   - De connexion reseau directe (delegue a ILLMClient)
 *
 * Regle : jamais de `any`. Toute donnee manquante -> valeur par defaut explicite.
 */

import { createHash } from 'crypto';

import { ILLMClient }   from './llm-client';
import { ICache }       from './cache';
import {
  EnricherInput,
  EnricherInputSchema,
  EnricherOutput,
  EnricherOutputSchema,
} from './schemas/enricher.schema';
import { LLMRequestSchema } from './schemas/llm-client.schema';
import {
  MAX_AI_INCLUSIONS,
  MAX_AI_EXCLUSIONS,
  MAX_LLM_PROMPT_CHARS,
} from './constants';

// --- Warning codes -----------------------------------------------------------

/**
 * Codes d avertissement non fataux retournes avec un resultat ok:true.
 * Permettent au code appelant de logger ou d alerter sans planter.
 */
export type EnricherWarningCode =
  | 'inclusions_truncated'
  | 'exclusions_truncated'
  | 'naive_exclusions_filtered'
  | 'cache_payload_invalid'
  | 'cache_store_failed';

export interface EnricherWarning {
  code:    EnricherWarningCode;
  message: string;
}

// --- Error codes -------------------------------------------------------------

export type EnricherErrorCode =
  | 'invalid_input'
  | 'prompt_too_long'
  | 'llm_error'
  | 'parse_error'
  | 'validation_error'
  | 'unknown';

export interface EnricherError {
  code:    EnricherErrorCode;
  message: string;
}

// --- Result discrimine -------------------------------------------------------

export type EnricherResult =
  | { ok: true;  output: EnricherOutput; warnings: EnricherWarning[] }
  | { ok: false; error:  EnricherError };

// --- Forme brute de la reponse LLM -------------------------------------------

/**
 * Forme attendue du JSON retourne par le LLM pour l enrichissement.
 * business_signals + technical_signals fusionnes -> proposed_inclusions.
 */
interface RawEnricherLLMResponse {
  business_signals:      string[];
  technical_signals:     string[];
  contextual_exclusions: string[];
  evidence:              string;
  confidence_score:      number;
}

function isRawEnricherLLMResponse(raw: unknown): raw is RawEnricherLLMResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    Array.isArray(r['business_signals'])      &&
    Array.isArray(r['technical_signals'])     &&
    Array.isArray(r['contextual_exclusions']) &&
    typeof r['evidence']        === 'string'  &&
    typeof r['confidence_score'] === 'number'
  );
}

// --- Log entry ---------------------------------------------------------------

export interface EnricherLogEntry {
  level:        'info' | 'warn' | 'error';
  event:        string;
  critere_id:   string;
  client_id:    string;
  model:        string;
  cache_hit?:   boolean;
  warnings?:    EnricherWarningCode[];
  error_code?:  EnricherErrorCode;
}

// --- Options -----------------------------------------------------------------

export interface CriteriaEnricherOptions {
  /** Identifiant du modele Ollama a utiliser (ex: "qwen2.5:14b"). */
  model:    string;
  /** Logger structure optionnel. Defaut : errors et warnings sur stderr. */
  logger?:  (entry: EnricherLogEntry) => void;
}

// --- CriteriaEnricher --------------------------------------------------------

export class CriteriaEnricher {
  private readonly model:  string;
  private readonly logger: (entry: EnricherLogEntry) => void;

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly cache:     ICache,
    options: CriteriaEnricherOptions,
  ) {
    this.model  = options.model;
    this.logger = options.logger ?? defaultEnricherLogger;
  }

  // --- enrich ----------------------------------------------------------------

  /**
   * Enrichit un critere client.
   * - Consulte le cache avant tout appel LLM.
   * - Si le payload cache est invalide, l ignore et refait un appel LLM.
   * - Retourne un resultat discrimine (ok: true | ok: false).
   * - Ne lance jamais d exception non geree.
   */
  async enrich(rawInput: unknown): Promise<EnricherResult> {
    // 1. Valider l entree
    const parsed = EnricherInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok:    false,
        error: { code: 'invalid_input', message: parsed.error.message },
      };
    }
    const input = parsed.data;

    // 1b. Initialiser preWarnings (cache_payload_invalid doit apparaitre dans le resultat)
    const preWarnings: EnricherWarning[] = [];

    // 2. Calculer la cle de cache (basee sur critere_valeur + model + task_type)
    const cacheKey = this.cache.computeKey({
      model:     this.model,
      task_type: 'enrichment',
      content:   input.critere_valeur,
    });

    // 3. Verifier le cache
    const cacheHit = this.cache.get(cacheKey, 'enrichment');
    if (cacheHit.hit) {
      const cached = this.tryParseCachedPayload(cacheHit.entry.payload);
      if (cached !== null) {
        this.log({
          level: 'info', event: 'enricher_cache_hit',
          critere_id: input.critere_id, client_id: input.client_id,
          model: this.model, cache_hit: true,
        });
        return { ok: true, output: cached, warnings: [] };
      }
      // Payload invalide -- ignorer le cache, continuer vers LLM
      preWarnings.push({ code: 'cache_payload_invalid', message: 'Payload cache invalide -- LLM appele en fallback' });
      this.log({
        level: 'warn', event: 'enricher_cache_payload_invalid',
        critere_id: input.critere_id, client_id: input.client_id,
        model: this.model, warnings: ['cache_payload_invalid'],
      });
    }

    // 4. Construire le prompt
    const prompt     = buildEnricherPrompt(input);
    const promptHash = computePromptHash(prompt);

    // 5. Verifier la taille du prompt avant tout appel LLM
    if (prompt.length > MAX_LLM_PROMPT_CHARS) {
      return {
        ok:    false,
        error: { code: 'prompt_too_long', message: `Prompt trop long (${prompt.length} chars > ${MAX_LLM_PROMPT_CHARS}). Reduire le critere ou le contexte.` },
      };
    }

    const llmReqParsed = LLMRequestSchema.safeParse({
      model:     this.model,
      prompt,
      task_type: 'enrichment',
    });
    if (!llmReqParsed.success) {
      return {
        ok:    false,
        error: { code: 'unknown', message: `LLMRequest invalide: ${llmReqParsed.error.message}` },
      };
    }

    const llmResult = await this.llmClient.call(llmReqParsed.data);

    if (!llmResult.ok) {
      this.log({
        level: 'error', event: 'enricher_llm_error',
        critere_id: input.critere_id, client_id: input.client_id,
        model: this.model, error_code: 'llm_error',
      });
      return {
        ok:    false,
        error: { code: 'llm_error', message: llmResult.error.message },
      };
    }

    // 6. Parser, valider, borner, mettre en cache
    return this.processLLMResponse(
      llmResult.value.content,
      llmResult.value.model,
      input,
      promptHash,
      cacheKey,
      preWarnings,
    );
  }

  // --- Helpers prives --------------------------------------------------------

  /**
   * Tente de deserialiser un payload cache en EnricherOutput valide.
   * Retourne null si le payload est corrompu ou invalide -- sans planter.
   */
  private tryParseCachedPayload(payload: string): EnricherOutput | null {
    try {
      const raw    = JSON.parse(payload) as unknown;
      const parsed = EnricherOutputSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Parse la reponse LLM, filtre, borne et valide via Zod.
   * Retourne EnricherResult (ok ou erreur).
   */
  private processLLMResponse(
    content:    string,
    llmModel:   string,
    input:      EnricherInput,
    promptHash: string,
    cacheKey:   string,
    preWarnings: EnricherWarning[] = [],
  ): EnricherResult {
    // Deserialiser le JSON brut
    let raw: unknown;
    try {
      raw = JSON.parse(content) as unknown;
    } catch {
      return {
        ok:    false,
        error: {
          code:    'parse_error',
          message: `Reponse LLM non parseable JSON: "${content.slice(0, 120)}"`,
        },
      };
    }

    // Verifier la structure attendue
    if (!isRawEnricherLLMResponse(raw)) {
      return {
        ok:    false,
        error: {
          code:    'parse_error',
          message: 'Reponse LLM manque des champs requis ' +
                   '(business_signals, technical_signals, contextual_exclusions, ' +
                   'evidence, confidence_score)',
        },
      };
    }

    const warnings: EnricherWarning[] = [...preWarnings];

    // Construire les inclusions candidates (business + technical)
    const rawInclusions: string[] = [
      ...raw.business_signals.filter((s): s is string => typeof s === 'string' && s.trim().length > 0),
      ...raw.technical_signals.filter((s): s is string => typeof s === 'string' && s.trim().length > 0),
    ];

    // Filtrer les exclusions naives (< 3 mots = trop generique)
    const rawExclusions = raw.contextual_exclusions.filter(
      (s): s is string => typeof s === 'string' && s.trim().length > 0,
    );
    const { kept: validExclusions, rejected: naiveRejected } = filterNaiveExclusions(rawExclusions);

    if (naiveRejected.length > 0) {
      warnings.push({
        code:    'naive_exclusions_filtered',
        message: `${naiveRejected.length} exclusion(s) trop generique(s) filtree(s): ${naiveRejected.join(', ')}`,
      });
    }

    // Borner les inclusions
    let proposed_inclusions = rawInclusions;
    if (rawInclusions.length > MAX_AI_INCLUSIONS) {
      proposed_inclusions = rawInclusions.slice(0, MAX_AI_INCLUSIONS);
      warnings.push({
        code:    'inclusions_truncated',
        message: `${rawInclusions.length} inclusions tronquees a ${MAX_AI_INCLUSIONS}`,
      });
    }

    // Borner les exclusions (apres filtrage naif)
    let proposed_exclusions = validExclusions;
    if (validExclusions.length > MAX_AI_EXCLUSIONS) {
      proposed_exclusions = validExclusions.slice(0, MAX_AI_EXCLUSIONS);
      warnings.push({
        code:    'exclusions_truncated',
        message: `${validExclusions.length} exclusions tronquees a ${MAX_AI_EXCLUSIONS}`,
      });
    }

    // Normaliser confidence_score dans [0, 1]
    const confidence_score = Math.min(1, Math.max(0, raw.confidence_score));

    // Construire le candidat EnricherOutput
    const candidate = {
      critere_id:          input.critere_id,
      client_id:           input.client_id,
      proposed_inclusions,
      proposed_exclusions,
      prompt_hash:         promptHash,
      confidence_score,
      evidence:            typeof raw.evidence === 'string' ? raw.evidence : '',
      source_type:         'llm'         as const,
      created_at:          new Date().toISOString(),
      model:               llmModel,
      task_type:           'enrichment'  as const,
    };

    const validated = EnricherOutputSchema.safeParse(candidate);
    if (!validated.success) {
      return {
        ok:    false,
        error: {
          code:    'validation_error',
          message: `Validation EnricherOutput echouee: ${validated.error.message}`,
        },
      };
    }

    const output = validated.data;

    // Stocker en cache (non fatal)
    try {
      this.cache.set(cacheKey, JSON.stringify(output), {
        model:     this.model,
        task_type: 'enrichment',
        tags: [
          `client_id:${input.client_id}`,
          `critere_id:${input.critere_id}`,
        ],
      });
    } catch {
      warnings.push({
        code:    'cache_store_failed',
        message: 'Impossible de stocker le resultat en cache (non fatal)',
      });
    }

    this.log({
      level:      warnings.length > 0 ? 'warn' : 'info',
      event:      'enricher_success',
      critere_id: input.critere_id,
      client_id:  input.client_id,
      model:      this.model,
      cache_hit:  false,
      warnings:   warnings.map(w => w.code),
    });

    return { ok: true, output, warnings };
  }

  private log(entry: EnricherLogEntry): void {
    this.logger(entry);
  }
}

// --- Fonctions pures exportees -----------------------------------------------

/**
 * Construit le prompt d enrichissement pour Ollama.
 * Demande explicitement business_signals, technical_signals,
 * contextual_exclusions (contextuelles, >= 3 mots), evidence et confidence_score.
 *
 * Exporte pour etre testable sans instancier CriteriaEnricher.
 */
export function buildEnricherPrompt(input: EnricherInput): string {
  const existingIncStr = input.existing_inclusions.length > 0
    ? `\nVariantes deja connues (ne pas redoubler) : ${input.existing_inclusions.join(', ')}`
    : '';
  const existingExcStr = input.existing_exclusions.length > 0
    ? `\nExclusions deja connues (ne pas redoubler) : ${input.existing_exclusions.join(', ')}`
    : '';
  const contextStr = input.business_context.length > 0
    ? `\nContexte metier du client : ${input.business_context}`
    : '';

  return (
    'Tu es un expert en marches publics algeriens.\n' +
    'Critere a enrichir : "' + input.critere_valeur + '"\n' +
    'Type : ' + input.critere_type + contextStr + existingIncStr + existingExcStr + '\n\n' +
    'Retourne UNIQUEMENT un objet JSON avec ces champs :\n' +
    '{\n' +
    '  "business_signals": [...],\n' +
    '  "technical_signals": [...],\n' +
    '  "contextual_exclusions": [...],\n' +
    '  "evidence": "...",\n' +
    '  "confidence_score": 0.0\n' +
    '}\n\n' +
    'Regles strictes :\n' +
    '- business_signals : variantes metier et sectorielles (synonymes, formulations alternatives). Max 6.\n' +
    '- technical_signals : variantes techniques (normes, certifications, abreviations). Max 6.\n' +
    '- contextual_exclusions : OBLIGATOIREMENT des phrases descriptives de 3 mots minimum.\n' +
    '  INTERDIT : un seul mot comme exclusion (ex: "achat" est refuse).\n' +
    '  AUTORISE : "achat simple sans maintenance ni pieces de rechange".\n' +
    '  Maximum 5 exclusions.\n' +
    '- evidence : justification en 2-3 phrases des choix de variantes et exclusions.\n' +
    '- confidence_score : 0.0 a 1.0. Haut (0.8-0.9) si critere clair, bas (0.4-0.6) si ambigu.\n' +
    'Ne retourne rien en dehors du JSON.'
  );
}

/**
 * Filtre les exclusions trop generiques (moins de 3 mots).
 * Retourne les exclusions acceptees et celles rejetees separement.
 *
 * Regle metier : une exclusion doit decrire un contexte precis d inapplicabilite,
 * pas simplement bannir un terme. Moins de 3 mots = trop vague.
 */
export function filterNaiveExclusions(exclusions: string[]): {
  kept:     string[];
  rejected: string[];
} {
  const kept:     string[] = [];
  const rejected: string[] = [];

  for (const exc of exclusions) {
    const wordCount = exc.trim().split(/\s+/).length;
    if (wordCount >= 3) {
      kept.push(exc);
    } else {
      rejected.push(exc);
    }
  }

  return { kept, rejected };
}

/**
 * Calcule un hash sha256 du prompt rendu.
 * Stocke dans prompt_hash pour detecter si le template de prompt a change.
 */
export function computePromptHash(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

// --- Logger par defaut -------------------------------------------------------

function defaultEnricherLogger(entry: EnricherLogEntry): void {
  if (entry.level === 'error') {
    console.error(`[CriteriaEnricher] ${entry.event}`, entry);
  } else if (entry.level === 'warn') {
    console.warn(`[CriteriaEnricher] ${entry.event}`, entry);
  }
}

// --- Factory -----------------------------------------------------------------

/**
 * Cree un enrichisseur de criteres avec les dependances injectees.
 * Toujours utiliser ILLMClient et ICache (interfaces) -- jamais les concrets.
 */
export function createCriteriaEnricher(
  llmClient: ILLMClient,
  cache:     ICache,
  model:     string,
  logger?:   (entry: EnricherLogEntry) => void,
): CriteriaEnricher {
  const opts: CriteriaEnricherOptions = logger !== undefined
    ? { model, logger }
    : { model };
  return new CriteriaEnricher(llmClient, cache, opts);
}
