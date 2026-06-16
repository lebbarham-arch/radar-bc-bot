/**
 * ONB-2b — Schémas Zod pour la revue humaine des suggestions IA
 *
 * Règles absolues :
 *   - Aucune suggestion IA n'est appliquée automatiquement
 *   - L'IA ne modifie jamais les critères actifs
 *   - L'IA ne modifie jamais base_keywords, radar_type, domain_category
 *   - Toute suggestion acceptée reste auditée
 *   - Toute suggestion rejetée reste traçable
 *   - Aucune écriture DB depuis ce module
 */

import { z } from 'zod';

// ─── Actions de revue ─────────────────────────────────────────────────────────

/**
 * Actions possibles pour une suggestion IA.
 * Chaque action crée une entrée dans l'audit trail.
 */
export const AIReviewActionSchema = z.enum([
  'approve_ai_inclusion',
  'reject_ai_inclusion',
  'edit_ai_inclusion',
  'approve_ai_exclusion',
  'reject_ai_exclusion',
  'edit_ai_exclusion',
  'approve_all_safe_suggestions',
  'reject_all_ai_suggestions',
]);
export type AIReviewAction = z.infer<typeof AIReviewActionSchema>;

// ─── Statut d'une suggestion individuelle ─────────────────────────────────────

export const SuggestionReviewStatusSchema = z.enum([
  'pending',    // Non encore revue
  'approved',   // Acceptée telle quelle
  'rejected',   // Rejetée
  'edited',     // Éditée avant acceptation
]);
export type SuggestionReviewStatus = z.infer<typeof SuggestionReviewStatusSchema>;

// ─── Entrée d'audit ───────────────────────────────────────────────────────────

/**
 * Trace immuable de chaque décision de revue.
 * Chaque action crée une entrée — jamais supprimée.
 */
