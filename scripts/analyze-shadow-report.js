#!/usr/bin/env node
"use strict";

/**
 * scripts/analyze-shadow-report.js
 *
 * Analyse un fichier shadow JSON existant sans relancer le scan.
 * Compatible avec les rapports anciens (sans champs strength/auto_notify_candidate)
 * et les rapports nouveaux (avec ces champs ajoutés par feat: enrich BC shadow strength).
 *
 * Usage :
 *   node scripts/analyze-shadow-report.js data/shadow/shadow-bc-2026-06-07T20-02-40.json
 *   node scripts/analyze-shadow-report.js --last              # dernier rapport automatiquement
 *   node scripts/analyze-shadow-report.js <file> --client "Client Test"
 */

var fs   = require("fs");
var path = require("path");

// ── Seuils (identiques au bot) ───────────────────────────────────────────────
var CLEAN_WEAK_THRESHOLD   = 5;
var CLEAN_STRONG_THRESHOLD = 15;

// ── Args ─────────────────────────────────────────────────────────────────────
var args         = process.argv.slice(2);
var clientFilter = null;
var reportPath   = null;
var useLastFile  = false;

var exportReview      = false;
var exportReviewCsv   = false;
var exportAutoCands   = false; // GD-025 : export admin auto_candidates
var exportComparison  = false; // GD-026 : export legacy vs clean comparison

for (var i = 0; i < args.length; i++) {
  if (args[i] === "--last")              { useLastFile = true; continue; }
  if (args[i] === "--export-review")     { exportReview = true; continue; }
  if (args[i] === "--export-review-csv") { exportReviewCsv = true; exportAutoCands = true; exportComparison = true; continue; } // GD-026
  if (args[i] === "--export-auto-candidates") { exportAutoCands = true; continue; }
  if (args[i] === "--export-comparison")       { exportComparison = true; continue; } // GD-026
  if (args[i] === "--client" && args[i + 1]) { clientFilter = args[++i]; continue; }
  if (!reportPath && !args[i].startsWith("--")) reportPath = args[i];
}

// Résoudre le chemin depuis la racine du projet (parent de scripts/)
var ROOT = path.join(__dirname, "..");

// ── GD-025 : Signal Risk Tier — chargement dynamique depuis review-decisions ─
/**
 * Charge la table de risque depuis le dernier summary review-decisions disponible.
 * Retourne un Map normSig → verdict ('Très fiable'|'Fiable'|'Ambigu'|'Risqué'|'Insuffisant').
 * Si aucun fichier disponible, retourne un Map vide (→ 'inconnu' par défaut).
 */
function loadSignalRiskTable() {
  var rdDir = path.join(ROOT, "data", "review-decisions");
  var table = {};
  try {
    if (!fs.existsSync(rdDir)) return table;
    // Chercher les summary-*.json du plus récent au plus ancien
    var files = fs.readdirSync(rdDir)
      .filter(function(f) { return /^summary-.*\.json$/.test(f); })
      .sort()
      .reverse();
    if (!files.length) return table;
    var raw = JSON.parse(fs.readFileSync(path.join(rdDir, files[0]), "utf8"));
    var signals = raw.by_signal || [];
    signals.forEach(function(s) {
      if (s.signal && s.verdict) {
        table[normSignalKey(s.signal)] = s.verdict;
      }
    });
  } catch (_) { /* silencieux — la table reste vide */ }
  return table;
}

function normSignalKey(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim();
}

/**
 * Retourne le tier de risque d'un signal.
 * Ordre de priorité : table review-decisions > table statique > 'inconnu'.
 */
var SIGNAL_RISK_TABLE = null; // chargé lazily

// Table statique de base pour signaux non encore évalués
var STATIC_RISK_TABLE = {
  // Très fiable
  'deratisation': 'Très fiable', 'desinsectisation': 'Très fiable',
  'insecticide': 'Très fiable', 'photocopieur': 'Très fiable',
  'toner': 'Très fiable', 'cartouche': 'Très fiable',
  // Fiable
  'nettoyage locaux': 'Fiable', 'produits d entretien': 'Fiable',
  'eau potable': 'Fiable', 'traitement des eaux': 'Fiable',
  // Ambigu
  'eau minerale': 'Ambigu', 'cafe': 'Ambigu', 'the': 'Ambigu',
  'alimentation': 'Ambigu', 'hygiene': 'Ambigu', 'javel': 'Ambigu',
  'systeme d information': 'Ambigu',
  // Risqué
  'pc': 'Risqué', 'patisserie': 'Risqué', 'informatique': 'Risqué',
  // Insuffisant
  'produits alimentaires': 'Insuffisant', 'desinfection': 'Insuffisant',
  'savon': 'Insuffisant', 'eau': 'Insuffisant',
};

function getSignalRiskTier(signalRaw) {
  var ns = normSignalKey(signalRaw || "");
  if (!SIGNAL_RISK_TABLE) SIGNAL_RISK_TABLE = loadSignalRiskTable();
  // Priorité 1 : table issue des review decisions réelles
  if (SIGNAL_RISK_TABLE[ns]) return SIGNAL_RISK_TABLE[ns];
  // Priorité 2 : table statique de base
  if (STATIC_RISK_TABLE[ns]) return STATIC_RISK_TABLE[ns];
  return 'inconnu';
}

/**
 * Enrichit un auto_candidate avec signal_risk_tier (tier le plus défavorable),
 * signal_risk_detail (par signal), warning, auto_candidate_reason, report_date.
 */
