#!/usr/bin/env node
"use strict";
/**
 * replay-shadow-from-input-snapshot.js
 *
 * Rejoue le matching shadow (legacy vs clean) à partir d'un snapshot d'entrée brut
 * (bc-input-<timestamp>.jsonl), capturé AVANT le matching client dans radar-bc-bot.js.
 *
 * Différences clés vs replay-shadow-from-snapshot.js :
 *   - bodyText complet (jusqu'à 8000 chars, pas 400)
 *   - articles[] réels depuis le DOM
 *   - Aucun _keyword injecté (matching pur, sans biais post-décision)
 *   - 1 ligne = 1 BC (pas de multiplication client × critère)
 *   - Toujours --supabase (pas de mode offline : le snapshot n'a pas de client_id)
 *
 * Usage :
 *   node scripts/replay-shadow-from-input-snapshot.js ".\data\input-snapshots\bc-input-....jsonl"
 *   node scripts/replay-shadow-from-input-snapshot.js --latest
 *   node scripts/replay-shadow-from-input-snapshot.js --latest --client "IT Bureautique"
 *   RADAR_BC_EXPORT_REVIEW_CANDIDATES=1 node scripts/...
 *
 * Requis : SUPABASE_URL + SUPABASE_KEY (ou SUPABASE_ANON_KEY) dans .env
 *
 * Ne modifie pas Supabase. Ne scrape pas. Ne notifie pas. Ne touche pas bcs_vus.
 */

try { require("dotenv").config(); } catch (_) {}

var fs   = require("fs");
var path = require("path");
var http  = require("http");
var https = require("https");

var ROOT           = path.join(__dirname, "..");
var INPUT_SNAP_DIR = path.join(ROOT, "data", "input-snapshots");
var SHADOW_DIR     = path.join(ROOT, "data", "shadow");

// ── Flags CLI ─────────────────────────────────────────────────────────────────
function flag(name) {
  return process.argv.indexOf(name) !== -1;
}
function opt(name) {
  var i = process.argv.indexOf(name);
  return (i !== -1 && i + 1 < process.argv.length) ? process.argv[i + 1] : null;
}

var useLatest    = flag("--latest");
var clientFilter   = opt("--client");
var localClientsArg = opt("--local-clients"); // GD-047 mode offline shadow-only

// LEGACY_USE_AI_INCLUSIONS : identique au bot (OFF par défaut)
var LEGACY_USE_AI_INCLUSIONS = process.env.RADAR_BC_LEGACY_USE_AI_INCLUSIONS === "1";

// Seuils clean shadow (identiques au bot)
var CLEAN_WEAK_THRESHOLD   = 5;
var CLEAN_STRONG_THRESHOLD = 15;
// GD-023 : signaux inclusions haute confiance — shadow uniquement (identique au bot)
var CLEAN_TRUSTED_INCLUSION_SCORE = new Set([
  'photocopieur', 'insecticide', 'deratisation', 'desinsectisation',
  'desinfection', 'savon', 'eau minerale',
]);

// ── Client learning hints (shadow advisory — GD-033) ─────────────────────────
// Chargé une seule fois au démarrage. Si absent ou invalide → shadow inchangé.
// Aucune modification legacy, aucune activation prod.
var CLIENT_LEARNING_HINTS = null;
(function() {
  var hintsPath = path.join(ROOT, 'data', 'client-learning', 'client-learning-hints.json');
  try {
    if (fs.existsSync(hintsPath)) {
      CLIENT_LEARNING_HINTS = JSON.parse(fs.readFileSync(hintsPath, 'utf8'));
      console.log('[Hints] Chargés : ' + hintsPath +
        ' (' + (CLIENT_LEARNING_HINTS.clients || []).length + ' client(s))');
    }
  } catch (_) { /* hints absents ou invalides → shadow inchangé */ }
})();

function getClientSignalHints(clientName, signals) {
  if (!CLIENT_LEARNING_HINTS) return [];
  var clientEntry = (CLIENT_LEARNING_HINTS.clients || []).find(function(c) {
    return c.client === clientName;
  });
  if (!clientEntry) return [];
  return (clientEntry.signals || []).filter(function(h) {
    return signals.indexOf(h.signal) !== -1;
  });
}


// ── Profils clients locaux (shadow fallback — GD-043) ─────────────────────
// Charge depuis data/client-profiles/profiles.json si present.
// Priorite : valeurs Supabase si non vides, sinon fallback local.
// Shadow-only -- n'affecte jamais scoring, seuils, hints, legacy, prod.

