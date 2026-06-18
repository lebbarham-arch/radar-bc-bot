'use strict';

/**
 * scripts/review-reason-learning-report.js — GD-037
 *
 * Rapport local d'apprentissage basé sur les raisons humaines de review.
 * Consultatif uniquement — ne modifie rien au moteur, au scoring, ni aux candidats.
 *
 * Principes :
 *  - Aucun appel réseau, aucun secret, aucune règle signal/client hardcodée.
 *  - Rule-based déterministe.
 *  - Groupement : client × signal × contexte × raison humaine.
 *  - Suggestions consultatives uniquement (safety: "shadow_only").
 *  - Jamais de règle globale ("toujours rejeter X", "toujours accepter X").
 *  - Pas de budget/prix/montant/estimation.
 *
 * Usage :
 *   var m = require('./review-reason-learning-report');
 *   var report = m.buildReviewReasonLearningReport(entries, opts);
 */

var LEARNING_MODEL = 'rule-based-review-reason-learning-v1';

// ── Helpers de normalisation ──────────────────────────────────────────────────

function normStr(s) {
  return String(s || '').trim();
}

/** Extrait une liste de signaux depuis un champ string ou array. */
function parseSignals(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map(function(s) { return normStr(s); })
      .filter(function(s) { return s && s.indexOf('bloque(') === -1; });
  }
  // string avec séparateur virgule/point-virgule
  return String(raw).split(/[,;]/)
    .map(function(s) { return normStr(s); })
    .filter(function(s) { return s && s.indexOf('bloque(') === -1; });
}

/** Clé de signal canonique (premier signal actif, ou "_none_"). */
function signalKey(entry) {
  var sigs = parseSignals(entry.matched_signals);
  if (sigs.length === 0) return '_none_';
  // Trier pour déterminisme, prendre le premier alphabétiquement
  return sigs.slice().sort().join('+');
}

/**
 * Clé de contexte : extrait un label contextuel générique stable depuis les champs CTX.
 * Priorité : ctx_learnable_context_hint (connu) > ctx_context_key > neg_terms → medical_admin_context > hint libre > no_context
 * Jamais de règle client-specific ou signal-specific.
 */
var KNOWN_CONTEXT_LABELS = [
  'medical_admin_context', 'cleaning_disinfection_context', 'food_or_beverage_context',
  'office_supplies_context', 'it_context', 'event_context', 'construction_or_works_context',
];
var MEDICAL_NEGATIVE_TERMS = [
  'medico', 'materiel medico', 'medico technique', 'dmsps', 'santé', 'sante',
  'ministère de la santé', 'ministere de la sante', 'délégation de la santé',
  'delegation de la sante', 'hygiène du milieu', 'hygiene du milieu',
  "unite d'hygiène", "unite d'hygiene", 'centre hospitalier',
  'hopital', 'hôpital', 'chp ', 'chr ', 'chu ',
];
function contextKey(entry) {
  // 1. ctx_learnable_context_hint — si c'est un label générique reconnu
  var hint = normStr(entry.ctx_learnable_context_hint || '');
  if (hint && KNOWN_CONTEXT_LABELS.indexOf(hint) !== -1) return hint;

  // 2. ctx_context_key ou context_key — si non-vide et non générique
  var ctk = normStr((entry.ctx_context_key || entry.context_key || ''));
  if (ctk && ctk !== 'no_context' && ctk !== 'unknown_context') return ctk;

  // 3. Dériver depuis ctx_negative_context_terms → medical_admin_context
  var neg = entry.ctx_negative_context_terms;
  if (Array.isArray(neg) && neg.length > 0) {
    var negLow = neg.map(function(t) { return normStr(String(t || '')); });
    var isMedical = MEDICAL_NEGATIVE_TERMS.some(function(term) {
      return negLow.some(function(t) { return t.indexOf(term) !== -1; });
    });
    if (isMedical) return 'medical_admin_context';
  }

  // 4. ctx_learnable_context_hint — valeur libre non nulle (label inconnu mais présent)
  if (hint) return hint;

  return 'no_context';
}

/** Clé client. */
function clientKey(entry) {
  var c = normStr(entry.client) || normStr(entry.client_name) || normStr(entry.client_id);
  return c || 'unknown_client';
}

/** Clé de raison humaine. */
function reasonKey(entry) {
  var r = normStr(entry.human_review_reason);
  return r || 'unspecified';
}

/** Décision normalisée. */
function decisionKey(entry) {
  var d = normStr(entry.decision).toLowerCase();
  if (d === 'keep' || d === 'reject' || d === 'ignore') return d;
  return '';
}

// ── summarizeReviewReasonGroup ────────────────────────────────────────────────
/**
 * Calcule les métriques pour un groupe d'entrées (même client+signal+ctx+reason).
 *
 * @param {Array}  group   — liste d'entrées du groupe
 * @returns {object}       — métriques du groupe
 */