function enrichAutoCandidate(e, reportDate) {
  var sigs = (e.matched_signals || [])
    .filter(function(s) { return s && s.indexOf("bloque(") === -1; });

  // Tier par signal
  var tierDetail = {};
  sigs.forEach(function(s) { tierDetail[s] = getSignalRiskTier(s); });

  // Tier global = le plus défavorable parmi tous les signaux connus
  // TIER_ORDER : index 0 = le plus risqué, index 5 = le plus fiable
  var TIER_ORDER = ['Risqué', 'Ambigu', 'Insuffisant', 'inconnu', 'Fiable', 'Très fiable'];
  var overallTier = sigs.length > 0 ? (tierDetail[sigs[0]] || 'inconnu') : 'inconnu';
  sigs.slice(1).forEach(function(s) {
    var t = tierDetail[s] || 'inconnu';
    // Garder le tier avec l'index le plus bas (= le plus défavorable)
    if (TIER_ORDER.indexOf(t) < TIER_ORDER.indexOf(overallTier)) overallTier = t;
  });

  var hasRisk = overallTier === 'Risqué' || overallTier === 'Ambigu';
  var warningSigs = sigs.filter(function(s) {
    var t = tierDetail[s];
    return t === 'Risqué' || t === 'Ambigu';
  });

  var reason = "score=" + (e.clean_score || 0) +
    ", origin=" + (e.signal_origin || "?") +
    ", strength=" + (e.strength || "strong");

  return Object.assign({}, e, {
    report_date:         reportDate || null,
    auto_candidate_reason: reason,
    signal_risk_tier:    overallTier,
    signal_risk_detail:  tierDetail,
    warning:             hasRisk ? ("signaux à risque : " + warningSigs.join(", ")) : null,
  });
}



// ── GD-026 : Legacy vs Clean Comparison ─────────────────────────────────────
/**
 * Construit les lignes de comparaison legacy_sent / clean_auto / clean_review.
 * Sources :
 *   legacy_only[]  → legacy a envoyé (clean n'a pas matché)
 *   clean_only[]   → clean détecte, legacy n'a pas envoyé
 *   both_match (compteur seul) → les deux ont matché (pas de détail individuel)
 *
 * comparison_bucket :
 *   legacy_sent_only         — legacy only, clean_score < 5
 *   legacy_and_clean_review  — legacy + clean aurait reviewé (5 ≤ score < 15)
 *   legacy_and_clean_auto    — legacy + clean aurait auto-notifié (score ≥ 15)
 *   clean_auto_only          — clean auto, legacy n'a pas envoyé
 *   clean_review_only        — clean review, legacy n'a pas envoyé
 */
function buildComparisonRows(reportClients, reportDate) {
  var rows = [];
  reportClients.forEach(function(rawClient) {
    var cName = rawClient.client_name || "";

    // ── legacy_only : legacy a envoyé, clean n'a pas matché (score < 5)
    (rawClient.legacy_only || []).forEach(function(e) {
      var cs = e.clean_score || 0;
      var isLegacyAuto   = cs >= CLEAN_STRONG_THRESHOLD;
      var isLegacyReview = !isLegacyAuto && cs >= CLEAN_WEAK_THRESHOLD;
      var bucket = isLegacyAuto   ? "legacy_and_clean_auto"
                 : isLegacyReview ? "legacy_and_clean_review"
                 :                  "legacy_sent_only";
      var sigs = (e.matched_signals || []).filter(function(s) { return s.indexOf("bloque(") === -1; });
      var enriched = enrichAutoCandidate(e, reportDate);
      rows.push({
        report_date:            reportDate || null,
        client:                 e.client || cName,
        bc_id:                  e.bc_id || "",
        title:                  e.objet || "",
        clean_text_excerpt:     e.clean_text_excerpt || "",
        legacy_sent:            true,
        clean_auto_candidate:   isLegacyAuto,
        clean_review_candidate: isLegacyReview,
        clean_score:            cs,
        matched_signals:        sigs,
        signal_risk_tier:       enriched.signal_risk_tier || "inconnu",
        signal_risk_detail:     enriched.signal_risk_detail || {},
        warning:                enriched.warning || null,
        comparison_bucket:      bucket,
      });
    });

    // ── clean_only : clean détecte, legacy n'a pas envoyé
    (rawClient.clean_only || []).map(enrichEntry).forEach(function(e) {
      var enriched = enrichAutoCandidate(e, reportDate);
      var isAuto   = !!e.auto_notify_candidate;
      var isReview = !isAuto && !!e.review_candidate;
      var bucket   = isAuto ? "clean_auto_only" : isReview ? "clean_review_only" : "clean_weak_only";
      var sigs = (e.matched_signals || []).filter(function(s) { return s.indexOf("bloque(") === -1; });
      rows.push({
        report_date:            reportDate || null,
        client:                 e.client || cName,
        bc_id:                  e.bc_id || "",
        title:                  e.objet || e.objet || "",
        clean_text_excerpt:     e.clean_text_excerpt || "",
        legacy_sent:            false,
        clean_auto_candidate:   isAuto,
        clean_review_candidate: isReview,
        clean_score:            e.clean_score || 0,
        matched_signals:        sigs,
        signal_risk_tier:       enriched.signal_risk_tier || "inconnu",
        signal_risk_detail:     enriched.signal_risk_detail || {},
        warning:                enriched.warning || null,
        comparison_bucket:      bucket,
      });
    });
  });
  return rows;
}


if (useLastFile || !reportPath) {
  var shadowDir = path.join(ROOT, "data", "shadow");
  var files = fs.readdirSync(shadowDir)
    .filter(function(f) { return f.startsWith("shadow-bc-") && f.endsWith(".json"); })
    .sort();
  if (!files.length) { console.error("[ERROR] Aucun rapport dans " + shadowDir); process.exit(1); }
  reportPath = path.join(shadowDir, files[files.length - 1]);
  console.log("Rapport auto-détecté : " + files[files.length - 1]);
}

if (!fs.existsSync(reportPath)) {
  console.error("[ERROR] Fichier introuvable : " + reportPath); process.exit(1);
}

var report;
try { report = JSON.parse(fs.readFileSync(reportPath, "utf-8")); }
catch (e) { console.error("[ERROR] JSON invalide : " + e.message); process.exit(1); }

// ── Normalisation signal (même logique que _normSignal dans le bot) ──────────
function normSignal(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ").trim();
}

