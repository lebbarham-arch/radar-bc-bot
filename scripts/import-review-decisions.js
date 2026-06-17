#!/usr/bin/env node
// scripts/import-review-decisions.js
// Usage: node scripts/import-review-decisions.js <review-csv-file> [options]
//
// Options :
//   --dry-run                       Affiche sans écrire le JSON
//   --cycle-id <valeur>             Identifiant du cycle de review (surcharge l'extraction auto)
//   --review-source operator|client|system
//                                   Source de la décision (défaut : operator)
//
// Lit un CSV de review candidates (exporté par analyze-shadow-report.js --export-review-csv)
// et importe les décisions humaines (keep/reject/ignore/vide) dans un JSON de synthèse.
//
// Champs ajoutés dans chaque record :
//   cycle_id      : extrait du nom du CSV (pattern YYYY-MM-DDTHH-MM-SS) ou --cycle-id
//   review_source : operator (calibration interne) | client (feedback réel) | system
//   reviewed_at   : timestamp ISO de l'import
//
// Sortie : data/review-decisions/review-decisions-YYYY-MM-DDTHH-mm-ss.json
//          (fallback : même dossier que le CSV d'entrée si data/review-decisions/ inaccessible)

'use strict';

var fs   = require('fs');
var path = require('path');

// ─────────────────────────────────────────────
// Parsing CSV : BOM UTF-8, séparateur ;, quotes doubles
// ─────────────────────────────────────────────
function parseCsv(raw) {
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  var lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  return lines.map(function(line) { return parseCsvLine(line); });
}

