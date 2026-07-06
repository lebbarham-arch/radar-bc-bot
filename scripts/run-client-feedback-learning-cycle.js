#!/usr/bin/env node
// scripts/run-client-feedback-learning-cycle.js
// GD-137 / GD-138 -- Orchestrateur local du cycle complet feedback client -> learning -> hints.
//
// Orchestre les 5 scripts existants en sequence :
//   1. export-client-feedback-events.js    -> JSONL Supabase
//   2. convert-feedback-events-to-review-csv.js -> CSV review candidates (--dedupe)
//   3. import-review-decisions.js          -> JSON review-decisions
//   4. analyze-client-learning.js          -> analyse learning
//   5. build-client-learning-hints.js      -> hints JSON
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
//   --radar-type <type>  "bc" | "mp"  (defaut : "bc")
//   --dry-run            Mode lecture seule : aucun fichier ecrit, aucun import
//
// SECURITE :
//   - Ne modifie pas radar-bc-bot.js ni le moteur
//   - Ne modifie pas les profils clients
//   - Ne modifie pas la production legacy
//   - Ne touche pas Fly, secrets, notifications
//   - En --dry-run : propage le flag a chaque script appele
//   - Generique multi-clients, aucune logique metier codee en dur

'use strict';

var fs    = require('fs');
var path  = require('path');
var spawn = require('child_process').spawnSync;

var ROOT         = path.join(__dirname, '..');
var NODE         = process.execPath;
var FEEDBACK_DIR = path.join(ROOT, 'data', 'feedback');
var _report      = require('./generate-client-learning-report');

// ---------------------------------------------------------------------------
// parseArgs -- pur, testable directement
// ---------------------------------------------------------------------------

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
// buildSteps -- construit les 5 etapes sans les executer (pur, testable)
// ---------------------------------------------------------------------------

function buildSteps(opts) {
  var dr = opts.dryRun ? ['--dry-run'] : [];

  return [
    {
      name:        'export-feedback',
      script:      path.join(ROOT, 'scripts', 'export-client-feedback-events.js'),
      args:        ['--client-id', opts.clientId, '--since', opts.since,
                    '--radar-type', opts.radarType].concat(dr),
      placeholder: 'JSONL_PATH',
    },
    {
      name:        'convert-to-csv',
      script:      path.join(ROOT, 'scripts', 'convert-feedback-events-to-review-csv.js'),
      args:        ['--dedupe'].concat(dr),
      placeholder: 'CSV_PATH',
    },
    {
      name:        'import-decisions',
      script:      path.join(ROOT, 'scripts', 'import-review-decisions.js'),
      args:        ['--review-source', 'client'].concat(dr),
      placeholder: 'DECISIONS_PATH',
    },
    {
      name:        'analyze-learning',
      script:      path.join(ROOT, 'scripts', 'analyze-client-learning.js'),
      args:        [],
    },
    {
      name:        'build-hints',
      script:      path.join(ROOT, 'scripts', 'build-client-learning-hints.js'),
      args:        dr,
    },
  ];
}

// ---------------------------------------------------------------------------
// Extracteurs stdout -- purs, testables
// ---------------------------------------------------------------------------

function extractJsonlPath(stdout) {
  var m = stdout.match(/\[OK\] JSONL ecrit : (.+)/);
  return m ? m[1].trim() : null;
}

function extractCsvPath(stdout) {
  var m = stdout.match(/\[OK\] CSV ecrit : (.+)/);
  return m ? m[1].trim() : null;
}

function extractDecisionsPath(stdout) {
  var m = stdout.match(/JSON ecrit(?:\s*\(fallback\))?\s*:\s*(.+)/);
  return m ? m[1].trim() : null;
}

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
// Idempotency -- GD-138
// ---------------------------------------------------------------------------

function makeEventKey(event) {
  return [
    String(event.client_id  || ''),
    String(event.item_id    || ''),
    String(event.radar_type || ''),
    String(event.critere    || ''),
    String(event.type       || ''),
    String(event.created_at || ''),
  ].join('|');
}

