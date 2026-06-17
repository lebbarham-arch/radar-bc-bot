/**
 * Opportunity Detector -- Anaho
 *
 * Detecte des opportunites cachees dans des BCs a faible score deterministe.
 * Produit uniquement un digest separe -- jamais de notification directe.
 *
 * Responsabilites UNIQUES :
 *   1. Valider l entree (bc_id + title + articles + score + criteres)
 *   2. Pre-verifier que le score est < OPPORTUNITY_DETERMINISTIC_MAX
 *   3. Verifier le cache (cle sur bc_id + title + articles + score_breakdown)
 *   4. Construire un prompt analysant le BC vs criteres clients
 *   5. Appeler ILLMClient.call() et parser la reponse JSON
 *   6. Filtrer les opportunites a faible confiance (< MIN_CONFIDENCE)
 *   7. Filtrer les signaux trop generiques
 *   8. Borner a MAX_OPPORTUNITIES (5)
 *   9. Valider via DetectorOutputSchema
 *
 * Garanties structurelles (Zod z.literal) :
 *   - digest_only: true              sur chaque opportunite
 *   - triggers_notification: false   sur chaque opportunite
 *
 * Ce module ne fait PAS :
 *   - Contredire le score deterministe
 *   - Declencher une notification
 *   - Modifier le profil client ou le BC
 *   - Acces Supabase ou base de donnees
 *   - Branchement dans le pipeline existant
 *
 * Regle : jamais de `any`. Toute donnee manquante -> valeur par defaut explicite.
 */

import { createHash } from 'crypto';
import { z }          from 'zod';

import { AIOutputBaseSchema }   from './schemas/shared.schema';
import { LLMRequestSchema }     from './schemas/llm-client.schema';
import { ILLMClient }           from './llm-client';
import { ICache }               from './cache';
import {
  OPPORTUNITY_DETERMINISTIC_MAX,
  MAX_LLM_PROMPT_CHARS,
} from './constants';

// --- Limites et seuils -------------------------------------------------------

export const MAX_OPPORTUNITIES       = 5    as const;
export const MAX_MATCHED_ARTICLES    = 5    as const;
export const OPPORTUNITY_MIN_CONFIDENCE     = 0.45  as const;
/** Seuil de confiance sous lequel un signal est trop generique pour etre retenu */
export const GENERIC_SIGNAL_CONFIDENCE_MAX = 0.6   as const;

// --- Schema local : opportunite individuelle --------------------------------

/**
 * Une opportunite cachee avec ses deux garanties structurelles Zod.
 *
 * - digest_only: z.literal(true)           -- jamais dans le flux notifications
 * - triggers_notification: z.literal(false) -- ce module ne notifie pas
 */
export const OpportunityItemSchema = z.object({
  label:               z.string().min(1),
  reason:              z.string().min(1),
  confidence_score:    z.number().min(0).max(1),
  matched_articles:    z.array(z.string()).max(MAX_MATCHED_ARTICLES).default([]),
  hidden_signals:      z.array(z.string()).default([]),
  business_relevance:  z.string().default(''),
  evidence:            z.string().min(1),
  /** Garantie : alimente uniquement le digest */
  digest_only:           z.literal(true),
  /** Garantie : aucune notification directe */
  triggers_notification: z.literal(false),
});
export type OpportunityItem = z.infer<typeof OpportunityItemSchema>;

// --- Schema local : entree --------------------------------------------------

export const DetectorInputSchema = z.object({
  bc_id:               z.string().min(1),
  client_id:           z.string().min(1),
  bc_title:            z.string().default(''),
  bc_text_excerpt:     z.string().max(600).default(''),
  critere_texts:       z.array(z.string()).min(1),
  deterministic_score: z.number().min(0).max(100),
  score_breakdown:     z.record(z.string(), z.number()).default({}),
  /** Precondition validee par le pipeline : score < OPPORTUNITY_DETERMINISTIC_MAX */
  bc_is_low_scorer:    z.literal(true),
}).refine(
  (inp) => inp.deterministic_score < OPPORTUNITY_DETERMINISTIC_MAX,
  {
    message: `deterministic_score doit etre < ${OPPORTUNITY_DETERMINISTIC_MAX} pour etre candidat`,
    path:    ['deterministic_score'],
  },
);
export type DetectorInput = z.infer<typeof DetectorInputSchema>;

// --- Schema local : sortie --------------------------------------------------