export const AuditEntrySchema = z.object({
  /** ID du critère concerné */
  critere_id:       z.string().min(1),
  /** Action effectuée */
  action:           AIReviewActionSchema,
  /** Valeur originale (suggestion IA brute) */
  original_value:   z.string(),
  /** Valeur finale après revue (= original si approve, '' si reject, nouvelle valeur si edit) */
  final_value:      z.string(),
  /** Type de suggestion : 'inclusion' | 'exclusion' */
  suggestion_type:  z.enum(['inclusion', 'exclusion']),
  /** Acteur humain ayant effectué la revue */
  reviewed_by:      z.string().default('admin'),
  /** Horodatage de la décision */
  reviewed_at:      z.string().datetime(),
  /** Motif optionnel (rejet, édition) */
  reason:           z.string().default(''),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ─── Suggestion revue individuelle ───────────────────────────────────────────

export const ReviewedSuggestionSchema = z.object({
  /** Valeur originale de la suggestion IA */
  original:   z.string(),
  /** Statut après revue */
  status:     SuggestionReviewStatusSchema,
  /** Valeur finale (= original si approve, nouvelle valeur si edit) */
  final:      z.string(),
  /** Motif de rejet ou d'édition */
  reason:     z.string().default(''),
});
export type ReviewedSuggestion = z.infer<typeof ReviewedSuggestionSchema>;

// ─── Résultat de revue par critère ───────────────────────────────────────────

/**
 * Résultat de la revue humaine pour un critère enrichi.
 *
 * Contient :
 *   - les suggestions approuvées (prêtes pour ONB-2c)
 *   - les suggestions rejetées (traçables, jamais fusionnées)
 *   - les suggestions éditées (re-validées par validateExclusionSafe)
 *   - le trail d'audit complet
 */
export const AIReviewedCritereSchema = z.object({
  // ── Champs originaux préservés (jamais modifiés) ──────────────────────────
  id:                        z.string().min(1),
  label:                     z.string().min(1),
  radar_type:                z.enum(['bc', 'mp']),
  domain_category:           z.string().min(1),
  base_keywords:             z.array(z.string()).min(1),
  ai_inclusions_initial:     z.array(z.string()).default([]),
  ai_exclusions_initial:     z.array(z.string()).default([]),
  prestations_recherchees:   z.array(z.string()).default([]),
  prestations_exclues:       z.array(z.string()).default([]),
  zones_geographiques:       z.array(z.string()).default([]),
  favorite_organizations:    z.array(z.string()).default([]),
  precision_mode:            z.enum(['large', 'equilibre', 'strict']),
  source_trace:              z.record(z.string(), z.unknown()).default({}),
  requires_human_validation: z.literal(true),
  active:                    z.literal(false),

  // ── Suggestions IA d'origine (non modifiées) ──────────────────────────────
  ai_suggestions_original: z.object({
    suggested_inclusions:        z.array(z.string()).default([]),
    suggested_exclusions:        z.array(z.string()).default([]),
    suggested_variants:          z.array(z.string()).default([]),
    suggested_positive_terms:    z.array(z.string()).default([]),
    suggested_negative_contexts: z.array(z.string()).default([]),
    review_notes:                z.string().default(''),
    confidence:                  z.number().min(0).max(1).default(0),
  }),

  // ── Résultats de revue ────────────────────────────────────────────────────
  reviewed_inclusions:  z.array(ReviewedSuggestionSchema).default([]),
  reviewed_exclusions:  z.array(ReviewedSuggestionSchema).default([]),

  // ── Listes finales (issues de la revue) ──────────────────────────────────
  /** Inclusions approuvées ou éditées — prêtes pour ONB-2c */
  approved_inclusions:  z.array(z.string()).default([]),
  /** Exclusions approuvées ou éditées — prêtes pour ONB-2c */
  approved_exclusions:  z.array(z.string()).default([]),
  /** Suggestions rejetées — traçables, jamais fusionnées */
  rejected_inclusions:  z.array(z.string()).default([]),
  rejected_exclusions:  z.array(z.string()).default([]),

  // ── Audit trail ───────────────────────────────────────────────────────────
  audit_trail: z.array(AuditEntrySchema).default([]),

  /** Statut global de la revue du critère */
  review_status: z.enum(['pending', 'partial', 'complete']).default('pending'),
});
export type AIReviewedCritere = z.infer<typeof AIReviewedCritereSchema>;

// ─── Jeu de critères revu ─────────────────────────────────────────────────────

export const AIReviewedCriteriaSetSchema = z.object({
  client_id:                 z.string().default(''),
  source:                    z.literal('ai_human_review'),
  reviewed_at:               z.string().datetime(),
  criteria:                  z.array(AIReviewedCritereSchema).min(1),
  warnings:                  z.array(z.string()).default([]),
  enrichment_model:          z.string().default('unknown'),
  /** Toujours true — jamais d'activation automatique */
  requires_human_validation: z.literal(true),
  /** Toujours false — même après revue complète */
  active:                    z.literal(false),
});
export type AIReviewedCriteriaSet = z.infer<typeof AIReviewedCriteriaSetSchema>;

// ─── Commande de revue individuelle ──────────────────────────────────────────

/**
 * Commande envoyée par l'admin pour une action de revue sur une suggestion.
 */
export const AIReviewCommandSchema = z.object({
  critere_id:       z.string().min(1),
  action:           AIReviewActionSchema,
  suggestion_type:  z.enum(['inclusion', 'exclusion']).optional(),
  original_value:   z.string().optional(),
  new_value:        z.string().optional(),
  reviewed_by:      z.string().default('admin'),
  reason:           z.string().default(''),
});
export type AIReviewCommand = z.infer<typeof AIReviewCommandSchema>;

// ─── Résultat d'une action de revue ──────────────────────────────────────────

export const AIReviewResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok:      z.literal(true),
    critere: AIReviewedCritereSchema,
    entry:   AuditEntrySchema,
  }),
  z.object({
    ok:      z.literal(false),
    error:   z.string(),
  }),
]);
export type AIReviewResult = z.infer<typeof AIReviewResultSchema>;
