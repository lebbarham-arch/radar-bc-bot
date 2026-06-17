/**
 * Classifier Schema — Anaho
 *
 * Contrats d'entrée/sortie du module de classification d'intention BC.
 *
 * Rôle : quand le moteur déterministe retourne `unknown` ou `mixed` pour
 * l'intent d'un BC, le classifier IA propose un intent candidat.
 *
 * Contraintes architecturales :
 *   - `overrides_deterministic` est littéralement `false` dans le schema —
 *     impossible de le mettre à true, même en forçant le type
 *   - `proposed_intent` est une proposition, jamais une imposition
 *   - Le moteur de scoring ignore ClassifierOutput si confidence < MIN_CONFIDENCE
 *   - Le classifier n'est jamais appelé si le moteur a déjà un intent fort
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';
import { AIOutputBaseSchema } from './shared.schema';

// ─── ArticleForClassification ─────────────────────────────────────────────────

/**
 * Article BC minimal passé au classifier.
 * On n'envoie que le texte — pas d'identifiants client ou de scores.
 */
export const ArticleForClassificationSchema = z.object({
  designation:    z.string().min(1),
  specifications: z.string().default(''),
});

export type ArticleForClassification = z.infer<typeof ArticleForClassificationSchema>;

// ─── BCIntent ─────────────────────────────────────────────────────────────────

/**
 * Intention globale d'un BC telle que proposée par le classifier.
 * Reprend les valeurs du moteur déterministe pour cohérence.
 *
 * - `fourniture` : achat de biens / matériels
 * - `prestation` : achat de services / prestations intellectuelles
 * - `travaux`    : travaux de construction, génie civil
 * - `mixte`      : mélange fourniture + prestation dans le même BC
 * - `inconnu`    : classifier incapable de trancher (low confidence)
 */
export const BCIntentSchema = z.enum([
  'fourniture',
  'prestation',
  'travaux',
  'mixte',
  'inconnu',
]);
export type BCIntent = z.infer<typeof BCIntentSchema>;

// ─── ClassifierInput ──────────────────────────────────────────────────────────

/**
 * Entrée du module de classification.
 *
 * - `bc_id`                    : identifiant du BC à classifier
 * - `articles`                 : articles du BC (désignation + specs)
 * - `deterministic_intent`     : intent calculé par le moteur de règles
 *                                (passé au LLM pour contextualisation)
 * - `raw_body_excerpt`         : extrait du corps brut du BC (max 500 chars)
 *                                pour donner du contexte sans surcharger le prompt
 */
export const ClassifierInputSchema = z.object({
  bc_id:                z.string().min(1),
  articles:             z.array(ArticleForClassificationSchema).min(1),
  deterministic_intent: BCIntentSchema,
  raw_body_excerpt:     z.string().max(500).default(''),
});

export type ClassifierInput = z.infer<typeof ClassifierInputSchema>;

// ─── ClassifierOutput ─────────────────────────────────────────────────────────

/**
 * Sortie du module de classification.
 *
 * - `bc_id`                   : BC classifié (pour corrélation)
 * - `proposed_intent`         : intent proposé par l'IA
 * - `overrides_deterministic` : toujours false — le moteur reste l'autorité
 * - `intent_scores`           : distribution de confiance par intent (debug/logs)
 *
 * Héritage de AIOutputBaseSchema :
 *   confidence_score, evidence, source_type, created_at, model, task_type
 */
export const ClassifierOutputSchema = AIOutputBaseSchema.merge(
  z.object({
    bc_id:                   z.string().min(1),
    proposed_intent:         BCIntentSchema,
    /** Toujours false — garantie structurelle que l'IA ne décide pas seule */
    overrides_deterministic: z.literal(false),
    /** Distribution optionnelle de confiance par intent (somme ≈ 1.0) */
    intent_scores:           z.record(BCIntentSchema, z.number().min(0).max(1)).optional(),
  }),
).refine(
  (out) => out.task_type === 'classification',
  { message: 'ClassifierOutput.task_type doit être "classification"' },
);

export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const safeParseClassifierInput  = (raw: unknown) => ClassifierInputSchema.safeParse(raw);
export const safeParseClassifierOutput = (raw: unknown) => ClassifierOutputSchema.safeParse(raw);

/**
 * Retourne l'intent proposé seulement si la confiance est suffisante.
 * En dessous du seuil, retourne le deterministic_intent inchangé.
 */
export function resolveIntent(
  deterministicIntent: BCIntent,
  classifierOutput: ClassifierOutput,
  minConfidence: number,
): BCIntent {
  if (classifierOutput.confidence_score < minConfidence) return deterministicIntent;
  if (classifierOutput.proposed_intent === 'inconnu')    return deterministicIntent;
  return classifierOutput.proposed_intent;
}