export const DetectorOutputSchema = AIOutputBaseSchema.merge(
  z.object({
    bc_id:               z.string().min(1),
    client_id:           z.string().min(1),
    deterministic_score: z.number().min(0).max(100),
    opportunities:       z.array(OpportunityItemSchema).max(MAX_OPPORTUNITIES).default([]),
  }),
).refine(
  (out) => out.task_type === 'opportunity_detection',
  { message: 'DetectorOutput.task_type doit etre "opportunity_detection"' },
).refine(
  (out) => out.opportunities.every(
    (o) => o.digest_only === true && o.triggers_notification === false,
  ),
  { message: 'Toutes les opportunites doivent avoir digest_only:true et triggers_notification:false' },
);
export type OpportunityDetectorOutput = z.infer<typeof DetectorOutputSchema>;

// --- Warning codes ----------------------------------------------------------

export type OpportunityDetectorWarningCode =
  | 'low_confidence'
  | 'generic_signals'
  | 'opportunities_truncated'
  | 'no_opportunities'
  | 'cache_payload_invalid'
  | 'cache_store_failed';

export interface OpportunityDetectorWarning {
  code:    OpportunityDetectorWarningCode;
  message: string;
}

// --- Error codes ------------------------------------------------------------

export type OpportunityDetectorErrorCode =
  | 'score_not_low_enough'
  | 'invalid_input'
  | 'prompt_too_long'
  | 'llm_error'
  | 'parse_error'
  | 'validation_error'
  | 'unknown';

export interface OpportunityDetectorError {
  code:    OpportunityDetectorErrorCode;
  message: string;
}

// --- Result discrimine ------------------------------------------------------

export type OpportunityDetectorResult =
  | { ok: true;  output: OpportunityDetectorOutput; warnings: OpportunityDetectorWarning[] }
  | { ok: false; error:  OpportunityDetectorError };

// --- Forme brute de la reponse LLM ------------------------------------------

interface RawOpportunityItem {
  label:              string;
  reason:             string;
  confidence_score:   number;
  matched_articles:   unknown[];
  hidden_signals:     unknown[];
  business_relevance: string;
  evidence:           string;
}

function isRawOpportunityItem(raw: unknown): raw is RawOpportunityItem {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['label']              === 'string' &&
    typeof r['reason']             === 'string' &&
    typeof r['confidence_score']   === 'number' &&
    Array.isArray(r['matched_articles']) &&
    Array.isArray(r['hidden_signals'])   &&
    typeof r['business_relevance'] === 'string' &&
    typeof r['evidence']           === 'string'
  );
}

interface RawDetectorLLMResponse {
  opportunities: unknown[];
}

function isRawDetectorLLMResponse(raw: unknown): raw is RawDetectorLLMResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return Array.isArray(r['opportunities']);
}

// --- Log entry --------------------------------------------------------------

export interface DetectorLogEntry {
  level:       'info' | 'warn' | 'error';
  event:       string;
  bc_id:       string;
  client_id:   string;
  model:       string;
  cache_hit?:  boolean;
  n_found?:    number;
  warnings?:   OpportunityDetectorWarningCode[];
  error_code?: OpportunityDetectorErrorCode;
}

// --- Options ----------------------------------------------------------------

export interface OpportunityDetectorOptions {
  model:   string;
  logger?: (entry: DetectorLogEntry) => void;
}

// --- OpportunityDetector ----------------------------------------------------

