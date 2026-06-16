/**
 * ONB-1d — Helpers de Revue Humaine des Critères L3
 *
 * Fournit les opérations de validation humaine sur un ReviewableCriteriaSet.
 *
 * Contraintes absolues :
 *   - Pas de mutation silencieuse — toutes les fonctions retournent un nouveau set
 *   - Pas d'écriture Supabase
 *   - Pas d'appel IA
 *   - Pas de branchement au matching / shadow mode
 *   - active reste false dans tout ce module
 *   - Chaque action produit une entrée d'audit trail
 *   - Un critère rejeté ne peut pas être approuvé directement
 *   - Un critère modifié repasse en "edited" (nécessite approbation explicite)
 */

import { type GeneratedCriteriaSet } from './l3-criteria.schema';
import { validateCritereLabel } from './criteria-label-guard';
import { enrichCriterion } from './criteria-auto-enrichment';
import {
  type ReviewableCriteriaSet,
  type ReviewableCritere,
  type CritereEnrichmentSnapshot,
  type CritereEdit,
  type AuditTrailEntry,
  ReviewableCriteriaSetSchema,
} from './l3-review.schema';

// ─── Erreurs métier ───────────────────────────────────────────────────────────

export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'CRITERION_NOT_FOUND'
      | 'CRITERION_ALREADY_REJECTED'
      | 'CRITERION_NOT_PENDING'
      | 'REQUIRES_HUMAN_VALIDATION'
      | 'EDIT_INVALID',
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

// ─── Utilitaires internes ──────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

/**
 * Calcule le statut global d'un set de critères.
 * "review_complete" si tous les critères sont approved ou rejected.
 * "in_review" sinon.
 */
function computeGlobalStatus(
  criteria: readonly ReviewableCritere[],
): 'in_review' | 'review_complete' {
  const allDone = criteria.every(
    c => c.review_status === 'approved' || c.review_status === 'rejected',
  );
  return allDone ? 'review_complete' : 'in_review';
}

/**
 * Crée une copie d'un critère avec les champs mis à jour + nouvelle entrée d'audit.
 * Ne mute jamais l'original.
 */
function withAudit(
  critere: ReviewableCritere,
  patch: Partial<ReviewableCritere>,
  auditEntry: AuditTrailEntry,
): ReviewableCritere {
  return {
    ...critere,
    ...patch,
    audit_trail: [...critere.audit_trail, auditEntry],
  };
}

// ─── Initialisation ────────────────────────────────────────────────────────────

/**
 * Initialise une session de revue depuis un GeneratedCriteriaSet.
 * Tous les critères démarrent en "pending_validation".
 *
 * @param generated  Set de critères L3 produit par generateCriteriaFromL2()
 * @returns          ReviewableCriteriaSet prêt pour la revue
 */
export function initReview(generated: GeneratedCriteriaSet): ReviewableCriteriaSet {
  const startedAt = now();

  const reviewableCriteria: ReviewableCritere[] = generated.criteria.map(c => {
    // Enrichissement automatique au moment de l'initiation de la revue.
    // Aucun appel IA, aucune écriture DB — calcul purement local.
    const enriched = enrichCriterion({
      valeur:        c.label,
      ai_inclusions: c.ai_inclusions_initial,
    });

    const auto_enrichment: CritereEnrichmentSnapshot = {
      activation_status:         enriched.activation_status,
      known_suggestion_bank:     enriched.known_suggestion_bank,
      needs_ai_enrichment:       enriched.needs_ai_enrichment,
      reason:                    enriched.reason,
      suggested_precise_criteria: enriched.suggested_precise_criteria,
      suggested_inclusions:      enriched.suggested_inclusions,
      suggested_exclusions:      enriched.suggested_exclusions,
    };

    return {
      ...c,
      review_status:  'pending_validation' as const,
      audit_trail:    [],
      auto_enrichment,
    };
  });

  const raw = {
    client_id:         generated.client_id,
    review_started_at: startedAt,
    review_updated_at: startedAt,
    review_status:     computeGlobalStatus(reviewableCriteria),
    criteria:          reviewableCriteria,
  };

  return ReviewableCriteriaSetSchema.parse(raw);
}

