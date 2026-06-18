'use strict';

/**
 * scripts/review-reasons.js — GD-036
 *
 * Raisons humaines normalisées pour les décisions review (keep/reject/ignore).
 *
 * Principes :
 *  - Aucun appel réseau, aucun secret, aucune règle signal/client hardcodée.
 *  - Rule-based déterministe.
 *  - Ces raisons sont OPTIONNELLES, CONSULTATIVES, HUMAINES.
 *  - Elles ne modifient PAS le scoring, les buckets, auto_notify_candidate,
 *    review_candidate, ni les champs AI/CTX.
 *  - Pas de raison "budget", "prix", "montant", "estimation" : les BC du
 *    module shadow ne contiennent pas de données financières exploitables.
 *
 * Usage :
 *   var rr = require('./review-reasons');
 *   var code = rr.normalizeReviewReason("hors activité");     // "hors_activite"
 *   var label = rr.explainReviewReason("hors_activite");       // "Hors activité du client"
 *   var tpl = rr.buildReviewReasonTemplate(entry);             // objet template
 */

// ── Codes autorisés ───────────────────────────────────────────────────────────
// NOTE : budget / prix / montant / estimation sont délibérément ABSENTS.
var REVIEW_REASON_CODES = [
  'hors_activite',
  'mauvais_contexte',
  'bon_signal_mauvais_contexte',
  'organisme_non_pertinent',
  'zone_non_pertinente',
  'doublon_deja_vu',
  'information_insuffisante',
  'faux_positif_evident',
  'autre',
];

// ── Libellés français ─────────────────────────────────────────────────────────
var REVIEW_REASON_LABELS = {
  hors_activite:              'Hors activité du client',
  mauvais_contexte:           'Mauvais contexte',
  bon_signal_mauvais_contexte:'Bon signal, mais mauvais contexte',
  organisme_non_pertinent:    'Organisme non pertinent',
  zone_non_pertinente:        'Zone non pertinente',
  doublon_deja_vu:            'Doublon ou déjà vu',
  information_insuffisante:   'Information insuffisante',
  faux_positif_evident:       'Faux positif évident',
  autre:                      'Autre raison',
};

// ── Variantes reconnues → code normalisé ─────────────────────────────────────
// Clé : texte normalisé (lowercase, sans accents, espaces compactés)
// Valeur : code cible
var REASON_VARIANTS = {
  // hors_activite
  'hors_activite':           'hors_activite',
  'hors activite':           'hors_activite',
  'hors activite du client': 'hors_activite',
  'hors_activite_du_client': 'hors_activite',
  'hors activite du client': 'hors_activite',
  // mauvais_contexte
  'mauvais_contexte':        'mauvais_contexte',
  'mauvais contexte':        'mauvais_contexte',
  // bon_signal_mauvais_contexte
  'bon_signal_mauvais_contexte':       'bon_signal_mauvais_contexte',
  'bon signal mauvais contexte':       'bon_signal_mauvais_contexte',
  'bon signal, mais mauvais contexte': 'bon_signal_mauvais_contexte',
  'bon signal mais mauvais contexte':  'bon_signal_mauvais_contexte',
  // organisme_non_pertinent
  'organisme_non_pertinent': 'organisme_non_pertinent',
  'organisme non pertinent': 'organisme_non_pertinent',
  // zone_non_pertinente
  'zone_non_pertinente':     'zone_non_pertinente',
  'zone non pertinente':     'zone_non_pertinente',
  // doublon_deja_vu
  'doublon_deja_vu':         'doublon_deja_vu',
  'doublon deja vu':         'doublon_deja_vu',
  'doublon':                 'doublon_deja_vu',
  'deja vu':                 'doublon_deja_vu',
  'deja-vu':                 'doublon_deja_vu',
  // information_insuffisante
  'information_insuffisante': 'information_insuffisante',
  'information insuffisante': 'information_insuffisante',
  'infos insuffisantes':      'information_insuffisante',
  'info insuffisante':        'information_insuffisante',
  // faux_positif_evident
  'faux_positif_evident':    'faux_positif_evident',
  'faux positif evident':    'faux_positif_evident',
  'faux positif':            'faux_positif_evident',
  'faux_positif':            'faux_positif_evident',
  // autre
  'autre':                   'autre',
  'autre raison':            'autre',
  'other':                   'autre',
};

// ── Helper : normalisation du texte brut pour la comparaison ─────────────────
function normReason(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // strip accents
    .replace(/['']/g, '')
    .replace(/[-_]+/g, ' ')  // tirets/underscores → espace
    .replace(/\s+/g, ' ')
    .trim();
}

// ── normalizeReviewReason ─────────────────────────────────────────────────────
/**
 * Normalise une raison humaine vers un code canonique.
 *
 * - null / undefined / chaîne vide  → ""
 * - code déjà valide                → même code
 * - variante reconnue               → code cible
 * - valeur inconnue non vide        → "autre"
 *   (choix documenté : plutôt que de perdre l'information, on classe
 *    en "autre" pour signaler qu'une raison a été fournie mais non reconnue)
 *
 * @param {string|null|undefined} reason
 * @returns {string}
 */
function normalizeReviewReason(reason) {
  if (reason === null || reason === undefined) return '';
  var raw = String(reason).trim();
  if (!raw) return '';

  var norm = normReason(raw);
  if (!norm) return '';

  // Chercher dans les variantes (inclut les codes canoniques eux-mêmes)
  if (REASON_VARIANTS[norm]) return REASON_VARIANTS[norm];

  // Valeur inconnue non vide → "autre" (documenté)
  return 'autre';
}

// ── explainReviewReason ───────────────────────────────────────────────────────
/**
 * Retourne le libellé français lisible d'un code de raison.
 *
 * @param {string} code  — code normalisé ou chaîne quelconque
 * @returns {string}     — libellé FR, ou "" si code vide/inconnu
 */
function explainReviewReason(code) {
  if (!code) return '';
  var norm = normalizeReviewReason(code);
  if (!norm) return '';
  return REVIEW_REASON_LABELS[norm] || '';
}

// ── buildReviewReasonTemplate ─────────────────────────────────────────────────
/**
 * Produit un objet template pour faciliter la saisie humaine.
 * Ne contient PAS de logique métier forte.
 * Cherche prudemment des champs pré-existants dans l'entrée.
 *
 * @param {object} entry  — candidat review (peut être null/undefined)
 * @returns {object}
 */
function buildReviewReasonTemplate(entry) {
  var e = entry || {};

  // Chercher prudemment la raison existante
  var rawReason = e.human_review_reason || e.review_reason || e.decision_reason || '';
  var normalizedReason = normalizeReviewReason(rawReason);

  // Chercher prudemment le commentaire existant
  var rawComment = e.human_review_comment || e.review_comment || e.decision_comment || '';

  // Liste des raisons autorisées (options exposées pour la saisie)
  var allowedReasons = REVIEW_REASON_CODES.map(function(code) {
    return { code: code, label: REVIEW_REASON_LABELS[code] || code };
  });

  return {
    review_reason:          normalizedReason,
    review_reason_label:    explainReviewReason(normalizedReason),
    review_comment:         String(rawComment || '').trim(),
    allowed_review_reasons: allowedReasons,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  REVIEW_REASON_CODES:        REVIEW_REASON_CODES,
  REVIEW_REASON_LABELS:       REVIEW_REASON_LABELS,
  normalizeReviewReason:      normalizeReviewReason,
  explainReviewReason:        explainReviewReason,
  buildReviewReasonTemplate:  buildReviewReasonTemplate,
};