export class OpportunityDetector {
  private readonly model:  string;
  private readonly logger: (entry: DetectorLogEntry) => void;

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly cache:     ICache,
    options: OpportunityDetectorOptions,
  ) {
    this.model  = options.model;
    this.logger = options.logger ?? defaultDetectorLogger;
  }

  // --- detect ----------------------------------------------------------------

  async detect(rawInput: unknown): Promise<OpportunityDetectorResult> {
    // 0. Pre-verifier le score AVANT Zod (erreur semantique propre)
    const scoreCheck = this.checkScoreNotLow(rawInput);
    if (scoreCheck !== null) return scoreCheck;

    // 1. Valider l entree via Zod
    const parsed = DetectorInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, error: { code: 'invalid_input', message: parsed.error.message } };
    }
    const input = parsed.data;

    // 2. Calculer la cle de cache
    const cacheContent = buildDetectorCacheContent(input);
    const cacheKey = this.cache.computeKey({
      model:     this.model,
      task_type: 'opportunity_detection',
      content:   cacheContent,
    });

    // 3. Verifier le cache
    const preWarnings: OpportunityDetectorWarning[] = [];
    const cacheHit = this.cache.get(cacheKey, 'opportunity_detection');
    if (cacheHit.hit) {
      const cached = this.tryParseCachedPayload(cacheHit.entry.payload);
      if (cached !== null) {
        this.log({
          level: 'info', event: 'detector_cache_hit',
          bc_id: input.bc_id, client_id: input.client_id,
          model: this.model, cache_hit: true,
        });
        return { ok: true, output: cached, warnings: [] };
      }
      preWarnings.push({
        code:    'cache_payload_invalid',
        message: 'Payload cache invalide -- LLM appele en fallback',
      });
      this.log({
        level: 'warn', event: 'detector_cache_payload_invalid',
        bc_id: input.bc_id, client_id: input.client_id,
        model: this.model, warnings: ['cache_payload_invalid'],
      });
    }

    // 4. Construire le prompt
    const prompt = buildDetectorPrompt(input);

    if (prompt.length > MAX_LLM_PROMPT_CHARS) {
      return {
        ok:    false,
        error: { code: 'prompt_too_long', message: `Prompt trop long (${prompt.length} chars > ${MAX_LLM_PROMPT_CHARS}). Reduire les criteres ou l extrait BC.` },
      };
    }

    const llmReqParsed = LLMRequestSchema.safeParse({
      model:     this.model,
      prompt,
      task_type: 'opportunity_detection',
    });
    if (!llmReqParsed.success) {
      return { ok: false, error: { code: 'unknown', message: `LLMRequest invalide: ${llmReqParsed.error.message}` } };
    }

    // 5. Appeler le LLM
    const llmResult = await this.llmClient.call(llmReqParsed.data);
    if (!llmResult.ok) {
      this.log({
        level: 'error', event: 'detector_llm_error',
        bc_id: input.bc_id, client_id: input.client_id,
        model: this.model, error_code: 'llm_error',
      });
      return { ok: false, error: { code: 'llm_error', message: llmResult.error.message } };
    }

    // 6. Parser, filtrer, valider, stocker
    return this.processLLMResponse(
      llmResult.value.content,
      llmResult.value.model,
      input,
      cacheKey,
      preWarnings,
    );
  }

  // --- Helpers prives --------------------------------------------------------

  /**
   * Pre-verification semantique du score AVANT Zod.
   * Retourne score_not_low_enough si le score est trop haut.
   * Retourne null si la verification passe (continuer normalement).
   */
  private checkScoreNotLow(rawInput: unknown): OpportunityDetectorResult | null {
    if (typeof rawInput !== 'object' || rawInput === null) return null;
    const r = rawInput as Record<string, unknown>;
    const score = typeof r['deterministic_score'] === 'number' ? r['deterministic_score'] : null;
    if (score === null) return null;
    if (score >= OPPORTUNITY_DETERMINISTIC_MAX) {
      return {
        ok:    false,
        error: {
          code:    'score_not_low_enough',
          message: `Score deterministe ${String(score)} >= ${String(OPPORTUNITY_DETERMINISTIC_MAX)}: BC non candidat a la detection d opportunites`,
        },
      };
    }
    return null;
  }

  private tryParseCachedPayload(payload: string): OpportunityDetectorOutput | null {
    try {
      const raw    = JSON.parse(payload) as unknown;
      const result = DetectorOutputSchema.safeParse(raw);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private processLLMResponse(
    content:     string,
    llmModel:    string,
    input:       DetectorInput,
    cacheKey:    string,
    preWarnings: OpportunityDetectorWarning[] = [],
  ): OpportunityDetectorResult {
    // Deserialiser
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

    if (!isRawDetectorLLMResponse(raw)) {
      return {
        ok:    false,
        error: {
          code:    'parse_error',
          message: 'Reponse LLM manque le champ "opportunities" (array)',
        },
      };
    }

    const warnings: OpportunityDetectorWarning[] = [...preWarnings];

    // Mapper les items bruts
    const mapped: OpportunityItem[] = [];
    for (const rawItem of raw.opportunities) {
      if (!isRawOpportunityItem(rawItem)) continue;

      const matched = rawItem.matched_articles
        .filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
        .slice(0, MAX_MATCHED_ARTICLES);

      const signals = rawItem.hidden_signals
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

      const p = OpportunityItemSchema.safeParse({
        label:               rawItem.label.trim(),
        reason:              rawItem.reason.trim(),
        confidence_score:    rawItem.confidence_score,
        matched_articles:    matched,
        hidden_signals:      signals,
        business_relevance:  rawItem.business_relevance,
        evidence:            rawItem.evidence.trim(),
        digest_only:         true  as const,
        triggers_notification: false as const,
      });

      if (p.success) {
        mapped.push(p.data);
      }
    }

    // Filtrer : faible confiance
    const lowConfFiltered: OpportunityItem[] = [];
    const afterConfidence = mapped.filter((o) => {
      if (o.confidence_score < OPPORTUNITY_MIN_CONFIDENCE) {
        lowConfFiltered.push(o);
        return false;
      }
      return true;
    });
    if (lowConfFiltered.length > 0) {
      warnings.push({
        code:    'low_confidence',
        message: `${lowConfFiltered.length} opportunite(s) ecartee(s) (confidence < ${String(OPPORTUNITY_MIN_CONFIDENCE)})`,
      });
    }

    // Filtrer : signaux generiques (tous < 2 mots ET confidence < GENERIC_SIGNAL_CONFIDENCE_MAX)
    const genericFiltered: OpportunityItem[] = [];
    const afterGeneric = afterConfidence.filter((o) => {
      if (isGenericOpportunity(o) && o.confidence_score < GENERIC_SIGNAL_CONFIDENCE_MAX) {
        genericFiltered.push(o);
        return false;
      }
      return true;
    });
    if (genericFiltered.length > 0) {
      warnings.push({
        code:    'generic_signals',
        message: `${genericFiltered.length} opportunite(s) ecartee(s) pour signaux trop generiques`,
      });
    }

    // Borner a MAX_OPPORTUNITIES
    let opportunities = afterGeneric;
    if (opportunities.length > MAX_OPPORTUNITIES) {
      opportunities = opportunities.slice(0, MAX_OPPORTUNITIES);
      warnings.push({
        code:    'opportunities_truncated',
        message: `${afterGeneric.length} opportunites tronquees a ${MAX_OPPORTUNITIES}`,
      });
    }

    // Aucune opportunite
    if (opportunities.length === 0) {
      warnings.push({
        code:    'no_opportunities',
        message: 'Aucune opportunite cachee retenue apres filtrage',
      });
    }

    // Construire la sortie
    const totalConf = opportunities.length > 0
      ? opportunities.reduce((acc, o) => acc + o.confidence_score, 0) / opportunities.length
      : 0;

    const candidate = {
      bc_id:               input.bc_id,
      client_id:           input.client_id,
      deterministic_score: input.deterministic_score,
      opportunities,
      confidence_score:    Math.round(totalConf * 100) / 100,
      evidence:            buildEvidence(input.bc_id, input.deterministic_score, opportunities.length),
      source_type:         'llm' as const,
      created_at:          new Date().toISOString(),
      model:               llmModel,
      task_type:           'opportunity_detection' as const,
    };

    const validated = DetectorOutputSchema.safeParse(candidate);
    if (!validated.success) {
      return {
        ok:    false,
        error: {
          code:    'validation_error',
          message: `Validation DetectorOutput echouee: ${validated.error.message}`,
        },
      };
    }

    const output = validated.data;

    // Stocker en cache (non fatal)
    try {
      this.cache.set(cacheKey, JSON.stringify(output), {
        model:     this.model,
        task_type: 'opportunity_detection',
        tags:      [`client_id:${input.client_id}`, `bc_id:${input.bc_id}`],
      });
    } catch {
      warnings.push({ code: 'cache_store_failed', message: 'Impossible de stocker en cache (non fatal)' });
    }

    this.log({
      level:     warnings.length > 0 ? 'warn' : 'info',
      event:     'detector_success',
      bc_id:     input.bc_id,
      client_id: input.client_id,
      model:     this.model,
      cache_hit: false,
      n_found:   output.opportunities.length,
      warnings:  warnings.map((w) => w.code),
    });

    return { ok: true, output, warnings };
  }

  private log(entry: DetectorLogEntry): void {
    this.logger(entry);
  }
}

// --- Fonctions pures exportees -----------------------------------------------

/**
 * Construit le prompt pour le detecteur d opportunites cachees.
 * Met en avant la tension titre-faible/articles-forts pour guider le LLM.
 */
export function buildDetectorPrompt(input: DetectorInput): string {
  const criteresStr = input.critere_texts
    .slice(0, 6)
    .map((c, i) => `  ${String(i + 1)}. ${c.slice(0, 120)}`)
    .join('\n');

  const breakdownStr = Object.entries(input.score_breakdown)
    .map(([k, v]) => `  ${k}: ${String(v)}`)
    .join('\n');

  return (
    'Tu es un expert en marches publics algeriens.\n' +
    'Ce BC a un score FAIBLE (' + String(input.deterministic_score) + '/100) mais peut cacher des opportunites.\n\n' +
    `BC ID: ${input.bc_id}\n` +
    `Titre: "${input.bc_title.slice(0, 200)}"\n` +
    `Extrait: "${input.bc_text_excerpt.slice(0, 400)}"\n` +
    `Decomposition du score:\n${breakdownStr}\n\n` +
    `Criteres actifs du client:\n${criteresStr}\n\n` +
    'Analyse les cas suivants :\n' +
    '- Titre generique mais articles pertinents\n' +
    '- Titre faible mais signaux techniques forts\n' +
    '- Opportunite metier secondaire interessante\n' +
    '- Signaux rares meme sous le seuil\n\n' +
    'Reponds en JSON uniquement :\n' +
    '{\n' +
    '  "opportunities": [\n' +
    '    {\n' +
    '      "label": "...",\n' +
    '      "reason": "...",\n' +
    '      "confidence_score": 0.0,\n' +
    '      "matched_articles": [...],\n' +
    '      "hidden_signals": [...],\n' +
    '      "business_relevance": "...",\n' +
    '      "evidence": "..."\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Regles STRICTES :\n' +
    '- Ne jamais contredire le score deterministe\n' +
    '- Utiliser "opportunite cachee potentielle a revoir" si incertain\n' +
    '- NE PAS dire "notifier ce BC"\n' +
    '- Ces opportunites alimentent un digest separe, elles ne declenchent aucune notification\n' +
    '- evidence obligatoire et non vide pour chaque opportunite\n' +
    `- Maximum ${String(MAX_OPPORTUNITIES)} opportunites\n` +
    `- confidence_score >= ${String(OPPORTUNITY_MIN_CONFIDENCE)} pour etre retenu\n` +
    '- hidden_signals : au moins 2 mots par signal\n' +
    'Ne retourne rien en dehors du JSON.'
  );
}

/**
 * Construit le contenu normalise pour la cle de cache.
 * Basee sur bc_id + title + articles normalises + score_breakdown trie.
 */
export function buildDetectorCacheContent(input: DetectorInput): string {
  const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const critereStr = [...input.critere_texts]
    .sort()
    .map(normalize)
    .join('|');
  const breakdownStr = Object.entries(input.score_breakdown)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('|');
  const raw = [
    input.bc_id,
    normalize(input.bc_title),
    normalize(input.bc_text_excerpt),
    critereStr,
    String(input.deterministic_score),
    breakdownStr,
  ].join('||');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Verifie si une opportunite a uniquement des signaux generiques (< 2 mots).
 */
export function isGenericOpportunity(opp: OpportunityItem): boolean {
  if (opp.hidden_signals.length === 0) return true;
  return opp.hidden_signals.every((s) => s.trim().split(/\s+/).length < 2);
}

// --- Helpers internes --------------------------------------------------------

function buildEvidence(bcId: string, score: number, n: number): string {
  return `BC ${bcId} (score det. ${String(score)}/100): ${n} opportunite(s) cachee(s) detectee(s). Digest uniquement -- aucune notification.`;
}

function defaultDetectorLogger(entry: DetectorLogEntry): void {
  if (entry.level === 'error') {
    console.error(`[OpportunityDetector] ${entry.event}`, entry);
  } else if (entry.level === 'warn') {
    console.warn(`[OpportunityDetector] ${entry.event}`, entry);
  }
}

// --- Factory -----------------------------------------------------------------

// --- Factory -----------------------------------------------------------------

export function createOpportunityDetector(
  llmClient: ILLMClient,
  cache:     ICache,
  model:     string,
  logger?:   (entry: DetectorLogEntry) => void,
): OpportunityDetector {
  const opts: OpportunityDetectorOptions = logger !== undefined
    ? { model, logger }
    : { model };
  return new OpportunityDetector(llmClient, cache, opts);
}
