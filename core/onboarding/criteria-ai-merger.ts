/**
 * ONB-2c — Fusion contrôlée des suggestions IA approuvées dans les critères L3
 *
 * Ce module fusionne les suggestions IA validées humainement (ONB-2b)
 * dans les champs ai_inclusions_merged / ai_exclusions_merged des critères.
 *
 * INTERDIT :
 *   - Fusionner les suggestions rejected ou pending
 *   - Modifier base_keywords, radar_type, domain_category
 *   - Passer active à true
 *   - Supprimer les inclusions/exclusions existantes
 *   - Écrire en base de données
 *   - Appeler l'IA
 *   - Impacter radar-bc-bot.js
 *
 * AUTORISÉ :
 *   - Fusionner approved_inclusions dans ai_inclusions_initial → ai_inclusions_merged
 *   - Fusionner approved_exclusions (safe) dans ai_exclusions_initial → ai_exclusions_merged
 *   - Dédupliquer proprement (ordre stable : initial d'abord, IA ensuite)
 *   - Re-valider chaque exclusion via validateExclusionSafe() avant fusion
 *   - Produire un merge_audit complet par critère
 */

import { validateExclusionSafe }          from './criteria-ai-enricher';
import { validateInclusionContextualized } from './inclusion-ambiguity-guard';

import {
  type AIReviewedCriteriaSet,
  type AIReviewedCritere,
} from './criteria-ai-review.schema';

import {
  type AIMergedCriteriaSet,
  type AIMergedCritere,
  type MergeAudit,
} from './criteria-ai-merge.schema';

// ─── Options de fusion ────────────────────────────────────────────────────────

export interface MergeOptions {
  /** Acteur déclenchant la fusion (pour audit) */
  actor_id?: string;
}

// ─── Fusion principale ────────────────────────────────────────────────────────

/**
 * Fusionne les suggestions IA approved dans les critères L3.
 *
 * @param reviewedSet  AIReviewedCriteriaSet issu de ONB-2b
 * @param options      Options de fusion (actor_id)
 * @returns            AIMergedCriteriaSet — jamais de throw non contrôlé
 */
