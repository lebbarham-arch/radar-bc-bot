/**
 * ONB-1h — Logique UI de Revue des Critères (module pur, sans DOM)
 *
 * Ce module gère l'état local de la session de revue UI.
 * Il délègue toutes les actions métier aux helpers criteria-reviewer.ts.
 *
 * Règles absolues :
 *   - Aucune duplication de logique métier (approve/reject/edit → reviewer)
 *   - Aucun appel IA
 *   - Aucun accès radar-bc-bot.js
 *   - active reste false avant persistance
 *   - dryRun=true obligatoire avant persist réel
 *   - actor_id obligatoire pour persist réel
 *   - Aucune activation automatique côté client public
 */

import {
  type ReviewableCriteriaSet,
  type ReviewableCritere,
  type CritereEdit,
} from './l3-review.schema';

import {
  approveCriterion,
  rejectCriterion,
  editCriterion,
  approveAll,
  rejectAll,
  getApprovedCriteria,
  getRejectedCriteria,
  getPendingCriteria,
  isReviewComplete,
  summarizeReview,
} from './criteria-reviewer';

import { type WorkflowReport } from './criteria-workflow';

// ─── État de la session UI ────────────────────────────────────────────────────

export interface ReviewUiState {
  /** Session de revue courante */
  reviewSet: ReviewableCriteriaSet;
  /** Identifiant de l'acteur admin connecté */
  actorId: string;
  /** Résultat du dernier dry run (null si pas encore effectué) */
  lastDryRun: WorkflowReport | null;
  /** Dry run réussi = prérequis pour le persist réel */
  dryRunSucceeded: boolean;
  /** Opération en cours */
  loading: boolean;
  /** Messages d'erreur non bloquants */
  errors: string[];
  /** Messages d'info/succès */
  messages: string[];
}

/**
 * Initialise l'état UI depuis un ReviewableCriteriaSet.
 */
export function initUiState(
  reviewSet: ReviewableCriteriaSet,
  actorId: string,
): ReviewUiState {
  return {
    reviewSet,
    actorId,
    lastDryRun:      null,
    dryRunSucceeded: false,
    loading:         false,
    errors:          [],
    messages:        [],
  };
}

// ─── Actions UI (délèguent au reviewer) ──────────────────────────────────────

/**
 * Approuve un critère — délègue à approveCriterion().
 * Retourne un nouvel état sans muter l'ancien.
 */
export function uiApproveCriterion(
  state: ReviewUiState,
  criterionId: string,
  note?: string,
): ReviewUiState {
  try {
    const updatedSet = approveCriterion(state.reviewSet, criterionId, state.actorId, note);
    return {
      ...state,
      reviewSet:       updatedSet,
      dryRunSucceeded: false,  // dry run à relancer après chaque changement
      errors:          [],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...state, errors: [msg] };
  }
}

/**
 * Rejette un critère — délègue à rejectCriterion().
 */
export function uiRejectCriterion(
  state: ReviewUiState,
  criterionId: string,
  note?: string,
): ReviewUiState {
  try {
    const updatedSet = rejectCriterion(state.reviewSet, criterionId, state.actorId, note);
    return {
      ...state,
      reviewSet:       updatedSet,
      dryRunSucceeded: false,
      errors:          [],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...state, errors: [msg] };
  }
}

/**
 * Édite un critère — délègue à editCriterion().
 * Le statut repasse à "edited" — nécessite re-approbation.
 */
export function uiEditCriterion(
  state: ReviewUiState,
  criterionId: string,
  edits: CritereEdit,
  note?: string,
): ReviewUiState {
  try {
    const updatedSet = editCriterion(state.reviewSet, criterionId, edits, state.actorId, note);
    return {
      ...state,
      reviewSet:       updatedSet,
      dryRunSucceeded: false,
      errors:          [],
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...state, errors: [msg] };
  }
}

/**
 * Approuve tous les critères pending/edited.
 */