function summarizeReviewReasonGroup(group) {
  var total       = group.length;
  var keepCount   = 0;
  var rejectCount = 0;
  var ignoreCount = 0;
  var pendingCount = 0;

  group.forEach(function(e) {
    var d = decisionKey(e);
    if (d === 'keep')   keepCount++;
    else if (d === 'reject') rejectCount++;
    else if (d === 'ignore') ignoreCount++;
    else pendingCount++;
  });

  var totalDecisions = keepCount + rejectCount + ignoreCount;

  // Décision dominante
  var dominantDecision = '';
  var dominantCount = 0;
  if (keepCount >= rejectCount && keepCount >= ignoreCount) {
    dominantDecision = 'keep';   dominantCount = keepCount;
  } else if (rejectCount >= keepCount && rejectCount >= ignoreCount) {
    dominantDecision = 'reject'; dominantCount = rejectCount;
  } else {
    dominantDecision = 'ignore'; dominantCount = ignoreCount;
  }
  if (totalDecisions === 0) { dominantDecision = ''; dominantCount = 0; }

  // Raison dominante (parmi les décidées)
  var reasonCounts = {};
  group.forEach(function(e) {
    if (decisionKey(e)) {
      var r = reasonKey(e);
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    }
  });
  var dominantReason = '';
  var dominantReasonCount = 0;
  Object.keys(reasonCounts).forEach(function(r) {
    if (reasonCounts[r] > dominantReasonCount) {
      dominantReason = r;
      dominantReasonCount = reasonCounts[r];
    }
  });

  // Taux
  var rejectRate = totalDecisions > 0 ? Math.round(rejectCount / totalDecisions * 100) : 0;
  var keepRate   = totalDecisions > 0 ? Math.round(keepCount   / totalDecisions * 100) : 0;
  var ignoreRate = totalDecisions > 0 ? Math.round(ignoreCount / totalDecisions * 100) : 0;

  // Taux de dominance
  var dominanceRate = totalDecisions > 0
    ? Math.round(dominantCount / totalDecisions * 100)
    : 0;

  // Confidence prudente
  var confidence;
  if (totalDecisions >= 5 && dominanceRate >= 80) confidence = 'high';
  else if (totalDecisions >= 3 && dominanceRate >= 67) confidence = 'medium';
  else confidence = 'low';

  return {
    total:                total,
    total_decisions:      totalDecisions,
    keep_count:           keepCount,
    reject_count:         rejectCount,
    ignore_count:         ignoreCount,
    pending_review_count: pendingCount,
    dominant_decision:    dominantDecision,
    dominant_reason:      dominantReason,
    reject_rate:          rejectRate,
    keep_rate:            keepRate,
    ignore_rate:          ignoreRate,
    dominance_rate:       dominanceRate,
    confidence:           confidence,
  };
}

// ── suggestReviewReasonHint ───────────────────────────────────────────────────
/**
 * Génère une suggestion consultative à partir d'un résumé de groupe.
 * Ne rien appliquer. Consultatif uniquement.
 *
 * @param {object} summary   — sortie de summarizeReviewReasonGroup
 * @param {object} groupMeta — { client_key, signal_key, context_key, reason_key }
 * @returns {object}
 */
function suggestReviewReasonHint(summary, groupMeta) {
  var meta = groupMeta || {};
  var base = {
    client_key:          meta.client_key   || '',
    signal_key:          meta.signal_key   || '',
    context_key:         meta.context_key  || '',
    reason_key:          meta.reason_key   || '',
    should_suggest_hint: false,
    suggested_hint_type: '',
    suggested_action:    '',
    rationale:           '',
    safety:              'shadow_only',
    confidence:          summary.confidence || '',
    total_decisions:     summary.total_decisions || 0,
    dominant_decision:   summary.dominant_decision || '',
    dominant_reason:     summary.dominant_reason || '',
    reject_rate:         summary.reject_rate !== undefined ? summary.reject_rate : 0,
    keep_rate:           summary.keep_rate    !== undefined ? summary.keep_rate    : 0,
    ignore_rate:         summary.ignore_rate  !== undefined ? summary.ignore_rate  : 0,
  };

  if (summary.total_decisions < 3) {
    base.rationale = 'Pas assez de décisions (' + summary.total_decisions + ' < 3).';
    return base;
  }
  if (summary.confidence === 'low') {
    base.rationale = 'Confiance insuffisante (low) — dominance=' + summary.dominance_rate + '%.';
    return base;
  }

  var dom = summary.dominant_decision;
  var rea = summary.dominant_reason;

  if (dom === 'reject') {
    if (rea === 'mauvais_contexte' || rea === 'bon_signal_mauvais_contexte') {
      base.should_suggest_hint  = true;
      base.suggested_hint_type  = 'context_demote_to_review';
      base.suggested_action     = 'Bloquer l\'auto-notification et envoyer en review dans ce contexte pour ce client.';
      base.rationale            = 'Rejet répété (' + summary.reject_count + '/' + summary.total_decisions + ') pour raison "' + rea + '" dans ce contexte.';
    } else if (rea === 'hors_activite') {
      base.should_suggest_hint  = true;
      base.suggested_hint_type  = 'client_signal_demote_to_review';
      base.suggested_action     = 'Dégrader ce signal vers review pour ce client, sans règle globale.';
      base.rationale            = 'Rejet répété (' + summary.reject_count + '/' + summary.total_decisions + ') pour raison "hors_activite".';
    } else {
      // Autres raisons de rejet → suggestion prudente générique
      base.should_suggest_hint  = true;
      base.suggested_hint_type  = 'client_signal_demote_to_review';
      base.suggested_action     = 'Surveiller ce signal pour ce client — rejets répétés sans contexte précis identifié.';
      base.rationale            = 'Rejet répété (' + summary.reject_count + '/' + summary.total_decisions + ') — raison : "' + rea + '".';
    }
  } else if (dom === 'keep') {
    base.should_suggest_hint  = true;
    base.suggested_hint_type  = 'context_keep_review_or_boost_candidate';
    base.suggested_action     = 'Conserver comme signal pertinent dans ce contexte pour ce client. Ne pas basculer en auto-notify sans validation humaine.';
    base.rationale            = 'Maintiens répétés (' + summary.keep_count + '/' + summary.total_decisions + ') — signal jugé pertinent dans ce contexte.';
  } else if (dom === 'ignore') {
    base.should_suggest_hint  = true;
    base.suggested_hint_type  = 'ignore_pattern_observed';
    base.suggested_action     = 'Ne pas apprendre automatiquement ; motif ignoré observé — vérifier si le signal est trop générique.';
    base.rationale            = 'Ignores répétés (' + summary.ignore_count + '/' + summary.total_decisions + ').';
  } else {
    base.rationale = 'Décision dominante indéterminée.';
  }

  return base;
}

