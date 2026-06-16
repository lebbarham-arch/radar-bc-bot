/**
 * ONB-2b — Revue humaine des suggestions IA
 *
 * Ce module permet à un admin humain de valider, rejeter ou éditer
 * les suggestions produites par ONB-2 (criteria-ai-enricher.ts).
 *
 * INTERDIT :
 *   - Appliquer une suggestion IA automatiquement
 *   - Modifier base_keywords, radar_type, domain_category
 *   - Modifier les critères actifs
 *   - Écrire en base de données
 *   - Appeler l'IA
 *
 * AUTORISÉ :
 *   - approve / reject / edit des suggestions IA (inclusions + exclusions)
 *   - Revalider les exclusions éditées via validateExclusionSafe()
 *   - Produire un AIReviewedCriteriaSet auditée, prête pour ONB-2c
 */

import { validateExclusionSafe } from './criteria-ai-enricher';
import {
  type AIEnrichedCriteriaSet,
  type AIEnrichedCritere,
} from './criteria-ai-enricher.schema';

import {
  type AIReviewedCritere,
  type AIReviewedCriteriaSet,
  type AIReviewCommand,
  type AIReviewResult,
  type AuditEntry,
  type ReviewedSuggestion,
} from './criteria-ai-review.schema';

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Initialise un AIReviewedCriteriaSet depuis un AIEnrichedCriteriaSet.
 * Toutes les suggestions sont en statut 'pending' au départ.
 * Aucune écriture DB, aucun appel IA.
 */
export function initReviewSet(enriched: AIEnrichedCriteriaSet): AIReviewedCriteriaSet {
  const criteria: AIReviewedCritere[] = enriched.criteria.map(c => initReviewedCritere(c));

  return {
    client_id:                 enriched.client_id,
    source:                    'ai_human_review',
    reviewed_at:               new Date().toISOString(),
    criteria,
    warnings:                  [...enriched.warnings],
    enrichment_model:          enriched.enrichment_model,
    requires_human_validation: true,
    active:                    false,
  };
}

function initReviewedCritere(c: AIEnrichedCritere): AIReviewedCritere {
  const sug = c.ai_suggestions;

  const reviewed_inclusions: ReviewedSuggestion[] = sug.suggested_inclusions.map(s => ({
    original: s, status: 'pending', final: s, reason: '',
  }));

  const reviewed_exclusions: ReviewedSuggestion[] = sug.suggested_exclusions.map(s => ({
    original: s, status: 'pending', final: s, reason: '',
  }));

  return {
    id:                        c.id,
    label:                     c.label,
    radar_type:                c.radar_type,
    domain_category:           c.domain_category,
    base_keywords:             [...c.base_keywords],
    ai_inclusions_initial:     [...c.ai_inclusions_initial],
    ai_exclusions_initial:     [...c.ai_exclusions_initial],
    prestations_recherchees:   [...c.prestations_recherchees],
    prestations_exclues:       [...c.prestations_exclues],
    zones_geographiques:       [...(c.zones_geographiques ?? [])],
    favorite_organizations:    [...(c.favorite_organizations ?? [])],
    precision_mode:            c.precision_mode,
    source_trace:              { ...c.source_trace },
    requires_human_validation: true,
    active:                    false,
    ai_suggestions_original: {
      suggested_inclusions:        [...sug.suggested_inclusions],
      suggested_exclusions:        [...sug.suggested_exclusions],
      suggested_variants:          [...sug.suggested_variants],
      suggested_positive_terms:    [...sug.suggested_positive_terms],
      suggested_negative_contexts: [...sug.suggested_negative_contexts],
      review_notes:                sug.review_notes,
      confidence:                  sug.confidence,
    },
    reviewed_inclusions,
    reviewed_exclusions,
    approved_inclusions:  [],
    approved_exclusions:  [],
    rejected_inclusions:  [],
    rejected_exclusions:  [],
    audit_trail:          [],
    review_status:        'pending',
  };
}

// ─── Actions individuelles ────────────────────────────────────────────────────

/**
 * Applique une commande de revue sur un critère.
 * Retourne un nouveau critère (immuable) ou une erreur.
 */