function normalizeProfileKey(s) {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

var LOCAL_CLIENT_PROFILES_INDEX = null;

(function() {
  var profPath = path.join(ROOT, 'data', 'client-profiles', 'profiles.json');
  try {
    if (fs.existsSync(profPath)) {
      var raw = JSON.parse(fs.readFileSync(profPath, 'utf8'));
      LOCAL_CLIENT_PROFILES_INDEX = {};
      Object.keys(raw).forEach(function(k) {
        if (k === '_comment') return;
        LOCAL_CLIENT_PROFILES_INDEX[normalizeProfileKey(k)] = raw[k];
      });
      var nb = Object.keys(LOCAL_CLIENT_PROFILES_INDEX).length;
      console.log('[LocalProfiles] Charges : ' + profPath + ' (' + nb + ' profil(s))');
    }
  } catch (_) { /* absent ou invalide -> shadow inchange */ }
})();

function mergeLocalProfile(c) {
  if (!LOCAL_CLIENT_PROFILES_INDEX) return c;
  var nom = c.nom || c.id || '';
  var local = LOCAL_CLIENT_PROFILES_INDEX[normalizeProfileKey(nom)] || null;
  if (!local) return c;
  function arr(sv, lv) { return Array.isArray(sv) && sv.length ? sv : (Array.isArray(lv) ? lv : []); }
  function str(sv, lv) { return (typeof sv === 'string' && sv.trim()) ? sv : (typeof lv === 'string' ? lv : ''); }
  return Object.assign({}, c, {
    business_profile:     str(c.business_profile,     local.business_profile),
    technical_profile:    str(c.technical_profile,    local.technical_profile),
    organization_profile: str(c.organization_profile, local.organization_profile),
    profile_label:        str(c.profile_label,        local.profile_label),
    secteurs:             arr(c.secteurs,             local.secteurs),
    types_prestation:     arr(c.types_prestation,     local.types_prestation),
    organismes_cibles:    arr(c.organismes_cibles,    local.organismes_cibles),
    exclusions_metier:    arr(c.exclusions_metier,    local.exclusions_metier),
    produits:             arr(c.produits,             local.produits),
    specifications:       arr(c.specifications,       local.specifications),
  });
}

// ── Résoudre le chemin du snapshot ────────────────────────────────────────────
var snapArg = process.argv.slice(2).find(function(a) {
  return !a.startsWith("--") && (a.includes(".jsonl") || a.includes("bc-input"));
});

var snapPath;
if (useLatest || !snapArg) {
  var latestAlias = path.join(INPUT_SNAP_DIR, "latest-bc-input.jsonl");
  if (fs.existsSync(latestAlias)) {
    snapPath = latestAlias;
  } else {
    if (!fs.existsSync(INPUT_SNAP_DIR)) {
      process.stderr.write("[ERREUR] Dossier input-snapshots introuvable : " + INPUT_SNAP_DIR + "\n");
      process.exit(1);
    }
    var files = fs.readdirSync(INPUT_SNAP_DIR)
      .filter(function(f) { return /^bc-input-.*\.jsonl$/.test(f); })
      .sort();
    if (!files.length) {
      process.stderr.write("[ERREUR] Aucun bc-input-*.jsonl dans " + INPUT_SNAP_DIR + "\n");
      process.exit(1);
    }
    snapPath = path.join(INPUT_SNAP_DIR, files[files.length - 1]);
  }
} else {
  snapPath = path.isAbsolute(snapArg) ? snapArg : path.resolve(process.cwd(), snapArg);
}

if (!fs.existsSync(snapPath)) {
  process.stderr.write("[ERREUR] Snapshot introuvable : " + snapPath + "\n");
  process.exit(1);
}

// ============================================================
// NORMALISATION & MATCHING (copie fidèle du bot)
// ============================================================
function norm(str) {
  return (str || "")
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
  var dp = Array.from({ length: m + 1 }, function(_, i) { return [i]; });
  for (var j = 0; j <= n; j++) dp[0][j] = j;
  for (var i = 1; i <= m; i++)
    for (var jj = 1; jj <= n; jj++)
      dp[i][jj] = a[i-1] === b[jj-1] ? dp[i-1][jj-1]
        : 1 + Math.min(dp[i-1][jj], dp[i][jj-1], dp[i-1][jj-1]);
  return dp[m][n];
}

function hasKwFuzzy(text, kw) {
  if (hasKw(text, kw)) return true;
  var nk = norm(kw);
  if (nk.length <= 5) return false;
  var maxDist = nk.length >= 8 ? 2 : 1;
  return norm(text).split(/\s+/).some(function(w) {
    return Math.abs(w.length - nk.length) <= maxDist + 1 &&
      w[0] === nk[0] && // GD-022 : premiere lettre doit correspondre (evite patisserie/tapisserie)
      levenshtein(w, nk) <= maxDist;
  });
}

function hasAnyKw(text, terms) {
  return (terms || []).some(function(t) { return hasKwFuzzy(text, t); });
}

function isCancelledNotice(text) {
  if (!text) return false;
  var n = norm(text);
  var CANCEL_PATTERNS = [
    "decision d annulation",
    "annulation de l avis d achat",
    "annulation de l avis",
    "avis d achat annule",
    "avis d achat est annule",
    "avis annule",
    "l avis est annule",
  ];
  for (var p = 0; p < CANCEL_PATTERNS.length; p++) {
    var idx = n.indexOf(CANCEL_PATTERNS[p]);
    if (idx === -1) continue;
    var before = n.slice(Math.max(0, idx - 5), idx);
    if (before.trimEnd().endsWith("non")) continue;
    return true;
  }
  return false;
}

function isEnCours(item) {
  if (norm(item.objet || "").includes("annul")) return false;
  if (isCancelledNotice((item.bodyText || "") + " " + (item.objet || ""))) return false;
  if (item.date_limite) {
    var m = item.date_limite.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) {
      var dStr  = m[3] + "-" + m[2] + "-" + m[1];
      var grace = new Date(); grace.setDate(grace.getDate() - 30);
      if (dStr < grace.toISOString().slice(0, 10)) return false;
    }
  }
  return true;
}

// matchCritere : copie exacte du bot (type null → "titre")
function matchCritere(item, c) {
  var incl = LEGACY_USE_AI_INCLUSIONS
    ? [c.valeur].concat(c.ai_inclusions || [])
    : [c.valeur];
  var excl = c.ai_exclusions || [];
  var type = c.type || "titre";
  switch (type) {
    case "region":
      return hasKw(item.wilaya || "", c.valeur) || hasKw(item.lieu || "", c.valeur);
    case "organisme":
      return hasKw(item.organisme || "", c.valeur);
    case "titre": {
      var text = (item.objet || "") + " " + (item._keyword || "");
      if (excl.length && excl.some(function(t) { return hasKw(text, t); })) return false;
      return hasAnyKw(text, incl);
    }
    case "contenu": {
      var textC = (item.articles || [])
          .map(function(a) { return (a.designation || "") + " " + (a.specifications || ""); }).join(" ")
        + " " + (item.bodyText || "")
        + " " + (item.objet || "")
        + " " + (item._keyword || "");
      if (excl.length && excl.some(function(t) { return hasKw(textC, t); })) return false;
      return hasAnyKw(textC, incl);
    }
    default: return false;
  }
}

function itemMatchesCriteres(item, criteres) {
  return criteres.some(function(c) { return matchCritere(item, c); });
}
function getMatchedCriteres(item, criteres) {
  return criteres.filter(function(c) { return matchCritere(item, c); });
}

// ── Shadow clean helpers ──────────────────────────────────────────────────────

function _normSignal(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim();
}

function _shadowHasAnyKw(text, terms) {
  return (terms || []).some(function(t) {
    if (!t) return false;
    var nk = norm(t);
    if (!nk) return false;
    if (nk.length <= 4) {
      var esc = nk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp("\\b" + esc + "\\b").test(norm(text));
    }
    return hasKwFuzzy(text, t);
  });
}

