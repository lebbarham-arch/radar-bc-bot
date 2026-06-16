/**
 * Shadow Mode — Types partagés
 *
 * Définit tous les types de données du Shadow Runner.
 * Le Shadow Mode observe le pipeline en lecture seule :
 *   - Aucun branchement dans radar-bc-bot.js
 *   - Aucune notification
 *   - Aucun effet de bord
 *   - Aucun accès Supabase direct (V1 : config passée en paramètre)
 *
 * Ces types sont les miroirs stricts des colonnes SQL de :
 *   - shadow_run_log (ShadowRunLog)
 *   - shadow_opportunity (ShadowOpportunity)
 *   - shadow_config (ShadowConfig)
 *
 * Règle : jamais de `any`.
 */

import { type ParsedBC }      from '@core/schemas/bc.schema';
import { type ClientProfile } from '@core/schemas/client.schema';

// ─── Feature flags ────────────────────────────────────────────────────────────

/**
 * Configuration du Shadow Mode.
 * Miroir des valeurs dans la table shadow_config (Supabase).
 * En V1, passée directement au constructeur ShadowRunner — pas de lecture DB.
 *
 * Rollback immédiat : passer shadow_mode_enabled = false.
 */
export interface ShadowConfig {
  /** Activer ou non le shadow mode */
  shadow_mode_enabled: boolean;
  /** Activer les appels LLM (opportunity detector) dans le shadow mode */
  shadow_llm_enabled: boolean;
  /**
   * Filtre client : 'all' = tous les clients observés.
   * Sinon = client_id spécifique (pour cibler un seul client en staging).
   */
  shadow_client_filter: string;
  /**
   * Taux d'échantillonnage des BCs.
   * 0.0 = aucun BC observé, 1.0 = tous les BCs observés.
   * Valeurs intermédiaires : fraction des BCs échantillonnés aléatoirement.
   */
  shadow_bc_sample_rate: number;
  /**
   * Nombre maximum d'opportunités cachées à logguer par BC.
   * Correspond à shadow_config.shadow_opportunity_max.
   */
  shadow_opportunity_max: number;
  /**
   * S1.5 — Activer le reranker advisory dans le shadow path.
   * Nécessite shadow_llm_enabled = true.
   * Défaut : false (aucun impact sur le legacy).
   */
  shadow_rerank_enabled: boolean;
}

/**
 * Configuration par défaut : tout désactivé.
 * Garantit qu'un ShadowRunner créé sans config explicite ne fait rien.
 */
export const DEFAULT_SHADOW_CONFIG: ShadowConfig = {
  shadow_mode_enabled:    false,
  shadow_llm_enabled:     false,
  shadow_client_filter:   'all',
  shadow_bc_sample_rate:  0.0,
  shadow_opportunity_max: 5,
  shadow_rerank_enabled:  false,
} as const;

// ─── Divergence ───────────────────────────────────────────────────────────────

/**
 * Résultat de la comparaison décision legacy vs décision core.
 * Correspond à la contrainte CHECK de shadow_run_log.divergence_type.
 *
 *   AGREE_NOTIFY    — les deux auraient notifié (accord positif)
 *   AGREE_SKIP      — les deux auraient ignoré (accord négatif)
 *   FALSE_POSITIVE  — legacy notifie, core ignorerait (alarme potentiellement inutile)
 *   FALSE_NEGATIVE  — legacy ignore, core notifierait (opportunité potentiellement manquée)
 */
export type DivergenceType =
  | 'AGREE_NOTIFY'
  | 'AGREE_SKIP'
  | 'FALSE_POSITIVE'
  | 'FALSE_NEGATIVE';

// ─── Raisons de skip ──────────────────────────────────────────────────────────

/**
 * Raisons pour lesquelles un run shadow est ignoré proprement.
 * Tous les skips sont volontaires — jamais d'erreur silencieuse.
 */
export type ShadowSkipReason =
  | 'shadow_disabled'   // shadow_mode_enabled = false
  | 'client_filtered'   // client.id ne correspond pas à shadow_client_filter
  | 'sample_excluded';  // BC exclu par shadow_bc_sample_rate

