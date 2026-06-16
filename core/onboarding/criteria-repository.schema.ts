/**
 * ONB-1e-B — Schéma du Repository de Persistance Supabase
 *
 * Définit les options, résultats et logs d'audit du repository.
 * N'importe pas Supabase directement — le client DB est injecté.
 *
 * Règles absolues :
 *   - Aucun critère non-approved ne peut passer
 *   - Feature flag obligatoire (enabled=false → aucune écriture)
 *   - dryRun=true → simulation sans écriture réelle
 *   - Pas de Supabase global caché
 *   - Aucun appel IA
 */

import { z } from 'zod';

// ─── Options de persistance ────────────────────────────────────────────────────

/**
 * Stratégie de gestion des doublons.
 *
 * skip_existing   — ignore la row si client_id+valeur+radar_type+type existe déjà
 * upsert_same_key — met à jour la row existante (ai_inclusions, ai_exclusions)
 */
export const ConflictStrategySchema = z.enum(['skip_existing', 'upsert_same_key']);
export type ConflictStrategy = z.infer<typeof ConflictStrategySchema>;

/**
 * Options d'appel à persistPreparedCriteriaBatch().
 */
export const PersistOptionsSchema = z.object({
  /**
   * Si true : simule l'opération sans aucun appel DB.
   * Retourne what_would_be_written avec les rows candidates.
   * Obligatoire avant toute écriture réelle en production.
   */
  dryRun: z.boolean().default(false),

  /**
   * Feature flag — si false : aucune écriture ni simulation réelle.
   * Permet de désactiver la persistance sans modifier le code.
   */
  enabled: z.boolean().default(false),

  /**
   * Stratégie de gestion des doublons détectés.
   * Clé de déduplication : client_id + valeur + radar_type + type
   */
  conflictStrategy: ConflictStrategySchema.default('skip_existing'),

  /**
   * Identifiant de l'acteur déclenchant l'opération (admin, système…).
   * Pour l'audit trail.
   */
  actor_id: z.string().min(1),

  /**
   * Source de l'opération — toujours "onboarding" pour ONB-1e-B.
   */
  source: z.literal('onboarding'),
});
export type PersistOptions = z.infer<typeof PersistOptionsSchema>;

// ─── Format exact table criteres ──────────────────────────────────────────────

/**
 * Row au format exact attendu par la table Supabase `criteres`.
 * Produit par buildCriteriaUpsertRows().
 *
 * Schéma production vérifié :
 *   id          uuid   (PK auto — absent ici)
 *   client_id   uuid   nullable
 *   type        text
 *   valeur      text
 *   radar_type  text   default 'bc'
 *   ai_inclusions jsonb default []
 *   ai_exclusions jsonb default []
 *
 * Colonnes ABSENTES du vrai schéma (ne jamais insérer) :
 *   - actif / active
 *   - created_at
 *   - metadata_json
 *
 * client_id doit être un UUID valide — validé avant toute écriture réelle.
 */
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CritereDbRowSchema = z.object({
  client_id:     z.string().regex(UUID_REGEX, 'client_id doit être un UUID valide'),
  valeur:        z.string().min(1),
  type:          z.enum(['contenu', 'organisme', 'wilaya']),
  radar_type:    z.enum(['bc', 'mp']),
  ai_inclusions: z.array(z.string()),
  ai_exclusions: z.array(z.string()),
});
export type CritereDbRow = z.infer<typeof CritereDbRowSchema>;

/**
 * Clé de déduplication — combinaison unique dans la table.
 */
export const DuplicateKeySchema = z.object({
  client_id:  z.string(),
  valeur:     z.string(),
  radar_type: z.enum(['bc', 'mp']),
  type:       z.enum(['contenu', 'organisme', 'wilaya']),
});
export type DuplicateKey = z.infer<typeof DuplicateKeySchema>;

// ─── Erreurs DB ───────────────────────────────────────────────────────────────

export const DbErrorSchema = z.object({
  row_valeur:    z.string(),
  row_client_id: z.string(),
  message:       z.string(),
  code:          z.string().optional(),
});
export type DbError = z.infer<typeof DbErrorSchema>;

// ─── Résultat de persistance ──────────────────────────────────────────────────

/**
 * Résultat retourné par persistPreparedCriteriaBatch().
 *
 * ok=true  → opération complète (même si certaines rows skippées)
 * ok=false → erreur DB non récupérable
 */
export const PersistResultSchema = z.object({
  /** Succès global de l'opération */
  ok: z.boolean(),

  /** Mode dry run — si true, aucune écriture n'a eu lieu */
  dry_run: z.boolean(),

  /** Feature flag état */
  enabled: z.boolean(),

  /** Rows qui auraient été / ont été insérées */
  inserted_count: z.number().int().min(0),

  /** Rows ignorées (doublons skip_existing + feature disabled) */
  skipped_count: z.number().int().min(0),

  /** Rows mises à jour (upsert_same_key) */
  upserted_count: z.number().int().min(0),

  /** Erreurs DB par row (non-bloquantes si les autres ont réussi) */
  errors: z.array(DbErrorSchema).default([]),

  /** Avertissements non bloquants */
  warnings: z.array(z.string()).default([]),

  /** Rows candidates (pour dry run et audit) */
  what_would_be_written: z.array(CritereDbRowSchema).default([]),

  /** Clés de déduplication détectées comme existantes */
  detected_duplicates: z.array(DuplicateKeySchema).default([]),

  /** ISO datetime de l'opération */
  persisted_at: z.string().datetime(),

  /** Source et acteur pour l'audit */
  actor_id: z.string(),
  source:   z.string(),
});
export type PersistResult = z.infer<typeof PersistResultSchema>;