export function mergeApprovedSuggestions(
  reviewedSet: AIReviewedCriteriaSet,
  options: MergeOptions = {},
): AIMergedCriteriaSet {
  const now      = new Date().toISOString();
  const warnings: string[] = [];
  const criteria: AIMergedCritere[] = [];

  for (const critere of reviewedSet.criteria) {
    try {
      criteria.push(mergeCritere(critere, options, now));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Erreur fusion critère ${critere.id} : ${msg}`);
    }
  }

  return {
    client_id:                 reviewedSet.client_id,
    source:                    'ai_review_merge',
    merged_at:                 now,
    criteria,
    warnings,
    enrichment_model:          reviewedSet.enrichment_model,
    requires_human_validation: true,
    active:                    false,
  };
}

// ─── Fusion d'un critère ──────────────────────────────────────────────────────

function mergeCritere(
  critere: AIReviewedCritere,
  options: MergeOptions,
  now: string,
): AIMergedCritere {
  const audit: MergeAudit = {
    critere_id:       critere.id,
    added_inclusions: [],
    added_exclusions: [],
    ignored_rejected: [],
    ignored_pending:  [],
    deduplicated:     [],
    ignored_unsafe:   [],
    ignored_ambiguous: [],
    actor_id:         options.actor_id,
    merged_at:        now,
  };

  // ── Collecter les inclusions rejected / pending pour l'audit ──────────────
  for (const r of critere.reviewed_inclusions) {
    if (r.status === 'rejected') audit.ignored_rejected.push(r.original);
    else if (r.status === 'pending') audit.ignored_pending.push(r.original);
  }

  // ── Collecter les exclusions rejected / pending pour l'audit ──────────────
  for (const r of critere.reviewed_exclusions) {
    if (r.status === 'rejected') audit.ignored_rejected.push(r.original);
    else if (r.status === 'pending') audit.ignored_pending.push(r.original);
  }

  // ── Fusionner les inclusions (approved + edited) ──────────────────────────
  const ai_inclusions_merged = mergeInclusions(
    critere.ai_inclusions_initial,
    critere.approved_inclusions,
    critere.domain_category,
    audit,
  );

  // ── Fusionner les exclusions (approved + edited, re-validées) ─────────────
  const ai_exclusions_merged = mergeExclusions(
    critere.ai_exclusions_initial,
    critere.approved_exclusions,
    audit,
  );

  return {
    // Champs originaux préservés
    id:                        critere.id,
    label:                     critere.label,
    radar_type:                critere.radar_type,
    domain_category:           critere.domain_category,
    base_keywords:             [...critere.base_keywords],
    ai_inclusions_initial:     [...critere.ai_inclusions_initial],
    ai_exclusions_initial:     [...critere.ai_exclusions_initial],
    prestations_recherchees:   [...critere.prestations_recherchees],
    prestations_exclues:       [...critere.prestations_exclues],
    zones_geographiques:       [...critere.zones_geographiques],
    favorite_organizations:    [...critere.favorite_organizations],
    precision_mode:            critere.precision_mode,
    source_trace:              { ...critere.source_trace },
    // Champs fusionnés
    ai_inclusions_merged,
    ai_exclusions_merged,
    merge_audit:               audit,
    requires_human_validation: true,
    active:                    false,
  };
}

// ─── Fusion inclusions ────────────────────────────────────────────────────────

function mergeInclusions(
  initial:         string[],
  approved:        string[],
  domain_category: string,
  audit:           MergeAudit,
): string[] {
  // Base : inclusions initiales — la garde s'applique aussi aux initiales
  const seen   = new Set<string>();
  const result: string[] = [];

  for (const inc of initial) {
    const guard = validateInclusionContextualized(inc, domain_category);
    if (!guard.valid) {
      audit.ignored_ambiguous.push(inc);
    } else {
      seen.add(normalise(inc));
      result.push(inc);
    }
  }

  // Inclusions approuvées par l'admin — re-validées par la garde
  for (const inc of approved) {
    const guard = validateInclusionContextualized(inc, domain_category);
    if (!guard.valid) {
      audit.ignored_ambiguous.push(inc);
      continue;
    }
    const key = normalise(inc);
    if (seen.has(key)) {
      audit.deduplicated.push(inc);
    } else {
      seen.add(key);
      result.push(inc);
      audit.added_inclusions.push(inc);
    }
  }

  return result;
}

// ─── Fusion exclusions ────────────────────────────────────────────────────────

function mergeExclusions(
  initial:   string[],
  approved:  string[],
  audit:     MergeAudit,
): string[] {
  const seen  = new Set<string>(initial.map(normalise));
  const result: string[] = [...initial];

  for (const ex of approved) {
    // Garde finale : re-valider même si approved par l'admin
    if (!validateExclusionSafe(ex)) {
      audit.ignored_unsafe.push(ex);
      continue;
    }

    const key = normalise(ex);
    if (seen.has(key)) {
      audit.deduplicated.push(ex);
    } else {
      seen.add(key);
      result.push(ex);
      audit.added_exclusions.push(ex);
    }
  }

  return result;
}

// ─── Normalisation pour déduplication ────────────────────────────────────────

/** Normalise une chaîne pour la comparaison (minuscule, espaces réduits) */
function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ─── Helpers de lecture ───────────────────────────────────────────────────────

/** Critères pour lesquels au moins une inclusion a été fusionnée */
export function getCriteriaWithAddedInclusions(set: AIMergedCriteriaSet): AIMergedCritere[] {
  return set.criteria.filter(c => c.merge_audit.added_inclusions.length > 0);
}

/** Critères pour lesquels au moins une exclusion a été fusionnée */
export function getCriteriaWithAddedExclusions(set: AIMergedCriteriaSet): AIMergedCritere[] {
  return set.criteria.filter(c => c.merge_audit.added_exclusions.length > 0);
}

/** Critères avec des exclusions unsafe rejetées lors de la fusion */
export function getCriteriaWithUnsafeExclusions(set: AIMergedCriteriaSet): AIMergedCritere[] {
  return set.criteria.filter(c => c.merge_audit.ignored_unsafe.length > 0);
}

/** Rapport de fusion global (toutes les entrées d'audit) */
export function getMergeSummary(set: AIMergedCriteriaSet): {
  total_criteria:       number;
  total_added_inc:      number;
  total_added_exc:      number;
  total_deduplicated:   number;
  total_ignored_unsafe: number;
  total_ignored_rejected: number;
  total_ignored_pending:  number;
} {
  return set.criteria.reduce(
    (acc, c) => ({
      total_criteria:         acc.total_criteria + 1,
      total_added_inc:        acc.total_added_inc        + c.merge_audit.added_inclusions.length,
      total_added_exc:        acc.total_added_exc        + c.merge_audit.added_exclusions.length,
      total_deduplicated:     acc.total_deduplicated     + c.merge_audit.deduplicated.length,
      total_ignored_unsafe:   acc.total_ignored_unsafe   + c.merge_audit.ignored_unsafe.length,
      total_ignored_rejected: acc.total_ignored_rejected + c.merge_audit.ignored_rejected.length,
      total_ignored_pending:  acc.total_ignored_pending  + c.merge_audit.ignored_pending.length,
    }),
    {
      total_criteria: 0, total_added_inc: 0, total_added_exc: 0,
      total_deduplicated: 0, total_ignored_unsafe: 0,
      total_ignored_rejected: 0, total_ignored_pending: 0,
    },
  );
}
