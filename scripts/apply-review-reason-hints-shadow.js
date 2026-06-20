'use strict';

/**
 * scripts/apply-review-reason-hints-shadow.js — GD-039 / P9
 *
 * Applique les hint candidates P8 dans le shadow replay uniquement.
 *
 * Principes STRICTS (shadow-only) :
 *  - Ne s'applique QUE si status === "human_approved_for_shadow"
 *  - safety doit être "shadow_only"
 *  - human_validation_required doit être true
 *  - Ne modifie JAMAIS scoreBC(), les poids, les seuils, le scoring brut
 *  - Ne touche JAMAIS auto_notify_candidate en production
 *  - Retourne une copie enrichie — jamais de mutation de l'entrée source
 *  - Pas de réseau/API/IA externe, pas de process.env, pas de secret
 *
 * Statuses :
 *  - candidate_pending_human_validation → ignoré
 *  - human_rejected                     → ignoré
 *  - human_approved_for_shadow          → appliqué en shadow
 *  - applied / active                   → interdit → ignoré
 *
 * Actions reconnues :
 *  A) block_auto_and_send_to_review  → scope client_signal_context
 *  B) send_to_review                 → scope client_signal
 *  C) keep_review_candidate_only     → scope client_signal_context
 *  D) observe_only                   → scope client_signal_context
 *
 * Actions interdites (jamais exécutées) :
 *  auto_notify, boost_score, change_threshold, change_weight, apply_to_prod, activate
 */

var fs   = require('fs');
var path = require('path');

var APPLY_HINTS_MODEL = 'rule-based-apply-review-reason-hints-shadow-v1';

// ── Statuses et actions ───────────────────────────────────────────────────────
var STATUS_APPROVED_FOR_SHADOW = 'human_approved_for_shadow';

var ALLOWED_STATUSES_TO_SKIP = [
  'candidate_pending_human_validation',
  'human_rejected',
];

var FORBIDDEN_STATUSES = [
  'applied',
  'active',
];

var ALLOWED_ACTIONS = [
  'block_auto_and_send_to_review',
  'send_to_review',
  'keep_review_candidate_only',
  'observe_only',
];

var FORBIDDEN_ACTIONS = [
  'auto_notify',
  'boost_score',
  'change_threshold',
  'change_weight',
  'apply_to_prod',
  'activate',
];

var ALLOWED_SCOPES = [
  'client_signal_context',
  'client_signal',
];

// ── Normalisation des signaux ─────────────────────────────────────────────────
/**
 * Normalise un signal : trim + lowercase.
 */
function normSignal(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Extrait les signaux matchés depuis une entrée shadow.
 * Gère string avec virgules, tableau, ou champ matched_signals.
 * @param {object} entry
 * @returns {string[]}
 */
function extractMatchedSignals(entry) {
  var raw = entry.matched_signals;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normSignal).filter(Boolean);
  if (typeof raw === 'string') {
    return raw.split(',').map(normSignal).filter(Boolean);
  }
  return [];
}

// ── Matching client ───────────────────────────────────────────────────────────
/**
 * Vérifie si l'entrée correspond au client_key du hint.
 * Utilise entry.client || entry.client_key || entry.clientName.
 * Si client inconnu → pas d'application.
 */
