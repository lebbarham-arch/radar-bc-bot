// scripts/feedback-handler.js
// GD-080 — Module pur isolant la logique du handler /feedback.
//
// Extraction depuis radar-bc-bot.js pour tests unitaires isoles,
// sans lancer Puppeteer, Supabase, cron ou HTTP.
//
// FONCTIONS PURES / INJECTABLES :
//   validateFeedbackQuery(query)          -- pure, pas d'I/O
//   buildFeedbackEvent(data, now?)        -- pure, now injectable pour tests
//   appendFeedbackEventToJsonl(event, fp) -- I/O mais path injectable
//
// SECURITE :
//   - Ne touche pas prod, Fly, Supabase, secrets, notifications
//   - Ne modifie pas scoring, guards, hints, seuils, poids, matching
//   - appendFeedbackToSupabase reste dans radar-bc-bot.js (depend de CFG/fetch)
//   - Le comportement de la route /feedback est identique apres extraction

'use strict';

var fs   = require('fs');
var path = require('path');

// ---------------------------------------------------------------------------
// Constantes de validation
// ---------------------------------------------------------------------------

var VALID_FEEDBACK_TYPES = [
  'relevant', 'irrelevant', 'duplicate', 'out_of_scope', 'wrong_category', 'watch',
];

var VALID_RADAR_TYPES = ['bc', 'mp'];

// GD-077 : raisons client optionnelles (parametre ?r=)
// Aucun lien existant ne contient ce parametre => comportement prod inchange si absent.
var VALID_FEEDBACK_REASONS = [
  'not_my_business', 'wrong_buyer', 'wrong_zone', 'wrong_product',
  'not_sure', 'duplicate', 'insufficient_info', 'other',
];

// HTML retourne au client apres enregistrement du feedback
var FEEDBACK_SUCCESS_HTML = (
  '<!DOCTYPE html><html><head><meta charset="utf-8">' +
  '<title>Feedback enregistré</title></head><body>' +
  '<p>✅ Merci, votre retour a été enregistré.</p>' +
  '</body></html>'
);

// ---------------------------------------------------------------------------
// validateFeedbackQuery
// ---------------------------------------------------------------------------

/**
 * Valide les parametres GET de la route /feedback.
 * Retourne { valid: true, data } ou { valid: false, error }.
 * Pur -- aucun I/O, aucun effet de bord.
 *
 * @param {object} query  Objet query parse (ex: url.parse(req.url, true).query)
 * @returns {{ valid: boolean, error?: string, data?: object }}
 */
function validateFeedbackQuery(query) {
  var client_id  = (query.client_id  || '').trim();
  var radar_type = (query.radar_type || '').trim();
  var item_id    = (query.item_id    || '').trim();
  var critere    = (query.critere    || '').trim();
  var type       = (query.type       || '').trim();

  if (!client_id)                              return { valid: false, error: 'client_id manquant' };
  if (!VALID_RADAR_TYPES.includes(radar_type)) return { valid: false, error: 'radar_type invalide' };
  if (!item_id)                                return { valid: false, error: 'item_id manquant' };
  if (!critere)                                return { valid: false, error: 'critere manquant' };
  if (!VALID_FEEDBACK_TYPES.includes(type))    return { valid: false, error: 'type invalide' };

  // Champs optionnels d'enrichissement
  var data = { client_id: client_id, radar_type: radar_type, item_id: item_id,
               critere: critere, type: type };
  var bc_title      = typeof query.bt  === 'string' ? query.bt.slice(0, 60).trim()  : undefined;
  var matched_terms = typeof query.mt  === 'string' ? query.mt.slice(0, 100).trim() : undefined;
  var notif_id      = typeof query.nid === 'string' ? query.nid.slice(0, 128).trim(): undefined;
  if (bc_title      !== undefined) data.bc_title      = bc_title;
  if (matched_terms !== undefined) data.matched_terms = matched_terms;
  if (notif_id      !== undefined) data.notif_id      = notif_id;

  // GD-077 : raison client optionnelle (?r=) -- passive, ignoree si invalide
  var reason = typeof query.r === 'string' ? query.r.slice(0, 64).trim() : undefined;
  if (reason !== undefined && VALID_FEEDBACK_REASONS.includes(reason)) data.reason = reason;

  return { valid: true, data: data };
}

// ---------------------------------------------------------------------------
// buildFeedbackEvent
// ---------------------------------------------------------------------------

/**
 * Construit l'objet event a persister a partir des donnees validees.
 * Pur -- `now` est injectable pour faciliter les tests.
 *
 * @param {object}  validatedData  Resultat de validateFeedbackQuery().data
 * @param {Date}    [now]          Date injectable (defaut: new Date())
 * @returns {object}               Event complet avec created_at ISO
 */
function buildFeedbackEvent(validatedData, now) {
  var ts = (now instanceof Date ? now : new Date()).toISOString();
  return Object.assign({}, validatedData, { created_at: ts });
}

// ---------------------------------------------------------------------------
// appendFeedbackEventToJsonl
// ---------------------------------------------------------------------------

/**
 * Ajoute un evenement feedback en JSONL dans filePath.
 * Cree le dossier parent si absent.
 * Path injectable -- permet les tests avec fichier temporaire hors repo.
 *
 * @param {object} event     Objet event (resultat de buildFeedbackEvent)
 * @param {string} filePath  Chemin absolu vers le fichier JSONL cible
 */
function appendFeedbackEventToJsonl(event, filePath) {
  var dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  VALID_FEEDBACK_TYPES:      VALID_FEEDBACK_TYPES,
  VALID_RADAR_TYPES:         VALID_RADAR_TYPES,
  VALID_FEEDBACK_REASONS:    VALID_FEEDBACK_REASONS,
  FEEDBACK_SUCCESS_HTML:     FEEDBACK_SUCCESS_HTML,
  validateFeedbackQuery:     validateFeedbackQuery,
  buildFeedbackEvent:        buildFeedbackEvent,
  appendFeedbackEventToJsonl: appendFeedbackEventToJsonl,
};
