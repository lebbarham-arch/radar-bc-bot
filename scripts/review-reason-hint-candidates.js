'use strict';

/**
 * scripts/review-reason-hint-candidates.js — GD-038
 *
 * Transforme les suggestions du rapport P7 (review-reason-learning-report)
 * en fichier JSON de "hint candidates" consultatifs, shadow-only.
 *
 * Principes STRICTS :
 *  - P8 ne doit PAS appliquer les hints.
 *  - P8 ne doit PAS modifier le scoring, les poids, les seuils.
 *  - P8 ne doit PAS modifier auto_notify_candidate / review_candidate / buckets.
 *  - Chaque candidate est status="candidate_pending_human_validation".
 *  - safety="shadow_only" est non négociable.
 *  - human_validation_required=true sur tous les candidates.
 *  - Aucune action interdite : auto_notify, boost_score, change_threshold, change_weight.
 *  - Pas de budget/prix/montant/estimation.
 *
 * Usage :
 *   var m = require('./review-reason-hint-candidates');
 *   var result = m.buildReviewReasonHintCandidates(p7Report, opts);
 */

var crypto = require('crypto');

var HINT_CANDIDATES_MODEL = 'rule-based-review-reason-hint-candidates-v1';

// ── Types de hint autorisés ───────────────────────────────────────────────────
var ALLOWED_HINT_TYPES = [
  'context_demote_to_review',
  'client_signal_demote_to_review',
  'context_keep_review_or_boost_candidate',
  'ignore_pattern_observed',
];

// ── Actions interdites ────────────────────────────────────────────────────────
var FORBIDDEN_ACTIONS = [
  'auto_notify',
  'boost_score',
  'change_threshold',
  'change_weight',
];

// ── candidate_id déterministe ─────────────────────────────────────────────────
/**
 * Génère un ID stable basé sur client+signal+context+reason+hint_type.
 * Utilise crypto.createHash si disponible, sinon fallback simple.
 */
function buildCandidateId(clientKey, signalKey, contextKey, reasonKey, hintType) {
  var raw = [
    String(clientKey  || ''),
    String(signalKey  || ''),
    String(contextKey || ''),
    String(reasonKey  || ''),
    String(hintType   || ''),
  ].join('|');

  try {
    var hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
    return 'rrhc_' + hash;
  } catch (_) {
    // Fallback déterministe sans crypto
    var h = 0;
    for (var i = 0; i < raw.length; i++) {
      h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
    }
    return 'rrhc_' + Math.abs(h).toString(16).padStart(8, '0');
  }
}

// ── Détermination de l'effet proposé ─────────────────────────────────────────
/**
 * Construit le proposed_effect selon le hint_type.
 * Aucune action interdite ne peut y figurer.
 *
 * @param {string} hintType
 * @param {object} meta  — { client_key, signal_key, context_key }
 * @returns {object}
 */
function buildProposedEffect(hintType, meta) {
  switch (hintType) {
    case 'context_demote_to_review':
      return {
        action: 'block_auto_and_send_to_review',
        scope:  'client_signal_context',
        applies_to: {
          client_key:  meta.client_key,
          signal_key:  meta.signal_key,
          context_key: meta.context_key,
        },
      };

    case 'client_signal_demote_to_review':
      return {
        action: 'send_to_review',
        scope:  'client_signal',
        applies_to: {
          client_key: meta.client_key,
          signal_key: meta.signal_key,
        },
      };

    case 'context_keep_review_or_boost_candidate':
      // Important : uniquement "candidate only", jamais auto_notify ni boost_score
      return {
        action: 'keep_review_candidate_only',
        scope:  'client_signal_context',
        applies_to: {
          client_key:  meta.client_key,
          signal_key:  meta.signal_key,
          context_key: meta.context_key,
        },
      };

    case 'ignore_pattern_observed':
      return {
        action: 'observe_only',
        scope:  'client_signal_context',
        applies_to: {
          client_key:  meta.client_key,
          signal_key:  meta.signal_key,
          context_key: meta.context_key,
        },
      };

    default:
      return {
        action: 'observe_only',
        scope:  'unknown',
        applies_to: {},
      };
  }
}

// ── normalizeSuggestedHint ────────────────────────────────────────────────────
/**
 * Normalise une suggestion P7 en structure standard pour transformation.
 * Retourne null si la suggestion ne peut pas être normalisée.
 *
 * @param {object} sugg  — suggestion P7 ou summary enrichi
 * @returns {object|null}
 */
