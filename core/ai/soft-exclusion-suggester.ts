/**
 * Soft Exclusion Suggester -- Anaho
 *
 * Analyse des feedbacks not_relevant/partial groupes et propose des candidats
 * SoftExclusion pour revue humaine obligatoire.
 *
 * Responsabilites UNIQUES de ce module :
 *   1. Valider l entree (SoftExclusionSuggesterInput via Zod)
 *   2. Verifier le cache (cle deterministe : client_id + hash feedbacks)
 *   3. Construire un prompt listant les feedbacks et demandant des patterns
 *      contextuels (jamais lexicaux)
 *   4. Appeler ILLMClient.call() et parser la reponse JSON
 *   5. Filtrer les patterns naifs (< 3 mots, trop generiques)
 *   6. Valider not_applicable_if obligatoire pour chaque candidat
 *   7. Borner a SOFT_EXCLUSION_MAX_CANDIDATES (5)
 *   8. Valider via SoftExclusionSuggesterOutputSchema
 *
 * Garanties structurelles (dans le schema Zod) :
 *   - requires_review: z.literal(true) sur chaque candidat
 *   - trigger_count >= SOFT_EXCLUSION_MIN_FEEDBACKS (3)
 *   - proposed_exclusions.length <= SOFT_EXCLUSION_MAX_CANDIDATES (5)
 *
 * Ce module ne fait PAS :
 *   - Creer des exclusions fortes (jamais)
 *   - Modifier le profil client
 *   - Acces Supabase ou base de donnees
 *   - Branchement dans le pipeline existant
 *
 * Regle : jamais de `any`. Toute donnee manquante -> valeur par defaut explicite.
 */

import { createHash } from 'crypto';

import {
  SoftExclusionSuggesterInput,
  SoftExclusionSuggesterInputSchema,
  SoftExclusionSuggesterOutput,
  SoftExclusionSuggesterOutputSchema,
  SoftExclusionCandidate,
  SoftExclusionCandidateSchema,
} from './schemas/soft-exclusion-suggester.schema';

import { LLMRequestSchema } from './schemas/llm-client.schema';
import { ILLMClient }        from './llm-client';
import { ICache }            from './cache';
import {
  SOFT_EXCLUSION_MIN_FEEDBACKS,
  SOFT_EXCLUSION_MAX_CANDIDATES,
  MAX_LLM_PROMPT_CHARS,
} from './constants';

// --- Warning codes -----------------------------------------------------------

export type SoftExclusionSuggesterWarningCode =
  | 'insufficient_feedback'
  | 'low_similarity'
  | 'naive_patterns_filtered'
  | 'candidates_truncated'
  | 'patterns_skipped_existing'
  | 'cache_payload_invalid'
  | 'cache_store_failed';

export interface SoftExclusionSuggesterWarning {
  code:    SoftExclusionSuggesterWarningCode;
  message: string;
}

// --- Error codes -------------------------------------------------------------

export type SoftExclusionSuggesterErrorCode =
  | 'invalid_input'
  | 'prompt_too_long'
  | 'llm_error'
  | 'parse_error'
  | 'validation_error'
  | 'unknown';

export interface SoftExclusionSuggesterError {
  code:    SoftExclusionSuggesterErrorCode;
  message: string;
}

// --- Result discrimine -------------------------------------------------------

export type SoftExclusionSuggesterResult =
  | { ok: true;  output: SoftExclusionSuggesterOutput; warnings: SoftExclusionSuggesterWarning[] }
  | { ok: false; error:  SoftExclusionSuggesterError };

// --- Forme brute de la reponse LLM -------------------------------------------

/**
 * Candidat brut tel que retourne par le LLM.
 * Contient des champs supplementaires (not_applicable_if, affected_signals,
 * proposed_penalty) qui seront consolides dans le champ `rationale` du schema.
 */
interface RawCandidate {
  pattern:           string;
  pattern_type:      string;
  proposed_penalty:  number;
  evidence:          string;
  confidence_score:  number;
  trigger_count:     number;
  affected_signals:  string[];
  not_applicable_if: string;
}

interface RawSuggesterLLMResponse {
  candidates: RawCandidate[];
}

