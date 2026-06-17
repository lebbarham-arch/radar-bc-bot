#!/usr/bin/env node
/**
 * shadow-compare-match-text.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Compare deux stratégies de construction du texte de matching sur un snapshot
 * BC figé, SANS toucher le scan réel, Supabase ou les notifications.
 *
 *   old_match_text  — simulation scan réel :
 *     objet + body_excerpt complet (400 chars)
 *     → peut contenir le boilerplate "Nature de prestation" du portail
 *
 *   clean_match_text — logique replay :
 *     objet + section Articles uniquement (texte après "Articles" dans body_excerpt)
 *     → boilerplate navigation/prestation exclu
 *
 * Usage :
 *   node scripts/shadow-compare-match-text.js \
 *     --snapshot data/scan-snapshots/bc-scan-2026-06-06T16-51-07.jsonl \
 *     --profile  fixtures/profiles/beta-informatique.json
 *
 * Sorties :
 *   - console synthétique avec détail des divergences
 *   - data/replay/shadow-compare-YYYY-MM-DDTHH-MM-SS.json
 *
 * Garanties :
 *   ✗ Aucune écriture Supabase
 *   ✗ Aucune notification
 *   ✗ Aucune modification de radar-bc-bot.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

"use strict";

var fs   = require("fs");
var path = require("path");

var ROOT = path.resolve(__dirname, "..");

// ─── CLI ─────────────────────────────────────────────────────────────────────

var args = process.argv.slice(2);
function argVal(flag) {
  var idx = args.indexOf(flag);
  return (idx !== -1 && idx + 1 < args.length) ? args[idx + 1] : null;
}

var snapshotArg = argVal("--snapshot");
var profileArg  = argVal("--profile");

if (!snapshotArg || !profileArg) {
  console.error("Usage: node scripts/shadow-compare-match-text.js --snapshot <path> --profile <path>");
  process.exit(1);
}

var snapshotPath = path.isAbsolute(snapshotArg) ? snapshotArg : path.join(ROOT, snapshotArg);
var profilePath  = path.isAbsolute(profileArg)  ? profileArg  : path.join(ROOT, profileArg);

// ─── Helpers texte (identiques au replay) ────────────────────────────────────

function norm(str) {
  if (!str) return "";
  var s = String(str).toLowerCase();
  try { s = s.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (e) {}
  return s.replace(/[''`]/g, " ").replace(/\s+/g, " ").trim();
}

function hasKw(text, kw) {
  if (!text || !kw) return false;
  var t = norm(text), k = norm(kw);
  if (!k) return false;
  var idx = t.indexOf(k);
  if (idx === -1) return false;
  var before = idx > 0 ? t[idx - 1] : " ";
  var after  = idx + k.length < t.length ? t[idx + k.length] : " ";
  return !/[a-z0-9àâéèêëîïôùûüç]/.test(before) && !/[a-z0-9àâéèêëîïôùûüç]/.test(after);
}

function levenshtein(a, b) {
  var m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  var dp = [];
  for (var i = 0; i <= m; i++) { dp[i] = [i]; }
  for (var j = 0; j <= n; j++) { dp[0][j] = j; }
  for (var i = 1; i <= m; i++) {
    for (var j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function hasKwFuzzy(text, kw) {
  if (!text || !kw) return false;
  var t = norm(text), k = norm(kw);
  if (!k || k.length < 6) return hasKw(text, kw);
  if (hasKw(text, kw)) return true;
  var words = t.split(" ");
  var kwords = k.split(" ");
  if (kwords.length === 1) {
    return words.some(function(w) {
      if (Math.abs(w.length - k.length) > 2) return false;
      return levenshtein(w, k) <= 1;
    });
  }
  for (var i = 0; i <= words.length - kwords.length; i++) {
    var window = words.slice(i, i + kwords.length).join(" ");
    if (levenshtein(window, k) <= 1) return true;
  }
  return false;
}

function hasAnyKw(text, terms) {
  if (!text || !terms || !terms.length) return false;
  return terms.some(function(t) { return hasKwFuzzy(text, t); });
}

// ─── Construction des textes de matching ─────────────────────────────────────

/**
 * old_match_text — simulation du scan réel sur les données disponibles.
 *
 * Le scan réel utilise :
 *   objet + bodyText (8000 chars) + _keyword
 * Le snapshot ne conserve que body_excerpt (400 chars de bodyText) et pas _keyword.
 * On utilise donc :
 *   objet + body_excerpt complet
 * Cela inclut la section "Nature de prestation" du portail, source probable
 * de faux positifs.
 */