function normalizeSuggestedHint(sugg) {
  if (!sugg || typeof sugg !== 'object') return null;

  var clientKey  = String(sugg.client_key  || '').trim();
  var signalKey  = String(sugg.signal_key  || '').trim();
  var contextKey = String(sugg.context_key || '').trim();
  var reasonKey  = String(sugg.reason_key  || '').trim();
  var hintType   = String(sugg.suggested_hint_type || sugg.hint_type || '').trim();
  var safety     = String(sugg.safety || '').trim();
  var confidence = String(sugg.confidence || sugg.context_confidence || '').trim();
  var totalDec   = typeof sugg.total_decisions === 'number' ? sugg.total_decisions : 0;
  var shouldSugg = sugg.should_suggest_hint === true;

  return {
    client_key:          clientKey,
    signal_key:          signalKey,
    context_key:         contextKey,
    reason_key:          reasonKey,
    hint_type:           hintType,
    safety:              safety,
    confidence:          confidence,
    total_decisions:     totalDec,
    should_suggest_hint: shouldSugg,
    dominant_decision:   String(sugg.dominant_decision || '').trim(),
    dominant_reason:     String(sugg.dominant_reason   || '').trim(),
    reject_rate:         typeof sugg.reject_rate === 'number' ? sugg.reject_rate : 0,
    keep_rate:           typeof sugg.keep_rate   === 'number' ? sugg.keep_rate   : 0,
    ignore_rate:         typeof sugg.ignore_rate === 'number' ? sugg.ignore_rate : 0,
    rationale:           String(sugg.rationale || '').trim(),
    suggested_action:    String(sugg.suggested_action || '').trim(),
  };
}

// ── validateHintCandidate ─────────────────────────────────────────────────────
/**
 * Valide un hint candidate : retourne { valid, errors }.
 *
 * @param {object} candidate
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateHintCandidate(candidate) {
  var errors = [];

  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['candidate est null ou non-objet'] };
  }

  // Champs sécurité obligatoires
  if (candidate.safety !== 'shadow_only') {
    errors.push('safety doit être "shadow_only", reçu: ' + candidate.safety);
  }
  if (candidate.status !== 'candidate_pending_human_validation') {
    errors.push('status doit être "candidate_pending_human_validation"');
  }
  if (candidate.human_validation_required !== true) {
    errors.push('human_validation_required doit être true');
  }

  // hint_type reconnu
  if (ALLOWED_HINT_TYPES.indexOf(candidate.hint_type) === -1) {
    errors.push('hint_type non reconnu: ' + candidate.hint_type);
  }

  // Actions interdites dans proposed_effect
  if (candidate.proposed_effect && candidate.proposed_effect.action) {
    var action = candidate.proposed_effect.action;
    if (FORBIDDEN_ACTIONS.indexOf(action) !== -1) {
      errors.push('action interdite dans proposed_effect: ' + action);
    }
  }

  // candidate_id présent
  if (!candidate.candidate_id || !String(candidate.candidate_id).startsWith('rrhc_')) {
    errors.push('candidate_id manquant ou invalide');
  }

  // client_key et signal_key non vides
  if (!candidate.client_key || candidate.client_key === 'unknown_client') {
    errors.push('client_key invalide');
  }
  if (!candidate.signal_key || candidate.signal_key === 'unknown_signal') {
    errors.push('signal_key invalide');
  }

  return { valid: errors.length === 0, errors: errors };
}

// ── buildReviewReasonHintCandidates ──────────────────────────────────────────
/**
 * Transforme les suggestions P7 en candidates P8.
 *
 * @param {object} p7Report  — rapport produit par buildReviewReasonLearningReport
 * @param {object} opts      — { generatedAt, sourceReport }
 * @returns {object}         — { model, generated_at, source_report, totals, candidates, skipped }
 */
