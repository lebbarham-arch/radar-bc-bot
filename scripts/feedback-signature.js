// scripts/feedback-signature.js
// GD-085 — Signature HMAC optionnelle des liens feedback client.
//
// Module pur, sans I/O, sans CFG, sans process.env.
// Utilise uniquement le module crypto natif de Node.js.
//
// COMPORTEMENT PAR DEFAUT (tous flags absents / false) :
//   - Aucun sig=, aucun exp= dans les liens generes
//   - Anciens liens non signes acceptes par /feedback
//   - Comportement prod inchange
//
// COMPORTEMENT AVEC SIGNING ACTIVE :
//   FEEDBACK_SIGNED_LINKS_ENABLED=true + FEEDBACK_SIGNING_SECRET defini
//     => liens contiennent &exp=<unix_ts>&sig=<hmac-sha256-hex>
//   FEEDBACK_REQUIRE_SIGNATURE=true
//     => /feedback rejette les liens non signes / expires / invalides
//
// SECURITE :
//   - Signature HMAC-SHA256 sur payload canonique deterministe
//   - Comparaison timing-safe (crypto.timingSafeEqual)
//   - Expiration verifiable cote serveur
//   - Ne touche pas prod, Fly, Supabase, secrets, notifications
//   - Ne modifie pas scoring, guards, hints, seuils, poids, matching

'use strict';

var crypto = require('crypto');

// TTL par defaut : 7 jours (604800 secondes)
var DEFAULT_TTL_SECONDS = 604800;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

/**
 * Determine si la generation de liens signes est activee.
 * Seule la valeur exacte "true" active le comportement.
 * Defaut : false => comportement prod inchange.
 *
 * @param {string|undefined} envVal  Valeur de process.env.FEEDBACK_SIGNED_LINKS_ENABLED
 * @returns {boolean}
 */
function isFeedbackSignedLinksEnabled(envVal) {
  return envVal === 'true';
}

/**
 * Determine si la verification de signature est requise sur /feedback.
 * Seule la valeur exacte "true" active le rejet des liens non signes.
 * Defaut : false => anciens liens non signes acceptes (retro-compatibilite).
 *
 * @param {string|undefined} envVal  Valeur de process.env.FEEDBACK_REQUIRE_SIGNATURE
 * @returns {boolean}
 */
function isFeedbackSignatureRequired(envVal) {
  return envVal === 'true';
}

// ---------------------------------------------------------------------------
// Expiration
// ---------------------------------------------------------------------------

/**
 * Calcule le timestamp unix d'expiration d'un lien feedback.
 * Injectable pour tests (now).
 *
 * @param {Date|undefined} now        Date de reference (defaut: new Date())
 * @param {number}         ttlSeconds Duree de validite en secondes (defaut: 604800 = 7 jours)
 * @returns {number}                  Timestamp unix (secondes)
 */
function buildFeedbackExpiry(now, ttlSeconds) {
  var ts  = Math.floor((now instanceof Date ? now : new Date()).getTime() / 1000);
  var ttl = (typeof ttlSeconds === 'number' && ttlSeconds > 0) ? ttlSeconds : DEFAULT_TTL_SECONDS;
  return ts + ttl;
}

// ---------------------------------------------------------------------------
// Payload canonique
// ---------------------------------------------------------------------------

/**
 * Construit la representation canonique des parametres pour la signature.
 * Ordre deterministe : champs requis d'abord, optionnels si presents, exp en dernier.
 * Valeurs brutes (non encodees URL) pour permettre la verification cote serveur.
 *
 * Champs requis : client_id, radar_type, item_id, critere, type
 * Champs optionnels (inclus si presents et non vides) : nid, mt, bt, r
 * Toujours en dernier : exp
 *
 * @param {object} params  { client_id, radar_type, item_id, critere, type, [nid], [mt], [bt], [r], exp }
 * @returns {string}       Chaine canonique ex: "client_id=X&radar_type=bc&...&exp=1234567890"
 */
