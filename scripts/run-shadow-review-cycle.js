'use strict';
/**
 * run-shadow-review-cycle.js
 * Script d'orchestration read-only du cycle Shadow → Review.
 *
 * Remplace l'enchaînement manuel :
 *   $env:RADAR_BC_EXPORT_REVIEW_CANDIDATES="1"
 *   node scripts/replay-shadow-from-input-snapshot.js --latest
 *   node scripts/analyze-shadow-report.js "data/shadow/<rapport>.json" --export-review-csv
 *   node scripts/analyze-review-decisions.js
 *
 * Usage :
 *   node scripts/run-shadow-review-cycle.js
 *   node scripts/run-shadow-review-cycle.js --client "TEST PROD - IT Bureautique"
 *
 * Aucun scraping, aucune notification, aucun write Supabase.
 */

var cp   = require('child_process');
var path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────

var ROOT        = path.join(__dirname, '..');
var NODE        = process.execPath;           // même binaire node que le process parent
var SHADOW_DIR  = path.join(ROOT, 'data', 'shadow');

// Récupérer un éventuel filtre --client "..."
var clientFilter = null;
(function() {
  for (var i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === '--client' && process.argv[i + 1]) {
      clientFilter = process.argv[i + 1];
    }
  }
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function hr(n) { return '='.repeat(n || 52); }

function die(msg, code) {
  console.error('\n[ERREUR] ' + msg);
  process.exit(code || 1);
}

/**
 * Lance un sous-processus Node et retourne { ok, stdout, stderr, status }.
 * stdout/stderr sont affichés en temps réel ET capturés pour analyse.
 * @param {string[]} args   - arguments après "node"
 * @param {Object}   env    - variables d'environnement supplémentaires
 */
function run(args, env) {
  var fullEnv = Object.assign({}, process.env, env || {});
  var label   = 'node ' + args.join(' ');
  console.log('\n' + hr(60));
  console.log('>> ' + label);
  console.log(hr(60));

  // spawnSync avec stdio: 'pipe' pour capturer stdout
  var result = cp.spawnSync(NODE, args, {
    cwd:      ROOT,
    env:      fullEnv,
    encoding: 'utf8',
    stdio:    'pipe',
    maxBuffer: 20 * 1024 * 1024,
  });

  // Afficher stdout et stderr proprement
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  return {
    ok:     result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ── Étape 1 : Replay V2 ───────────────────────────────────────────────────────

console.log('\n' + hr(60));
console.log('  CYCLE SHADOW REVIEW — ' + new Date().toLocaleString('fr-FR'));
if (clientFilter) console.log('  Filtre client : ' + clientFilter);
console.log(hr(60));

var replayArgs = [
  path.join('scripts', 'replay-shadow-from-input-snapshot.js'),
  '--latest',
];
if (clientFilter) {
  replayArgs.push('--client');
  replayArgs.push(clientFilter);
}

var replayResult = run(replayArgs, {
  RADAR_BC_EXPORT_REVIEW_CANDIDATES: '1',
});

if (!replayResult.ok) {
  die(
    'Le replay a échoué (exit ' + replayResult.status + ').\n' +
    'Vérifier la connexion Supabase et le snapshot latest.',
    1
  );
}

// ── Étape 2 : Extraire le nom du rapport depuis stdout ────────────────────────

// Pattern attendu : "[Replay-V2] Rapport ecrit : shadow-bc-input-replay-<ts>.json"
var reportMatch = replayResult.stdout.match(
  /\[Replay-V2\] Rapport ecrit : (shadow-bc-input-replay-[^\s]+\.json)/
);

if (!reportMatch) {
  die(
    'Impossible de détecter le rapport shadow dans la sortie du replay.\n' +
    'La ligne attendue est : [Replay-V2] Rapport ecrit : shadow-bc-input-replay-*.json\n' +
    'Vérifier que le replay a bien produit des résultats.',
    1
  );
}

var reportFname = reportMatch[1];
var reportPath  = path.join(SHADOW_DIR, reportFname);

console.log('\n>> Rapport détecté : ' + reportFname);

// ── Étape 3 : Analyser le rapport + exporter le CSV review ────────────────────

var analyzeArgs = [
  path.join('scripts', 'analyze-shadow-report.js'),
  reportPath,
  '--export-review-csv',
];

var analyzeResult = run(analyzeArgs, {});

if (!analyzeResult.ok) {
  die(
    'analyze-shadow-report.js a échoué (exit ' + analyzeResult.status + ').',
    1
  );
}

// Extraire le nom du CSV depuis stdout
// Pattern : "[--export-review-csv] N candidat(s) → review-candidates-<ts>.csv"
var csvMatch = analyzeResult.stdout.match(
  /\[--export-review-csv\].*?→\s*(review-candidates-[^\s]+\.csv)/
);
var csvFname = csvMatch ? csvMatch[1] : '(non exporté — 0 candidat)';

// ── Étape 4 : Analyse consolidée des décisions humaines ──────────────────────

var decisionsResult = run(
  [path.join('scripts', 'analyze-review-decisions.js')],
  {}
);

if (!decisionsResult.ok) {
  die(
    'analyze-review-decisions.js a échoué (exit ' + decisionsResult.status + ').',
    1
  );
}

// ── Étape 5 : Analyse des candidats à promotion shadow ───────────────────────

var promotionResult = run(
  [path.join('scripts', 'analyze-promotion-candidates.js')],
  {}
);

if (!promotionResult.ok) {
  die(
    'analyze-promotion-candidates.js a échoué (exit ' + promotionResult.status + ').',
    1
  );
}

// ── Résumé final ──────────────────────────────────────────────────────────────

console.log('\n' + hr(60));
console.log('  CYCLE SHADOW REVIEW TERMINÉ');
console.log(hr(60));
console.log('  Rapport shadow    : data/shadow/' + reportFname);
console.log('  CSV review        : data/shadow/' + csvFname);
console.log('  Review summary    : OK');
console.log('  Promotion analyse : OK');
if (clientFilter) {
  console.log('  Filtre client     : ' + clientFilter);
}
console.log(hr(60));
console.log('');
