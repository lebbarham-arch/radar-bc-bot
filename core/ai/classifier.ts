/**
 * BC Intent Classifier -- Anaho
 *
 * Classifie l intention dominante d un BC quand le moteur deterministe
 * retourne `inconnu` ou `mixte`. Propose un BCIntent candidat via LLM local.
 *
 * Responsabilites UNIQUES de ce module :
 *   1. Valider l entree (ClassifierInput via Zod)
 *   2. Verifier le cache (cle = sha256 des articles + intent det. + extrait)
 *   3. Construire un prompt court et structure (articles en priorite sur le titre)
 *   4. Appeler ILLMClient.call() et parser la reponse JSON
 *   5. Valider que proposed_intent est dans BCIntentSchema -- erreur si hors enum
 *   6. Detecter les signaux contradictoires -> warning mixed_intents_detected
 *   7. Valider via ClassifierOutputSchema et stocker en cache
 *   8. Retourner ClassifierResult discrimine
 *
 * Ce module ne fait PAS :
 *   - Modification du scoring, des articles ou du profil client
 *   - Acces Supabase ou base de donnees
 *   - Branchement dans le pipeline existant
 *   - Decision finale : resolveIntent() reste la seule autorite
 *
 * overrides_deterministic est structurellement false (z.literal(false)) --
 * impossible de le mettre a true meme en forcant le type.
 *
 * Regle : jamais de `any`. Toute donnee manquante -> valeur par defaut explicite.
 */

import {
  ClassifierInput,
  ClassifierInputSchema,
  ClassifierOutput,
  ClassifierOutputSchema,
  BCIntent,
  BCIntentSchema,
} from './schemas/classifier.schema';

import { LLMRequestSchema } from './schemas/llm-client.schema';
import { ILLMClient }        from './llm-client';
import { ICache }            from './cache';
import { MAX_LLM_PROMPT_CHARS } from './constants';

// --- Warning codes -----------------------------------------------------------

export type ClassifierWarningCode =
  | 'mixed_intents_detected'
  | 'cache_payload_invalid'
  | 'cache_store_failed'
  | 'low_confidence_fallback';

export interface ClassifierWarning {
  code:    ClassifierWarningCode;
  message: string;
}

// --- Error codes -------------------------------------------------------------

export type ClassifierErrorCode =
  | 'invalid_input'
  | 'prompt_too_long'
  | 'llm_error'
  | 'parse_error'
  | 'unknown_intent'
  | 'validation_error'
  | 'unknown';

export interface ClassifierError {
  code:    ClassifierErrorCode;
  message: string;
}

// --- Result discrimine -------------------------------------------------------

export type ClassifierResult =
  | { ok: true;  output: ClassifierOutput; warnings: ClassifierWarning[] }
  | { ok: false; error:  ClassifierError };

// --- Forme brute de la reponse LLM -------------------------------------------

/**
 * JSON attendu du LLM pour la classification.
 * proposed_intent est un string ici -- valide ensuite contre BCIntentSchema.
 * alternative_intents permet de detecter les signaux mixtes.
 * mixed_signals est un signal explicite du LLM.
 */
interface RawClassifierLLMResponse {
  proposed_intent:    string;
  confidence_score:   number;
  evidence:           string;
  alternative_intents: string[];
  mixed_signals:      boolean;
}

function isRawClassifierLLMResponse(raw: unknown): raw is RawClassifierLLMResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['proposed_intent']   === 'string'  &&
    typeof r['confidence_score']  === 'number'  &&
    typeof r['evidence']          === 'string'  &&
    Array.isArray(r['alternative_intents'])     &&
    typeof r['mixed_signals']     === 'boolean'
  );
}

// --- Log entry ---------------------------------------------------------------

export interface ClassifierLogEntry {
  level:                'info' | 'warn' | 'error';
  event:                string;
  bc_id:                string;
  model:                string;
  deterministic_intent: BCIntent;
  proposed_intent?:     string;
  cache_hit?:           boolean;
  warnings?:            ClassifierWarningCode[];
  error_code?:          ClassifierErrorCode;
}

// --- Options -----------------------------------------------------------------

export interface BCClassifierOptions {
  model:   string;
  logger?: (entry: ClassifierLogEntry) => void;
}

