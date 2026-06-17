/**
 * AI Cache — Anaho
 *
 * Couche cache typée pour tous les modules IA locaux.
 *
 * V1 : implémentation mémoire pure (Map) — aucune persistance.
 * Conçu pour être remplacé par Supabase/Redis sans changer les appelants :
 * ils ne dépendent que de l'interface ICache, jamais de MemoryCache directement.
 *
 * Responsabilités :
 *   - Stocker/récupérer des sorties IA sérialisées (JSON string)
 *   - Clé déterministe : sha256(model + task_type + content_normalisé)
 *   - TTL configurable par task_type (défauts dans constants.ts)
 *   - Invalidation explicite par client_id, critere_id ou tag libre
 *   - Compter hits/misses par task_type pour les métriques
 *
 * Politique de tags :
 *   Les tags sont des chaînes libres attachées à chaque entrée au moment du set.
 *   Convention recommandée :
 *     'client_id:<uuid>'   → invalider tout le cache d'un client
 *     'critere_id:<uuid>'  → invalider les enrichissements d'un critère
 *     'module:<task_type>' → invalider toutes les entrées d'un module
 *   Un feedback not_relevant déclenche invalidateByTag('critere_id:<id>').
 *
 * Ce module ne fait PAS :
 *   - D'appel LLM
 *   - De décision métier
 *   - De connexion réseau
 *   - D'accès base de données (V1)
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { createHash } from 'crypto';

import {
  CacheEntry,
  CacheEntrySchema,
  CacheKeyInput,
  CacheKeyInputSchema,
  CacheLookupResult,
  CacheStats,
  isCacheEntryValid,
  computeExpiresAt,
  normalizeCacheContent,
} from './schemas/cache.schema';

import { AITaskType } from './schemas/shared.schema';

import {
  EMBEDDING_CACHE_TTL_DAYS,
  ENRICHMENT_CACHE_TTL_DAYS,
  CLASSIFICATION_CACHE_TTL_DAYS,
} from './constants';

// ─── CacheSetOptions ──────────────────────────────────────────────────────────

/**
 * Options passées lors d'un set en cache.
 *
 * - `model`     : modèle Ollama ayant produit le payload
 * - `task_type` : type de tâche (détermine le TTL par défaut)
 * - `ttlDays`   : durée de vie en jours (si omis : TTL par défaut du task_type)
 * - `tags`      : tags pour invalidation groupée
 *                 Convention : 'client_id:<id>', 'critere_id:<id>', 'module:<task_type>'
 */
export interface CacheSetOptions {
  model:     string;
  task_type: AITaskType;
  ttlDays?:  number;
  tags?:     string[];
}

// ─── ICache ───────────────────────────────────────────────────────────────────

/**
 * Interface publique du cache IA.
 * Tout code consommateur (enricher, classifier, etc.) dépend de cette interface,
 * jamais de MemoryCache directement — ce qui permet de swapper l'implémentation.
 */
export interface ICache {
  /**
   * Récupère une entrée par sa clé.
   * Retourne un résultat discriminé — forcer la vérification du hit avant usage.
   */
  get(key: string, taskType: AITaskType): CacheLookupResult;

  /**
   * Stocke un payload JSON dans le cache.
   * Retourne l'entrée créée (validée par Zod).
   * Throws si le payload est vide ou si les options sont invalides.
   */
  set(key: string, payload: string, options: CacheSetOptions): CacheEntry;

  /**
   * Invalide toutes les entrées portant le tag 'client_id:<clientId>'.
   * Retourne le nombre d'entrées invalidées.
   */
  invalidateByClientId(clientId: string): number;

  /**
   * Invalide toutes les entrées portant le tag 'critere_id:<critereId>'.
   * À appeler sur un feedback not_relevant.
   * Retourne le nombre d'entrées invalidées.
   */
  invalidateByCritereId(critereId: string): number;

  /**
   * Invalide toutes les entrées portant un tag donné (forme libre).
   * Retourne le nombre d'entrées invalidées.
   */
  invalidateByTag(tag: string): number;

  /**
   * Invalide une entrée par sa clé exacte.
   * Retourne true si l'entrée existait et a été invalidée.
   */
  invalidateByKey(key: string): boolean;

  /**
   * Supprime physiquement toutes les entrées (invalidées ou non).
   * Remet les stats à zéro.
   */
  clear(): void;

