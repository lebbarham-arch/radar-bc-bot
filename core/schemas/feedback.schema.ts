/**
 * Feedback Schema — Anaho
 *
 * Modélise les retours utilisateurs sur les notifications reçues.
 * Ces feedbacks alimentent la boucle d'apprentissage du scoring.
 *
 * Principe : l'IA n'apprend jamais automatiquement.
 * Chaque ajustement de profil nécessite un snapshot (rollback possible).
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';

// ─── FeedbackVerdict ──────────────────────────────────────────────────────────

/**
 * Verdict donné par le client sur une notification reçue.
 * - `relevant`     : le BC était pertinent (vrai positif confirmé)
 * - `not_relevant` : le BC n'était pas pertinent (faux positif)
 * - `partial`      : partiellement pertinent (certains articles seulement)
 */
export const FeedbackVerdictSchema = z.enum(['relevant', 'not_relevant', 'partial']);
export type FeedbackVerdict = z.infer<typeof FeedbackVerdictSchema>;

// ─── FeedbackEvent ────────────────────────────────────────────────────────────

/**
 * Un événement de feedback client sur une notification Anaho.
 *
 * - `id`             : identifiant unique de l'événement
 * - `client_id`      : client ayant donné le feedback
 * - `bc_id`          : BC concerné par le feedback
 * - `critere_id`     : critère qui a déclenché la notification (si applicable)
 * - `verdict`        : jugement du client sur la pertinence
 * - `score_at_time`  : score calculé au moment de la notification
 * - `commentaire`    : texte libre optionnel du client
 * - `created_at`     : timestamp de création du feedback
 *
 * Immutabilité : les feedbacks ne sont jamais modifiés.
 * Un nouveau feedback crée toujours un nouvel enregistrement.
 */
export const FeedbackEventSchema = z.object({
  id:            z.string().min(1, 'L\'identifiant du feedback est requis'),
  client_id:     z.string().min(1, 'Le client est requis'),
  bc_id:         z.string().min(1, 'Le BC est requis'),
  critere_id:    z.string().optional(),
  verdict:       FeedbackVerdictSchema,
  score_at_time: z.number().min(0).max(100),
  commentaire:   z.string().default(''),
  created_at:    z.string().datetime(),
});

export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;

// ─── ProfileSnapshot ──────────────────────────────────────────────────────────

/**
 * Snapshot du profil client à un instant T.
 * Créé avant toute modification du profil (critères, seuils, exclusions).
 * Permet le rollback en cas de dégradation des performances.
 *
 * - `id`             : identifiant unique du snapshot
 * - `client_id`      : client concerné
 * - `snapshot`       : copie JSON complète du profil client
 * - `reason`         : raison du snapshot (ex: "feedback_update", "manual_edit")
 * - `feedback_ids`   : feedbacks à l'origine de la modification (si applicable)
 * - `created_at`     : timestamp de création
 * - `rolled_back_at` : timestamp de rollback si ce snapshot a été restauré
 */
export const ProfileSnapshotSchema = z.object({
  id:              z.string().min(1),
  client_id:       z.string().min(1),
  /** Profil client sérialisé au format JSON (opaque — parsé à la restauration) */
  snapshot:        z.string().min(1),
  reason:          z.enum(['feedback_update', 'manual_edit', 'ai_suggestion', 'rollback']),
  feedback_ids:    z.array(z.string()).default([]),
  created_at:      z.string().datetime(),
  rolled_back_at:  z.string().datetime().optional(),
});

export type ProfileSnapshot = z.infer<typeof ProfileSnapshotSchema>;

// ─── FeedbackSummary ──────────────────────────────────────────────────────────

/**
 * Agrégat de feedbacks pour une période donnée.
 * Utilisé pour calculer les métriques de qualité du scoring.
 *
 * precision = vrais_positifs / (vrais_positifs + faux_positifs)
 */
export const FeedbackSummarySchema = z.object({
  client_id:       z.string().min(1),
  period_start:    z.string().datetime(),
  period_end:      z.string().datetime(),
  total:           z.number().int().min(0),
  relevant:        z.number().int().min(0),
  not_relevant:    z.number().int().min(0),
  partial:         z.number().int().min(0),
  /** Précision calculée (0.0–1.0), null si total = 0 */
  precision:       z.number().min(0).max(1).nullable(),
});

export type FeedbackSummary = z.infer<typeof FeedbackSummarySchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Valide et parse un événement de feedback brut.
 */
export const safeParseFeedbackEvent = (raw: unknown) =>
  FeedbackEventSchema.safeParse(raw);

/**
 * Calcule la précision à partir d'un résumé de feedbacks.
 * Retourne null si aucun feedback n'est disponible.
 */
export function computePrecision(summary: Omit<FeedbackSummary, 'precision' | 'client_id' | 'period_start' | 'period_end'>): number | null {
  if (summary.total === 0) return null;
  const denom = summary.relevant + summary.not_relevant + summary.partial;
  if (denom === 0) return null;
  // Pondération : relevant = 1, partial = 0.5, not_relevant = 0
  const score = summary.relevant + summary.partial * 0.5;
  return score / denom;
}

/**
 * Crée un snapshot sérialisé à partir d'un objet profil.
 * Utilise JSON.stringify — le profil doit être un objet sérialisable.
 */
export function serializeSnapshot(profile: Record<string, unknown>): string {
  return JSON.stringify(profile);
}