/**
 * Raisons de skip supplémentaires pour detectOpportunities().
 * S'ajoutent aux ShadowSkipReason de base.
 */
export type DetectSkipReason =
  | ShadowSkipReason
  | 'llm_disabled'      // shadow_llm_enabled = false
  | 'score_too_high'    // legacy_score >= OPPORTUNITY_DETERMINISTIC_MAX
  | 'already_notified'  // was_notified_legacy = true (pas de valeur à chercher des opportunités)
  | 'no_active_criteres'; // client sans critères actifs

// ─── S1.5 Reranker types ──────────────────────────────────────────────────────

/**
 * Raisons pour lesquelles le reranker advisory est ignoré proprement (S1.5).
 */
export type ShadowRerankSkipReason =
  | 'rerank_disabled'    // shadow_rerank_enabled = false
  | 'llm_disabled'       // shadow_llm_enabled = false
  | 'no_reranker'        // reranker non injecté
  | 'no_service_signal'; // aucun signal de service détecté dans le BC

/**
 * Résultat du reranker advisory (S1.5).
 * Discriminé par `skipped`.
 *
 *   { skipped: true,  reason }                        — rerank ignoré proprement
 *   { skipped: false, delta, evidence, source }        — rerank appliqué
 */
export type ShadowRerankResult =
  | { skipped: true;  reason: ShadowRerankSkipReason }
  | { skipped: false; delta: number; evidence: string; source: string };

/**
 * Paramètres passés au reranker advisory (S1.5).
 */
export interface ShadowRerankParams {
  /** BC parsé à évaluer */
  bc:              ParsedBC;
  /** Score déterministe calculé par scoreBC */
  det_score:       number;
  /** Seuil de décision du client */
  threshold:       number;
  /** Valeurs des critères actifs du client (pour le contexte signal) */
  critere_valeurs: readonly string[];
}

// ─── ShadowRunLog ─────────────────────────────────────────────────────────────

/**
 * Log d'une comparaison shadow (BC × critère × client).
 * Miroir exact de la table shadow_run_log — prêt à être inséré en Supabase.
 *
 * En V1, retourné par evaluateCritere() sans être persisté directement.
 * La persistance sera assurée par les hooks J1/J2 (Livrable 4).
 */
export interface ShadowRunLog {
  /** Timestamp ISO 8601 du run */
  run_ts:               string;
  /** Identifiant du bon de commande */
  bc_id:                string;
  /** Identifiant du client observé */
  client_id:            string;
  /** Identifiant du critère qui a déclenché la comparaison (pour le log) */
  critere_id:           string;
  /** Score donné par le legacy pour ce BC × client */
  legacy_score:         number;
  /** Décision legacy : true = notifié, false = ignoré ou reranked */
  legacy_decision:      boolean;
  /** Score déterministe calculé par le core (scoreBC sans LLM) */
  det_score:            number;
  /** Delta appliqué par le reranker (0 en V1 — reranker non intégré au shadow) */
  rerank_delta:         number;
  /** Source du reranking (null en V1) */
  rerank_source:        string | null;
  /** Score final core = det_score + rerank_delta (= det_score en V1) */
  intelligent_score:    number;
  /** Décision core : true = le core aurait notifié */
  intelligent_decision: boolean;
  /** Type de divergence entre legacy et core */
  divergence_type:      DivergenceType;
  /** intelligent_score − legacy_score (positif = core voit plus d'intérêt) */
  score_delta:          number;
  /** Si un appel LLM a été fait dans ce run shadow (false en V1 pour evaluateCritere) */
  llm_used:             boolean;
  /** Message d'erreur si le run shadow a levé une exception, null sinon */
  shadow_error:         string | null;
  /** Durée du run shadow en millisecondes */
  duration_ms:          number;
  // ── S1.5 fields (optionnels — présents uniquement si reranker actif) ─────────
  /** Preuve textuelle du reranker (null si reranker non déclenché) */
  rerank_evidence?:     string | null;
  /** true si le reranker a été déclenché pour ce BC (signal de service détecté) */
  rerank_window_hit?:   boolean;
  /** true si legacy=true et intelligent_decision=false (FP candidat potentiel) */
  shadow_fp_candidate?: boolean;
}

