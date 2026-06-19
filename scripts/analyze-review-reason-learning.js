'use strict';

/**
 * scripts/analyze-review-reason-learning.js -- GD-037 CLI
 *
 * Script CLI local pour generer le rapport d'apprentissage des raisons de review.
 * Consultatif uniquement -- ne modifie rien au moteur ni aux candidats.
 *
 * Usage :
 *   node scripts/analyze-review-reason-learning.js
 *     -> cherche automatiquement le dernier review-candidates-*.json dans data/shadow/
 *
 *   node scripts/analyze-review-reason-learning.js data\shadow\review-candidates-2026-06-18.json
 *     -> traite un fichier precis
 *
 *   node scripts/analyze-review-reason-learning.js data\shadow
 *     -> traite tous les review-candidates-*.json du dossier
 *
 *   node scripts/analyze-review-reason-learning.js data\human-review
 *     -> traite human-review-decisions-for-learning-*.json ET review-candidates-*.json du dossier
 *
 * Rapport ecrit dans : data/review-learning/review-reason-learning-report-<ts>.json
 *
 * Patterns acceptes en mode dossier :
 *   - review-candidates-*.json
 *   - human-review-decisions-for-learning-*.json
 *   - review-decisions-*.json
 */

var fs   = require('fs');
var path = require('path');

var learningReport = require('./review-reason-learning-report');

// Patterns de fichiers acceptes en mode dossier (ordre de priorite pour le tri)
var DIR_PATTERNS = [
  /^review-candidates-.*\.json$/,
  /^human-review-decisions-for-learning-.*\.json$/,
  /^review-decisions-.*\.json$/,
];

function matchesAnyPattern(filename) {
  return DIR_PATTERNS.some(function(re) { return re.test(filename); });
}

// -- Resolution des fichiers source -------------------------------------------
function findSourceFiles(argPath, projectRoot) {
  var shadowDir = path.join(projectRoot, 'data', 'shadow');

  if (!argPath) {
    // Mode auto : dernier review-candidates-*.json dans data/shadow/
    if (!fs.existsSync(shadowDir)) {
      console.error('[ERREUR] Dossier data/shadow/ introuvable : ' + shadowDir);
      process.exit(1);
    }
    var autoCands = fs.readdirSync(shadowDir)
      .filter(function(f) { return /^review-candidates-.*\.json$/.test(f); })
      .sort()
      .reverse();
    if (autoCands.length === 0) {
      console.error('[ERREUR] Aucun fichier review-candidates-*.json dans ' + shadowDir);
      process.exit(1);
    }
    return [path.join(shadowDir, autoCands[0])];
  }

  var resolved = path.resolve(argPath);

  // Fichier unique
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return [resolved];
  }

  // Dossier : accepter tous les patterns compatibles
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    var found = fs.readdirSync(resolved)
      .filter(matchesAnyPattern)
      .sort()
      .map(function(f) { return path.join(resolved, f); });
    if (found.length === 0) {
      console.error(
        '[ERREUR] Aucun fichier compatible dans ' + resolved + '\n' +
        '  Patterns attendus : review-candidates-*.json,' +
        ' human-review-decisions-for-learning-*.json, review-decisions-*.json'
      );
      process.exit(1);
    }
    return found;
  }

  console.error('[ERREUR] Chemin introuvable : ' + resolved);
  process.exit(1);
}

// -- Cle de deduplication pour une entree ------------------------------------
function dedupKey(entry) {
  var bcId   = String(entry.bc_id   || '').trim();
  var client = String(entry.client  || entry.client_name || entry.client_id || '').trim();
  return bcId + '|' + client;
}

// -- Deduplication des entrees par bc_id + client ----------------------------
// Priorite : garde l'entree qui a une decision non-vide.
// Si plusieurs avec decision, garde la premiere rencontree.
function deduplicateEntries(entries) {
  var seen   = Object.create(null); // key -> index dans deduped
  var deduped = [];
  var dupCount = 0;

  entries.forEach(function(e) {
    var k   = dedupKey(e);
    var idx = seen[k];
    if (idx === undefined) {
      seen[k] = deduped.length;
      deduped.push(e);
    } else {
      // Si l'entree existante n'a pas de decision et la nouvelle en a une, remplacer
      var existing  = deduped[idx];
      var hasDec    = function(x) { return x && String(x.decision || '').trim() !== ''; };
      if (!hasDec(existing) && hasDec(e)) {
        deduped[idx] = e;
      }
      dupCount++;
    }
  });

  return { entries: deduped, rawCount: entries.length, dupCount: dupCount };
}

