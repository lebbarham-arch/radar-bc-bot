/**
 * notification-quality-gate.runtime.js
 *
 * Runtime CommonJS used directly by radar-bc-bot.js.
 * Ambiguous cases are held for review by returning "block":
 * the production pipeline already snapshots blocked decisions and does not
 * deliver them to Telegram.
 *
 * Client learning overlay (feature-flagged, disabled by default):
 * once the core gate has produced its decision, an optional client learning
 * hint may only harden "allow" into "block". It can never turn "block" into
 * "allow" and can never force a delivery.
 */

"use strict";

var _clientLearning = null;
try {
  _clientLearning = require("../learning/client-learning-runtime.js");
} catch (e) {
  /* Fail-open : l'absence du module learning ne doit jamais casser le gate. */
  _clientLearning = null;
}

var BLOCK_LABELS = new Set([
  "eau", "maintenance", "materiel", "travaux",
  "fourniture", "fournitures", "produit", "produits",
  "service", "services", "equipement",
]);

var WARN_LABELS = new Set([
  "informatique", "cafe", "nettoyage", "securite", "transport",
  "formation", "consommable", "consommables", "cartouche",
  "support", "filtre", "cable", "poste",
]);

function _normalizeLabel(label) {
  return (label || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function _isBareMatch(normalized, term) {
  return normalized === term
    || normalized === term + "s"
    || normalized === term + "es"
    || normalized === term + "x";
}

function _isSingleToken(normalized) {
  return normalized.indexOf(" ") === -1;
}

function validateCritereLabel(valeur) {
  if (!valeur || valeur.trim() === "") {
    return { level: "block", reason: "Le label est vide." };
  }
  var normalized = _normalizeLabel(valeur);
  if (!_isSingleToken(normalized)) return { level: "ok" };

  for (var bt of BLOCK_LABELS) {
    if (_isBareMatch(normalized, _normalizeLabel(bt))) {
      return {
        level: "block",
        reason: '"' + valeur + '" est un terme trop generique.',
      };
    }
  }

  for (var wt of WARN_LABELS) {
    if (_isBareMatch(normalized, _normalizeLabel(wt))) {
      return {
        level: "warn",
        reason: '"' + valeur + '" seul est ambigu.',
      };
    }
  }

  return { level: "ok" };
}

var STRONG_CONTEXTS = {
  eau: [
    "eau potable", "point d eau", "adduction", "pompe", "forage",
    "reseau d eau", "assainissement", "traitement des eaux", "plomberie",
    "distribution d eau", "citerne",
  ],
  informatique: [
    "serveur", "reseau", "ordinateur", "imprimante", "logiciel",
    "materiel informatique", "switch", "firewall", "onduleur",
    "infrastructure", "systeme d information", "si ", "datacenter",
    "virtualisation", "stockage",
  ],
  cafe: [
    "cafe moulu", "cafe en grains", "capsule", "dosette",
    "machine a cafe", "boissons chaudes", "distributeur de boissons",
  ],
  maintenance: [
    "maintenance preventive", "maintenance corrective", "contrat de maintenance",
    "entretien technique", "curatif", "preventif",
  ],
  nettoyage: [
    "nettoyage des locaux", "nettoyage industriel", "entretien des locaux",
    "hygiene", "desinfection", "produits d entretien",
  ],
  securite: [
    "securite incendie", "surveillance", "gardiennage", "telesurveillance",
    "controle d acces", "alarme", "detection incendie",
  ],
  transport: [
    "transport de personnes", "transport de marchandises", "logistique",
    "demenagement", "livraison", "vehicule", "flotte",
  ],
};

var OFF_SCOPE_TERMS = [
  "restauration", "hebergement", "reception", "evenement", "traiteur",
  "hotellerie", "seminaire", "conference", "banquet", "cocktail",
  "location de salle", "animation",
];

var IMPRESSION_SAFE = [
  "toner", "toner photocopieur", "toner laser", "cartouche toner",
  "imprimante", "photocopieur", "multifonction", "reprographie",
];

var IMPRESSION_CONTEXT = [
  "toner", "cartouche", "imprimante", "photocopieur", "reprographie",
  "laser", "impression", "multifonction", "encre",
];

function _norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _containsAny(text, terms) {
  var n = _norm(text);
  for (var i = 0; i < terms.length; i++) {
    if (n.indexOf(_norm(terms[i])) !== -1) return terms[i];
  }
  return null;
}

function _getStrongContextTerms(labelNorm) {
  var keys = Object.keys(STRONG_CONTEXTS);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var keyNorm = _norm(key);
    if (labelNorm === keyNorm || labelNorm.indexOf(keyNorm) === 0) {
      return STRONG_CONTEXTS[key];
    }
  }
  return [];
}

var PORTAL_CUTOFF_MARKERS = [
  "DÉTAILS", "DETAILS",
  "Acheteur public",
  "Date mise en ligne",
  "Date limite",
  "Lieu d’exécution",
  "Date de réception",
];

function cleanBusinessText(text) {
  if (!text) return "";
  var result = text;
  for (var i = 0; i < PORTAL_CUTOFF_MARKERS.length; i++) {
    var idx = result.indexOf(PORTAL_CUTOFF_MARKERS[i]);
    if (idx !== -1) result = result.slice(0, idx);
  }
  return result.trim();
}

function reviewBlock(reason, signals) {
  return {
    decision: "block",
    reason: "Revue requise - " + reason,
    signals: signals,
  };
}

function _checkNotificationQualityCore(input) {
  var signals = [];
  var valeur = input.critere_valeur || "";
  var objet = cleanBusinessText(input.objet || "");
  var body = cleanBusinessText(input.bodyText || "");
  var fullText = objet + " " + body;
  var labelNorm = _norm(valeur);
  var matchTerms = (input.matched_terms || []).map(_norm);

  if (input.is_cancelled) {
    return {
      decision: "block",
      reason: "Avis annule detecte avant envoi",
      signals: ["is_cancelled = true"],
    };
  }

  var safeImpression = IMPRESSION_SAFE.some(function(s) {
    return labelNorm.indexOf(_norm(s)) !== -1;
  }) || IMPRESSION_SAFE.some(function(s) {
    return matchTerms.indexOf(_norm(s)) !== -1;
  });

  if (safeImpression) {
    var hasImprContext = _containsAny(fullText, IMPRESSION_CONTEXT);
    if (hasImprContext) {
      return { decision: "allow", reason: "Contexte impression clair", signals: [] };
    }
  }

  var guard = validateCritereLabel(valeur);

  if (guard.level === "block") {
    var ctxTerms = _getStrongContextTerms(labelNorm);
    var strongCtx = ctxTerms.length > 0 ? _containsAny(fullText, ctxTerms) : null;

    if (strongCtx) {
      signals.push('label block mais contexte fort detecte : "' + strongCtx + '"');
      var offScope1 = _containsAny(objet, OFF_SCOPE_TERMS);
      if (offScope1) {
        signals.push('terme hors-perimetre malgre contexte fort : "' + offScope1 + '"');
        return {
          decision: "block",
          reason: 'Label block + terme hors-perimetre : "' + offScope1 + '"',
          signals: signals,
        };
      }
      return {
        decision: "allow",
        reason: "Label block mais contexte metier fort",
        signals: signals,
      };
    }

    var offScope2 = _containsAny(objet, OFF_SCOPE_TERMS);
    if (offScope2) {
      signals.push('terme hors-perimetre : "' + offScope2 + '"');
      return {
        decision: "block",
        reason: 'Label block + terme hors-perimetre : "' + offScope2 + '"',
        signals: signals,
      };
    }

    signals.push('label block generique : "' + valeur + '"');
    return {
      decision: "block",
      reason: 'Critere trop generique sans contexte metier fort ("' + valeur + '")',
      signals: signals,
    };
  }

  if (guard.level === "warn") {
    var ctxTermsW = _getStrongContextTerms(labelNorm);
    var strongCtxW = ctxTermsW.length > 0 ? _containsAny(fullText, ctxTermsW) : null;

    if (strongCtxW) {
      signals.push('label warn mais contexte fort : "' + strongCtxW + '"');
      return {
        decision: "allow",
        reason: "Label warn avec contexte metier fort",
        signals: signals,
      };
    }

    var offScopeW = _containsAny(objet, OFF_SCOPE_TERMS);
    if (offScopeW) {
      signals.push('label warn + hors-perimetre : "' + offScopeW + '"');
      return {
        decision: "block",
        reason: 'Label warn + terme hors-perimetre : "' + offScopeW + '"',
        signals: signals,
      };
    }

    signals.push('label warn sans contexte fort pour "' + valeur + '"');
    return reviewBlock(
      'Critere ambigu sans contexte metier fort ("' + valeur + '")',
      signals
    );
  }

  if (!objet.trim()) {
    signals.push("objet vide");
    return reviewBlock("Objet vide - impossible de verifier la pertinence", signals);
  }

  var objetNorm = _norm(objet);
  var critereMentionned = objetNorm.indexOf(labelNorm) !== -1
    || matchTerms.some(function(t) { return objetNorm.indexOf(t) !== -1; });

  if (!critereMentionned && matchTerms.length === 0) {
    signals.push("critere absent de l objet et aucun matched_term");
    return reviewBlock(
      "Objet ne contient ni le critere ni un terme matche",
      signals
    );
  }

  return { decision: "allow", reason: "Aucun signal bloquant", signals: [] };
}

/**
 * Overlay learning client.
 *
 * Ordre d'evaluation impose :
 *   1. le gate metier actuel decide ;
 *   2. une decision "block" est conservee telle quelle ;
 *   3. une decision "allow" peut etre durcie en "block" par un hint client
 *      satisfaisant integralement la politique stricte du loader.
 *
 * Aucune transition block -> allow n'est possible ici.
 * Le resultat porte learning_applied = true uniquement lors d'un durcissement
 * reel, afin que l'appelant puisse journaliser l'evenement.
 */
function checkNotificationQuality(input) {
  var base = _checkNotificationQualityCore(input);

  if (!base || base.decision !== "allow") return base;
  if (!_clientLearning) return base;

  var verdict;
  try {
    verdict = _clientLearning.evaluateLearningDecision({
      gateDecision:   base.decision,
      clientId:       input ? input.client_id : null,
      critereValeur:  input ? input.critere_valeur : null,
      env:            process.env,
    });
  } catch (e) {
    /* Fail-open strict : le learning ne fait jamais echouer un scan. */
    return base;
  }

  if (!verdict || verdict.decision !== "block") return base;

  var signals = (base.signals || []).slice();
  signals.push("apprentissage client : demote_to_review");

  return {
    decision:         "block",
    reason:           verdict.reason,
    signals:          signals,
    learning_applied: true,
    learning: {
      client_id:    verdict.client_id,
      signal:       verdict.signal,
      effect:       verdict.effect,
      total:        verdict.total,
      cycles_count: verdict.cycles_count,
    },
  };
}

module.exports = {
  checkNotificationQuality: checkNotificationQuality,
  checkNotificationQualityCore: _checkNotificationQualityCore,
  cleanBusinessText: cleanBusinessText,
};
