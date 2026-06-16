"use strict";
/**
 * purchase-intent.runtime.js — GD-027 / GD-028
 *
 * Port CommonJS de core/shadow/purchase-intent.ts.
 * Shadow uniquement — aucun effet sur le matching legacy ni les notifications.
 *
 * GD-028 : signaux courts (≤2 chars normalisés) → fenêtre ±30, Tier 2 désactivé.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _piNorm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _piHasKw(text, kw) {
  var nk = _piNorm(kw);
  if (!nk) return false;
  var esc = nk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("\\b" + esc).test(_piNorm(text));
}

function _piHasAnyKw(text, terms) {
  return (terms || []).some(function(t) { return t && _piHasKw(text, t); });
}

// ─── Constantes ────────────────────────────────────────────────────────────────

var PURCHASE_INTENT_SCORE = 5;
var OUT_OF_SCOPE_PENALTY  = 5;
var SHORT_SIGNAL_MAX_LEN  = 2;  // GD-028
var SHORT_SIGNAL_WINDOW   = 30; // GD-028

var PURCHASE_INTENT_PATTERNS = [
  'achat de', 'achat des', 'achat du', 'achats de',
  'acquisition de', 'acquisition des', 'acquisition du',
  'fourniture de', 'fourniture des', 'fournitures de', 'fournitures des',
  'fourniture pour', 'fournitures pour',
  'entretien et reparation de', 'entretien et reparation des',
  'entretien et maintenance de', 'entretien et maintenance des',
  'maintenance de', 'maintenance des', 'maintenance du',
  'installation de', 'installation des', 'installation du',
  'prestation de', 'prestations de',
  'service de', 'services de',
  'livraison de', 'livraison des',
  'approvisionnement en', 'approvisionnement de', 'approvisionnement des',
  'mise a disposition de', 'mise a disposition des',
  'realisation de la prestation', 'realisation des prestations',
];

var CTX_EVENEMENTIEL_SUPPRESS = [
  'reception', 'ceremonie', 'manifestation', 'inauguration',
  'banquet', 'gala', 'convives', 'buffet', 'cocktail', 'soiree',
];

var OUT_OF_SCOPE_PATTERNS = [
  'etude topographique',
  'etude geologique', 'etude geotechnique', 'etude geophysique',
  'etude architecturale', 'etude d architecture',
  'maitrise d oeuvre', 'mission de maitrise d oeuvre',
  'travaux de construction',
  'travaux de rehabilitation',
  'travaux d amenagement',
  'travaux de renovation', 'travaux de refection',
  'rehabilitation du batiment', 'rehabilitation de batiment',
  'construction du batiment', 'construction de batiment',
  'amenagement du batiment', 'amenagement de batiment',
  'gardiennage et surveillance',
  'service de gardiennage', 'services de gardiennage',
  'surveillance des locaux', 'surveillance et gardiennage',
  'ceremonies officielles',
];

var OUT_OF_SCOPE_BYPASS = [
  'fourniture de', 'fournitures de', 'fourniture pour',
  'achat de', 'acquisition de',
  'prestation de', 'service de',
  'livraison de', 'approvisionnement de',
];

// ─── detectPurchaseIntentNear ──────────────────────────────────────────────────

function detectPurchaseIntentNear(cleanText, signal) {
  var nText = _piNorm(cleanText);
  var nSig  = _piNorm(signal);

  if (!nSig || !_piHasKw(nText, nSig)) return { detected: false, pattern: null };
  if (_piHasAnyKw(nText, CTX_EVENEMENTIEL_SUPPRESS)) return { detected: false, pattern: null };

  var esc      = nSig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var sigRegex = new RegExp("\\b" + esc);
  var sigMatch = sigRegex.exec(nText);
  if (!sigMatch) return { detected: false, pattern: null };
  var sigPos = sigMatch.index;

  // GD-028 : fenêtre stricte pour les signaux courts
  var isShortSignal = nSig.length <= SHORT_SIGNAL_MAX_LEN;
  var halfWin       = isShortSignal ? SHORT_SIGNAL_WINDOW : 100;

  // Tier 1 : fenêtre autour du signal
  var winStart = Math.max(0, sigPos - halfWin);
  var winEnd   = Math.min(nText.length, sigPos + nSig.length + halfWin);
  var win      = nText.slice(winStart, winEnd);

  for (var i = 0; i < PURCHASE_INTENT_PATTERNS.length; i++) {
    if (_piHasKw(win, PURCHASE_INTENT_PATTERNS[i])) {
      return { detected: true, pattern: PURCHASE_INTENT_PATTERNS[i] };
    }
  }

  // Tier 2 : désactivé pour les signaux courts (GD-028)
  if (!isShortSignal) {
    var textStart = nText.slice(0, 60);
    for (var j = 0; j < PURCHASE_INTENT_PATTERNS.length; j++) {
      if (_piHasKw(textStart, PURCHASE_INTENT_PATTERNS[j])) {
        return { detected: true, pattern: PURCHASE_INTENT_PATTERNS[j] };
      }
    }
  }

  return { detected: false, pattern: null };
}

// ─── detectOutOfScopeContext ───────────────────────────────────────────────────

function detectOutOfScopeContext(cleanText) {
  var nText = _piNorm(cleanText);
  if (_piHasAnyKw(nText, OUT_OF_SCOPE_BYPASS)) return { blocked: false, reason: null };
  for (var k = 0; k < OUT_OF_SCOPE_PATTERNS.length; k++) {
    if (_piHasKw(nText, OUT_OF_SCOPE_PATTERNS[k])) {
      return { blocked: true, reason: 'contexte hors p\u00e9rim\u00e8tre : ' + OUT_OF_SCOPE_PATTERNS[k] };
    }
  }
  return { blocked: false, reason: null };
}

module.exports = {
  PURCHASE_INTENT_SCORE:    PURCHASE_INTENT_SCORE,
  OUT_OF_SCOPE_PENALTY:     OUT_OF_SCOPE_PENALTY,
  SHORT_SIGNAL_MAX_LEN:     SHORT_SIGNAL_MAX_LEN,
  SHORT_SIGNAL_WINDOW:      SHORT_SIGNAL_WINDOW,
  detectPurchaseIntentNear: detectPurchaseIntentNear,
  detectOutOfScopeContext:  detectOutOfScopeContext,
};
