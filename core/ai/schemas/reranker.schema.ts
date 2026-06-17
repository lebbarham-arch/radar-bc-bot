/**
 * Reranker Schema — Anaho
 *
 * Contrats d'entrée/sortie du module de reranking sémantique.
 *
 * Rôle : pour les BCs dans la fenêtre d'ambiguïté autour du seuil client,
 * le reranker produit un delta signé borné qui s'additionne au score déterministe.
 *
 * Contraintes architecturales strictes :
 *   - `rerank_delta` borné à [RERANK_DELTA_MIN, RERANK_DELTA_MAX] = [-5, +5]
 *     → impossible de dépasser, garanti par le schema Zod
 *   - `final_score_authority` est littéralement `'deterministic'` dans le type
 *     → aucun consumer ne peut croire que l'IA a l'autorité finale
 *   - Le reranker n'est activé QUE si score ∈ [seuil - 5, seuil + 10]
 *     → `score_in_ambiguity_window` valide cette précondition dans le schema
 *   - Le reranker ne connaît jamais l'identité des critères — seulement les textes
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';
import { AIOutputBaseSchema } from './shared.schema';
import {
  RERANK_DELTA_MIN,
  RERANK_DELTA_MAX,
  RERANK_WINDOW_BELOW,
  RERANK_WINDOW_ABOVE,
} from '../constants';

// ─── RerankerInput ────────────────────────────────────────────────────────────

/**
 * Entrée du module de reranking.
 *
 * - `bc_id`                    : BC candidat au reranking
 * - `client_id`                : client pour corrélation (pas de profil complet)
 * - `deterministic_score`      : score calculé par le moteur (source de vérité)
 * - `score_threshold`          : seuil du client (pour vérifier la fenêtre)
 * - `bc_text_excerpt`          : extrait texte du BC (max 800 chars, sans PII)
 * - `critere_texts`            : textes bruts des critères actifs (sans IDs)
 * - `score_in_ambiguity_window`: précondition validée par le pipeline
 *                                true = score ∈ [seuil - WINDOW_BELOW, seuil + WINDOW_ABOVE]
 */
export const RerankerInputSchema = z.object({
  bc_id:                     z.string().min(1),
  client_id:                 z.string().min(1),
  deterministic_score:       z.number().min(0).max(100),
  score_threshold:           z.number().min(0).max(100),
  bc_text_excerpt:           z.string().max(800).default(''),
  critere_texts:             z.array(z.string()).min(1),
  score_in_ambiguity_window: z.literal(true),
}).refine(
  (inp) => {
    const lo = inp.score_threshold - RERANK_WINDOW_BELOW;
    const hi = inp.score_threshold + RERANK_WINDOW_ABOVE;
    return inp.deterministic_score >= lo && inp.deterministic_score <= hi;
  },
  {
    message:
      `Le score doit être dans la fenêtre [seuil - ${RERANK_WINDOW_BELOW}, seuil + ${RERANK_WINDOW_ABOVE}]`,
    path: ['deterministic_score'],
  },
);

export type RerankerInput = z.infer<typeof RerankerInputSchema>;

// ─── RerankerOutput ───────────────────────────────────────────────────────────

/**
 * Sortie du module de reranking.
 *
 * - `bc_id`                  : BC reranké
 * - `client_id`              : client concerné
 * - `rerank_delta`           : delta signé à additionner au score [-5, +5]
 *                              borné structurellement par Zod
 * - `reason`                 : justification courte du delta (pour logs/debug)
 * - `final_score_authority`  : toujours 'deterministic' — garantie structurelle
 * - `applied_score`          : score résultant après application du delta
 *                              (calculé, jamais décisionnel seul)
 *
 * Héritage de AIOutputBaseSchema :
 *   confidence_score, evidence, source_type, created_at, model, task_type
 */
export const RerankerOutputSchema = AIOutputBaseSchema.merge(
  z.object({
    bc_id:     z.string().min(1),
    client_id: z.string().min(1),

    /** Delta borné : jamais en dehors de [-5, +5] */
    rerank_delta: z.number()
      .min(RERANK_DELTA_MIN)
      .max(RERANK_DELTA_MAX),

    reason: z.string().default(''),

    /** Garantie structurelle : le scoring déterministe reste l'autorité finale */
    final_score_authority: z.literal('deterministic'),

    /** Score après delta — fourni pour les logs, jamais utilisé seul comme verdict */
    applied_score: z.number().min(0).max(100),
  }),
).refine(
  (out) => out.task_type === 'reranking',
  { message: 'RerankerOutput.task_type doit être "reranking"' },
);

export type RerankerOutput = z.infer<typeof RerankerOutputSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const safeParseRerankerInput  = (raw: unknown) => RerankerInputSchema.safeParse(raw);
export const safeParseRerankerOutput = (raw: unknown) => RerankerOutputSchema.safeParse(raw);

/**
 * Calcule le score appliqué après reranking, clampé à [0, 100].
 * Cette fonction est la seule autorisation d'additionner le delta.
 */
export function applyRerankDelta(deterministicScore: number, delta: number): number {
  const bounded = Math.max(RERANK_DELTA_MIN, Math.min(RERANK_DELTA_MAX, delta));
  return Math.min(100, Math.max(0, deterministicScore + bounded));
}

/**
 * Vérifie si un score est dans la fenêtre d'ambiguïté d'un seuil donné.
 * Utilisé par le pipeline pour décider d'appeler ou non le reranker.
 */
export function isInAmbiguityWindow(score: number, threshold: number): boolean {
  return score >= threshold - RERANK_WINDOW_BELOW
      && score <= threshold + RERANK_WINDOW_ABOVE;
}
