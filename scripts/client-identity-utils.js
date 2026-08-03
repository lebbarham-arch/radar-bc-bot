'use strict';

/**
 * scripts/client-identity-utils.js
 *
 * Identite client canonique pour les historiques learning.
 *
 * Probleme resolu : le champ `client` des review-decisions contient selon les
 * generations soit un UUID, soit un libelle, soit une variante typographique
 * du libelle. Le runtime ne consomme que l'UUID exact et voit donc un
 * historique fragmente.
 *
 * Contrat :
 *   1. Un UUID valide est toujours la cle canonique prioritaire.
 *   2. Le nom reste une metadonnee d'affichage, jamais une cle de production
 *      des lors qu'un UUID est connu.
 *   3. Les variantes typographiques d'un meme nom sont rapprochees via
 *      normalizeLearningKey (accents, casse, ponctuation).
 *   4. Un nom n'est rattache a un UUID que sur preuve explicite fournie par
 *      une source autoritative deja produite par le cycle.
 *   5. Aucune fusion si le nom pointe vers plusieurs UUID, si aucune preuve
 *      n'existe, ou si la correspondance serait seulement approximative.
 *   6. Toute ambiguite laisse les historiques separes et produit un
 *      avertissement d'audit.
 *
 * Aucun alias code en dur. Aucune regle metier. Aucun acces reseau.
 */

var fs   = require('fs');
var path = require('path');
var normalizeLearningKey = require('./learning-key-utils').normalizeLearningKey;

/* Etat produit par le cycle feedback : seule source de preuve utilisee. */
var DEFAULT_STATE_FILE = path.join(
  __dirname, '..', 'data', 'feedback', 'feedback-learning-state.json'
);

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** true si la valeur est un UUID canonique (8-4-4-4-12). */
function isUuid(value) {
  if (value == null) return false;
  return UUID_RE.test(String(value).trim());
}

/** Forme canonique d'un UUID : trim + minuscules. Chaine vide sinon. */
function canonicalUuid(value) {
  if (!isUuid(value)) return '';
  return String(value).trim().toLowerCase();
}

/**
 * Extrait l'identite brute d'un enregistrement, toutes generations confondues.
 * Les champs sont examines par ordre de fiabilite decroissante ; aucun n'est
 * suppose present.
 */
function extractRawIdentity(record) {
  if (!record || typeof record !== 'object') {
    return { uuid: '', name: '' };
  }

  var uuidCandidates = [
    record.client_id, record.clientId, record.client_uuid, record.uuid,
    record.client,
  ];
  var uuid = '';
  for (var i = 0; i < uuidCandidates.length; i++) {
    var c = canonicalUuid(uuidCandidates[i]);
    if (c) { uuid = c; break; }
  }

  var nameCandidates = [record.client_name, record.clientName];
  /* `client` ne fournit un nom que s'il ne contient pas deja un UUID. */
  if (!isUuid(record.client)) nameCandidates.push(record.client);

  var name = '';
  for (var j = 0; j < nameCandidates.length; j++) {
    var n = nameCandidates[j];
    if (n != null && String(n).trim() !== '') { name = String(n).trim(); break; }
  }

  return { uuid: uuid, name: name };
}

/* ------------------------------------------------------------------ */
/* Registre de preuves nom -> UUID                                     */
/* ------------------------------------------------------------------ */

/**
 * Construit un registre a partir de paires de preuve explicites.
 * Chaque paire doit porter un UUID valide ET un nom non vide, observes
 * ensemble dans une meme source autoritative.
 *
 * Sortie :
 *   byNameKey     : nameKey -> [uuid, ...]   (plusieurs = collision)
 *   displayName   : uuid    -> libelle d'affichage retenu
 *   aliasesByUuid : uuid    -> [libelles distincts observes]
 *   collisions    : [{ name_key, names, uuids }]
 */
function buildIdentityRegistry(evidencePairs) {
  var byNameKey     = Object.create(null);
  var displayName   = Object.create(null);
  var aliasesByUuid = Object.create(null);
  var rawNamesByKey = Object.create(null);

  (evidencePairs || []).forEach(function(pair) {
    if (!pair) return;
    var uuid = canonicalUuid(pair.uuid || pair.client_id);
    var name = pair.name != null ? String(pair.name).trim()
             : (pair.client_name != null ? String(pair.client_name).trim() : '');

    /* Une preuve exige les deux cotes du lien. */
    if (!uuid || !name) return;

    var nameKey = normalizeLearningKey(name);
    if (!nameKey) return;

    if (!byNameKey[nameKey]) byNameKey[nameKey] = [];
    if (byNameKey[nameKey].indexOf(uuid) === -1) byNameKey[nameKey].push(uuid);

    if (!rawNamesByKey[nameKey]) rawNamesByKey[nameKey] = [];
    if (rawNamesByKey[nameKey].indexOf(name) === -1) rawNamesByKey[nameKey].push(name);

    /* Premier libelle observe = libelle d'affichage. */
    if (!displayName[uuid]) displayName[uuid] = name;

    if (!aliasesByUuid[uuid]) aliasesByUuid[uuid] = [];
    if (aliasesByUuid[uuid].indexOf(name) === -1) aliasesByUuid[uuid].push(name);
  });

  var collisions = [];
  Object.keys(byNameKey).forEach(function(nameKey) {
    if (byNameKey[nameKey].length > 1) {
      collisions.push({
        name_key: nameKey,
        names:    (rawNamesByKey[nameKey] || []).slice(),
        uuids:    byNameKey[nameKey].slice(),
      });
    }
  });

  return {
    byNameKey:     byNameKey,
    displayName:   displayName,
    aliasesByUuid: aliasesByUuid,
    collisions:    collisions,
  };
}