// GD-024 / GD-024f : déléguer au module canonique (évite les dérives de copie)
var _contextGuards    = require('../core/shadow/context-guards.runtime.js');
var _purchaseIntent   = require('../core/shadow/purchase-intent.runtime.js'); // GD-027
function _shadowContextGuardBlocked(normSignal, cleanText) {
  return _contextGuards.shadowContextGuardBlocked(normSignal, cleanText);
}
function _shadowWeakContextBlocked(normSig, cleanText) {
  return _contextGuards.shadowWeakContextBlocked(normSig, cleanText);
}
// NOTE: la fonction inline ci-dessous est remplacée par les délégations ci-dessus.
// Ancien corps supprimé pour éviter la désynchronisation avec context-guards.runtime.js.
function _shadowContextGuardBlocked_UNUSED(normSignal, cleanText) {
  if (normSignal === "reseau") {
    var IT_CTX = [
      "systeme d information", "systeme informatique", "audit si",
      "informatique", "reseau informatique",
      "securite informatique", "lan", "switch", "routeur", "serveur",
      "poste de travail", "ordinateur",
    ];
    return !hasAnyKw(cleanText, IT_CTX);
  }
  if (normSignal === "scanner") {
    var VERB_SCANNER = [
      "scanner et envoyer", "a scanner et envoyer", "scanner puis envoyer",
      "scanner le document",
    ];
    if (hasAnyKw(cleanText, VERB_SCANNER)) return true;
    var HARDWARE_SCANNER = [
      "achat de scanner", "acquisition de scanner", "fourniture de scanner",
      "scanners", "acquisition scanner", "achat scanner",
    ];
    return !hasAnyKw(cleanText, HARDWARE_SCANNER);
  }
  if (normSignal === "pc") {
    var IT_CTX_PC = [
      "ordinateur", "informatique", "poste de travail", "materiel informatique",
      "equipement informatique", "serveur", "logiciel", "licence",
      "reseau informatique", "imprimante", "maintenance informatique",
      "bureautique", "unite centrale",
    ];
    return !hasAnyKw(cleanText, IT_CTX_PC);
  }
  if (normSignal === "produits alimentaires") {
    var FOOD_PURCHASE = [
      "achat de produits alimentaires", "achat des produits alimentaires",
      "achat produits alimentaires",
      "acquisition de produits alimentaires",
      "fourniture de produits alimentaires",
      "fourniture de denrees alimentaires",
      "achat de denrees", "achat des denrees",
      "denrees alimentaires",
      "alimentation humaine", "usage humain",
    ];
    return !hasAnyKw(cleanText, FOOD_PURCHASE);
  }
  if (normSignal === "alimentation") {
    var ANIMAL_CTX = [
      "betail", "fourrage", "alimentation animale", "alimentation de betail",
      "aliment compose", "bovin", "ovin", "caprin", "elevage",
    ];
    if (hasAnyKw(cleanText, ANIMAL_CTX)) return true;
    var HUMAN_CTX = [
      "reception", "evenement", "ceremonie", "invite", "convives",
      "traiteur", "repas", "restauration", "cantine",
      "usage humain", "produits alimentaires", "denrees",
    ];
    return !hasAnyKw(cleanText, HUMAN_CTX);
  }
  if (normSignal === "hygiene") {
    var HYGIENE_PRODUCT_CTX = [
      "produits chimiques", "produit chimique",
      "produits d hygiene", "produit d hygiene",
      "nettoyage", "desinfection", "deratisation", "desinsectisation",
      "insecticide", "savon", "detergent", "desinfectant",
      "pesticide", "produits menagers",
    ];
    return !hasAnyKw(cleanText, HYGIENE_PRODUCT_CTX);
  }
  return false;
}

function _snapExtractObjet(bodyText) {
  if (!bodyText || bodyText.trim() === "") return null;
  var m = bodyText.match(/\bOBJET\s*[:\-]?\s*([^\n\r]{10,200})/i);
  if (m) return m[1].trim().replace(/\s+/g, " ").slice(0, 200);
  var lines = bodyText.split(/[\n\r]+/);
  var BOILER = ["accueil", "liste des avis", "avis d'achat", "marchespublics", "portail"];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.length < 15) continue;
    var lower = line.toLowerCase();
    if (BOILER.some(function(p) { return lower.indexOf(p) !== -1; })) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^(date|organisme|acheteur|lieu|reference|N[o\xb0])/i.test(line)) continue;
    return line.slice(0, 200);
  }
  return null;
}

function buildCleanMatchText(item) {
  var bt = item.bodyText || "";
  var objet = (item.objet || "").trim();
  if (!objet && bt) objet = (_snapExtractObjet(bt) || "");

  var articlesText = "";
  if (item.articles && item.articles.length) {
    articlesText = item.articles.map(function(a) {
      return [(a.designation || ""), (a.specifications || "")].join(" ");
    }).join(" ").trim();
    articlesText = articlesText
      .replace(/Achat de mat[eé]riel technique[,\s]+de logiciels et de mat[eé]riel informatique/gi, " ")
      .trim();
  }

  if (!articlesText && bt) {
    var scanStart = 0;
    var objPos = bt.search(/\bOBJET\b/i);
    if (objPos > 0 && objPos < 1500) scanStart = objPos;
    var searchZone = bt.slice(scanStart);
    var artMatch = searchZone.match(/Articles\s+(?:Tout afficher|N[°o°\s]|D[eé]signation|\d)/i)
                || searchZone.match(/D[eé]signation\s+(?:Quantit[eé]|Unit[eé]|Sp[eé]c)/i)
                || searchZone.match(/(?:Lot|Article)\s+N[°o]/i);
    if (artMatch) {
      var artIdx = searchZone.indexOf(artMatch[0]);
      articlesText = searchZone.slice(artIdx)
        .replace(/^Articles\s+Tout afficher\s+Tout r[eé]duire\s*/i, "")
        .replace(/Achat de mat[eé]riel technique[,\s]+de logiciels et de mat[eé]riel informatique/gi, " ")
        .trim()
        .slice(0, 2000);
    }
  }

  return (objet + " " + articlesText).trim();
}

