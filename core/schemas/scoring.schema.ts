/**
 * Scoring Schema — Anaho
 *
 * Modélise le résultat du scoring déterministe d'un BC contre un profil client.
 *
 * Architecture du score (0–100) :
 *   Signaux métier   (BS) : secteur 25pts, prestation 20pts, organisme 15pts, région 10pts
 *   Signaux techniques (TS) : article match 40pts, densité 10pts, specs 5pts
 *
 * Le score est calculé de façon déterministe, sans LLM.
 * L'IA n'intervient qu'en phase d'enrichissement (inclusions/exclusions),
 * jamais pour la décision finale.
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';

// ─── SignalCategory ────────────────────────────────────────────────────────────

/**
 * Catégorie d'un signal de scoring.
 * - `business`   : signaux métier (secteur, prestation, organisme, région)
 * - `technical`  : signaux techniques (article, densité, specs)
 * - `exclusion`  : signal de pénalité ou d'exclusion contextuelle
 */
export const SignalCategorySchema = z.enum(['business', 'technical', 'exclusion']);
export type SignalCategory = z.infer<typeof SignalCategorySchema>;

// ─── MatchTrigger ─────────────────────────────────────────────────────────────

/**
 * Ce qui a déclenché le match sur un critère.
 * - `exact`      : match exact du mot-clé
 * - `inclusion`  : match via ai_inclusions (variante IA)
 * - `fuzzy`      : match par distance de Levenshtein ≤ 2
 * - `none`       : aucun match
 */
export const MatchTriggerSchema = z.enum(['exact', 'inclusion', 'fuzzy', 'none']);
export type MatchTrigger = z.infer<typeof MatchTriggerSchema>;

// ─── Signal ───────────────────────────────────────────────────────────────────

/**
 * Un signal de scoring individuel.
 * Chaque signal contribue positivement ou négativement au score total.
 *
 * - `id`          : identifiant unique du signal (ex: "BS-01", "TS-01")
 * - `category`    : catégorie du signal
 * - `label`       : description courte (ex: "Secteur informatique matché")
 * - `points`      : contribution au score (positif ou négatif)
 * - `matched`     : true si le signal a été activé
 * - `evidence`    : texte du BC qui a déclenché le signal (pour traçabilité)
 * - `trigger`     : mécanisme de déclenchement (exact, inclusion, fuzzy)
 */
export const SignalSchema = z.object({
  id:        z.string().min(1),
  category:  SignalCategorySchema,
  label:     z.string().min(1),
  points:    z.number(),
  matched:   z.boolean(),
  evidence:  z.string().default(''),
  trigger:   MatchTriggerSchema.default('none'),
});

export type Signal = z.infer<typeof SignalSchema>;

// ─── MatchExplanation ─────────────────────────────────────────────────────────

/**
 * Explication lisible du résultat de scoring pour un critère donné.
 * Utilisée pour les logs, le debug, et les notifications enrichies.
 */
export const MatchExplanationSchema = z.object({
  critere_id:    z.string().min(1),
  critere_valeur: z.string().min(1),
  trigger:       MatchTriggerSchema,
  /** Terme exact trouvé dans le texte du BC (variante ou mot-clé principal) */
  matched_term:  z.string().default(''),
  /** Phrase ou extrait du BC où le match a été trouvé */
  context:       z.string().default(''),
});

export type MatchExplanation = z.infer<typeof MatchExplanationSchema>;

// ─── ScoreResult ──────────────────────────────────────────────────────────────

/**
 * Résultat complet du scoring d'un BC pour un client donné.
 *
 * - `score`          : score final 0–100 (somme clampée des signaux)
 * - `verdict`        : match/no_match basé sur le seuil du pack client
 * - `signals`        : liste détaillée des signaux activés
 * - `explanations`   : explications par critère matché
 * - `matched_critere_ids` : IDs des critères qui ont déclenché un match
 * - `bc_id`          : ID du BC scoré
 * - `client_id`      : ID du client
 * - `scored_at`      : timestamp ISO du calcul
 * - `explanation`    : résumé textuel court (ex: pour log ou notification)
 */
export const ScoreResultSchema = z.object({
  score:               z.number().min(0).max(100),
  verdict:             z.enum(['match', 'no_match']),
  signals:             z.array(SignalSchema).default([]),
  explanations:        z.array(MatchExplanationSchema).default([]),
  matched_critere_ids: z.array(z.string()).default([]),
  bc_id:               z.string().min(1),
  client_id:           z.string().min(1),
  scored_at:           z.string().datetime(),
  explanation:         z.string().default(''),
});

export type ScoreResult = z.infer<typeof ScoreResultSchema>;

// ─── ScoreBreakdown ───────────────────────────────────────────────────────────

/**
 * Décomposition du score par catégorie.
 * Utile pour l'affichage dans l'interface et les logs de debug.
 */
export const ScoreBreakdownSchema = z.object({
  business_score:   z.number().min(0).max(70),
  technical_score:  z.number().min(0).max(55),
  exclusion_penalty: z.number().min(-100).max(0),
  total:            z.number().min(0).max(100),
});

export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

// ─── Helpers ──────────────────────────────----------------------------------------------------------------────

/**
 * Valide et parse un résultat de scoring brut.
 */
export const safeParseScoreResult = (raw: unknown) =>
  ScoreResultSchema.safeParse(raw);

/**
 * Calcule la décomposition du score à partir des signaux.
 */
export function computeBreakdown(signals: Signal[]): ScoreBreakdown {
  let business_score = 0;
  let technical_score = 0;
  let exclusion_penalty = 0;

  for (const signal of signals) {
    if (!signal.matched) continue;
    if (signal.category === 'business')   business_score   += signal.points;
    if (signal.category === 'technical')  technical_score  += signal.points;
    if (signal.category === 'exclusion')  exclusion_penalty += signal.points;
  }

  const raw = business_score + technical_score + exclusion_penalty;
  const total = Math.min(100, Math.max(0, raw));

  return { business_score, technical_score, exclusion_penalty, total };
}

/**
 * Retourne les signaux activés (matched = true), triés par points décroissants.
 */
export function getActiveSignals(signals: Signal[]): Signal[] {
  return signals
    .filter(s => s.matched)
    .sort((a, b) => b.points - a.points);
}
