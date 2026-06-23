// scripts/feedback-links-builder.js
// GD-078 — Helpers purs pour la generation de liens feedback avec raison client.
//
// Module pur, sans effet de bord, sans I/O, sans acces CFG / process.env.
// Utilise par radar-bc-bot.js (_buildFeedbackSection) et testable directement.
//
// SECURITE :
//   - flag false par defaut  => comportement prod identique a avant GD-078
//   - Aucun lien existant ne contient r= tant que FEEDBACK_REASON_LINKS_ENABLED != "true"
//   - Ne touche pas prod, Fly, Supabase, secrets, notifications
//   - Ne modifie pas scoring, guards, hints, seuils, poids, matching

'use strict';

// GD-085 : helper de signature optionnelle (pur, injectable, crypto Node)
var _fbs = require('./feedback-signature');

// ---------------------------------------------------------------------------
// Entrees par defaut -- comportement original, 3 liens sans r=
// Labels identiques a ceux presents dans _buildFeedbackSection avant GD-078.
// ---------------------------------------------------------------------------
var FEEDBACK_TYPES_DEFAULT = [
  { type: "relevant",   label: "✅ Pertinent" },
  { type: "irrelevant", label: "❌ Pas pertinent" },
  { type: "watch",      label: "👀 À surveiller" },
];

// ---------------------------------------------------------------------------
// Entrees enrichies -- GD-078, 8 liens avec r= par raison client.
// Uniquement utilisees si FEEDBACK_REASON_LINKS_ENABLED=true.
// ---------------------------------------------------------------------------
var FEEDBACK_REASON_ENTRIES = [
  { type: "relevant",   label: "✅ Pertinent",             reason: null },
  { type: "irrelevant", label: "❌ Pas mon métier",   reason: "not_my_business" },
  { type: "irrelevant", label: "❌ Mauvais acheteur",      reason: "wrong_buyer" },
  { type: "irrelevant", label: "❌ Mauvaise zone",         reason: "wrong_zone" },
  { type: "irrelevant", label: "❌ Mauvais produit",       reason: "wrong_product" },
  { type: "watch",      label: "👀 Pas sûr(e)", reason: "not_sure" },
  { type: "watch",      label: "👀 Infos insuffisantes", reason: "insufficient_info" },
  { type: "watch",      label: "👀 Autre",           reason: "other" },
];

// ---------------------------------------------------------------------------
// Helper pur : lecture du flag
// ---------------------------------------------------------------------------

/**
 * Determine si les liens feedback enrichis avec raison sont actives.
 * Accepte la valeur brute de process.env.FEEDBACK_REASON_LINKS_ENABLED.
 * false par defaut -- comportement prod inchange tant que la variable n'est pas "true".
 *
 * @param {string|undefined} envVal  Valeur de process.env.FEEDBACK_REASON_LINKS_ENABLED
 * @returns {boolean}
 */
function isFeedbackReasonLinksEnabled(envVal) {
  return envVal === "true";
}

// ---------------------------------------------------------------------------
// Helper pur : construction des liens
// ---------------------------------------------------------------------------

/**
 * Construit la section feedback avec ou sans raisons client.
 * Coeur pur de _buildFeedbackSection -- testable directement sans CFG ni process.env.
 *
 * @param {string}  base               URL de base (ex: "https://myapp.example.com")
 * @param {string}  clientId           ID client
 * @param {string}  itemId             ID BC/MP
 * @param {string}  critereValeur      Critere qui a matche
 * @param {string}  radarType          "bc" | "mp"
 * @param {object}  opts               { notifId?, matchedTerms?, bcTitle? }
 * @param {string}  mode               "html" | "plain"
 * @param {boolean} reasonLinksEnabled true => 8 liens avec r=; false => 3 liens originaux sans r=
 * @returns {string|null}              Section feedback ou null si base vide
 */
/**
 * @param {object|null} [signatureOpts]  GD-085 : { enabled, secret, ttlSeconds?, now? }
 *   Si enabled=true ET secret present => ajoute &exp=<unix>&sig=<hmac> a chaque URL.
 *   Si absent/null => comportement original inchange (retro-compatible).
 */
function buildFeedbackReasonLinks(base, clientId, itemId, critereValeur, radarType, opts, mode, reasonLinksEnabled, signatureOpts) {
  var b = (base || "").trim();
  if (!b) return null;

  var clean = b.replace(/\/$/, "") + "/feedback";

  function makeUrl(type, reason) {
    var u = clean
      + "?client_id=" + encodeURIComponent(clientId)
      + "&radar_type=" + encodeURIComponent(radarType)
      + "&item_id="    + encodeURIComponent(itemId)
      + "&critere="    + encodeURIComponent(critereValeur)
      + "&type="       + encodeURIComponent(type);
    if (opts && opts.notifId)      u += "&nid=" + encodeURIComponent(opts.notifId);
    if (opts && opts.matchedTerms) u += "&mt="  + encodeURIComponent(opts.matchedTerms);
    if (opts && opts.bcTitle)      u += "&bt="  + encodeURIComponent(String(opts.bcTitle).slice(0, 60));
    // GD-078 : r= ajoutee uniquement si reason fournie (liens enrichis, flag=true)
    if (reason)                    u += "&r="   + encodeURIComponent(reason);
    // GD-085 : signature HMAC optionnelle (uniquement si flag true + secret defini)
    if (signatureOpts && signatureOpts.enabled && signatureOpts.secret) {
      var exp = _fbs.buildFeedbackExpiry(
        signatureOpts.now || new Date(),
        signatureOpts.ttlSeconds || _fbs.DEFAULT_TTL_SECONDS
      );
      var sigParams = {
        client_id:  clientId,
        radar_type: radarType,
        item_id:    itemId,
        critere:    critereValeur,
        type:       type,
        exp:        exp,
      };
      if (opts && opts.notifId)      sigParams.nid = opts.notifId;
      if (opts && opts.matchedTerms) sigParams.mt  = opts.matchedTerms;
      if (opts && opts.bcTitle)      sigParams.bt  = String(opts.bcTitle).slice(0, 60);
      if (reason)                    sigParams.r   = reason;
      var sig = _fbs.signFeedbackParams(sigParams, signatureOpts.secret);
      u += "&exp=" + encodeURIComponent(exp) + "&sig=" + encodeURIComponent(sig);
    }
    return u;
  }

  var entries = reasonLinksEnabled ? FEEDBACK_REASON_ENTRIES : FEEDBACK_TYPES_DEFAULT;
  var lines = ["", "Feedback :"];

  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var url   = makeUrl(entry.type, entry.reason || null);
    if (mode === "html") {
      lines.push('<a href="' + url + '">' + entry.label + "</a>");
    } else {
      lines.push(entry.label + " — " + url);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  isFeedbackReasonLinksEnabled: isFeedbackReasonLinksEnabled,
  buildFeedbackReasonLinks:     buildFeedbackReasonLinks,
  FEEDBACK_REASON_ENTRIES:      FEEDBACK_REASON_ENTRIES,
  FEEDBACK_TYPES_DEFAULT:       FEEDBACK_TYPES_DEFAULT,
};
