/**
 * ONB-1d — Schéma de Revue Humaine des Critères L3
 *
 * Représente le workflow de validation humaine d'un GeneratedCriteriaSet.
 *
 * Règles absolues :
 *   - Aucun critère ne peut être activé sans validation humaine explicite
 *   - active reste false jusqu'à la persistance ONB-1e
 *   - Aucune écriture DB dans ce module
 *   - Aucun appel IA
 *   - Tout changement produit un audit trail
 *   - Un critère rejeté ne peut pas être approuvé sans re-soumission
 *   - Un critère modifié repasse automatiquement en "edited" (attend re-validation)
 */

import { z } from 'zod';
import { ProposedCritereSchema } from './l3-criteria.schema';
import { NiveauPrecisionSchema, PrestationSchema } from './schema';

// ─── Statuts de revue ────────────────────────────────────────────────────────

/**
 * Statut de revue d'un critère individuel.
 *
 * pending_validation → approved | rejected | edited
 * edited             → approved | rejected
 * approved           → (persisté en ONB-1e, ne repasse pas par ici)
 * rejected           → (archivé, ne peut pas être activé)
 */
export const ReviewStatusSchema = z.enum([
  'pending_validation',
  'approved',
  'rejected',
  'edited',
]);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

// ─── Actions de revue ────────────────────────────────────────────────────────

export const ReviewActionSchema = z.enum([
  'approve_criterion',
  'reject_criterion',
  'edit_criterion',
  'approve_all',
  'reject_all',
]);
export type ReviewAction = z.infer<typeof ReviewActionSchema>;

// ─── Audit trail ─────────────────────────────────────────────────────────────

/**
 * Entrée d'audit pour une action de revue.
 * Chaque modification de statut produit une entrée immuable.
 */
export const AuditTrailEntrySchema = z.object({
  /** Action effectuée */
  review_action: ReviewActionSchema,
  /** Identifiant de l'utilisateur ayant effectué l'action */
  reviewed_by: z.string().min(1),
  /** ISO datetime de l'action */
  reviewed_at: z.string().datetime(),
  /** Note optionnelle du reviewer */
  review_note: z.string().optional(),
  /** Snapshot avant modification (pour edit_criterion uniquement) */
  before: z.record(z.string(), z.unknown()).optional(),
  /** Snapshot après modification (pour edit_criterion uniquement) */
  after: z.record(z.string(), z.unknown()).optional(),
});
export type AuditTrailEntry = z.infer<typeof AuditTrailEntrySchema>;

// ─── Modifications éditables d'un critère ────────────────────────────────────

/**
 * Champs d'un ProposedCritere modifiables par un reviewer.
 * Tous optionnels — seuls les champs fournis sont mis à jour.
 */
export const CritereEditSchema = z.object({
  label:                 z.string().min(1).optional(),
  base_keywords:         z.array(z.string()).min(1).optional(),
  ai_inclusions_initial: z.array(z.string()).optional(),
  ai_exclusions_initial: z.array(z.string()).optional(),
  prestations_recherchees: z.array(PrestationSchema).optional(),
  prestations_exclues:     z.array(PrestationSchema).optional(),
  zones_geographiques:     z.array(z.string()).optional(),
  favorite_organizations:  z.array(z.string()).optional(),
  precision_mode:          NiveauPrecisionSchema.optional(),
});
export type CritereEdit = z.infer<typeof CritereEditSchema>;

// ─── Enrichissement automatique (snapshot) ───────────────────────────────────

/**
 * Snapshot minimal du résultat d'enrichCriterion attaché à chaque critère
 * au moment de l'initiation de la revue.
 *
 * Ne contient que les champs nécessaires à la revue humaine.
 * Stocké en lecture seule — pas mis à jour après editCriterion.
 */
export const CritereEnrichmentSnapshotSchema = z.object({
  /** Statut d'activabilité calculé à l'initialisation */
  activation_status: z.enum(['active', 'needs_review', 'needs_clarification']),
  /** true si le terme est dans la banque de suggestions locale */
  known_suggestion_bank: z.boolean(),
  /**
   * true si le critère est vague ET sans banque locale —
   * nécessite enrichissement IA ou revue humaine approfondie.
   */
  needs_ai_enrichment: z.boolean(),
  /** Raison courte de la décision d'activation */
  reason: z.string(),
  /** Critères précis suggérés en remplacement du libellé générique */
  suggested_precise_criteria: z.array(z.string()),
  /** Termes d'inclusion suggérés */
  suggested_inclusions: z.array(z.string()),
  /** Termes d'exclusion suggérés */
  suggested_exclusions: z.array(z.string()),
});
export type CritereEnrichmentSnapshot = z.infer<typeof CritereEnrichmentSnapshotSchema>;

// ─── ReviewableCritere ────────────────────────────────────────────────────────

/**
 * Un critère proposé enrichi du statut de revue et de l'audit trail.
 * Étend ProposedCritere sans le muter.
 *
 * Invariants :
 *   - active reste toujours false dans ce module (persistance = ONB-1e)
 *   - requires_human_validation reste toujours true
 *   - review_status seul indique l'état de validation
 */
export const ReviewableCritereSchema = ProposedCritereSchema.extend({
  /** Statut de revue courant */
  review_status: ReviewStatusSchema,
  /** Historique complet des actions de revue (immuable, append-only) */
  audit_trail: z.array(AuditTrailEntrySchema).default([]),
  /**
   * Snapshot d'enrichissement calculé à l'initReview().
   * Absent sur les critères importés avant la feature (rétrocompatibilité).
   * Ne pas mettre à jour après editCriterion — reste le snapshot initial.
   */
  auto_enrichment: CritereEnrichmentSnapshotSchema.optional(),
});
export type ReviewableCritere = z.infer<typeof ReviewableCritereSchema>;

// ─── ReviewableCriteriaSet ────────────────────────────────────────────────────

/**
 * Ensemble de critères en cours de revue.
 * Produit par initReview() à partir d'un GeneratedCriteriaSet.
 *
 * Statut global :
 *   - "in_review"      : au moins un critère pending ou edited
 *   - "review_complete": tous les critères sont approved ou rejected
 */
export const ReviewStatusGlobalSchema = z.enum(['in_review', 'review_complete']);
export type ReviewStatusGlobal = z.infer<typeof ReviewStatusGlobalSchema>;

export const ReviewableCriteriaSetSchema = z.object({
  /** Identifiant client */
  client_id: z.string().default(''),
  /** ISO datetime d'initialisation de la revue */
  review_started_at: z.string().datetime(),
  /** ISO datetime de dernière modification */
  review_updated_at: z.string().datetime(),
  /** Statut global de la session de revue */
  review_status: ReviewStatusGlobalSchema,
  /** Critères avec statut de revue et audit trail */
  criteria: z.array(ReviewableCritereSchema),
});
export type ReviewableCriteriaSet = z.infer<typeof ReviewableCriteriaSetSchema>;