// --- BCClassifier ------------------------------------------------------------

export class BCClassifier {
  private readonly model:  string;
  private readonly logger: (entry: ClassifierLogEntry) => void;

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly cache:     ICache,
    options: BCClassifierOptions,
  ) {
    this.model  = options.model;
    this.logger = options.logger ?? defaultClassifierLogger;
  }

  // --- classify --------------------------------------------------------------

  /**
   * Classifie l intention dominante d un BC.
   * Retourne un ClassifierResult discrimine (ok: true | ok: false).
   * Ne lance jamais d exception non geree.
   */
  async classify(rawInput: unknown): Promise<ClassifierResult> {
    // 1. Valider l entree
    const parsed = ClassifierInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok:    false,
        error: { code: 'invalid_input', message: parsed.error.message },
      };
    }
    const input = parsed.data;

    // 2. Calculer la cle de cache
    const cacheContent = buildCacheContent(input);
    const cacheKey = this.cache.computeKey({
      model:     this.model,
      task_type: 'classification',
      content:   cacheContent,
    });

    // 2b. Initialiser preWarnings (cache_payload_invalid doit apparaitre dans le resultat)
    const preWarnings: ClassifierWarning[] = [];

    // 3. Verifier le cache
    const cacheHit = this.cache.get(cacheKey, 'classification');
    if (cacheHit.hit) {
      const cached = this.tryParseCachedPayload(cacheHit.entry.payload);
      if (cached !== null) {
        this.log({
          level: 'info', event: 'classifier_cache_hit',
          bc_id: input.bc_id, model: this.model,
          deterministic_intent: input.deterministic_intent,
          cache_hit: true,
        });
        return { ok: true, output: cached, warnings: [] };
      }
      // Payload invalide -- propager le warning au caller via preWarnings
      preWarnings.push({ code: 'cache_payload_invalid', message: 'Payload cache invalide -- LLM appele en fallback' });
      this.log({
        level: 'warn', event: 'classifier_cache_payload_invalid',
        bc_id: input.bc_id, model: this.model,
        deterministic_intent: input.deterministic_intent,
        warnings: ['cache_payload_invalid'],
      });
    }

    // 4. Construire et valider le prompt
    const prompt = buildClassifierPrompt(input);

    if (prompt.length > MAX_LLM_PROMPT_CHARS) {
      return {
        ok:    false,
        error: { code: 'prompt_too_long', message: `Prompt trop long (${prompt.length} chars > ${MAX_LLM_PROMPT_CHARS}). Reduire les articles ou l extrait.` },
      };
    }

    const llmReqParsed = LLMRequestSchema.safeParse({
      model:     this.model,
      prompt,
      task_type: 'classification',
    });
    if (!llmReqParsed.success) {
      return {
        ok:    false,
        error: { code: 'unknown', message: `LLMRequest invalide: ${llmReqParsed.error.message}` },
      };
    }

    // 5. Appeler le LLM
    const llmResult = await this.llmClient.call(llmReqParsed.data);

    if (!llmResult.ok) {
      this.log({
        level: 'error', event: 'classifier_llm_error',
        bc_id: input.bc_id, model: this.model,
        deterministic_intent: input.deterministic_intent,
        error_code: 'llm_error',
      });
      return {
        ok:    false,
        error: { code: 'llm_error', message: llmResult.error.message },
      };
    }

    // 6. Parser, valider, stocker
    return this.processLLMResponse(
      llmResult.value.content,
      llmResult.value.model,
      input,
      cacheKey,
      preWarnings,
    );
  }

  // --- Helpers prives --------------------------------------------------------

  private tryParseCachedPayload(payload: string): ClassifierOutput | null {
    try {
      const raw    = JSON.parse(payload) as unknown;
      const parsed = ClassifierOutputSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private processLLMResponse(
    content:     string,
    llmModel:    string,
    input:       ClassifierInput,
    cacheKey:    string,
    preWarnings: ClassifierWarning[] = [],
  ): ClassifierResult {
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

    // Verifier la structure
    if (!isRawClassifierLLMResponse(raw)) {
      return {
        ok:    false,
        error: {
          code:    'parse_error',
          message: 'Reponse LLM manque des champs requis ' +
                   '(proposed_intent, confidence_score, evidence, ' +
                   'alternative_intents, mixed_signals)',
        },
      };
    }

    // Valider proposed_intent contre BCIntentSchema -- jamais de fallback silencieux
    const intentParsed = BCIntentSchema.safeParse(raw.proposed_intent);
    if (!intentParsed.success) {
      this.log({
        level: 'error', event: 'classifier_unknown_intent',
        bc_id: input.bc_id, model: this.model,
        deterministic_intent: input.deterministic_intent,
        proposed_intent: raw.proposed_intent,
        error_code: 'unknown_intent',
      });
      return {
        ok:    false,
        error: {
          code:    'unknown_intent',
          message: `Intent hors enum BCIntent: "${raw.proposed_intent}". ` +
                   `Valeurs valides: fourniture, prestation, travaux, mixte, inconnu.`,
        },
      };
    }

    const proposed_intent: BCIntent = intentParsed.data;
    const warnings: ClassifierWarning[] = [...preWarnings];

    // Detecter les signaux contradictoires
    const hasMixedAlternatives = raw.alternative_intents.length > 0;
    if (raw.mixed_signals || hasMixedAlternatives) {
      warnings.push({
        code:    'mixed_intents_detected',
        message: `Signaux contradictoires detectes. Intent principal: ${proposed_intent}. ` +
                 `Alternatives: ${raw.alternative_intents.join(', ') || 'aucune'}. ` +
                 `Indicateur LLM mixed_signals: ${String(raw.mixed_signals)}.`,
      });
    }

    // Normaliser confidence_score dans [0, 1]
    const confidence_score = Math.min(1, Math.max(0, raw.confidence_score));

    // Construire intent_scores a partir des alternatives si disponibles
    const intent_scores = buildIntentScores(proposed_intent, confidence_score, raw.alternative_intents);

    // Construire le candidat ClassifierOutput
    const candidate = {
      bc_id:                   input.bc_id,
      proposed_intent,
      overrides_deterministic: false as const,
      confidence_score,
      evidence:                typeof raw.evidence === 'string' ? raw.evidence : '',
      source_type:             'llm'            as const,
      created_at:              new Date().toISOString(),
      model:                   llmModel,
      task_type:               'classification' as const,
      ...(intent_scores !== undefined ? { intent_scores } : {}),
    };

    const validated = ClassifierOutputSchema.safeParse(candidate);
    if (!validated.success) {
      return {
        ok:    false,
        error: {
          code:    'validation_error',
          message: `Validation ClassifierOutput echouee: ${validated.error.message}`,
        },
      };
    }

    const output = validated.data;

    // Stocker en cache (non fatal)
    try {
      this.cache.set(cacheKey, JSON.stringify(output), {
        model:     this.model,
        task_type: 'classification',
        tags:      [`bc_id:${input.bc_id}`],
      });
    } catch {
      warnings.push({
        code:    'cache_store_failed',
        message: 'Impossible de stocker le resultat en cache (non fatal)',
      });
    }

    this.log({
      level:                warnings.length > 0 ? 'warn' : 'info',
      event:                'classifier_success',
      bc_id:                input.bc_id,
      model:                this.model,
      deterministic_intent: input.deterministic_intent,
      proposed_intent:      proposed_intent,
      cache_hit:            false,
      warnings:             warnings.map(w => w.code),
    });

    return { ok: true, output, warnings };
  }

  private log(entry: ClassifierLogEntry): void {
    this.logger(entry);
  }
}

// --- Fonctions pures exportees -----------------------------------------------

/**
 * Construit le prompt de classification.
 * Les articles sont listes EN PREMIER (priorite sur le titre/extrait).
 * Le prompt est court et structure : articles, intent det., extrait, question.
 */
export function buildClassifierPrompt(input: ClassifierInput): string {
  const articlesStr = input.articles
    .slice(0, 5)  // limiter a 5 articles pour rester court
    .map((a, i) => {
      const specs = a.specifications.length > 0 ? ` | Specs: ${a.specifications.slice(0, 80)}` : '';
      return `  ${String(i + 1)}. ${a.designation.slice(0, 120)}${specs}`;
    })
    .join('\n');

  const excerptStr = input.raw_body_excerpt.length > 0
    ? `\nExtrait du BC : "${input.raw_body_excerpt.slice(0, 300)}"`
    : '';

  return (
    'Tu es un expert en marches publics algeriens.\n' +
    'Classifie l intention dominante de ce bon de commande.\n\n' +
    'Articles principaux (source prioritaire) :\n' +
    articlesStr + '\n' +
    excerptStr + '\n' +
    'Intent deterministe actuel : ' + input.deterministic_intent + '\n\n' +
    'Question : Quelle est l intention dominante de ce BC ?\n\n' +
    'Reponds en JSON uniquement :\n' +
    '{\n' +
    '  "proposed_intent": "fourniture|prestation|travaux|mixte|inconnu",\n' +
    '  "confidence_score": 0.0,\n' +
    '  "evidence": "...",\n' +
    '  "alternative_intents": [],\n' +
    '  "mixed_signals": false\n' +
    '}\n\n' +
    'Regles :\n' +
    '- proposed_intent DOIT etre une de ces valeurs exactes : fourniture, prestation, travaux, mixte, inconnu\n' +
    '- Les articles ont priorite sur l extrait pour determiner l intent\n' +
    '- Si les articles pointent des intentions contradictoires : proposed_intent="mixte", mixed_signals=true\n' +
    '- Si le titre dit une chose mais les articles disent autre chose : se baser sur les articles\n' +
    '- evidence doit mentionner en premier les articles et leur contenu\n' +
    '- alternative_intents : liste des autres intents plausibles (vide si aucun)\n' +
    '- confidence_score : 0.9 si clair, 0.6-0.8 si ambigu, 0.4 si tres incertain\n' +
    '- Utilise "inconnu" si impossible de trancher\n' +
    'Ne retourne rien en dehors du JSON.'
  );
}

/**
 * Construit le contenu normalise pour la cle de cache.
 * Encode : articles + intent deterministe + extrait BC.
 * Les articles sont en premier (source de verite dominante).
 */
export function buildCacheContent(input: ClassifierInput): string {
  const articlesStr = input.articles
    .map(a => `${a.designation.trim().toLowerCase()}:${a.specifications.trim().toLowerCase()}`)
    .join('|');
  const excerptStr  = input.raw_body_excerpt.trim().toLowerCase();
  return `${articlesStr}|${input.deterministic_intent}|${excerptStr}`;
}

/**
 * Construit un intent_scores partiel depuis les alternatives LLM.
 * Retourne undefined si aucune alternative -- le champ est optionnel.
 */
function buildIntentScores(
  mainIntent:   BCIntent,
  mainScore:    number,
  alternatives: string[],
): Partial<Record<BCIntent, number>> | undefined {
  // Ne construire le map que si on a des alternatives valides
  const validAlts = alternatives
    .map(a => BCIntentSchema.safeParse(a))
    .filter(p => p.success)
    .map(p => (p as { success: true; data: BCIntent }).data)
    .filter(a => a !== mainIntent);

  if (validAlts.length === 0) return undefined;

  const remaining = Math.max(0, 1 - mainScore);
  const altScore  = remaining / validAlts.length;

  const scores: Partial<Record<BCIntent, number>> = {
    [mainIntent]: mainScore,
  };
  for (const alt of validAlts) {
    scores[alt] = Math.round(altScore * 100) / 100;
  }
  return scores;
}

// --- Logger par defaut -------------------------------------------------------

function defaultClassifierLogger(entry: ClassifierLogEntry): void {
  if (entry.level === 'error') {
    console.error(`[BCClassifier] ${entry.event}`, entry);
  } else if (entry.level === 'warn') {
    console.warn(`[BCClassifier] ${entry.event}`, entry);
  }
}

// --- Factory -----------------------------------------------------------------

/**
 * Cree un classificateur d intention BC avec les dependances injectees.
 */
export function createBCClassifier(
  llmClient: ILLMClient,
  cache:     ICache,
  model:     string,
  logger?:   (entry: ClassifierLogEntry) => void,
): BCClassifier {
  const opts: BCClassifierOptions = logger !== undefined
    ? { model, logger }
    : { model };
  return new BCClassifier(llmClient, cache, opts);
}
