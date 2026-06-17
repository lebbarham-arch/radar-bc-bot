/**
 * Feedback Learning V1 — Types & Schemas
 *
 * Modélise le système d'apprentissage par feedback du moteur de scoring.
 * Toutes les modifications de profil sont tracées et rollbackables.
 *
 * Règles fondamentales :
 *   - Feedback positif  → +0.05 sur les composants matchés (clampé à 1.5)
 *   - Feedback négatif  → −0.05 sur les composants matchés (clampé à 0.5)
 *   - Feedback partiel  → +0.025 sur les composants matchés
 *   - 3 feedbacks négatifs similaires → SoftExclusion (requires_review = true)
 *   - Aucune exclusion dure automatique
 *   - Chaque modification crée une nouvelle version du profil (rollback possible)
 *   - Toute donnée est tracée : client_id, bc_id, notification_id, signaux, score initial
 *
 * Source de vérité : Zod. Types inférés via z.infer<>.
 */

import { z } from 'zod';

// ─── Constantes d'ajustement ──────────────────────────────────────────────────

/** Delta appliqué sur un feedback positif */
export const WEIGHT_DELTA_POSITIVE = 0.05 as const;

/** Delta appliqué sur un feedback négatif */
export const WEIGHT_DELTA_NEGATIVE = 0.05 as const;

/** Delta appliqué sur un feedback partiel */
export const WEIGHT_DELTA_PARTIAL = 0.025 as const;

/** Multiplicateur minimum (jamais en dessous de 0.5) */
export const WEIGHT_MIN = 0.5 as const;

/** Multiplicateur maximum (jamais au-dessus de 1.5) */
export const WEIGHT_MAX = 1.5 as const;

/** Nombre de feedbacks négatifs similaires déclenchant une SoftExclusion */
export const SOFT_EXCLUSION_THRESHOLD = 3 as const;

// ─── Composants ajustables ────────────────────────────────────────────────────

/**
 * Composants du score pouvant être ajustés par feedback.
 * Correspond aux composants positifs du scoring engine (hors pénalités).
 */
export const AdjustableComponentSchema = z.enum([
  'title',
  'content',
  'article',
  'business_intent',
  'technical',
  'organization',
]);

export type AdjustableComponent = z.infer<typeof AdjustableComponentSchema>;

// ─── ComponentWeights ─────────────────────────────────────────────────────────

/**
 * Multiplicateurs par composant du score.
 * Valeur nominale = 1.0. Bornes : [0.5, 1.5].
 *
 * Appliqués dans le scoring engine comme :
 *   score_titre_pondéré = titre_score × title_multiplier
 *
 * Ces poids ne sont jamais appliqués automatiquement en production
 * sans validation explicite.
 */
export const ComponentWeightsSchema = z.object({
  title_multiplier:           z.number().min(WEIGHT_MIN).max(WEIGHT_MAX),
  content_multiplier:         z.number().min(WEIGHT_MIN).max(WEIGHT_MAX),
  article_multiplier:         z.number().min(WEIGHT_MIN).max(WEIGHT_MAX),
  business_intent_multiplier: z.number().min(WEIGHT_MIN).max(WEIGHT_MAX),
  technical_multiplier:       z.number().min(WEIGHT_MIN).max(WEIGHT_MAX),
  organization_multiplier:    z.number().min(WEIGHT_MIN).max(WEIGHT_MAX),
});

export type ComponentWeights = z.infer<typeof ComponentWeightsSchema>;

/** Poids nominaux : tous les multiplicateurs à 1.0 */
export const DEFAULT_WEIGHTS: ComponentWeights = {
  title_multiplier:           1.0,
  content_multiplier:         1.0,
  article_multiplier:         1.0,
  business_intent_multiplier: 1.0,
  technical_multiplier:       1.0,
  organization_multiplier:    1.0,
} as const;

// ─── Signal matchant ──────────────────────────────────────────────────────────

/**
 * Un signal qui a contribué au score lors du traitement du BC.
 * Enregistré au moment du feedback pour la traçabilité.
 */
