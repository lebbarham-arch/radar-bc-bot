/**
 * ONB-2 — Schémas Zod pour l'enrichissement IA contrôlé des critères L3
 *
 * Règles absolues :
 *   - L'IA ne modifie jamais L1, L2, base_keywords, radar_type, domain_category
 *   - L'IA ne rend jamais un critère active=true
 *   - L'IA ne persiste rien en base
 *   - Toute suggestion IA reste pending_validation jusqu'à validation humaine
 *   - Toute exclusion IA doit être contextuelle (jamais lexicale brute)
 */

import { z } from 'zod';

// ─── Limites ──────────────────────────────────────────────────────────────────

const MAX_SUGGESTED_INCLUSIONS         = 15;
const MAX_SUGGESTED_EXCLUSIONS         = 8;
const MAX_SUGGESTED_VARIANTS           = 10;
const MAX_SUGGESTED_POSITIVE_TERMS     = 10;
const MAX_SUGGESTED_NEGATIVE_CONTEXTS  = 8;

// ─── Statut d'enrichissement ──────────────────────────────────────────────────

export const EnrichmentStatusSchema = z.enum([
  'enriched',   // LLM appelé avec succès, suggestions présentes
  'fallback',   // LLM indisponible — suggestions vides, critère original préservé
  'error',      // LLM a répondu mais JSON invalide ou suggestions rejetées
]);
export type EnrichmentStatus = z.infer<typeof EnrichmentStatusSchema>;

// ─── Suggestions IA pour un critère ──────────────────────────────────────────

export const AISuggestionForCritereSchema = z.object({
  /** ID du critère source (correspondance avec ProposedCritere.id) */
  critere_id: z.string().min(1),

  /**
   * Inclusions supplémentaires suggérées par l'IA.
   * Enrichissement de ai_inclusions_initial — ne remplace pas.
   * Toujours en attente de validation humaine.
   */
  suggested_inclusions: z.array(z.string()).max(MAX_SUGGESTED_INCLUSIONS).default([]),

  /**
   * Exclusions supplémentaires suggérées par l'IA.
   * TOUJOURS CONTEXTUELLES — validées par validateExclusionSafe().
   * Les exclusions lexicales brutes sont rejetées automatiquement.
   */
  suggested_exclusions: z.array(z.string()).max(MAX_SUGGESTED_EXCLUSIONS).default([]),

  /**
   * Variantes du libellé ou du critère principal.
   * Ex : "fourniture PC" → "acquisition ordinateurs", "dotation postes de travail"
   */
  suggested_variants: z.array(z.string()).max(MAX_SUGGESTED_VARIANTS).default([]),

  /**
   * Termes positifs utiles pour qualifier un bon marché.
   * Ex : "lot", "appel d'offres ouvert", "accord-cadre"
   */
  suggested_positive_terms: z.array(z.string()).max(MAX_SUGGESTED_POSITIVE_TERMS).default([]),

  /**
   * Contextes négatifs — formulations qui signalent un marché hors périmètre.
   * Distincts des exclusions : ce sont des signaux, pas des filtres durs.
   * Ex : "simple réparation", "contrat de maintenance uniquement"
   */
  suggested_negative_contexts: z.array(z.string()).max(MAX_SUGGESTED_NEGATIVE_CONTEXTS).default([]),

  /**
   * Note de revue libre générée par l'IA — pour l'admin qui relit.
   * Ex : "Ce critère pourrait capturer des marchés BTP — vérifier les exclusions travaux"
   */
  review_notes: z.string().default(''),

  /** Confiance de l'IA dans ses suggestions (0–1) */
  confidence: z.number().min(0).max(1).default(0),

  /** Statut de l'enrichissement */
  enrichment_status: EnrichmentStatusSchema.default('fallback'),

  /** Avertissements générés pendant l'enrichissement */
  warnings: z.array(z.string()).default([]),
});

export type AISuggestionForCritere = z.infer<typeof AISuggestionForCritereSchema>;

// ─── Réponse JSON brute attendue du LLM ──────────────────────────────────────

/**
 * Structure JSON que l'on attend du LLM dans sa réponse.
 * Validée par Zod avant utilisation — toute réponse invalide → fallback.
 */
export const LLMEnrichmentResponseSchema = z.object({
  suggested_inclusions:        z.array(z.string()).max(MAX_SUGGESTED_INCLUSIONS).default([]),
  suggested_exclusions:        z.array(z.string()).max(MAX_SUGGESTED_EXCLUSIONS).default([]),
  suggested_variants:          z.array(z.string()).max(MAX_SUGGESTED_VARIANTS).default([]),
  suggested_positive_terms:    z.array(z.string()).max(MAX_SUGGESTED_POSITIVE_TERMS).default([]),
  suggested_negative_contexts: z.array(z.string()).max(MAX_SUGGESTED_NEGATIVE_CONTEXTS).default([]),
  review_notes:                z.string().default(''),
  confidence:                  z.number().min(0).max(1).default(0.5),
});

export type LLMEnrichmentResponse = z.infer<typeof LLMEnrichmentResponseSchema>;

// ─── Critère enrichi ──────────────────────────────────────────────────────────

/**
 * Critère L3 original + suggestions IA en couche séparée.
 *
 * Règles immuables :
 *   - Tous les champs du ProposedCritere sont préservés SANS MODIFICATION
 *   - active reste false
 *   - radar_type reste inchangé
 *   - domain_category reste inchangée
 *   - base_keywords restent inchangés
 *   - requires_human_validation reste true
 */
export const AIEnrichedCritereSchema = z.object({
  // ── Champs originaux ProposedCritere (préservés sans modification) ─────────
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
  requires_human_validation: z.literal(true),
  active:                    z.literal(false),

  // ── Suggestions IA — couche séparée, pending_validation ───────────────────
  ai_suggestions: AISuggestionForCritereSchema,
});

export type AIEnrichedCritere = z.infer<typeof AIEnrichedCritereSchema>;

// ─── Jeu de critères enrichi ──────────────────────────────────────────────────

export const AIEnrichedCriteriaSetSchema = z.object({
  /** Identifiant client hérité du GeneratedCriteriaSet */
  client_id: z.string().default(''),

  /** Source traçable : toujours 'ai_enrichment' */
  source: z.literal('ai_enrichment'),

  /** Horodatage de l'enrichissement */
  enriched_at: z.string().datetime(),

  /** Critères enrichis — même count que l'entrée */
  criteria: z.array(AIEnrichedCritereSchema).min(1),

  /** Avertissements globaux de l'enrichissement */
  warnings: z.array(z.string()).default([]),

  /** Modèle LLM utilisé (ou 'mock' en test) */
  enrichment_model: z.string().default('unknown'),

  /** Toujours true — validation humaine obligatoire avant activation */
  requires_human_validation: z.literal(true),

  /** Toujours false — aucune activation automatique */
  active: z.literal(false),
});

export type AIEnrichedCriteriaSet = z.infer<typeof AIEnrichedCriteriaSetSchema>;

// ─── Helpers de validation ────────────────────────────────────────────────────

export const safeParseAISuggestion      = (raw: unknown) => AISuggestionForCritereSchema.safeParse(raw);
export const safeParseLLMEnrichResponse = (raw: unknown) => LLMEnrichmentResponseSchema.safeParse(raw);
export const safeParseAIEnrichedSet     = (raw: unknown) => AIEnrichedCriteriaSetSchema.safeParse(raw);
