#!/usr/bin/env node
// scripts/run-client-feedback-learning-cycle.js
// GD-137 — Orchestrateur local du cycle complet feedback client → learning → hints.
//
// Orchestre les 5 scripts existants en séquence :
//   1. export-client-feedback-events.js    → JSONL Supabase
//   2. convert-feedback-events-to-review-csv.js → CSV review candidates (--dedupe)
//   3. import-review-decisions.js          → JSON review-decisions
//   4. analyze-client-learning.js          → analyse learning
//   5. build-client-learning-hints.js      → hints JSON
//
// Usage :
//   node scripts/run-client-feedback-learning-cycle.js \
//     --client-id <uuid> --since <iso>
//   node scripts/run-client-feedback-learning-cycle.js \
//     --client-id <uuid> --since <iso> --dry-run
//   node scripts/run-client-feedback-learning-cycle.js \
//     --client-id <uuid> --since <iso> --radar-type mp
//
// Options :
//   --client-id <uuid>   (OBLIGATOIRE) UUID client Supabase
//   --since <iso>        (OBLIGATOIRE) Date ISO minimale (ex: 2026-07-05T18:00:00Z)
//   --radar-type <type>  "bc" | "mp"  (défaut : "bc")
//   --dry-run            Mode lecture seule : aucun fichier écrit, aucun import
//
// SECURITE :
//   - Ne modifie pas radar-bc-bot.js ni le moteur
//   - Ne modifie pas les profils clients
//   - Ne modifie pas la production legacy
//   - Ne touche pas Fly, secrets, notifications
//   - En --dry-run : propage le flag à chaque script appelé
//   - Générique multi-clients, aucune logique métier codée en dur

'use strict';

var path  = require('path');
var spawn = require('child_process').spawnSync;

var ROOT   = path.join(__dirname, '..');
var NODE   = process.execPath;

// ---------------------------------------------------------------------------
// parseArgs — pur, testable directement
// ---------------------------------------------------------------------------

/**
 * Analyse process.argv (ou un tableau fourni) et retourne les options.
 *
 * @param {string[]} argv   Tableau d'arguments (sans "node" ni nom de script)
 * @returns {{ clientId: string|null, since: string|null, radarType: string,
 *             dryRun: boolean, error: string|null }}
 */
function parseArgs(argv) {
  var clientId  = null;
  var since     = null;
  var radarType = 'bc';
  var dryRun    = false;

  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--client-id' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      clientId = argv[++i];
    } else if (a === '--since' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      since = argv[++i];
    } else if (a === '--radar-type' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      radarType = argv[++i];
    } else if (a === '--dry-run') {
      dryRun = true;
    }
  }

  if (!clientId) {
    return { clientId: null, since: since, radarType: radarType, dryRun: dryRun,
      error: 'Argument manquant : --client-id <uuid> est obligatoire' };
  }
  if (!since) {
    return { clientId: clientId, since: null, radarType: radarType, dryRun: dryRun,
      error: 'Argument manquant : --since <iso> est obligatoire' };
  }

  return { clientId: clientId, since: since, radarType: radarType, dryRun: dryRun, error: null };
}

// ---------------------------------------------------------------------------
// buildSteps — construit les 5 étapes sans les exécuter (pur, testable)
// ---------------------------------------------------------------------------

/**
 * Retourne la liste des étapes à exécuter dans l'ordre.
 * Chaque étape : { name, script, args[] }
 * Les chemins des fichiers intermédiaires (jsonl, csv) sont déterminés au
 * moment de l'exécution depuis la sortie stdout de l'étape précédente.
 *
 * @param {{ clientId:string, since:string, radarType:string, dryRun:boolean }} opts
 * @returns {Array<{name:string, script:string, args:string[], placeholder?:string}>}
 */
