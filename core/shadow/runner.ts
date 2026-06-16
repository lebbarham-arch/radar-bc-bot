/**
 * Shadow Runner — Anaho
 *
 * Évalue le core intelligent en parallèle du legacy, sans aucun effet de bord.
 *
 * Ce module N'EST PAS branché dans radar-bc-bot.js.
 * Il sera appelé via des hooks fire-and-forget (Livrable 4) uniquement
 * après validation complète en staging.
 *
 * Garanties structurelles :
 *   - Si shadow_mode_enabled = false     → skip propre, zéro traitement
 *   - Si client ne correspond pas        → skip propre
 *   - Si BC exclu par sample_rate        → skip propre
 *   - Aucune notification déclenchée
 *   - Aucun accès Supabase direct (V1)
 *   - Aucune mutation des entrées
 *   - Le scoring déterministe reste l'autorité finale
 *   - Le core observe uniquement
 *
 * Règle : jamais de `any`.
 */

import { scoreBC }                        from '@core/scoring/engine';
import { getActiveCriteres, getEffectiveThreshold } from '@core/schemas/client.schema';
import { DEFAULT_WEIGHTS }               from '@core/feedback/types';
import {
  OPPORTUNITY_DETERMINISTIC_MAX,
  RERANK_DELTA_MIN,
  RERANK_DELTA_MAX,
} from '@core/ai/constants';
import { type OpportunityDetectorResult } from '@core/ai/opportunity-detector';

import {
  type ShadowConfig,
  type ShadowRunLog,
  type ShadowOpportunity,
  type ShadowEvaluateResult,
  type ShadowDetectResult,
  type EvaluateCritereParams,
  type DetectOpportunitiesParams,
  type DivergenceType,
} from './types';

import { type IShadowReranker } from './reranker';

// ─── Interface du détecteur d'opportunités ───────────────────────────────────

/**
 * Interface minimale pour l'OpportunityDetector.
 * Permet de mocker le détecteur dans les tests sans importer ses dépendances.
 * L'implémentation réelle est core/ai/opportunity-detector.ts::OpportunityDetector.
 */
export interface IShadowDetector {
  detect(rawInput: unknown): Promise<OpportunityDetectorResult>;
}

// ─── Log entry ────────────────────────────────────────────────────────────────

export interface ShadowLogEntry {
  level:     'info' | 'warn' | 'error';
  event:     string;
  bc_id?:    string;
  client_id?: string;
  message?:  string;
}

// ─── Helpers purs ─────────────────────────────────────────────────────────────

/**
 * Détermine le type de divergence entre la décision legacy et la décision core.
 *
 *   legacy=true  + core=true  → AGREE_NOTIFY    (les deux notifient)
 *   legacy=false + core=false → AGREE_SKIP       (les deux ignorent)
 *   legacy=true  + core=false → FALSE_POSITIVE   (legacy alarme, core ignorerait)
 *   legacy=false + core=true  → FALSE_NEGATIVE   (legacy rate, core notifierait)
 */
export function computeDivergence(
  legacyDecision:     boolean,
  intelligentDecision: boolean,
): DivergenceType {
  if ( legacyDecision &&  intelligentDecision) return 'AGREE_NOTIFY';
  if (!legacyDecision && !intelligentDecision) return 'AGREE_SKIP';
  if ( legacyDecision && !intelligentDecision) return 'FALSE_POSITIVE';
  return 'FALSE_NEGATIVE';
}

// ─── ShadowRunner ─────────────────────────────────────────────────────────────

/**
 * Shadow Runner — observe le core en parallèle du legacy.
 *
 * Construction :
 *   const runner = new ShadowRunner(config);
 *   // Avec detector (LLM opportunity detection) :
 *   const runner = new ShadowRunner(config, detector);
 *   // Avec detector + reranker (S1.5 — advisory reranking) :
 *   const runner = new ShadowRunner(config, detector, reranker);
 *
 * Usage (fire-and-forget — Livrable 4) :
 *   void runner.evaluateCritere(params).then(log => persistToSupabase(log));
 */
