/**
 * ONB-1e-B — Repository Supabase des Critères Approuvés
 *
 * Prend un PreparedCriteriaPersistenceBatch validé et écrit les critères
 * dans la table Supabase `criteres`.
 *
 * Règles absolues :
 *   - Seules les rows d'un batch validé Zod peuvent être persistées
 *   - Ne jamais écrire de critère non approved
 *   - Feature flag enabled=false → aucune écriture
 *   - dryRun=true → simulation sans écriture réelle
 *   - Pas de Supabase global caché — client DB injecté
 *   - Pas d'appel IA
 *   - Pas de radar-bc-bot.js
 *   - Erreur DB retournée proprement, jamais relancée non contrôlée
 */

import {
  type PreparedCriteriaPersistenceBatch,
  type PreparedCritereRow,   // eslint-disable-line @typescript-eslint/no-unused-vars
  PreparedCriteriaPersistenceBatchSchema,
} from './criteria-persistence.schema';

import {
  PersistOptionsSchema,
  CritereDbRowSchema,
  UUID_REGEX,
  type PersistOptions,
  type CritereDbRow,
  type DuplicateKey,
  type DbError,
  type PersistResult,
} from './criteria-repository.schema';

export type { DuplicateKey };

// ─── Interface DB injectable ──────────────────────────────────────────────────

/**
 * Interface minimale du client DB injecté.
 * Compatible avec le client Supabase et tout mock de test.
 *
 * Pas d'import Supabase ici — l'appelant injecte son client.
 */
export interface ICriteriaDbClient {
  /**
   * Insère des rows dans la table `criteres`.
   * Retourne les rows insérées ou une erreur.
   */
  insert(
    rows: CritereDbRow[],
  ): Promise<{ data: unknown[] | null; error: { message: string; code?: string } | null }>;

  /**
   * Upsert des rows dans la table `criteres`.
   * Clé de conflit : (client_id, valeur, radar_type, type)
   */
  upsert(
    rows: CritereDbRow[],
    conflictColumns: string[],
  ): Promise<{ data: unknown[] | null; error: { message: string; code?: string } | null }>;

  /**
   * Vérifie quelles clés existent déjà dans la table.
   * Retourne les clés (client_id+valeur+radar_type+type) présentes.
   */
  findExistingKeys(
    keys: DuplicateKey[],
  ): Promise<{ data: DuplicateKey[] | null; error: { message: string; code?: string } | null }>;
}

// ─── Clé de déduplication ────────────────────────────────────────────────────

function rowToKey(row: CritereDbRow): string {
  return `${row.client_id}|${row.valeur}|${row.radar_type}|${row.type}`;
}

function duplicateKeyToString(key: DuplicateKey): string {
  return `${key.client_id}|${key.valeur}|${key.radar_type}|${key.type}`;
}

// ─── Fonctions pures ──────────────────────────────────────────────────────────

/**
 * Transforme une PreparedCritereRow en CritereDbRow (format exact table).
 * Fonction pure — aucun effet de bord.
 */
export function buildCriteriaUpsertRows(batch: PreparedCriteriaPersistenceBatch): CritereDbRow[] {
  return batch.rows.map(row => {
    // Schéma production vérifié : uniquement ces 6 colonnes.
    // Pas de actif, pas de created_at, pas de metadata_json.
    // client_id doit être un UUID valide (validé par CritereDbRowSchema).
    const dbRow = {
      client_id:     row.client_id,
      valeur:        row.valeur,
      type:          row.type,
      radar_type:    row.radar_type,
      ai_inclusions: row.ai_inclusions,
      ai_exclusions: row.ai_exclusions,
    };
    return CritereDbRowSchema.parse(dbRow);
  });
}

/**
 * Détecte les doublons parmi les rows candidates en les croisant
 * avec les clés existantes retournées par le client DB.
 *
 * @param rows      Rows candidates à insérer
 * @param existing  Clés déjà présentes en base (résultat findExistingKeys)
 * @returns         { toInsert, toSkip } partitionnées selon les doublons
 */
