'use strict';

/**
 * scripts/analyze-local-multi-profile-report.js -- GD-048
 *
 * Rapport synthetique multi-profils depuis un shadow-bc-input-replay-*.json.
 * Shadow-only -- ne touche pas au scoring, matching, prod, Supabase, Fly.
 * Pas de notification, pas d'ecriture bcs_vus, pas de scan reel.
 * Rule-based deterministe.
 *
 * Usage :
 *   node scripts/analyze-local-multi-profile-report.js
 *     -> dernier shadow-bc-input-replay-*.json dans data/shadow/
 *
 *   node scripts/analyze-local-multi-profile-report.js --shadow data\shadow\shadow-bc-input-replay-2026-06-19T20-47-40.json
 *     -> fichier shadow explicite
 *
 *   node scripts/analyze-local-multi-profile-report.js --top 3
 *     -> top 3 signaux (defaut : 5)
 *
 * Sorties :
 *   Console : resume par client/profil
 *   data/shadow/multi-profile-summary-<ts>.json
 *   data/shadow/multi-profile-summary-<ts>.csv
 *
 * ASCII strict -- pas de caracteres accentues dans le source.
 */

var fs   = require('fs');
var path = require('path');

// -- CLI ----------------------------------------------------------------------

function opt(name) {
  var idx = process.argv.indexOf(name);
  return (idx >= 0 && process.argv[idx + 1]) ? process.argv[idx + 1] : null;
}

var shadowArg = opt('--shadow') || opt('--input') || process.argv[2] || null;
var topN      = Math.max(1, parseInt(opt('--top') || '5', 10));

// -- Chemins ------------------------------------------------------------------

var SHADOW_DIR = path.resolve(__dirname, '..', 'data', 'shadow');

// -- Helpers ------------------------------------------------------------------

/**
 * Retourne le chemin du dernier shadow-bc-input-replay-*.json par date de modification.
 */
function findLatestShadowJson(dir) {
  if (!fs.existsSync(dir)) return null;
  var files = fs.readdirSync(dir)
    .filter(function(f) { return /^shadow-bc-input-replay-.*\.json$/.test(f); })
    .map(function(f) {
      return { name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs };
    })
    .sort(function(a, b) { return b.mtime - a.mtime; });
  return files.length ? path.join(dir, files[0].name) : null;
}

/**
 * Compte les occurrences de chaque signal dans une liste d'entrees.
 * @param {Array} entries  Elements clean_only du rapport shadow.
 * @returns {Object}  { signal: count }
 */
function countSignals(entries) {
  var counts = {};
  entries.forEach(function(e) {
    (e.matched_signals || []).forEach(function(s) {
      var k = String(s || '').trim();
      if (k) { counts[k] = (counts[k] || 0) + 1; }
    });
  });
  return counts;
}

/**
 * Retourne les N signaux les plus frequents sous forme [{signal, count}].
 * @param {Object} counts  Resultat de countSignals.
 * @param {number} n       Nombre max a retourner.
 */
function topSignals(counts, n) {
  return Object.keys(counts)
    .sort(function(a, b) { return counts[b] - counts[a]; })
    .slice(0, n)
    .map(function(s) { return { signal: s, count: counts[s] }; });
}

/**
 * Detecte si un signal semble trop large (peu discriminant).
 * Criteres :
 *   - review >= 3 * (auto + 1)                  -- beaucoup de review vs auto
 *   - weak_single_signal_count >= 50% total_clean -- majorite weak_single
 *   Si les deux criteres sont remplis : warning.
 * @returns {string[]}  Liste de messages warning (vide si OK).
 */