function normClient(s) {
  if (!s) return '';
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function clientMatches(entry, hintClientKey) {
  if (!hintClientKey || hintClientKey === 'unknown_client') return false;
  var entryClient = String(entry.client || entry.client_key || entry.clientName || '').trim();
  if (!entryClient) return false;
  return normClient(entryClient) === normClient(hintClientKey);
}

// ── Matching signal ───────────────────────────────────────────────────────────
/**
 * Vérifie si l'entrée contient le signal_key du hint parmi ses matched_signals.
 * Normalise trim/lowercase pour la comparaison.
 */
function signalMatches(entry, hintSignalKey) {
  if (!hintSignalKey || hintSignalKey === 'unknown_signal' || hintSignalKey === '_none_') return false;
  var normHintSig = normSignal(hintSignalKey);
  var signals = extractMatchedSignals(entry);
  return signals.some(function(s) { return s === normHintSig; });
}

// ── Résolution contextuelle (miroir P7 contextKey) ───────────────────────────

var KNOWN_CONTEXT_LABELS_RRH = [
  'medical_admin_context',
  'cleaning_disinfection_context',
  'food_or_beverage_context',
  'office_supplies_context',
  'it_context',
  'event_context',
  'construction_or_works_context',
];

var MEDICAL_NEG_TERMS_RRH = [
  'medico', 'materiel medico', 'medico technique', 'dmsps', 'dmspsf',
  'santé', 'sante', 'ministère de la santé', 'delegation de la sante',
  'délégation de la santé', 'centre hospitalier', 'hopital', 'hôpital',
  'chp', 'chr', 'hygiène du milieu',
];

var CLEANING_TERMS_RRH = [
  'desinfection', 'désinfection', 'deratisation', 'dératisation',
  'desinsectisation', 'désinsectisation', 'nettoyage', 'nettoiement',
];

/**
 * Résout le context_key d'une entry shadow selon l'ordre :
 *  A. ctx_context_key explicite non-vide / non-no_context
 *  B. ctx_learnable_context_hint contient un label connu
 *  C. ctx_negative_context_terms : termes médicaux → medical_admin_context
 *     ctx_negative/positive_context_terms : termes nettoyage → cleaning_disinfection_context
 *  D. no_context
 *
 * Logique identique à contextKey() dans review-reason-learning-report.js.
 */
function resolveEntryContextKey(entry) {
  // A. ctx_context_key explicite
  var ctk = String(entry.ctx_context_key || entry.context_key || '').trim();
  if (ctk && ctk !== 'no_context' && ctk !== 'unknown_context') return ctk;

  // B. ctx_learnable_context_hint contient un label connu (substring)
  var hint = String(entry.ctx_learnable_context_hint || '').toLowerCase();
  for (var _li = 0; _li < KNOWN_CONTEXT_LABELS_RRH.length; _li++) {
    if (hint.indexOf(KNOWN_CONTEXT_LABELS_RRH[_li]) !== -1) return KNOWN_CONTEXT_LABELS_RRH[_li];
  }

  // C. ctx_negative_context_terms
  var neg = entry.ctx_negative_context_terms;
  if (Array.isArray(neg) && neg.length > 0) {
    var negLow = neg.map(function(t) { return String(t || '').toLowerCase(); });
    var isMedical = MEDICAL_NEG_TERMS_RRH.some(function(term) {
      return negLow.some(function(t) { return t.indexOf(term) !== -1; });
    });
    if (isMedical) return 'medical_admin_context';
    var isCleaningNeg = CLEANING_TERMS_RRH.some(function(term) {
      return negLow.some(function(t) { return t.indexOf(term) !== -1; });
    });
    if (isCleaningNeg) return 'cleaning_disinfection_context';
  }

  // C2. ctx_positive_context_terms
  var pos = entry.ctx_positive_context_terms;
  if (Array.isArray(pos) && pos.length > 0) {
    var posLow = pos.map(function(t) { return String(t || '').toLowerCase(); });
    var isCleaningPos = CLEANING_TERMS_RRH.some(function(term) {
      return posLow.some(function(t) { return t.indexOf(term) !== -1; });
    });
    if (isCleaningPos) return 'cleaning_disinfection_context';
  }

  return 'no_context';
}

// ── Matching contexte ─────────────────────────────────────────────────────────
/**
 * Vérifie si l'entrée correspond au context_key du hint.
 * Utilise resolveEntryContextKey() — même logique que P7 contextKey() :
 *  A. ctx_context_key explicite
 *  B. ctx_learnable_context_hint (substring sur labels connus)
 *  C. ctx_negative/positive_context_terms (termes médicaux ou nettoyage)
 *  D. no_context (pas de match)
 */
function contextMatches(entry, hintContextKey) {
  if (!hintContextKey || hintContextKey === '') return true; // Scope non-contextuel

  var resolved = resolveEntryContextKey(entry);
  return resolved === hintContextKey;
}

// ── loadApprovedReviewReasonHints ─────────────────────────────────────────────
/**
 * Charge et filtre les hint candidates approuvés depuis un fichier JSON P8
 * ou depuis un objet déjà parsé.
 *
 * Filtre obligatoire :
 *  - safety === "shadow_only"
 *  - human_validation_required === true
 *  - status === "human_approved_for_shadow"
 *  - proposed_effect existe et action/scope/applies_to valides
 *  - candidate_id existe
 *
 * @param {string|object} pathOrObject  Chemin du fichier JSON P8 ou objet déjà parsé
 * @param {object} opts
 * @returns {{ approved_hints: object[], skipped: object[], totals: object }}
 */
function loadApprovedReviewReasonHints(pathOrObject, opts) {
  opts = opts || {};
  var approvedHints = [];
  var skipped       = [];
  var raw;

  // Charger si chemin
  if (typeof pathOrObject === 'string') {
    var fpath = path.resolve(pathOrObject);
    if (!fs.existsSync(fpath)) {
      return {
        approved_hints: [],
        skipped: [{ reason: 'Fichier introuvable', source: fpath }],
        totals: { input: 0, approved: 0, skipped: 1 },
      };
    }
    try {
      raw = JSON.parse(fs.readFileSync(fpath, 'utf8'));
    } catch (e) {
      return {
        approved_hints: [],
        skipped: [{ reason: 'JSON invalide : ' + e.message, source: fpath }],
        totals: { input: 0, approved: 0, skipped: 1 },
      };
    }
  } else if (pathOrObject && typeof pathOrObject === 'object') {
    raw = pathOrObject;
  } else {
    return {
      approved_hints: [],
      skipped: [{ reason: 'Argument invalide', source: String(pathOrObject) }],
      totals: { input: 0, approved: 0, skipped: 1 },
    };
  }

  var candidates = Array.isArray(raw) ? raw
    : Array.isArray(raw.candidates)   ? raw.candidates
    : [];

  candidates.forEach(function(c) {
    if (!c || typeof c !== 'object') {
      skipped.push({ reason: 'candidate null/non-objet', source: '' });
      return;
    }

    var cid     = String(c.candidate_id || '').trim();
    var safety  = String(c.safety || '').trim();
    var hvr     = c.human_validation_required;
    var status  = String(c.status || '').trim();
    var effect  = c.proposed_effect;

    // candidate_id obligatoire
    if (!cid) {
      skipped.push({ reason: 'candidate_id manquant', source: '' });
      return;
    }

    // safety obligatoire
    if (safety !== 'shadow_only') {
      skipped.push({ reason: 'safety != shadow_only (' + safety + ')', source: cid });
      return;
    }

    // human_validation_required obligatoire
    if (hvr !== true) {
      skipped.push({ reason: 'human_validation_required != true', source: cid });
      return;
    }

    // Statuses explicitement ignorés
    if (ALLOWED_STATUSES_TO_SKIP.indexOf(status) !== -1) {
      skipped.push({ reason: 'status ignoré (' + status + ')', source: cid });
      return;
    }

    // Statuses interdits (applied/active)
    if (FORBIDDEN_STATUSES.indexOf(status) !== -1) {
      skipped.push({ reason: 'status interdit (' + status + ')', source: cid });
      return;
    }

    // Seul human_approved_for_shadow est accepté
    if (status !== STATUS_APPROVED_FOR_SHADOW) {
      skipped.push({ reason: 'status non reconnu (' + status + ')', source: cid });
      return;
    }

    // proposed_effect obligatoire
    if (!effect || typeof effect !== 'object') {
      skipped.push({ reason: 'proposed_effect manquant', source: cid });
      return;
    }

    var action = String(effect.action || '').trim();
    var scope  = String(effect.scope  || '').trim();
    var applyTo = effect.applies_to || {};

    // Action interdite
    if (FORBIDDEN_ACTIONS.indexOf(action) !== -1) {
      skipped.push({ reason: 'action interdite : ' + action, source: cid });
      return;
    }

    // Action non reconnue
    if (ALLOWED_ACTIONS.indexOf(action) === -1) {
      skipped.push({ reason: 'action non reconnue : ' + action, source: cid });
      return;
    }

    // Scope non reconnu
    if (ALLOWED_SCOPES.indexOf(scope) === -1) {
      skipped.push({ reason: 'scope non reconnu : ' + scope, source: cid });
      return;
    }

    // client_key et signal_key obligatoires
    var clientKey = String(applyTo.client_key || c.client_key || '').trim();
    var signalKey = String(applyTo.signal_key || c.signal_key || '').trim();
    if (!clientKey || clientKey === 'unknown_client') {
      skipped.push({ reason: 'client_key invalide', source: cid });
      return;
    }
    if (!signalKey || signalKey === 'unknown_signal' || signalKey === '_none_') {
      skipped.push({ reason: 'signal_key invalide', source: cid });
      return;
    }

    approvedHints.push(c);
  });

  return {
    approved_hints: approvedHints,
    skipped:        skipped,
    totals: {
      input:    candidates.length,
      approved: approvedHints.length,
      skipped:  skipped.length,
    },
  };
}

// ── evaluateReviewReasonHintForEntry ──────────────────────────────────────────
/**
 * Évalue si un hint approuvé s'applique à une entrée shadow donnée.
 *
 * @param {object} entry  — entrée shadow enrichie
 * @param {object} hint   — hint approuvé (depuis loadApprovedReviewReasonHints)
 * @returns {{ matches: boolean, reason: string }}
 */
function evaluateReviewReasonHintForEntry(entry, hint) {
  if (!entry || !hint) return { matches: false, reason: 'entry ou hint null' };

  var effect  = hint.proposed_effect || {};
  var applyTo = effect.applies_to    || {};
  var scope   = String(effect.scope  || '').trim();
  var action  = String(effect.action || '').trim();

  var clientKey  = String(applyTo.client_key  || hint.client_key  || '').trim();
  var signalKey  = String(applyTo.signal_key  || hint.signal_key  || '').trim();
  var contextKey = String(applyTo.context_key || hint.context_key || '').trim();

  // Action interdite → pas de match
  if (FORBIDDEN_ACTIONS.indexOf(action) !== -1) {
    return { matches: false, reason: 'action interdite : ' + action };
  }

  // Client match obligatoire
  if (!clientMatches(entry, clientKey)) {
    return { matches: false, reason: 'client_key ne correspond pas (' + clientKey + ')' };
  }

  // Signal match obligatoire
  if (!signalMatches(entry, signalKey)) {
    return { matches: false, reason: 'signal_key absent dans matched_signals (' + signalKey + ')' };
  }

  // Contexte match selon scope
  if (scope === 'client_signal_context') {
    if (contextKey && !contextMatches(entry, contextKey)) {
      return { matches: false, reason: 'context_key ne correspond pas (' + contextKey + ')' };
    }
  }

  return { matches: true, reason: 'client + signal' + (scope === 'client_signal_context' && contextKey ? ' + context' : '') + ' correspondent' };
}

// ── applyReviewReasonHintsToShadowEntry ───────────────────────────────────────
/**
 * Applique les hints approuvés qui matchent une entrée.
 * Retourne une COPIE de l'entrée enrichie avec les champs RRH.
 * Ne mute jamais l'entrée source.
 * Ne modifie jamais le score brut ni scoreBC() ni les thresholds.
 *
 * @param {object}   entry   Entrée shadow enrichie
 * @param {object[]} hints   Liste des hints approuvés (depuis loadApprovedReviewReasonHints)
 * @param {object}   opts
 * @returns {object}         Copie de l'entrée, éventuellement enrichie
 */
function applyReviewReasonHintsToShadowEntry(entry, hints, opts) {
  opts = opts || {};
  if (!entry || !Array.isArray(hints) || hints.length === 0) {
    return Object.assign({}, entry);
  }

  var matchedHints     = [];
  var appliedActions   = [];
  var explanations     = [];

  hints.forEach(function(hint) {
    var eval_ = evaluateReviewReasonHintForEntry(entry, hint);
    if (!eval_.matches) return;

    var action = String((hint.proposed_effect && hint.proposed_effect.action) || '').trim();
    matchedHints.push(hint.candidate_id);

    switch (action) {
      case 'block_auto_and_send_to_review':
        // Type A : bloquer auto, forcer review_candidate dans la copie shadow
        appliedActions.push(action);
        explanations.push(hint.rationale || 'hint_type=context_demote_to_review');
        break;

      case 'send_to_review':
        // Type B : forcer review_candidate, pas d'auto
        appliedActions.push(action);
        explanations.push(hint.rationale || 'hint_type=client_signal_demote_to_review');
        break;

      case 'keep_review_candidate_only':
        // Type C : conserver en review, ne pas booster, ne pas auto
        appliedActions.push(action);
        explanations.push(hint.rationale || 'hint_type=context_keep_review_or_boost_candidate');
        break;

      case 'observe_only':
        // Type D : aucun changement de bucket, seulement trace
        appliedActions.push(action);
        explanations.push(hint.rationale || 'hint_type=ignore_pattern_observed');
        break;

      default:
        // Ignoré (ne devrait pas arriver si loadApprovedReviewReasonHints a bien filtré)
        break;
    }
  });

  if (matchedHints.length === 0) {
    return Object.assign({}, entry);
  }

  // Construire la copie enrichie
  var copy = Object.assign({}, entry);

  // Champs d'explication (shadow uniquement)
  copy.review_reason_hint_applied     = true;
  copy.review_reason_hint_action      = appliedActions[0] || '';
  copy.review_reason_hint_ids         = matchedHints;
  copy.review_reason_hint_explanation = explanations.join(' | ');

  // Effets shadow selon l'action dominante (première qui bloque auto en priorité)
  var dominantAction = appliedActions[0] || '';

  if (dominantAction === 'block_auto_and_send_to_review') {
    // Bloquer auto + forcer review (copie shadow uniquement)
    copy.auto_notify_candidate = false;  // shadow copy only
    copy.review_candidate      = true;   // shadow copy only
  } else if (dominantAction === 'send_to_review') {
    // Forcer review uniquement (pas d'auto)
    copy.auto_notify_candidate = false;  // shadow copy only
    copy.review_candidate      = true;   // shadow copy only
  } else if (dominantAction === 'keep_review_candidate_only') {
    // Ne pas auto-notifier, garder en review si déjà là
    copy.auto_notify_candidate = false;  // shadow copy only
    // review_candidate inchangé (ne pas changer un candidat qui n'est pas review)
  }
  // observe_only : aucun changement de bucket

  return copy;
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  resolveEntryContextKey:               resolveEntryContextKey,
  loadApprovedReviewReasonHints:        loadApprovedReviewReasonHints,
  evaluateReviewReasonHintForEntry:      evaluateReviewReasonHintForEntry,
  applyReviewReasonHintsToShadowEntry:   applyReviewReasonHintsToShadowEntry,
  APPLY_HINTS_MODEL:                     APPLY_HINTS_MODEL,
  ALLOWED_ACTIONS:                       ALLOWED_ACTIONS,
  FORBIDDEN_ACTIONS:                     FORBIDDEN_ACTIONS,
  FORBIDDEN_STATUSES:                    FORBIDDEN_STATUSES,
  STATUS_APPROVED_FOR_SHADOW:            STATUS_APPROVED_FOR_SHADOW,
  // exposés pour tests
  _clientMatches:      clientMatches,
  _signalMatches:      signalMatches,
  _contextMatches:     contextMatches,
  _extractMatchedSignals: extractMatchedSignals,
};
