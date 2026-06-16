/**
 * ONB-2d — Adapter de persistance dry run pour critères enrichis IA
 *
 * Convertit un AIMergedCriteriaSet (ONB-2c) en structures compatibles
 * avec le workflow de persistance existant (ONB-1e/ONB-1i), puis exécute
 * un dry run sans aucune écriture DB.
 *
 * Pipeline :
 *   AIMergedCriteriaSet
 *     → adaptMergedToReviewable()   → ReviewableCriteriaSet
 *     → preparePersistenceBatch()   → PreparedCriteriaPersistenceBatch
 *     → persistPreparedCriteriaBatch(dryRun=true) → PersistResult
 *     → AIPersistenceDryRunReport
 *
 * INTERDIT :
 *   - Écriture DB réelle (dryRun=true forcé)
 *   - Appel IA
 *   - Mutation de l'entrée AIMergedCriteriaSet
 *   - Création d'un second workflow parallèle
 *   - Modification de radar-bc-bot.js
 *
 * AUTORISÉ :
 *   - Réutilisation de preparePersistenceBatch() tel quel
 *   - Réutilisation de persistPreparedCriteriaBatch() en dryRun=true
 *   - Mock DB client sécurisé (throw si appelé réellement)
 *   - Production d'un rapport dry run lisible
 */

import { z } from 'zod';

import {
  type AIMergedCriteriaSet,
  type AIMergedCritere,
  type MergeAudit,
} from './criteria-ai-merge.schema';

import {
  type ReviewableCriteriaSet,
  type ReviewableCritere,
} from './l3-review.schema';

import type { Prestation }    from './schema';
import type { L3SourceTrace } from './l3-criteria.schema';

import {
  preparePersistenceBatch,
} from './criteria-persistence-adapter';

import {
  persistPreparedCriteriaBatch,
  type ICriteriaDbClient,
} from './criteria-repository';

import type { PreparedCriteriaPersistenceBatch } from './criteria-persistence.schema';
import type { PersistResult }                    from './criteria-repository.schema';

// ─── Schéma du rapport dry run ────────────────────────────────────────────────

export const AIPersistenceDryRunReportSchema = z.object({
  /** Toujours true dans ce module */
  dry_run: z.literal(true),

  /** Critères convertis et prêts pour persistance */
  prepared_count: z.number().int().min(0),

  /** Critères ignorés (aucun critère dans merged, ou batch vide) */
  skipped_count: z.number().int().min(0),

  /** Rows qui SERAIENT écrites en écriture réelle */
  what_would_be_written: z.array(z.record(z.string(), z.unknown())).default([]),

  /** Avertissements de l'adapter + du workflow de persistance */
  warnings: z.array(z.string()).default([]),

  /** Audits de fusion par critère (de ONB-2c) */
  merge_audits: z.array(z.record(z.string(), z.unknown())).default([]),

  /** Critères ignorés lors de la préparation du batch */
  skipped_criteria: z.array(z.object({
    criterion_id:  z.string(),
    label:         z.string(),
    reason:        z.string(),
  })).default([]),

  /** Horodatage du dry run */
  run_at: z.string().datetime(),

  /** Modèle LLM ayant enrichi les critères */
  enrichment_model: z.string().default('unknown'),
});
export type AIPersistenceDryRunReport = z.infer<typeof AIPersistenceDryRunReportSchema>;

// ─── Options du dry run ───────────────────────────────────────────────────────

export interface AIDryRunOptions {
  /**
   * Identifiant de l'acteur déclenchant le dry run.
   * Requis pour l'audit trail (même en dry run).
   */
  actor_id: string;
  /**
   * dryRun est TOUJOURS true dans ce module — ce champ est ignoré
   * mais présent pour rendre l'intent explicite.
   */
  dryRun?: true;
  /**
   * enabled=true active la simulation dans persistPreparedCriteriaBatch.
   * La feature flag est passée à true pour déclencher le code de dry run.
   * Elle ne provoque aucune écriture réelle grâce à dryRun=true.
   */
  enabled?: boolean;
}

// ─── Mock DB client sécurisé ──────────────────────────────────────────────────

/**
 * Client DB ne faisant jamais d'appel réseau.
 * Si appelé malgré dryRun=true, il lance une erreur explicite.
 * Garantit qu'aucune écriture DB n'est possible via cet adapter.
 */