function _shadowScoreClean(item, criteres) {
  var cleanText = buildCleanMatchText(item);
  var score = 0, signals = [], primarySignals = [], inclusionSignals = [];
  var blocked = false, hasSignal = false;
  var seenNorm = {};
  var guardBlockedList = []; // GD-024g : impact reporting
  var purchaseIntentSignals = []; // GD-027 : signaux rescapés par PI bypass
  var outOfScopePenaltyReason = null; // GD-027

  criteres.forEach(function(c) {
    var excl = c.ai_exclusions || [];
    if (excl.length && excl.some(function(t) { return hasKw(cleanText, t); })) {
      blocked = true;
      signals.push("bloque(" + c.valeur + ")");
      return;
    }
    var normV = _normSignal(c.valeur);
    if (_shadowHasAnyKw(cleanText, [c.valeur]) && _shadowContextGuardBlocked(normV, cleanText)) {
      // guard spécifique actif — tenter PI bypass (GD-027)
      var piSpecific = _purchaseIntent.detectPurchaseIntentNear(cleanText, c.valeur);
      if (piSpecific.detected && !seenNorm[normV]) {
        seenNorm[normV] = true;
        score += _purchaseIntent.PURCHASE_INTENT_SCORE;
        signals.push(c.valeur); primarySignals.push(c.valeur); hasSignal = true;
        purchaseIntentSignals.push({ signal: c.valeur, pattern: piSpecific.pattern });
      } else if (!seenNorm['__gb__' + normV]) {
        seenNorm['__gb__' + normV] = true;
        guardBlockedList.push(_contextGuards.explainShadowContextGuard(normV, cleanText));
      }
    } else if (_shadowHasAnyKw(cleanText, [c.valeur]) && !_shadowContextGuardBlocked(normV, cleanText)) {
      // GD-024f : guard contexte faible appliqué aussi aux signaux primaires
      var weakGuardPrimary = _shadowWeakContextBlocked(normV, cleanText);
      if (weakGuardPrimary.blocked) {
        // guard faible actif — tenter PI bypass (GD-027)
        var piWeak = _purchaseIntent.detectPurchaseIntentNear(cleanText, c.valeur);
        if (piWeak.detected && !seenNorm[normV]) {
          seenNorm[normV] = true;
          score += _purchaseIntent.PURCHASE_INTENT_SCORE;
          signals.push(c.valeur); primarySignals.push(c.valeur); hasSignal = true;
          purchaseIntentSignals.push({ signal: c.valeur, pattern: piWeak.pattern });
        } else if (!seenNorm['__wg__' + normV]) {
          seenNorm['__wg__' + normV] = true;
          guardBlockedList.push(weakGuardPrimary);
        }
      } else if (!seenNorm[normV]) {
        seenNorm[normV] = true;
        score += 10;
        signals.push(c.valeur);
        primarySignals.push(c.valeur);
        hasSignal = true;
      }
    }
    (c.ai_inclusions || []).forEach(function(t) {
      if (!t) return;
      var normT = _normSignal(t);
      if (!_shadowHasAnyKw(cleanText, [t])) return;
      if (_shadowContextGuardBlocked(normT, cleanText)) {
        // guard spécifique actif — tenter PI bypass (GD-027)
        var piInclSpec = _purchaseIntent.detectPurchaseIntentNear(cleanText, t);
        if (piInclSpec.detected && !seenNorm[normT]) {
          seenNorm[normT] = true;
          score += _purchaseIntent.PURCHASE_INTENT_SCORE;
          signals.push(t); inclusionSignals.push(t); hasSignal = true;
          purchaseIntentSignals.push({ signal: t, pattern: piInclSpec.pattern });
        } else if (!seenNorm['__gb__' + normT]) {
          seenNorm['__gb__' + normT] = true;
          guardBlockedList.push(_contextGuards.explainShadowContextGuard(normT, cleanText));
        }
        return;
      }
      // GD-024f : guard contexte faible sur signaux d'inclusion
      var weakGuardIncl = _shadowWeakContextBlocked(normT, cleanText);
      if (weakGuardIncl.blocked) {
        // guard faible actif — tenter PI bypass (GD-027)
        var piInclWeak = _purchaseIntent.detectPurchaseIntentNear(cleanText, t);
        if (piInclWeak.detected && !seenNorm[normT]) {
          seenNorm[normT] = true;
          score += _purchaseIntent.PURCHASE_INTENT_SCORE;
          signals.push(t); inclusionSignals.push(t); hasSignal = true;
          purchaseIntentSignals.push({ signal: t, pattern: piInclWeak.pattern });
        } else if (!seenNorm['__wg__' + normT]) {
          seenNorm['__wg__' + normT] = true;
          guardBlockedList.push(weakGuardIncl);
        }
        return;
      }
      if (!seenNorm[normT]) {
        seenNorm[normT] = true;
        score += CLEAN_TRUSTED_INCLUSION_SCORE.has(normT) ? 10 : 5; // GD-023
        signals.push(t);
        inclusionSignals.push(t);
        hasSignal = true;
      }
    });
  });

  // GD-027 : out-of-scope penalty (si aucun PI bypass actif)
  if (!purchaseIntentSignals.length) {
    var oosResult = _purchaseIntent.detectOutOfScopeContext(cleanText);
    if (oosResult.blocked && score > 0) {
      score = Math.max(0, score - _purchaseIntent.OUT_OF_SCOPE_PENALTY);
      outOfScopePenaltyReason = oosResult.reason;
    }
  }

  var decision;
  if (blocked && hasSignal)       decision = "bloque";
  else if (!hasSignal || score < 5) decision = "no_match";
  else if (score >= 15)           decision = "match_fort";
  else                            decision = "match_faible";

  return {
    match:                hasSignal && !blocked && score >= 5,
    score:                score,
    signals:              signals,
    primarySignals:       primarySignals,
    inclusionSignals:     inclusionSignals,
    blocked:              blocked,
    decision:             decision,
    reason:   signals.filter(function(s) { return s.indexOf("bloque(") === -1; })
                     .slice(0, 3).join(", ") || "aucun signal",
    guardBlockedList:     guardBlockedList,      // GD-024g
    purchaseIntentSignals: purchaseIntentSignals, // GD-027
    outOfScopePenalty:    outOfScopePenaltyReason, // GD-027
  };
}

function _itemMatchesCleanCriteres(item, criteres) {
  return _shadowScoreClean(item, criteres).match;
}

function _dedupByBcId(list) {
  var seen = {}, result = [];
  list.forEach(function(e) {
    var bid = e.bc_id || "";
    if (!seen[bid]) { seen[bid] = true; result.push(e); }
    else {
      // Conserver l'entrée avec le clean_score le plus élevé
      var idx = result.findIndex(function(x) { return x.bc_id === bid; });
      if (idx !== -1 && (e.clean_score || 0) > (result[idx].clean_score || 0)) {
        result[idx] = e;
      }
    }
  });
  return result;
}