function isRawCandidate(raw: unknown): raw is RawCandidate {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['pattern']           === 'string'  &&
    typeof r['pattern_type']      === 'string'  &&
    typeof r['proposed_penalty']  === 'number'  &&
    typeof r['evidence']          === 'string'  &&
    typeof r['confidence_score']  === 'number'  &&
    typeof r['trigger_count']     === 'number'  &&
    Array.isArray(r['affected_signals'])        &&
    typeof r['not_applicable_if'] === 'string'
  );
}

function isRawSuggesterLLMResponse(raw: unknown): raw is RawSuggesterLLMResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return Array.isArray(r['candidates']);
}

// --- Log entry ---------------------------------------------------------------

export interface SuggesterLogEntry {
  level:       'info' | 'warn' | 'error';
  event:       string;
  client_id:   string;
  model:       string;
  n_feedbacks: number;
  n_proposed?: number;
  cache_hit?:  boolean;
  warnings?:   SoftExclusionSuggesterWarningCode[];
  error_code?: SoftExclusionSuggesterErrorCode;
}

// --- Options -----------------------------------------------------------------

export interface SoftExclusionSuggesterOptions {
  model:   string;
  logger?: (entry: SuggesterLogEntry) => void;
}

// --- SoftExclusionSuggester --------------------------------------------------