export class ShadowRunner {
  constructor(
    private readonly config:    ShadowConfig,
    private readonly detector:  IShadowDetector | null  = null,
    private readonly reranker:  IShadowReranker | null  = null,
    private readonly randomFn:  () => number            = Math.random,
    private readonly logger:    (entry: ShadowLogEntry) => void = () => { /* noop */ },
  ) {}

  // ── evaluateCritere ─────────────────────────────────────────────────────────

  /**
   * Compare la décision legacy avec la décision core pour un BC × critère × client.
   *
   * Le scoring déterministe est appelé avec tous les critères actifs du client.
   * Le critere_id est loggué comme identifiant de la paire (BC × critère) observée.
   *
   * S1.5 : si SHADOW_RERANK_ENABLED = true et un reranker est injecté,
   *        appelle le reranker advisory (Option C — signaux de service).
   *        Le delta est borné ±5. Aucune notification modifiée.
   *
   * @returns ShadowEvaluateResult discriminé par `skipped`
   */
  async evaluateCritere(params: EvaluateCritereParams): Promise<ShadowEvaluateResult> {
    // ── Guard 1 : feature flag ────────────────────────────────────────────────
    if (!this.config.shadow_mode_enabled) {
      return { skipped: true, reason: 'shadow_disabled' };
    }

    // ── Guard 2 : filtre client ───────────────────────────────────────────────
    if (!this.matchesClientFilter(params.client.id)) {
      return { skipped: true, reason: 'client_filtered' };
    }

    // ── Guard 3 : sample rate ─────────────────────────────────────────────────
    // randomFn() in [0, 1)
    //   sample_rate = 0.0 → toujours skip    (randomFn() >= 0.0 toujours vrai)
    //   sample_rate = 1.0 → jamais skip      (randomFn() < 1.0 toujours vrai)
    if (this.randomFn() >= this.config.shadow_bc_sample_rate) {
      return { skipped: true, reason: 'sample_excluded' };
    }

    // ── Évaluation ────────────────────────────────────────────────────────────
    const start = Date.now();

    try {
      const activeCriteres  = getActiveCriteres(params.client, 'bc');
      const scoreComponents = scoreBC(params.bc, params.client, activeCriteres, DEFAULT_WEIGHTS);
      const threshold       = getEffectiveThreshold(params.client);
      const detScore        = scoreComponents.final_score;

      // ── Reranker advisory (S1.5 — Option C) ────────────────────────────────
      // Activé uniquement si SHADOW_RERANK_ENABLED = true ET LLM activé ET reranker injecté.
      // Le delta est borné à [RERANK_DELTA_MIN, RERANK_DELTA_MAX] = [-5, +5].
      // Aucune notification n'est modifiée — advisory log uniquement.
      let rerankDelta    = 0;
      let rerankSource: string | null = null;
      let rerankEvidence: string | null = null;
      let rerankWindowHit = false;

      if (
        this.config.shadow_rerank_enabled === true &&
        this.config.shadow_llm_enabled    === true &&
        this.reranker !== null
      ) {
        const rerankResult = await this.reranker.rerank({
          bc:              params.bc,
          det_score:       detScore,
          threshold,
          critere_valeurs: activeCriteres.map(c => c.valeur),
        });

        if (!rerankResult.skipped) {
          rerankWindowHit = true;
          // Clamp défensif — le reranker garantit déjà ±5 mais on re-borne
          rerankDelta    = Math.max(RERANK_DELTA_MIN, Math.min(RERANK_DELTA_MAX, rerankResult.delta));
          rerankSource   = rerankResult.source;
          rerankEvidence = rerankResult.evidence;
        }
      }

      const intelligentScore    = detScore + rerankDelta;
      const intelligentDecision = intelligentScore >= threshold;
      const divergenceType      = computeDivergence(params.legacy_decision, intelligentDecision);

      // shadow_fp_candidate : legacy notifie mais le reranker suggère que core ne notifierait pas
      const shadowFpCandidate = params.legacy_decision && !intelligentDecision;

      const log: ShadowRunLog = {
        run_ts:               new Date().toISOString(),
        bc_id:                params.bc.id,
        client_id:            params.client.id,
        critere_id:           params.critere_id,
        legacy_score:         params.legacy_score,
        legacy_decision:      params.legacy_decision,
        det_score:            detScore,
        rerank_delta:         rerankDelta,
        rerank_source:        rerankSource,
        intelligent_score:    intelligentScore,
        intelligent_decision: intelligentDecision,
        divergence_type:      divergenceType,
        score_delta:          intelligentScore - params.legacy_score,
        llm_used:             false,
        shadow_error:         null,
        duration_ms:          Date.now() - start,
        // S1.5 fields
        rerank_evidence:      rerankEvidence,
        rerank_window_hit:    rerankWindowHit,
        shadow_fp_candidate:  shadowFpCandidate,
      };

      this.logger({
        level:     'info',
        event:     'shadow_evaluate_critere',
        bc_id:     params.bc.id,
        client_id: params.client.id,
      });

      return { skipped: false, log };

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      this.logger({
        level:     'error',
        event:     'shadow_evaluate_error',
        bc_id:     params.bc.id,
        client_id: params.client.id,
        message,
      });

      // Retourner un log d'erreur — le shadow mode ne doit jamais propager
      // d'exception vers le pipeline appelant
      const log: ShadowRunLog = {
        run_ts:               new Date().toISOString(),
        bc_id:                params.bc.id,
        client_id:            params.client.id,
        critere_id:           params.critere_id,
        legacy_score:         params.legacy_score,
        legacy_decision:      params.legacy_decision,
        det_score:            0,
        rerank_delta:         0,
        rerank_source:        null,
        intelligent_score:    0,
        intelligent_decision: false,
        divergence_type:      'AGREE_SKIP',
        score_delta:          0,
        llm_used:             false,
        shadow_error:         message,
        duration_ms:          Date.now() - start,
        rerank_evidence:      null,
        rerank_window_hit:    false,
        shadow_fp_candidate:  false,
      };

      return { skipped: false, log };
    }
  }