function buildOldMatchText(item) {
  var objet  = (item.objet || "").trim();
  var body   = (item.body_excerpt || "").trim();
  // _keyword absent du snapshot — simulé à vide (avantage donné au scan réel)
  var kw     = (item._keyword || "").trim();
  return (objet + " " + body + (kw ? " " + kw : "")).trim();
}

/**
 * clean_match_text — logique replay (buildMatchText).
 *
 * Utilise uniquement :
 *   objet + texte APRÈS le marqueur "Articles" dans body_excerpt
 * La section "Nature de prestation" et la navigation portail sont exclues.
 */
function buildCleanMatchText(item) {
  var objet = (item.objet || "").trim();
  var body  = (item.body_excerpt || "");
  var articlesText = "";
  var artIdx = body.indexOf("Articles");
  if (artIdx !== -1) {
    var afterArt = body.slice(artIdx)
      .replace(/^Articles\s+Tout afficher\s+Tout r[eé]duire\s*/i, "")
      .trim();
    articlesText = afterArt;
  }
  return (objet + " " + articlesText).trim();
}

/**
 * Détecte la raison probable d'un écart old_only.
 * Cherche la phrase boilerplate "Nature de prestation" dans le body_excerpt.
 */
var BOILERPLATE_PHRASES = [
  "logiciels et de materiel informatique",
  "materiel technique, de logiciels",
  "nature de prestation",
  "categories principales",
  "categorie principale",
];

function detectBoilerplateHit(item, criteria) {
  var body = norm(item.body_excerpt || "");
  // Où la phrase boilerplate commence-t-elle ?
  var artIdx = (item.body_excerpt || "").indexOf("Articles");
  var preArticles = artIdx !== -1
    ? norm((item.body_excerpt || "").slice(0, artIdx))
    : body;

  var hits = [];
  for (var i = 0; i < criteria.length; i++) {
    var c = criteria[i];
    if (hasAnyKw(preArticles, [c]) && !hasAnyKw(norm(item.objet || ""), [c])) {
      // Le critère matche dans la section pré-Articles, pas dans l'objet
      // → probablement boilerplate portail
      var boilerPhraseFound = BOILERPLATE_PHRASES.some(function(p) {
        return preArticles.indexOf(p) !== -1;
      });
      hits.push({
        critere:  c,
        in_preArticles: true,
        boilerplate_suspected: boilerPhraseFound,
      });
    }
  }
  return hits;
}

// ─── Moteur de scoring (identique au replay) ─────────────────────────────────