// ─── Actions de revue ─────────────────────────────────────────────────────────

/**
 * Approuve un critère par son ID.
 *
 * Préconditions :
 *   - Le critère doit exister dans le set
 *   - Le critère doit être en statut pending_validation ou edited
 *   - Le critère ne peut pas être rejected (il faudrait re-soumettre)
 *
 * @throws ReviewError si les préconditions ne sont pas remplies
 */
export function approveCriterion(
  set: ReviewableCriteriaSet,
  criterionId: string,
  reviewedBy: string,
  note?: string,
): ReviewableCriteriaSet {
  const idx = set.criteria.findIndex(c => c.id === criterionId);
  if (idx === -1) {
    throw new ReviewError(
      `Critère "${criterionId}" introuvable dans le set`,
      'CRITERION_NOT_FOUND',
    );
  }

  const critere = set.criteria[idx]!;

  if (critere.review_status === 'rejected') {
    throw new ReviewError(
      `Critère "${criterionId}" est rejeté — impossible de l'approuver directement`,
      'CRITERION_ALREADY_REJECTED',
    );
  }

  if (critere.review_status === 'approved') {
    // Idempotent — retourner le set inchangé
    return set;
  }

  // Guard enrichissement : bloquer les critères needs_clarification.
  // Ces critères nécessitent un editCriterion préalable pour préciser le label.
  if (critere.auto_enrichment?.activation_status === 'needs_clarification') {
    throw new ReviewError(
      `Critère "${criterionId}" est trop générique (needs_clarification) — ` +
      `utilisez editCriterion pour préciser le label avant d'approuver. ` +
      `Raison : ${critere.auto_enrichment.reason}`,
      'REQUIRES_HUMAN_VALIDATION',
    );
  }

  // Guard label générique : ajouter un avertissement explicite dans l'audit
  const labelGuard = validateCritereLabel(critere.label ?? critere.id);
  const guardNote  = labelGuard.level !== 'ok'
    ? `[label-guard:${labelGuard.level}] ${labelGuard.reason ?? ''}`
    : undefined;

  const auditEntry: AuditTrailEntry = {
    review_action: 'approve_criterion',
    reviewed_by:   reviewedBy,
    reviewed_at:   now(),
    review_note:   [guardNote, note].filter(Boolean).join(' | ') || undefined,
  };

  const updatedCritere = withAudit(critere, { review_status: 'approved' }, auditEntry);
  const updatedCriteria = set.criteria.map((c, i) => (i === idx ? updatedCritere : c));

  return {
    ...set,
    criteria:          updatedCriteria,
    review_status:     computeGlobalStatus(updatedCriteria),
    review_updated_at: now(),
  };
}

/**
 * Rejette un critère par son ID.
 *
 * Un critère rejeté reste dans le set avec active=false.
 * Il ne peut pas être approuvé par la suite (il faudrait re-générer).
 */
export function rejectCriterion(
  set: ReviewableCriteriaSet,
  criterionId: string,
  reviewedBy: string,
  note?: string,
): ReviewableCriteriaSet {
  const idx = set.criteria.findIndex(c => c.id === criterionId);
  if (idx === -1) {
    throw new ReviewError(
      `Critère "${criterionId}" introuvable dans le set`,
      'CRITERION_NOT_FOUND',
    );
  }

  const critere = set.criteria[idx]!;

  if (critere.review_status === 'rejected') {
    // Idempotent
    return set;
  }

  const auditEntry: AuditTrailEntry = {
    review_action: 'reject_criterion',
    reviewed_by:   reviewedBy,
    reviewed_at:   now(),
    ...(note ? { review_note: note } : {}),
  };

  const updatedCritere = withAudit(critere, { review_status: 'rejected' }, auditEntry);
  const updatedCriteria = set.criteria.map((c, i) => (i === idx ? updatedCritere : c));

  return {
    ...set,
    criteria:          updatedCriteria,
    review_status:     computeGlobalStatus(updatedCriteria),
    review_updated_at: now(),
  };
}