  /**
   * Retourne les statistiques du cache par task_type.
   */
  getStats(): CacheStats[];

  /**
   * Calcule la clé de cache déterministe pour une entrée donnée.
   * Exposée pour permettre aux modules de vérifier avant de demander un get.
   */
  computeKey(input: CacheKeyInput): string;
}

// ─── Structures internes ──────────────────────────────────────────────────────

/**
 * Enveloppe interne d'une entrée de cache.
 * Augmente CacheEntry avec les tags (non exposés dans le schema public).
 */
interface InternalEntry {
  entry: CacheEntry;
  tags:  Set<string>;
}

/**
 * Compteurs de stats par task_type.
 */
interface StatCounters {
  hits:    number;
  misses:  number;
  expired: number;
}

// ─── MemoryCache ──────────────────────────────────────────────────────────────

export class MemoryCache implements ICache {
  /** Store principal : key → InternalEntry */
  private readonly store: Map<string, InternalEntry> = new Map();

  /** Index inversé tag → Set<key> pour invalidation O(|tag|) */
  private readonly tagIndex: Map<string, Set<string>> = new Map();

  /** Compteurs de stats par task_type */
  private readonly stats: Map<AITaskType, StatCounters> = new Map();

  // ─── get ────────────────────────────────────────────────────────────────────

  get(key: string, taskType: AITaskType): CacheLookupResult {
    const internal = this.store.get(key);

    if (internal === undefined) {
      this.recordMiss(taskType);
      return { hit: false, reason: 'not_found' };
    }

    const { entry } = internal;

    if (entry.invalidated) {
      this.recordMiss(taskType);
      return { hit: false, reason: 'invalidated' };
    }

    if (!isCacheEntryValid(entry)) {
      this.recordExpired(taskType);
      return { hit: false, reason: 'expired' };
    }

    // Hit — mettre à jour hit_count en mémoire
    const updated: CacheEntry = { ...entry, hit_count: entry.hit_count + 1 };
    internal.entry = updated;
    this.recordHit(taskType);

    return { hit: true, entry: updated };
  }

  // ─── set ────────────────────────────────────────────────────────────────────

  set(key: string, payload: string, options: CacheSetOptions): CacheEntry {
    if (payload.trim().length === 0) {
      throw new Error('CacheSet: payload vide interdit');
    }

    const ttlDays = options.ttlDays ?? getDefaultTTL(options.task_type);
    const now     = new Date();

    const candidate = {
      key,
      model:       options.model,
      task_type:   options.task_type,
      payload,
      created_at:  now.toISOString(),
      expires_at:  computeExpiresAt(ttlDays, now),
      hit_count:   0,
      invalidated: false,
    };

    const parsed = CacheEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(`CacheSet: entrée invalide — ${parsed.error.message}`);
    }

    const entry = parsed.data;
    const tags  = new Set(options.tags ?? []);

    // Ajouter les tags de convention automatiques
    tags.add(`module:${options.task_type}`);

    // Stocker
    this.store.set(key, { entry, tags });

    // Mettre à jour l'index inversé
    for (const tag of tags) {
      const existing = this.tagIndex.get(tag) ?? new Set<string>();
      existing.add(key);
      this.tagIndex.set(tag, existing);
    }

