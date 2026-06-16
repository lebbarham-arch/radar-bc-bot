"use strict";
/**
 * context-guards.runtime.js
 *
 * Port CommonJS de core/shadow/context-guards.ts.
 * Utilisable directement par radar-bc-bot.js sans build TypeScript.
 *
 * Logique 100 % identique à la version TS.
 * Maintenir en sync avec context-guards.ts lors de toute modification des guards.
 *
 * Shadow uniquement — aucun effet sur le matching legacy ni les notifications.
 *
 * Exports : normSignal, shadowContextGuardBlocked, explainShadowContextGuard
 */

// ─── Helpers internes ────────────────────────────────────────────────────────

function norm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasKw(text, kw) {
  var nk = norm(kw);
  if (!nk) return false;
  var esc = nk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("\\b" + esc).test(norm(text));
}

function levenshtein(a, b) {
  var m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (a === b) return 0;
  var prev = Array.from({ length: n + 1 }, function(_, i) { return i; });
  var curr = new Array(n + 1).fill(0);
  for (var i = 1; i <= m; i++) {
    curr[0] = i;
    for (var j = 1; j <= n; j++) {
      var sub = (prev[j - 1] || 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      var del = (prev[j] || 0) + 1;
      var ins = (curr[j - 1] || 0) + 1;
      curr[j] = Math.min(sub, del, ins);
    }
    var tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n] || 0;
}

function hasKwFuzzy(text, kw) {
  if (hasKw(text, kw)) return true;
  var nk = norm(kw);
  if (nk.length <= 5) return false;
  var maxDist = nk.length >= 8 ? 2 : 1;
  return norm(text).split(/\s+/).some(function(w) {
    return Math.abs(w.length - nk.length) <= maxDist + 1 &&
      w[0] === nk[0] &&
      levenshtein(w, nk) <= maxDist;
  });
}

function hasAnyKw(text, terms) {
  return (terms || []).some(function(t) { return t && hasKwFuzzy(text, t); });
}

// ─── Moteur interne ───────────────────────────────────────────────────────────

/**
 * Évalue un guard et retourne { blocked, reason }.
 * Source unique de vérité pour shadowContextGuardBlocked et
 * explainShadowContextGuard.
 */
function _explainGuard(normSig, cleanText) {
  // ── 1. "reseau" — exige contexte informatique ───────────────────────────
  if (normSig === 'reseau') {
    var IT_CTX = [
      'systeme d information', 'systeme informatique', 'audit si',
      'informatique', 'reseau informatique',
      'securite informatique', 'lan', 'switch', 'routeur', 'serveur',
      'poste de travail', 'ordinateur',
    ];
    return hasAnyKw(cleanText, IT_CTX)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte informatique absent' };
  }
  // ── 2. "scanner" — usage verbal admin ou hors achat scanner matériel ────
  if (normSig === 'scanner') {
    var VERB_SCANNER = [
      'scanner et envoyer', 'a scanner et envoyer', 'scanner puis envoyer',
      'scanner le document',
    ];
    if (hasAnyKw(cleanText, VERB_SCANNER)) {
      return { blocked: true, reason: 'usage verbal scanner détecté' };
    }
    var HARDWARE_SCANNER = [
      'achat de scanner', 'acquisition de scanner', 'fourniture de scanner',
      'scanners', 'acquisition scanner', 'achat scanner',
    ];
    return hasAnyKw(cleanText, HARDWARE_SCANNER)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte achat scanner absent' };
  }
  // ── 3. "pc" — exige un contexte matériel PC explicite (GD-032) ─────────
  // Historique : `informatique`, `bureautique`, `logiciel`, `licence`, `serveur`,
  // `imprimante`, `reseau informatique`, `maintenance informatique` retirés car
  // trop génériques — apparaissent dans noms d'organisme, catégories client et
  // navigation de page même sans relation avec un achat de PC.
  // Ne pas revenir en arrière sans données admin review justifiant le cas.
  if (normSig === 'pc') {
    var IT_CTX_PC = [
      'ordinateur',              // hardware sans ambiguïté
      'poste de travail',        // hardware sans ambiguïté (singulier)
      'postes de travail',       // idem pluriel
      'poste pc',                // auto-référentiel explicite
      'postes pc',               // idem pluriel
      'materiel informatique',   // achat matériel — multi-token, peu de bruit
      'equipement informatique', // idem
      'unite centrale',          // composant PC explicite
      'pc portable',             // self-referential + type explicite
      'pc fixe',                 // idem
      'achat de pc',             // contexte achat explicite
      'acquisition de pc',       // idem
      'fourniture de pc',        // idem
    ];
    return hasAnyKw(cleanText, IT_CTX_PC)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte matériel PC absent' };
  }
  // ── 4. "produits alimentaires" — exige contexte d'achat alimentaire ─────
  if (normSig === 'produits alimentaires') {
    var FOOD_PURCHASE = [
      'achat de produits alimentaires', 'achat des produits alimentaires',
      'achat produits alimentaires',
      'acquisition de produits alimentaires',
      'fourniture de produits alimentaires',
      'fourniture de denrees alimentaires',
      'achat de denrees', 'achat des denrees',
      'denrees alimentaires',
      'alimentation humaine', 'usage humain',
    ];
    return hasAnyKw(cleanText, FOOD_PURCHASE)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte achat alimentaire absent' };
  }
  // ── 5. "alimentation" — bloquer animale, exiger contexte humain ─────────
  if (normSig === 'alimentation') {
    var ANIMAL_CTX = [
      'betail', 'fourrage', 'alimentation animale', 'alimentation de betail',
      'aliment compose', 'bovin', 'ovin', 'caprin', 'elevage',
    ];
    if (hasAnyKw(cleanText, ANIMAL_CTX)) {
      return { blocked: true, reason: 'contexte animal détecté' };
    }
    var HUMAN_CTX = [
      'reception', 'evenement', 'ceremonie', 'invite', 'convives',
      'traiteur', 'repas', 'restauration', 'cantine',
      'usage humain', 'produits alimentaires', 'denrees',
    ];
    return hasAnyKw(cleanText, HUMAN_CTX)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte humain absent' };
  }
  // ── 6. "hygiene" — exige produits/services d'hygiène concrets ───────────
  if (normSig === 'hygiene') {
    var HYGIENE_PRODUCT_CTX = [
      'produits chimiques', 'produit chimique',
      'produits d hygiene', 'produit d hygiene',
      'nettoyage', 'desinfection', 'deratisation', 'desinsectisation',
      'insecticide', 'savon', 'detergent', 'desinfectant',
      'pesticide', 'produits menagers',
    ];
    return hasAnyKw(cleanText, HYGIENE_PRODUCT_CTX)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte produits hygi\u00e8ne absent' };
  }
  // Signal inconnu — aucun guard actif
  return { blocked: false, reason: null };
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Normalise un signal pour la déduplication.
 * Miroir de _normSignal (radar-bc-bot.js).
 */
function normSignal(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim();
}

/**
 * Guard de contexte shadow clean.
 * Retourne true si le signal doit être IGNORÉ pour ce texte.
 * Shadow uniquement — aucun effet sur le matching legacy ni les notifications.
 * Miroir de _shadowContextGuardBlocked (radar-bc-bot.js).
 */
function shadowContextGuardBlocked(normSig, cleanText) {
  return _explainGuard(normSig, cleanText).blocked;
}

/**
 * Version explicable du guard de contexte shadow.
 * Retourne les mêmes décisions que shadowContextGuardBlocked, plus un motif lisible.
 * @returns {{ blocked: boolean, reason: string|null, signal: string }}
 */
function explainShadowContextGuard(normSig, cleanText) {
  var result = _explainGuard(normSig, cleanText);
  return { blocked: result.blocked, reason: result.reason, signal: normSig };
}

// ─── Couche générique de contextualisation des signaux faibles ───────────────

var CTX_EVENEMENTIEL = [
  'reception', 'ceremonie', 'manifestation', 'inauguration',
  'banquet', 'gala', 'convives', 'buffet', 'cocktail', 'soiree',
];
var CTX_COMMUNICATION = [
  'impression diffusion', 'impression et diffusion', 'edition diffusion',
  'conception graphique', 'plaquette', 'brochure',
  'communication institutionnelle', 'diffusion au profit',
];
var CTX_ETUDE_TRAVAUX = [
  'etude technique', 'diagnostic technique', 'audit energetique',
  'maitrise d oeuvre', 'travaux d amenagement', 'rehabilitation batiment',
  'renovation batiment', 'construction batiment',
];
var CTX_PORTAIL = [
  'portail internet', 'site internet', 'site web', 'application mobile',
  'developpement web', 'portail electronique', 'developpement informatique',
];
// Bypass cœur métier (contexte événementiel uniquement)
var CORE_BUSINESS_BYPASS = [
  'usage humain', 'alimentation humaine',
  'cantine', 'restaurant scolaire', 'restauration collective', 'restauration scolaire',
  'internat', 'pensionnat',
  'cuisine', 'repas', 'dejeuner', 'diner',
  'approvisionnement regulier', 'stock alimentaire',
];

// Bypass achat simple (familles communication, étude/travaux, portail)
var SIMPLE_PURCHASE_BYPASS = [
  'achat', 'acquisition', 'fourniture', 'approvisionnement',
];

/**
 * Guard de contexte faible — UNIQUEMENT pour signaux d’inclusion (faibles).
 * CTX_EVENEMENTIEL : “achat” seul NE débloque PAS.
 * Shadow uniquement — aucun effet sur le matching legacy ni les notifications.
 * @returns {{ blocked: boolean, reason: string|null, signal: string }}
 */
function shadowWeakContextBlocked(normSig, cleanText) {
  // 1. Contexte événementiel : “achat” seul NE débloque PAS
  if (hasAnyKw(cleanText, CTX_EVENEMENTIEL)) {
    return hasAnyKw(cleanText, CORE_BUSINESS_BYPASS)
      ? { blocked: false, reason: null, signal: normSig }
      : { blocked: true, reason: 'signal faible + contexte événementiel', signal: normSig };
  }
  // 2-4. Familles sans événementiel : bypass achat simple suffit
  if (hasAnyKw(cleanText, SIMPLE_PURCHASE_BYPASS)) {
    return { blocked: false, reason: null, signal: normSig };
  }
  if (hasAnyKw(cleanText, CTX_COMMUNICATION)) {
    return { blocked: true, reason: 'signal faible + contexte impression/communication', signal: normSig };
  }
  if (hasAnyKw(cleanText, CTX_ETUDE_TRAVAUX)) {
    return { blocked: true, reason: 'signal faible + contexte étude/travaux', signal: normSig };
  }
  if (hasAnyKw(cleanText, CTX_PORTAIL)) {
    return { blocked: true, reason: 'signal faible + bruit portail', signal: normSig };
  }
  return { blocked: false, reason: null, signal: normSig };
}

module.exports = { normSignal, shadowContextGuardBlocked, explainShadowContextGuard, shadowWeakContextBlocked };
