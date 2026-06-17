/**
 * Onboarding Advisor Schema — Anaho
 *
 * Contrats d'entrée/sortie du module de conseil onboarding.
 *
 * Rôle : analyser les critères saisis par un client lors de l'onboarding
 * et produire des suggestions affichables dans le portail (redondances,
 * angles morts, opportunités de consolidation ou d'expansion).
 *
 * Contraintes architecturales strictes :
 *   - `display_only` est littéralement `true` dans chaque suggestion
 *     → aucune modification automatique du profil client
 *   - Le module ne modifie jamais ClientProfile ou Critere directement
 *   - Les suggestions sont uniquement textuelles et affichées à l'utilisateur
 *   - MAX_ONBOARDING_SUGGESTIONS suggestions maximum par analyse
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';
import { AIOutputBaseSchema } from './shared.schema';
import { MAX_ONBOARDING_SUGGESTIONS, CRITERE_REDUNDANCY_THRESHOLD } from '../constants';

// ─── OnboardingSuggestionType ─────────────────────────────────────────────────

/**
 * Type de suggestion onboarding.
 *
 * - `redundancy`    : deux critères sont sémantiquement proches → suggère fusion
 * - `blind_spot`    : secteur ou type de prestation non couvert → suggère ajout
 * - `consolidation` : plusieurs critères spécifiques → suggère un critère générique
 * - `expansion`     : critère trop restrictif → suggère des variantes
 */
export const OnboardingSuggestionTypeSchema = z.enum([
  'redundancy',
  'blind_spot',
  'consolidation',
  'expansion',
]);
export type OnboardingSuggestionType = z.infer<typeof OnboardingSuggestionTypeSchema>;

// ─── CritereForAdvisor ────────────────────────────────────────────────────────

/**
 * Critère minimal passé à l'advisor (lecture seule, pas de modification).
 */
export const CritereForAdvisorSchema = z.object({
  id:     z.string().min(1),
  valeur: z.string().min(1),
  type:   z.enum(['contenu', 'organisme', 'wilaya']),
  actif:  z.boolean(),
});

export type CritereForAdvisor = z.infer<typeof CritereForAdvisorSchema>;

// ─── OnboardingSuggestion ─────────────────────────────────────────────────────

/**
 * Une suggestion individuelle de l'advisor.
 *
 * - `type`                 : nature de la suggestion
 * - `message`              : texte affiché à l'utilisateur (clair, actionnable)
 * - `affected_critere_ids` : IDs des critères concernés par cette suggestion
 * - `suggested_action`     : action recommandée (optionnel, pour UX guidée)
 * - `similarity_score`     : score de similarité pour les suggestions redundancy
 *                            (undefined pour les autres types)
 * - `display_only`         : TOUJOURS true — garantie structurelle
 */
export const OnboardingSuggestionSchema = z.object({
  type:                 OnboardingSuggestionTypeSchema,
  message:              z.string().min(1),
  affected_critere_ids: z.array(z.string()).min(1),
  suggested_action:     z.string().default(''),
  similarity_score:     z.number().min(0).max(1).optional(),

  /** Garantie structurelle : aucune modification automatique du profil */
  display_only: z.literal(true),
});

export type OnboardingSuggestion = z.infer<typeof OnboardingSuggestionSchema>;

// ─── OnboardingAdvisorInput ───────────────────────────────────────────────────

/**
 * Entrée du module de conseil onboarding.
 *
 * - `client_id`          : client en cours d'onboarding
 * - `criteres`           : critères actifs du client (lecture seule)
 * - `business_secteurs`  : secteurs déclarés (pour détecter les angles morts)
 * - `types_prestation`   : types de prestation déclarés
 */
export const OnboardingAdvisorInputSchema = z.object({
  client_id:         z.string().min(1),
  criteres:          z.array(CritereForAdvisorSchema).min(1),
  business_secteurs: z.array(z.string()).default([]),
  types_prestation:  z.array(z.string()).default([]),
});

export type OnboardingAdvisorInput = z.infer<typeof OnboardingAdvisorInputSchema>;

// ─── OnboardingAdvisorOutput ──────────────────────────────────────────────────

/**
 * Sortie du module de conseil onboarding.
 *
 * - `client_id`            : client concerné
 * - `suggestions`          : suggestions triées par priorité (max MAX_ONBOARDING_SUGGESTIONS)
 * - `criteres_analyzed`    : nombre de critères analysés
 * - `redundancy_threshold` : seuil utilisé pour la détection de redondances
 *
 * Héritage de AIOutputBaseSchema :
 *   confidence_score, evidence, source_type, created_at, model, task_type
 */
export const OnboardingAdvisorOutputSchema = AIOutputBaseSchema.merge(
  z.object({
    client_id: z.string().min(1),

    suggestions: z.array(OnboardingSuggestionSchema)
      .max(MAX_ONBOARDING_SUGGESTIONS)
      .default([]),

    criteres_analyzed:    z.number().int().min(0).default(0),
    redundancy_threshold: z.number().min(0).max(1).default(CRITERE_REDUNDANCY_THRESHOLD),
  }),
).refine(
  (out) => out.task_type === 'onboarding_advice',
  { message: 'OnboardingAdvisorOutput.task_type doit être "onboarding_advice"' },
).refine(
  (out) => out.suggestions.every((s) => s.display_only === true),
  { message: 'Toutes les suggestions doivent avoir display_only: true' },
);

export type OnboardingAdvisorOutput = z.infer<typeof OnboardingAdvisorOutputSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const safeParseOnboardingAdvisorInput  = (raw: unknown) =>
  OnboardingAdvisorInputSchema.safeParse(raw);

export const safeParseOnboardingAdvisorOutput = (raw: unknown) =>
  OnboardingAdvisorOutputSchema.safeParse(raw);

export const safeParseOnboardingSuggestion = (raw: unknown) =>
  OnboardingSuggestionSchema.safeParse(raw);