const SAFETY_MOCK_DB_CLIENT: ICriteriaDbClient = {
  insert: () => {
    throw new Error(
      '[ONB-2d] SAFETY: tentative d\'appel DB réel depuis le dry run adapter. ' +
      'Cela ne devrait jamais arriver avec dryRun=true.',
    );
  },
  upsert: () => {
    throw new Error(
      '[ONB-2d] SAFETY: tentative d\'appel DB réel depuis le dry run adapter. ' +
      'Cela ne devrait jamais arriver avec dryRun=true.',
    );
  },
  findExistingKeys: () => {
    throw new Error(
      '[ONB-2d] SAFETY: tentative d\'appel DB réel depuis le dry run adapter. ' +
      'Cela ne devrait jamais arriver avec dryRun=true.',
    );
  },
};

// ─── Conversion AIMergedCritere → ReviewableCritere ──────────────────────────

/**
 * Convertit un AIMergedCritere en ReviewableCritere compatible avec
 * preparePersistenceBatch().
 *
 * Points clés :
 *   - ai_inclusions_initial ← ai_inclusions_merged (enrichi IA)
 *   - ai_exclusions_initial ← ai_exclusions_merged (enrichi IA, sécurisé)
 *   - review_status ← 'approved' (seuls les merged approved arrivent ici)
 *   - audit_trail ← entrée synthétique depuis merge_audit
 *   - active reste false, requires_human_validation reste true
 */
function adaptMergedCritere(c: AIMergedCritere): ReviewableCritere {
  return {
    // Champs ProposedCritere préservés
    id:                        c.id,
    label:                     c.label,
    radar_type:                c.radar_type,
    domain_category:           c.domain_category,
    base_keywords:             [...c.base_keywords],
    // Injection des inclusions/exclusions fusionnées IA
    ai_inclusions_initial:     [...c.ai_inclusions_merged],
    ai_exclusions_initial:     [...c.ai_exclusions_merged],
    // Casting sécurisé : AIMergedCritere hérite de ProposedCritere dont les
    // prestations_* sont typées Prestation[] — la conversion est sûre.
    prestations_recherchees:   [...c.prestations_recherchees] as Prestation[],
    prestations_exclues:       [...c.prestations_exclues]     as Prestation[],
    zones_geographiques:       [...c.zones_geographiques],
    favorite_organizations:    [...c.favorite_organizations],
    precision_mode:            c.precision_mode,
    // source_trace de l'adapter est Record<string, unknown> — on le cast
    // vers L3SourceTrace (Record<string, L3SourceTraceEntry>).
    // Les entrées sont conformes car héritées du ProposedCritere original.
    source_trace:              c.source_trace as L3SourceTrace,
    requires_human_validation: true,
    active:                    false,
    // Statut de revue : approved (seuls les critères fusionnés passent ici)
    review_status:             'approved',
    // Audit trail synthétique depuis merge_audit
    audit_trail: [
      {
        review_action: 'approve_criterion' as const,
        reviewed_by:   c.merge_audit.actor_id ?? 'ai_merge',
        reviewed_at:   c.merge_audit.merged_at,
        review_note:   `ONB-2d dry run — ${c.merge_audit.added_inclusions.length} inclusions IA + ${c.merge_audit.added_exclusions.length} exclusions IA fusionnées`,
      },
    ],
  };
}

/**
 * Convertit un AIMergedCriteriaSet complet en ReviewableCriteriaSet.
 * Seuls les critères ayant des suggestions fusionnées (ou des inclusions initiales)
 * sont inclus — les critères vides (aucun base_keyword) sont ignorés.
 *
 * @param merged   AIMergedCriteriaSet (sortie ONB-2c)
 * @returns        ReviewableCriteriaSet compatible preparePersistenceBatch()
 */
export function adaptMergedToReviewable(merged: AIMergedCriteriaSet): ReviewableCriteriaSet {
  const now = new Date().toISOString();

  const criteria: ReviewableCritere[] = merged.criteria.map(adaptMergedCritere);

  return {
    client_id:        merged.client_id,
    review_started_at: now,
    review_updated_at: now,
    review_status:    'review_complete',
    criteria,
  };
}

// ─── Dry run principal ────────────────────────────────────────────────────────

/**
 * Exécute un dry run de persistance sur un AIMergedCriteriaSet enrichi IA.
 *
 * Étapes :
 *  1. Convertit AIMergedCriteriaSet → ReviewableCriteriaSet
 *  2. Appelle preparePersistenceBatch() — aucun accès DB
 *  3. Appelle persistPreparedCriteriaBatch(dryRun=true) — aucun accès DB
 *  4. Retourne AIPersistenceDryRunReport lisible
 *
 * @param merged   AIMergedCriteriaSet (sortie ONB-2c)
 * @param options  Options dry run (actor_id requis)
 * @returns        Rapport dry run — jamais une exception non contrôlée
 */