function parseCsvLine(line) {
  var fields = [];
  var i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(''); break; }
    if (line[i] === '"') {
      var buf = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { buf += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { buf += line[i++]; }
      }
      fields.push(buf);
      if (line[i] === ';') i++;
    } else {
      var end = line.indexOf(';', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

// ─────────────────────────────────────────────
// Extraction cycle_id depuis le nom de fichier
// ─────────────────────────────────────────────
// Cherche le pattern YYYY-MM-DDTHH-MM-SS dans le basename du fichier CSV.
// Ex : review-candidates-2026-06-17T22-15-41.csv → "2026-06-17T22-15-41"
// Ex : auto-candidates-admin-2026-06-18T09-00-00.csv → "2026-06-18T09-00-00"
// Retourne null si le pattern est absent.
function extractCycleId(filePath) {
  var basename = path.basename(filePath);
  var m = basename.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// ─────────────────────────────────────────────
// Args
// ─────────────────────────────────────────────
var args         = process.argv.slice(2);
var csvPath      = null;
var dryRun       = false;
var cycleIdArg   = undefined;  // undefined = extraction auto ; null = absent du nom de fichier
var reviewSource = 'operator'; // operator | client | system

for (var _i = 0; _i < args.length; _i++) {
  var _a = args[_i];
  if (_a === '--dry-run') {
    dryRun = true;
  } else if (_a === '--cycle-id' && args[_i + 1] && !args[_i + 1].startsWith('--')) {
    cycleIdArg = args[++_i];
  } else if (_a === '--review-source' && args[_i + 1] && !args[_i + 1].startsWith('--')) {
    var _src = args[++_i].toLowerCase();
    if (_src === 'operator' || _src === 'client' || _src === 'system') {
      reviewSource = _src;
    } else {
      console.warn('WARN: --review-source invalide "' + _src + '" → "operator" utilisé');
    }
  } else if (!csvPath && !_a.startsWith('--')) {
    csvPath = _a;
  }
}

if (!csvPath) {
  console.error('Usage: node scripts/import-review-decisions.js <review-csv-file> [--dry-run]');
  process.exit(1);
}

if (!fs.existsSync(csvPath)) {
  console.error('ERROR: Fichier introuvable : ' + csvPath);
  process.exit(1);
}

// ─────────────────────────────────────────────
// Lecture + parsing
// ─────────────────────────────────────────────
var raw  = fs.readFileSync(csvPath, 'utf8');
var rows = parseCsv(raw).filter(function(r) { return r.join('').trim() !== ''; });

if (rows.length < 2) {
  console.error('ERROR: CSV vide ou sans ligne de données.');
  process.exit(1);
}

var header = rows[0];
var COL = {
  client:             header.indexOf('client'),
  bc_id:              header.indexOf('bc_id'),
  score:              header.indexOf('score'),
  signal_origin:      header.indexOf('signal_origin'),
  matched_signals:    header.indexOf('matched_signals'),
  strength_reason:    header.indexOf('strength_reason'),
  weak_single_signal: header.indexOf('weak_single_signal'),
  clean_text_excerpt: header.indexOf('clean_text_excerpt'),
  decision:           header.indexOf('decision'),
};

var missing = Object.keys(COL).filter(function(k) { return COL[k] === -1; });
if (missing.length) {
  console.error('ERROR: Colonnes manquantes dans le CSV : ' + missing.join(', '));
  console.error('  Header détecté :', header.join(' | '));
  process.exit(1);
}

// ─────────────────────────────────────────────
// Traitement lignes
// ─────────────────────────────────────────────
// Résoudre les métadonnées de cycle avant la boucle
var _reviewedAt  = new Date().toISOString();
var _cycleId     = (cycleIdArg !== undefined) ? cycleIdArg : extractCycleId(csvPath);

var VALID_DECISIONS = ['keep', 'reject', 'ignore', ''];
var records  = [];
var counters = { total: 0, keep: 0, reject: 0, ignore: 0, vide: 0, invalid: 0 };
var signalKeep   = {};
var signalReject = {};

rows.slice(1).forEach(function(row) {
  counters.total++;

  var decision = (row[COL.decision] || '').trim().toLowerCase();
  if (VALID_DECISIONS.indexOf(decision) === -1) {
    console.warn('  WARN: décision invalide "' + decision + '" pour bc_id=' + row[COL.bc_id] + ' → remis à vide');
    counters.invalid++;
    decision = '';
  }

  var signals = (row[COL.matched_signals] || '')
    .split(',').map(function(s) { return s.trim(); }).filter(Boolean);

  var rec = {
    client:             row[COL.client]             || '',
    bc_id:              row[COL.bc_id]              || '',
    score:              Number(row[COL.score])       || 0,
    signal_origin:      row[COL.signal_origin]       || '',
    matched_signals:    signals,
    strength_reason:    row[COL.strength_reason]     || '',
    weak_single_signal: row[COL.weak_single_signal] === 'true',
    clean_text_excerpt: row[COL.clean_text_excerpt]  || '',
    decision:           decision,
    cycle_id:           _cycleId,       // null si non détectable depuis le nom du fichier
    review_source:      reviewSource,   // operator | client | system
    reviewed_at:        _reviewedAt,    // timestamp ISO de l'import
  };
  records.push(rec);

  if (decision === 'keep') {
    counters.keep++;
    signals.forEach(function(s) { signalKeep[s] = (signalKeep[s] || 0) + 1; });
  } else if (decision === 'reject') {
    counters.reject++;
    signals.forEach(function(s) { signalReject[s] = (signalReject[s] || 0) + 1; });
  } else if (decision === 'ignore') {
    counters.ignore++;
  } else {
    counters.vide++;
  }
});

// ─────────────────────────────────────────────
// Affichage résumé
// ─────────────────────────────────────────────
function topSignals(map, n) {
  return Object.keys(map)
    .sort(function(a, b) { return map[b] - map[a]; })
    .slice(0, n)
    .map(function(s) { return s + '×' + map[s]; })
    .join(', ');
}

console.log('\n=== Import Review Decisions ===');
console.log('Fichier       :', csvPath);
console.log('cycle_id      :', _cycleId      || '(non détecté)');
console.log('review_source :', reviewSource);
console.log('reviewed_at   :', _reviewedAt);
console.log('Total         :', counters.total);
console.log('keep     :', counters.keep);
console.log('reject   :', counters.reject);
console.log('ignore   :', counters.ignore);
console.log('vide     :', counters.vide);
if (counters.invalid) console.log('invalide :', counters.invalid, '(remis à vide)');
if (counters.keep)    console.log('Top signaux keep   :', topSignals(signalKeep,   5));
if (counters.reject)  console.log('Top signaux reject :', topSignals(signalReject, 5));

// ─────────────────────────────────────────────
// Écriture JSON
// ─────────────────────────────────────────────
if (dryRun) {
  console.log('\n[DRY-RUN] Aucun fichier écrit.');
  console.log('Serait écrit dans : data/review-decisions/');
  console.log('\nRecords prévus :');
  records.forEach(function(r) { console.log('  ', JSON.stringify(r)); });
  process.exit(0);
}

var now   = new Date();
var ts    = now.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
var fname = 'review-decisions-' + ts + '.json';

var outputData = {
  imported_at: now.toISOString(),
  source_csv:  path.resolve(csvPath),
  counters:    counters,
  records:     records,
};

// Tentative 1 : data/review-decisions/
var outputDir  = path.resolve('data/review-decisions');
var outputPath = path.join(outputDir, fname);

try {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), 'utf8');
  console.log('\nJSON écrit :', outputPath);
} catch (e1) {
  // Fallback VirtioFS : même dossier que le CSV
  var fallbackDir  = path.dirname(path.resolve(csvPath));
  var fallbackPath = path.join(fallbackDir, fname);
  try {
    fs.writeFileSync(fallbackPath, JSON.stringify(outputData, null, 2), 'utf8');
    console.log('\nJSON écrit (fallback) :', fallbackPath);
  } catch (e2) {
    console.error('\nERROR: Impossible d\'écrire le JSON :', e1.message, '/', e2.message);
    process.exit(1);
  }
}