// -- Chargement des entrees depuis les fichiers -------------------------------
function loadEntries(files) {
  var allEntries = [];
  var filesRead  = 0;

  files.forEach(function(fpath) {
    try {
      var raw  = fs.readFileSync(fpath, 'utf8');
      var data = JSON.parse(raw);
      var items = data.candidates || data.entries || data.records || [];
      if (!Array.isArray(items)) {
        console.warn('[WARN] Format inattendu dans ' + path.basename(fpath) + ' -- ignore.');
        return;
      }
      items.forEach(function(e) { allEntries.push(e); });
      console.log('  [lu] ' + path.basename(fpath) + ' -> ' + items.length + ' entree(s)');
      filesRead++;
    } catch (err) {
      console.warn('[WARN] Impossible de lire ' + path.basename(fpath) + ' : ' + err.message);
    }
  });

  console.log('  [total fichiers lus] ' + filesRead + ' / ' + files.length);
  return allEntries;
}

// -- Affichage console --------------------------------------------------------
function printReport(report) {
  console.log('\n================================================================');
  console.log('  RAPPORT D\'APPRENTISSAGE -- RAISONS REVIEW');
  console.log('  Modele : ' + report.model);
  console.log('  Genere : ' + report.generated_at);
  console.log('================================================================');
  console.log('  Entrees       : ' + report.totals.entries);
  console.log('  Avec decision : ' + report.totals.with_decision);
  console.log('  En attente    : ' + report.totals.pending_review);
  console.log('  Groupes       : ' + report.totals.groups);
  console.log('  Suggestions   : ' + report.totals.suggested_hints);
  console.log('');

  if (report.clients.length === 0) {
    console.log('  (aucune donnee a analyser)');
    return;
  }

  report.clients.forEach(function(client) {
    console.log('\n  CLIENT : ' + client.client_key);
    console.log('  ' + '-'.repeat(60));

    client.groups.forEach(function(g) {
      var s = g.summary;
      console.log('\n    Signal : ' + g.signal_key);
      console.log('    Contexte : ' + g.context_key + '  |  Raison : ' + g.reason_key);
      console.log('    Decisions : ' + s.total_decisions + ' total'
        + '  keep=' + s.keep_count
        + '  reject=' + s.reject_count
        + '  ignore=' + s.ignore_count
        + '  pending=' + s.pending_review_count);
      console.log('    Dominance : ' + s.dominant_decision + ' ' + s.dominance_rate + '%'
        + '  |  Confidence : ' + s.confidence);

      var sg = g.suggestion;
      if (sg.should_suggest_hint) {
        console.log('    [SUGGESTION] type=' + sg.suggested_hint_type);
        console.log('    [SUGGESTION] ' + sg.suggested_action);
        console.log('    [SUGGESTION] safety=' + sg.safety);
        console.log('    [SUGGESTION] rationale: ' + sg.rationale);
      } else {
        console.log('    [suggestion] aucune (' + sg.rationale + ')');
      }
    });
  });

  if (report.suggested_hints.length > 0) {
    console.log('\n\n  -- SYNTHESE DES SUGGESTIONS (' + report.suggested_hints.length + ') ---------------------');
    report.suggested_hints.forEach(function(h, i) {
      console.log('\n  [' + (i + 1) + '] client=' + h.client_key + '  signal=' + h.signal_key);
      console.log('      type=' + h.suggested_hint_type);
      console.log('      action: ' + h.suggested_action);
      console.log('      safety: ' + h.safety + '  (consultatif -- ne rien appliquer automatiquement)');
    });
  }

  console.log('\n================================================================\n');
}

// -- Main ---------------------------------------------------------------------
var projectRoot = path.join(__dirname, '..');
var argPath     = process.argv[2] || '';

console.log('[analyze-review-reason-learning] Demarrage...');

var sourceFiles = findSourceFiles(argPath, projectRoot);
console.log('[sources] ' + sourceFiles.length + ' fichier(s) :');
sourceFiles.forEach(function(f) { console.log('  ' + f); });

var rawEntries = loadEntries(sourceFiles);

// Deduplication par bc_id + client
var dedup = deduplicateEntries(rawEntries);
console.log('[dedup] entrees brutes=' + dedup.rawCount
  + '  utilisees=' + dedup.entries.length
  + '  doublons elimines=' + dedup.dupCount);

var report = learningReport.buildReviewReasonLearningReport(dedup.entries, {
  generatedAt:  new Date().toISOString(),
  sourceFiles:  sourceFiles.map(function(f) { return path.basename(f); }),
});

printReport(report);

// -- Ecriture du rapport JSON -------------------------------------------------
var learningDir = path.join(projectRoot, 'data', 'review-learning');
if (!fs.existsSync(learningDir)) {
  fs.mkdirSync(learningDir, { recursive: true });
  console.log('[mkdir] ' + learningDir);
}

var ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
var outName = 'review-reason-learning-report-' + ts + '.json';
var outPath = path.join(learningDir, outName);

fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('[rapport] Ecrit : ' + outName);
console.log('[rapport] Chemin : ' + outPath);
