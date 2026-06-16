/**
 * ONB-1f — Workflow de Persistance des Critères Approuvés
 *
 * Point d'entrée contrôlé : prend un ReviewableCriteriaSet post-revue,
 * prépare le batch et appelle le repository Supabase.
 *
 * Règles absolues :
 *   - dryRun=true par défaut — aucune écriture sans accord explicite
 *   - enabled=false par défaut — feature flag obligatoire
 *   - actor_id obligatoire pour toute écriture réelle
 *   - Pas de modification radar-bc-bot.js
 *   - Pas de branchement au matching
 *   - Pas d'appel IA
 *   - Pas de suppression d'anciens critères
 *   - Aucun throw non contrôlé
 *   - Repository injecté — aucun import Supabase global
 */

import { z } from 'zod';

import {
  type ReviewableCriteriaSet,
  ReviewableCriteriaSetSchema,
} from './l3-review.schema';

import { getApprovedCriteria } from './criteria-reviewer';
import { preparePersistenceBatch } from './criteria-persistence-adapter';
import { validateCritereLabel } from './criteria-label-guard';

import {
  type PersistResult,
  ConflictStrategySchema,
} from './criteria-repository.schema';

// ─── Types injectables ────────────────────────────────────────────────────────

/**
 * Signature de la fonction de persistance injectée.
 * Compatible avec persistPreparedCriteriaBatch() du repository.
 */
export type PersistFn = (
  batch: ReturnType<typeof preparePersistenceBatch>,
  options: {
    dryRun: boolean;
    enabled: boolean;
    conflictStrategy: 'skip_existing' | 'upsert_same_key';
    actor_id: string;
    source: 'onboarding';
  },
) => Promise<PersistResult>;

/**
 * Dépendances injectées dans le workflow.
 * Permet le mock complet en tests sans Supabase.
 */
export interface WorkflowDeps {
  /** Fonction de persistance — repository ou mock */
  persistBatch: PersistFn;
}

// ─── Input ────────────────────────────────────────────────────────────────────

export const WorkflowInputSchema = z.object({
  /** Session de revue humaine — doit être post-initReview() */
  review_set: ReviewableCriteriaSetSchema,

  options: z.object({
    /**
     * Si true : simulation sans écriture DB.
     * Par défaut true — comportement protecteur obligatoire.
     */
    dryRun: z.boolean().default(true),

    /**
     * Feature flag — si false : aucune écriture.
     * Par défaut false.
     */
    enabled: z.boolean().default(false),

    /** Stratégie de gestion des doublons */
    conflictStrategy: ConflictStrategySchema.default('skip_existing'),

    /**
     * Identifiant de l'acteur déclenchant l'écriture réelle.
     * Obligatoire si dryRun=false et enabled=true.
     */
    actor_id: z.string().optional(),

    /** Source de l'opération */
    source: z.enum(['admin', 'client_validation']),
  }),
});
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

// ─── Output ───────────────────────────────────────────────────────────────────

export const WorkflowReportSchema = z.object({
  /** Critères approved dans le set source */
  approved_count: z.number().int().min(0),

  /** Critères non-approved (rejected + pending + edited) */
  skipped_count: z.number().int().min(0),

  /** Rows qui seraient insérées (dry run ou préparation) */
  would_insert_count: z.number().int().min(0),

  /** Rows effectivement insérées */
  inserted_count: z.number().int().min(0),

  /** Rows mises à jour (upsert) */
  upserted_count: z.number().int().min(0),

  /** Erreurs DB non-bloquantes */
  errors: z.array(z.object({
    row_valeur:    z.string(),
    row_client_id: z.string(),
    message:       z.string(),
    code:          z.string().optional(),
  })).default([]),

  /** Avertissements non bloquants */
  warnings: z.array(z.string()).default([]),

  /** Mode dry run actif */
  dry_run: z.boolean(),

  /** Feature flag état */
  enabled: z.boolean(),

  /** Succès global */
  ok: z.boolean(),
});
export type WorkflowReport = z.infer<typeof WorkflowReportSchema>;

// ─── Helpers internes ─────────────────────────────────────────────────────────

function makeReport(patch: Partial<WorkflowReport>, base: Partial<WorkflowReport> = {}): WorkflowReport {
  return WorkflowReportSchema.parse({
    approved_count:    0,
    skipped_count:     0,
    would_insert_count: 0,
    inserted_count:    0,
    upserted_count:    0,
    errors:            [],
    warnings:          [],
    dry_run:           true,
    enabled:           false,
    ok:                true,
    ...base,
    ...patch,
  });
}

// ─── Workflow principal ────────────────────────────────────────────────────────