function buildReviewReasonHintCandidates(p7Report, opts) {
  opts = opts || {};
  var genAt        = opts.generatedAt  || new Date().toISOString();
  var sourceReport = opts.sourceReport || '';

  var candidates = [];
  var skipped    = [];

  var inputSuggestions = [];

  // Extraire les suggestions depuis le rapport P7
  if (p7Report && Array.isArray(p7Report.suggested_hints)) {
    inputSuggestions = p7Report.suggested_hints;
  } else if (p7Report && Array.isArray(p7Report.clients)) {
    // Fallback : parcourir les clients → groups → suggestions
    p7Report.clients.forEach(function(client) {
      (client.groups || []).forEach(function(g) {
        if (g.suggestion) {
          // Fusionner summary dans la suggestion pour avoir les métriques
          var merged = Object.assign({}, g.suggestion, g.summary || {});
          inputSuggestions.push(merged);
        }
      });
    });
  }

  inputSuggestions.forEach(function(rawSugg) {
    var norm = normalizeSuggestedHint(rawSugg);
    if (!norm) {
      skipped.push({ reason: 'normalisation impossible', source: JSON.stringify(rawSugg).slice(0, 80) });
      return;
    }

    // ── Filtres d'inclusion ───────────────────────────────────────────────────
    if (!norm.should_suggest_hint) {
      skipped.push({ reason: 'should_suggest_hint=false', source: norm.client_key + '/' + norm.signal_key });
      return;
    }
    if (norm.safety !== 'shadow_only') {
      skipped.push({ reason: 'safety != shadow_only (' + norm.safety + ')', source: norm.client_key + '/' + norm.signal_key });
      return;
    }
    if (norm.confidence !== 'medium' && norm.confidence !== 'high') {
      skipped.push({ reason: 'confidence non qualifiée (' + norm.confidence + ')', source: norm.client_key + '/' + norm.signal_key });
      return;
    }
    if (norm.total_decisions < 3) {
      skipped.push({ reason: 'total_decisions < 3 (' + norm.total_decisions + ')', source: norm.client_key + '/' + norm.signal_key });
      return;
    }
    if (!norm.client_key || norm.client_key === 'unknown_client') {
      skipped.push({ reason: 'client_key invalide', source: norm.client_key });
      return;
    }
    if (!norm.signal_key || norm.signal_key === 'unknown_signal' || norm.signal_key === '_none_') {
      skipped.push({ reason: 'signal_key invalide (' + norm.signal_key + ')', source: norm.signal_key });
      return;
    }
    if (ALLOWED_HINT_TYPES.indexOf(norm.hint_type) === -1) {
      skipped.push({ reason: 'hint_type non reconnu (' + norm.hint_type + ')', source: norm.hint_type });
      return;
    }

    // ── Construction du candidate ─────────────────────────────────────────────
    var candidateId = buildCandidateId(
      norm.client_key, norm.signal_key, norm.context_key, norm.reason_key, norm.hint_type
    );

    var proposedEffect = buildProposedEffect(norm.hint_type, {
      client_key:  norm.client_key,
      signal_key:  norm.signal_key,
      context_key: norm.context_key,
    });

    var candidate = {
      candidate_id:              candidateId,
      client_key:                norm.client_key,
      signal_key:                norm.signal_key,
      context_key:               norm.context_key,
      reason_key:                norm.reason_key,
      hint_type:                 norm.hint_type,
      proposed_effect:           proposedEffect,
      safety:                    'shadow_only',
      status:                    'candidate_pending_human_validation',
      confidence:                norm.confidence,
      human_validation_required: true,
      evidence: {
        total_decisions:   norm.total_decisions,
        dominant_decision: norm.dominant_decision,
        dominant_reason:   norm.dominant_reason,
        reject_rate:       norm.reject_rate,
        keep_rate:         norm.keep_rate,
        ignore_rate:       norm.ignore_rate,
      },
      rationale:      norm.rationale,
      suggested_action: norm.suggested_action,
      created_from:   sourceReport,
    };

    // Validation finale
    var validation = validateHintCandidate(candidate);
    if (!validation.valid) {
      skipped.push({
        reason: 'validation échouée : ' + validation.errors.join('; '),
        source: candidateId,
      });
      return;
    }

    candidates.push(candidate);
  });

  // ── Totaux par type ───────────────────────────────────────────────────────
  var byType = {};
  candidates.forEach(function(c) {
    byType[c.hint_type] = (byType[c.hint_type] || 0) + 1;
  });

  return {
    model:         HINT_CANDIDATES_MODEL,
    generated_at:  genAt,
    source_report: sourceReport,
    totals: {
      input_suggestions: inputSuggestions.length,
      candidates:        candidates.length,
      skipped:           skipped.length,
      by_type:           byType,
    },
    candidates: candidates,
    skipped:    skipped,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  buildReviewReasonHintCandidates: buildReviewReasonHintCandidates,
  normalizeSuggestedHint:          normalizeSuggestedHint,
  validateHintCandidate:           validateHintCandidate,
  HINT_CANDIDATES_MODEL:           HINT_CANDIDATES_MODEL,
  ALLOWED_HINT_TYPES:              ALLOWED_HINT_TYPES,
  FORBIDDEN_ACTIONS:               FORBIDDEN_ACTIONS,
  // exposés pour tests
  _buildCandidateId:    buildCandidateId,
  _buildProposedEffect: buildProposedEffect,
};
