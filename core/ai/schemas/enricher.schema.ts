/**
 * Enricher Schema — Anaho
 *
 * Contrats d'entrée/sortie du module d'enrichissement IA.
 *
 * Rôle : à partir d'un critère client brut, le LLM génère des variantes
 * lexicales candidates (`ai_inclusions`) et des termes à exclure (`ai_exclusions`).
 *
 * Contraintes :
 *   - MAX_AI_INCLUSIONS = 10 par critère (borné par le schema)
 *   - MAX_AI_EXCLUSIONS = 5 par critère (borné par le schema)
 *   - Le moteur déterministe décide d'utiliser ou non ces variantes
 *   - L'enrichisseur ne modifie jamais directement le profil client
 *   - prompt_hash permet d'invalider le cache si le prompt change
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';
import { AIOutputBaseSchema } from './shared.schema';
import { MAX_AI_INCLUSIONS, MAX_AI_EXCLUSIONS } from '../constants';

// ─── EnricherInput ────────────────────────────────────────────────────────────

/**
 * Entrée du module d'enrichissement.
 *
 * - `critere_id`            : identifiant du critère à enrichir
 * - `critere_valeur`        : mot-clé principal (ex: "câble réseau")
 * - `critere_type`          : type du critère (contenu | organisme | wilaya)
 * - `client_id`             : client propriétaire du critère
 * - `existing_inclusions`   : inclusions déjà connues (pour éviter les doublons)
 * - `existing_exclusions`   : exclusions déjà connues
 * - `business_context`      : secteur client pour contextualiser le prompt
 */
export const EnricherInputSchema = z.object({
  critere_id:           z.string().min(1),
  critere_valeur:       z.string().min(1),
  critere_type:         z.enum(['contenu', 'organisme', 'wilaya']),
  client_id:            z.string().min(1),
  existing_inclusions:  z.array(z.string()).default([]),
  existing_exclusions:  z.array(z.string()).default([]),
  business_context:     z.string().default(''),
});

export type EnricherInput = z.infer<typeof EnricherInputSchema>;

// ─── EnricherOutput ───────────────────────────────────────────────────────────

/**
 * Sortie du module d'enrichissement.
 *
 * - `critere_id`          : identifiant du critère enrichi (pour corrélation)
 * - `client_id`           : client propriétaire
 * - `proposed_inclusions` : variantes acceptées candidates (max MAX_AI_INCLUSIONS)
 * - `proposed_exclusions` : termes à exclure candidats (max MAX_AI_EXCLUSIONS)
 * - `prompt_hash`         : sha256 du prompt utilisé (clé de cache)
 *
 * Héritage de AIOutputBaseSchema :
 *   confidence_score, evidence, source_type, created_at, model, task_type
 */
export const EnricherOutputSchema = AIOutputBaseSchema.merge(
  z.object({
    critere_id:          z.string().min(1),
    client_id:           z.string().min(1),
    proposed_inclusions: z.array(z.string()).max(MAX_AI_INCLUSIONS).default([]),
    proposed_exclusions: z.array(z.string()).max(MAX_AI_EXCLUSIONS).default([]),
    prompt_hash:         z.string().min(1),
  }),
).refine(
  (out) => out.task_type === 'enrichment',
  { message: 'EnricherOutput.task_type doit être "enrichment"' },
);

export type EnricherOutput = z.infer<typeof EnricherOutputSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const safeParseEnricherInput  = (raw: unknown) => EnricherInputSchema.safeParse(raw);
export const safeParseEnricherOutput = (raw: unknown) => EnricherOutputSchema.safeParse(raw);