/**
 * Modifie un critère par son ID.
 *
 * Règles :
 *   - Un critère rejeté ne peut pas être modifié
 *   - La modification produit un snapshot before/after dans l'audit trail
 *   - Après modification, le critère repasse en "edited" (attente de re-validation)
 *   - active reste false
 *   - requires_human_validation reste true
 *
 * @throws ReviewError si le critère est rejected
 */
export function editCriterion(
  set: ReviewableCriteriaSet,
  criterionId: string,
  edits: CritereEdit,
  reviewedBy: string,
  note?: string,
): ReviewableCriteriaSet {
  const idx = set.criteria.findIndex(c => c.id === criterionId);
  if (idx === -1) {
    throw new ReviewError(
      `Critère "${criterionId}" introuvable dans le set`,
      'CRITERION_NOT_FOUND',
    );
  }

  const critere = set.criteria[idx]!;

  if (critere.review_status === 'rejected') {
    throw new ReviewError(
      `Critère "${criterionId}" est rejeté — impossible de le modifier`,
      'CRITERION_ALREADY_REJECTED',
    );
  }

  // Snapshot before (champs modifiés uniquement)
  const beforeSnapshot: Record<string, unknown> = {};
  const afterSnapshot:  Record<string, unknown> = {};

  for (const [key, value] of Object.entries(edits)) {
    if (value !== undefined) {
      beforeSnapshot[key] = (critere as Record<string, unknown>)[key];
      afterSnapshot[key]  = value;
    }
  }

  const auditEntry: AuditTrailEntry = {
    review_action: 'edit_criterion',
    reviewed_by:   reviewedBy,
    reviewed_at:   now(),
    before:        beforeSnapshot,
    after:         afterSnapshot,
    ...(note ? { review_note: note } : {}),
  };

  // Filtrer les undefined de edits avant de merger (exactOptionalPropertyTypes)
  const cleanEdits = Object.fromEntries(
    Object.entries(edits).filter(([, v]) => v !== undefined),
  ) as Partial<ReviewableCritere>;

  const updatedCritere = withAudit(
    critere,
    {
      ...cleanEdits,
      // Invariants inchangeables
      active:                    false,
      requires_human_validation: true,
      // Repasse en "edited" — nécessite re-approbation
      review_status:             'edited',
    },
    auditEntry,
  );

  const updatedCriteria = set.criteria.map((c, i) => (i === idx ? updatedCritere : c));

  return {
    ...set,
    criteria:          updatedCriteria,
    review_status:     computeGlobalStatus(updatedCriteria),
    review_updated_at: now(),
  };
}

/**
 * Approuve tous les critères en statut pending_validation ou edited.
 * Les critères rejected sont laissés inchangés.
 */
export function approveAll(
  set: ReviewableCriteriaSet,
  reviewedBy: string,
  note?: string,
): ReviewableCriteriaSet {
  const auditEntry: AuditTrailEntry = {
    review_action: 'approve_all',
    reviewed_by:   reviewedBy,
    reviewed_at:   now(),
    ...(note ? { review_note: note } : {}),
  };

  const updatedCriteria = set.criteria.map(c => {
    if (c.review_status === 'pending_validation' || c.review_status === 'edited') {
      // Ne pas approuver automatiquement les critères needs_clarification.
      // Ils restent en pending_validation jusqu'à editCriterion explicite.
      if (c.auto_enrichment?.activation_status === 'needs_clarification') {
        return c;
      }
      return withAudit(c, { review_status: 'approved' }, auditEntry);
    }
    return c;
  });

  return {
    ...set,
    criteria:          updatedCriteria,
    review_status:     computeGlobalStatus(updatedCriteria),
    review_updated_at: now(),
  };
}

