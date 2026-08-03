/**
 * client-learning-runtime.js
 *
 * Loader runtime generique des hints d'apprentissage client.
 *
 * Principes :
 *   - aucune dependance externe ;
 *   - aucune regle metier, aucun mot-cle code en dur ;
 *   - fail-open systematique : un fichier absent, illisible ou invalide
 *     ne doit jamais faire echouer un scan ;
 *   - resolution du client par client_id exact uniquement (jamais par nom) ;
 *   - cache memoire invalide par mtime.
 *
 * Le module ne decide jamais seul : il expose une politique stricte
 * (evaluateLearningDecision) qui ne peut que durcir une decision "allow"
 * en "block". Il ne peut jamais transformer "block" en "allow".
 */

"use strict";

var fs = require("fs");
var path = require("path");

var DEFAULT_HINTS_RELATIVE_PATH = path.join(
  "data", "feedback", "runtime-learning", "client-learning-hints.json"
);

/* Seuils de preuve minimaux de la politique stricte. */
var MIN_TOTAL = 5;
var MIN_CYCLES = 2;

/* Seul effet executoire dans cette version. Tout le reste est consultatif. */
var EFFECT_DEMOTE_TO_REVIEW = "demote_to_review";

var _cache = {
  filePath: null,
  mtimeMs: null,
  size: null,
  index: null,
};

/* ------------------------------------------------------------------ */
/* Feature flag                                                        */
/* ------------------------------------------------------------------ */

/**
 * Le runtime learning est desactive par defaut.
 * Seules les valeurs "1" et "true" (insensible a la casse) l'activent.
 */