  // ── detectOpportunities ─────────────────────────────────────────────────────

  /**
   * Détecte des opportunités cachées dans des BCs faibles ou ignorés par le legacy.
   *
   * Appelle l'OpportunityDetector uniquement si toutes les conditions sont remplies :
   *   - shadow_mode_enabled = true
   *   - shadow_llm_enabled = true
   *   - legacy_score < OPPORTUNITY_DETERMINISTIC_MAX
   *   - was_notified_legacy = false
   *   - detector non null
   *   - critères actifs non vides
   *
   * Garanties : aucune notification, aucune mutation du profil client.
   *
   * @returns ShadowDetectResult discriminé par `skipped`
   */
  async detectOpportunities(params: DetectOpportunitiesParams): Promise<ShadowDetectResult> {
    // ── Guard 1 : feature flag ────────────────────────────────────────────────
    if (!this.config.shadow_mode_enabled) {
      return { skipped: true, reason: 'shadow_disabled' };
    }

    // ── Guard 2 : filtre client ───────────────────────────────────────────────
    if (!this.matchesClientFilter(params.client.id)) {
      return { skipped: true, reason: 'client_filtered' };
    }

    // ── Guard 3 : sample rate ─────────────────────────────────────────────────
    if (this.randomFn() >= this.config.shadow_bc_sample_rate) {
      return { skipped: true, reason: 'sample_excluded' };
    }

    // ── Guard 4 : LLM activé ─────────────────────────────────────────────────
    if (!this.config.shadow_llm_enabled) {
      return { skipped: true, reason: 'llm_disabled' };
    }

    // ── Guard 5 : score trop élevé (pré-condition du détecteur) ──────────────
    if (params.legacy_score >= OPPORTUNITY_DETERMINISTIC_MAX) {
      return { skipped: true, reason: 'score_too_high' };
    }

    // ── Guard 6 : BC déjà notifié par legacy ─────────────────────────────────
    // Inutile de chercher des opportunités si le legacy a déjà notifié
    if (params.was_notified_legacy) {
      return { skipped: true, reason: 'already_notified' };
    }

    // ── Guard 7 : détecteur disponible ───────────────────────────────────────
    if (this.detector === null) {
      return { skipped: true, reason: 'llm_disabled' };
    }

    // ── Préparer l'input du détecteur ─────────────────────────────────────────
    const activeCriteres = getActiveCriteres(params.client, 'bc');

    // Guard 8 : critères actifs (le détecteur exige critere_texts.length >= 1)
    if (activeCriteres.length === 0) {
      return { skipped: true, reason: 'no_active_criteres' };
    }

    // Recompute du score pour obtenir la décomposition → prompt plus riche
    const scoreComponents = scoreBC(params.bc, params.client, activeCriteres, DEFAULT_WEIGHTS);
    const scoreBreakdown: Record<string, number> = {
      title:          scoreComponents.title_score,
      content:        scoreComponents.content_score,
      article:        scoreComponents.article_score,
      business_intent: scoreComponents.business_intent_score,
      technical:      scoreComponents.technical_score,
      organization:   scoreComponents.organization_score,
      exclusion:      scoreComponents.contextual_exclusion_penalty,
    };

    const detectorInput = {
      bc_id:               params.bc.id,
      client_id:           params.client.id,
      bc_title:            params.bc.objet,
      bc_text_excerpt:     params.bc.bodyText.slice(0, 600),
      critere_texts:       activeCriteres.map(c => c.valeur),
      deterministic_score: params.legacy_score,
      score_breakdown:     scoreBreakdown,
      bc_is_low_scorer:    true as const,
    };

    // ── Appel au détecteur ────────────────────────────────────────────────────
    let detectorResult: OpportunityDetectorResult;
    try {
      detectorResult = await this.detector.detect(detectorInput);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger({
        level:     'error',
        event:     'shadow_detect_error',
        bc_id:     params.bc.id,
        client_id: params.client.id,
        message,
      });
      // Non-fatal : retourner une liste vide plutôt que de propager l'erreur
      return { skipped: false, opportunities: [] };
    }

    if (!detectorResult.ok) {
      this.logger({
        level:     'warn',
        event:     'shadow_detect_failed',
        bc_id:     params.bc.id,
        client_id: params.client.id,
        message:   detectorResult.error.message,
      });
      return { skipped: false, opportunities: [] };
    }

    // ── Mapper en ShadowOpportunity ───────────────────────────────────────────
    const runTs  = new Date().toISOString();
    const maxOpp = this.config.shadow_opportunity_max;

    const opportunities: ShadowOpportunity[] = detectorResult.output.opportunities
      .slice(0, maxOpp)
      .map(opp => ({
        run_ts:              runTs,
        bc_id:               params.bc.id,
        client_id:           params.client.id,
        opportunity_label:   opp.label,
        reason:              opp.reason,
        confidence_score:    opp.confidence_score,
        matched_articles:    [...opp.matched_articles],
        hidden_signals:      [...opp.hidden_signals],
        evidence:            opp.evidence,
        legacy_score:        params.legacy_score,
        was_notified_legacy: params.was_notified_legacy,
      }));

    this.logger({
      level:     opportunities.length > 0 ? 'info' : 'warn',
      event:     'shadow_detect_done',
      bc_id:     params.bc.id,
      client_id: params.client.id,
      message:   `${String(opportunities.length)} opportunité(s) détectée(s)`,
    });

    return { skipped: false, opportunities };
  }

  // ── Helpers privés ───────────────────────────────────────────────────────────

  /**
   * Vérifie si le client passe le filtre shadow_client_filter.
   * 'all' → tous les clients passent.
   * Sinon → uniquement le client dont l'id correspond.
   */
  private matchesClientFilter(clientId: string): boolean {
    return (
      this.config.shadow_client_filter === 'all' ||
      this.config.shadow_client_filter === clientId
    );
  }
}