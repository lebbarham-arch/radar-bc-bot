/**
 * ONB-1c — Critères Radar Proposés (Layer L3)
 *
 * Sortie du générateur L2 → L3.
 * Ce schema représente des critères radar en attente de validation humaine.
 *
 * Règles absolues :
 *   - Jamais activés automatiquement (active: false, status: "pending_validation")
 *   - Aucune écriture Supabase ici
 *   - Aucun appel LLM
 *   - radar_type reste "bc" | "mp" pour compatibilité bot
 *   - domain_category porte la catégorie métier réelle
 *   - ai_exclusions_initial = exclusions contextuelles UNIQUEMENT (jamais lexicales)
 *   - source_trace documenté pour chaque champ L3
 */

import { z } from 'zod';
import { NiveauPrecisionSchema, PrestationSchema } from './schema';

// ─── RadarType compatible bot ─────────────────────────────────────────────────

/**
 * Types radar compatibles avec radar-bc-bot.js.
 * NB : la catégorie métier va dans domain_category, pas ici.
 */
export const ProposedRadarTypeSchema = z.enum(['bc', 'mp']);
export type ProposedRadarType = z.infer<typeof ProposedRadarTypeSchema>;

// ─── SourceTrace L3 ───────────────────────────────────────────────────────────

export const L3SourceTraceEntrySchema = z.object({
  /** Champ(s) L2 ayant produit cette valeur */
  source_l2_fields: z.array(z.string()),
  /** Type de dérivation */
  derivation: z.enum(['direct', 'extracted', 'composed', 'inferred']),
  /** Règle appliquée */
  note: z.string().optional(),
});

export type L3SourceTraceEntry = z.infer<typeof L3SourceTraceEntrySchema>;
export const L3SourceTraceSchema = z.record(z.string(), L3SourceTraceEntrySchema);
export type L3SourceTrace = z.infer<typeof L3SourceTraceSchema>;

// ─── ProposedCritere ──────────────────────────────────────────────────────────

/**
 * Un critère radar proposé, issu du profil L2.
 * Toujours en statut draft — jamais activé automatiquement.
 *
 * Champ clé : radar_type vs domain_category
 *   - radar_type      = portée technique du bot ("bc" | "mp") — ne change PAS
 *   - domain_category = catégorie métier réelle du critère (ex: "informatique", "cvc")
 */
export const ProposedCritereSchema = z.object({
  /** Identifiant déterministe : slugifié depuis label + domain_category */
  id: z.string().min(1),

  /** Label lisible humain — sera présenté au client pour validation */
  label: z.string().min(1),

  /**
   * Type radar compatible bot (bc | mp).
   * Toujours "bc" en phase initiale — "mp" réservé à l'avenir.
   * La catégorie métier est dans domain_category.
   */
  radar_type: ProposedRadarTypeSchema.default('bc'),

  /**
   * Catégorie métier réelle — séparée de radar_type pour éviter tout conflit.
   * Exemples : "informatique", "cvc", "btp", "impression", "mobilier", "medical"
   */
  domain_category: z.string().min(1),

  /**
   * Mots-clés de base du critère, issus de main_activity + capabilities.
   * Ces mots-clés alimenteront valeur + ai_inclusions en L4/L5.
   */
  base_keywords: z.array(z.string()).min(1),

  /**
   * Inclusions initiales déterministes — synonymes et variantes évidents.
   * Ne pas confondre avec ai_inclusions (L4) qui sont générées par LLM.
   * Restent pending_validation.
   */
  ai_inclusions_initial: z.array(z.string()).default([]),

  /**
   * Exclusions initiales CONTEXTUELLES uniquement.
   * Règle : jamais d'exclusion lexicale brute (pas de "maintenance", "achat"...).
   * Toujours des formulations contextuelles :
   *   ✓ "maintenance seule sans fourniture matériel"
   *   ✓ "formation sans fourniture ni installation"
   *   ✗ "maintenance"
   *   ✗ "achat"
   */
  ai_exclusions_initial: z.array(z.string()).default([]),

  /** Prestations que le client cherche activement */
  prestations_recherchees: z.array(PrestationSchema),

  /** Prestations que le client refuse — contextualisées */
  prestations_exclues: z.array(PrestationSchema).default([]),

  /** Zones géographiques couvertes par ce critère */
  zones_geographiques: z.array(z.string()).default([]),

  /** Types d'organismes favoris pour ce critère */
  favorite_organizations: z.array(z.string()).default([]),

  /**
   * Mode de précision hérité du profil L2.
   * Influence la largeur des inclusions/exclusions suggérées.
   *   large    → plus d'inclusions, exclusions minimales
   *   equilibre → équilibre par défaut
   *   strict   → peu d'inclusions, exclusions plus agressives
   */
  precision_mode: NiveauPrecisionSchema,

  /** Traçabilité complète : chaque champ L3 → source L2 */
  source_trace: L3SourceTraceSchema,

  /** Toujours true : un humain doit valider avant activation */
  requires_human_validation: z.literal(true),

  /** Toujours false : jamais activé automatiquement */
  active: z.literal(false),
});

export type ProposedCritere = z.infer<typeof ProposedCritereSchema>;

// ─── GeneratedCriteriaSet ─────────────────────────────────────────────────────

/**
 * Ensemble complet des critères proposés pour un client.
 * Sortie de generateCriteriaFromL2().
 *
 * Ce set n'est jamais persisté automatiquement.
 * Il doit passer par une interface de validation humaine (ONB-1d) avant activation.
 */
export const GeneratedCriteriaSetSchema = z.object({
  /**
   * Identifiant client — UUID ou slug.
   * Peut être vide si généré avant l'attribution d'un client_id (preview).
   */
  client_id: z.string().default(''),

  /** ISO datetime de génération */
  generated_at: z.string().datetime(),

  /**
   * Statut de l'ensemble.
   * Toujours "pending_validation" à la sortie du générateur.
   */
  status: z.literal('pending_validation'),

  /** Critères proposés */
  criteria: z.array(ProposedCritereSchema).min(1),

  /**
   * Métadonnées de génération : version du générateur, paramètres utilisés.
   * Utile pour rejouer ou auditer une génération.
   */
  generation_meta: z.object({
    generator_version: z.string(),
    precision_mode:    NiveauPrecisionSchema,
    source_profile_sectors: z.array(z.string()),
  }),
});

export type GeneratedCriteriaSet = z.infer<typeof GeneratedCriteriaSetSchema>;