function isRuntimeLearningEnabled(rawValue) {
  if (rawValue === undefined || rawValue === null) return false;
  var v = String(rawValue).trim().toLowerCase();
  return v === "1" || v === "true";
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normalise un signal : accents, casse, ponctuation, espaces.
 * Generique - aucune connaissance metier.
 */
function normalizeSignal(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Identite client : comparaison exacte apres trim.
 * Aucun repli sur le nom, aucune normalisation d'accents ou de casse :
 * un client_id est un identifiant opaque.
 */
function normalizeClientId(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/* ------------------------------------------------------------------ */
/* Resolution du chemin                                                */
/* ------------------------------------------------------------------ */

function resolveHintsPath(env, baseDir) {
  var e = env || {};
  var override = e.CLIENT_LEARNING_RUNTIME_HINTS_PATH;
  if (override !== undefined && override !== null && String(override).trim() !== "") {
    return String(override).trim();
  }
  var root = baseDir || path.resolve(__dirname, "..", "..");
  return path.join(root, DEFAULT_HINTS_RELATIVE_PATH);
}

/* ------------------------------------------------------------------ */
/* Chargement et indexation                                            */
/* ------------------------------------------------------------------ */

/**
 * Construit l'index { clientId -> { signalNormalise -> hint } }.
 * Toute entree malformee est ignoree silencieusement.
 */
function buildIndex(parsed) {
  var index = Object.create(null);
  if (!parsed || typeof parsed !== "object") return index;

  var clients = parsed.clients;
  if (!Array.isArray(clients)) return index;

  for (var i = 0; i < clients.length; i++) {
    var entry = clients[i];
    if (!entry || typeof entry !== "object") continue;

    var clientKey = normalizeClientId(entry.client);
    if (!clientKey) continue;

    var signals = entry.signals;
    if (!Array.isArray(signals)) continue;

    if (!index[clientKey]) index[clientKey] = Object.create(null);

    for (var j = 0; j < signals.length; j++) {
      var hint = signals[j];
      if (!hint || typeof hint !== "object") continue;

      var signalKey = normalizeSignal(hint.signal);
      if (!signalKey) continue;

      /* Premiere occurrence gagnante : evite qu'un doublon plus permissif
         ecrase un hint deja indexe. */
      if (index[clientKey][signalKey] === undefined) {
        index[clientKey][signalKey] = hint;
      }
    }
  }

  return index;
}

/**
 * Charge l'index depuis le disque, avec cache invalide par mtime + taille.
 * Retourne toujours un objet (vide en cas de probleme) - jamais d'exception.
 */
function loadHintsIndex(options) {
  var opts = options || {};
  var filePath = opts.filePath || resolveHintsPath(opts.env || process.env, opts.baseDir);

  var stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    /* Fichier absent ou inaccessible : fail-open silencieux. */
    _cache.filePath = filePath;
    _cache.mtimeMs = null;
    _cache.size = null;
    _cache.index = Object.create(null);
    return _cache.index;
  }

  if (
    _cache.index !== null &&
    _cache.filePath === filePath &&
    _cache.mtimeMs === stat.mtimeMs &&
    _cache.size === stat.size
  ) {
    return _cache.index;
  }

  var index;
  try {
    var raw = fs.readFileSync(filePath, "utf8");
    index = buildIndex(JSON.parse(raw));
  } catch (e) {
    /* JSON invalide ou lecture impossible : fail-open silencieux. */
    index = Object.create(null);
  }

  _cache.filePath = filePath;
  _cache.mtimeMs = stat.mtimeMs;
  _cache.size = stat.size;
  _cache.index = index;
  return index;
}

/** Reinitialise le cache. Reserve aux tests et au rechargement explicite. */
function resetCache() {
  _cache.filePath = null;
  _cache.mtimeMs = null;
  _cache.size = null;
  _cache.index = null;
}

/* ------------------------------------------------------------------ */
/* Lookup                                                              */
/* ------------------------------------------------------------------ */

/**
 * Retourne le hint correspondant au couple (client_id exact, signal normalise),
 * ou null. Aucun repli sur le nom du client.
 */
function lookupHint(clientId, signal, options) {
  var key = normalizeClientId(clientId);
  if (!key) return null;

  var sig = normalizeSignal(signal);
  if (!sig) return null;

  var index = loadHintsIndex(options);
  var byClient = index[key];
  if (!byClient) return null;

  var hint = byClient[sig];
  return hint === undefined ? null : hint;
}

/* ------------------------------------------------------------------ */
/* Politique stricte                                                   */
/* ------------------------------------------------------------------ */

/**
 * Coercition stricte : seuls de vrais nombres finis sont acceptes.
 * null, undefined, "" et les chaines sont refuses - Number(null) vaut 0
 * et transformerait un compteur manquant en zero valide.
 * Toute valeur refusee fait echouer la politique (fail-open).
 */
function _toFiniteNumber(value) {
  if (typeof value !== "number") return null;
  return Number.isFinite(value) ? value : null;
}

/**
 * Determine si un hint satisfait toutes les conditions de blocage.
 * Toute condition non satisfaite, absente ou du mauvais type => false.
 */
function hintBlocksAutoNotify(hint) {
  if (!hint || typeof hint !== "object") return false;

  if (hint.recommended_effect !== EFFECT_DEMOTE_TO_REVIEW) return false;
  if (hint.block_auto_notify !== true) return false;

  var total = _toFiniteNumber(hint.total);
  if (total === null || total < MIN_TOTAL) return false;

  var cycles = _toFiniteNumber(hint.cycles_count);
  if (cycles === null || cycles < MIN_CYCLES) return false;

  var keep = _toFiniteNumber(hint.keep);
  var reject = _toFiniteNumber(hint.reject);
  var ignore = _toFiniteNumber(hint.ignore);
  if (keep === null || reject === null || ignore === null) return false;
  if (!((reject + ignore) > keep)) return false;

  return true;
}

/**
 * Politique de decision.
 *
 * Contrat :
 *   - retourne null si aucune modification ne doit etre appliquee ;
 *   - ne peut retourner qu'une transition allow -> block ;
 *   - ne transforme jamais block -> allow ;
 *   - ne force jamais un envoi.
 *
 * Les effets boost / keep_review / insufficient_data / inconnus restent
 * consultatifs et ne modifient jamais la livraison.
 */
function evaluateLearningDecision(params) {
  var p = params || {};
  var env = p.env || process.env;

  if (!isRuntimeLearningEnabled(env.CLIENT_LEARNING_RUNTIME_ENABLED)) return null;

  /* Une decision deja bloquante est conservee telle quelle. */
  if (p.gateDecision !== "allow") return null;

  var clientId = normalizeClientId(p.clientId);
  if (!clientId) return null;

  var hint;
  try {
    hint = lookupHint(clientId, p.critereValeur, {
      env: env,
      filePath: p.filePath,
      baseDir: p.baseDir,
    });
  } catch (e) {
    /* Fail-open : aucun scan ne doit echouer a cause du learning. */
    return null;
  }

  if (!hintBlocksAutoNotify(hint)) return null;

  return {
    decision: "block",
    reason: "Revue requise - apprentissage client (demote_to_review)",
    client_id: clientId,
    signal: normalizeSignal(p.critereValeur),
    effect: EFFECT_DEMOTE_TO_REVIEW,
    total: _toFiniteNumber(hint.total),
    cycles_count: _toFiniteNumber(hint.cycles_count),
  };
}

module.exports = {
  DEFAULT_HINTS_RELATIVE_PATH: DEFAULT_HINTS_RELATIVE_PATH,
  MIN_TOTAL: MIN_TOTAL,
  MIN_CYCLES: MIN_CYCLES,
  EFFECT_DEMOTE_TO_REVIEW: EFFECT_DEMOTE_TO_REVIEW,
  isRuntimeLearningEnabled: isRuntimeLearningEnabled,
  normalizeSignal: normalizeSignal,
  normalizeClientId: normalizeClientId,
  resolveHintsPath: resolveHintsPath,
  buildIndex: buildIndex,
  loadHintsIndex: loadHintsIndex,
  resetCache: resetCache,
  lookupHint: lookupHint,
  hintBlocksAutoNotify: hintBlocksAutoNotify,
  evaluateLearningDecision: evaluateLearningDecision,
};