export const MatchedSignalSchema = z.object({
  /** Composant du score concerné */
  component:     AdjustableComponentSchema,
  /** Score obtenu sur ce composant (avant pondération) */
  score:         z.number().min(0),
  /** Terme qui a déclenché le match (peut être vide) */
  matched_term:  z.string().default(''),
});

export type MatchedSignal = z.infer<typeof MatchedSignalSchema>;

// ─── FeedbackRecord ───────────────────────────────────────────────────────────

/**
 * Enregistrement complet et tracé d'un feedback client.
 *
 * Tous les champs sont enregistrés au moment du feedback.
 * Ce record est immuable — une fois créé, il n'est jamais modifié.
 *
 * Traçabilité complète :
 *   - client_id, bc_id, notification_id
 *   - signaux qui ont déclenché la notification
 *   - score initial et décision initiale
 *   - catégorie dominante du BC (pour soft exclusions)
 */
export const FeedbackRecordSchema = z.object({
  /** Identifiant unique du feedback */
  id:                    z.string().min(1),
  /** Client ayant donné le feedback */
  client_id:             z.string().min(1),
  /** BC concerné */
  bc_id:                 z.string().min(1),
  /** Notification qui a déclenché le feedback (optionnel si feedback manuel) */
  notification_id:       z.string().optional(),
  /** Verdict du client */
  verdict:               z.enum(['relevant', 'not_relevant', 'partial']),
  /** Signaux du scoring qui ont contribué à la notification */
  matched_signals:       z.array(MatchedSignalSchema),
  /** IDs des critères matchés au moment de la notification */
  matched_critere_ids:   z.array(z.string()),
  /** Score calculé au moment de la notification */
  score_at_time:         z.number().min(0).max(100),
  /** Décision prise au moment de la notification */
  decision_at_time:      z.enum(['notify', 'rerank', 'ignore']),
  /** Catégorie dominante du BC (ex: "cvc", "informatique") pour détecter les patterns */
  bc_dominant_category:  z.string().optional(),
  /** Timestamp de création */
  created_at:            z.string().datetime(),
});

export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;

// ─── WeightAdjustment ────────────────────────────────────────────────────────

/**
 * Ajustement calculé sur un composant suite à un feedback.
 * Produit par computeWeightAdjustments() — ne modifie pas le profil.
 */
export const WeightAdjustmentSchema = z.object({
  /** Composant concerné */
  component:   AdjustableComponentSchema,
  /** Ancien multiplicateur */
  old_weight:  z.number().min(WEIGHT_MIN).max(WEIGHT_MAX),
  /** Nouveau multiplicateur (après clamp) */
  new_weight:  z.number().min(WEIGHT_MIN).max(WEIGHT_MAX),
  /** Delta appliqué (positif = renforcement, négatif = affaiblissement) */
  delta:       z.number(),
  /** Raison de l'ajustement */
  reason:      z.string(),
});

export type WeightAdjustment = z.infer<typeof WeightAdjustmentSchema>;

// ─── SoftExclusion ────────────────────────────────────────────────────────────

/**
 * Exclusion douce générée après 3 feedbacks négatifs similaires.
 *
 * RÈGLE CRITIQUE : requires_review = true TOUJOURS.
 * Une SoftExclusion n'est JAMAIS appliquée automatiquement au moteur
 * de scoring. Elle doit être revue et validée manuellement.
 *
 * Elle peut ensuite être convertie en exclusion_metier du profil
 * après validation opérateur.
 */
export const SoftExclusionSchema = z.object({
  /** Identifiant unique */
  id:               z.string().min(1),
  /** Client concerné */
  client_id:        z.string().min(1),
  /** Pattern détecté (ex: "informatique", "câble réseau") */
  pattern:          z.string().min(1),
  /** Type de pattern */
  pattern_type:     z.enum(['category', 'keyword']),
  /** Nombre de feedbacks négatifs ayant déclenché cette exclusion */
  trigger_count:    z.number().int().min(SOFT_EXCLUSION_THRESHOLD),
  /** IDs des feedbacks négatifs à l'origine de l'exclusion */
  feedback_ids:     z.array(z.string()).min(1),
  /** Niveau de confiance de la détection */
  confidence:       z.enum(['low', 'medium', 'high']),
  /** L'exclusion est-elle active (non supprimée) */
  active:           z.boolean().default(true),
  /** Timestamp de création */
  created_at:       z.string().datetime(),
  /**
   * IMMUABLE : une SoftExclusion nécessite TOUJOURS une revue manuelle.
   * Elle ne peut jamais être auto-appliquée en hard exclusion.
   */
  requires_review:  z.literal(true),
});