// ── Enrichir une entrée clean_only si les champs strength/qualification manquent ─
function enrichEntry(e) {
  var sigs     = (e.matched_signals || []).filter(function(s) { return s.indexOf("bloque(") === -1; });
  var isWeak   = sigs.length === 1 && (e.clean_score || 0) < CLEAN_STRONG_THRESHOLD;
  var isStrong = (e.clean_score || 0) >= CLEAN_STRONG_THRESHOLD;
  var exclHit  = e.exclusion_hit || false;
  var primCount = e.primary_signal_count != null
    ? e.primary_signal_count
    : null;  // inconnu dans anciens rapports — pas de backfill fiable
  var inclCount = e.inclusion_signal_count != null
    ? e.inclusion_signal_count
    : null;
  // signal_origin : anciens rapports : on ne peut pas distinguer fiablement
  var origin = e.signal_origin || (primCount != null ? (primCount > 0 ? "primary" : "inclusion") : "unknown");
  // strength_reason : backfill générique si absent
  var strengthReason = e.strength_reason || (
    exclHit ? "exclu (ai_exclusions)" :
    isWeak  ? "signal_secondaire_unique (" + (sigs[0] || "?") + ")" :
              "score=" + (e.clean_score || 0)
  );
  var isAutoCandidate = isStrong && !isWeak && !exclHit;
  // Si déjà enrichi par nouveau bot, garder les champs mais recalculer candidature avec exclusion_hit
  if (e.strength) {
    return Object.assign({}, e, {
      signal_origin:         e.signal_origin || origin,
      primary_signal_count:  primCount,
      inclusion_signal_count: inclCount,
      strength_reason:       e.strength_reason || strengthReason,
      // Recalculer auto_notify avec !exclusion_hit (correction des anciens rapports)
      auto_notify_candidate: isAutoCandidate || undefined,
      review_candidate:      (!isAutoCandidate && (e.clean_score || 0) >= CLEAN_WEAK_THRESHOLD) || undefined,
    });
  }
  return Object.assign({}, e, {
    strength:               isStrong ? "strong" : "weak",
    signal_origin:          origin,
    primary_signal_count:   primCount,
    inclusion_signal_count: inclCount,
    exclusion_hit:          exclHit || undefined,
    strength_reason:        strengthReason,
    weak_single_signal:     isWeak || undefined,
    auto_notify_candidate:  isAutoCandidate || undefined,
    review_candidate:       (!isAutoCandidate && (e.clean_score || 0) >= CLEAN_WEAK_THRESHOLD) || undefined,
  });
}

// ── GD-024g : catégorisation des blocages par guard ─────────────────────────
/**
 * Mappe un motif de blocage vers une catégorie lisible.
 * Catégories :
 *   weak_context:event          — contexte événementiel (réception, manifestation…)
 *   weak_context:communication  — contexte impression/communication
 *   weak_context:study_works    — contexte étude/travaux
 *   weak_context:portal_noise   — bruit portail web
 *   guard:specific:<signal>     — guard spécifique (pc, hygiene, alimentation…)
 */
function classifyGuardCategory(reason, signal) {
  var r = (reason || "").toLowerCase();
  if (r.indexOf("contexte événementiel") !== -1 || r.indexOf("evenementiel") !== -1)
    return "weak_context:event";
  if (r.indexOf("impression") !== -1 || r.indexOf("communication") !== -1)
    return "weak_context:communication";
  if (r.indexOf("étude") !== -1 || r.indexOf("travaux") !== -1 || r.indexOf("etude") !== -1)
    return "weak_context:study_works";
  if (r.indexOf("portail") !== -1 || r.indexOf("portal") !== -1)
    return "weak_context:portal_noise";
  // Guard spécifique : identifier par signal
  return "guard:specific:" + (signal || "?");
}

// ── Analyse d'un client ───────────────────────────────────────────────────────
function analyzeClient(c) {
  var cleanOnly = (c.clean_only || []).map(enrichEntry);

  var strong       = cleanOnly.filter(function(e) { return e.strength === "strong"; });
  var weak         = cleanOnly.filter(function(e) { return e.strength === "weak"; });
  var wsig         = cleanOnly.filter(function(e) { return e.weak_single_signal; });
  var autoCands    = cleanOnly.filter(function(e) { return e.auto_notify_candidate; });
  var revCands     = cleanOnly.filter(function(e) { return e.review_candidate && !e.auto_notify_candidate; });
  var exclHits     = cleanOnly.filter(function(e) { return e.exclusion_hit; });
  var primaryBased = cleanOnly.filter(function(e) { return e.signal_origin === "primary"; });
  var inclOnly     = cleanOnly.filter(function(e) { return e.signal_origin === "inclusion"; });

  // Top signaux faibles
  var sigCount = {};
  wsig.forEach(function(e) {
    (e.matched_signals || []).forEach(function(s) {
      var n = normSignal(s);
      sigCount[n] = (sigCount[n] || 0) + 1;
    });
  });
  var topWeakSigs = Object.keys(sigCount)
    .sort(function(a, b) { return sigCount[b] - sigCount[a]; })
    .slice(0, 8)
    .map(function(s) { return s + "×" + sigCount[s]; });

  // Recommandation locale
  var recommendation = c.recommendation ||
    (strong.length >= 5 && wsig.length < cleanOnly.length * 0.5
      ? "candidate_for_clean_shadow_review"
      : "keep_legacy_production");

  return {
    client_name:           c.client_name,
    has_detail:            c.detail_available,
    legacy:                c.legacy,
    clean:                 c.clean,
    both:                  c.both_match,
    legacy_only:           c.legacy_only_count,
    fp_rate_pct:           c.fp_rate_pct,
    clean_only:            cleanOnly.length,
    clean_strong_count:    (c.clean_strong_count != null ? c.clean_strong_count : (c.both_strong_count || 0) + strong.length),
    clean_weak_count:      (c.clean_weak_count   != null ? c.clean_weak_count   : (c.both_weak_count   || 0) + weak.length),
    clean_only_strong:     strong,
    clean_only_weak_count: weak.length,
    weak_single_count:     wsig.length,
    top_weak_signals:      topWeakSigs,
    auto_notify_cands:     autoCands,
    review_cands:          revCands,
    duplicate_count:       c.duplicate_count || 0,
    exclusion_hit_count:   exclHits.length,
    primary_based_count:   primaryBased.length,
    inclusion_only_count:  inclOnly.length,
    recommendation:        recommendation,
  };
}