// ── _computeShadowComparison : copie exacte du bot ────────────────────────────
function _computeShadowComparison(client, items, criteres, radarType) {
  var both = 0, legacyOnlyList = [], cleanOnlyList = [], neitherCount = 0;
  var bothScores = [];
  var guardImpactAll = []; // GD-024g : impact global tous items
  var clientName = client.nom || "";
  var wantDetail = !clientFilter ||
                   clientName === clientFilter ||
                   String(client.id) === clientFilter;

  items.forEach(function(item) {
    if (!isEnCours(item)) return;
    var legacy = itemMatchesCriteres(item, criteres);
    var clean  = _itemMatchesCleanCriteres(item, criteres);

    if (legacy && clean) {
      var cleanResultBoth = _shadowScoreClean(item, criteres);
      bothScores.push(cleanResultBoth.score);
      guardImpactAll = guardImpactAll.concat(cleanResultBoth.guardBlockedList || []); // GD-024g
      both++;
    } else if (legacy && !clean) {
      if (wantDetail) {
        var matched       = getMatchedCriteres(item, criteres);
        var cleanResult   = _shadowScoreClean(item, criteres);
        guardImpactAll = guardImpactAll.concat(cleanResult.guardBlockedList || []); // GD-024g
        var legacyExcerpt = ((item.objet || "") + " " + (item.bodyText || "")).slice(0, 150);
        var cleanExcerpt  = buildCleanMatchText(item).slice(0, 150);
        var signalPool = [];
        criteres.forEach(function(c2) {
          signalPool.push(c2.valeur);
          (c2.ai_inclusions || []).forEach(function(t) { if (t) signalPool.push(t); });
        });
        var cleanTextForPool = buildCleanMatchText(item);
        var availSignals = signalPool.filter(function(t) {
          return hasAnyKw(cleanTextForPool, [t]);
        });
        legacyOnlyList.push({
          client:                clientName,
          bc_id:                 item.id || "",
          objet:                 (item.objet || "").slice(0, 120),
          critere:               matched[0] ? matched[0].valeur : "",
          legacy_text_excerpt:   legacyExcerpt,
          clean_text_excerpt:    cleanExcerpt,
          clean_score:           cleanResult.score,
          matched_signals:       cleanResult.signals,
          clean_decision:        cleanResult.decision,
          reason:                cleanResult.reason || "aucun signal propre détecté",
          available_signal_count: availSignals.length,
          available_signals:      availSignals.slice(0, 10),
          guard_blocked_signals:  cleanResult.guardBlockedList || [], // GD-024g
        });
      } else {
        legacyOnlyList.push({ bc_id: item.id || "", critere: "" });
      }
    } else if (!legacy && clean) {
      if (wantDetail) {
        var cleanResult2      = _shadowScoreClean(item, criteres);
        guardImpactAll = guardImpactAll.concat(cleanResult2.guardBlockedList || []); // GD-024g
        var cleanTextExcerpt2 = buildCleanMatchText(item).slice(0, 200);
        var cleanSigs2        = cleanResult2.signals.filter(function(s) { return s.indexOf("bloque(") === -1; });
        var primCount2        = cleanResult2.primarySignals.length;
        var inclCount2        = cleanResult2.inclusionSignals.length;
        var isWeakSingle2     = cleanSigs2.length === 1 && cleanResult2.score < CLEAN_STRONG_THRESHOLD;
        var isStrong2         = cleanResult2.score >= CLEAN_STRONG_THRESHOLD;
        var exclusionHit2     = cleanResult2.blocked;
        var isAutoCandidate2  = isStrong2 && !isWeakSingle2 && !exclusionHit2;
        // ── Hints client learning (advisory, shadow only — GD-033) ──────────────
        var hintScoreAdj   = 0;
        var hintBlockAuto  = false;
        var hintApplied    = [];
        if (CLIENT_LEARNING_HINTS && clientName) {
          var sigHints2 = getClientSignalHints(clientName, cleanSigs2);
          sigHints2.forEach(function(h) {
            hintScoreAdj   += (h.score_adjustment || 0);
            if (h.block_auto_notify) hintBlockAuto = true;
            hintApplied.push(h.signal + ':' + h.recommended_effect);
          });
          if (hintScoreAdj !== 0) {
            var adjustedScore2 = cleanResult2.score + hintScoreAdj;
            isStrong2      = adjustedScore2 >= CLEAN_STRONG_THRESHOLD;
            isWeakSingle2  = cleanSigs2.length === 1 && adjustedScore2 < CLEAN_STRONG_THRESHOLD;
            isAutoCandidate2 = isStrong2 && !isWeakSingle2 && !exclusionHit2;
          }
          if (hintBlockAuto) isAutoCandidate2 = false;
        }
        var strengthReason2;
        if (exclusionHit2) {
          strengthReason2 = "exclu (ai_exclusions)";
        } else if (primCount2 > 0 && inclCount2 > 0) {
          strengthReason2 = "valeur_principale + inclusions (" + primCount2 + "p+" + inclCount2 + "i)";
        } else if (primCount2 > 0) {
          strengthReason2 = "valeur_principale seule (" + primCount2 + "p)";
        } else if (inclCount2 >= 2) {
          strengthReason2 = "inclusions_multiples (" + inclCount2 + "i, score=" + cleanResult2.score + ")";
        } else if (isWeakSingle2) {
          strengthReason2 = "signal_secondaire_unique (" + (cleanSigs2[0] || "?") + ")";
        } else {
          strengthReason2 = "inclusions_faibles (score=" + cleanResult2.score + ")";
        }
        cleanOnlyList.push({
          client:                clientName,
          bc_id:                 item.id || "",
          objet:                 (item.objet || "").slice(0, 120),
          clean_score:           cleanResult2.score,
          matched_signals:       cleanResult2.signals,
          clean_decision:        cleanResult2.decision,
          reason:                cleanResult2.reason,
          signal_origin:         primCount2 > 0 ? "primary" : "inclusion",
          primary_signal_count:  primCount2,
          inclusion_signal_count: inclCount2,
          exclusion_hit:         exclusionHit2 || undefined,
          strength:              isStrong2 ? "strong" : "weak",
          strength_reason:       strengthReason2,
          clean_text_excerpt:    cleanTextExcerpt2,
          weak_single_signal:    isWeakSingle2 || undefined,
          auto_notify_candidate: isAutoCandidate2 || undefined,
          review_candidate:      (!isAutoCandidate2 && cleanResult2.score >= CLEAN_WEAK_THRESHOLD) || undefined,
          hint_score_adj:        hintScoreAdj  || undefined,
          hint_block_auto:       hintBlockAuto || undefined,
          hint_applied:          hintApplied.length ? hintApplied.join(',') : undefined,
        });
      } else {
        cleanOnlyList.push({ bc_id: item.id || "" });
      }
    } else {
      neitherCount++;
    }
  });

  var critCount = {};
  legacyOnlyList.forEach(function(e) {
    var c = e.critere || "inconnu";
    critCount[c] = (critCount[c] || 0) + 1;
  });
  var topCriteria = Object.keys(critCount)
    .sort(function(a, b) { return critCount[b] - critCount[a]; })
    .slice(0, 5)
    .map(function(c) { return { critere: c, count: critCount[c] }; });

  var legacyOnlyUniq = _dedupByBcId(legacyOnlyList);
  var cleanOnlyUniq  = _dedupByBcId(cleanOnlyList);
  var legacyDupCount = legacyOnlyList.length - legacyOnlyUniq.length;
  var cleanDupCount  = cleanOnlyList.length  - cleanOnlyUniq.length;

  var bothStrongCount = bothScores.filter(function(s) { return s >= CLEAN_STRONG_THRESHOLD; }).length;
  var bothWeakCount   = bothScores.filter(function(s) { return s <  CLEAN_STRONG_THRESHOLD; }).length;

  var cleanOnlyStrong = cleanOnlyUniq.filter(function(e) { return e.strength === "strong"; });
  var cleanOnlyWeak   = cleanOnlyUniq.filter(function(e) { return e.strength === "weak"; });
  var weakSingleCount = cleanOnlyUniq.filter(function(e) { return e.weak_single_signal; }).length;
  var autoNotifCands  = cleanOnlyUniq.filter(function(e) { return e.auto_notify_candidate; });
  var reviewCands     = cleanOnlyUniq.filter(function(e) { return e.review_candidate && !e.auto_notify_candidate; });
  var primaryBased    = cleanOnlyUniq.filter(function(e) { return e.signal_origin === "primary"; });
  var inclusionOnly   = cleanOnlyUniq.filter(function(e) { return e.signal_origin === "inclusion"; });

  var legacyTotal = both + legacyOnlyUniq.length;
  var cleanTotal  = both + cleanOnlyUniq.length;
  var fpRate      = legacyTotal > 0 ? Math.round(legacyOnlyUniq.length / legacyTotal * 100) : 0;

  var recommendation = (cleanOnlyStrong.length >= 5 && weakSingleCount < cleanOnlyUniq.length * 0.5)
    ? "candidate_for_clean_shadow_review"
    : "keep_legacy_production";

  return {
    client_id:                  client.id,
    client_name:                clientName,
    // Profil enrichi (GD-041) -- shadow reporting uniquement, jamais dans le scoring
    business_profile:     client.business_profile     || "",
    technical_profile:    client.technical_profile    || "",
    organization_profile: client.organization_profile || "",
    profile_label:        client.profile_label        || "",
    secteurs:             Array.isArray(client.secteurs)          ? client.secteurs          : [],
    types_prestation:     Array.isArray(client.types_prestation)  ? client.types_prestation  : [],
    organismes_cibles:    Array.isArray(client.organismes_cibles) ? client.organismes_cibles : [],
    exclusions_metier:    Array.isArray(client.exclusions_metier) ? client.exclusions_metier : [],
    produits:             Array.isArray(client.produits)          ? client.produits          : [],
    specifications:       Array.isArray(client.specifications)    ? client.specifications    : [],
    radar_type:                 radarType,
    total_checked:              items.filter(function(i) { return isEnCours(i); }).length,
    legacy:                     legacyTotal,
    clean:                      cleanTotal,
    both_match:                 both,
    both_strong_count:          bothStrongCount,
    both_weak_count:            bothWeakCount,
    clean_strong_count:         bothStrongCount + cleanOnlyStrong.length,
    clean_weak_count:           bothWeakCount   + cleanOnlyWeak.length,
    legacy_only_count:          legacyOnlyUniq.length,
    legacy_only_unique_count:   legacyOnlyUniq.length,
    clean_only_count:           cleanOnlyUniq.length,
    clean_only_unique_count:    cleanOnlyUniq.length,
    clean_only_strong_count:    cleanOnlyStrong.length,
    clean_only_weak_count:      cleanOnlyWeak.length,
    weak_single_signal_count:   weakSingleCount,
    duplicate_count:            legacyDupCount + cleanDupCount,
    neither:                    neitherCount,
    fp_rate_pct:                fpRate,
    top_criteria_legacy_only:   topCriteria,
    clean_auto_notify_candidates: autoNotifCands.length,
    clean_review_candidates:      reviewCands.length,
    clean_blocked_or_weak:        weakSingleCount,
    primary_based_matches:        primaryBased.length,
    inclusion_only_matches:       inclusionOnly.length,
    recommendation:               recommendation,
    legacy_only:              wantDetail ? legacyOnlyUniq : [],
    clean_only:               wantDetail ? cleanOnlyUniq  : [],
    review_candidates_detail: wantDetail ? reviewCands    : [],
    detail_available:         wantDetail,
    guard_impact:             guardImpactAll, // GD-024g : tous blocages guards (read-only)
  };
}