export async function runAIDryRunPersistence(
  merged: AIMergedCriteriaSet,
  options: AIDryRunOptions,
): Promise<AIPersistenceDryRunReport> {
  const run_at  = new Date().toISOString();
  const warnings: string[] = [];

  // ── 1. Convertir en ReviewableCriteriaSet ─────────────────────────────────
  let reviewable: ReviewableCriteriaSet;
  try {
    reviewable = adaptMergedToReviewable(merged);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return AIPersistenceDryRunReportSchema.parse({
      dry_run:               true,
      prepared_count:        0,
      skipped_count:         merged.criteria.length,
      what_would_be_written: [],
      warnings:              [`Erreur conversion AIMergedCriteriaSet → ReviewableCriteriaSet : ${msg}`],
      merge_audits:          extractMergeAudits(merged),
      skipped_criteria:      [],
      run_at,
      enrichment_model:      merged.enrichment_model,
    });
  }

  // ── 2. Préparer le batch (sans accès DB) ──────────────────────────────────
  let batch: PreparedCriteriaPersistenceBatch;
  try {
    batch = preparePersistenceBatch(reviewable);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return AIPersistenceDryRunReportSchema.parse({
      dry_run:               true,
      prepared_count:        0,
      skipped_count:         merged.criteria.length,
      what_would_be_written: [],
      warnings:              [`Erreur préparation batch : ${msg}`],
      merge_audits:          extractMergeAudits(merged),
      skipped_criteria:      [],
      run_at,
      enrichment_model:      merged.enrichment_model,
    });
  }

  warnings.push(...batch.warnings);

  // Avertissement si aucun critère persistable
  if (batch.rows.length === 0) {
    warnings.push(
      'ONB-2d : aucun critère enrichi IA persistable trouvé — ' +
      'vérifiez que des suggestions approved existent dans le set fusionné.',
    );
  }

  // ── 3. Dry run via persistPreparedCriteriaBatch (jamais d'accès DB) ───────
  let persistResult: PersistResult;
  try {
    persistResult = await persistPreparedCriteriaBatch(
      batch,
      {
        dryRun:           true,
        enabled:          options.enabled ?? true,
        actor_id:         options.actor_id,
        source:           'onboarding',
        conflictStrategy: 'skip_existing',
      },
      SAFETY_MOCK_DB_CLIENT,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Erreur dry run persist : ${msg}`);
    persistResult = {
      ok: false, dry_run: true, enabled: false,
      inserted_count: 0, skipped_count: 0, upserted_count: 0,
      errors: [], warnings: [msg], what_would_be_written: [],
      detected_duplicates: [],
      persisted_at: new Date().toISOString(),
      actor_id: options.actor_id, source: 'onboarding',
    };
  }

  warnings.push(...(persistResult.warnings ?? []));

  // ── 4. Produire le rapport ────────────────────────────────────────────────
  const skipped_criteria = batch.skipped.map(s => ({
    criterion_id: s.criterion_id,
    label:        s.label,
    reason:       s.reason,
  }));

  return AIPersistenceDryRunReportSchema.parse({
    dry_run:               true,
    prepared_count:        batch.rows.length,
    skipped_count:         batch.skipped.length,
    what_would_be_written: persistResult.what_would_be_written ?? [],
    warnings,
    merge_audits:          extractMergeAudits(merged),
    skipped_criteria,
    run_at,
    enrichment_model:      merged.enrichment_model,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractMergeAudits(merged: AIMergedCriteriaSet): Record<string, unknown>[] {
  return merged.criteria.map(c => ({
    critere_id:         c.merge_audit.critere_id,
    added_inclusions:   c.merge_audit.added_inclusions,
    added_exclusions:   c.merge_audit.added_exclusions,
    ignored_rejected:   c.merge_audit.ignored_rejected,
    ignored_pending:    c.merge_audit.ignored_pending,
    deduplicated:       c.merge_audit.deduplicated,
    ignored_unsafe:     c.merge_audit.ignored_unsafe,
    ignored_ambiguous:  c.merge_audit.ignored_ambiguous,
    actor_id:           c.merge_audit.actor_id,
    merged_at:          c.merge_audit.merged_at,
  } satisfies MergeAudit));
}