function buildSteps(opts) {
  var dr = opts.dryRun ? ['--dry-run'] : [];

  return [
    // Étape 1 : export JSONL depuis Supabase
    {
      name:        'export-feedback',
      script:      path.join(ROOT, 'scripts', 'export-client-feedback-events.js'),
      args:        ['--client-id', opts.clientId, '--since', opts.since,
                    '--radar-type', opts.radarType].concat(dr),
      placeholder: 'JSONL_PATH',  // le chemin sera extrait du stdout
    },
    // Étape 2 : conversion JSONL → CSV (--input injecté dynamiquement)
    {
      name:        'convert-to-csv',
      script:      path.join(ROOT, 'scripts', 'convert-feedback-events-to-review-csv.js'),
      args:        ['--dedupe'].concat(dr),
      // --input sera ajouté après extraction du chemin JSONL (étape 1 stdout)
      placeholder: 'CSV_PATH',
    },
    // Étape 3 : import CSV → review-decisions
    {
      name:        'import-decisions',
      script:      path.join(ROOT, 'scripts', 'import-review-decisions.js'),
      args:        ['--review-source', 'client'].concat(dr),
      // chemin CSV ajouté en premier argument dynamiquement
      placeholder: 'DECISIONS_PATH',
    },
    // Étape 4 : analyse learning (lecture seule, pas de --dry-run nécessaire)
    {
      name:        'analyze-learning',
      script:      path.join(ROOT, 'scripts', 'analyze-client-learning.js'),
      args:        [],
    },
    // Étape 5 : build hints
    {
      name:        'build-hints',
      script:      path.join(ROOT, 'scripts', 'build-client-learning-hints.js'),
      args:        dr,
    },
  ];
}

// ---------------------------------------------------------------------------
// Extracteurs stdout — purs, testables
// ---------------------------------------------------------------------------

/**
 * Extrait le chemin JSONL depuis la sortie de export-client-feedback-events.js.
 * Cherche la ligne : "[OK] JSONL ecrit : <path>"
 * @param {string} stdout
 * @returns {string|null}
 */
function extractJsonlPath(stdout) {
  var m = stdout.match(/\[OK\] JSONL ecrit : (.+)/);
  return m ? m[1].trim() : null;
}

/**
 * Extrait le chemin CSV depuis la sortie de convert-feedback-events-to-review-csv.js.
 * Cherche la ligne : "[OK] CSV ecrit : <path>"
 * @param {string} stdout
 * @returns {string|null}
 */
function extractCsvPath(stdout) {
  var m = stdout.match(/\[OK\] CSV ecrit : (.+)/);
  return m ? m[1].trim() : null;
}

/**
 * Extrait le chemin review-decisions depuis la sortie de import-review-decisions.js.
 * Cherche la ligne : "JSON ecrit : <path>" ou "JSON ecrit (fallback) : <path>"
 * @param {string} stdout
 * @returns {string|null}
 */
function extractDecisionsPath(stdout) {
  var m = stdout.match(/JSON ecrit(?:\s*\(fallback\))?\s*:\s*(.+)/);
  return m ? m[1].trim() : null;
}

/**
 * Extrait les statistiques de la sortie des scripts.
 * Cherche les patterns :
 *   "Total recupere Supabase     : N"
 *   "Total exporte               : N"
 *   "keep     : N"  / "reject   : N"  / "ignore   : N"
 *
 * @param {string} stdout
 * @returns {{ fetched:number|null, exported:number|null,
 *             keep:number|null, reject:number|null, ignore:number|null }}
 */
function extractStats(stdout) {
  function _n(re) {
    var m = stdout.match(re);
    return m ? parseInt(m[1], 10) : null;
  }
  return {
    fetched:  _n(/Total recupere Supabase\s*:\s*(\d+)/),
    exported: _n(/Total exporte\s*:\s*(\d+)/),
    keep:     _n(/keep\s*:\s*(\d+)/),
    reject:   _n(/reject\s*:\s*(\d+)/),
    ignore:   _n(/ignore\s*:\s*(\d+)/),
  };
}

// ---------------------------------------------------------------------------
// Exécution d'une étape (wraps spawnSync)
// ---------------------------------------------------------------------------

/**
 * Lance un script Node et retourne { ok, stdout, stderr, code }.
 * @param {string}   scriptPath
 * @param {string[]} args
 * @returns {{ ok:boolean, stdout:string, stderr:string, code:number }}
 */