/**
 * Lit les preuves depuis l'etat du cycle feedback.
 * Ce fichier est deja produit et consomme par le cycle : aucune source
 * supplementaire, aucun appel reseau.
 * Retourne [] si le fichier est absent ou illisible (fail-open).
 */
function readEvidenceFromCycleState(stateFile) {
  var file = stateFile || DEFAULT_STATE_FILE;
  var pairs = [];

  try {
    var parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    var streams = parsed && parsed.streams;
    if (!streams || typeof streams !== 'object') return pairs;

    Object.keys(streams).forEach(function(k) {
      var s = streams[k];
      if (!s || typeof s !== 'object') return;
      pairs.push({ uuid: s.client_id, name: s.client_name });
    });
  } catch (e) {
    return pairs;
  }

  return pairs;
}

/**
 * Preuves internes aux decisions : un meme enregistrement portant a la fois
 * un UUID et un nom constitue une preuve explicite.
 */
function collectEvidenceFromRecords(records) {
  var pairs = [];
  (records || []).forEach(function(r) {
    var id = extractRawIdentity(r);
    if (id.uuid && id.name) pairs.push({ uuid: id.uuid, name: id.name });
  });
  return pairs;
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Resout la cle canonique d'un enregistrement.
 *
 * Retour :
 *   {
 *     key         : cle d'agregation (UUID si resolu, sinon cle de nom),
 *     client_id   : UUID canonique ou '',
 *     client_name : libelle d'affichage ou '',
 *     resolved    : true si un UUID a ete etabli,
 *     via         : 'client_id' | 'evidence' | 'unresolved',
 *     warning     : motif d'audit ou null
 *   }
 */
function resolveClientIdentity(record, registry) {
  var raw = extractRawIdentity(record);
  var reg = registry || { byNameKey: {}, displayName: {}, aliasesByUuid: {} };

  /* 1. UUID present : priorite absolue, aucune autre source consultee. */
  if (raw.uuid) {
    return {
      key:         raw.uuid,
      client_id:   raw.uuid,
      client_name: raw.name || reg.displayName[raw.uuid] || '',
      resolved:    true,
      via:         'client_id',
      warning:     null,
    };
  }

  var nameKey = normalizeLearningKey(raw.name);

  if (!nameKey) {
    return {
      key:         '(inconnu)',
      client_id:   '',
      client_name: '',
      resolved:    false,
      via:         'unresolved',
      warning:     'identite client absente',
    };
  }

  var candidates = reg.byNameKey[nameKey] || [];

  /* 2. Une seule preuve : rattachement autorise. */
  if (candidates.length === 1) {
    var uuid = candidates[0];
    return {
      key:         uuid,
      client_id:   uuid,
      client_name: reg.displayName[uuid] || raw.name,
      resolved:    true,
      via:         'evidence',
      warning:     null,
    };
  }

  /* 3. Plusieurs UUID pour un meme nom : collision, aucune fusion. */
  if (candidates.length > 1) {
    return {
      key:         nameKey,
      client_id:   '',
      client_name: raw.name,
      resolved:    false,
      via:         'unresolved',
      warning:     'nom associe a plusieurs UUID (' + candidates.join(', ') + ')',
    };
  }

  /* 4. Aucune preuve : historique conserve separement, non executoire. */
  return {
    key:         nameKey,
    client_id:   '',
    client_name: raw.name,
    resolved:    false,
    via:         'unresolved',
    warning:     'aucune preuve reliant ce nom a un UUID',
  };
}

module.exports = {
  DEFAULT_STATE_FILE:        DEFAULT_STATE_FILE,
  isUuid:                    isUuid,
  canonicalUuid:             canonicalUuid,
  extractRawIdentity:        extractRawIdentity,
  buildIdentityRegistry:     buildIdentityRegistry,
  readEvidenceFromCycleState: readEvidenceFromCycleState,
  collectEvidenceFromRecords: collectEvidenceFromRecords,
  resolveClientIdentity:     resolveClientIdentity,
};