// ============================================================
// CHARGEMENT DU SNAPSHOT D'ENTRÉE
// ============================================================
/**
 * Lit bc-input-<timestamp>.jsonl — 1 ligne = 1 BC brut.
 * Mappe bc_id → id pour que les fonctions de matching puissent utiliser item.id.
 * bodyText et articles sont présents tels quels (complets).
 * _keyword n'est PAS défini (matching pur sans biais de critère).
 */
function loadInputSnapshot(snapPath) {
  var raw = fs.readFileSync(snapPath, "utf8");
  var lines = raw.trim().split("\n");
  var items = [], parsed = 0, skipped = 0;

  lines.forEach(function(line) {
    if (!line.trim()) return;
    var row;
    try { row = JSON.parse(line); } catch (_) { skipped++; return; }
    if (!row.bc_id && !row.id) { skipped++; return; }
    parsed++;
    var item = {
      id:          row.bc_id || row.id || "",
      objet:       row.objet       || "",
      reference:   row.reference   || "",
      organisme:   row.organisme   || row.acheteur || "",
      lieu:        row.lieu        || "",
      wilaya:      row.wilaya      || "",
      date_limite: row.date_limite || "",
      url:         row.url         || "",
      articles:    row.articles    || [],
      bodyText:    row.bodyText    || "",
      _keyword:    "",              // volontairement vide — matching pur
      _snap_ts:    row.scan_timestamp || "",
    };
    items.push(item);
  });

  var enCours = items.filter(function(i) { return isEnCours(i); }).length;
  console.log("[Replay-V2] Snapshot : " + parsed + " BCs ("
    + enCours + " en cours, " + (parsed - enCours) + " expirés/annulés)"
    + (skipped ? ", " + skipped + " lignes ignorées" : ""));
  return items;
}

