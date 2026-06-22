#!/usr/bin/env node
// scripts/feedback-reason-mapping.js
// GD-077 — Mapping raisons client feedback -> decisions review internes
//
// Module pur, sans effet de bord, sans acces fichier, sans I/O.
// Utilise par convert-feedback-events-to-review-csv.js (GD-076) pour
// affiner le mapping quand une raison client est disponible.
//
// SECURITE :
//   - Ne modifie pas radar-bc-bot.js
//   - Ne modifie pas les liens envoyes aux clients
//   - Ne modifie pas le scoring, guards, hints, seuils, poids
//   - Ne touche pas prod, Fly, Supabase, secrets, notifications

'use strict';

// ---------------------------------------------------------------------------
// Constantes exportees
// ---------------------------------------------------------------------------

/**
 * Raisons valides cote client (parametre ?r= dans les liens feedback).
 * Correspond a _VALID_FEEDBACK_REASONS dans radar-bc-bot.js (GD-077).
 * Les deux listes doivent rester synchronisees manuellement.
 */
var VALID_FEEDBACK_REASONS = [
  'not_my_business',    // Ce n'est pas mon metier
  'wrong_buyer',        // Mauvais acheteur / organisme
  'wrong_zone',         // Mauvaise zone geographique
  'wrong_product',      // Produit ou prestation non concerne
  'not_sure',           // Pas sur(e)
  'duplicate',          // Deja vu / doublon
  'insufficient_info',  // Informations insuffisantes
  'other',              // Autre
];

/**
 * Mapping (type, reason) -> { decision, human_review_reason }
 *
 * Logique :
 *   - relevant                              -> keep / bon_signal_bon_contexte
 *   - irrelevant + not_my_business          -> reject / hors_profil
 *   - irrelevant + wrong_buyer              -> reject / hors_profil
 *   - irrelevant + wrong_zone               -> reject / hors_profil
 *   - irrelevant + wrong_product            -> reject / bon_signal_mauvais_contexte
 *   - irrelevant (sans reason ou autre)     -> reject / hors_profil  (defaut)
 *   - watch + not_sure                      -> ignore / ambigu
 *   - watch + insufficient_info             -> ignore / ambigu
 *   - watch + other                         -> ignore / ambigu
 *   - watch (sans reason ou autre)          -> ignore / ambigu  (defaut)
 *   - duplicate (+ reason=duplicate)        -> ignore / ignore_non_decidable
 *   - out_of_scope                          -> reject / hors_profil
 *   - wrong_category                        -> reject / bon_signal_mauvais_contexte
 *
 * Si reason est absent ou inconnu : mapping de base par type (comportement GD-076 inchange).
 */
var MAPPING = {
  // type=relevant (raison non pertinente)
  'relevant': {
    _default: { decision: 'keep', human_review_reason: 'bon_signal_bon_contexte' },
  },
  // type=irrelevant
  'irrelevant': {
    _default:        { decision: 'reject', human_review_reason: 'hors_profil' },
    'not_my_business':{ decision: 'reject', human_review_reason: 'hors_profil' },
    'wrong_buyer':    { decision: 'reject', human_review_reason: 'hors_profil' },
    'wrong_zone':     { decision: 'reject', human_review_reason: 'hors_profil' },
    'wrong_product':  { decision: 'reject', human_review_reason: 'bon_signal_mauvais_contexte' },
  },
  // type=watch
  'watch': {
    _default:          { decision: 'ignore', human_review_reason: 'ambigu' },
    'not_sure':        { decision: 'ignore', human_review_reason: 'ambigu' },
    'insufficient_info':{ decision: 'ignore', human_review_reason: 'ambigu' },
    'other':           { decision: 'ignore', human_review_reason: 'ambigu' },
  },
  // type=duplicate
  'duplicate': {
    _default:   { decision: 'ignore', human_review_reason: 'ignore_non_decidable' },
    'duplicate':{ decision: 'ignore', human_review_reason: 'ignore_non_decidable' },
  },
  // type=out_of_scope
  'out_of_scope': {
    _default: { decision: 'reject', human_review_reason: 'hors_profil' },
  },
  // type=wrong_category
  'wrong_category': {
    _default: { decision: 'reject', human_review_reason: 'bon_signal_mauvais_contexte' },
  },
};

// ---------------------------------------------------------------------------
// Fonction principale
// ---------------------------------------------------------------------------

/**
 * Resout le (decision, human_review_reason) a partir du type feedback
 * et de la raison client optionnelle.
 *
 * @param {string} type    Type feedback (ex: 'irrelevant')
 * @param {string} [reason] Raison client optionnelle (ex: 'wrong_product')
 * @returns {{ decision: string, human_review_reason: string } | null}
 *          null si le type est inconnu.
 */
function mapFeedbackToReview(type, reason) {
  var typeEntry = MAPPING[type];
  if (!typeEntry) return null;

  // Chercher une entree specifique pour la raison, sinon utiliser _default
  var entry = (reason && typeEntry[reason]) ? typeEntry[reason] : typeEntry['_default'];
  return { decision: entry.decision, human_review_reason: entry.human_review_reason };
}

/**
 * Valide une raison client.
 * @param {string} reason
 * @returns {boolean}
 */
function isValidFeedbackReason(reason) {
  return VALID_FEEDBACK_REASONS.indexOf(reason) !== -1;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  VALID_FEEDBACK_REASONS: VALID_FEEDBACK_REASONS,
  MAPPING:                MAPPING,
  mapFeedbackToReview:    mapFeedbackToReview,
  isValidFeedbackReason:  isValidFeedbackReason,
};