function scoreText(matchText, profile) {
  var criteria    = profile.selected_criteria   || [];
  var deselected  = profile.deselected_criteria || [];
  var enr         = profile.optional_enrichments || {};
  var synTerms    = [];
  var brands      = enr.normes_marques_modeles  || [];
  var validators  = enr.contextes_validants     || [];
  var blockers    = enr.contextes_bloquants     || [];
  var ambiguous   = enr.termes_ambigus          || [];

  var rawSyn = enr.synonymes_metier || [];
  rawSyn.forEach(function(entry) {
    entry.split(/[\/,]/).map(function(s) { return s.trim(); })
      .filter(function(s) { return s.length > 2; })
      .forEach(function(s) { synTerms.push(s); });
  });

  var activeCriteria = criteria.filter(function(c) {
    return deselected.indexOf(c) === -1;
  });

  var fullText = norm(matchText);

  // Blocages
  var blockerHits = blockers.filter(function(b) { return hasAnyKw(fullText, [b]); });
  if (blockerHits.length > 0) {
    return { decision: "bloque", score: 0, critere_declencheur: null,
             raisons: [], blocages: blockerHits, signaux_secondaires: [] };
  }

  var criteriaMatches = activeCriteria.filter(function(c) { return hasAnyKw(fullText, [c]); });
  var synHits         = synTerms.filter(function(s)   { return hasAnyKw(fullText, [s]); });
  var validatorHits   = validators.filter(function(v) { return hasAnyKw(fullText, [v]); });
  var brandHits       = brands.filter(function(b)     { return hasKw(fullText, b); });
  var ambigHits       = ambiguous.filter(function(a)  { return hasAnyKw(fullText, [a]); });

  var score = criteriaMatches.length  * 10
            + synHits.length          * 5
            + validatorHits.length    * 5
            + Math.min(brandHits.length * 2, 10);

  var critere_declencheur = criteriaMatches[0] || synHits[0] || null;
  var raisons = [];
  if (criteriaMatches.length)  raisons.push("Critères : " + criteriaMatches.join(", "));
  if (synHits.length)          raisons.push("Synonymes : " + synHits.join(", "));
  if (validatorHits.length)    raisons.push("Contextes validants : " + validatorHits.join(", "));
  if (brandHits.length)        raisons.push("Marques : " + brandHits.join(", "));
  if (ambigHits.length)        raisons.push("Termes ambigus : " + ambigHits.join(", "));

  var decision = score >= 15 ? "match_fort"
               : score >= 5  ? "match_faible"
               : "no_match";

  return { decision, score, critere_declencheur, raisons, blocages: [],
           signaux_secondaires: ambigHits };
}

// ─── Chargement données ───────────────────────────────────────────────────────

function loadSnapshot(snapshotPath) {
  var raw = fs.readFileSync(snapshotPath, "utf8");
  var lines = raw.split("\n").filter(function(l) { return l.trim(); });
  var seen = {};
  lines.forEach(function(l) {
    var row;
    try { row = JSON.parse(l); } catch (e) { return; }
    var bid = row.bc_id;
    if (!bid) return;
    if (!seen[bid] || (row.body_excerpt || "").length > (seen[bid].body_excerpt || "").length) {
      seen[bid] = row;
    }
  });
  return Object.values(seen);
}

function loadProfile(profilePath) {
  var raw = fs.readFileSync(profilePath, "utf8");
  return JSON.parse(raw);
}

// ─── Formatage console ────────────────────────────────────────────────────────

var HR  = "═".repeat(64);
var HR2 = "─".repeat(64);
function sec(title) { console.log("\n" + HR + "\n  " + title + "\n" + HR); }