export function applyReviewCommand(
  critere: AIReviewedCritere,
  cmd: AIReviewCommand,
): AIReviewResult {
  switch (cmd.action) {
    case 'approve_ai_inclusion':
      return approveInclusion(critere, cmd);
    case 'reject_ai_inclusion':
      return rejectInclusion(critere, cmd);
    case 'edit_ai_inclusion':
      return editInclusion(critere, cmd);
    case 'approve_ai_exclusion':
      return approveExclusion(critere, cmd);
    case 'reject_ai_exclusion':
      return rejectExclusion(critere, cmd);
    case 'edit_ai_exclusion':
      return editExclusion(critere, cmd);
    case 'approve_all_safe_suggestions':
      return approveAllSafe(critere, cmd);
    case 'reject_all_ai_suggestions':
      return rejectAll(critere, cmd);
    default: {
      const _exhaustive: never = cmd.action;
      return { ok: false, error: `Action inconnue : ${_exhaustive}` };
    }
  }
}

// ─── approve_ai_inclusion ─────────────────────────────────────────────────────

function approveInclusion(critere: AIReviewedCritere, cmd: AIReviewCommand): AIReviewResult {
  const value = cmd.original_value ?? '';
  if (!value) return { ok: false, error: 'original_value requis pour approve_ai_inclusion' };

  const entry = makeAuditEntry(critere.id, cmd, 'inclusion', value, value);
  const updated = updateInclusion(critere, value, { status: 'approved', final: value, reason: '' });
  const next = recomputeLists({ ...updated, audit_trail: [...updated.audit_trail, entry] });

  return { ok: true, critere: next, entry };
}

// ─── reject_ai_inclusion ──────────────────────────────────────────────────────

function rejectInclusion(critere: AIReviewedCritere, cmd: AIReviewCommand): AIReviewResult {
  const value = cmd.original_value ?? '';
  if (!value) return { ok: false, error: 'original_value requis pour reject_ai_inclusion' };

  const entry  = makeAuditEntry(critere.id, cmd, 'inclusion', value, '');
  const updated = updateInclusion(critere, value, { status: 'rejected', final: '', reason: cmd.reason });
  const next   = recomputeLists({ ...updated, audit_trail: [...updated.audit_trail, entry] });

  return { ok: true, critere: next, entry };
}

// ─── edit_ai_inclusion ────────────────────────────────────────────────────────

function editInclusion(critere: AIReviewedCritere, cmd: AIReviewCommand): AIReviewResult {
  const value    = cmd.original_value ?? '';
  const newValue = cmd.new_value ?? '';
  if (!value)    return { ok: false, error: 'original_value requis pour edit_ai_inclusion' };
  if (!newValue) return { ok: false, error: 'new_value requis pour edit_ai_inclusion' };

  const entry  = makeAuditEntry(critere.id, cmd, 'inclusion', value, newValue);
  const updated = updateInclusion(critere, value, { status: 'edited', final: newValue, reason: cmd.reason });
  const next   = recomputeLists({ ...updated, audit_trail: [...updated.audit_trail, entry] });

  return { ok: true, critere: next, entry };
}

// ─── approve_ai_exclusion ─────────────────────────────────────────────────────

function approveExclusion(critere: AIReviewedCritere, cmd: AIReviewCommand): AIReviewResult {
  const value = cmd.original_value ?? '';
  if (!value) return { ok: false, error: 'original_value requis pour approve_ai_exclusion' };

  if (!validateExclusionSafe(value)) {
    return {
      ok:    false,
      error: `Exclusion rejetée — lexicale brute ou trop courte : "${value}". Une exclusion valide doit avoir ≥ 3 mots.`,
    };
  }

  const entry  = makeAuditEntry(critere.id, cmd, 'exclusion', value, value);
  const updated = updateExclusion(critere, value, { status: 'approved', final: value, reason: '' });
  const next   = recomputeLists({ ...updated, audit_trail: [...updated.audit_trail, entry] });

  return { ok: true, critere: next, entry };
}

// ─── reject_ai_exclusion ──────────────────────────────────────────────────────

function rejectExclusion(critere: AIReviewedCritere, cmd: AIReviewCommand): AIReviewResult {
  const value = cmd.original_value ?? '';
  if (!value) return { ok: false, error: 'original_value requis pour reject_ai_exclusion' };

  const entry  = makeAuditEntry(critere.id, cmd, 'exclusion', value, '');
  const updated = updateExclusion(critere, value, { status: 'rejected', final: '', reason: cmd.reason });
  const next   = recomputeLists({ ...updated, audit_trail: [...updated.audit_trail, entry] });

  return { ok: true, critere: next, entry };
}

// ─── edit_ai_exclusion ────────────────────────────────────────────────────────

