/**
 * ONB-3 — Machine d'état du pipeline onboarding IA (module pur, testable)
 *
 * Orchestre les étapes L1 → L2 → L3 → IA → revue → merge → dry run → persistence
 * sans logique DOM ni dépendance HTTP. Toute la logique est ici, testable
 * isolément, sans Supabase, sans appel LLM réel.
 *
 * INTERDIT :
 *   - Modifier le matching/scraping/notifications
 *   - Activer automatiquement un critère (active=true)
 *   - Persister sans actor_id, sans dryRun explicite, sans feature flag
 *   - Modifier radar-bc-bot.js (sauf routing minimal via pipeline-admin-router)
 *   - Appel DB réel si dryRun=true
 *
 * États :
 *   draft_l1 → l2_generated → l3_generated → ai_enriched
 *   → ai_reviewed → ai_merged → dry_run_done → ready_for_persistence → persisted
 */

import { mapL1ToL2 }                   from './profile-mapper';
import { generateCriteriaFromL2 }       from './criteria-generator';
import { enrichCriteriaWithAI }         from './criteria-ai-enricher';
import {
  initReviewSet,
  applyReviewCommandToSet,
}                                        from './criteria-ai-reviewer';
import { mergeApprovedSuggestions }      from './criteria-ai-merger';
import { runAIDryRunPersistence }        from './criteria-ai-persistence-adapter';

import type { OnboardingClientForm }     from './schema';
import type { StructuredBusinessProfile } from './l2-profile.schema';
import type { GeneratedCriteriaSet }     from './l3-criteria.schema';
import type { AIEnrichedCriteriaSet }    from './criteria-ai-enricher.schema';
import type { AIReviewedCriteriaSet }    from './criteria-ai-review.schema';
import type { AIReviewCommand }          from './criteria-ai-review.schema';
import type { AIMergedCriteriaSet }      from './criteria-ai-merge.schema';
import type { AIPersistenceDryRunReport } from './criteria-ai-persistence-adapter';
import type { ILLMClient }               from '../ai/llm-client';
import type { PersistResult }            from './criteria-repository.schema';

// ─── États du pipeline ────────────────────────────────────────────────────────

export type PipelineState =
  | 'draft_l1'
  | 'l2_generated'
  | 'l3_generated'
  | 'ai_enriched'
  | 'ai_reviewed'
  | 'ai_merged'
  | 'dry_run_done'
  | 'ready_for_persistence'
  | 'persisted';

// ─── Session pipeline ─────────────────────────────────────────────────────────

/**
 * Snapshot immuable de l'état courant du pipeline.
 * Chaque transition retourne une NOUVELLE session — jamais de mutation.
 */
export interface PipelineSession {
  readonly state:       PipelineState;
  readonly client_id:   string;
  readonly actor_id:    string;

  /** Fiche client L1 */
  readonly l1_form?:   OnboardingClientForm;

  /** Profil structuré L2 */
  readonly l2_profile?: StructuredBusinessProfile;

  /** Critères L3 générés */
  readonly l3_criteria?: GeneratedCriteriaSet;

  /** Critères enrichis IA (ONB-2) */
  readonly ai_enriched?: AIEnrichedCriteriaSet;

  /** Critères après revue humaine (ONB-2b) */
  readonly ai_reviewed?: AIReviewedCriteriaSet;

  /** Critères fusionnés (ONB-2c) */
  readonly ai_merged?: AIMergedCriteriaSet;

  /** Rapport dry run (ONB-2d) */
  readonly dry_run_report?: AIPersistenceDryRunReport;

  /** Résultat de la persistance réelle */
  readonly persist_result?: PersistResult;

  /** Avertissements accumulés par étape */
  readonly warnings: readonly string[];

  /** Erreurs non bloquantes */
  readonly errors: readonly string[];
}

// ─── Options de création ──────────────────────────────────────────────────────

export interface CreateSessionOptions {
  client_id?: string;
  actor_id:   string;
}

// ─── Résultat de transition ───────────────────────────────────────────────────

export type PipelineTransitionResult =
  | { ok: true;  session: PipelineSession }
  | { ok: false; error: string; session: PipelineSession };

// ─── Dépendances injectables pour la persistance réelle ──────────────────────

export interface PipelinePersistDeps {
  /** Feature flag — false par défaut (protecteur) */
  enabled:          boolean;
  /** Fonction de persistance injectable (Supabase ou mock) */
  persistFn:        (merged: AIMergedCriteriaSet, opts: {
    actor_id: string;
    enabled:  boolean;
    dryRun:   false;
  }) => Promise<PersistResult>;
}

// ─── Création de session ──────────────────────────────────────────────────────

/**
 * Crée une nouvelle session pipeline en état draft_l1.
 */
export function createPipelineSession(
  form:    OnboardingClientForm,
  options: CreateSessionOptions,
): PipelineSession {
  return {
    state:    'draft_l1',
    client_id: options.client_id ?? '',
    actor_id:  options.actor_id,
    l1_form:   form,
    warnings:  [],
    errors:    [],
  };
}