function printItem(r, idx, label) {
  console.log("\n  [" + idx + "] BC " + r.bc_id + "  (" + label + "  score=" + r.compare.old_score + "→" + r.compare.clean_score + ")");
  console.log("      Objet    : " + (r.objet || "").slice(0, 80));
  if (r.acheteur) console.log("      Acheteur : " + r.acheteur.slice(0, 60));
  if (r.date_limite) console.log("      Deadline : " + r.date_limite);
  console.log("      Critère  : " + (r.compare.old_critere || r.compare.clean_critere || "—"));
  console.log("      old_text : " + (r.compare.old_match_text || "").slice(0, 100) + "…");
  console.log("      cln_text : " + (r.compare.clean_match_text || "").slice(0, 100) + "…");
  if (r.compare.boilerplate_hits && r.compare.boilerplate_hits.length) {
    r.compare.boilerplate_hits.forEach(function(h) {
      console.log("      ⚠  boilerplate [" + h.critere + "] en pré-Articles" +
        (h.boilerplate_suspected ? " → 'Nature de prestation'" : ""));
    });
  }
  if (r.url) console.log("      URL      : " + r.url);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  // 1. Chargement
  if (!fs.existsSync(snapshotPath)) {
    console.error("Snapshot introuvable : " + snapshotPath); process.exit(1);
  }
  if (!fs.existsSync(profilePath)) {
    console.error("Profil introuvable : " + profilePath); process.exit(1);
  }

  var items   = loadSnapshot(snapshotPath);
  var profile = loadProfile(profilePath);
  var runDate = new Date().toISOString();

  sec("SHADOW COMPARE — old vs clean match text  [DRY-RUN]");
  console.log("\n  Snapshot    : " + path.basename(snapshotPath));
  console.log("  Profil      : " + profileArg);
  console.log("  Date        : " + runDate);
  console.log("  Items BC    : " + items.length + " uniques (dédupliqués par bc_id)");

  var allCriteria = (profile.selected_criteria || [])
    .concat(profile.optional_enrichments && profile.optional_enrichments.synonymes_metier
      ? (profile.optional_enrichments.synonymes_metier || []).join("/").split(/[\/,]/).map(function(s) { return s.trim(); }).filter(function(s){ return s.length>2; })
      : []);

  // 2. Scoring des deux textes pour chaque item
  var results = items.map(function(item) {
    var oldText   = buildOldMatchText(item);
    var cleanText = buildCleanMatchText(item);

    var oldScore   = scoreText(oldText,   profile);
    var cleanScore = scoreText(cleanText, profile);

    var oldMatch   = oldScore.decision   !== "no_match" && oldScore.decision   !== "bloque";
    var cleanMatch = cleanScore.decision !== "no_match" && cleanScore.decision !== "bloque";

    var boilerplateHits = [];
    if (oldMatch && !cleanMatch) {
      boilerplateHits = detectBoilerplateHit(item, allCriteria);
    }

    // Acheteur : extrait depuis objet si absent
    var acheteur = "";
    var m = (item.body_excerpt || "").match(/Acheteur public\s+([^\n\r]+?)(?:\s+Date mise en ligne|\s+Date limite)/);
    if (m) acheteur = m[1].trim().slice(0, 80);

    return {
      bc_id:       item.bc_id,
      objet:       item.objet || "",
      acheteur:    acheteur,
      date_limite: item.date_limite || "",
      url:         item.url || "",
      compare: {
        old_match:        oldMatch,
        clean_match:      cleanMatch,
        old_score:        oldScore.score,
        clean_score:      cleanScore.score,
        old_decision:     oldScore.decision,
        clean_decision:   cleanScore.decision,
        old_critere:      oldScore.critere_declencheur,
        clean_critere:    cleanScore.critere_declencheur,
        old_raisons:      oldScore.raisons,
        clean_raisons:    cleanScore.raisons,
        old_match_text:   oldText.slice(0, 200),
        clean_match_text: cleanText.slice(0, 200),
        boilerplate_hits: boilerplateHits,
      },
    };
  });

  // 3. Catégorisation
  var bothMatch   = results.filter(function(r) { return  r.compare.old_match &&  r.compare.clean_match; });
  var oldOnly     = results.filter(function(r) { return  r.compare.old_match && !r.compare.clean_match; });
  var cleanOnly   = results.filter(function(r) { return !r.compare.old_match &&  r.compare.clean_match; });
  var neither     = results.filter(function(r) { return !r.compare.old_match && !r.compare.clean_match; });

  // 4. Affichage console

  console.log("\n  " + HR2);
  console.log("  RÉSUMÉ");
  console.log("  " + HR2);
  console.log("  total_items  : " + items.length);
  console.log("  both_match   : " + bothMatch.length + "   (vrais positifs communs)");
  console.log("  old_only     : " + oldOnly.length   + "   ← faux positifs probables (boilerplate)");
  console.log("  clean_only   : " + cleanOnly.length + "   ← opportunités manquées par l'ancien");
  console.log("  neither      : " + neither.length);
  console.log("  " + HR2);

  // Taux de divergence
  var totalMatches = bothMatch.length + oldOnly.length + cleanOnly.length;
  if (totalMatches > 0) {
    var fpRate = Math.round(oldOnly.length / (bothMatch.length + oldOnly.length) * 100);
    console.log("  Taux faux positifs old_only / (old_match) : " + fpRate + "%");
  }

  // Top critères responsables des old_only
  if (oldOnly.length > 0) {
    var critereCount = {};
    oldOnly.forEach(function(r) {
      var c = r.compare.old_critere || "inconnu";
      critereCount[c] = (critereCount[c] || 0) + 1;
    });
    var sorted = Object.keys(critereCount).sort(function(a, b) {
      return critereCount[b] - critereCount[a];
    });
    console.log("\n  Top critères responsables des old_only :");
    sorted.slice(0, 8).forEach(function(c) {
      console.log("    " + critereCount[c] + "×  " + c);
    });

    // Boilerplate confirmé
    var confirmedBoiler = oldOnly.filter(function(r) {
      return r.compare.boilerplate_hits.some(function(h) { return h.boilerplate_suspected; });
    });
    console.log("\n  old_only avec boilerplate 'Nature de prestation' confirmé : " + confirmedBoiler.length + " / " + oldOnly.length);
  }

  // 5. Détail des divergences
  if (oldOnly.length > 0) {
    sec("OLD_ONLY — faux positifs probables (" + oldOnly.length + ")");
    console.log("  Ces BCs matchent avec l'ancien texte mais pas avec le texte propre.");
    console.log("  Cause probable : phrase boilerplate 'Nature de prestation' du portail.\n");
    oldOnly.forEach(function(r, i) { printItem(r, i + 1, "old_only"); });
  }

  if (cleanOnly.length > 0) {
    sec("CLEAN_ONLY — opportunités manquées par l'ancien (" + cleanOnly.length + ")");
    console.log("  Ces BCs matchent avec le texte propre mais pas avec l'ancien.");
    console.log("  Cause probable : objet générique mais articles pertinents.\n");
    cleanOnly.forEach(function(r, i) { printItem(r, i + 1, "clean_only"); });
  }

  // 6. Rapport JSON
  var compareDir = path.join(ROOT, "data", "replay");
  if (!fs.existsSync(compareDir)) fs.mkdirSync(compareDir, { recursive: true });

  var ts         = runDate.replace(/[:.]/g, "-").slice(0, 19);
  var reportFile = path.join(compareDir, "shadow-compare-" + ts + ".json");

  var report = {
    snapshot_used:  path.basename(snapshotPath),
    profile_used:   profileArg,
    generated_at:   runDate,
    summary: {
      total_items:  items.length,
      both_match:   bothMatch.length,
      old_only:     oldOnly.length,
      clean_only:   cleanOnly.length,
      neither:      neither.length,
      fp_rate_pct:  totalMatches > 0
        ? Math.round(oldOnly.length / (bothMatch.length + oldOnly.length) * 100)
        : 0,
    },
    old_only: oldOnly.map(function(r) {
      return {
        bc_id:            r.bc_id,
        titre:            r.objet.slice(0, 100),
        acheteur:         r.acheteur,
        date_limite:      r.date_limite,
        url:              r.url,
        old_score:        r.compare.old_score,
        old_critere:      r.compare.old_critere,
        old_raisons:      r.compare.old_raisons,
        old_match_text:   r.compare.old_match_text,
        clean_match_text: r.compare.clean_match_text,
        boilerplate_hits: r.compare.boilerplate_hits,
      };
    }),
    clean_only: cleanOnly.map(function(r) {
      return {
        bc_id:            r.bc_id,
        titre:            r.objet.slice(0, 100),
        acheteur:         r.acheteur,
        date_limite:      r.date_limite,
        url:              r.url,
        clean_score:      r.compare.clean_score,
        clean_critere:    r.compare.clean_critere,
        clean_raisons:    r.compare.clean_raisons,
        old_match_text:   r.compare.old_match_text,
        clean_match_text: r.compare.clean_match_text,
      };
    }),
    both_match_sample: bothMatch.slice(0, 10).map(function(r) {
      return {
        bc_id:        r.bc_id,
        titre:        r.objet.slice(0, 100),
        old_score:    r.compare.old_score,
        clean_score:  r.compare.clean_score,
        critere:      r.compare.clean_critere || r.compare.old_critere,
      };
    }),
  };

  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");

  console.log("\n" + HR);
  console.log("  Rapport JSON : " + path.relative(ROOT, reportFile));
  console.log("  TOTAL matches old : " + (bothMatch.length + oldOnly.length)
    + " | clean : " + (bothMatch.length + cleanOnly.length));
  console.log(HR + "\n");
}

main();