function detectBroadSignalWarning(c) {
  var autoCount    = typeof c.clean_auto_notify_candidates === 'number'
                      ? c.clean_auto_notify_candidates : 0;
  var reviewCount  = typeof c.clean_review_candidates === 'number'
                      ? c.clean_review_candidates : 0;
  var weakSingle   = typeof c.weak_single_signal_count === 'number'
                      ? c.weak_single_signal_count : 0;
  var totalClean   = typeof c.clean === 'number' ? c.clean : (autoCount + reviewCount);
  if (totalClean === 0) return [];
  var warnings = [];
  var ratioHigh   = reviewCount >= 3 * (autoCount + 1);
  var weakHigh    = weakSingle >= Math.ceil(totalClean * 0.5);
  if (ratioHigh && weakHigh) {
    warnings.push(
      'signal_trop_large: ' + reviewCount + ' review / ' + autoCount + ' auto' +
      ' / ' + weakSingle + ' weak_single (' +
      Math.round(weakSingle / totalClean * 100) + '% du total)'
    );
  }
  return warnings;
}

/**
 * Construit le resume synthetique d'un client depuis son entree shadow.
 * @param {Object} c     Entree client du rapport shadow JSON.
 * @param {number} topN  Nombre de signaux top a inclure.
 */
function computeClientSummary(c, n) {
  var allEntries    = Array.isArray(c.clean_only) ? c.clean_only : [];
  var autoEntries   = allEntries.filter(function(e) { return !e.review_candidate; });
  var reviewEntries = allEntries.filter(function(e) { return !!e.review_candidate; });

  var sigAll    = countSignals(allEntries);
  var sigAuto   = countSignals(autoEntries);
  var sigReview = countSignals(reviewEntries);

  var autoCount   = typeof c.clean_auto_notify_candidates === 'number'
                     ? c.clean_auto_notify_candidates : autoEntries.length;
  var reviewCount = typeof c.clean_review_candidates === 'number'
                     ? c.clean_review_candidates : reviewEntries.length;
  var totalClean  = typeof c.clean === 'number' ? c.clean : allEntries.length;

  // Exemples auto-candidats : tries par score desc, top 3
  var bestAuto = autoEntries
    .slice()
    .sort(function(a, b) { return (b.clean_score || 0) - (a.clean_score || 0); })
    .slice(0, 3)
    .map(function(e) {
      return {
        bc_id          : e.bc_id,
        score          : e.clean_score,
        matched_signals: e.matched_signals || [],
        strength       : e.strength,
        objet          : ((e.objet || '').trim() || (e.clean_text_excerpt || '')).slice(0, 80)
      };
    });

  // Exemples review-candidats : top 3 (ordre original -- les plus saillants en premier)
  var reviewExamples = reviewEntries.slice(0, 3).map(function(e) {
    return {
      bc_id             : e.bc_id,
      score             : e.clean_score,
      matched_signals   : e.matched_signals || [],
      strength_reason   : e.strength_reason,
      weak_single_signal: !!e.weak_single_signal,
      objet             : ((e.objet || '').trim() || (e.clean_text_excerpt || '')).slice(0, 80)
    };
  });

  return {
    client_id         : c.client_id,
    client_name       : c.client_name || c.client_id,
    profile_label     : c.profile_label || '',
    total_checked     : c.total_checked || 0,
    total_clean       : totalClean,
    auto_candidates   : autoCount,
    review_candidates : reviewCount,
    clean_strong      : c.clean_strong_count || 0,
    clean_weak        : c.clean_weak_count   || 0,
    weak_single_signal: c.weak_single_signal_count || 0,
    top_signals_all   : topSignals(sigAll,    n),
    top_signals_auto  : topSignals(sigAuto,   n),
    top_signals_review: topSignals(sigReview, n),
    best_auto_examples: bestAuto,
    review_examples   : reviewExamples,
    warnings          : detectBroadSignalWarning(c),
    recommendation    : c.recommendation || ''
  };
}

// -- CSV helpers ---------------------------------------------------------------