// ─── Étape 1 : L1 → L2 ───────────────────────────────────────────────────────

/**
 * Génère le profil L2 depuis la fiche L1.
 * Transition : draft_l1 → l2_generated
 */
export function generateL2(session: PipelineSession): PipelineTransitionResult {
  if (!session.l1_form) {
    return err(session, 'Aucune fiche L1 disponible.');
  }

  try {
    const l2_profile = mapL1ToL2(session.l1_form);
    return ok({ ...session, state: 'l2_generated', l2_profile });
  } catch (e: unknown) {
    return err(session, `Erreur génération L2 : ${msgOf(e)}`);
  }
}

// ─── Étape 2 : L2 → L3 ───────────────────────────────────────────────────────

/**
 * Génère les critères L3 depuis le profil L2.
 * Transition : l2_generated → l3_generated
 */
export function generateL3(session: PipelineSession): PipelineTransitionResult {
  if (!session.l2_profile) {
    return err(session, 'Profil L2 non disponible — générer L2 d\'abord.');
  }

  try {
    const l3_criteria = generateCriteriaFromL2(session.l2_profile, session.client_id);
    return ok({ ...session, state: 'l3_generated', l3_criteria });
  } catch (e: unknown) {
    return err(session, `Erreur génération L3 : ${msgOf(e)}`);
  }
}

// ─── Étape 3 : L3 → Enrichissement IA ───────────────────────────────────────

/**
 * Enrichit les critères L3 via le LLM injecté.
 * Transition : l3_generated → ai_enriched
 *
 * @param llmClient LLM injectable — utiliser un mock en tests
 * @param model     Modèle LLM à utiliser
 */
export async function enrichWithAI(
  session:   PipelineSession,
  llmClient: ILLMClient,
  model:     string = 'ollama/mistral-7b-instruct',
): Promise<PipelineTransitionResult> {
  if (!session.l3_criteria) {
    return err(session, 'Critères L3 non disponibles — générer L3 d\'abord.');
  }

  try {
    const ai_enriched = await enrichCriteriaWithAI(
      session.l3_criteria,
      { llmClient, model },
    );
    const warnings = [...session.warnings, ...ai_enriched.warnings];
    return ok({ ...session, state: 'ai_enriched', ai_enriched, warnings });
  } catch (e: unknown) {
    return err(session, `Erreur enrichissement IA : ${msgOf(e)}`);
  }
}

// ─── Étape 4 : Revue humaine ──────────────────────────────────────────────────

/**
 * Initialise la revue humaine (si pas encore démarrée)
 * puis applique une commande de revue au set courant.
 * Transition : ai_enriched → ai_reviewed (idempotente)
 */
export function applyReview(
  session: PipelineSession,
  command: AIReviewCommand,
): PipelineTransitionResult {
  if (!session.ai_enriched && !session.ai_reviewed) {
    return err(session, 'Enrichissement IA non disponible — lancer l\'enrichissement d\'abord.');
  }

  try {
    // Initialiser la revue si nécessaire
    const reviewSet = session.ai_reviewed ?? initReviewSet(session.ai_enriched!);
    const result    = applyReviewCommandToSet(reviewSet, command);
    if (!result.ok) {
      return err(session, `Commande de revue refusée : ${result.error}`);
    }
    return ok({ ...session, state: 'ai_reviewed', ai_reviewed: result.set });
  } catch (e: unknown) {
    return err(session, `Erreur revue : ${msgOf(e)}`);
  }
}

// ─── Étape 5 : Merge approved ─────────────────────────────────────────────────

/**
 * Fusionne les suggestions IA approuvées dans les critères.
 * Transition : ai_reviewed → ai_merged
 */
export function mergeApproved(session: PipelineSession): PipelineTransitionResult {
  if (!session.ai_reviewed) {
    return err(session, 'Revue IA non disponible — effectuer la revue d\'abord.');
  }

  try {
    const ai_merged = mergeApprovedSuggestions(session.ai_reviewed, {
      actor_id: session.actor_id,
    });
    const warnings = [...session.warnings, ...ai_merged.warnings];
    return ok({ ...session, state: 'ai_merged', ai_merged, warnings });
  } catch (e: unknown) {
    return err(session, `Erreur fusion : ${msgOf(e)}`);
  }
}

// ─── Étape 6 : Dry run persistence ───────────────────────────────────────────

/**
 * Exécute le dry run de persistance — jamais d'écriture DB.
 * Transition : ai_merged → dry_run_done
 */
export async function runDryRun(
  session: PipelineSession,
): Promise<PipelineTransitionResult> {
  if (!session.ai_merged) {
    return err(session, 'Merge IA non disponible — effectuer le merge d\'abord.');
  }

  try {
    const dry_run_report = await runAIDryRunPersistence(session.ai_merged, {
      actor_id: session.actor_id,
      dryRun:   true,
      enabled:  true,
    });

    const nextState: PipelineState = dry_run_report.prepared_count > 0
      ? 'dry_run_done'
      : 'dry_run_done';

    const warnings = [...session.warnings, ...dry_run_report.warnings];
    return ok({ ...session, state: nextState, dry_run_report, warnings });
  } catch (e: unknown) {
    return err(session, `Erreur dry run : ${msgOf(e)}`);
  }
}