/**
 * Rejette tous les critères (pending, edited et approved).
 * Utilisé pour annuler une session de revue complète.
 */
export function rejectAll(
  set: ReviewableCriteriaSet,
  reviewedBy: string,
  note?: string,
): ReviewableCriteriaSet {
  const auditEntry: AuditTrailEntry = {
    review_action: 'reject_all',
    reviewed_by:   reviewedBy,
    reviewed_at:   now(),
    ...(note ? { review_note: note } : {}),
  };

  const updatedCriteria = set.criteria.map(c => {
    if (c.review_status !== 'rejected') {
      return withAudit(c, { review_status: 'rejected' }, auditEntry);
    }
    return c;
  });

  return {
    ...set,
    criteria:          updatedCriteria,
    review_status:     computeGlobalStatus(updatedCriteria),
    review_updated_at: now(),
  };
}

// ─── Helpers de lecture ────────────────────────────────────────────────────────

/**
 * Retourne uniquement les critères approuvés.
 * Ces critères sont prêts pour la persistance ONB-1e.
 *
 * Note : active reste false — l'activation est du ressort d'ONB-1e.
 */
export function getApprovedCriteria(set: ReviewableCriteriaSet): ReviewableCritere[] {
  return set.criteria.filter(c => c.review_status === 'approved');
}

/**
 * Retourne uniquement les critères rejetés.
 */
export function getRejectedCriteria(set: ReviewableCriteriaSet): ReviewableCritere[] {
  return set.criteria.filter(c => c.review_status === 'rejected');
}

/**
 * Retourne uniquement les critères en attente (pending ou edited).
 */
export function getPendingCriteria(set: ReviewableCriteriaSet): ReviewableCritere[] {
  return set.criteria.filter(
    c => c.review_status === 'pending_validation' || c.review_status === 'edited',
  );
}

/**
 * Résumé des statuts d'enrichissement pour toute la session de revue.
 *
 * Utile pour l'affichage admin : combien de critères sont prêts vs. nécessitent
 * une action humaine complémentaire.
 */
export function getEnrichmentStatusSummary(set: ReviewableCriteriaSet): {
  active:               number;
  needs_review:         number;
  needs_clarification:  number;
  needs_ai_enrichment:  number;
  no_enrichment_data:   number;
} {
  let active = 0, needs_review = 0, needs_clarification = 0,
      needs_ai_enrichment = 0, no_enrichment_data = 0;

  for (const c of set.criteria) {
    if (!c.auto_enrichment) {
      no_enrichment_data++;
      continue;
    }
    const s = c.auto_enrichment.activation_status;
    if (s === 'active')               active++;
    else if (s === 'needs_review')    needs_review++;
    else if (s === 'needs_clarification') needs_clarification++;
    if (c.auto_enrichment.needs_ai_enrichment) needs_ai_enrichment++;
  }

  return { active, needs_review, needs_clarification, needs_ai_enrichment, no_enrichment_data };
}

/**
 * Indique si la session de revue est complète (plus aucun critère en attente).
 */
export function isReviewComplete(set: ReviewableCriteriaSet): boolean {
  return set.review_status === 'review_complete';
}

/**
 * Résumé lisible de l'état de la revue.
 */
export function summarizeReview(set: ReviewableCriteriaSet): string {
  const approved = getApprovedCriteria(set).length;
  const rejected = getRejectedCriteria(set).length;
  const pending  = getPendingCriteria(set).length;
  const total    = set.criteria.length;

  return [
    `Session de revue — ${set.client_id || 'preview'}`,
    `Total : ${total} critères`,
    `  ✅ Approuvés : ${approved}`,
    `  ❌ Rejetés   : ${rejected}`,
    `  ⏳ En attente : ${pending}`,
    `Statut global : ${set.review_status}`,
  ].join('\n');
}