function csvEsc(v) {
  var s = String(v == null ? '' : v);
  if (s.indexOf(';') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function signalsToStr(arr) {
  return (arr || []).map(function(x) {
    return typeof x === 'object' ? x.signal + '(' + x.count + ')' : String(x);
  }).join(', ');
}

/**
 * Genere le CSV BOM-UTF8 depuis un tableau de summaries client.
 */
function buildSummaryCsv(summaries) {
  var COLS = [
    'client_id', 'client_name', 'profile_label',
    'total_checked', 'total_clean',
    'auto_candidates', 'review_candidates',
    'clean_strong', 'clean_weak', 'weak_single_signal',
    'top_signals_all', 'top_signals_auto', 'top_signals_review',
    'warnings', 'recommendation'
  ];
  var rows = ['\uFEFF' + COLS.join(';')];
  summaries.forEach(function(s) {
    var row = [
      csvEsc(s.client_id),
      csvEsc(s.client_name),
      csvEsc(s.profile_label),
      csvEsc(s.total_checked),
      csvEsc(s.total_clean),
      csvEsc(s.auto_candidates),
      csvEsc(s.review_candidates),
      csvEsc(s.clean_strong),
      csvEsc(s.clean_weak),
      csvEsc(s.weak_single_signal),
      csvEsc(signalsToStr(s.top_signals_all)),
      csvEsc(signalsToStr(s.top_signals_auto)),
      csvEsc(signalsToStr(s.top_signals_review)),
      csvEsc((s.warnings || []).join(' | ')),
      csvEsc(s.recommendation)
    ];
    rows.push(row.join(';'));
  });
  return rows.join('\r\n');
}

// -- Console output ------------------------------------------------------------

function printSummary(s, shadowPath) {
  console.log('  Client : ' + s.client_name + ' [' + s.profile_label + ']');
  console.log('  ID     : ' + s.client_id);
  console.log('  Shadow : ' + shadowPath);
  console.log('');
  console.log('  Totaux');
  console.log('    BCs analyses       : ' + s.total_checked);
  console.log('    Clean total        : ' + s.total_clean);
  console.log('    Auto-candidats     : ' + s.auto_candidates);
  console.log('    Review-candidats   : ' + s.review_candidates);
  console.log('    Clean strong       : ' + s.clean_strong);
  console.log('    Clean weak         : ' + s.clean_weak);
  console.log('    Weak single signal : ' + s.weak_single_signal);
  console.log('');
  if (s.top_signals_all.length > 0) {
    console.log('  Top signaux (tous) : ' +
      s.top_signals_all.map(function(x) { return x.signal + '(' + x.count + ')'; }).join(', '));
  }
  if (s.top_signals_auto.length > 0) {
    console.log('  Top signaux auto   : ' +
      s.top_signals_auto.map(function(x) { return x.signal + '(' + x.count + ')'; }).join(', '));
  }
  if (s.top_signals_review.length > 0) {
    console.log('  Top signaux review : ' +
      s.top_signals_review.map(function(x) { return x.signal + '(' + x.count + ')'; }).join(', '));
  }
  console.log('');
  if (s.best_auto_examples.length > 0) {
    console.log('  Meilleurs auto-candidats :');
    s.best_auto_examples.forEach(function(e, i) {
      console.log('    [' + (i + 1) + '] bc_id=' + e.bc_id +
        ' score=' + e.score +
        ' signals=' + (e.matched_signals || []).join(',') +
        ' strength=' + e.strength);
      if (e.objet) { console.log('        ' + e.objet); }
    });
    console.log('');
  }
  if (s.review_examples.length > 0) {
    console.log('  Review-candidats a inspecter :');
    s.review_examples.forEach(function(e, i) {
      console.log('    [' + (i + 1) + '] bc_id=' + e.bc_id +
        ' score=' + e.score +
        ' signals=' + (e.matched_signals || []).join(',') +
        (e.weak_single_signal ? ' [weak_single]' : ''));
      if (e.strength_reason) { console.log('        ' + e.strength_reason); }
      if (e.objet) { console.log('        ' + e.objet); }
    });
    console.log('');
  }
  if (s.warnings.length > 0) {
    console.log('  [!] WARNINGS :');
    s.warnings.forEach(function(w) { console.log('    - ' + w); });
    console.log('');
  }
  if (s.recommendation) {
    console.log('  Recommandation : ' + s.recommendation);
  }
  console.log('  ' + '-'.repeat(60));
}

// -- Main ---------------------------------------------------------------------

(function main() {
  // 1. Chemin du shadow JSON
  var shadowPath;
  if (shadowArg && /\.json$/i.test(shadowArg)) {
    shadowPath = path.isAbsolute(shadowArg)
      ? shadowArg
      : path.resolve(process.cwd(), shadowArg);
  } else {
    shadowPath = findLatestShadowJson(SHADOW_DIR);
  }
  if (!shadowPath || !fs.existsSync(shadowPath)) {
    process.stderr.write('[ERREUR] Aucun shadow JSON trouve.' +
      (shadowPath ? ' Chemin : ' + shadowPath : '') + '\n');
    process.exit(1);
  }

  // 2. Chargement
  var report;
  try {
    report = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
  } catch (e) {
    process.stderr.write('[ERREUR] Lecture shadow JSON : ' + e.message + '\n');
    process.exit(1);
  }
  if (!report || !Array.isArray(report.clients) || report.clients.length === 0) {
    process.stderr.write('[ERREUR] Aucun client dans le rapport shadow.\n');
    process.exit(1);
  }

  // 3. Calcul des summaries
  var summaries = report.clients.map(function(c) {
    return computeClientSummary(c, topN);
  });

  // 4. Affichage console
  console.log('');
  console.log('=== RAPPORT MULTI-PROFILS SHADOW-ONLY (GD-048) ===');
  console.log('  Source     : ' + path.basename(shadowPath));
  console.log('  Scan date  : ' + (report.scan_date || 'inconnue'));
  console.log('  Mode       : ' + (report.clients_mode || '?'));
  console.log('  Clients    : ' + summaries.length);
  console.log('');

  summaries.forEach(function(s) { printSummary(s, path.basename(shadowPath)); });

  // 5. Totaux globaux
  var totalAuto   = summaries.reduce(function(acc, s) { return acc + s.auto_candidates;   }, 0);
  var totalReview = summaries.reduce(function(acc, s) { return acc + s.review_candidates; }, 0);
  var totalClean  = summaries.reduce(function(acc, s) { return acc + s.total_clean;       }, 0);
  var nbWarnings  = summaries.reduce(function(acc, s) { return acc + s.warnings.length;   }, 0);
  console.log('=== TOTAUX ===');
  console.log('  Clean total   : ' + totalClean);
  console.log('  Auto total    : ' + totalAuto);
  console.log('  Review total  : ' + totalReview);
  if (nbWarnings > 0) {
    console.log('  [!] ' + nbWarnings + ' warning(s) signal trop large');
  }
  console.log('');

  // 6. Sorties fichiers
  var ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  var jsonOut = path.join(SHADOW_DIR, 'multi-profile-summary-' + ts + '.json');
  var csvOut  = path.join(SHADOW_DIR, 'multi-profile-summary-' + ts + '.csv');

  var jsonPayload = {
    generated_at  : new Date().toISOString(),
    source_shadow : path.basename(shadowPath),
    scan_date     : report.scan_date || null,
    clients_mode  : report.clients_mode || null,
    top_n         : topN,
    nb_clients    : summaries.length,
    total_auto    : totalAuto,
    total_review  : totalReview,
    total_clean   : totalClean,
    nb_warnings   : nbWarnings,
    clients       : summaries
  };

  try {
    fs.mkdirSync(SHADOW_DIR, { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(jsonPayload, null, 2), 'utf8');
    var csvContent = buildSummaryCsv(summaries);
    fs.writeFileSync(csvOut, csvContent, 'utf8');
  } catch (e) {
    process.stderr.write('[ERREUR] Ecriture fichiers : ' + e.message + '\n');
    process.exit(1);
  }

  console.log('[JSON] ' + jsonOut);
  console.log('[CSV]  ' + csvOut);
  console.log('');
})();