export function detectDuplicates(
  rows: CritereDbRow[],
  existing: DuplicateKey[],
): { toInsert: CritereDbRow[]; toSkip: CritereDbRow[] } {
  const existingSet = new Set(existing.map(duplicateKeyToString));

  const toInsert: CritereDbRow[] = [];
  const toSkip:   CritereDbRow[] = [];

  for (const row of rows) {
    if (existingSet.has(rowToKey(row))) {
      toSkip.push(row);
    } else {
      toInsert.push(row);
    }
  }

  return { toInsert, toSkip };
}

// ─── Résultat rapide (sans DB) ────────────────────────────────────────────────

function makeQuickResult(
  patch: Partial<PersistResult>,
  options: PersistOptions,
  rows: CritereDbRow[],
): PersistResult {
  return {
    ok:                    true,
    dry_run:               options.dryRun,
    enabled:               options.enabled,
    inserted_count:        0,
    skipped_count:         0,
    upserted_count:        0,
    errors:                [],
    warnings:              [],
    what_would_be_written: rows,
    detected_duplicates:   [],
    persisted_at:          new Date().toISOString(),
    actor_id:              options.actor_id,
    source:                options.source,
    ...patch,
  };
}

// ─── Fonction principale ───────────────────────────────────────────────────────

/**
 * Persiste un PreparedCriteriaPersistenceBatch validé dans la table `criteres`.
 *
 * @param batch    Batch préparé par preparePersistenceBatch() (ONB-1e-A)
 * @param options  Options : dryRun, enabled, conflictStrategy, actor_id, source
 * @param dbClient Client DB injecté (Supabase ou mock de test)
 * @returns        PersistResult — jamais une exception non contrôlée
 */