function readJsonlEvents(filePath) {
  try {
    var lines  = fs.readFileSync(filePath, 'utf8').split('\n');
    var events = [];
    lines.forEach(function(line) {
      var l = line.trim();
      if (!l) return;
      try { events.push(JSON.parse(l)); } catch (_) {}
    });
    return events;
  } catch (_) {
    return [];
  }
}

function loadKnownEventKeys(feedbackDir, excludePath) {
  var knownKeys = new Set();
  try {
    var files = fs.readdirSync(feedbackDir).filter(function(f) {
      return /^feedback-events-client-.*\.jsonl$/.test(f);
    });
    files.forEach(function(fname) {
      var fpath = path.join(feedbackDir, fname);
      if (excludePath && path.resolve(fpath) === path.resolve(excludePath)) return;
      var events = readJsonlEvents(fpath);
      events.forEach(function(e) { knownKeys.add(makeEventKey(e)); });
    });
  } catch (_) {}
  return knownKeys;
}

function filterNewEvents(events, knownKeys) {
  return events.filter(function(e) {
    return !knownKeys.has(makeEventKey(e));
  });
}

// ---------------------------------------------------------------------------
// Execution d'une etape (wraps spawnSync)
// ---------------------------------------------------------------------------

function runStep(scriptPath, args) {
  var result = spawn(NODE, [scriptPath].concat(args), {
    cwd:      ROOT,
    encoding: 'utf8',
    env:      process.env,
  });
  var code = result.status !== null ? result.status : (result.error ? 1 : 0);
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

function runCycle(opts) {
  var steps   = buildSteps(opts);
  var summary = {
    client_id:        opts.clientId,
    since:            opts.since,
    radar_type:       opts.radarType,
    dry_run:          opts.dryRun,
    fetched:          null,
    exported:         null,
    known_count:      null,
    new_count:        null,
    no_new_feedback:  false,
    keep:             null,
    reject:           null,
    ignore:           null,
    jsonl_path:       null,
    csv_path:         null,
    decisions_path:   null,
    hints_written:    false,
    report_path:      null,
    steps_ok:         [],
    steps_failed:     [],
  };

  // Etape 1 : export feedback
  console.log('\n[GD-137] Etape 1/5 : export-client-feedback-events');
  var r1 = runStep(steps[0].script, steps[0].args);
  process.stdout.write(r1.stdout);
  if (r1.stderr) process.stderr.write(r1.stderr);
  if (!r1.ok) {
    console.error('[GD-137] ERREUR etape 1 (code ' + r1.code + ')');
    summary.steps_failed.push('export-feedback');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('export-feedback');
  var stats1 = extractStats(r1.stdout);
  summary.fetched  = stats1.fetched;
  summary.exported = stats1.exported;

  // En dry-run, pas de fichier -> arret propre apres etape 1
  if (opts.dryRun) {
    console.log('\n[GD-137] --dry-run actif : etapes 2..5 ignorees (aucun fichier ecrit).');
    return { ok: true, summary: summary };
  }

  var jsonlPath = extractJsonlPath(r1.stdout);

  // Cas zero events Supabase (aucun JSONL ecrit)
  if (!jsonlPath) {
    if (summary.exported === 0 || summary.fetched === 0) {
      summary.no_new_feedback = true;
      summary.known_count     = 0;
      summary.new_count       = 0;
      console.log('[GD-138] Aucun event Supabase -- etapes 2..5 ignorees.');
      return { ok: true, summary: summary };
    }
    console.error('[GD-137] ERREUR : impossible de detecter le chemin JSONL dans la sortie etape 1.');
    summary.steps_failed.push('extract-jsonl-path');
    return { ok: false, summary: summary };
  }
  summary.jsonl_path = jsonlPath;

  // Idempotency GD-138 : filtrer les events deja connus
  console.log('\n[GD-138] Verification idempotency...');
  var allNewEvents = readJsonlEvents(jsonlPath);
  var knownKeys    = loadKnownEventKeys(FEEDBACK_DIR, jsonlPath);
  var freshEvents  = filterNewEvents(allNewEvents, knownKeys);
  summary.known_count = allNewEvents.length - freshEvents.length;
  summary.new_count   = freshEvents.length;
  console.log('[GD-138] Events Supabase : ' + allNewEvents.length
    + ' | deja connus : ' + summary.known_count
    + ' | nouveaux : ' + summary.new_count);

  if (summary.new_count === 0) {
    // Aucun nouveau feedback -- supprimer le JSONL doublon et terminer proprement
    try { fs.unlinkSync(jsonlPath); } catch (_) {}
    summary.jsonl_path      = null;
    summary.no_new_feedback = true;
    console.log('[GD-138] Aucun nouveau feedback -- etapes 2..5 ignorees.');
    return { ok: true, summary: summary };
  }

  // Si certains events sont deja connus, reecrire le JSONL avec seulement les nouveaux
  if (summary.known_count > 0) {
    var filteredContent = freshEvents.map(function(e) { return JSON.stringify(e); }).join('\n') + '\n';
    fs.writeFileSync(jsonlPath, filteredContent, 'utf8');
    console.log('[GD-138] JSONL reecrit avec ' + summary.new_count + ' event(s) nouveau(x) uniquement.');
  }

  // Etape 2 : conversion JSONL -> CSV
  console.log('\n[GD-137] Etape 2/5 : convert-feedback-events-to-review-csv');
  var step2args = ['--input', jsonlPath, '--dedupe'];
  var r2 = runStep(steps[1].script, step2args);
  process.stdout.write(r2.stdout);
  if (r2.stderr) process.stderr.write(r2.stderr);
  if (!r2.ok) {
    console.error('[GD-137] ERREUR etape 2 (code ' + r2.code + ')');
    summary.steps_failed.push('convert-to-csv');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('convert-to-csv');
  var csvPath = extractCsvPath(r2.stdout);
  if (!csvPath) {
    console.error('[GD-137] ERREUR : impossible de detecter le chemin CSV dans la sortie etape 2.');
    summary.steps_failed.push('extract-csv-path');
    return { ok: false, summary: summary };
  }
  summary.csv_path = csvPath;

  // Etape 3 : import CSV -> review-decisions
  console.log('\n[GD-137] Etape 3/5 : import-review-decisions');
  var step3args = [csvPath, '--review-source', 'client'];
  var r3 = runStep(steps[2].script, step3args);
  process.stdout.write(r3.stdout);
  if (r3.stderr) process.stderr.write(r3.stderr);
  if (!r3.ok) {
    console.error('[GD-137] ERREUR etape 3 (code ' + r3.code + ')');
    summary.steps_failed.push('import-decisions');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('import-decisions');
  var stats3 = extractStats(r3.stdout);
  summary.keep          = stats3.keep;
  summary.reject        = stats3.reject;
  summary.ignore        = stats3.ignore;
  summary.decisions_path = extractDecisionsPath(r3.stdout);

  // Etape 4 : analyze-client-learning
  console.log('\n[GD-137] Etape 4/5 : analyze-client-learning');
  var r4 = runStep(steps[3].script, steps[3].args);
  process.stdout.write(r4.stdout);
  if (r4.stderr) process.stderr.write(r4.stderr);
  if (!r4.ok) {
    console.error('[GD-137] ERREUR etape 4 (code ' + r4.code + ')');
    summary.steps_failed.push('analyze-learning');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('analyze-learning');

  // Etape 5 : build-client-learning-hints
  console.log('\n[GD-137] Etape 5/5 : build-client-learning-hints');
  var r5 = runStep(steps[4].script, steps[4].args);
  process.stdout.write(r5.stdout);
  if (r5.stderr) process.stderr.write(r5.stderr);
  if (!r5.ok) {
    console.error('[GD-137] ERREUR etape 5 (code ' + r5.code + ')');
    summary.steps_failed.push('build-hints');
    return { ok: false, summary: summary };
  }
  summary.steps_ok.push('build-hints');
  summary.hints_written = r5.stdout.includes('[OK] Hints');

  // Etape 6 (optionnelle) : generer le rapport learning GD-139
  // Seulement si de nouveaux feedbacks ont ete traites ET hints mis a jour.
  if (summary.hints_written && summary.new_count > 0 && !opts.dryRun) {
    console.log('\n[GD-139] Generation du rapport learning client...');
    try {
      var reportsDir    = path.join(ROOT, 'data', 'reports');
      var reportTs      = new Date().toISOString().replace(/[:.]/g, '-');
      var reportFname   = 'client-learning-report-' + opts.clientId.slice(0, 8) + '-' + reportTs + '.md';
      var reportOutPath = path.join(reportsDir, reportFname);
      var reportResult  = _report.runReport(opts.clientId, null, null, {
        generatedAt: new Date().toISOString(),
      });
      if (reportResult.ok) {
        if (!require('fs').existsSync(reportsDir)) {
          require('fs').mkdirSync(reportsDir, { recursive: true });
        }
        require('fs').writeFileSync(reportOutPath, reportResult.report, 'utf8');
        summary.report_path = reportOutPath;
        console.log('[GD-139] Rapport ecrit : ' + reportOutPath);
        summary.steps_ok.push('generate-report');
      } else {
        console.warn('[GD-139] Avertissement rapport : ' + reportResult.error);
      }
    } catch (err) {
      console.warn('[GD-139] Avertissement rapport (non bloquant) : ' + String(err));
    }
  }

  return { ok: true, summary: summary };
}

// ---------------------------------------------------------------------------
// Affichage du resume final
// ---------------------------------------------------------------------------

function printSummary(summary) {
  console.log('\n' + '='.repeat(60));
  console.log('[GD-137] RESUME CYCLE FEEDBACK -> LEARNING');
  console.log('='.repeat(60));
  console.log('Client ID     :', summary.client_id);
  console.log('Depuis        :', summary.since);
  console.log('Radar type    :', summary.radar_type);
  console.log('Mode          :', summary.dry_run ? 'DRY-RUN (rien ecrit)' : 'REEL');
  console.log('');
  if (summary.fetched      !== null) console.log('Feedback Supabase recupere  :', summary.fetched);
  if (summary.exported     !== null) console.log('Feedback exporte            :', summary.exported);
  if (summary.known_count  !== null) console.log('Deja connus (ignores)       :', summary.known_count);
  if (summary.new_count    !== null) console.log('Nouveaux retenus            :', summary.new_count);
  if (summary.no_new_feedback)       console.log('Statut                      : no_new_feedback');
  if (summary.keep         !== null) console.log('Decisions keep              :', summary.keep);
  if (summary.reject       !== null) console.log('Decisions reject            :', summary.reject);
  if (summary.ignore       !== null) console.log('Decisions ignore            :', summary.ignore);
  console.log('');
  if (summary.jsonl_path)      console.log('JSONL cree         :', summary.jsonl_path);
  if (summary.csv_path)        console.log('CSV cree           :', summary.csv_path);
  if (summary.decisions_path)  console.log('Review-decisions   :', summary.decisions_path);
  if (summary.hints_written)   console.log('Hints mis a jour   : data/client-learning/client-learning-hints.json');
  if (summary.report_path)     console.log('Rapport learning   :', summary.report_path);
  console.log('');
  console.log('Etapes OK     :', summary.steps_ok.join(', ') || '(aucune)');
  if (summary.steps_failed.length) {
    console.log('Etapes ERREUR :', summary.steps_failed.join(', '));
  }
  console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// Point d'entree CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  var opts = parseArgs(process.argv.slice(2));
  if (opts.error) {
    console.error('[GD-137] ' + opts.error);
    console.error('Usage : node scripts/run-client-feedback-learning-cycle.js --client-id <uuid> --since <iso> [--radar-type bc|mp] [--dry-run]');
    process.exit(1);
  }

  console.log('[GD-137] Demarrage cycle feedback -> learning');
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
  // GD-138 : idempotency
  makeEventKey:          makeEventKey,
  readJsonlEvents:       readJsonlEvents,
  loadKnownEventKeys:    loadKnownEventKeys,
  filterNewEvents:       filterNewEvents,
};