// ─── ShadowOpportunity ────────────────────────────────────────────────────────

/**
 * Opportunité cachée détectée par le Shadow Runner via l'OpportunityDetector.
 * Miroir exact de la table shadow_opportunity — prêt à être inséré en Supabase.
 *
 * En V1, retourné par detectOpportunities() sans être persisté.
 * Garanties : aucune notification, aucun effet de bord.
 */
export interface ShadowOpportunity {
  /** Timestamp ISO 8601 du run */
  run_ts:               string;
  /** Identifiant du BC */
  bc_id:                string;
  /** Identifiant du client */
  client_id:            string;
  /** Libellé court de l'opportunité détectée */
  opportunity_label:    string;
  /** Explication de pourquoi cette opportunité est cachée */
  reason:               string;
  /** Score de confiance [0, 1] */
  confidence_score:     number;
  /** Articles du BC ayant déclenché l'opportunité */
  matched_articles:     readonly string[];
  /** Signaux cachés détectés */
  hidden_signals:       readonly string[];
  /** Preuve textuelle (obligatoire, non vide) */
  evidence:             string;
  /** Score legacy au moment de la détection */
  legacy_score:         number;
  /** true si le legacy avait quand même notifié ce BC */
  was_notified_legacy:  boolean;
}

// ─── Résultats discriminés ────────────────────────────────────────────────────

/**
 * Résultat de evaluateCritere().
 * Discriminé par `skipped`.
 *
 *   { skipped: true,  reason }     — run ignoré volontairement (skip propre)
 *   { skipped: false, log }        — log de comparaison produit
 */
export type ShadowEvaluateResult =
  | { skipped: true;  reason: ShadowSkipReason }
  | { skipped: false; log: ShadowRunLog };

/**
 * Résultat de detectOpportunities().
 * Discriminé par `skipped`.
 *
 *   { skipped: true,  reason }           — run ignoré volontairement
 *   { skipped: false, opportunities }    — liste des opportunités détectées (peut être vide)
 */
export type ShadowDetectResult =
  | { skipped: true;  reason: DetectSkipReason }
  | { skipped: false; opportunities: readonly ShadowOpportunity[] };

// ─── Paramètres d'entrée ──────────────────────────────────────────────────────

/**
 * Paramètres de evaluateCritere().
 *
 * Le runner évalue le BC complet contre tous les critères actifs du client,
 * mais log le résultat contre le critere_id passé en paramètre.
 * (En J1, ce sera le critère qui a déclenché l'appel dans le pipeline legacy.)
 */
export interface EvaluateCritereParams {
  /** BC parsé à évaluer — non muté */
  bc:               ParsedBC;
  /** Profil client complet — non muté */
  client:           ClientProfile;
  /** ID du critère observé (pour le log — identifie la paire BC × critère) */
  critere_id:       string;
  /** Score donné par le legacy pour ce BC × client */
  legacy_score:     number;
  /** Décision legacy : true = notifié, false = ignoré ou reranked */
  legacy_decision:  boolean;
}

/**
 * Paramètres de detectOpportunities().
 *
 * Ne déclenche l'OpportunityDetector que si toutes les conditions sont remplies :
 *   - shadow_mode_enabled = true
 *   - shadow_llm_enabled = true
 *   - legacy_score < OPPORTUNITY_DETERMINISTIC_MAX
 *   - was_notified_legacy = false
 */
export interface DetectOpportunitiesParams {
  /** BC parsé à analyser — non muté */
  bc:                   ParsedBC;
  /** Profil client complet — non muté */
  client:               ClientProfile;
  /** Score legacy pour ce BC × client */
  legacy_score:         number;
  /** true si le legacy a notifié ce BC pour ce client */
  was_notified_legacy:  boolean;
}