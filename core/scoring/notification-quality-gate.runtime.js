/**
 * notification-quality-gate.runtime.js
 *
 * Port CommonJS de core/scoring/notification-quality-gate.ts
 * Utilisable directement par radar-bc-bot.js sans build TypeScript.
 *
 * Logique 100 % identique à la version TS — zéro réseau, zéro DB.
 * Maintenir en sync avec notification-quality-gate.ts.
 */

"use strict";

// ─── Label guard (inline de criteria-label-guard.ts) ─────────────────────────

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
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

function _isBareMatch(normalized, term) {
  if (normalized === term)        return true;
  if (normalized === term + "s")  return true;
  if (normalized === term + "es") return true;
  if (normalized === term + "x")  return true;
  return false;
}

function _isSingleToken(normalized) {
  return normalized.indexOf(" ") === -1;
}

function validateCritereLabel(valeur) {
  if (!valeur || valeur.trim() === "") {
    return { level: "block", reason: "Le label est vide." };
  }
  var normalized = _normalizeLabel(valeur);
  if (!_isSingleToken(normalized)) {
    return { level: "ok" };
  }
  for (var bt of BLOCK_LABELS) {
    if (_isBareMatch(normalized, _normalizeLabel(bt))) {
      return {
        level:  "block",
        reason: '"' + valeur + '" est un terme trop generique.',
      };
    }
  }
  for (var wt of WARN_LABELS) {
    if (_isBareMatch(normalized, _normalizeLabel(wt))) {
      return {
        level:  "warn",
        reason: '"' + valeur + '" seul est ambigu.',
      };
    }
  }
  return { level: "ok" };
}

// ─── Contextes métier forts ───────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
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

// ─── Gate principale ──────────────────────────────────────────────────────────

/**
 * checkNotificationQuality(input) → { decision, reason, signals }
 *
 * @param {object} input
 * @param {string}   input.critere_valeur
 * @param {string}   input.objet
 * @param {string}   [input.bodyText]
 * @param {string[]} [input.matched_terms]
 * @param {number}   [input.score]
 * @param {string}   [input.radar_type]
 * @param {boolean}  [input.is_cancelled]
 * @returns {{ decision: 'allow'|'warn'|'block', reason: string, signals: string[] }}
 */
// ─── Nettoyage portail ───────────────────────────────────────────────────────

var PORTAL_CUTOFF_MARKERS = [
  "DÉTAILS", "DETAILS",
  "Acheteur public",
  "Date mise en ligne",
  "Date limite",
  "Lieu d’exécution",
  "Date de réception",
];

/**
 * Retourne la partie métier du texte, coupée avant les métadonnées portail.
 */
function cleanBusinessText(text) {
  if (!text) return "";
  var result = text;
  for (var i = 0; i < PORTAL_CUTOFF_MARKERS.length; i++) {
    var idx = result.indexOf(PORTAL_CUTOFF_MARKERS[i]);
    if (idx !== -1) result = result.slice(0, idx);
  }
  return result.trim();
}

function checkNotificationQuality(input) {
  var signals    = [];
  var valeur     = input.critere_valeur || "";
  var objetRaw   = input.objet          || "";
  var bodyRaw    = input.bodyText       || "";
  // Textes coupés avant les métadonnées portail
  var objet      = cleanBusinessText(objetRaw);
  var body       = cleanBusinessText(bodyRaw);
  var fullText   = objet + " " + body;
  var labelNorm  = _norm(valeur);
  var matchTerms = (input.matched_terms || []).map(_norm);

  // Règle 0 — avis annulé
  if (input.is_cancelled) {
    return {
      decision: "block",
      reason:   "Avis annule detecte avant envoi",
      signals:  ["is_cancelled = true"],
    };
  }

  // Règle 1 — protection impression/toner
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

  // Règle 2 — label guard
  var guard = validateCritereLabel(valeur);

  if (guard.level === "block") {
    var ctxTerms  = _getStrongContextTerms(labelNorm);
    var strongCtx = ctxTerms.length > 0 ? _containsAny(fullText, ctxTerms) : null;

    if (strongCtx) {
      signals.push('label block mais contexte fort detecte : "' + strongCtx + '"');
      var offScope1 = _containsAny(objet, OFF_SCOPE_TERMS);
      if (offScope1) {
        signals.push('terme hors-perimetre malgre contexte fort : "' + offScope1 + '"');
        return {
          decision: "block",
          reason:   'Label block + terme hors-perimetre : "' + offScope1 + '"',
          signals:  signals,
        };
      }
      return { decision: "allow", reason: "Label block mais contexte metier fort", signals: signals };
    }

    var offScope2 = _containsAny(objet, OFF_SCOPE_TERMS);
    if (offScope2) {
      signals.push('terme hors-perimetre : "' + offScope2 + '"');
      return {
        decision: "block",
        reason:   'Label block + terme hors-perimetre : "' + offScope2 + '"',
        signals:  signals,
      };
    }

    signals.push('label block generique : "' + valeur + '"');
    return {
      decision: "block",
      reason:   'Critere trop generique sans contexte metier fort ("' + valeur + '")',
      signals:  signals,
    };
  }

  if (guard.level === "warn") {
    var ctxTermsW  = _getStrongContextTerms(labelNorm);
    var strongCtxW = ctxTermsW.length > 0 ? _containsAny(fullText, ctxTermsW) : null;

    if (strongCtxW) {
      signals.push('label warn mais contexte fort : "' + strongCtxW + '"');
      return { decision: "allow", reason: "Label warn avec contexte metier fort", signals: signals };
    }

    var offScopeW = _containsAny(objet, OFF_SCOPE_TERMS);
    if (offScopeW) {
      signals.push('label warn + hors-perimetre : "' + offScopeW + '"');
      return {
        decision: "block",
        reason:   'Label warn + terme hors-perimetre : "' + offScopeW + '"',
        signals:  signals,
      };
    }

    signals.push('label warn sans contexte fort pour "' + valeur + '"');
    return {
      decision: "warn",
      reason:   'Critere ambigu sans contexte metier fort ("' + valeur + '") — verifier',
      signals:  signals,
    };
  }

  // Règle 3 — objet vide
  if (!objet.trim()) {
    signals.push("objet vide");
    return {
      decision: "warn",
      reason:   "Objet vide — impossible de verifier la pertinence",
      signals:  signals,
    };
  }

  // Règle 3b — critère absent de l'objet
  var objetNorm = _norm(objet);
  var critereMentionned = objetNorm.indexOf(labelNorm) !== -1
    || matchTerms.some(function(t) { return objetNorm.indexOf(t) !== -1; });

  if (!critereMentionned && matchTerms.length === 0) {
    signals.push("critere absent de l objet et aucun matched_term");
    return {
      decision: "warn",
      reason:   "Objet ne contient ni le critere ni un terme matche — verifier",
      signals:  signals,
    };
  }

  // Tout OK
  return { decision: "allow", reason: "Aucun signal bloquant", signals: [] };
}

module.exports = { checkNotificationQuality, cleanBusinessText };
