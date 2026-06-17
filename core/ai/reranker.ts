/**
 * Bounded Reranker -- Anaho
 *
 * Propose un delta signe borne [-5, +5] pour ajuster le score deterministe
 * des BCs dans la fenetre d ambiguite autour du seuil client.
 *
 * Responsabilites UNIQUES de ce module :
 *   1. Verifier que le score est dans la fenetre avant tout appel LLM
 *   2. Valider l entree (RerankerInput via Zod)
 *   3. Verifier le cache (cle deterministe : client_id + bc_id + score + criteres)
 *   4. Construire un prompt court : score breakdown, criteres, positive/negative reasons
 *   5. Appeler ILLMClient.call() et parser la reponse JSON
 *   6. Appliquer la prudence : evidence faible -> delta 0, contradiction -> warning
 *   7. Valider via RerankerOutputSchema (Zod rejette si delta hors [-5, +5])
 *   8. Retourner RerankerResult discrimine (advisory, jamais decisionnel)
 *
 * Ce module ne fait PAS :
 *   - Decider de notifier ou d ignorer un BC
 *   - Modifier le score final deterministe
 *   - Acces Supabase ou base de donnees
 *   - Branchement dans le pipeline existant
 *
 * Garanties structurelles (dans le schema Zod) :
 *   - rerank_delta in [-5, +5] : Zod rejette si hors bornes
 *   - final_score_authority === 'deterministic' : z.literal('deterministic')
 *   - score_in_ambiguity_window === true : z.literal(true) sur l entree
 *
 * Regle : jamais de `any`. Toute donnee manquante -> valeur par defaut explicite.
 */

import {
  RerankerInput,
  RerankerInputSchema,
  RerankerOutput,
  RerankerOutputSchema,
  applyRerankDelta,
  isInAmbiguityWindow,
} from './schemas/reranker.schema';

import { LLMRequestSchema } from './schemas/llm-client.schema';
import { ILLMClient }        from './llm-client';
import { ICache }            from './cache';
import {
  RERANK_WINDOW_BELOW,
  RERANK_WINDOW_ABOVE,
  HIGH_CONFIDENCE_THRESHOLD,
  MAX_LLM_PROMPT_CHARS,
} from './constants';

// --- Warning codes -----------------------------------------------------------

export type RerankerWarningCode =
  | 'low_confidence_delta_zeroed'
  | 'high_confidence_no_evidence'
  | 'mixed_signals_detected'
  | 'cache_payload_invalid'
  | 'cache_store_failed';

export interface RerankerWarning {
  code:    RerankerWarningCode;
  message: string;
}

// --- Error codes -------------------------------------------------------------

export type RerankerErrorCode =
  | 'score_out_of_window'
  | 'invalid_input'
  | 'prompt_too_long'
  | 'llm_error'
  | 'parse_error'
  | 'validation_error'
  | 'unknown';

export interface RerankerError {
  code:    RerankerErrorCode;
  message: string;
}

// --- Result discrimine -------------------------------------------------------

/**
 * Le resultat du reranker est TOUJOURS advisory.
 * Le code appelant est seul responsable de decider si appliquer adjusted_score.
 * final_score_authority: 'deterministic' est une garantie structurelle.
 */
export type RerankerResult =
  | { ok: true;  output: RerankerOutput; warnings: RerankerWarning[] }
  | { ok: false; error:  RerankerError };

// --- Forme brute de la reponse LLM -------------------------------------------

interface RawRerankerLLMResponse {
  rerank_delta:     number;
  confidence_score: number;
  evidence:         string;
  reason:           string;
  mixed_signals:    boolean;
}

function isRawRerankerLLMResponse(raw: unknown): raw is RawRerankerLLMResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['rerank_delta']     === 'number'  &&
    typeof r['confidence_score'] === 'number'  &&
    typeof r['evidence']         === 'string'  &&
    typeof r['reason']           === 'string'  &&
    typeof r['mixed_signals']    === 'boolean'
  );
}

// --- Seuil d evidence minimum ------------------------------------------------

/** Nombre de caracteres minimum pour qu une evidence soit consideree substantielle. */
const MIN_EVIDENCE_CHARS = 15;

// --- Log entry ---------------------------------------------------------------

export interface RerankerLogEntry {
  level:               'info' | 'warn' | 'error';
  event:               string;
  bc_id:               string;
  client_id:           string;
  model:               string;
  deterministic_score: number;
  score_threshold:     number;
  rerank_delta?:       number;
  cache_hit?:          boolean;
  warnings?:           RerankerWarningCode[];
  error_code?:         RerankerErrorCode;
}