function buildCanonicalFeedbackPayload(params) {
  var parts = [];
  // Champs obligatoires — toujours inclus dans cet ordre
  parts.push('client_id='  + (params.client_id  || ''));
  parts.push('radar_type=' + (params.radar_type || ''));
  parts.push('item_id='    + (params.item_id    || ''));
  parts.push('critere='    + (params.critere    || ''));
  parts.push('type='       + (params.type       || ''));
  // Champs optionnels — inclus uniquement si non vides
  if (params.nid) parts.push('nid=' + params.nid);
  if (params.mt)  parts.push('mt='  + params.mt);
  if (params.bt)  parts.push('bt='  + params.bt);
  if (params.r)   parts.push('r='   + params.r);
  // Expiration toujours en dernier (couvre la duree de vie dans le payload signe)
  parts.push('exp=' + (params.exp || 0));
  return parts.join('&');
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/**
 * Calcule la signature HMAC-SHA256 des parametres du lien feedback.
 * Deterministe : memes params + meme secret => meme sig.
 *
 * @param {object} params   Parametres du lien (voir buildCanonicalFeedbackPayload)
 * @param {string} secret   Secret de signature (FEEDBACK_SIGNING_SECRET)
 * @returns {string}        Signature hexadecimale (64 chars)
 */
function signFeedbackParams(params, secret) {
  var payload = buildCanonicalFeedbackPayload(params);
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verifie la signature et l'expiration d'un lien feedback.
 * Utilise crypto.timingSafeEqual pour eviter les attaques temporelles.
 *
 * Si sig absent           => { valid: false, error: 'signature absente' }
 * Si exp absent           => { valid: false, error: 'exp absent' }
 * Si lien expire          => { valid: false, error: 'lien expire' }
 * Si signature invalide   => { valid: false, error: 'signature invalide' }
 * Si tout OK              => { valid: true }
 *
 * @param {object}        query   Objet query parse (url.parse(req.url, true).query)
 * @param {string}        secret  Secret de verification (FEEDBACK_SIGNING_SECRET)
 * @param {Date|undefined} now    Date de reference (defaut: new Date())
 * @returns {{ valid: boolean, error?: string }}
 */
function verifyFeedbackSignature(query, secret, now) {
  var sig = typeof query.sig === 'string' ? query.sig.trim() : '';
  var exp = typeof query.exp === 'string' ? parseInt(query.exp, 10) : 0;

  if (!sig) return { valid: false, error: 'signature absente' };
  if (!exp) return { valid: false, error: 'exp absent' };

  var nowTs = Math.floor((now instanceof Date ? now : new Date()).getTime() / 1000);
  if (nowTs > exp) return { valid: false, error: 'lien expire' };

  // Reconstruire les parametres canoniques depuis la query
  var params = {
    client_id:  (query.client_id  || '').trim(),
    radar_type: (query.radar_type || '').trim(),
    item_id:    (query.item_id    || '').trim(),
    critere:    (query.critere    || '').trim(),
    type:       (query.type       || '').trim(),
    exp:        exp,
  };
  // Champs optionnels : inclus dans le payload si presents dans la query
  // Applique les memes troncatures que validateFeedbackQuery pour coherence
  if (query.nid) params.nid = String(query.nid).slice(0, 128).trim();
  if (query.mt)  params.mt  = String(query.mt).slice(0, 100).trim();
  if (query.bt)  params.bt  = String(query.bt).slice(0, 60).trim();
  if (query.r)   params.r   = String(query.r).slice(0, 64).trim();

  var expected = signFeedbackParams(params, secret);

  try {
    var sigBuf      = Buffer.from(sig,      'hex');
    var expectedBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expectedBuf.length) {
      return { valid: false, error: 'signature invalide' };
    }
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, error: 'signature invalide' };
    }
  } catch (e) {
    return { valid: false, error: 'signature invalide' };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  DEFAULT_TTL_SECONDS:            DEFAULT_TTL_SECONDS,
  isFeedbackSignedLinksEnabled:   isFeedbackSignedLinksEnabled,
  isFeedbackSignatureRequired:    isFeedbackSignatureRequired,
  buildFeedbackExpiry:            buildFeedbackExpiry,
  buildCanonicalFeedbackPayload:  buildCanonicalFeedbackPayload,
  signFeedbackParams:             signFeedbackParams,
  verifyFeedbackSignature:        verifyFeedbackSignature,
};
