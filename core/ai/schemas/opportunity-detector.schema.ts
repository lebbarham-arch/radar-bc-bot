/**
 * Opportunity Detector Schema — Anaho
 *
 * Contrats d'entrée/sortie du module de détection d'opportunités cachées.
 *
 * Rôle : identifier des BCs qui ont scoré bas de façon déterministe mais
 * présentent une forte proximité sémantique avec le profil client.
 *
 * Contraintes architecturales strictes :
 *   - `digest_only` est littéralement `true` dans le type
 *     → les opportunités alimentent un digest séparé, jamais le flux principal
 *   - `triggers_notification` est littéralement `false`
 *     → aucune notification directe n'est déclenchée par ce module
 *   - Seuls les BCs avec score déterministe < OPPORTUNITY_DETERMINISTIC_MAX
 *     sont candidats (les BCs déjà bien scorés ne sont pas "cachés")
 *   - `embedding_score` représente la similarité cosinus [0, 1]
 *     — elle ne remplace jamais le score déterministe
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';
import { AIOutputBaseSchema } from './shared.schema';
import {
  OPPORTUNITY_DETERMINISTIC_MAX,
  OPPORTUNITY_EMBEDDING_MIN,
} from '../constants';

// ─── OpportunityDetectorInput ─────────────────────────────────────────────────

/**
 * Entrée du module de détection d'opportunités cachées.
 *
 * - `bc_id`                : BC candidat (score déterministe déjà calculé)
 * - `client_id`            : client pour corrélation
 * - `deterministic_score`  : score calculé par le moteur — doit être bas
 * - `bc_text_excerpt`      : extrait texte du BC (max 600 chars)
 * - `critere_texts`        : textes bruts des critères actifs du client
 * - `bc_is_low_scorer`     : précondition validée par le pipeline
 *                            true = score < OPPORTUNITY_DETERMINISTIC_MAX
 */
export const OpportunityDetectorInputSchema = z.object({
  bc_id:               z.string().min(1),
  client_id:           z.string().min(1),
  deterministic_score: z.number().min(0).max(100),
  bc_text_excerpt:     z.string().max(600).default(''),
  critere_texts:       z.array(z.string()).min(1),
  bc_is_low_scorer:    z.literal(true),
}).refine(
  (inp) => inp.deterministic_score < OPPORTUNITY_DETERMINISTIC_MAX,
  {
    message: `Le score déterministe doit être inférieur à ${OPPORTUNITY_DETERMINISTIC_MAX} pour être candidat`,
    path:    ['deterministic_score'],
  },
);

export type OpportunityDetectorInput = z.infer<typeof OpportunityDetectorInputSchema>;

// ─── OpportunityDetectorOutput ────────────────────────────────────────────────

/**
 * Sortie du module de détection d'opportunités cachées.
 *
 * - `bc_id`                : BC analysé
 * - `client_id`            : client concerné
 * - `embedding_score`      : similarité cosinus [0, 1] (plus haute = plus proche)
 * - `deterministic_score`  : score déterministe (rappel pour traçabilité)
 * - `promoted`             : true si embedding_score >= OPPORTUNITY_EMBEDDING_MIN
 * - `digest_only`          : TOUJOURS true — alimente le digest, jamais le flux principal
 * - `triggers_notification`: TOUJOURS false — aucune notification directe
 * - `opportunity_label`    : label court pour l'affichage dans le digest
 *
 * Héritage de AIOutputBaseSchema :
 *   confidence_score, evidence, source_type, created_at, model, task_type
 */
export const OpportunityDetectorOutputSchema = AIOutputBaseSchema.merge(
  z.object({
    bc_id:               z.string().min(1),
    client_id:           z.string().min(1),
    embedding_score:     z.number().min(0).max(1),
    deterministic_score: z.number().min(0).max(100),
    promoted:            z.boolean(),

    /** Garantie structurelle : jamais dans le flux principal de notifications */
    digest_only:           z.literal(true),
    /** Garantie structurelle : ce module ne déclenche aucune notification */
    triggers_notification: z.literal(false),

    opportunity_label: z.string().default(''),
  }),
).refine(
  (out) => out.task_type === 'opportunity_detection',
  { message: 'OpportunityDetectorOutput.task_type doit être "opportunity_detection"' },
).refine(
  (out) => {
    // Cohérence : promoted ↔ embedding_score suffisant
    if (out.promoted && out.embedding_score < OPPORTUNITY_EMBEDDING_MIN) return false;
    return true;
  },
  {
    message: `promoted=true requiert embedding_score >= ${OPPORTUNITY_EMBEDDING_MIN}`,
    path:    ['promoted'],
  },
);

export type OpportunityDetectorOutput = z.infer<typeof OpportunityDetectorOutputSchema>;

// ─── OpportunityDigest ────────────────────────────────────────────────────────

/**
 * Digest périodique d'opportunités cachées pour un client.
 * Ce type agrège plusieurs OpportunityDetectorOutput en un résumé affichable.
 *
 * - `client_id`     : client destinataire
 * - `opportunities` : liste triée par embedding_score décroissant
 * - `generated_at`  : timestamp de génération du digest
 * - `digest_only`   : toujours true — ce digest n'est jamais une notification
 */
export const OpportunityDigestSchema = z.object({
  client_id:     z.string().min(1),
  opportunities: z.array(
    z.object({
      bc_id:           z.string().min(1),
      embedding_score: z.number().min(0).max(1),
      opportunity_label: z.string().default(''),
      evidence:        z.string().default(''),
    }),
  ).default([]),
  generated_at: z.string().datetime(),
  digest_only:  z.literal(true),
});

export type OpportunityDigest = z.infer<typeof OpportunityDigestSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const safeParseOpportunityDetectorInput  = (raw: unknown) =>
  OpportunityDetectorInputSchema.safeParse(raw);

export const safeParseOpportunityDetectorOutput = (raw: unknown) =>
  OpportunityDetectorOutputSchema.safeParse(raw);

export const safeParseOpportunityDigest = (raw: unknown) =>
  OpportunityDigestSchema.safeParse(raw);

/**
 * Détermine si un BC est candidat au détecteur d'opportunités.
 * À appeler dans le pipeline AVANT de créer un OpportunityDetectorInput.
 */
export function isOpportunityCandidate(deterministicScore: number): boolean {
  return deterministicScore < OPPORTUNITY_DETERMINISTIC_MAX;
}

/**
 * Détermine si une opportunité est suffisamment forte pour être promue dans le digest.
 */
export function isPromotedOpportunity(embeddingScore: number): boolean {
  return embeddingScore >= OPPORTUNITY_EMBEDDING_MIN;
}