function editExclusion(critere: AIReviewedCritere, cmd: AIReviewCommand): AIReviewResult {
  const value    = cmd.original_value ?? '';
  const newValue = cmd.new_value ?? '';
  if (!value)    return { ok: false, error: 'original_value requis pour edit_ai_exclusion' };
  if (!newValue) return { ok: false, error: 'new_value requis pour edit_ai_exclusion' };

  // L'exclusion éditée doit repasser par validateExclusionSafe()
  if (!validateExclusionSafe(newValue)) {
    return {
      ok:    false,
      error: `Exclusion éditée rejetée — lexicale brute ou trop courte : "${newValue}". Une exclusion valide doit avoir ≥ 3 mots.`,
    };
  }

  const entry  = makeAuditEntry(critere.id, cmd, 'exclusion', value, newValue);
  const updated = updateExclusion(critere, value, { status: 'edited', final: newValue, reason: cmd.reason });
  const next   = recomputeLists({ ...updated, audit_trail: [...updated.audit_trail, entry] });

  return { ok: true, critere: next, entry };
}

// ─── approve_all_safe_suggestions ────────────────────────────────────────────

/**
 * Approuve toutes les suggestions IA encore en pending.
 * Les exclusions dangereuses (< 3 mots, mots bruts interdits) sont ignorées silencieusement.
 */
function approveAllSafe(critere: AIReviewedCritere, cmd: AIReviewCommand): AIReviewResult {
  const now = new Date().toISOString();
  const newAudit: AuditEntry[] = [...critere.audit_trail];

  // Approuver les inclusions pending
  const reviewed_inclusions: ReviewedSuggestion[] = critere.reviewed_inclusions.map(r => {
    if (r.status !== 'pending') return r;
    newAudit.push({
      critere_id:      critere.id,
      action:          'approve_all_safe_suggestions',
      original_value:  r.original,
      final_value:     r.original,
      suggestion_type: 'inclusion',
      reviewed_by:     cmd.reviewed_by,
      reviewed_at:     now,
      reason:          '',
    });
    return { ...r, status: 'approved' as const, final: r.original };
  });

  // Approuver les exclusions safe pending (ignorer les dangereuses)
  const reviewed_exclusions: ReviewedSuggestion[] = critere.reviewed_exclusions.map(r => {
    if (r.status !== 'pending') return r;
    if (!validateExclusionSafe(r.original)) return r; // Ignorer silencieusement
    newAudit.push({
      critere_id:      critere.id,
      action:          'approve_all_safe_suggestions',
      original_value:  r.original,
      final_value:     r.original,
      suggestion_type: 'exclusion',
      reviewed_by:     cmd.reviewed_by,
      reviewed_at:     now,
      reason:          '',
    });
    return { ...r, status: 'approved' as const, final: r.original };
  });

  const next = recomputeLists({
    ...critere,
    reviewed_inclusions,
    reviewed_exclusions,
    audit_trail: newAudit,
  });

  const entry: AuditEntry = {
    critere_id:      critere.id,
    action:          'approve_all_safe_suggestions',
    original_value:  '',
    final_value:     '',
    suggestion_type: 'inclusion',
    reviewed_by:     cmd.reviewed_by,
    reviewed_at:     now,
    reason:          '',
  };

  return { ok: true, critere: next, entry };
}

// ─── reject_all_ai_suggestions ───────────────────────────────────────────────

function rejectAll(critere: AIReviewedCritere, cmd: AIReviewCommand): AIReviewResult {
  const now = new Date().toISOString();
  const newAudit: AuditEntry[] = [...critere.audit_trail];

  const reject = (type: 'inclusion' | 'exclusion') =>
    (r: ReviewedSuggestion): ReviewedSuggestion => {
      if (r.status !== 'pending') return r;
      newAudit.push({
        critere_id:      critere.id,
        action:          'reject_all_ai_suggestions',
        original_value:  r.original,
        final_value:     '',
        suggestion_type: type,
        reviewed_by:     cmd.reviewed_by,
        reviewed_at:     now,
        reason:          cmd.reason,
      });
      return { ...r, status: 'rejected' as const, final: '', reason: cmd.reason };
    };

  const next = recomputeLists({
    ...critere,
    reviewed_inclusions: critere.reviewed_inclusions.map(reject('inclusion')),
    reviewed_exclusions: critere.reviewed_exclusions.map(reject('exclusion')),
    audit_trail:         newAudit,
  });

  const entry: AuditEntry = {
    critere_id:      critere.id,
    action:          'reject_all_ai_suggestions',
    original_value:  '',
    final_value:     '',
    suggestion_type: 'inclusion',
    reviewed_by:     cmd.reviewed_by,
    reviewed_at:     now,
    reason:          cmd.reason,
  };

  return { ok: true, critere: next, entry };
}

// ─── Helpers internes ─────────────────────────────────────────────────────────

