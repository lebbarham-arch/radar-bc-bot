'use strict';

/**
 * scripts/review-explainer.js — GD-034
 *
 * Explication assistive rule-based pour les candidats review (shadow/local uniquement).
 *
 * Principes :
 *  - Aucun appel réseau, aucun secret requis.
 *  - Mode déterministe (rule-based-v1) — interface prête pour futur LLM.
 *  - L'IA explique uniquement. La décision finale reste humaine (keep/reject/ignore).
 *  - ai_suggested_decision est TOUJOURS "review" : jamais de validation automatique.
 *  - Aucune règle spécifique à un signal ou à un client.
 *
 * Usage :
 *   var explainer = require('./review-explainer');
 *   var result = explainer.explainReviewCandidate(entry);
 *   // result.ai_review_explanation  — texte narratif
 *   // result.ai_relevance_reasons   — tableau de raisons de pertinence
 *   // result.ai_risk_reasons        — tableau de raisons de risque / faux positif
 *   // result.ai_suggested_decision  — toujours "review"
 *   // result.ai_confidence          — "low" | "medium" | "high"
 *   // result.ai_review_model        — identifiant du moteur
 *   // result.ai_review_generated_at — ISO 8601
 */

var EXPLAINER_MODEL     = 'rule-based-v1';
var STRONG_THRESHOLD    = 15;
var WEAK_THRESHOLD      = 5;

/**
 * Génère une explication assistive pour un candidat review.
 *
 * @param {object} entry   — entrée enrichie (champs du shadow JSON clean_only[])
 * @param {object} [opts]  — { generatedAt: string ISO, signalRiskTable: object }
 * @returns {object}       — champs ai_* (voir en-tête)
 */
function explainReviewCandidate(entry, opts) {
  opts = opts || {};
  var generatedAt    = opts.generatedAt || new Date().toISOString();
  var riskTable      = opts.signalRiskTable || {};   // normSig → verdict (Très fiable / Ambigu / Risqué…)

  // ── Extraction des champs d'entrée ──────────────────────────────────────────
  var score        = entry.clean_score != null ? Number(entry.clean_score) : 0;
  var sigs         = (entry.matched_signals || []).filter(function(s) {
    return s.indexOf('bloque(') === -1;
  });
  var origin       = entry.signal_origin  || 'unknown';
  var hintBlock    = !!entry.hint_block_auto;
  var hintApplied  = entry.hint_applied   ? String(entry.hint_applied) : null;
  var hintAdj      = entry.hint_score_adj != null ? Number(entry.hint_score_adj) : 0;
  var weakSingle   = !!entry.weak_single_signal;
  var exclHit      = !!entry.exclusion_hit;
  var strengthRsn  = entry.strength_reason || null;

  // ── Raisons de pertinence ──────────────────────────────────────────────────
  var relevanceReasons = [];

  if (sigs.length > 0) {
    relevanceReasons.push(
      'Signal(s) détecté(s) : ' + sigs.join(', ') + '.'
    );
  }

  if (origin === 'primary') {
    relevanceReasons.push('Match issu de critères primaires — pertinence structurelle élevée.');
  } else if (origin === 'inclusion') {
    relevanceReasons.push('Match issu de critères d\'inclusion — confirme la thématique mais non discriminant seul.');
  }

  if (score >= STRONG_THRESHOLD) {
    var adj = hintAdj !== 0 ? ' (avant ajustement hint : ' + hintAdj + ')' : '';
    relevanceReasons.push('Score ' + score + ' ≥ ' + STRONG_THRESHOLD + ' : seuil fort atteint' + adj + '.');
  } else if (score >= WEAK_THRESHOLD) {
    relevanceReasons.push('Score ' + score + ' dans la plage review (' + WEAK_THRESHOLD + '–' + (STRONG_THRESHOLD - 1) + ').');
  }

  if (strengthRsn) {
    relevanceReasons.push('Raison de force : ' + strengthRsn + '.');
  }

  // Tier de risque signal depuis la table (si disponible)
  sigs.forEach(function(s) {
    var key    = normSigKey(s);
    var verdict = riskTable[key];
    if (verdict) {
      relevanceReasons.push('Signal "' + s + '" : tier ' + verdict + ' selon l\'historique des décisions.');
    }
  });

  // ── Raisons de risque / faux positif ──────────────────────────────────────
  var riskReasons = [];

  if (weakSingle) {
    riskReasons.push(
      'Signal unique de niveau secondaire — insuffisant seul pour confirmer la pertinence sans contexte primaire.'
    );
  }

  if (hintBlock) {
    var hintDetail = hintApplied ? ' (' + hintApplied + ')' : '';
    riskReasons.push(
      'Hint client actif' + hintDetail +
      ' : l\'auto-notification est bloquée sur la base des décisions historiques de ce client pour ce signal.'
    );
    if (hintAdj < 0) {
      var effective = score + hintAdj;
      riskReasons.push(
        'Ajustement de score appliqué : ' + hintAdj +
        ' (score effectif : ' + effective + ').'
      );
    }
  }

  if (exclHit) {
    riskReasons.push('Critère d\'exclusion déclenché — risque de faux positif élevé.');
  }

  if (sigs.length === 0) {
    riskReasons.push('Aucun signal thématique actif identifiable — correspondance probablement générique ou bruit.');
  }

  // ── Confiance ────────────────────────────────────────────────────────────
  // Déterministe, sans connaissance client-spécifique.
  // "high" n'est jamais émis : on ne valide jamais automatiquement.
  var confidence;
  if (sigs.length === 0 || weakSingle) {
    confidence = 'low';
  } else if (hintBlock || exclHit) {
    confidence = 'medium';
  } else if (sigs.length >= 2 && score >= STRONG_THRESHOLD) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // ── Décision suggérée : TOUJOURS "review" ─────────────────────────────────
  // L'IA n'auto-approuve ni n'auto-rejette. La décision reste humaine.
  var suggestedDecision = 'review';

  // ── Texte narratif ────────────────────────────────────────────────────────
  var parts = [];

  if (sigs.length > 0) {
    parts.push(
      'Ce BC contient ' + sigs.length + ' signal(s) actif(s) (' + sigs.join(', ') + ')' +
      (origin !== 'unknown' ? ', issu(s) de critères de type "' + origin + '"' : '') + '.'
    );
  } else {
    parts.push('Aucun signal thématique clair identifié dans ce BC.');
  }

  if (riskReasons.length > 0) {
    parts.push(riskReasons.join(' '));
  }

  if (relevanceReasons.length > 1) {
    // La première est déjà dans l'intro — ajouter le reste
    var extraRel = relevanceReasons.slice(1);
    if (extraRel.length > 0) {
      parts.push('Éléments de contexte : ' + extraRel.join(' '));
    }
  }

  parts.push('Décision recommandée : revue humaine (keep / reject / ignore).');

  var explanation = parts.join(' ');

  return {
    ai_review_explanation:  explanation,
    ai_relevance_reasons:   relevanceReasons,
    ai_risk_reasons:        riskReasons,
    ai_suggested_decision:  suggestedDecision,
    ai_confidence:          confidence,
    ai_review_model:        EXPLAINER_MODEL,
    ai_review_generated_at: generatedAt,
  };
}

// ── Utilitaire interne ────────────────────────────────────────────────────────
function normSigKey(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();
}

module.exports = {
  explainReviewCandidate: explainReviewCandidate,
  // Exposé pour les tests
  _normSigKey: normSigKey,
  EXPLAINER_MODEL: EXPLAINER_MODEL,
};
