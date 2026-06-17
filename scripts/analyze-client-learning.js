#!/usr/bin/env node
/**
 * analyze-client-learning.js
 * GD-032 — Rapport d'apprentissage par client (read-only).
 *
 * Agrège les décisions de review par client, puis par signal, et calcule :
 *   - statistiques keep/reject/ignore
 *   - cycles distincts (preuves indépendantes)
 *   - sources observées (operator / client / system)
 *   - verdict statistique générique
 *   - promotion_ready (cycles >= 2 + verdict positif)
 *   - blockers : insufficient_cycles | risky_signal | insufficient_data
 *
 * Read-only :
 *   - Ne modifie aucun fichier
 *   - Ne touche pas au matching legacy ni aux notifications
 *   - Aucune règle spécifique à un signal ou un client
 *
 * Compatibilité :
 *   - Anciens records sans cycle_id  → comptés dans stats, pas dans cycles
 *   - Anciens records sans review_source → traités comme operator
 *   - Anciens records sans matched_signals → ignorés pour l'agrégation signal
 *
 * Usage :
 *   node scripts/analyze-client-learning.js
 *   node scripts/analyze-client-learning.js --json   # output JSON brut
 */

'use strict';

var fs   = require('fs');
var path = require('path');

var DECISIONS_DIR = path.join(__dirname, '..', 'data', 'review-decisions');
var JSON_OUT = process.argv.includes('--json');

// ─── 1. Lecture + déduplication last-wins ────────────────────────────────────
// Clé de dédup : client::bc_id (dernière version importée gagne)

function loadAndDedup() {
  var files = [];
  try {
    files = fs.readdirSync(DECISIONS_DIR)
      .filter(function(f) { return /^review-decisions-.*\.json$/.test(f); })
      .sort();
  } catch (e) {
    console.error('[ERREUR] Dossier introuvable : ' + DECISIONS_DIR);
    process.exit(1);
  }

  var rawTotal = 0;
  var map      = {};   // client::bc_id → record (last-wins)

  files.forEach(function(fname) {
    var fpath = path.join(DECISIONS_DIR, fname);
    try {
      var data    = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      var records = data.records || [];
      rawTotal += records.length;
      records.forEach(function(r) {
        var key = String(r.client || '') + '::' + String(r.bc_id || '');
        map[key] = r;
      });
    } catch (e) {
      console.warn('[WARN] ' + fname + ' ignoré : ' + e.message);
    }
  });

  return {
    files:    files,
    rawTotal: rawTotal,
    records:  Object.values(map),
  };
}

// ─── 2. Classement verdict générique ─────────────────────────────────────────
// Aucune règle spécifique à un signal — uniquement des seuils de ratio.
// Valeurs compatibles avec TIER_ORDER de analyze-shadow-report.js.

function classifyVerdict(keep, reject, total) {
  if (!total) return 'Insuffisant';
  var kr = keep   / total;
  var rr = reject / total;
  if (kr >= 0.8 && total >= 2) return 'Tres fiable';
  if (kr >= 0.6 && total >= 2) return 'Fiable';
  if (rr >= 0.8 && total >= 2) return 'Risque';
  if (total === 1)              return 'Insuffisant';
  return 'Ambigu';
}

// ─── 3. Calcul promotion_ready + blockers ────────────────────────────────────
// promotion_ready = cycles >= 2 ET verdict positif (Tres fiable | Fiable)
// Priorité future source (client > operator > system) non encore appliquée :
// seulement loggée via warning si sources mixtes.

var POSITIVE_VERDICTS = ['Tres fiable', 'Fiable'];

function computeReadiness(sigEntry) {
  var cyclesSz = sigEntry.cycles.size;
  var verdict  = sigEntry.verdict;
  var blockers = [];

  if (cyclesSz < 2)                             blockers.push('insufficient_cycles');
  if (sigEntry.reject > sigEntry.keep)          blockers.push('risky_signal');
  if (sigEntry.total < 3)                       blockers.push('insufficient_data');

  var ready = blockers.length === 0 && POSITIVE_VERDICTS.indexOf(verdict) !== -1;

  return { ready: ready, blockers: blockers };
}

// ─── 4. Agrégation par client → signal ───────────────────────────────────────

