/**
 * ONB-2c — Schémas Zod pour la fusion contrôlée des suggestions IA approuvées
 *
 * Règles absolues :
 *   - Seules les suggestions approved sont fusionnées
 *   - Les rejected et pending sont explicitement ignorées et tracées
 *   - base_keywords, radar_type, domain_category : jamais modifiés
 *   - active reste false, requires_human_validation reste true
 *   - Toutes les exclusions fusionnées repassent par validateExclusionSafe()
 *   - Aucune écriture DB, aucun appel IA
 */

import { z } from 'zod';

// ─── Audit de fusion par critère ──────────────────────────────────────────────

/**
 * Rapport détaillé de la fusion pour un critère.
 * Traçabilité complète de ce qui a été fusionné, ignoré, dédupliqué.
 */
export const MergeAuditSchema = z.object({
  /** ID du critère fusionné */
  critere_id:         z.string().min(1),

  /** Inclusions IA effectivement ajoutées (approved, non-doublons) */
  added_inclusions:   z.array(z.string()).default([]),

  /** Exclusions IA effectivement ajoutées (approved, safe, non-doublons) */
  added_exclusions:   z.array(z.string()).default([]),

  /** Suggestions rejected ignorées (non fusionnées — immuable) */
  ignored_rejected:   z.array(z.string()).default([]),

  /** Suggestions pending ignorées (non encore revues) */
  ignored_pending:    z.array(z.string()).default([]),

  /** Doublons détectés et supprimés lors de la fusion */
  deduplicated:       z.array(z.string()).default([]),

  /**
   * Exclusions approved rejetées lors de la re-validation validateExclusionSafe().
   * Une exclusion peut être approved par l'admin mais toujours échouer la garde finale.
   */
  ignored_unsafe:     z.array(z.string()).default([]),

  /**
   * Inclusions approved rejetées par la garde anti-ambiguïté (ONB-2d).
   * Terme ambigu seul, composé inter-domaine, ou composé inconnu pour le domaine.
   */
  ignored_ambiguous:  z.array(z.string()).default([]),

  /** Acteur ayant déclenché la fusion (optionnel) */
  actor_id:           z.string().optional(),

  /** Horodatage de la fusion */
  merged_at:          z.string().datetime(),
});
export type MergeAudit = z.infer<typeof MergeAuditSchema>;

// ─── Critère fusionné ─────────────────────────────────────────────────────────

/**
 * Critère L3 avec les suggestions IA approved fusionnées dans
 * ai_inclusions_merged et ai_exclusions_merged.
 *
 * Les champs originaux (base_keywords, radar_type, domain_category,
 * ai_inclusions_initial, ai_exclusions_initial) sont PRÉSERVÉS INCHANGÉS.
 *
 * La fusion produit de NOUVEAUX champs merged — elle n'écrase rien.
 */
export const AIMergedCritereSchema = z.object({
  // ── Champs originaux préservés ─────────────────────────────────────────────
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

  // ── Champs fusionnés (initial + approved IA, dédupliqués) ─────────────────
  /**
   * ai_inclusions_initial + approved_inclusions IA (dédupliqués, ordre stable).
   * Prêt pour usage dans le workflow de persistance (ONB-1e).
   */
  ai_inclusions_merged:      z.array(z.string()).default([]),

  /**
   * ai_exclusions_initial + approved_exclusions IA safe (dédupliqués, ordre stable).
   * Toutes les exclusions ont passé validateExclusionSafe().
   */
  ai_exclusions_merged:      z.array(z.string()).default([]),

  // ── Audit de la fusion ────────────────────────────────────────────────────
  merge_audit:               MergeAuditSchema,

  // ── Garanties de sécurité ─────────────────────────────────────────────────
  requires_human_validation: z.literal(true),
  active:                    z.literal(false),
});
export type AIMergedCritere = z.infer<typeof AIMergedCritereSchema>;

// ─── Jeu de critères fusionné ─────────────────────────────────────────────────

export const AIMergedCriteriaSetSchema = z.object({
  /** Identifiant client hérité */
  client_id:                 z.string().default(''),

  /** Source traçable : toujours 'ai_review_merge' */
  source:                    z.literal('ai_review_merge'),

  /** Horodatage de la fusion globale */
  merged_at:                 z.string().datetime(),

  /** Critères fusionnés */
  criteria:                  z.array(AIMergedCritereSchema).min(1),

  /** Avertissements globaux de la fusion */
  warnings:                  z.array(z.string()).default([]),

  /** Modèle LLM ayant produit les suggestions initiales (traçabilité) */
  enrichment_model:          z.string().default('unknown'),

  /** Toujours true — validation humaine obligatoire avant activation */
  requires_human_validation: z.literal(true),

  /** Toujours false — jamais d'activation automatique */
  active:                    z.literal(false),
});
export type AIMergedCriteriaSet = z.infer<typeof AIMergedCriteriaSetSchema>;