export async function persistPreparedCriteriaBatch(
  batch: PreparedCriteriaPersistenceBatch,
  options: PersistOptions,
  dbClient: ICriteriaDbClient,
): Promise<PersistResult> {

  // ── 1. Validation Zod des options ─────────────────────────────────────────
  const parsedOptions = PersistOptionsSchema.safeParse(options);
  if (!parsedOptions.success) {
    return makeQuickResult(
      {
        ok:       false,
        warnings: [`Options invalides : ${parsedOptions.error.message}`],
      },
      options,
      [],
    );
  }
  const opts = parsedOptions.data;

  // ── 2. Validation Zod du batch ────────────────────────────────────────────
  const parsedBatch = PreparedCriteriaPersistenceBatchSchema.safeParse(batch);
  if (!parsedBatch.success) {
    return makeQuickResult(
      {
        ok:       false,
        warnings: [`Batch invalide : ${parsedBatch.error.message}`],
      },
      opts,
      [],
    );
  }
  const validBatch = parsedBatch.data;

  // ── 3. Batch vide ─────────────────────────────────────────────────────────
  if (validBatch.rows.length === 0) {
    return makeQuickResult(
      {
        warnings: [
          'Batch vide — aucune row à persister. Vérifiez que des critères approved existent.',
        ],
      },
      opts,
      [],
    );
  }

  // ── 4. Feature flag disabled ──────────────────────────────────────────────
  if (!opts.enabled) {
    return makeQuickResult(
      {
        warnings: [
          'Feature flag enabled=false — aucune écriture effectuée. Activez la persistance explicitement.',
        ],
      },
      opts,
      buildCriteriaUpsertRows(validBatch),
    );
  }

  // ── 5. Construire les rows DB ─────────────────────────────────────────────
  const dbRows = buildCriteriaUpsertRows(validBatch);

  // ── 6. Dry run ────────────────────────────────────────────────────────────
  if (opts.dryRun) {
    return makeQuickResult(
      {
        what_would_be_written: dbRows,
        warnings: [
          `Dry run — ${dbRows.length} row(s) seraient écrites. Aucune écriture réelle.`,
        ],
      },
      opts,
      dbRows,
    );
  }

  // ── 7. Validation UUID client_id avant écriture réelle ───────────────────
  // Le schéma production exige un UUID valide pour client_id.
  // Un client_id fictif (ex : "pilot-esi-maroc-01") est rejeté ici.
  const invalidClientIds = dbRows
    .map(r => r.client_id)
    .filter(id => !UUID_REGEX.test(id));

  if (invalidClientIds.length > 0) {
    return makeQuickResult(
      {
        ok:       false,
        warnings: [
          `client_id invalide (doit être UUID) : ${[...new Set(invalidClientIds)].join(', ')}. ` +
          'Aucune écriture effectuée.',
        ],
      },
      opts,
      dbRows,
    );
  }

  // ── 8. Détection des doublons ─────────────────────────────────────────────
  const candidateKeys: DuplicateKey[] = dbRows.map(r => ({
    client_id:  r.client_id,
    valeur:     r.valeur,
    radar_type: r.radar_type,
    type:       r.type,
  }));

  let existingKeys: DuplicateKey[] = [];
  {
    const { data, error } = await dbClient.findExistingKeys(candidateKeys);
    if (error) {
      return makeQuickResult(
        {
          ok:       false,
          errors:   [{ row_valeur: '*', row_client_id: '*', message: error.message, code: error.code }],
          warnings: ['Impossible de vérifier les doublons existants.'],
        },
        opts,
        dbRows,
      );
    }
    existingKeys = data ?? [];
  }

  const { toInsert, toSkip } = detectDuplicates(dbRows, existingKeys);
  const detectedDuplicates: DuplicateKey[] = toSkip.map(r => ({
    client_id:  r.client_id,
    valeur:     r.valeur,
    radar_type: r.radar_type,
    type:       r.type,
  }));

  // ── 9. Écriture selon la stratégie ────────────────────────────────────────
  const errors: DbError[] = [];
  let insertedCount  = 0;
  let skippedCount   = toSkip.length;
  let upsertedCount  = 0;

  if (opts.conflictStrategy === 'skip_existing') {
    // N'insère que les rows sans doublon
    if (toInsert.length > 0) {
      const { error } = await dbClient.insert(toInsert);
      if (error) {
        for (const row of toInsert) {
          errors.push({
            row_valeur:    row.valeur,
            row_client_id: row.client_id,
            message:       error.message,
            code:          error.code,
          });
        }
        return makeQuickResult(
          {
            ok:                  false,
            inserted_count:      0,
            skipped_count:       skippedCount,
            errors,
            detected_duplicates: detectedDuplicates,
            what_would_be_written: dbRows,
          },
          opts,
          dbRows,
        );
      }
      insertedCount = toInsert.length;
    }
    // Les doublons (toSkip) sont silencieusement ignorés

  } else {
    // upsert_same_key — upsert sur toutes les rows (insert + update des existantes)
    if (dbRows.length > 0) {
      const { error } = await dbClient.upsert(dbRows, ['client_id', 'valeur', 'radar_type', 'type']);
      if (error) {
        for (const row of dbRows) {
          errors.push({
            row_valeur:    row.valeur,
            row_client_id: row.client_id,
            message:       error.message,
            code:          error.code,
          });
        }
        return makeQuickResult(
          {
            ok:                  false,
            upserted_count:      0,
            skipped_count:       0,
            errors,
            detected_duplicates: detectedDuplicates,
            what_would_be_written: dbRows,
          },
          opts,
          dbRows,
        );
      }
      upsertedCount = dbRows.length;
      skippedCount  = 0;  // upsert traite tout, rien de skippé
    }
  }

  // ── 10. Résultat final ─────────────────────────────────────────────────────
  const warnings: string[] = [];
  if (toSkip.length > 0 && opts.conflictStrategy === 'skip_existing') {
    warnings.push(
      `${toSkip.length} doublon(s) ignoré(s) (skip_existing) : ${toSkip.map(r => r.valeur).join(', ')}`,
    );
  }

  return {
    ok:                    true,
    dry_run:               false,
    enabled:               true,
    inserted_count:        insertedCount,
    skipped_count:         skippedCount,
    upserted_count:        upsertedCount,
    errors,
    warnings,
    what_would_be_written: dbRows,
    detected_duplicates:   detectedDuplicates,
    persisted_at:          new Date().toISOString(),
    actor_id:              opts.actor_id,
    source:                opts.source,
  };
}