export type SoftExclusion = z.infer<typeof SoftExclusionSchema>;

// ─── ProfileVersion ───────────────────────────────────────────────────────────

/**
 * Une version du profil de poids d'un client.
 * Créée à chaque modification par feedback.
 * Permet le rollback vers n'importe quelle version antérieure.
 */
export const ProfileVersionSchema = z.object({
  /** Numéro de version (commence à 1, incrémenté à chaque modification) */
  version:      z.number().int().min(1),
  /** Poids à cette version */
  weights:      ComponentWeightsSchema,
  /** Feedbacks à l'origine de cette version (vide pour v1 initiale) */
  feedback_ids: z.array(z.string()).default([]),
  /** Raison de la création de cette version */
  reason:       z.string(),
  /** Timestamp de création */
  created_at:   z.string().datetime(),
});

export type ProfileVersion = z.infer<typeof ProfileVersionSchema>;

// ─── LearningEvent ────────────────────────────────────────────────────────────

/**
 * Événement d'apprentissage émis lors du traitement d'un feedback.
 * Documente toutes les modifications appliquées.
 */
export const LearningEventSchema = z.object({
  /** ID du feedback traité */
  feedback_id:        z.string().min(1),
  /** Verdict traité */
  verdict:            z.enum(['relevant', 'not_relevant', 'partial']),
  /** Ajustements de poids calculés */
  weight_adjustments: z.array(WeightAdjustmentSchema),
  /** Soft exclusions créées lors de cet événement (si applicable) */
  new_soft_exclusions: z.array(SoftExclusionSchema).default([]),
  /** Numéro de la nouvelle version de profil créée */
  new_version:        z.number().int().min(1),
  /** Timestamp */
  processed_at:       z.string().datetime(),
});

export type LearningEvent = z.infer<typeof LearningEventSchema>;

// ─── LearningState ────────────────────────────────────────────────────────────

/**
 * État complet du système d'apprentissage pour un client.
 *
 * Immuable : processFeedback() retourne un NOUVEL état, ne mute pas l'existant.
 * Toutes les versions sont conservées pour permettre le rollback.
 */
export const LearningStateSchema = z.object({
  /** Client concerné */
  client_id:        z.string().min(1),
  /** Numéro de la version courante des poids */
  current_version:  z.number().int().min(1),
  /** Poids actuellement appliqués */
  current_weights:  ComponentWeightsSchema,
  /** Soft exclusions détectées (requires_review = true, jamais auto-appliquées) */
  soft_exclusions:  z.array(SoftExclusionSchema).default([]),
  /** Historique complet des versions (du plus ancien au plus récent) */
  versions:         z.array(ProfileVersionSchema).min(1),
  /** Historique complet des feedbacks (immuable) */
  feedback_history: z.array(FeedbackRecordSchema).default([]),
});

export type LearningState = z.infer<typeof LearningStateSchema>;

// ─── Résultat du processeur ───────────────────────────────────────────────────

/**
 * Résultat retourné par processFeedback().
 * Contient le nouvel état ET l'événement d'apprentissage pour audit.
 */
export interface ProcessFeedbackResult {
  /** Nouvel état immuable après traitement */
  new_state: LearningState;
  /** Événement d'apprentissage émis */
  event:     LearningEvent;
}

// ─── Helpers de validation ────────────────────────────────────────────────────

export const safeParseFeedbackRecord = (raw: unknown) =>
  FeedbackRecordSchema.safeParse(raw);

export const safeParseLearningState = (raw: unknown) =>
  LearningStateSchema.safeParse(raw);

export const safeParseComponentWeights = (raw: unknown) =>
  ComponentWeightsSchema.safeParse(raw);
