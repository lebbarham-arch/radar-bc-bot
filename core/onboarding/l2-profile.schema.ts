/**
 * ONB-1b — Profil Métier Structuré (Layer L2)
 *
 * Sortie du mapping L1 → L2.
 * Ce schema représente la structure intermédiaire entre la fiche client (L1)
 * et les critères radar (L3).
 *
 * Règles absolues :
 *   - Pas de ai_inclusions / ai_exclusions (appartiennent à L3)
 *   - Pas de critères radar (générés en L3)
 *   - Pas d'appel IA (L4 uniquement)
 *   - Chaque champ L2 référence sa source L1 via source_trace
 */

import { z } from 'zod';
import { PrestationSchema, NiveauPrecisionSchema } from './schema';

// ─── BusinessProfile L2 ───────────────────────────────────────────────────────

/**
 * Profil métier structuré, issu de activite_principale + prestations.
 * Alimente business_profile du ClientProfileSchema en L3.
 */
export const L2BusinessProfileSchema = z.object({
  /** Activité principale, copiée directement depuis L1 */
  main_activity: z.string().min(1),

  /**
   * Secteurs/catégories déduits de activite_principale par extraction lexicale.
   * Exemples : ["informatique", "réseau", "bureautique"]
   * Aucun LLM — extraction purement textuelle.
   */
  sectors: z.array(z.string()).default([]),

  /**
   * Prestations que le client recherche activement.
   * Source directe : prestations_realisees (L1).
   */
  prestations_recherchees: z.array(PrestationSchema),

  /**
   * Prestations que le client refuse explicitement.
   * Source directe : prestations_refusees (L1).
   */
  prestations_refusees: z.array(PrestationSchema).default([]),

  /**
   * Mode de précision du radar, mappé depuis niveau_precision (L1).
   */
  precision_mode: NiveauPrecisionSchema,
});

export type L2BusinessProfile = z.infer<typeof L2BusinessProfileSchema>;

// ─── TechnicalProfile L2 ─────────────────────────────────────────────────────

/**
 * Profil technique, issu de capacites + exemples_bc_recherches.
 * Alimente technical_profile du ClientProfileSchema en L3.
 */
export const L2TechnicalProfileSchema = z.object({
  /**
   * Capacités brutes du client, copiées depuis L1.
   * Correspondent aux items de capacites[].
   */
  capabilities: z.array(z.string()).default([]),

  /**
   * Produits ou services fournis — synonyme affiné de capabilities.
   * Actuellement identique à capabilities, sera précisé en L3.
   */
  products_or_services: z.array(z.string()).default([]),

  /**
   * Marques ou références détectées dans capacites + exemples_bc_recherches.
   * Extraction déterministe : mots tout-caps ≥ 2 chars, CamelCase technique.
   * Exemples : ["HP", "Dell", "VRV", "Daikin", "Cisco"]
   * Pas de LLM — pattern matching uniquement.
   */
  brands_or_references: z.array(z.string()).default([]),

  /**
   * Termes techniques multi-mots ou spécifications détectés.
   * Extraction déterministe depuis capacites + exemples.
   * Exemples : ["Core i7", "18000 BTU", "split system", "rack 2U"]
   */
  technical_terms: z.array(z.string()).default([]),
});

export type L2TechnicalProfile = z.infer<typeof L2TechnicalProfileSchema>;

// ─── OrganizationProfile L2 ──────────────────────────────────────────────────

/**
 * Profil organisationnel, issu de zones_geographiques + organismes_favoris.
 * Alimente organization_profile du ClientProfileSchema en L3.
 * Ces champs restent en L2 — ils ne migrent pas dans les critères radar.
 */
export const L2OrganizationProfileSchema = z.object({
  /**
   * Zones géographiques couvertes.
   * Source directe : zones_geographiques (L1).
   */
  zones_geographiques: z.array(z.string()).default([]),

  /**
   * Types d'organismes publics favoris.
   * Source directe : organismes_favoris (L1).
   */
  favorite_organizations: z.array(z.string()).default([]),
});

export type L2OrganizationProfile = z.infer<typeof L2OrganizationProfileSchema>;

// ─── IntentProfile L2 ────────────────────────────────────────────────────────

/**
 * Intentions de matching structurées, déduites des prestations.
 * Alimentera la détection d'intention du moteur (detectBCIntent) en L5.
 * Note : la correspondance exacte vers BCIntent ('fourniture' | 'maintenance' | ...)
 * est réalisée en L3, pas ici.
 */
export const L2IntentProfileSchema = z.object({
  /**
   * Intentions recherchées, mappées depuis prestations_realisees.
   * Ces intentions guident le matching dans scoreBusinessIntentComponent (L5).
   */
  searched_intentions: z.array(PrestationSchema),

  /**
   * Intentions contextuellement exclues, mappées depuis prestations_refusees.
   * Alimenteront exclusions_metier en L3 pour computeContextualExclusionPenalty (L5).
   */
  excluded_intentions: z.array(PrestationSchema).default([]),
});

export type L2IntentProfile = z.infer<typeof L2IntentProfileSchema>;

// ─── SourceTrace L2 ──────────────────────────────────────────────────────────

/**
 * Traçabilité complète : chaque champ L2 pointe vers sa source L1.
 * Aucun champ L2 ne doit être opaque.
 * Utilisé pour debug, audit, et validation humaine en ONB-1e.
 */
export const SourceTraceEntrySchema = z.object({
  /** Champ(s) L1 ayant produit cette valeur */
  source_fields: z.array(z.string()),
  /** Type de dérivation */
  derivation: z.enum(['direct', 'extracted', 'mapped', 'inferred']),
  /** Note optionnelle expliquant la règle appliquée */
  note: z.string().optional(),
});

export type SourceTraceEntry = z.infer<typeof SourceTraceEntrySchema>;

export const SourceTraceSchema = z.record(z.string(), SourceTraceEntrySchema);
export type SourceTrace = z.infer<typeof SourceTraceSchema>;

// ─── StructuredBusinessProfile L2 ────────────────────────────────────────────

/**
 * Sortie complète du mapping L1 → L2.
 * Entrée du mapping L2 → L3 (ONB-1c).
 */
export const StructuredBusinessProfileSchema = z.object({
  business_profile:     L2BusinessProfileSchema,
  technical_profile:    L2TechnicalProfileSchema,
  organization_profile: L2OrganizationProfileSchema,
  intent_profile:       L2IntentProfileSchema,
  source_trace:         SourceTraceSchema,
});

export type StructuredBusinessProfile = z.infer<typeof StructuredBusinessProfileSchema>;