function updateInclusion(
  critere: AIReviewedCritere,
  original: string,
  patch: Omit<ReviewedSuggestion, 'original'>,
): AIReviewedCritere {
  return {
    ...critere,
    reviewed_inclusions: critere.reviewed_inclusions.map(r =>
      r.original === original ? { ...r, ...patch } : r,
    ),
  };
}

function updateExclusion(
  critere: AIReviewedCritere,
  original: string,
  patch: Omit<ReviewedSuggestion, 'original'>,
): AIReviewedCritere {
  return {
    ...critere,
    reviewed_exclusions: critere.reviewed_exclusions.map(r =>
      r.original === original ? { ...r, ...patch } : r,
    ),
  };
}

/**
 * Recalcule approved_*, rejected_* et review_status à partir des reviewed_*.
 * Toujours appelé après une mutation des reviewed_*.
 */
function recomputeLists(critere: AIReviewedCritere): AIReviewedCritere {
  const approved_inclusions = critere.reviewed_inclusions
    .filter(r => r.status === 'approved' || r.status === 'edited')
    .map(r => r.final)
    .filter(Boolean);

  const rejected_inclusions = critere.reviewed_inclusions
    .filter(r => r.status === 'rejected')
    .map(r => r.original);

  const approved_exclusions = critere.reviewed_exclusions
    .filter(r => r.status === 'approved' || r.status === 'edited')
    .map(r => r.final)
    .filter(Boolean);

  const rejected_exclusions = critere.reviewed_exclusions
    .filter(r => r.status === 'rejected')
    .map(r => r.original);

  const allReviewed = [
    ...critere.reviewed_inclusions,
    ...critere.reviewed_exclusions,
  ];

  const hasPending  = allReviewed.some(r => r.status === 'pending');
  const hasReviewed = allReviewed.some(r => r.status !== 'pending');
  const review_status = allReviewed.length === 0
    ? 'complete'
    : hasPending && hasReviewed
      ? 'partial'
      : hasPending
        ? 'pending'
        : 'complete';

  return {
    ...critere,
    approved_inclusions,
    rejected_inclusions,
    approved_exclusions,
    rejected_exclusions,
    review_status,
  };
}

function makeAuditEntry(
  critere_id: string,
  cmd: AIReviewCommand,
  suggestion_type: 'inclusion' | 'exclusion',
  original_value: string,
  final_value: string,
): AuditEntry {
  return {
    critere_id,
    action:          cmd.action,
    original_value,
    final_value,
    suggestion_type,
    reviewed_by:     cmd.reviewed_by,
    reviewed_at:     new Date().toISOString(),
    reason:          cmd.reason,
  };
}

// ─── Application sur un set complet ──────────────────────────────────────────

/**
 * Applique une commande de revue sur le set entier.
 * Retourne un nouveau set (immuable) avec le critère mis à jour.
 */
export function applyReviewCommandToSet(
  set: AIReviewedCriteriaSet,
  cmd: AIReviewCommand,
): { ok: true; set: AIReviewedCriteriaSet; entry: AuditEntry } | { ok: false; error: string } {
  const critere = set.criteria.find(c => c.id === cmd.critere_id);
  if (!critere) return { ok: false, error: `Critère introuvable : ${cmd.critere_id}` };

  const result = applyReviewCommand(critere, cmd);
  if (!result.ok) return result;

  return {
    ok:    true,
    set:   {
      ...set,
      reviewed_at: new Date().toISOString(),
      criteria:    set.criteria.map(c => c.id === cmd.critere_id ? result.critere : c),
    },
    entry: result.entry,
  };
}

// ─── Helpers de lecture ───────────────────────────────────────────────────────

/** Critères dont la revue est complète (aucune suggestion en pending) */
export function getCompleteReviews(set: AIReviewedCriteriaSet): AIReviewedCritere[] {
  return set.criteria.filter(c => c.review_status === 'complete');
}

/** Critères dont la revue est partielle (certaines suggestions encore en pending) */
export function getPartialReviews(set: AIReviewedCriteriaSet): AIReviewedCritere[] {
  return set.criteria.filter(c => c.review_status === 'partial');
}

/** Critères sans aucune revue (toutes suggestions en pending) */
export function getPendingReviews(set: AIReviewedCriteriaSet): AIReviewedCritere[] {
  return set.criteria.filter(c => c.review_status === 'pending');
}

/** Extrait le trail d'audit complet du set (toutes entrées, tous critères) */
export function getFullAuditTrail(set: AIReviewedCriteriaSet): AuditEntry[] {
  return set.criteria.flatMap(c => c.audit_trail);
}
