/**
 * Cache Schema — Anaho
 *
 * Contrats du système de cache de la couche IA locale.
 *
 * Principe :
 *   Toute sortie IA coûteuse (embedding, enrichissement, classification)
 *   est mise en cache avec une clé déterministe basée sur le contenu.
 *   La clé est un sha256(model + task_type + content_normalized).
 *
 * Propriétés du cache :
 *   - Clé déterministe : même entrée → même clé, toujours
 *   - TTL par task_type (définis dans constants.ts)
 *   - Invalidation explicite uniquement (pas d'éviction LRU auto)
 *   - hit_count pour détection des entrées chaudes
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';
import { AITaskTypeSchema } from './shared.schema';

// ─── CacheKeyInput ────────────────────────────────────────────────────────────

/**
 * Entrée pour la génération d'une clé de cache déterministe.
 *
 * - `model`      : identifiant du modèle Ollama (inclus dans la clé)
 * - `task_type`  : type de tâche (inclus dans la clé)
 * - `content`    : contenu source (sera normalisé avant hachage)
 *                  Pour les embeddings : le texte embedé
 *                  Pour les enrichissements : la valeur du critère
 *                  Pour les classifications : designation + specs concaténés
 */
export const CacheKeyInputSchema = z.object({
  model:     z.string().min(1),
  task_type: AITaskTypeSchema,
  content:   z.string().min(1),
});

export type CacheKeyInput = z.infer<typeof CacheKeyInputSchema>;

// ─── CacheEntry ───────────────────────────────────────────────────────────────

/**
 * Entrée de cache stockée en base de données.
 *
 * - `key`        : sha256 de (model + task_type + content_normalized)
 * - `model`      : modèle ayant produit la valeur
 * - `task_type`  : type de tâche (pour segmentation du cache)
 * - `payload`    : valeur sérialisée (JSON string de la sortie IA complète)
 * - `created_at` : timestamp de création (ISO)
 * - `expires_at` : timestamp d'expiration (ISO) — calculé selon le TTL du task_type
 * - `hit_count`  : nombre de fois où cette entrée a été lue (pour métriques)
 * - `invalidated`: true si l'entrée a été explicitement invalidée
 *                  (conservée en base pour audit, jamais retournée)
 */
export const CacheEntrySchema = z.object({
  key:         z.string().min(64).max(64),  // sha256 hex = 64 chars
  model:       z.string().min(1),
  task_type:   AITaskTypeSchema,
  payload:     z.string().min(1),           // JSON sérialisé de la sortie IA
  created_at:  z.string().datetime(),
  expires_at:  z.string().datetime(),
  hit_count:   z.number().int().min(0).default(0),
  invalidated: z.boolean().default(false),
});

export type CacheEntry = z.infer<typeof CacheEntrySchema>;

// ─── CacheLookupResult ────────────────────────────────────────────────────────

/**
 * Résultat d'une recherche en cache.
 * Pattern discriminé pour forcer la vérification du hit/miss avant usage.
 */
export const CacheLookupResultSchema = z.discriminatedUnion('hit', [
  z.object({
    hit:   z.literal(true),
    entry: CacheEntrySchema,
  }),
  z.object({
    hit:    z.literal(false),
    reason: z.enum(['not_found', 'expired', 'invalidated']),
  }),
]);

export type CacheLookupResult = z.infer<typeof CacheLookupResultSchema>;

// ─── CacheStats ───────────────────────────────────────────────────────────────

/**
 * Statistiques du cache par task_type.
 * Utilisé pour les métriques et le monitoring.
 */
export const CacheStatsSchema = z.object({
  task_type:    AITaskTypeSchema,
  total_entries: z.number().int().min(0),
  hit_count:    z.number().int().min(0),
  miss_count:   z.number().int().min(0),
  expired_count: z.number().int().min(0),
  computed_at:  z.string().datetime(),
});

export type CacheStats = z.infer<typeof CacheStatsSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const safeParseCacheKeyInput    = (raw: unknown) => CacheKeyInputSchema.safeParse(raw);
export const safeParseCacheEntry       = (raw: unknown) => CacheEntrySchema.safeParse(raw);
export const safeParseCacheLookupResult = (raw: unknown) => CacheLookupResultSchema.safeParse(raw);

/**
 * Vérifie si une entrée de cache est encore valide.
 * Une entrée invalidée n'est jamais valide, même si non expirée.
 */
export function isCacheEntryValid(entry: CacheEntry, now: Date = new Date()): boolean {
  if (entry.invalidated) return false;
  return new Date(entry.expires_at) > now;
}

/**
 * Calcule la date d'expiration à partir d'un TTL en jours.
 */
export function computeExpiresAt(ttlDays: number, from: Date = new Date()): string {
  const expires = new Date(from);
  expires.setDate(expires.getDate() + ttlDays);
  return expires.toISOString();
}

/**
 * Normalise le contenu avant hachage (trim, lowercase, collapse whitespace).
 * Garantit que la même donnée produit toujours la même clé.
 */
export function normalizeCacheContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, ' ');
}