// --- Options -----------------------------------------------------------------

export interface BoundedRerankerOptions {
  model:   string;
  logger?: (entry: RerankerLogEntry) => void;
}

// --- BoundedReranker ---------------------------------------------------------

export class BoundedReranker {
  private readonly model:  string;
  private readonly logger: (entry: RerankerLogEntry) => void;

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly cache:     ICache,
    options: BoundedRerankerOptions,
  ) {
    this.model  = options.model;
    this.logger = options.logger ?? defaultRerankerLogger;
  }

  // --- rerank ----------------------------------------------------------------

  /**
   * Propose un rerank_delta advisory pour un BC dans la fenetre d ambiguite.
   *
   * Precondition : le score DOIT etre dans [seuil - WINDOW_BELOW, seuil + WINDOW_ABOVE].
   * Si hors fenetre -> retourne score_out_of_window SANS appeler le LLM.
   */
  async rerank(rawInput: unknown): Promise<RerankerResult> {
    // 1. Verifier la fenetre d ambiguite AVANT la validation Zod complete
    //    pour retourner une erreur semantique si le score est hors fenetre
    const preCheck = this.checkAmbiguityWindow(rawInput);
    if (preCheck !== null) return preCheck;

    // 2. Validation Zod complete
    const parsed = RerankerInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok:    false,
        error: { code: 'invalid_input', message: parsed.error.message },
      };
    }
    const input = parsed.data;

    // 3. Calculer la cle de cache
    const cacheContent = buildRerankerCacheContent(input);
    const cacheKey = this.cache.computeKey({
      model:     this.model,
      task_type: 'reranking',
      content:   cacheContent,
    });

    // 3b. Initialiser preWarnings (cache_payload_invalid doit apparaitre dans le resultat)
    const preWarnings: RerankerWarning[] = [];

    // 4. Verifier le cache
    const cacheHit = this.cache.get(cacheKey, 'reranking');
    if (cacheHit.hit) {
      const cached = this.tryParseCachedPayload(cacheHit.entry.payload);
      if (cached !== null) {
        this.log({
          level: 'info', event: 'reranker_cache_hit',
          bc_id: input.bc_id, client_id: input.client_id,
          model: this.model,
          deterministic_score: input.deterministic_score,
          score_threshold:     input.score_threshold,
          cache_hit: true,
        });
        return { ok: true, output: cached, warnings: [] };
      }
      // Payload invalide -- propager le warning au caller via preWarnings
      preWarnings.push({ code: 'cache_payload_invalid', message: 'Payload cache invalide -- LLM appele en fallback' });
      this.log({
        level: 'warn', event: 'reranker_cache_payload_invalid',
        bc_id: input.bc_id, client_id: input.client_id,
        model: this.model,
        deterministic_score: input.deterministic_score,
        score_threshold:     input.score_threshold,
        warnings: ['cache_payload_invalid'],
      });
    }

    // 5. Construire le prompt et valider le LLMRequest
    const prompt = buildRerankerPrompt(input);

    if (prompt.length > MAX_LLM_PROMPT_CHARS) {
      return {
        ok:    false,
        error: { code: 'prompt_too_long', message: `Prompt trop long (${prompt.length} chars > ${MAX_LLM_PROMPT_CHARS}). Reduire les criteres ou l extrait BC.` },
      };
    }

    const llmReqParsed = LLMRequestSchema.safeParse({
      model:     this.model,
      prompt,
      task_type: 'reranking',
    });
    if (!llmReqParsed.success) {
      return {
        ok:    false,
        error: { code: 'unknown', message: `LLMRequest invalide: ${llmReqParsed.error.message}` },
      };
    }

    // 6. Appeler le LLM
    const llmResult = await this.llmClient.call(llmReqParsed.data);

    if (!llmResult.ok) {
      this.log({
        level: 'error', event: 'reranker_llm_error',
        bc_id: input.bc_id, client_id: input.client_id,
        model: this.model,
        deterministic_score: input.deterministic_score,
        score_threshold:     input.score_threshold,
        error_code: 'llm_error',
      });
      return {
        ok:    false,
        error: { code: 'llm_error', message: llmResult.error.message },
      };
    }

    // 7. Parser, valider, stocker
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
   * Verifie si le score est dans la fenetre d ambiguite.
   * Retourne une RerankerResult erreur si hors fenetre, null sinon.
   * S execute AVANT la validation Zod pour un feedback semantique immediat.
   */
  private checkAmbiguityWindow(rawInput: unknown): RerankerResult | null {
    if (typeof rawInput !== 'object' || rawInput === null) return null;
    const r = rawInput as Record<string, unknown>;
    const score     = typeof r['deterministic_score'] === 'number' ? r['deterministic_score'] : null;
    const threshold = typeof r['score_threshold']     === 'number' ? r['score_threshold']     : null;

    if (score === null || threshold === null) return null; // Zod gerera le cas manquant

    if (!isInAmbiguityWindow(score, threshold)) {
      const lo = threshold - RERANK_WINDOW_BELOW;
      const hi = threshold + RERANK_WINDOW_ABOVE;
      return {
        ok:    false,
        error: {
          code:    'score_out_of_window',
          message: `Score ${score} hors fenetre d ambiguite [${lo}, ${hi}] ` +
                   `(seuil ${threshold}, window [-${RERANK_WINDOW_BELOW}, +${RERANK_WINDOW_ABOVE}]). ` +
                   'Le reranker ne doit pas etre appele pour ce BC.',
        },
      };
    }
    return null;
  }

  private tryParseCachedPayload(payload: string): RerankerOutput | null {
    try {
      const raw    = JSON.parse(payload) as unknown;
      const parsed = RerankerOutputSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private processLLMResponse(
    content:     string,
    llmModel:    string,
    input:       RerankerInput,
    cacheKey:    string,
    preWarnings: RerankerWarning[] = [],
  ): RerankerResult {
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

    if (!isRawRerankerLLMResponse(raw)) {
      return {
        ok:    false,
        error: {
          code:    'parse_error',
          message: 'Reponse LLM manque des champs requis ' +
                   '(rerank_delta, confidence_score, evidence, reason, mixed_signals)',
        },
      };
    }

    const warnings: RerankerWarning[] = [...preWarnings];

    // Normaliser confidence_score dans [0, 1]
    const confidence_score = Math.min(1, Math.max(0, raw.confidence_score));

    // Evidence substantielle ?
    const evidenceIsWeak = raw.evidence.trim().length < MIN_EVIDENCE_CHARS;

    // Prudence : evidence faible -> forcer delta a 0
    let rerank_delta = raw.rerank_delta;
    if (evidenceIsWeak && rerank_delta !== 0) {
      warnings.push({
        code:    'low_confidence_delta_zeroed',
        message: `Evidence trop courte (${raw.evidence.trim().length} chars < ${MIN_EVIDENCE_CHARS}). ` +
                 `Delta force a 0 (etait ${rerank_delta}).`,
      });
      rerank_delta = 0;
    }

    // LLM trop confiant sans evidence
    if (confidence_score > HIGH_CONFIDENCE_THRESHOLD && evidenceIsWeak) {
      warnings.push({
        code:    'high_confidence_no_evidence',
        message: `Confidence elevee (${confidence_score}) sans evidence substantielle. ` +
                 'Resultat traite avec prudence.',
      });
    }

    // Signaux contradictoires
    if (raw.mixed_signals) {
      warnings.push({
        code:    'mixed_signals_detected',
        message: 'Le LLM a detecte des signaux contradictoires dans le BC. ' +
                 `Delta applique : ${rerank_delta}.`,
      });
    }

    // Calculer applied_score via applyRerankDelta (clampe dans [0, 100])
    // NOTE : rerank_delta n est pas encore valide par Zod --
    // si hors [-5,+5], la validation du candidat echouera -> validation_error
    const applied_score = applyRerankDelta(input.deterministic_score, rerank_delta);

    // Construire le candidat RerankerOutput
    const candidate = {
      bc_id:                  input.bc_id,
      client_id:              input.client_id,
      rerank_delta,
      reason:                 typeof raw.reason === 'string' ? raw.reason : '',
      final_score_authority:  'deterministic' as const,
      applied_score,
      confidence_score,
      evidence:               typeof raw.evidence === 'string' ? raw.evidence : '',
      source_type:            'llm'       as const,
      created_at:             new Date().toISOString(),
      model:                  llmModel,
      task_type:              'reranking' as const,
    };

    // Validation Zod -- rejecte si rerank_delta hors [-5, +5]
    const validated = RerankerOutputSchema.safeParse(candidate);
    if (!validated.success) {
      return {
        ok:    false,
        error: {
          code:    'validation_error',
          message: `Validation RerankerOutput echouee: ${validated.error.message}`,
        },
      };
    }

    const output = validated.data;

    // Stocker en cache (non fatal)
    try {
      this.cache.set(cacheKey, JSON.stringify(output), {
        model:     this.model,
        task_type: 'reranking',
        tags:      [`client_id:${input.client_id}`, `bc_id:${input.bc_id}`],
      });
    } catch {
      warnings.push({
        code:    'cache_store_failed',
        message: 'Impossible de stocker le resultat en cache (non fatal)',
      });
    }

    this.log({
      level:               warnings.length > 0 ? 'warn' : 'info',
      event:               'reranker_success',
      bc_id:               input.bc_id,
      client_id:           input.client_id,
      model:               this.model,
      deterministic_score: input.deterministic_score,
      score_threshold:     input.score_threshold,
      rerank_delta:        output.rerank_delta,
      cache_hit:           false,
      warnings:            warnings.map(w => w.code),
    });

    return { ok: true, output, warnings };
  }

  private log(entry: RerankerLogEntry): void {
    this.logger(entry);
  }
}

// --- Fonctions pures exportees -----------------------------------------------

/**
 * Construit le prompt de reranking.
 * Court et cible : score breakdown, criteres, positive/negative reasons,
 * question sur l ajustement. Le reranker conseille, il ne decide pas.
 */
export function buildRerankerPrompt(input: RerankerInput): string {
  const criteresStr = input.critere_texts
    .slice(0, 4)
    .map((t, i) => `  ${String(i + 1)}. ${t.slice(0, 100)}`)
    .join('\n');

  const excerptStr = input.bc_text_excerpt.length > 0
    ? `\nExtrait BC : "${input.bc_text_excerpt.slice(0, 300)}"`
    : '';

  const lo = input.score_threshold - RERANK_WINDOW_BELOW;
  const hi = input.score_threshold + RERANK_WINDOW_ABOVE;

  return (
    'Tu es un expert en evaluation de marches publics.\n' +
    'Un bon de commande est dans la zone d ambiguite de pertinence.\n\n' +
    'Score deterministe : ' + String(input.deterministic_score) + '/100\n' +
    'Seuil client : ' + String(input.score_threshold) + '/100\n' +
    'Fenetre d ambiguite : [' + String(lo) + ', ' + String(hi) + ']\n\n' +
    'Criteres actifs du client :\n' + criteresStr + '\n' +
    excerptStr + '\n\n' +
    'Question : Ce score ambigu merite-t-il un leger ajustement ?\n\n' +
    'Reponds en JSON uniquement :\n' +
    '{\n' +
    '  "rerank_delta": 0,\n' +
    '  "confidence_score": 0.0,\n' +
    '  "evidence": "...",\n' +
    '  "reason": "...",\n' +
    '  "mixed_signals": false\n' +
    '}\n\n' +
    'Regles strictes :\n' +
    '- rerank_delta DOIT etre entre -5 et +5 (entier ou decimal)\n' +
    '- Si tu n es pas certain : utilise 0 ou une valeur proche de 0\n' +
    '- evidence : cite des elements concrets du BC ou des criteres (min 15 chars)\n' +
    '- reason : justification courte du delta propose\n' +
    '- mixed_signals: true si les criteres pointent des directions contradictoires\n' +
    '- Tu ne decides PAS de notifier ni d ignorer -- tu proposes un ajustement\n' +
    'Ne retourne rien en dehors du JSON.'
  );
}

/**
 * Construit le contenu normalise pour la cle de cache.
 * Encode : client_id + bc_id + score + seuil + criteres normalises.
 */
export function buildRerankerCacheContent(input: RerankerInput): string {
  const criteresStr = input.critere_texts
    .map(t => t.trim().toLowerCase())
    .join('|');
  const excerptStr  = input.bc_text_excerpt.trim().toLowerCase();
  return (
    `${input.client_id}|${input.bc_id}|` +
    `${String(input.deterministic_score)}|${String(input.score_threshold)}|` +
    `${criteresStr}|${excerptStr}`
  );
}

// --- Logger par defaut -------------------------------------------------------

function defaultRerankerLogger(entry: RerankerLogEntry): void {
  if (entry.level === 'error') {
    console.error(`[BoundedReranker] ${entry.event}`, entry);
  } else if (entry.level === 'warn') {
    console.warn(`[BoundedReranker] ${entry.event}`, entry);
  }
}

// --- Factory -----------------------------------------------------------------

export function createBoundedReranker(
  llmClient: ILLMClient,
  cache:     ICache,
  model:     string,
  logger?:   (entry: RerankerLogEntry) => void,
): BoundedReranker {
  const opts: BoundedRerankerOptions = logger !== undefined
    ? { model, logger }
    : { model };
  return new BoundedReranker(llmClient, cache, opts);
}
