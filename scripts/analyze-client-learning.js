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
var normalizeLearningKey = require('./learning-key-utils').normalizeLearningKey;

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

  var rawTotal   = 0;
  var rawRecords = [];
  var map        = {};   // client::bc_id → record (last-wins)

  files.forEach(function(fname) {
    var fpath = path.join(DECISIONS_DIR, fname);
    try {
      var data    = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      var records = data.records || [];
      rawTotal += records.length;
      records.forEach(function(r) {
        rawRecords.push(r);
        var key = String(r.client || '') + '::' + String(r.bc_id || '');
        map[key] = r;
      });
    } catch (e) {
      console.warn('[WARN] ' + fname + ' ignoré : ' + e.message);
    }
  });

  return {
    files:      files,
    rawTotal:   rawTotal,
    records:    Object.values(map),
    rawRecords: rawRecords,
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
//
// GD-124 : politique sources advisory
//   - ai_assisted_validated = source consultative uniquement
//   - Un signal ne peut pas être promotion_ready grâce à ai_assisted_validated seul.
//   - Si les stats hors sources advisory (base) suffisent → READY inchangé.
//   - Si le signal devient READY uniquement via ai_assisted_validated → bloqué :
//     raison = 'blocked_by_ai_assisted_only'.

var POSITIVE_VERDICTS = ['Tres fiable', 'Fiable'];

// GD-124 : sources consultatives — ne peuvent pas déclencher promotion seules.
var AI_ADVISORY_SOURCES = ['ai_assisted_validated'];
function isAdvisorySource(src) { return AI_ADVISORY_SOURCES.indexOf(src) !== -1; }

function computeReadiness(sigEntry) {
  var cyclesSz = sigEntry.cycles.size;
  var verdict  = sigEntry.verdict;
  var blockers = [];

  if (cyclesSz < 2)                             blockers.push('insufficient_cycles');
  if (sigEntry.reject > sigEntry.keep)          blockers.push('risky_signal');
  if (sigEntry.total < 3)                       blockers.push('insufficient_data');

  // GD-124 : si le signal serait READY (pas de blockers encore) mais dépend
  // de sources advisory, vérifier si les stats "base" (hors advisory) suffisent.
  if (blockers.length === 0 && POSITIVE_VERDICTS.indexOf(verdict) !== -1 &&
      sigEntry.has_advisory_source) {
    var kb  = sigEntry.keep_base   || 0;
    var rb  = sigEntry.reject_base || 0;
    var ib  = sigEntry.ignore_base || 0;
    var tb  = sigEntry.total_base  || 0;
    var csz = sigEntry.cycles_base ? sigEntry.cycles_base.size : 0;
    var baseVerdict  = classifyVerdict(kb, rb, tb);
    var baseBlockers = [];
    if (csz < 2)       baseBlockers.push('insufficient_cycles');
    if (rb > kb)       baseBlockers.push('risky_signal');
    if (tb < 3)        baseBlockers.push('insufficient_data');
    var baseReady = baseBlockers.length === 0 && POSITIVE_VERDICTS.indexOf(baseVerdict) !== -1;
    if (!baseReady) blockers.push('blocked_by_ai_assisted_only');
  }

  var ready = blockers.length === 0 && POSITIVE_VERDICTS.indexOf(verdict) !== -1;

  return { ready: ready, blockers: blockers };
}

// ─── 4. Agrégation par client → signal ───────────────────────────────────────

function aggregate(records, rawRecords) {
  // Structure : { [client]: { [signal]: { keep, reject, ignore, total, cycles Set, sources Set } } }
  var byClient = {};

  // Phase 1 : stats keep/reject/ignore/total depuis les records dédupliqués
  // Clé d'agrégation = normalisée ; label original (premier vu) conservé pour affichage.
  records.forEach(function(r) {
    var rawClient = String(r.client || '(inconnu)').trim();
    var ck        = normalizeLearningKey(rawClient) || rawClient;

    if (!byClient[ck]) byClient[ck] = { _label: rawClient };

    var signals = r.matched_signals;
    if (!Array.isArray(signals) || signals.length === 0) return;  // pas de signal → ignoré

    signals.forEach(function(s) {
      var rawSig = String(s || '').trim();
      if (!rawSig) return;
      var sk = normalizeLearningKey(rawSig) || rawSig;

      if (!byClient[ck][sk]) {
        byClient[ck][sk] = {
          signal:             sk,
          label:              rawSig,   // label original premier vu
          keep:               0,
          reject:             0,
          ignore:             0,
          total:              0,
          // GD-124 : stats hors sources advisory (base = operator + client + system)
          keep_base:          0,
          reject_base:        0,
          ignore_base:        0,
          total_base:         0,
          cycles:             new Set(),
          cycles_base:        new Set(),   // GD-124 : cycles hors advisory
          sources:            new Set(),
          has_advisory_source: false,
        };
      }

      var e   = byClient[ck][sk];
      var dec = r.decision || '';
      if (dec === 'keep' || dec === 'reject' || dec === 'ignore') e[dec]++;
      e.total++;
      // GD-124 : stats base (hors advisory) depuis les records dédupliqués
      var src_dedup = (r.review_source || 'operator');
      if (!isAdvisorySource(src_dedup)) {
        if (dec === 'keep' || dec === 'reject' || dec === 'ignore') e[dec + '_base']++;
        e.total_base++;
      }
    });
  });

  // Phase 2 : cycles et sources depuis tous les records bruts (avant dedup)
  (rawRecords || records).forEach(function(r) {
    var rawClient = String(r.client || '(inconnu)').trim();
    var ck        = normalizeLearningKey(rawClient) || rawClient;
    var src       = (r.review_source || 'operator');

    if (!byClient[ck]) return;  // client sans record dédupliqué → skip

    var signals = r.matched_signals;
    if (!Array.isArray(signals) || signals.length === 0) return;

    signals.forEach(function(s) {
      var rawSig = String(s || '').trim();
      if (!rawSig) return;
      var sk = normalizeLearningKey(rawSig) || rawSig;
      if (!byClient[ck][sk]) return;

      var e = byClient[ck][sk];
      if (r.cycle_id) e.cycles.add(r.cycle_id);   // null/undefined → pas de cycle
      e.sources.add(src);
      // GD-124 : cycles et flag advisory depuis les rawRecords
      if (isAdvisorySource(src)) {
        e.has_advisory_source = true;
      } else {
        if (r.cycle_id) e.cycles_base.add(r.cycle_id);
      }
    });
  });

  // Calculer verdict, readiness, warnings
  var clientReports = {};

  Object.keys(byClient).sort().forEach(function(ck) {
    var sigMap    = byClient[ck];
    var client    = sigMap._label || ck;   // label original pour affichage
    var sigReport = [];

    Object.keys(sigMap).sort().forEach(function(sig) {
      if (sig === '_label') return;   // métadonnée interne, pas un signal
      var e       = sigMap[sig];
      var verdict = classifyVerdict(e.keep, e.reject, e.total);
      // GD-124 : passer les stats base pour détection blocked_by_ai_assisted_only
      var readiness = computeReadiness({
        cycles: e.cycles, verdict: verdict, reject: e.reject, keep: e.keep, total: e.total,
        keep_base: e.keep_base, reject_base: e.reject_base, ignore_base: e.ignore_base,
        total_base: e.total_base, cycles_base: e.cycles_base,
        has_advisory_source: e.has_advisory_source,
      });
      var sourcesArr = Array.from(e.sources).sort();

      // Warning sources mixtes : priorité future client > operator > system
      var hasMixedSources = e.sources.size > 1;

      sigReport.push({
        signal:         sig,            // clé normalisée
        label:          e.label || sig, // label original premier vu
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
      var displaySig = s.label !== s.signal ? (s.label + ' [' + s.signal + ']') : s.signal;
      console.log(
        '  ' + String(displaySig).padEnd(32) +
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
var clientReports = aggregate(loaded.records, loaded.rawRecords);

if (JSON_OUT) {
  console.log(JSON.stringify({ files: loaded.files.length, records: loaded.records.length, clients: clientReports }, null, 2));
} else {
  printReport(loaded, clientReports);
}