function aggregate(records) {
  // Structure : { [client]: { [signal]: { keep, reject, ignore, total, cycles Set, sources Set } } }
  var byClient = {};

  records.forEach(function(r) {
    var client = String(r.client || '(inconnu)').trim();
    var src    = (r.review_source || 'operator');   // compat anciens records

    if (!byClient[client]) byClient[client] = {};

    var signals = r.matched_signals;
    if (!Array.isArray(signals) || signals.length === 0) return;  // pas de signal → ignoré

    signals.forEach(function(s) {
      var sig = String(s || '').trim();
      if (!sig) return;

      if (!byClient[client][sig]) {
        byClient[client][sig] = {
          signal:  sig,
          keep:    0,
          reject:  0,
          ignore:  0,
          total:   0,
          cycles:  new Set(),
          sources: new Set(),
        };
      }

      var e = byClient[client][sig];
      var dec = r.decision || '';
      if (dec === 'keep' || dec === 'reject' || dec === 'ignore') e[dec]++;
      e.total++;

      if (r.cycle_id)  e.cycles.add(r.cycle_id);   // null/undefined = anciens records → pas de cycle
      e.sources.add(src);
    });
  });

  // Calculer verdict, readiness, warnings
  var clientReports = {};

  Object.keys(byClient).sort().forEach(function(client) {
    var sigMap    = byClient[client];
    var sigReport = [];

    Object.keys(sigMap).sort().forEach(function(sig) {
      var e       = sigMap[sig];
      var verdict = classifyVerdict(e.keep, e.reject, e.total);
      var readiness = computeReadiness({ cycles: e.cycles, verdict: verdict, reject: e.reject, keep: e.keep, total: e.total });
      var sourcesArr = Array.from(e.sources).sort();

      // Warning sources mixtes : priorité future client > operator > system
      var hasMixedSources = e.sources.size > 1;

      sigReport.push({
        signal:         sig,
        keep:           e.keep,
        reject:         e.reject,
        ignore:         e.ignore,
        total:          e.total,
        keep_rate:      e.total ? Math.round(e.keep   / e.total * 100) : 0,
        reject_rate:    e.total ? Math.round(e.reject / e.total * 100) : 0,
        cycles_count:   e.cycles.size,
        sources:        sourcesArr,
        verdict:        verdict,
        promotion_ready: readiness.ready,
        blockers:       readiness.blockers,
        warn_mixed_sources: hasMixedSources,
      });
    });

    clientReports[client] = sigReport;
  });

  return clientReports;
}

// ─── 5. Affichage ─────────────────────────────────────────────────────────────

function hr(n) { return '─'.repeat(n || 63); }

function printReport(loaded, clientReports) {
  console.log('');
  console.log('╔' + '═'.repeat(62) + '╗');
  console.log('║   GD-032 — Rapport apprentissage par client              ║');
  console.log('╚' + '═'.repeat(62) + '╝');

  console.log('');
  console.log(hr());
  console.log('  Résumé global');
  console.log(hr());
  console.log('  Fichiers lus : ' + loaded.files.length);
  console.log('  Décisions brutes : ' + loaded.rawTotal);
  console.log('  Décisions dédupliquées (last-wins) : ' + loaded.records.length);
  console.log('  Clients distincts : ' + Object.keys(clientReports).length);
  console.log('');

  Object.keys(clientReports).sort().forEach(function(client) {
    var sigReport = clientReports[client];
    var totalSigs = sigReport.length;
    var ready     = sigReport.filter(function(s) { return s.promotion_ready; }).length;

    console.log(hr());
    console.log('  Client : ' + client);
    console.log('  Signaux : ' + totalSigs + '  |  promotion_ready : ' + ready);
    console.log(hr());

    if (totalSigs === 0) {
      console.log('  (aucun signal avec matched_signals)');
      return;
    }

    sigReport.forEach(function(s) {
      var readyStr  = s.promotion_ready ? '  ✓ READY' : '  ✗ bloqué';
      var blockStr  = s.blockers.length ? '  [' + s.blockers.join(', ') + ']' : '';
      var warnStr   = s.warn_mixed_sources ? '  ⚠ sources mixtes' : '';
      console.log(
        '  ' + String(s.signal).padEnd(32) +
        ' K=' + s.keep + '(' + s.keep_rate + '%)' +
        ' R=' + s.reject + '(' + s.reject_rate + '%)' +
        ' I=' + s.ignore +
        ' tot=' + s.total +
        ' cyc=' + s.cycles_count +
        ' src=' + s.sources.join('/') +
        ' [' + s.verdict + ']' +
        readyStr + blockStr + warnStr
      );
    });

    console.log('');
  });

  console.log(hr());
  console.log('  Rappel : rapport consultatif, read-only, shadow uniquement.');
  console.log('  Aucune activation production ne doit être déclenchée depuis ce script.');
  console.log(hr());
  console.log('');
}

// ─── main ─────────────────────────────────────────────────────────────────────

var loaded        = loadAndDedup();
var clientReports = aggregate(loaded.records);

if (JSON_OUT) {
  console.log(JSON.stringify({ files: loaded.files.length, records: loaded.records.length, clients: clientReports }, null, 2));
} else {
  printReport(loaded, clientReports);
}
