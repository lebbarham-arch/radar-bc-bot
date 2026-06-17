/**
 * Soft Exclusion Suggester Schema — Anaho
 *
 * Contrats d'entrée/sortie du module de suggestion de soft exclusions.
 *
 * Rôle : analyser les feedbacks `not_relevant` groupés par pattern,
 * et proposer des candidats SoftExclusion pour revue humaine.
 *
 * Contraintes architecturales strictes :
 *   - `requires_review` est littéralement `true` dans CHAQUE candidat
 *     → aucune soft exclusion ne peut être appliquée automatiquement
 *   - Le module ne crée rien en base de données — il propose uniquement
 *   - SOFT_EXCLUSION_MIN_FEEDBACKS feedbacks minimum pour toute suggestion
 *   - SOFT_EXCLUSION_MAX_CANDIDATES candidats maximum par analyse
 *   - La confiance du candidat (`confidence`) ne remplace pas la revue humaine
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';
import { AIOutputBaseSchema } from './shared.schema';
import {
  SOFT_EXCLUSION_MIN_FEEDBACKS,
  SOFT_EXCLUSION_MAX_CANDIDATES,
} from '../constants';

// ─── FeedbackForSuggestion ────────────────────────────────────────────────────

/**
 * Feedback minimal passé au suggester (pas de PII, pas de données client).
 * Seuls les éléments nécessaires à la détection de patterns sont inclus.
 */
export const FeedbackForSuggestionSchema = z.object({
  bc_id:         z.string().min(1),
  critere_id:    z.string().optional(),
  verdict:       z.enum(['not_relevant', 'partial']),
  /** Catégorie détectée du BC (ex: "alimentaire", "bâtiment") */
  bc_category:   z.string().default(''),
  /** Texte court du BC ayant déclenché le faux positif */
  trigger_text:  z.string().default(''),
  created_at:    z.string().datetime(),
});

export type FeedbackForSuggestion = z.infer<typeof FeedbackForSuggestionSchema>;

// ─── SoftExclusionCandidate ───────────────────────────────────────────────────

/**
 * Candidat soft exclusion proposé par le suggester.
 *
 * - `pattern`         : terme ou catégorie à exclure (ex: "alimentaire")
 * - `pattern_type`    : nature du pattern ('keyword' | 'category' | 'regex')
 * - `trigger_count`   : nombre de feedbacks ayant déclenché cette suggestion
 * - `feedback_ids`    : IDs des feedbacks sources (pour traçabilité)
 * - `confidence`      : niveau de confiance de la suggestion
 * - `requires_review` : TOUJOURS true — garantie structurelle par z.literal(true)
 * - `rationale`       : explication courte pour l'interface de revue
 */
export const SoftExclusionCandidateSchema = z.object({
  pattern:      z.string().min(1),
  pattern_type: z.enum(['keyword', 'category', 'regex']),
  trigger_count: z.number().int().min(SOFT_EXCLUSION_MIN_FEEDBACKS),
  feedback_ids:  z.array(z.string()).min(SOFT_EXCLUSION_MIN_FEEDBACKS),
  confidence:    z.enum(['low', 'medium', 'high']),

  /** Garantie structurelle : toute suggestion requiert une revue humaine */
  requires_review: z.literal(true),

  rationale: z.string().default(''),
});

export type SoftExclusionCandidate = z.infer<typeof SoftExclusionCandidateSchema>;

// ─── SoftExclusionSuggesterInput ─────────────────────────────────────────────

/**
 * Entrée du module de suggestion de soft exclusions.
 *
 * - `client_id`             : client pour corrélation
 * - `feedbacks`             : feedbacks not_relevant/partial à analyser
 *                             (minimum SOFT_EXCLUSION_MIN_FEEDBACKS)
 * - `existing_exclusion_patterns` : patterns déjà actifs (pour éviter les doublons)
 */
export const SoftExclusionSuggesterInputSchema = z.object({
  client_id:                  z.string().min(1),
  feedbacks:                  z.array(FeedbackForSuggestionSchema)
                                .min(SOFT_EXCLUSION_MIN_FEEDBACKS),
  existing_exclusion_patterns: z.array(z.string()).default([]),
});

export type SoftExclusionSuggesterInput = z.infer<typeof SoftExclusionSuggesterInputSchema>;

// ─── SoftExclusionSuggesterOutput ────────────────────────────────────────────

/**
 * Sortie du module de suggestion de soft exclusions.
 *
 * - `client_id`           : client concerné
 * - `proposed_exclusions` : candidats à soumettre à revue (max SOFT_EXCLUSION_MAX_CANDIDATES)
 * - `feedbacks_analyzed`  : nombre de feedbacks analysés (pour logs)
 * - `patterns_skipped`    : patterns ignorés car déjà existants
 *
 * Héritage de AIOutputBaseSchema :
 *   confidence_score, evidence, source_type, created_at, model, task_type
 */
export const SoftExclusionSuggesterOutputSchema = AIOutputBaseSchema.merge(
  z.object({
    client_id: z.string().min(1),

    proposed_exclusions: z.array(SoftExclusionCandidateSchema)
      .max(SOFT_EXCLUSION_MAX_CANDIDATES)
      .default([]),

    feedbacks_analyzed: z.number().int().min(0).default(0),
    patterns_skipped:   z.array(z.string()).default([]),
  }),
).refine(
  (out) => out.task_type === 'soft_exclusion_suggestion',
  { message: 'SoftExclusionSuggesterOutput.task_type doit être "soft_exclusion_suggestion"' },
).refine(
  (out) => out.proposed_exclusions.every((c) => c.requires_review === true),
  { message: 'Tous les candidats doivent avoir requires_review: true' },
);

export type SoftExclusionSuggesterOutput = z.infer<typeof SoftExclusionSuggesterOutputSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const safeParseSoftExclusionSuggesterInput  = (raw: unknown) =>
  SoftExclusionSuggesterInputSchema.safeParse(raw);

export const safeParseSoftExclusionSuggesterOutput = (raw: unknown) =>
  SoftExclusionSuggesterOutputSchema.safeParse(raw);

export const safeParseSoftExclusionCandidate = (raw: unknown) =>
  SoftExclusionCandidateSchema.safeParse(raw);