// ── buildReviewReasonLearningReport ──────────────────────────────────────────
/**
 * Construit le rapport complet d'apprentissage.
 *
 * @param {Array}  entries  — liste d'entrées review (depuis exports JSON)
 * @param {object} opts     — { generatedAt, sourceFiles }
 * @returns {object}        — rapport complet
 */
function buildReviewReasonLearningReport(entries, opts) {
  opts = opts || {};
  var genAt       = opts.generatedAt || new Date().toISOString();
  var sourceFiles = opts.sourceFiles || [];

  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      model:        LEARNING_MODEL,
      generated_at: genAt,
      source_files: sourceFiles,
      totals:       { entries: 0, with_decision: 0, pending_review: 0 },
      clients:      [],
      suggested_hints: [],
    };
  }

  // ── Groupement ──────────────────────────────────────────────────────────────
  var groups = {}; // key → entries[]

  entries.forEach(function(e) {
    var ck  = clientKey(e);
    var sk  = signalKey(e);
    var ctk = contextKey(e);
    var rk  = reasonKey(e);
    var key = [ck, sk, ctk, rk].join('||');

    if (!groups[key]) {
      groups[key] = {
        client_key:  ck,
        signal_key:  sk,
        context_key: ctk,
        reason_key:  rk,
        entries:     [],
      };
    }
    groups[key].entries.push(e);
  });

  // ── Métriques globales ──────────────────────────────────────────────────────
  var totalWithDecision = entries.filter(function(e) { return !!decisionKey(e); }).length;
  var totalPending      = entries.length - totalWithDecision;

  // ── Par client ──────────────────────────────────────────────────────────────
  var clientsMap = {};
  var allSuggestions = [];

  Object.keys(groups).forEach(function(key) {
    var g       = groups[key];
    var summary = summarizeReviewReasonGroup(g.entries);
    var suggestion = suggestReviewReasonHint(summary, {
      client_key:  g.client_key,
      signal_key:  g.signal_key,
      context_key: g.context_key,
      reason_key:  g.reason_key,
    });

    var groupRecord = {
      signal_key:          g.signal_key,
      context_key:         g.context_key,
      reason_key:          g.reason_key,
      summary:             summary,
      suggestion:          suggestion,
    };

    if (!clientsMap[g.client_key]) {
      clientsMap[g.client_key] = { client_key: g.client_key, groups: [] };
    }
    clientsMap[g.client_key].groups.push(groupRecord);

    if (suggestion.should_suggest_hint) {
      allSuggestions.push(suggestion);
    }
  });

  return {
    model:        LEARNING_MODEL,
    generated_at: genAt,
    source_files: sourceFiles,
    totals: {
      entries:         entries.length,
      with_decision:   totalWithDecision,
      pending_review:  totalPending,
      groups:          Object.keys(groups).length,
      suggested_hints: allSuggestions.length,
    },
    clients:         Object.values(clientsMap),
    suggested_hints: allSuggestions,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  buildReviewReasonLearningReport: buildReviewReasonLearningReport,
  summarizeReviewReasonGroup:      summarizeReviewReasonGroup,
  suggestReviewReasonHint:         suggestReviewReasonHint,
  LEARNING_MODEL:                  LEARNING_MODEL,
  // helpers exposés pour tests
  _parseSignals:  parseSignals,
  _signalKey:     signalKey,
  _contextKey:    contextKey,
  _clientKey:     clientKey,
  _reasonKey:     reasonKey,
  _decisionKey:   decisionKey,
};