// ── Affichage ─────────────────────────────────────────────────────────────────
// ── Helpers CSV ───────────────────────────────────────────────────────────────
function csvCell(v) {
  var s = v === null || v === undefined ? "" : String(v);
  // Échapper si la valeur contient ; " ou saut de ligne
  if (s.indexOf(";") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildReviewCsv(candidates) {
  var BOM = "\uFEFF";  // UTF-8 BOM pour Excel français
  var SEP = ";";
  var COLS = ["client","bc_id","score","signal_origin","matched_signals",
              "strength_reason","weak_single_signal","clean_text_excerpt","decision"];
  var lines = [BOM + COLS.join(SEP)];
  candidates.forEach(function(e) {
    var sigs = Array.isArray(e.matched_signals)
      ? e.matched_signals.filter(function(s) { return s.indexOf("bloque(") === -1; }).join(", ")
      : (e.matched_signals || "");
    var row = [
      csvCell(e.client || ""),
      csvCell(e.bc_id  || ""),
      csvCell(e.clean_score != null ? e.clean_score : ""),
      csvCell(e.signal_origin || ""),
      csvCell(sigs),
      csvCell(e.strength_reason || ""),
      csvCell(e.weak_single_signal ? "oui" : ""),
      csvCell((e.clean_text_excerpt || "").replace(/[\r\n]+/g, " ").trim()),
      csvCell(""),   // decision : vide pour saisie humaine
    ];
    lines.push(row.join(SEP));
  });
  return lines.join("\r\n");  // CRLF standard CSV
}

var clients = report.clients || [];
if (clientFilter) {
  clients = clients.filter(function(c) {
    return c.client_name === clientFilter || String(c.client_id) === clientFilter;
  });
}

console.log("\n====================================================");
console.log("ANALYSE SHADOW BC : " + path.basename(reportPath));
console.log("Date rapport : " + (report.scan_date || "?"));
console.log("====================================================\n");

clients.forEach(function(rawClient) {
  var a = analyzeClient(rawClient);

  console.log("CLIENT : " + a.client_name);
  console.log("─────────────────────────────────────────────────");

  if (!a.has_detail) {
    console.log("  (pas de détail disponible — relancer avec RADAR_BC_MATCH_SHADOW_CLIENT=\"" + a.client_name + "\")");
    console.log("  legacy=" + a.legacy + "  clean=" + a.clean + "  both=" + a.both +
                "  legacy_only=" + a.legacy_only + "  fp=" + a.fp_rate_pct + "%\n");
    return;
  }

  console.log("  legacy=" + a.legacy +
              "  clean=" + a.clean +
              "  both=" + a.both +
              "  legacy_only=" + a.legacy_only +
              "  fp=" + a.fp_rate_pct + "%");
  console.log("  clean_strong=" + a.clean_strong_count +
              "  clean_weak=" + a.clean_weak_count);
  console.log("  clean_only=" + a.clean_only +
              "  clean_only_strong=" + a.clean_only_strong.length +
              "  clean_only_weak=" + a.clean_only_weak_count);
  console.log("  weak_single_signal=" + a.weak_single_count +
              "  auto_candidates=" + a.auto_notify_cands.length +
              "  review_candidates=" + a.review_cands.length +
              "  doublons_elim=" + a.duplicate_count);
  console.log("  signal_origin:  primary_based=" + a.primary_based_count +
              "  inclusion_only=" + a.inclusion_only_count +
              "  exclusion_hit=" + a.exclusion_hit_count);

  // Clean_only strong → candidats auto
  if (a.auto_notify_cands.length) {
    console.log("\n  ── AUTO-NOTIFY CANDIDATES (score >= 15) ──────────────");
    a.auto_notify_cands.slice(0, 10).forEach(function(e) {
      var enriched = enrichAutoCandidate(e, report.scan_date);
      var riskLabel = "[" + enriched.signal_risk_tier + "]";
      console.log("    bc_id=" + e.bc_id +
                  "  score=" + e.clean_score +
                  "  risk=" + riskLabel +
                  "  signaux=" + (e.matched_signals || []).filter(function(s){ return s.indexOf("bloque(") === -1; }).join(", ") +
                  (enriched.warning ? "  ⚠ " + enriched.warning : "") +
                  (e.objet ? "\n      objet=" + e.objet.slice(0, 80) : ""));
    });
  } else {
    console.log("\n  ── AUTO-NOTIFY CANDIDATES : aucun (score >= 15 requis)");
  }

  // Candidats à review
  if (a.review_cands.length) {
    console.log("\n  ── REVIEW CANDIDATES (5 <= score < 15) ──────────────");
    a.review_cands.slice(0, 10).forEach(function(e) {
      console.log("    bc_id=" + e.bc_id +
                  "  score=" + e.clean_score +
                  "  origin=" + (e.signal_origin || "?") +
                  "  signaux=" + (e.matched_signals || []).join(", ") +
                  (e.weak_single_signal ? "  [weak_single]" : "") +
                  (e.exclusion_hit ? "  [EXCLU]" : "") +
                  (e.strength_reason ? "  raison=" + e.strength_reason : ""));
    });
  }

  // Top signaux faibles
  if (a.top_weak_signals.length) {
    console.log("\n  ── TOP SIGNAUX FAIBLES (weak_single_signal) ──────────");
    console.log("    " + a.top_weak_signals.join("  "));
  }

  // Signaux bloqués par guards (GD-024e/024g) — read-only reporting
  var guardBlocked = [];
  // Depuis guard_impact du client (nouveau format)
  (rawClient.guard_impact || []).forEach(function(g) {
    if (g && g.blocked && g.signal) guardBlocked.push(g);
  });
  // Fallback : legacy_only[].guard_blocked_signals (ancien format)
  if (!guardBlocked.length) {
    (rawClient.legacy_only || []).forEach(function(e) {
      (e.guard_blocked_signals || []).forEach(function(g) {
        if (g && g.blocked && g.signal) guardBlocked.push(g);
      });
    });
  }
  if (guardBlocked.length) {
    var catCount    = {};
    var reasonCount = {};
    var sigCount2   = {};
    guardBlocked.forEach(function(g) {
      var r = g.reason || "motif inconnu";
      var s = g.signal || "?";
      var cat = classifyGuardCategory(r, s);
      catCount[cat]    = (catCount[cat]    || 0) + 1;
      reasonCount[r]   = (reasonCount[r]   || 0) + 1;
      sigCount2[s]     = (sigCount2[s]     || 0) + 1;
    });
    console.log("\n  ── SIGNAUX BLOQUÉS PAR GUARDS (" + guardBlocked.length + " occurrences) ─────");
    // Par catégorie
    Object.keys(catCount)
      .sort(function(a, b) { return catCount[b] - catCount[a]; })
      .forEach(function(cat) {
        console.log("    [" + cat + "]  " + catCount[cat] + "x");
      });
    // Par motif détaillé
    var topReasons = Object.keys(reasonCount)
      .sort(function(a, b) { return reasonCount[b] - reasonCount[a]; })
      .slice(0, 5);
    if (topReasons.length > 1 || (topReasons.length === 1 && topReasons[0] !== Object.keys(catCount)[0])) {
      topReasons.forEach(function(r) {
        console.log("      " + reasonCount[r] + "x  " + r);
      });
    }
    // Top signaux concernés
    var topGuardSigs = Object.keys(sigCount2)
      .sort(function(a, b) { return sigCount2[b] - sigCount2[a]; })
      .slice(0, 6)
      .map(function(s) { return s + "×" + sigCount2[s]; });
    if (topGuardSigs.length) {
      console.log("    signaux : " + topGuardSigs.join("  "));
    }
  }

  // Recommandation
  console.log("\n  ── RECOMMANDATION ─────────────────────────────────────");
  if (a.recommendation === "candidate_for_clean_shadow_review") {
    console.log("  [REVIEW] clean_only_strong suffisant — envisager revue manuelle des clean_only");
  } else {
    console.log("  [LEGACY] Trop de signaux faibles/uniques — maintenir matching legacy en production");
    console.log("           clean_only_strong=" + a.clean_only_strong.length +
                "  weak_single=" + a.weak_single_count +
                " → ratio faible");
  }
  console.log("");
});

// ── GD-025 : CLEAN AUTO-CANDIDATES ADMIN REVIEW ─────────────────────────────
(function() {
  var allAutoCands = [];
  clients.forEach(function(rawClient) {
    var reportDate = report.scan_date || null;
    // Collecter depuis clean_only où auto_notify_candidate=true
    var detail = rawClient.clean_only || [];
    detail.map(enrichEntry).forEach(function(e) {
      if (e.auto_notify_candidate) {
        var enriched = enrichAutoCandidate(e, reportDate);
        enriched.client = enriched.client || rawClient.client_name || "";
        allAutoCands.push(enriched);
      }
    });
    // Fallback : review_candidates_detail marqués auto
    if (!detail.length) {
      (rawClient.review_candidates_detail || []).map(enrichEntry).forEach(function(e) {
        if (e.auto_notify_candidate) {
          var enriched = enrichAutoCandidate(e, reportDate);
          enriched.client = enriched.client || rawClient.client_name || "";
          allAutoCands.push(enriched);
        }
      });
    }
  });

  if (!allAutoCands.length) return;

  var hasWarning = allAutoCands.some(function(e) { return !!e.warning; });

  console.log("\n====================================================");
  console.log("CLEAN AUTO-CANDIDATES ADMIN REVIEW — " + allAutoCands.length + " candidat(s)");
  if (hasWarning) console.log("  ⚠  Certains candidats contiennent des signaux ambigus ou risqués");
  console.log("====================================================");

  allAutoCands.forEach(function(e, idx) {
    var sigs = (e.matched_signals || [])
      .filter(function(s) { return s.indexOf("bloque(") === -1; });
    var tierLabel = "[" + (e.signal_risk_tier || "inconnu") + "]";
    console.log("\n  " + (idx + 1) + ". " + (e.client || "?") + " — bc_id=" + (e.bc_id || "?"));
    console.log("     score=" + (e.clean_score || 0) +
                "  origin=" + (e.signal_origin || "?") +
                "  risk=" + tierLabel);
    console.log("     signaux : " + sigs.join(", "));
    // Détail par signal
    if (e.signal_risk_detail) {
      var details = Object.keys(e.signal_risk_detail).map(function(s) {
        return s + " → " + e.signal_risk_detail[s];
      });
      console.log("     tiers   : " + details.join("  |  "));
    }
    if (e.warning) {
      console.log("     ⚠ WARNING : " + e.warning);
    }
    if (e.strength_reason) {
      console.log("     raison  : " + e.strength_reason);
    }
    if (e.clean_text_excerpt) {
      console.log("     extrait : " + e.clean_text_excerpt.slice(0, 100));
    }
  });
  console.log("");
})();

// ── GD-026 : LEGACY SENT VS CLEAN ADMIN COMPARISON — section console ────────
(function() {
  var reportDate   = report.scan_date || null;
  var compRows     = buildComparisonRows(clients, reportDate);
  if (!compRows.length) return;

  // Compteurs par bucket
  var bucketCount = {};
  compRows.forEach(function(r) {
    bucketCount[r.comparison_bucket] = (bucketCount[r.comparison_bucket] || 0) + 1;
  });

  // Compteur both_match (détail non disponible individuellement)
  var totBoth = clients.reduce(function(s, c) { return s + (c.both_match || 0); }, 0);

  var withWarning = compRows.filter(function(r) { return !!r.warning; });
  var autoNotLeg  = compRows.filter(function(r) { return r.comparison_bucket === "clean_auto_only"; });
  var revNotLeg   = compRows.filter(function(r) { return r.comparison_bucket === "clean_review_only"; });

  console.log("\n====================================================");
  console.log("LEGACY SENT VS CLEAN ADMIN COMPARISON — " + compRows.length + " ligne(s)");
  if (totBoth > 0) console.log("  (+ " + totBoth + " BC(s) matchés par les deux — détail non individuel)");
  console.log("====================================================");

  // Par bucket
  var BUCKET_ORDER = [
    "legacy_sent_only", "legacy_and_clean_review", "legacy_and_clean_auto",
    "clean_auto_only", "clean_review_only", "clean_weak_only"
  ];
  var BUCKET_LABEL = {
    "legacy_sent_only":        "legacy envoyé — clean non détecté          ",
    "legacy_and_clean_review": "legacy envoyé + clean aurait reviewé       ",
    "legacy_and_clean_auto":   "legacy envoyé + clean aurait auto-notifié  ",
    "clean_auto_only":         "clean auto-notif — legacy n'a PAS envoyé   ",
    "clean_review_only":       "clean review     — legacy n'a PAS envoyé   ",
    "clean_weak_only":         "clean faible     — legacy n'a PAS envoyé   ",
  };
  console.log("\nPar bucket :");
  BUCKET_ORDER.forEach(function(b) {
    if (bucketCount[b]) {
      console.log("  " + pad(bucketCount[b], 4) + "  [" + b + "]  " + (BUCKET_LABEL[b] || ""));
    }
  });

  // Candidats clean auto que legacy n'aurait pas envoyés
  if (autoNotLeg.length) {
    console.log("\nClean auto-candidates non couverts par legacy (" + autoNotLeg.length + ") :");
    autoNotLeg.slice(0, 8).forEach(function(r) {
      var tier = "[" + (r.signal_risk_tier || "inconnu") + "]";
      console.log("  bc_id=" + r.bc_id +
                  "  client=" + r.client +
                  "  score=" + r.clean_score +
                  "  risk=" + tier +
                  "  signaux=" + (r.matched_signals || []).slice(0, 4).join(", ") +
                  (r.warning ? "  ⚠ " + r.warning : ""));
    });
  }

  // Candidats legacy que clean aurait reviewés
  var legAndReview = compRows.filter(function(r) { return r.comparison_bucket === "legacy_and_clean_review"; });
  if (legAndReview.length) {
    console.log("\nLegacy envoyé + clean review (FP potentiels, " + legAndReview.length + ") :");
    legAndReview.slice(0, 5).forEach(function(r) {
      console.log("  bc_id=" + r.bc_id +
                  "  client=" + r.client +
                  "  clean_score=" + r.clean_score +
                  "  signaux=" + (r.matched_signals || []).join(", "));
    });
  }

  if (withWarning.length) {
    console.log("\n  ⚠  " + withWarning.length + " ligne(s) avec signaux ambigus/risqués");
  }
  console.log("");
})();

// ── Export --export-review ──────────────────────────────────────────────────
if (exportReview) {
  var allRevCands = [];
  clients.forEach(function(rawClient) {
    // Essayer review_candidates_detail (nouveau format) en priorité
    var detail = rawClient.review_candidates_detail || [];
    if (detail.length) {
      allRevCands = allRevCands.concat(detail);
    } else {
      // Fallback : filtrer clean_only sur review_candidate=true (anciens rapports)
      (rawClient.clean_only || []).map(enrichEntry).forEach(function(e) {
        if (e.review_candidate && !e.auto_notify_candidate) allRevCands.push(e);
      });
    }
  });

  if (!allRevCands.length) {
    console.log("\n[--export-review] Aucun candidat review dans ce rapport.");
  } else {
    var shadowDir  = path.dirname(path.resolve(reportPath));
    var ts         = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    var rcFname    = "review-candidates-" + ts + ".json";
    var rcFpath    = path.join(shadowDir, rcFname);
    var rcReport   = {
      exported_at:      new Date().toISOString(),
      source_report:    path.basename(reportPath),
      client_filter:    clientFilter || null,
      total_candidates: allRevCands.length,
      candidates:       allRevCands,
    };
    require("fs").writeFileSync(rcFpath, JSON.stringify(rcReport, null, 2), "utf8");
    console.log("\n[--export-review] " + allRevCands.length + " candidat(s) exporté(s) → " + rcFname);
    console.log("  Chemin : " + rcFpath);
  }
}

// ── Export --export-review-csv ─────────────────────────────────────────────
if (exportReviewCsv) {
  var allCsvCands = [];
  clients.forEach(function(rawClient) {
    var detail = rawClient.review_candidates_detail || [];
    if (detail.length) {
      allCsvCands = allCsvCands.concat(detail);
    } else {
      (rawClient.clean_only || []).map(enrichEntry).forEach(function(e) {
        if (e.review_candidate && !e.auto_notify_candidate) allCsvCands.push(e);
      });
    }
  });

  if (!allCsvCands.length) {
    console.log("\n[--export-review-csv] Aucun candidat review dans ce rapport.");
  } else {
    var shadowDir2 = path.dirname(path.resolve(reportPath));
    var ts2        = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    var csvFname   = "review-candidates-" + ts2 + ".csv";
    var csvFpath   = path.join(shadowDir2, csvFname);
    var csvContent = buildReviewCsv(allCsvCands);
    require("fs").writeFileSync(csvFpath, csvContent, "utf8");
    console.log("\n[--export-review-csv] " + allCsvCands.length + " candidat(s) → " + csvFname);
    console.log("  Colonnes : client;bc_id;score;signal_origin;matched_signals;strength_reason;weak_single_signal;clean_text_excerpt;decision");
    console.log("  Chemin   : " + csvFpath);
  }
}

// ── GD-025 : Export auto_candidates CSV + JSON ──────────────────────────────
if (exportAutoCands) {
  var allAutoExp = [];
  var autoReportDate = report.scan_date || new Date().toISOString();

  clients.forEach(function(rawClient) {
    (rawClient.clean_only || []).map(enrichEntry).forEach(function(e) {
      if (e.auto_notify_candidate) {
        var enriched = enrichAutoCandidate(e, autoReportDate);
        enriched.client = enriched.client || rawClient.client_name || "";
        allAutoExp.push(enriched);
      }
    });
    if (!(rawClient.clean_only || []).length) {
      (rawClient.review_candidates_detail || []).map(enrichEntry).forEach(function(e) {
        if (e.auto_notify_candidate) {
          var enriched = enrichAutoCandidate(e, autoReportDate);
          enriched.client = enriched.client || rawClient.client_name || "";
          allAutoExp.push(enriched);
        }
      });
    }
  });

  if (!allAutoExp.length) {
    console.log("\n[--export-auto-candidates] Aucun auto_candidate dans ce rapport.");
  } else {
    var autoDir = path.dirname(path.resolve(reportPath));
    var autoTs  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    // JSON export
    var jsonFname = "auto-candidates-admin-" + autoTs + ".json";
    var jsonFpath = path.join(autoDir, jsonFname);
    var jsonReport = {
      exported_at:      new Date().toISOString(),
      source_report:    path.basename(reportPath),
      purpose:          "ADMIN REVIEW — clean auto_candidates avec signal risk tier",
      warning:          "Shadow/review uniquement. Ne pas activer en production sans validation complète.",
      total_candidates: allAutoExp.length,
      has_risk_warning: allAutoExp.some(function(e) { return !!e.warning; }),
      candidates:       allAutoExp,
    };
    require("fs").writeFileSync(jsonFpath, JSON.stringify(jsonReport, null, 2), "utf8");
    console.log("\n[--export-auto-candidates] " + allAutoExp.length + " auto_candidate(s) → " + jsonFname);

    // CSV export
    var csvAutoFname = "auto-candidates-admin-" + autoTs + ".csv";
    var csvAutoFpath = path.join(autoDir, csvAutoFname);
    var BOM2 = "\uFEFF";
    var SEP2 = ";";
    var AUTO_COLS = ["report_date","client","bc_id","score","signal_origin",
                     "matched_signals","strength_reason","signal_risk_tier",
                     "signal_risk_detail","warning","auto_candidate_reason",
                     "clean_text_excerpt","decision"];
    var autoLines = [BOM2 + AUTO_COLS.join(SEP2)];
    allAutoExp.forEach(function(e) {
      var sigs = (e.matched_signals || [])
        .filter(function(s) { return s.indexOf("bloque(") === -1; }).join(", ");
      var riskDetail = e.signal_risk_detail
        ? Object.keys(e.signal_risk_detail).map(function(s) {
            return s + ":" + e.signal_risk_detail[s];
          }).join(" | ")
        : "";
      var row = [
        csvCell(e.report_date || ""),
        csvCell(e.client || ""),
        csvCell(e.bc_id  || ""),
        csvCell(e.clean_score != null ? e.clean_score : ""),
        csvCell(e.signal_origin || ""),
        csvCell(sigs),
        csvCell(e.strength_reason || ""),
        csvCell(e.signal_risk_tier || "inconnu"),
        csvCell(riskDetail),
        csvCell(e.warning || ""),
        csvCell(e.auto_candidate_reason || ""),
        csvCell((e.clean_text_excerpt || "").replace(/[\r\n]+/g, " ").trim()),
        csvCell(""),   // decision : vide pour saisie humaine (même convention que review-candidates)
      ];
      autoLines.push(row.join(SEP2));
    });
    require("fs").writeFileSync(csvAutoFpath, autoLines.join("\r\n"), "utf8");
    console.log("  JSON : " + jsonFpath);
    console.log("  CSV  : " + csvAutoFpath);
    console.log("  Colonnes : " + AUTO_COLS.join(";"));

    // Avertissement si signaux risqués
    var warned = allAutoExp.filter(function(e) { return !!e.warning; });
    if (warned.length) {
      console.log("  ⚠  " + warned.length + " candidat(s) avec signaux ambigus/risqués :");
      warned.forEach(function(e) {
        console.log("     bc_id=" + e.bc_id + "  " + e.warning);
      });
    }
  }
}

// ── GD-026 : Export legacy vs clean comparison CSV + JSON ───────────────────
if (exportComparison) {
  var compReportDate = report.scan_date || new Date().toISOString();
  var compRows2      = buildComparisonRows(clients, compReportDate);

  if (!compRows2.length) {
    console.log("\n[--export-comparison] Aucune ligne de comparaison (pas de legacy_only ni clean_only avec détail).");
  } else {
    var compDir = path.dirname(path.resolve(reportPath));
    var compTs  = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

    // ── JSON ──────────────────────────────────────────────────────────────────
    var compJsonFname = "legacy-vs-clean-admin-" + compTs + ".json";
    var compJsonFpath = path.join(compDir, compJsonFname);

    // Compteurs globaux
    var totBoth2 = clients.reduce(function(s, c) { return s + (c.both_match || 0); }, 0);
    var buckets2 = {};
    compRows2.forEach(function(r) { buckets2[r.comparison_bucket] = (buckets2[r.comparison_bucket] || 0) + 1; });

    var compJsonReport = {
      exported_at:     new Date().toISOString(),
      source_report:   path.basename(reportPath),
      purpose:         "ADMIN — comparaison legacy_sent vs clean auto/review candidates",
      warning:         "Shadow/review uniquement. Ne pas activer en production sans validation complète.",
      report_date:     compReportDate,
      summary: {
        total_rows:              compRows2.length,
        both_match_count:        totBoth2,
        both_match_note:         "BCs matchés par les deux — détail individuel non disponible dans ce format",
        legacy_sent_only:        buckets2["legacy_sent_only"] || 0,
        legacy_and_clean_review: buckets2["legacy_and_clean_review"] || 0,
        legacy_and_clean_auto:   buckets2["legacy_and_clean_auto"] || 0,
        clean_auto_only:         buckets2["clean_auto_only"] || 0,
        clean_review_only:       buckets2["clean_review_only"] || 0,
        clean_weak_only:         buckets2["clean_weak_only"] || 0,
        with_risk_warning:       compRows2.filter(function(r) { return !!r.warning; }).length,
      },
      rows: compRows2,
    };
    require("fs").writeFileSync(compJsonFpath, JSON.stringify(compJsonReport, null, 2), "utf8");

    // ── CSV ───────────────────────────────────────────────────────────────────
    var compCsvFname = "legacy-vs-clean-admin-" + compTs + ".csv";
    var compCsvFpath = path.join(compDir, compCsvFname);
    var COMP_BOM = "﻿";
    var COMP_SEP = ";";
    var COMP_COLS = [
      "report_date", "client", "bc_id", "title",
      "legacy_sent", "clean_auto_candidate", "clean_review_candidate",
      "clean_score", "matched_signals", "signal_risk_tier",
      "signal_risk_detail", "warning", "comparison_bucket",
      "clean_text_excerpt"
    ];
    var compLines = [COMP_BOM + COMP_COLS.join(COMP_SEP)];
    compRows2.forEach(function(r) {
      var sigs = (r.matched_signals || []).join(", ");
      var riskDetail = r.signal_risk_detail
        ? Object.keys(r.signal_risk_detail).map(function(s) {
            return s + ":" + r.signal_risk_detail[s];
          }).join(" | ")
        : "";
      var row = [
        csvCell(r.report_date || ""),
        csvCell(r.client || ""),
        csvCell(r.bc_id || ""),
        csvCell((r.title || "").replace(/[\r\n]+/g, " ").trim()),
        csvCell(r.legacy_sent ? "oui" : "non"),
        csvCell(r.clean_auto_candidate ? "oui" : "non"),
        csvCell(r.clean_review_candidate ? "oui" : "non"),
        csvCell(r.clean_score != null ? r.clean_score : ""),
        csvCell(sigs),
        csvCell(r.signal_risk_tier || "inconnu"),
        csvCell(riskDetail),
        csvCell(r.warning || ""),
        csvCell(r.comparison_bucket || ""),
        csvCell((r.clean_text_excerpt || "").replace(/[\r\n]+/g, " ").trim()),
      ];
      compLines.push(row.join(COMP_SEP));
    });
    require("fs").writeFileSync(compCsvFpath, compLines.join("\r\n"), "utf8");

    console.log("\n[--export-comparison] " + compRows2.length + " ligne(s) exportées");
    console.log("  JSON : " + compJsonFpath);
    console.log("  CSV  : " + compCsvFpath);
    console.log("  Colonnes : " + COMP_COLS.join(";"));

    // Avertissements
    var compWarned = compRows2.filter(function(r) { return !!r.warning; });
    if (compWarned.length) {
      console.log("  ⚠  " + compWarned.length + " ligne(s) avec signaux ambigus/risqués");
    }
    if (totBoth2 > 0) {
      console.log("  ℹ  " + totBoth2 + " BC(s) matchés par les deux non inclus (compteur uniquement)");
    }
  }
}

// Résumé global
if (clients.length > 1) {
  var totLegacy = clients.reduce(function(s, c) { return s + c.legacy; }, 0);
  var totClean  = clients.reduce(function(s, c) { return s + c.clean; }, 0);
  var totLO     = clients.reduce(function(s, c) { return s + c.legacy_only_count; }, 0);
  var totCO     = clients.reduce(function(s, c) { return s + c.clean_only_count; }, 0);
  console.log("====================================================");
  console.log("TOTAL  legacy=" + totLegacy + "  clean=" + totClean +
              "  legacy_only=" + totLO + "  clean_only=" + totCO);
  console.log("====================================================\n");
}

// ── GD-024g : IMPACT DES GUARDS — bilan global ──────────────────────────────
(function() {
  // Collecter tous les blocages depuis guard_impact_global (nouveau format)
  // ou fallback sur les guard_impact par client
  var allBlocked = [];
  if (report.summary && report.summary.guard_impact_global) {
    (report.summary.guard_impact_global || []).forEach(function(g) {
      if (g && g.blocked && g.signal) allBlocked.push(g);
    });
  } else {
    clients.forEach(function(rawClient) {
      (rawClient.guard_impact || []).forEach(function(g) {
        if (g && g.blocked && g.signal) allBlocked.push(g);
      });
      // Fallback legacy_only[].guard_blocked_signals
      (rawClient.legacy_only || []).forEach(function(e) {
        (e.guard_blocked_signals || []).forEach(function(g) {
          if (g && g.blocked && g.signal) allBlocked.push(g);
        });
      });
    });
  }

  if (!allBlocked.length) return;

  console.log("\n====================================================");
  console.log("IMPACT DES GUARDS — " + allBlocked.length + " blocage(s) total");
  console.log("====================================================");

  // Par catégorie
  var catCount    = {};
  var reasonCount = {};
  var sigCount    = {};
  allBlocked.forEach(function(g) {
    var r   = g.reason || "motif inconnu";
    var s   = g.signal || "?";
    var cat = classifyGuardCategory(r, s);
    catCount[cat]  = (catCount[cat]  || 0) + 1;
    reasonCount[r] = (reasonCount[r] || 0) + 1;
    sigCount[s]    = (sigCount[s]    || 0) + 1;
  });

  console.log("\nPar catégorie :");
  Object.keys(catCount)
    .sort(function(a, b) { return catCount[b] - catCount[a]; })
    .forEach(function(cat) {
      var pct = Math.round(catCount[cat] / allBlocked.length * 100);
      console.log("  " + pad(catCount[cat], 4) + "x  [" + cat + "]  (" + pct + "%)");
    });

  console.log("\nPar motif détaillé :");
  Object.keys(reasonCount)
    .sort(function(a, b) { return reasonCount[b] - reasonCount[a]; })
    .forEach(function(r) {
      console.log("  " + pad(reasonCount[r], 4) + "x  " + r);
    });

  console.log("\nTop signaux bloqués :");
  Object.keys(sigCount)
    .sort(function(a, b) { return sigCount[b] - sigCount[a]; })
    .slice(0, 10)
    .forEach(function(s) {
      console.log("  " + pad(sigCount[s], 4) + "x  " + s);
    });

  console.log("");
})();

function pad(n, w) {
  var s = String(n);
  while (s.length < w) s = " " + s;
  return s;
}