/**
 * Marque la session comme prête pour la persistance réelle.
 * Transition : dry_run_done → ready_for_persistence
 *
 * Conditions :
 *   - dry_run_report présent
 *   - prepared_count > 0
 *   - actor_id présent
 */
export function markReadyForPersistence(session: PipelineSession): PipelineTransitionResult {
  if (session.state !== 'dry_run_done') {
    return err(session, 'Le dry run doit être complété avant de marquer la session comme prête.');
  }
  if (!session.dry_run_report || session.dry_run_report.prepared_count === 0) {
    return err(session, 'Aucun critère persistable détecté — vérifier le dry run.');
  }
  if (!session.actor_id) {
    return err(session, 'actor_id obligatoire pour la persistance réelle.');
  }

  return ok({ ...session, state: 'ready_for_persistence' });
}

// ─── Étape 7 : Persistance réelle ─────────────────────────────────────────────

/**
 * Persistance réelle — bloquée sans toutes les conditions.
 *
 * Conditions bloquantes :
 *   - state === 'ready_for_persistence'
 *   - actor_id présent
 *   - deps.enabled === true
 *   - dry_run_report présent et prepared_count > 0
 *   - confirmation explicite (confirmPersist === true)
 *
 * Transition : ready_for_persistence → persisted
 */
export async function persistReal(
  session:        PipelineSession,
  confirmPersist: boolean,
  deps:           PipelinePersistDeps,
): Promise<PipelineTransitionResult> {
  // ── Garde actor_id ────────────────────────────────────────────────────────
  if (!session.actor_id) {
    return err(session, 'actor_id obligatoire pour la persistance réelle.');
  }

  // ── Garde confirmation ────────────────────────────────────────────────────
  if (!confirmPersist) {
    return err(session, 'Confirmation explicite requise pour la persistance réelle.');
  }

  // ── Garde état ────────────────────────────────────────────────────────────
  if (session.state !== 'ready_for_persistence') {
    return err(session, 'La session doit être en état ready_for_persistence. Effectuer le dry run et valider d\'abord.');
  }

  // ── Garde dry run ─────────────────────────────────────────────────────────
  if (!session.dry_run_report || session.dry_run_report.prepared_count === 0) {
    return err(session, 'Dry run non effectué ou aucun critère persistable.');
  }

  // ── Garde feature flag ────────────────────────────────────────────────────
  if (!deps.enabled) {
    return err(session, 'Feature flag enabled=false — persistance réelle désactivée.');
  }

  // ── Garde merged set ──────────────────────────────────────────────────────
  if (!session.ai_merged) {
    return err(session, 'Set fusionné IA non disponible.');
  }

  try {
    const persist_result = await deps.persistFn(session.ai_merged, {
      actor_id: session.actor_id,
      enabled:  deps.enabled,
      dryRun:   false,
    });
    return ok({ ...session, state: 'persisted', persist_result });
  } catch (e: unknown) {
    return err(session, `Erreur persistance réelle : ${msgOf(e)}`);
  }
}

// ─── Helpers de validation / lecture ─────────────────────────────────────────

/** Vrai si la session a passé le dry run avec au moins 1 critère persistable */
export function isDryRunSuccessful(session: PipelineSession): boolean {
  return (session.dry_run_report?.prepared_count ?? 0) > 0
    && session.state !== 'persisted';
}

/** Vrai si toutes les conditions de persistance réelle sont remplies */
export function canPersistReal(
  session: PipelineSession,
  enabled: boolean,
): boolean {
  return session.state === 'ready_for_persistence'
    && !!session.actor_id
    && enabled
    && isDryRunSuccessful(session);
}

/** Résumé lisible de l'état courant */
export function getPipelineSummary(session: PipelineSession): {
  state:          PipelineState;
  client_id:      string;
  actor_id:       string;
  l3_count:       number;
  enriched_count: number;
  prepared_count: number;
  warnings:       number;
  errors:         number;
} {
  return {
    state:          session.state,
    client_id:      session.client_id,
    actor_id:       session.actor_id,
    l3_count:       session.l3_criteria?.criteria.length ?? 0,
    enriched_count: session.ai_enriched?.criteria.length ?? 0,
    prepared_count: session.dry_run_report?.prepared_count ?? 0,
    warnings:       session.warnings.length,
    errors:         session.errors.length,
  };
}

// ─── Helpers internes ─────────────────────────────────────────────────────────

function ok(session: Partial<PipelineSession> & Pick<PipelineSession, 'state' | 'client_id' | 'actor_id' | 'warnings' | 'errors'>): PipelineTransitionResult {
  return { ok: true, session: session as PipelineSession };
}

function err(session: PipelineSession, error: string): PipelineTransitionResult {
  return {
    ok:      false,
    error,
    session: { ...session, errors: [...session.errors, error] },
  };
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