export class SoftExclusionSuggester {
  private readonly model:  string;
  private readonly logger: (entry: SuggesterLogEntry) => void;

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly cache:     ICache,
    options: SoftExclusionSuggesterOptions,
  ) {
    this.model  = options.model;
    this.logger = options.logger ?? defaultSuggesterLogger;
  }

  // --- suggest ---------------------------------------------------------------

  async suggest(rawInput: unknown): Promise<SoftExclusionSuggesterResult> {
    // 1. Valider l entree
    const parsed = SoftExclusionSuggesterInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        ok:    false,
        error: { code: 'invalid_input', message: parsed.error.message },
      };
    }
    const input = parsed.data;

    // 2. Calculer la cle de cache
    const cacheContent = buildSuggesterCacheContent(input);
    const cacheKey = this.cache.computeKey({
      model:     this.model,
      task_type: 'soft_exclusion_suggestion',
      content:   cacheContent,
    });

    // 3. Verifier le cache
    const preWarnings: SoftExclusionSuggesterWarning[] = [];
    const cacheHit = this.cache.get(cacheKey, 'soft_exclusion_suggestion');
    if (cacheHit.hit) {
      const cached = this.tryParseCachedPayload(cacheHit.entry.payload);
      if (cached !== null) {
        this.log({
          level: 'info', event: 'suggester_cache_hit',
          client_id: input.client_id, model: this.model,
          n_feedbacks: input.feedbacks.length, cache_hit: true,
        });
        return { ok: true, output: cached, warnings: [] };
      }
      // Payload invalide : on logge ET on propage le warning au caller
      preWarnings.push({
        code:    'cache_payload_invalid',
        message: 'Payload cache invalide — LLM appele en fallback',
      });
      this.log({
        level: 'warn', event: 'suggester_cache_payload_invalid',
        client_id: input.client_id, model: this.model,
        n_feedbacks: input.feedbacks.length, warnings: ['cache_payload_invalid'],
      });
    }

    // 4. Construire le prompt
    const prompt = buildSuggesterPrompt(input);

    if (prompt.length > MAX_LLM_PROMPT_CHARS) {
      return {
        ok:    false,
        error: { code: 'prompt_too_long', message: `Prompt trop long (${prompt.length} chars > ${MAX_LLM_PROMPT_CHARS}). Reduire les feedbacks.` },
      };
    }

    const llmReqParsed = LLMRequestSchema.safeParse({
      model:     this.model,
      prompt,
      task_type: 'soft_exclusion_suggestion',
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
        level: 'error', event: 'suggester_llm_error',
        client_id: input.client_id, model: this.model,
        n_feedbacks: input.feedbacks.length, error_code: 'llm_error',
      });
      return {
        ok:    false,
        error: { code: 'llm_error', message: llmResult.error.message },
      };
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

  private tryParseCachedPayload(payload: string): SoftExclusionSuggesterOutput | null {
    try {
      const raw    = JSON.parse(payload) as unknown;
      const parsed = SoftExclusionSuggesterOutputSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private processLLMResponse(
    content:     string,
    llmModel:    string,
    input:       SoftExclusionSuggesterInput,
    cacheKey:    string,
    preWarnings: SoftExclusionSuggesterWarning[] = [],
  ): SoftExclusionSuggesterResult {
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

    if (!isRawSuggesterLLMResponse(raw)) {
      return {
        ok:    false,
        error: {
          code:    'parse_error',
          message: 'Reponse LLM manque le champ "candidates" (array)',
        },
      };
    }

    const warnings: SoftExclusionSuggesterWarning[] = [...preWarnings];
    const feedbackIds = input.feedbacks.map(f => f.bc_id);

    // Traiter chaque candidat brut
    const naiveFiltered:    string[] = [];
    const missingNAI:       string[] = [];
    const skippedExisting:  string[] = [];
    const validCandidates:  SoftExclusionCandidate[] = [];

    for (const rawCand of raw.candidates) {
      // Verifier la structure minimale
      if (!isRawCandidate(rawCand)) continue;

      // Filtrer les patterns naifs (< 3 mots = trop lexical)
      const wordCount = rawCand.pattern.trim().split(/\s+/).length;
      if (wordCount < 3) {
        naiveFiltered.push(rawCand.pattern);
        continue;
      }

      // not_applicable_if obligatoire et non vide
      if (rawCand.not_applicable_if.trim().length === 0) {
        missingNAI.push(rawCand.pattern);
        continue;
      }

      // Eviter les patterns deja existants
      if (input.existing_exclusion_patterns.includes(rawCand.pattern)) {
        skippedExisting.push(rawCand.pattern);
        continue;
      }

      // trigger_count doit etre >= MIN_FEEDBACKS
      const trigger_count = Math.max(
        SOFT_EXCLUSION_MIN_FEEDBACKS,
        Math.min(rawCand.trigger_count, input.feedbacks.length),
      );

      // Mapper confidence_score -> confidence enum
      const confidence = mapConfidenceScore(rawCand.confidence_score);

      // Construire le rationale en incluant tous les champs supplementaires
      const affectedStr = rawCand.affected_signals.length > 0
        ? ` | Signaux: ${rawCand.affected_signals.join(', ')}`
        : '';
      const rationale = (
        `${rawCand.evidence} | ` +
        `Non applicable si: ${rawCand.not_applicable_if}` +
        affectedStr +
        ` | Penalite suggeree: ${String(rawCand.proposed_penalty)}`
      );

      // Construire et valider le candidat via Zod
      const candidateParsed = SoftExclusionCandidateSchema.safeParse({
        pattern:         rawCand.pattern,
        pattern_type:    rawCand.pattern_type,
        trigger_count,
        feedback_ids:    feedbackIds.slice(0, Math.max(SOFT_EXCLUSION_MIN_FEEDBACKS, trigger_count)),
        confidence,
        requires_review: true,
        rationale,
      });

      if (candidateParsed.success) {
        validCandidates.push(candidateParsed.data);
      }
    }

    // Avertir si patterns naifs filtres
    if (naiveFiltered.length > 0) {
      warnings.push({
        code:    'naive_patterns_filtered',
        message: `${naiveFiltered.length} pattern(s) naif(s) filtre(s) (< 3 mots): ${naiveFiltered.join(', ')}`,
      });
    }

    // Avertir si patterns existants ignores
    if (skippedExisting.length > 0) {
      warnings.push({
        code:    'patterns_skipped_existing',
        message: `${skippedExisting.length} pattern(s) deja existant(s) ignore(s): ${skippedExisting.join(', ')}`,
      });
    }

    // Si aucun candidat valide -> warning low_similarity
    if (validCandidates.length === 0) {
      warnings.push({
        code:    'low_similarity',
        message: 'Aucun candidat valide propose par le LLM. ' +
                 'Les feedbacks sont peut-etre trop heterogenes pour identifier un pattern commun.',
      });
    }

    // Borner a SOFT_EXCLUSION_MAX_CANDIDATES
    let proposed_exclusions = validCandidates;
    if (validCandidates.length > SOFT_EXCLUSION_MAX_CANDIDATES) {
      proposed_exclusions = validCandidates.slice(0, SOFT_EXCLUSION_MAX_CANDIDATES);
      warnings.push({
        code:    'candidates_truncated',
        message: `${validCandidates.length} candidats tronques a ${SOFT_EXCLUSION_MAX_CANDIDATES}`,
      });
    }

    // Construire la sortie
    const candidate = {
      client_id:           input.client_id,
      proposed_exclusions,
      feedbacks_analyzed:  input.feedbacks.length,
      patterns_skipped:    skippedExisting,
      confidence_score:    computeOutputConfidenceScore(proposed_exclusions),
      evidence:            buildOutputEvidence(proposed_exclusions, input.feedbacks.length),
      source_type:         'llm'                      as const,
      created_at:          new Date().toISOString(),
      model:               llmModel,
      task_type:           'soft_exclusion_suggestion' as const,
    };

    const validated = SoftExclusionSuggesterOutputSchema.safeParse(candidate);
    if (!validated.success) {
      return {
        ok:    false,
        error: {
          code:    'validation_error',
          message: `Validation SoftExclusionSuggesterOutput echouee: ${validated.error.message}`,
        },
      };
    }

    const output = validated.data;

    // Stocker en cache (non fatal)
    try {
      this.cache.set(cacheKey, JSON.stringify(output), {
        model:     this.model,
        task_type: 'soft_exclusion_suggestion',
        tags:      [`client_id:${input.client_id}`],
      });
    } catch {
      warnings.push({
        code:    'cache_store_failed',
        message: 'Impossible de stocker le resultat en cache (non fatal)',
      });
    }

    this.log({
      level:       warnings.length > 0 ? 'warn' : 'info',
      event:       'suggester_success',
      client_id:   input.client_id,
      model:       this.model,
      n_feedbacks: input.feedbacks.length,
      n_proposed:  output.proposed_exclusions.length,
      cache_hit:   false,
      warnings:    warnings.map(w => w.code),
    });

    return { ok: true, output, warnings };
  }

  private log(entry: SuggesterLogEntry): void {
    this.logger(entry);
  }
}

// --- Fonctions pures exportees -----------------------------------------------

/**
 * Construit le prompt du suggester.
 * Liste les feedbacks avec trigger_text et categorie.
 * Demande des exclusions contextuelles (>= 3 mots, with not_applicable_if).
 */
export function buildSuggesterPrompt(input: SoftExclusionSuggesterInput): string {
  const feedbacksStr = input.feedbacks
    .slice(0, 10)
    .map((f, i) => {
      const cat     = f.bc_category.length > 0 ? ` | Categorie: ${f.bc_category}` : '';
      const trigger = f.trigger_text.length > 0 ? ` | Texte: "${f.trigger_text.slice(0, 80)}"` : '';
      return `  ${String(i + 1)}. Verdict: ${f.verdict}${cat}${trigger}`;
    })
    .join('\n');

  const existingStr = input.existing_exclusion_patterns.length > 0
    ? `\nPatterns deja actifs (ne pas dupliquer) : ${input.existing_exclusion_patterns.join(', ')}`
    : '';

  return (
    'Tu es un expert en marches publics algeriens.\n' +
    'Analyse ces feedbacks negatifs et propose des patterns d exclusion contextuels.\n\n' +
    'Feedbacks not_relevant / partial :\n' +
    feedbacksStr + '\n' +
    existingStr + '\n\n' +
    'Reponds en JSON uniquement :\n' +
    '{\n' +
    '  "candidates": [\n' +
    '    {\n' +
    '      "pattern": "...",\n' +
    '      "pattern_type": "keyword|category|regex",\n' +
    '      "proposed_penalty": -20,\n' +
    '      "evidence": "...",\n' +
    '      "confidence_score": 0.0,\n' +
    '      "trigger_count": 3,\n' +
    '      "affected_signals": [...],\n' +
    '      "not_applicable_if": "..."\n' +
    '    }\n' +
    '  ]\n' +
    '}\n\n' +
    'Regles STRICTES :\n' +
    '- pattern : OBLIGATOIREMENT une phrase descriptive de 3 mots minimum\n' +
    '  INTERDIT : "achat" seul, "fourniture" seule, "split" seul\n' +
    '  AUTORISE : "achat simple climatiseur sans maintenance"\n' +
    '  AUTORISE : "fourniture seule sans pose ni SAV"\n' +
    '- not_applicable_if : OBLIGATOIRE et non vide (ex: "contrat incluant maintenance")\n' +
    '- pattern_type : "keyword" si expression, "category" si domaine, "regex" si pattern\n' +
    '- proposed_penalty : entre -50 et -5 (penalite de score negative)\n' +
    '- trigger_count : nombre de feedbacks qui correspondent a ce pattern\n' +
    '- affected_signals : liste des signaux affectes par cette exclusion\n' +
    '- Propose uniquement des patterns pour lesquels tu as >= 3 feedbacks correspondants\n' +
    '- Maximum ' + String(SOFT_EXCLUSION_MAX_CANDIDATES) + ' candidats\n' +
    'Ne retourne rien en dehors du JSON.'
  );
}

/**
 * Construit le contenu normalise pour la cle de cache.
 * Hash sur client_id + bc_ids des feedbacks + trigger_texts.
 */
export function buildSuggesterCacheContent(input: SoftExclusionSuggesterInput): string {
  const feedbackStr = input.feedbacks
    .map(f => `${f.bc_id}:${f.trigger_text.trim().toLowerCase()}:${f.verdict}`)
    .join('|');
  const raw = `${input.client_id}|${feedbackStr}`;
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Filtre les patterns naifs (< 3 mots).
 * Identique a la logique de l enricher pour la coherence.
 */
export function filterNaiveSuggesterPatterns(patterns: string[]): {
  kept:     string[];
  rejected: string[];
} {
  const kept:     string[] = [];
  const rejected: string[] = [];
  for (const p of patterns) {
    if (p.trim().split(/\s+/).length >= 3) {
      kept.push(p);
    } else {
      rejected.push(p);
    }
  }
  return { kept, rejected };
}

/**
 * Mappe un score de confiance [0, 1] vers l enum confidence.
 */
export function mapConfidenceScore(score: number): 'low' | 'medium' | 'high' {
  if (score >= 0.75) return 'high';
  if (score >= 0.5)  return 'medium';
  return 'low';
}

// --- Helpers internes --------------------------------------------------------

/**
 * Calcule un confidence_score global base sur les candidats proposes.
 */
function computeOutputConfidenceScore(candidates: SoftExclusionCandidate[]): number {
  if (candidates.length === 0) return 0.0;
  const highCount   = candidates.filter(c => c.confidence === 'high').length;
  const mediumCount = candidates.filter(c => c.confidence === 'medium').length;
  const score = (highCount * 0.85 + mediumCount * 0.6 + (candidates.length - highCount - mediumCount) * 0.4)
                / candidates.length;
  return Math.round(score * 100) / 100;
}

/**
 * Construit le champ evidence de la sortie globale.
 */
function buildOutputEvidence(
  candidates:     SoftExclusionCandidate[],
  feedbackCount:  number,
): string {
  if (candidates.length === 0) {
    return `Analyse de ${feedbackCount} feedbacks: aucun pattern commun identifie.`;
  }
  const patterns = candidates.map(c => `"${c.pattern}"`).join(', ');
  return `Analyse de ${feedbackCount} feedbacks: ${candidates.length} pattern(s) propose(s): ${patterns}. Tous requierent une revue humaine.`;
}

// --- Logger par defaut -------------------------------------------------------

function defaultSuggesterLogger(entry: SuggesterLogEntry): void {
  if (entry.level === 'error') {
    console.error(`[SoftExclusionSuggester] ${entry.event}`, entry);
  } else if (entry.level === 'warn') {
    console.warn(`[SoftExclusionSuggester] ${entry.event}`, entry);
  }
}

// --- Factory -----------------------------------------------------------------

export function createSoftExclusionSuggester(
  llmClient: ILLMClient,
  cache:     ICache,
  model:     string,
  logger?:   (entry: SuggesterLogEntry) => void,
): SoftExclusionSuggester {
  const opts: SoftExclusionSuggesterOptions = logger !== undefined
    ? { model, logger }
    : { model };
  return new SoftExclusionSuggester(llmClient, cache, opts);
}
