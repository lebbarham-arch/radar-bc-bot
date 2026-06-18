'use strict';

/**
 * scripts/analyze-review-reason-learning.js — GD-037 CLI
 *
 * Script CLI local pour générer le rapport d'apprentissage des raisons de review.
 * Consultatif uniquement — ne modifie rien au moteur ni aux candidats.
 *
 * Usage :
 *   node scripts/analyze-review-reason-learning.js
 *     → cherche automatiquement le dernier review-candidates-*.json dans data/shadow/
 *
 *   node scripts/analyze-review-reason-learning.js data\shadow\review-candidates-2026-06-18.json
 *     → traite un fichier précis
 *
 *   node scripts/analyze-review-reason-learning.js data\shadow
 *     → traite tous les review-candidates-*.json du dossier
 *
 * Rapport écrit dans : data/review-learning/review-reason-learning-report-<ts>.json
 */

var fs   = require('fs');
var path = require('path');

var learningReport = require('./review-reason-learning-report');

// ── Résolution des fichiers source ────────────────────────────────────────────
function findSourceFiles(argPath, projectRoot) {
  var shadowDir = path.join(projectRoot, 'data', 'shadow');

  if (!argPath) {
    // Mode auto : dernier review-candidates-*.json dans data/shadow/
    if (!fs.existsSync(shadowDir)) {
      console.error('[ERREUR] Dossier data/shadow/ introuvable : ' + shadowDir);
      process.exit(1);
    }
    var candidates = fs.readdirSync(shadowDir)
      .filter(function(f) { return /^review-candidates-.*\.json$/.test(f); })
      .sort()
      .reverse();
    if (candidates.length === 0) {
      console.error('[ERREUR] Aucun fichier review-candidates-*.json dans ' + shadowDir);
      process.exit(1);
    }
    return [path.join(shadowDir, candidates[0])];
  }

  var resolved = path.resolve(argPath);

  // Fichier unique
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return [resolved];
  }

  // Dossier : chercher tous les review-candidates-*.json
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    var found = fs.readdirSync(resolved)
      .filter(function(f) { return /^review-candidates-.*\.json$/.test(f); })
      .sort()
      .map(function(f) { return path.join(resolved, f); });
    if (found.length === 0) {
      console.error('[ERREUR] Aucun fichier review-candidates-*.json dans ' + resolved);
      process.exit(1);
    }
    return found;
  }

  console.error('[ERREUR] Chemin introuvable : ' + resolved);
  process.exit(1);
}

// ── Chargement des entrées depuis les fichiers ────────────────────────────────
function loadEntries(files) {
  var allEntries = [];
  files.forEach(function(fpath) {
    try {
      var raw  = fs.readFileSync(fpath, 'utf8');
      var data = JSON.parse(raw);
      var candidates = data.candidates || data.entries || [];
      if (!Array.isArray(candidates)) {
        console.warn('[WARN] Format inattendu dans ' + path.basename(fpath) + ' — ignoré.');
        return;
      }
      candidates.forEach(function(e) { allEntries.push(e); });
      console.log('  [lu] ' + path.basename(fpath) + ' → ' + candidates.length + ' entrée(s)');
    } catch (err) {
      console.warn('[WARN] Impossible de lire ' + path.basename(fpath) + ' : ' + err.message);
    }
  });
  return allEntries;
}

// ── Affichage console ─────────────────────────────────────────────────────────
function printReport(report) {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  RAPPORT D\'APPRENTISSAGE — RAISONS REVIEW');
  console.log('  Modèle : ' + report.model);
  console.log('  Généré : ' + report.generated_at);
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  Entrées       : ' + report.totals.entries);
  console.log('  Avec décision : ' + report.totals.with_decision);
  console.log('  En attente    : ' + report.totals.pending_review);
  console.log('  Groupes       : ' + report.totals.groups);
  console.log('  Suggestions   : ' + report.totals.suggested_hints);
  console.log('');

  if (report.clients.length === 0) {
    console.log('  (aucune donnée à analyser)');
    return;
  }

  report.clients.forEach(function(client) {
    console.log('\n  CLIENT : ' + client.client_key);
    console.log('  ' + '─'.repeat(60));

    client.groups.forEach(function(g) {
      var s = g.summary;
      console.log('\n    Signal : ' + g.signal_key);
      console.log('    Contexte : ' + g.context_key + '  |  Raison : ' + g.reason_key);
      console.log('    Décisions : ' + s.total_decisions + ' total'
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
    console.log('\n\n  ── SYNTHÈSE DES SUGGESTIONS (' + report.suggested_hints.length + ') ─────────────────────');
    report.suggested_hints.forEach(function(h, i) {
      console.log('\n  [' + (i + 1) + '] client=' + h.client_key + '  signal=' + h.signal_key);
      console.log('      type=' + h.suggested_hint_type);
      console.log('      action: ' + h.suggested_action);
      console.log('      safety: ' + h.safety + '  (consultatif — ne rien appliquer automatiquement)');
    });
  }

  console.log('\n════════════════════════════════════════════════════════════════\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
var projectRoot = path.join(__dirname, '..');
var argPath     = process.argv[2] || '';

console.log('[analyze-review-reason-learning] Démarrage…');

var sourceFiles = findSourceFiles(argPath, projectRoot);
console.log('[sources] ' + sourceFiles.length + ' fichier(s) :');
sourceFiles.forEach(function(f) { console.log('  ' + f); });

var entries = loadEntries(sourceFiles);
console.log('[chargé] ' + entries.length + ' entrée(s) au total.');

var report = learningReport.buildReviewReasonLearningReport(entries, {
  generatedAt:  new Date().toISOString(),
  sourceFiles:  sourceFiles.map(function(f) { return path.basename(f); }),
});

printReport(report);

// ── Écriture du rapport JSON ──────────────────────────────────────────────────
var learningDir = path.join(projectRoot, 'data', 'review-learning');
if (!fs.existsSync(learningDir)) {
  fs.mkdirSync(learningDir, { recursive: true });
  console.log('[mkdir] ' + learningDir);
}

var ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
var outName = 'review-reason-learning-report-' + ts + '.json';
var outPath = path.join(learningDir, outName);

fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
console.log('[rapport] Écrit : ' + outName);
console.log('[rapport] Chemin : ' + outPath);