// ============================================================
// GD-047 : Chargement clients locaux (mode offline shadow-only, experimental)
// ============================================================
function loadClientsFromLocalFile(filePath) {
  var abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(abs)) {
    process.stderr.write("[ERREUR] --local-clients : fichier introuvable : " + abs + "\n");
    process.exit(1);
  }
  var rawLocal;
  try {
    rawLocal = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    process.stderr.write("[ERREUR] --local-clients : JSON invalide : " + e.message + "\n");
    process.exit(1);
  }
  if (!Array.isArray(rawLocal)) {
    process.stderr.write("[ERREUR] --local-clients : le fichier doit etre un tableau JSON.\n");
    process.exit(1);
  }
  var PACK_LIMITS_LOCAL = {
    starter:  { maxCriteres: 5  },
    pro:      { maxCriteres: 20 },
    business: { maxCriteres: 50 },
  };
  var localClients = rawLocal
    .filter(function(c) {
      return (c.criteres || []).some(function(cr) {
        return (cr.radar_type || "bc") === "bc";
      });
    })
    .map(function(c) {
      c = mergeLocalProfile(c); // GD-043 profil enrichi + GD-047
      var pack   = c.pack || "starter";
      var limits = PACK_LIMITS_LOCAL[pack] || PACK_LIMITS_LOCAL.starter;
      var allCr  = (c.criteres || []).filter(function(cr) {
        return (cr.radar_type || "bc") === "bc";
      });
      return {
        id:       c.id,
        nom:      c.nom || c.id,
        pack:     pack,
        criteres: allCr.slice(0, limits.maxCriteres),
        // Profil enrichi (GD-041) -- shadow reporting uniquement, jamais dans le scoring
        business_profile:     c.business_profile     || c.profile_label || "",
        technical_profile:    c.technical_profile    || "",
        organization_profile: c.organization_profile || "",
        profile_label:        c.profile_label        || "",
        secteurs:             Array.isArray(c.secteurs)          ? c.secteurs          : [],
        types_prestation:     Array.isArray(c.types_prestation)  ? c.types_prestation  : [],
        organismes_cibles:    Array.isArray(c.organismes_cibles) ? c.organismes_cibles : [],
        exclusions_metier:    Array.isArray(c.exclusions_metier) ? c.exclusions_metier : [],
        produits:             Array.isArray(c.produits)          ? c.produits          : [],
        specifications:       Array.isArray(c.specifications)    ? c.specifications    : [],
      };
    });
  var nbCr = localClients.reduce(function(s, c) { return s + c.criteres.length; }, 0);
  console.log("[LocalClients] " + localClients.length + " client(s) charge(s) depuis " + abs
    + " (" + nbCr + " critere(s))");
  return localClients;
}

