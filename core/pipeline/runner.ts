/**
 * Pipeline Runner — Anaho
 *
 * Orchestre les 4 étapes du pipeline de démonstration :
 *
 *   1. Parse     — RawBC → ParsedBC (mockParseBc)
 *   2. Classify  — ParsedBC → ClassificationSummary (classifyArticles)
 *   3. Score     — ParsedBC + ClientProfile + Criteres → ScoreComponents (scoreBC)
 *   4. Decide    — ScoreComponents → PipelineResult final
 *
 * Ce runner est indépendant de la production.
 * Il ne fait aucune requête réseau, aucun accès Supabase, aucun appel LLM.
 *
 * Usage :
 *   const result = runPipeline({ raw, client, criteres });
 *   if (isPipelineResult(result)) {
 *     console.log(result.final_decision, result.final_score);
 *   }
 */

import { type ClientProfile, type Critere } from '@core/schemas/client.schema';
import { scoreBC } from '@core/scoring/engine';
import { mockParseBc } from './mock-parser';
import { classifyArticles, formatClassificationSummary } from './mock-classifier';
import {
  type RawBC,
  type PipelineResult,
  type PipelineError,
  type PipelineOutcome,
} from './types';

// ─── Input du runner ──────────────────────────────────────────────────────────

export interface PipelineInput {
  raw:      RawBC;
  client:   ClientProfile;
  criteres: readonly Critere[];
}

// ─── Runner principal ─────────────────────────────────────────────────────────

/**
 * Exécute le pipeline complet sur un BC brut.
 *
 * @returns PipelineResult (succès) ou PipelineError (échec parsing)
 *
 * En cas d'échec de parsing, retourne un PipelineError avec la raison.
 * Le scoring n'est jamais tenté si le parsing a échoué.
 */
export function runPipeline(input: PipelineInput): PipelineOutcome {
  const t0 = Date.now();
  const { raw, client, criteres } = input;

  // ── Étape 1 : Parsing ────────────────────────────────────────────────────
  const parseResult = mockParseBc(raw);

  if (!parseResult.success) {
    const err: PipelineError = {
      bc_id:     raw.id ?? '(inconnu)',
      client_id: client.id,
      stage:     'parse',
      error:     parseResult.error,
      raw_input: raw,
    };
    return err;
  }

  const parsed = parseResult.parsed;

  // ── Étape 2 : Classification des articles ────────────────────────────────
  const classification = classifyArticles(parsed);

  // ── Étape 3 : Scoring déterministe ──────────────────────────────────────
  const scoreComponents = scoreBC(parsed, client, criteres);

  // ── Étape 4 : Explication finale ─────────────────────────────────────────
  const classifSummary = formatClassificationSummary(classification);

  const explanationParts: string[] = [
    `[PIPELINE] BC "${parsed.objet || parsed.id}" → ${scoreComponents.final_decision.toUpperCase()} (${scoreComponents.final_score}/100)`,
    `[PARSE]    ${parsed.articles.length} articles extraits${parseResult.warnings.length > 0 ? ` — ⚠ ${parseResult.warnings.join(', ')}` : ''}`,
    `[CLASSIFY] ${classifSummary}`,
    `[SCORE]    ${scoreComponents.explanation}`,
  ];

  if (scoreComponents.details.exclusion_reasons.length > 0) {
    explanationParts.push(
      `[EXCL]     ${scoreComponents.details.exclusion_reasons.join(' / ')}`,
    );
  }

  const result: PipelineResult = {
    bc_id:    parsed.id,
    client_id: client.id,

    stages: {
      raw_input:        raw,
      parse_result:     parseResult,
      classification,
      score_components: scoreComponents,
    },

    final_decision: scoreComponents.final_decision,
    final_score:    scoreComponents.final_score,
    explanation:    explanationParts.join('\n'),
    duration_ms:    Date.now() - t0,
  };

  return result;
}

// ─── Batch runner ─────────────────────────────────────────────────────────────

export interface BatchInput {
  raws:     RawBC[];
  client:   ClientProfile;
  criteres: readonly Critere[];
}

export interface BatchResult {
  total:    number;
  notify:   PipelineResult[];
  rerank:   PipelineResult[];
  ignore:   PipelineResult[];
  errors:   PipelineError[];
  duration_ms: number;
}

/**
 * Exécute le pipeline sur un lot de BCs et classe les résultats par décision.
 * Utile pour les tests et la démonstration d'un scan complet.
 */
export function runBatchPipeline(input: BatchInput): BatchResult {
  const t0 = Date.now();
  const notify:  PipelineResult[] = [];
  const rerank:  PipelineResult[] = [];
  const ignore:  PipelineResult[] = [];
  const errors:  PipelineError[]  = [];

  for (const raw of input.raws) {
    const outcome = runPipeline({ raw, client: input.client, criteres: input.criteres });

    if ('final_score' in outcome) {
      if (outcome.final_decision === 'notify')  notify.push(outcome);
      else if (outcome.final_decision === 'rerank') rerank.push(outcome);
      else                                      ignore.push(outcome);
    } else {
      errors.push(outcome);
    }
  }

  // Trier les notify par score décroissant
  notify.sort((a, b) => b.final_score - a.final_score);

  return {
    total: input.raws.length,
    notify,
    rerank,
    ignore,
    errors,
    duration_ms: Date.now() - t0,
  };
}