export function uiApproveAll(state: ReviewUiState, note?: string): ReviewUiState {
  const updatedSet = approveAll(state.reviewSet, state.actorId, note);
  return {
    ...state,
    reviewSet:       updatedSet,
    dryRunSucceeded: false,
    errors:          [],
  };
}

/**
 * Rejette tous les critères.
 */
export function uiRejectAll(state: ReviewUiState, note?: string): ReviewUiState {
  const updatedSet = rejectAll(state.reviewSet, state.actorId, note);
  return {
    ...state,
    reviewSet:       updatedSet,
    dryRunSucceeded: false,
    errors:          [],
  };
}

// ─── Dry run ──────────────────────────────────────────────────────────────────

/**
 * Enregistre le résultat d'un dry run dans l'état UI.
 * dryRunSucceeded=true débloque le bouton de persist réel.
 */
export function uiApplyDryRunResult(
  state: ReviewUiState,
  report: WorkflowReport,
): ReviewUiState {
  return {
    ...state,
    lastDryRun:      report,
    dryRunSucceeded: report.ok && report.dry_run,
    loading:         false,
    messages:        report.ok
      ? [`Dry run OK — ${report.would_insert_count} critère(s) seraient insérés.`]
      : [],
    errors: report.ok ? [] : [`Dry run échoué : ${report.warnings.join(', ')}`],
  };
}

// ─── Guards persist réel ──────────────────────────────────────────────────────

export interface PersistReadinessCheck {
  ready: boolean;
  reasons: string[];
}

/**
 * Vérifie si le persist réel est autorisé.
 *
 * Conditions :
 *   - dryRunSucceeded = true
 *   - actorId présent
 *   - au moins un critère approved
 *   - ONBOARDING_ADMIN_API_ENABLED (vérifié côté serveur, signal côté UI)
 */
export function checkPersistReadiness(
  state: ReviewUiState,
  adminApiEnabled: boolean,
): PersistReadinessCheck {
  const reasons: string[] = [];

  if (!adminApiEnabled) {
    reasons.push('ONBOARDING_ADMIN_API_ENABLED=false — persistance désactivée.');
  }
  if (!state.dryRunSucceeded) {
    reasons.push('Un dry run réussi est requis avant le persist réel.');
  }
  if (!state.actorId || state.actorId.trim() === '') {
    reasons.push('actor_id obligatoire pour la persistance réelle.');
  }
  if (getApprovedCriteria(state.reviewSet).length === 0) {
    reasons.push('Aucun critère approuvé — rien à persister.');
  }

  return { ready: reasons.length === 0, reasons };
}

// ─── Helpers de lecture (expose les helpers reviewer) ────────────────────────

export {
  getApprovedCriteria,
  getRejectedCriteria,
  getPendingCriteria,
  isReviewComplete,
  summarizeReview,
};

/**
 * Retourne un résumé lisible des critères par statut.
 */
export function getStatusSummary(set: ReviewableCriteriaSet): {
  total:    number;
  approved: number;
  rejected: number;
  pending:  number;
} {
  return {
    total:    set.criteria.length,
    approved: getApprovedCriteria(set).length,
    rejected: getRejectedCriteria(set).length,
    pending:  getPendingCriteria(set).length,
  };
}

/**
 * Retourne les champs d'affichage d'un critère pour l'UI.
 */
export function getCritereDisplayFields(c: ReviewableCritere) {
  return {
    id:                    c.id,
    label:                 c.label,
    domain_category:       c.domain_category,
    radar_type:            c.radar_type,
    base_keywords:         c.base_keywords,
    ai_inclusions_initial: c.ai_inclusions_initial,
    ai_exclusions_initial: c.ai_exclusions_initial,
    prestations_recherchees: c.prestations_recherchees,
    prestations_exclues:   c.prestations_exclues,
    zones_geographiques:   c.zones_geographiques,
    favorite_organizations: c.favorite_organizations,
    review_status:         c.review_status,
    active:                c.active,          // toujours false ici
    requires_human_validation: c.requires_human_validation, // toujours true ici
    audit_trail:           c.audit_trail,
  };
}
