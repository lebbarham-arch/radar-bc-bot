/**
 * Shared AI Schema — Anaho
 *
 * Contrats communs à toutes les sorties de la couche IA locale.
 *
 * Principe architectural :
 *   Chaque sortie IA est un avis structuré, jamais une décision finale.
 *   Le scoring déterministe reste l'autorité. L'IA propose, le moteur dispose.
 *
 * Chaque sortie IA expose obligatoirement :
 *   - confidence_score  : confiance du modèle (0–1)
 *   - evidence          : justification textuelle de la sortie
 *   - source_type       : mécanisme d'inférence utilisé
 *   - created_at        : timestamp ISO de la production
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';

import { MIN_CONFIDENCE_THRESHOLD } from '../constants';

// ─── AISourceType ─────────────────────────────────────────────────────────────

/**
 * Mécanisme d'inférence ayant produit la sortie IA.
 * - `llm`       : réponse générée par un LLM (texte → texte)
 * - `embedding` : similarité cosinus sur vecteurs d'embeddings
 * - `hybrid`    : combinaison LLM + embedding
 */
export const AISourceTypeSchema = z.enum(['llm', 'embedding', 'hybrid']);
export type AISourceType = z.infer<typeof AISourceTypeSchema>;

// ─── AITaskType ───────────────────────────────────────────────────────────────

/**
 * Type de tâche IA — utilisé comme discriminant de cache et de métriques.
 */
export const AITaskTypeSchema = z.enum([
  'enrichment',
  'classification',
  'reranking',
  'opportunity_detection',
  'soft_exclusion_suggestion',
  'onboarding_advice',
  'embedding',
]);
export type AITaskType = z.infer<typeof AITaskTypeSchema>;

// ─── AIOutputBase ─────────────────────────────────────────────────────────────

/**
 * Base commune à toutes les sorties IA.
 *
 * Toute interface de sortie IA DOIT inclure ces champs.
 * Utiliser `.merge(AIOutputBaseSchema)` pour composer.
 *
 * - `confidence_score` : entre 0 et 1. En dessous de 0.5, la sortie
 *   doit être ignorée ou marquée requires_review.
 * - `evidence`         : extrait ou raisonnement court justifiant la sortie.
 * - `source_type`      : traçabilité du mécanisme d'inférence.
 * - `created_at`       : timestamp ISO 8601 de production (jamais modifié).
 * - `model`            : identifiant Ollama du modèle utilisé.
 * - `task_type`        : discriminant pour le cache et les métriques.
 */
export const AIOutputBaseSchema = z.object({
  confidence_score: z.number().min(0).max(1),
  evidence:         z.string().default(''),
  source_type:      AISourceTypeSchema,
  created_at:       z.string().datetime(),
  model:            z.string().min(1),
  task_type:        AITaskTypeSchema,
});

export type AIOutputBase = z.infer<typeof AIOutputBaseSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Verifie qu une sortie IA est exploitable.
 * Source de verite : MIN_CONFIDENCE_THRESHOLD dans constants.ts.
 * Une sortie avec confidence_score < MIN_CONFIDENCE_THRESHOLD doit etre ignoree.
 */
export function isUsableAIOutput(output: AIOutputBase): boolean {
  return output.confidence_score >= MIN_CONFIDENCE_THRESHOLD;
}

/**
 * Retourne un label lisible pour le source_type.
 */
export function describeSourceType(source: AISourceType): string {
  switch (source) {
    case 'llm':       return 'Modèle de langage local';
    case 'embedding': return 'Similarité sémantique';
    case 'hybrid':    return 'LLM + similarité sémantique';
  }
}

/**
 * Safe-parse generique d une sortie IA.
 */
export const safeParseAIOutputBase = (raw: unknown) =>
  AIOutputBaseSchema.safeParse(raw);
