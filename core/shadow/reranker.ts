/**
 * Shadow Reranker — Anaho S1.5
 *
 * Reranker advisory intégré au Shadow Path uniquement.
 * Option C : intervient sur les BCs portant des signaux de service dans leurs
 * articles (formation, maintenance, audit, entretien…), indépendamment du score.
 *
 * Garanties structurelles :
 *   - delta borné à [-5, +5] (RERANK_DELTA_MIN / RERANK_DELTA_MAX)
 *   - evidence obligatoire et non vide si delta ≠ 0
 *   - aucune notification déclenchée
 *   - aucune mutation du score déterministe
 *   - aucun accès Supabase ou DB
 *   - skip propre si signal absent → ShadowRerankResult { skipped: true }
 *   - jamais d'exception propagée vers le pipeline appelant
 *
 * Activation :
 *   - SHADOW_RERANK_ENABLED = true
 *   - SHADOW_LLM_ENABLED    = true  (pré-condition — vérifiée dans runner.ts)
 *
 * Règle : jamais de `any`.
 */

import { type ParsedBC }       from '@core/schemas/bc.schema';
import { RERANK_DELTA_MIN, RERANK_DELTA_MAX } from '@core/ai/constants';
import {
  type ShadowRerankParams,
  type ShadowRerankResult,
  type ShadowRerankSkipReason,
} from './types';

// ─── Constantes Option C ──────────────────────────────────────────────────────

/**
 * Signaux lexicaux indiquant qu'un BC porte une prestation de service
 * plutôt qu'un achat de fourniture.
 *
 * Critère d'activation Option C :
 *   Au moins un signal présent dans les articles (designation + specifications)
 *   ou dans l'objet du BC → le reranker est candidat.
 *
 * Source : analyse des cas S0-023..026 (formation, maintenance, entretien, audit).
 * Liste conservatrice : pas de mots trop courts ou ambigus.
 */
export const SHADOW_SERVICE_SIGNALS: readonly string[] = [
  'contrat',
  'formation',
  'maintenance',
  'entretien',
  'audit',
  'prestation',
  'expertise',
  'reparation',
  'diagnostic',
] as const;

/**
 * Delta appliqué quand un signal de service est détecté.
 * Négatif : le reranker suggère que le score déterministe surestime l'intérêt.
 * Borné à RERANK_DELTA_MIN (-5) — le runner re-clampe par sécurité.
 */
export const SERVICE_SIGNAL_DELTA = RERANK_DELTA_MIN; // -5

/** Source loggée dans shadow_run_log.rerank_source */
export const SHADOW_RERANKER_SOURCE = 'shadow_service_signal_v1';

// ─── Helpers purs ─────────────────────────────────────────────────────────────

/**
 * Normalise une chaîne pour la comparaison de signaux :
 * lowercase + NFD sans diacritiques + caractères non-alpha remplacés par espace.
 */
export function normForSignal(str: string): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Détecte si un BC contient au moins un signal de service (Option C).
 *
 * Recherche dans :
 *   1. designation + specifications de chaque article
 *   2. objet du BC
 *   3. bodyText du BC
 *
 * Retourne le premier signal trouvé, ou null si aucun.
 */
export function detectServiceSignal(bc: ParsedBC): string | null {
  const articleText = bc.articles
    .map(a => `${a.designation ?? ''} ${a.specifications ?? ''}`)
    .join(' ');
  const fullText = normForSignal(
    `${articleText} ${bc.objet} ${bc.bodyText}`,
  );

  for (const signal of SHADOW_SERVICE_SIGNALS) {
    // Correspondance mot entier (pas de sous-chaîne : évite "contrat" dans "contractuel")
    const pattern = new RegExp(`\\b${signal}\\b`);
    if (pattern.test(fullText)) {
      return signal;
    }
  }
  return null;
}

/**
 * Construit l'evidence obligatoire pour un delta ≠ 0.
 * Format : source + signal détecté + BC + score.
 */
export function buildRerankEvidence(
  signal:    string,
  bcId:      string,
  detScore:  number,
  delta:     number,
): string {
  return (
    `signal_service="${signal}" bc_id=${bcId} det_score=${detScore.toFixed(1)} ` +
    `delta=${delta} source=${SHADOW_RERANKER_SOURCE} — ` +
    `Prestation de service détectée. Le score déterministe peut surestimer ` +
    `l'intérêt d'achat pour un critère "fourniture".`
  );
}

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * Interface du Reranker Shadow — injectable dans ShadowRunner.
 *
 * Contrat :
 *   - Ne jamais propager d'exception
 *   - Retourner un ShadowRerankResult discriminé
 *   - delta dans [-5, +5] (le runner re-clampe par sécurité)
 *   - evidence non vide si skipped = false
 */
export interface IShadowReranker {
  rerank(params: ShadowRerankParams): Promise<ShadowRerankResult>;
}

// ─── ShadowServiceSignalReranker ──────────────────────────────────────────────

/**
 * Reranker shadow Option C — détection de signaux de service.
 *
 * Logique :
 *   1. Cherche un signal de service dans les articles + objet + bodyText
 *   2. Si signal trouvé → delta = SERVICE_SIGNAL_DELTA (-5) + evidence
 *   3. Si aucun signal    → skip (no_service_signal)
 *
 * Design advisory :
 *   Ce reranker ne consulte pas de LLM. Il est purement déterministe.
 *   Son rôle en S1.5 est de valider le pipeline d'intégration du reranker
 *   dans le shadow path avant de brancher un reranker LLM réel.
 *
 * Utilisation :
 *   const reranker = new ShadowServiceSignalReranker();
 *   const result   = await reranker.rerank({ bc, det_score, threshold, critere_valeurs });
 */
export class ShadowServiceSignalReranker implements IShadowReranker {
  async rerank(params: ShadowRerankParams): Promise<ShadowRerankResult> {
    try {
      const signal = detectServiceSignal(params.bc);

      if (signal === null) {
        return { skipped: true, reason: 'no_service_signal' };
      }

      const delta    = SERVICE_SIGNAL_DELTA; // = -5, borné par constante
      const evidence = buildRerankEvidence(
        signal,
        params.bc.id,
        params.det_score,
        delta,
      );

      return {
        skipped:  false,
        delta,
        evidence,
        source:   SHADOW_RERANKER_SOURCE,
      };

    } catch (err: unknown) {
      // Le reranker ne doit jamais propager d'exception
      // En cas d'erreur inattendue : skip propre avec raison no_service_signal
      return { skipped: true, reason: 'no_service_signal' };
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Crée une instance de ShadowServiceSignalReranker.
 * Point d'entrée recommandé pour l'injection dans ShadowRunner.
 */
export function createShadowReranker(): IShadowReranker {
  return new ShadowServiceSignalReranker();
}