// CHARGEMENT CLIENTS SUPABASE (read-only)
// ============================================================
function loadClientsFromSupabase() {
  var supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  var supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
                  || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    process.stderr.write("[ERREUR] SUPABASE_URL et SUPABASE_KEY (ou SUPABASE_ANON_KEY) requis dans .env\n");
    process.exit(1);
  }
  var url = supabaseUrl.replace(/\/$/, "") + "/rest/v1/clients?actif=eq.true&select=*,criteres(*)";
  return new Promise(function(resolve, reject) {
    var lib = url.startsWith("https") ? https : http;
    var parsed = new (require("url").URL)(url);
    var options = {
      hostname: parsed.hostname,
      port:     parsed.port || (url.startsWith("https") ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   "GET",
      headers:  {
        "apikey":        supabaseKey,
        "Authorization": "Bearer " + supabaseKey,
        "Content-Type":  "application/json",
      },
    };
    var req = lib.request(options, function(res) {
      var data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        try {
          var rows = JSON.parse(data);
          if (!Array.isArray(rows)) {
            return reject(new Error("Réponse Supabase inattendue : " + data.slice(0, 200)));
          }
          var PACK_LIMITS = {
            starter:  { maxCriteres: 5  },
            pro:      { maxCriteres: 20 },
            business: { maxCriteres: 50 },
          };
          var clients = rows
            .filter(function(c) {
              return (c.criteres || []).some(function(cr) {
                return (cr.radar_type || "bc") === "bc";
              });
            })
            .map(function(c) {
              c = mergeLocalProfile(c); // GD-043 shadow fallback
              var pack   = c.pack || "starter";
              var limits = PACK_LIMITS[pack] || PACK_LIMITS.starter;
              var allCr  = (c.criteres || []).filter(function(cr) {
                return (cr.radar_type || "bc") === "bc";
              });
              return {
                id:       c.id,
                nom:      c.nom || c.id,
                pack:     pack,
                criteres: allCr.slice(0, limits.maxCriteres),
                // Profil enrichi (GD-041) -- transport shadow uniquement, jamais dans le scoring
                business_profile:     c.business_profile     || c.profile_label || "",
                technical_profile:    c.technical_profile    || "",
                organization_profile: c.organization_profile || "",
                profile_label:        c.profile_label        || "",
                secteurs:             Array.isArray(c.secteurs)          ? c.secteurs          : [],
                types_prestation:     Array.isArray(c.types_prestation)  ? c.types_prestation  : [],
                organismes_cibles:    Array.isArray(c.organismes_cibles) ? c.organismes_cibles : [],
                exclusions_metier:    Array.isArray(c.exclusions_metier) ? c.exclusions_metier : [],
                produits:             Array.isArray(c.produits)          ? c.produits          : [],
                specifications:       Array.isArray(c.specifications)    ? c.specifications    : [],
              };
            });
          var nbCriteres = clients.reduce(function(s, c) { return s + c.criteres.length; }, 0);
          console.log("[Replay-V2] Clients Supabase : " + clients.length
            + " clients, " + nbCriteres + " criteres (avec ai_inclusions)");
          resolve(clients);
        } catch (e) {
          reject(new Error("Supabase JSON invalide : " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ============================================================
// ÉCRITURE DU RAPPORT
// ============================================================
function writeShadowReplayReport(shadowAccum, snapPath, mode) {
  if (!shadowAccum.length) {
    console.log("[Replay-V2] Aucun resultat a ecrire.");
    return null;
  }
  try { fs.mkdirSync(SHADOW_DIR, { recursive: true }); } catch (_) {}

  var ts    = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  var fname = "shadow-bc-input-replay-" + ts + ".json";
  var fpath = path.join(SHADOW_DIR, fname);

  var totLegacy     = shadowAccum.reduce(function(s, e) { return s + e.legacy; }, 0);
  var totClean      = shadowAccum.reduce(function(s, e) { return s + e.clean; }, 0);
  var totLegacyOnly = shadowAccum.reduce(function(s, e) { return s + e.legacy_only_count; }, 0);
  var totCleanOnly  = shadowAccum.reduce(function(s, e) { return s + e.clean_only_count; }, 0);
  var fpRate        = totLegacy > 0 ? Math.round(totLegacyOnly / totLegacy * 100) : 0;

  // Log par client
  shadowAccum.forEach(function(e) {
    console.log("[Shadow][" + e.client_name + "]"
      + "  legacy="        + e.legacy
      + "  clean="         + e.clean
      + "  both="          + e.both_match
      + "  legacy_only="   + e.legacy_only_count  + " (" + e.fp_rate_pct + "% FP)"
      + "  clean_only="    + e.clean_only_count
      + "  strong="        + (e.clean_only_strong_count || 0)
      + "  auto_cands="    + (e.clean_auto_notify_candidates || 0)
      + "  review_cands="  + (e.clean_review_candidates || 0)
      + "  => " + (e.recommendation || "?"));
  });
  console.log("[Shadow] TOTAL  legacy=" + totLegacy + "  clean=" + totClean
    + "  legacy_only=" + totLegacyOnly + " (" + fpRate + "% FP)"
    + "  clean_only=" + totCleanOnly);

  var report = {
    scan_date:           new Date().toISOString(),
    snapshot_type:       "input_v2",       // distingue du scan-snapshot V1
    replay_source:       snapPath,
    clients_mode:        mode,
    client_filter:       clientFilter || null,
    legacy_ai_inclusions: LEGACY_USE_AI_INCLUSIONS,
    summary: {
      total_legacy_matches: totLegacy,
      total_clean_matches:  totClean,
      total_legacy_only:    totLegacyOnly,
      total_clean_only:     totCleanOnly,
      guard_impact_global:  shadowAccum.reduce(function(acc, e) { // GD-024g
        return acc.concat(e.guard_impact || []);
      }, []),
      fp_rate_pct:          fpRate,
    },
    clients: shadowAccum,
  };

  fs.writeFileSync(fpath, JSON.stringify(report, null, 2), "utf8");
  console.log("[Replay-V2] Rapport ecrit : " + fname);

  // Export review candidates (opt-in)
  if (process.env.RADAR_BC_EXPORT_REVIEW_CANDIDATES === "1") {
    var allRC = [];
    shadowAccum.forEach(function(e) {
      (e.review_candidates_detail || []).forEach(function(rc) { allRC.push(rc); });
    });
    if (allRC.length) {
      var rcFname = "review-candidates-input-replay-" + ts + ".json";
      var rcFpath = path.join(SHADOW_DIR, rcFname);
      fs.writeFileSync(rcFpath, JSON.stringify({
        scan_date:        new Date().toISOString(),
        snapshot_type:    "input_v2",
        source_report:    fname,
        replay_source:    snapPath,
        total_candidates: allRC.length,
        candidates:       allRC,
      }, null, 2), "utf8");
      console.log("[Replay-V2] Review candidates : " + rcFname + " (" + allRC.length + " entrees)");
    }
  }

  return fpath;
}

// ============================================================
// POINT D'ENTRÉE
// ============================================================
async function main() {
  console.log("[Replay-V2] Snapshot : " + snapPath);
  console.log("[Replay-V2] LEGACY_USE_AI_INCLUSIONS=" + LEGACY_USE_AI_INCLUSIONS);
  if (clientFilter) console.log("[Replay-V2] Filtre client : " + clientFilter);

  // 1. Charger le snapshot d'entrée brut
  var items = loadInputSnapshot(snapPath);
  if (!items.length) {
    process.stderr.write("[ERREUR] Snapshot vide ou invalide.\n");
    process.exit(1);
  }

  // 2. Charger les clients (local --local-clients GD-047 ou Supabase par defaut)
  var clients;
  if (localClientsArg) {
    // GD-047 : mode offline local shadow-only
    clients = loadClientsFromLocalFile(localClientsArg);
  } else {
    try {
      clients = await loadClientsFromSupabase();
    } catch (e) {
      process.stderr.write("[ERREUR] Chargement Supabase : " + e.message + "\n");
      process.exit(1);
    }
  }
  if (!clients.length) {
    process.stderr.write("[ERREUR] Aucun client BC actif.\n");
    process.exit(1);
  }

  // 3. Pour chaque client, lancer _computeShadowComparison sur TOUS les items
  //    (pas de filtrage par client_id — le snapshot est cross-client)
  var shadowAccum = [];
  for (var ci = 0; ci < clients.length; ci++) {
    var client  = clients[ci];
    var criteres = client.criteres;

    // Appliquer filtre --client si demandé
    if (clientFilter) {
      var cn = client.nom || "";
      if (cn !== clientFilter && String(client.id) !== clientFilter) continue;
    }

    console.log("[Replay-V2] " + client.nom + " : " + items.length + " BCs, "
      + criteres.length + " criteres");

    var result = _computeShadowComparison(client, items, criteres, "bc");
    shadowAccum.push(result);
  }

  // 4. Écrire le rapport
  writeShadowReplayReport(shadowAccum, snapPath, localClientsArg ? "local" : "supabase");
}

main().catch(function(e) {
  process.stderr.write("[ERREUR] " + e.message + "\n" + (e.stack || "") + "\n");
  process.exit(1);
});
