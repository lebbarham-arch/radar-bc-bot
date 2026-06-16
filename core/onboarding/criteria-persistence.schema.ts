/**
 * ONB-1e-A — Schéma de Persistance des Critères Approuvés
 *
 * Représente les payloads prêts pour l'insertion en table Supabase `criteres`.
 * Ce module ne fait AUCUN accès DB — il prépare uniquement les données.
 *
 * Table `criteres` (colonnes existantes) :
 *   id            UUID PK (généré par Supabase)
 *   client_id     UUID FK → clients
 *   valeur        TEXT    — mot-clé principal de matching
 *   type          TEXT    — 'contenu' | 'organisme' | 'wilaya'
 *   radar_type    TEXT    — 'bc' | 'mp'
 *   ai_inclusions JSONB   — variantes acceptées
 *   ai_exclusions JSONB   — variantes à exclure
 *   actif         BOOLEAN — true = critère actif dans le matching
 *
 * Colonnes non encore existantes → stockées dans metadata_json :
 *   domain_category, precision_mode, zones_geographiques,
 *   favorite_organizations, source_trace, review_audit,
 *   generated_from_onboarding
 *
 * Règles absolues :
 *   - Seuls les critères approved → PreparedCritereRow avec actif=true
 *   - Les critères rejected/pending/edited → skipped avec raison
 *   - Aucun accès DB dans ce module
 *   - Aucun appel IA
 */

import { z } from 'zod';

// ─── Row DB préparée ──────────────────────────────────────────────────────────

/**
 * Métadonnées ONB stockées dans metadata_json (colonne JSONB extensible).
 * Permet de transporter les informations L2/L3 sans modifier la table criteres.
 */
export const CritereMetadataSchema = z.object({
  /** Catégorie métier : "informatique", "cvc", "btp"… */
  domain_category: z.string(),
  /** Mode de précision hérité du profil */
  precision_mode: z.enum(['large', 'equilibre', 'strict']),
  /** Zones géographiques couvertes */
  zones_geographiques: z.array(z.string()).default([]),
  /** Organismes favoris */
  favorite_organizations: z.array(z.string()).default([]),
  /** Traçabilité L2→L3 */
  source_trace: z.record(z.string(), z.unknown()),
  /** Dernière entrée d'audit de la revue humaine */
  review_audit: z.array(z.record(z.string(), z.unknown())),
  /** Marqueur d'origine onboarding */
  generated_from_onboarding: z.literal(true),
  /** Prestations recherchées (pour future évolution) */
  prestations_recherchees: z.array(z.string()).default([]),
  /** Prestations exclues (pour future évolution) */
  prestations_exclues: z.array(z.string()).default([]),
});
export type CritereMetadata = z.infer<typeof CritereMetadataSchema>;

/**
 * Row prête pour insertion dans la table `criteres` Supabase.
 *
 * Champs directs = colonnes existantes.
 * metadata_json = colonnes futures / enrichissements onboarding.
 *
 * Invariant : actif est TOUJOURS true ici (seuls les approved arrivent).
 */
export const PreparedCritereRowSchema = z.object({
  /** UUID client — sera mis en FK */
  client_id: z.string(),

  /**
   * Mot-clé principal de matching.
   * Source : ProposedCritere.base_keywords[0] ?? ProposedCritere.label
   */
  valeur: z.string().min(1),

  /**
   * Type de critère.
   * ONB-1e-A génère uniquement "contenu" (matching textuel).
   * "organisme" et "wilaya" sont réservés à une gestion manuelle.
   */
  type: z.enum(['contenu', 'organisme', 'wilaya']).default('contenu'),

  /** Type radar compatible bot — toujours "bc" ou "mp" */
  radar_type: z.enum(['bc', 'mp']).default('bc'),

  /**
   * Inclusions de matching — synonymes et variantes acceptées.
   * Source : ai_inclusions_initial du critère approuvé.
   */
  ai_inclusions: z.array(z.string()).default([]),

  /**
   * Exclusions contextuelles.
   * Source : ai_exclusions_initial du critère approuvé.
   */
  ai_exclusions: z.array(z.string()).default([]),

  /**
   * Toujours true — seuls les critères approved sont préparés.
   * Ne peut jamais être false dans ce schema.
   */
  actif: z.literal(true),

  /**
   * Métadonnées étendues (domain_category, precision_mode, source_trace…).
   * Stockées en JSONB pour rétrocompatibilité avec la table existante.
   */
  metadata_json: CritereMetadataSchema,
});
export type PreparedCritereRow = z.infer<typeof PreparedCritereRowSchema>;

// ─── Critères ignorés ─────────────────────────────────────────────────────────

/**
 * Raisons pour lesquelles un critère est ignoré lors de la préparation.
 */
export const SkipReasonSchema = z.enum([
  'rejected',         // critère explicitement rejeté par le reviewer
  'not_approved',     // critère pending, edited — pas encore approuvé
  'invalid_payload',  // critère approuvé mais payload Zod invalide
]);
export type SkipReason = z.infer<typeof SkipReasonSchema>;

export const SkippedCritereSchema = z.object({
  /** Identifiant du critère ignoré */
  criterion_id: z.string(),
  /** Label lisible (pour debug) */
  label: z.string(),
  /** Statut de revue au moment du skip */
  review_status: z.string(),
  /** Raison du skip */
  reason: SkipReasonSchema,
  /** Détail optionnel (ex: message d'erreur Zod) */
  detail: z.string().optional(),
});
export type SkippedCritere = z.infer<typeof SkippedCritereSchema>;

// ─── Batch de persistance ─────────────────────────────────────────────────────

/**
 * Résultat complet de la préparation de persistance.
 * Produit par preparePersistenceBatch() — aucun accès DB.
 *
 * Pour persister :
 *   - Transmettre rows à un repository Supabase (ONB-1e-B)
 *   - Vérifier warnings avant insertion
 *   - Traiter skipped si nécessaire (re-review ou abandon)
 */
export const PreparedCriteriaPersistenceBatchSchema = z.object({
  /** Identifiant client */
  client_id: z.string().default(''),

  /** ISO datetime de préparation du batch */
  prepared_at: z.string().datetime(),

  /** Identifiant de session de revue source (pour traçabilité) */
  source_review_session: z.string(),

  /** Rows prêtes pour insertion */
  rows: z.array(PreparedCritereRowSchema),

  /** Critères ignorés avec raison */
  skipped: z.array(SkippedCritereSchema).default([]),

  /**
   * Avertissements non bloquants.
   * Ex : "aucune row préparée", "inclusions vides sur N critères"
   */
  warnings: z.array(z.string()).default([]),
});
export type PreparedCriteriaPersistenceBatch = z.infer<typeof PreparedCriteriaPersistenceBatchSchema>;