function runStep(scriptPath, args) {
  var result = spawn(NODE, [scriptPath].concat(args), {
    cwd:      ROOT,
    encoding: 'utf8',
    env:      process.env,
  });
  var code   = result.status !== null ? result.status : (result.error ? 1 : 0);
  return {
    ok:     code === 0 && !result.error,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code:   code,
  };
}

// ---------------------------------------------------------------------------
// Cycle complet
// ---------------------------------------------------------------------------

/**
 * Exécute les 5 étapes du cycle en séquence.
 * @param {{ clientId:string, since:string, radarType:string, dryRun:boolean }} opts
 * @returns {{ ok:boolean, summary:object }}
 */
function runCycle(opts) {
  var steps   = buildSteps(opts);
  var summary = {
    client_id:       opts.clientId,
    since:           opts.since,
    radar_type:      opts.radarType,
    dry_run:         opts.dryRun,
    fetched:         null,
    exported:        null,
    keep:            null,
    reject:          null,
    ignore:          null,
    jsonl_path:      null,
    csv_path:        null,
    decisions_path:  null,
    hints_written:   false,
    steps_ok:        [],
    steps_failed:    [],
  };

  // ── Étape 1 : export feedback ───────────────────────────────────────────
  console.log('\n[GD-137] ─── Étape 1/5 : export-client-feedback-events ───');
  var r1 = runStep(steps[0].script, steps[0].args);
  process.stdout.write(r1.stdout);
  if (r1.stderr) process.stderr.write(r1.stderr);
  if (!r1.ok) {
    console.error('[GD-137] ERREUR étape 1 (code ' + r1.code + ')');
    summary.steps_failed.push('export-feedback');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('export-feedback');
  var stats1 = extractStats(r1.stdout);
  summary.fetched  = stats1.fetched;
  summary.exported = stats1.exported;

  // En dry-run, pas de fichier → arrêt propre après étape 1
  if (opts.dryRun) {
    console.log('\n[GD-137] --dry-run actif : étapes 2..5 ignorées (aucun fichier écrit).');
    return { ok: true, summary: summary };
  }

  var jsonlPath = extractJsonlPath(r1.stdout);
  if (!jsonlPath) {
    console.error('[GD-137] ERREUR : impossible de détecter le chemin JSONL dans la sortie étape 1.');
    summary.steps_failed.push('extract-jsonl-path');
    return { ok: false, summary: summary };
  }
  summary.jsonl_path = jsonlPath;

  // ── Étape 2 : conversion JSONL → CSV ───────────────────────────────────
  console.log('\n[GD-137] ─── Étape 2/5 : convert-feedback-events-to-review-csv ───');
  var step2args = ['--input', jsonlPath, '--dedupe'];
  var r2 = runStep(steps[1].script, step2args);
  process.stdout.write(r2.stdout);
  if (r2.stderr) process.stderr.write(r2.stderr);
  if (!r2.ok) {
    console.error('[GD-137] ERREUR étape 2 (code ' + r2.code + ')');
    summary.steps_failed.push('convert-to-csv');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('convert-to-csv');
  var csvPath = extractCsvPath(r2.stdout);
  if (!csvPath) {
    console.error('[GD-137] ERREUR : impossible de détecter le chemin CSV dans la sortie étape 2.');
    summary.steps_failed.push('extract-csv-path');
    return { ok: false, summary: summary };
  }
  summary.csv_path = csvPath;

  // ── Étape 3 : import CSV → review-decisions ────────────────────────────
  console.log('\n[GD-137] ─── Étape 3/5 : import-review-decisions ───');
  var step3args = [csvPath, '--review-source', 'client'];
  var r3 = runStep(steps[2].script, step3args);
  process.stdout.write(r3.stdout);
  if (r3.stderr) process.stderr.write(r3.stderr);
  if (!r3.ok) {
    console.error('[GD-137] ERREUR étape 3 (code ' + r3.code + ')');
    summary.steps_failed.push('import-decisions');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('import-decisions');
  var stats3 = extractStats(r3.stdout);
  summary.keep   = stats3.keep;
  summary.reject = stats3.reject;
  summary.ignore = stats3.ignore;
  var decisionsPath = extractDecisionsPath(r3.stdout);
  summary.decisions_path = decisionsPath;

  // ── Étape 4 : analyze-client-learning ──────────────────────────────────
  console.log('\n[GD-137] ─── Étape 4/5 : analyze-client-learning ───');
  var r4 = runStep(steps[3].script, steps[3].args);
  process.stdout.write(r4.stdout);
  if (r4.stderr) process.stderr.write(r4.stderr);
  if (!r4.ok) {
    console.error('[GD-137] ERREUR étape 4 (code ' + r4.code + ')');
    summary.steps_failed.push('analyze-learning');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('analyze-learning');

  // ── Étape 5 : build-client-learning-hints ──────────────────────────────
  console.log('\n[GD-137] ─── Étape 5/5 : build-client-learning-hints ───');
  var r5 = runStep(steps[4].script, steps[4].args);
  process.stdout.write(r5.stdout);
  if (r5.stderr) process.stderr.write(r5.stderr);
  if (!r5.ok) {
    console.error('[GD-137] ERREUR étape 5 (code ' + r5.code + ')');
    summary.steps_failed.push('build-hints');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('build-hints');
  summary.hints_written = r5.stdout.includes('[OK] Hints');

  return { ok: true, summary: summary };
}

// ---------------------------------------------------------------------------
// Affichage du résumé final
// ---------------------------------------------------------------------------

function printSummary(summary) {
  console.log('\n' + '═'.repeat(60));
  console.log('[GD-137] RÉSUMÉ CYCLE FEEDBACK → LEARNING');
  console.log('═'.repeat(60));
  console.log('Client ID     :', summary.client_id);
  console.log('Depuis        :', summary.since);
  console.log('Radar type    :', summary.radar_type);
  console.log('Mode          :', summary.dry_run ? 'DRY-RUN (rien écrit)' : 'RÉEL');
  console.log('');
  if (summary.fetched  !== null) console.log('Feedback Supabase récupéré  :', summary.fetched);
  if (summary.exported !== null) console.log('Feedback exporté            :', summary.exported);
  if (summary.keep     !== null) console.log('Décisions keep              :', summary.keep);
  if (summary.reject   !== null) console.log('Décisions reject            :', summary.reject);
  if (summary.ignore   !== null) console.log('Décisions ignore            :', summary.ignore);
  console.log('');
  if (summary.jsonl_path)      console.log('JSONL créé         :', summary.jsonl_path);
  if (summary.csv_path)        console.log('CSV créé           :', summary.csv_path);
  if (summary.decisions_path)  console.log('Review-decisions   :', summary.decisions_path);
  if (summary.hints_written)   console.log('Hints mis à jour   : data/client-learning/client-learning-hints.json');
  console.log('');
  console.log('Étapes OK     :', summary.steps_ok.join(', ') || '(aucune)');
  if (summary.steps_failed.length) {
    console.log('Étapes ERREUR :', summary.steps_failed.join(', '));
  }
  console.log('═'.repeat(60));
}

// ---------------------------------------------------------------------------
// Point d'entrée CLI — IIFE (ne s'exécute que si lancé directement)
// ---------------------------------------------------------------------------

if (require.main === module) {
  var opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error('[GD-137] ' + opts.error);
    console.error('Usage : node scripts/run-client-feedback-learning-cycle.js --client-id <uuid> --since <iso> [--radar-type bc|mp] [--dry-run]');
    process.exit(1);
  }

  console.log('[GD-137] Démarrage cycle feedback → learning');
  console.log('[GD-137] client-id  :', opts.clientId);
  console.log('[GD-137] since      :', opts.since);
  console.log('[GD-137] radar-type :', opts.radarType);
  console.log('[GD-137] dry-run    :', opts.dryRun);

  var result = runCycle(opts);
  printSummary(result.summary);

  if (!result.ok) {
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Exports (pour tests unitaires)
// ---------------------------------------------------------------------------

module.exports = {
  parseArgs:             parseArgs,
  buildSteps:            buildSteps,
  extractJsonlPath:      extractJsonlPath,
  extractCsvPath:        extractCsvPath,
  extractDecisionsPath:  extractDecisionsPath,
  extractStats:          extractStats,
};