/**
 * Workflow de persistance contrôlé des critères approuvés.
 *
 * Étapes :
 *   1. Valide le review_set et les options (Zod)
 *   2. Extrait les critères approved via getApprovedCriteria()
 *   3. Prépare le batch via preparePersistenceBatch()
 *   4. Si écriture autorisée : appelle persistBatch()
 *   5. Retourne un rapport lisible
 *
 * @param input   review_set + options
 * @param deps    Repository ou mock injecté
 * @returns       WorkflowReport — jamais une exception non contrôlée
 */
export async function runCriteriaPersistenceWorkflow(
  input: WorkflowInput,
  deps: WorkflowDeps,
): Promise<WorkflowReport> {

  // ── 1. Validation Zod de l'input ──────────────────────────────────────────
  const parsed = WorkflowInputSchema.safeParse(input);
  if (!parsed.success) {
    return makeReport({
      ok:       false,
      warnings: [`Input invalide : ${parsed.error.message}`],
    });
  }

  const { review_set, options } = parsed.data;
  const baseReport = { dry_run: options.dryRun, enabled: options.enabled };

  // ── 2. Guard : écriture réelle sans actor_id ───────────────────────────────
  if (!options.dryRun && options.enabled && !options.actor_id) {
    return makeReport(
      {
        ok:       false,
        warnings: ['actor_id obligatoire pour une écriture réelle (dryRun=false, enabled=true).'],
      },
      baseReport,
    );
  }

  // ── 3. Extraire les critères approved ─────────────────────────────────────
  const approved = getApprovedCriteria(review_set);
  const totalCriteria = review_set.criteria.length;
  const skippedCount  = totalCriteria - approved.length;

  // ── 4. Aucun critère approved ─────────────────────────────────────────────
  if (approved.length === 0) {
    return makeReport(
      {
        approved_count: 0,
        skipped_count:  skippedCount,
        warnings:       ['Aucun critère approved dans le set — aucune persistance possible.'],
      },
      baseReport,
    );
  }

  // ── 4b. Guard label générique : bloquer avant persistence ────────────────
  const blockedLabels: string[] = [];
  const warnLabels:    string[] = [];
  for (const c of approved) {
    const guard = validateCritereLabel(c.label ?? c.id);
    if (guard.level === 'block') blockedLabels.push(c.label ?? c.id);
    if (guard.level === 'warn')  warnLabels.push(c.label ?? c.id);
  }
  if (blockedLabels.length > 0) {
    return makeReport(
      {
        ok:            false,
        approved_count: approved.length,
        skipped_count:  skippedCount,
        warnings: [
          `[label-guard:block] Critères refusés avant persistence : ${blockedLabels.join(', ')}. ` +
          'Ces labels sont trop génériques — qualifiez-les avant de re-soumettre.',
        ],
      },
      baseReport,
    );
  }
  const labelWarnings = warnLabels.length > 0
    ? [`[label-guard:warn] Labels ambigus détectés : ${warnLabels.join(', ')} — vérifiez qu'ils sont intentionnels.`]
    : [];

  // ── 5. Préparer le batch ───────────────────────────────────────────────────
  const batch = preparePersistenceBatch(review_set);
  const wouldInsertCount = batch.rows.length;

  // ── 6. Dry run ou feature flag off — aucun appel DB ──────────────────────
  if (options.dryRun || !options.enabled) {
    const warnings: string[] = [...labelWarnings, ...batch.warnings];
    if (options.dryRun) {
      warnings.push(`Dry run — ${wouldInsertCount} row(s) seraient écrites. Aucune écriture réelle.`);
    } else {
      warnings.push('Feature flag enabled=false — aucune écriture effectuée.');
    }

    return makeReport(
      {
        approved_count:     approved.length,
        skipped_count:      skippedCount,
        would_insert_count: wouldInsertCount,
        warnings,
      },
      baseReport,
    );
  }

  // ── 7. Écriture réelle ────────────────────────────────────────────────────
  // actor_id est garanti présent ici (guard step 2)
  let persistResult: PersistResult;
  try {
    persistResult = await deps.persistBatch(batch, {
      dryRun:           false,
      enabled:          true,
      conflictStrategy: options.conflictStrategy,
      actor_id:         options.actor_id!,
      source:           'onboarding',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return makeReport(
      {
        ok:                false,
        approved_count:    approved.length,
        skipped_count:     skippedCount,
        would_insert_count: wouldInsertCount,
        warnings:          [`Erreur inattendue du repository : ${message}`],
      },
      baseReport,
    );
  }

  // ── 8. Mapper le résultat repository → rapport workflow ───────────────────
  return makeReport(
    {
      ok:                 persistResult.ok,
      approved_count:     approved.length,
      skipped_count:      skippedCount,
      would_insert_count: wouldInsertCount,
      inserted_count:     persistResult.inserted_count,
      upserted_count:     persistResult.upserted_count,
      errors:             persistResult.errors,
      warnings:           [...labelWarnings, ...persistResult.warnings],
    },
    baseReport,
  );
}