    return entry;
  }

  // ─── invalidation ───────────────────────────────────────────────────────────

  invalidateByClientId(clientId: string): number {
    return this.invalidateByTag(`client_id:${clientId}`);
  }

  invalidateByCritereId(critereId: string): number {
    return this.invalidateByTag(`critere_id:${critereId}`);
  }

  invalidateByTag(tag: string): number {
    const keys = this.tagIndex.get(tag);
    if (keys === undefined || keys.size === 0) return 0;

    let count = 0;
    for (const key of keys) {
      if (this.markInvalidated(key)) count++;
    }
    return count;
  }

  invalidateByKey(key: string): boolean {
    return this.markInvalidated(key);
  }

  // ─── clear ──────────────────────────────────────────────────────────────────

  clear(): void {
    this.store.clear();
    this.tagIndex.clear();
    this.stats.clear();
  }

  // ─── getStats ───────────────────────────────────────────────────────────────

  getStats(): CacheStats[] {
    const now = new Date().toISOString();

    // Collecter tous les task_types : ceux avec compteurs + ceux presents dans le store
    // (un set() sans get() cree des entrees sans compteurs — il faut quand meme les exposer)
    const taskTypes = new Set<AITaskType>(this.stats.keys());
    for (const { entry } of this.store.values()) {
      taskTypes.add(entry.task_type);
    }

    const result: CacheStats[] = [];

    for (const task_type of taskTypes) {
      const counters = this.stats.get(task_type) ?? { hits: 0, misses: 0, expired: 0 };

      // Compter les entrees non invalidees pour ce task_type
      let total = 0;
      for (const { entry } of this.store.values()) {
        if (entry.task_type === task_type && !entry.invalidated) total++;
      }

      result.push({
        task_type,
        total_entries:  total,
        hit_count:      counters.hits,
        miss_count:     counters.misses,
        expired_count:  counters.expired,
        computed_at:    now,
      });
    }

    return result;
  }

  // ─── computeKey ─────────────────────────────────────────────────────────────

  computeKey(input: CacheKeyInput): string {
    const parsed = CacheKeyInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error(`computeKey: input invalide — ${parsed.error.message}`);
    }
    return computeCacheKey(parsed.data);
  }

  // ─── Helpers privés ─────────────────────────────────────────────────────────

  private markInvalidated(key: string): boolean {
    const internal = this.store.get(key);
    if (internal === undefined) return false;
    if (internal.entry.invalidated) return false; // déjà invalidé
    internal.entry = { ...internal.entry, invalidated: true };
    return true;
  }

  private getOrCreateCounters(taskType: AITaskType): StatCounters {
    const existing = this.stats.get(taskType);
    if (existing !== undefined) return existing;
    const counters: StatCounters = { hits: 0, misses: 0, expired: 0 };
    this.stats.set(taskType, counters);
    return counters;
  }

  private recordHit(taskType: AITaskType): void {
    this.getOrCreateCounters(taskType).hits++;
  }

  private recordMiss(taskType: AITaskType): void {
    this.getOrCreateCounters(taskType).misses++;
  }

  private recordExpired(taskType: AITaskType): void {
    const c = this.getOrCreateCounters(taskType);
    c.expired++;
    c.misses++;
  }

  /** Expose la taille du store pour les tests. */
  get size(): number {
    return this.store.size;
  }
}

// ─── Fonctions pures exportées ────────────────────────────────────────────────

/**
 * Calcule une clé de cache sha256 déterministe.
 * sha256(model + ':' + task_type + ':' + normalize(content))
 *
 * Séparée de la classe pour être testable sans instancier MemoryCache.
 */
export function computeCacheKey(input: CacheKeyInput): string {
  const normalized = normalizeCacheContent(input.content);
  const raw        = `${input.model}:${input.task_type}:${normalized}`;
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Construit un tag de convention pour client_id.
 */
export function clientTag(clientId: string): string {
  return `client_id:${clientId}`;
}

/**
 * Construit un tag de convention pour critere_id.
 */
export function critereTag(critereId: string): string {
  return `critere_id:${critereId}`;
}

/**
 * Construit un tag de convention pour module (task_type).
 * Automatiquement ajouté par set() — exposé pour permettre les requêtes manuelles.
 */
export function moduleTag(taskType: AITaskType): string {
  return `module:${taskType}`;
}

/**
 * Retourne le TTL par défaut (en jours) pour un task_type donné.
 */
export function getDefaultTTL(taskType: AITaskType): number {
  switch (taskType) {
    case 'embedding':              return EMBEDDING_CACHE_TTL_DAYS;
    case 'enrichment':             return ENRICHMENT_CACHE_TTL_DAYS;
    case 'classification':         return CLASSIFICATION_CACHE_TTL_DAYS;
    case 'reranking':              return 7;    // reranking = court (scores changent)
    case 'opportunity_detection':  return 1;    // quotidien (BCs évoluent)
    case 'soft_exclusion_suggestion': return 7; // hebdomadaire
    case 'onboarding_advice':      return 30;   // mensuel
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Singleton de cache mémoire /**
 * Singleton de cache memoire pour l application.
 * En V2, cette factory retournera un SupabaseCache ou RedisCache.
 */
let _instance: MemoryCache | null = null;

export function getCache(): ICache {
  if (_instance === null) {
    _instance = new MemoryCache();
  }
  return _instance;
}

/**
 * Reinitialise le singleton -- a utiliser UNIQUEMENT dans les tests.
 */
export function resetCacheForTests(): void {
  _instance = null;
}
