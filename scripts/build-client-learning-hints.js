#!/usr/bin/env node
/**
 * build-client-learning-hints.js
 * GD-033 — Générateur de hints d'apprentissage par client (shadow uniquement).
 *
 * Lit  : data/review-decisions/review-decisions-*.json
 * Écrit: data/client-learning/client-learning-hints.json
 *
 * Les hints sont consultatifs et indicatifs pour le shadow uniquement.
 * Aucune activation production. Aucune règle spécifique à un signal ou client.
 * Pas d'exclusion définitive — uniquement des ajustements de score et
 * des signaux de routing (keep_review / demote_to_review / boost).
 *
 * Logique des effets (par priorité, du plus conservateur au plus confiant) :
 *   1. cycles_count < 2  → insufficient_data  (adj=0,  block_auto=true)
 *   2. total < 3         → keep_review         (adj=0,  block_auto=true)
 *   3. reject > keep     → demote_to_review    (adj=-3, block_auto=true)
 *   4. keep_rate >= 80 % + cycles >= 2 + total >= 3
 *                        → boost               (adj=+5, block_auto=false)
 *   5. sinon             → keep_review         (adj=0,  block_auto=true)
 *
 * Usage :
 *   node scripts/build-client-learning-hints.js
 *   node scripts/build-client-learning-hints.js --dry-run  # affiche sans écrire
 */

'use strict';

var fs   = require('fs');
var path = require('path');

var DECISIONS_DIR   = path.join(__dirname, '..', 'data', 'review-decisions');
var HINTS_DIR       = path.join(__dirname, '..', 'data', 'client-learning');
var HINTS_FILE      = path.join(HINTS_DIR, 'client-learning-hints.json');
var DRY_RUN         = process.argv.includes('--dry-run');

// ─── 1. Lecture + collecte rawRecords + déduplication last-wins ───────────────

function loadDecisions() {
  var files = [];
  try {
    files = fs.readdirSync(DECISIONS_DIR)
      .filter(function(f) { return /^review-decisions-.*\.json$/.test(f); })
      .sort();
  } catch (e) {
    console.error('[ERREUR] Dossier introuvable : ' + DECISIONS_DIR);
    process.exit(1);
  }

  var rawRecords = [];
  var rawTotal   = 0;
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
    records:    Object.values(map),   // dédupliqués (last-wins)
    rawRecords: rawRecords,           // tous les records avant dedup
  };
}

// ─── 2. Agrégation par client → signal ───────────────────────────────────────

function aggregate(records, rawRecords) {
  var byClient = {};

  // Phase 1 : stats keep/reject/ignore/total depuis les records dédupliqués
  records.forEach(function(r) {
    var client = String(r.client || '(inconnu)').trim();

    if (!byClient[client]) byClient[client] = {};

    var signals = r.matched_signals;
    if (!Array.isArray(signals) || signals.length === 0) return;

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

      var e   = byClient[client][sig];
      var dec = r.decision || '';
      if (dec === 'keep' || dec === 'reject' || dec === 'ignore') e[dec]++;
      e.total++;
    });
  });

  // Phase 2 : cycles et sources depuis tous les records bruts (avant dedup)
  (rawRecords || records).forEach(function(r) {
    var client = String(r.client || '(inconnu)').trim();
    var src    = (r.review_source || 'operator');

    if (!byClient[client]) return;

    var signals = r.matched_signals;
    if (!Array.isArray(signals) || signals.length === 0) return;

    signals.forEach(function(s) {
      var sig = String(s || '').trim();
      if (!sig || !byClient[client][sig]) return;

      var e = byClient[client][sig];
      if (r.cycle_id) e.cycles.add(r.cycle_id);
      e.sources.add(src);
    });
  });

  return byClient;
}

// ─── 3. Calcul du hint par signal ─────────────────────────────────────────────
// Aucune règle spécifique à un signal ou un client.
// Uniquement des seuils génériques sur les ratios et les cycles.

function computeHint(e) {
  var cyclesCount = e.cycles.size;
  var keepRate    = e.total > 0 ? Math.round(e.keep / e.total * 100) : 0;
  var rejectRate  = e.total > 0 ? Math.round(e.reject / e.total * 100) : 0;

  var effect, scoreAdj, blockAuto, reason;

  if (cyclesCount < 2) {
    effect    = 'insufficient_data';
    scoreAdj  = 0;
    blockAuto = true;
    reason    = 'Cycles insuffisants (' + cyclesCount + '/2 requis) — décision non fiable';
  } else if (e.total < 3) {
    effect    = 'keep_review';
    scoreAdj  = 0;
    blockAuto = true;
    reason    = 'Données insuffisantes (' + e.total + ' décisions, minimum 3)';
  } else if (e.reject > e.keep) {
    effect    = 'demote_to_review';
    scoreAdj  = -3;
    blockAuto = true;
    reason    = 'Signal rejeté/ignoré pour ce client sur plusieurs cycles';
  } else if (keepRate >= 80 && cyclesCount >= 2 && e.total >= 3) {
    effect    = 'boost';
    scoreAdj  = +5;
    blockAuto = false;
    reason    = 'Signal fiable pour ce client (keep_rate=' + keepRate + '%, cycles=' + cyclesCount + ')';
  } else {
    effect    = 'keep_review';
    scoreAdj  = 0;
    blockAuto = true;
    reason    = 'Signal ambigu — maintenir en review humaine';
  }

  return {
    signal:             e.signal,
    keep:               e.keep,
    reject:             e.reject,
    ignore:             e.ignore,
    total:              e.total,
    keep_rate:          keepRate,
    reject_rate:        rejectRate,
    cycles_count:       cyclesCount,
    sources:            Array.from(e.sources).sort(),
    verdict:            computeVerdict(e.keep, e.reject, e.total),
    promotion_ready:    cyclesCount >= 2 && keepRate >= 80 && e.total >= 3,
    recommended_effect: effect,
    score_adjustment:   scoreAdj,
    block_auto_notify:  blockAuto,
    reason:             reason,
  };
}

function computeVerdict(keep, reject, total) {
  if (!total) return 'Insuffisant';
  var kr = keep   / total;
  var rr = reject / total;
  if (kr >= 0.8 && total >= 2) return 'Tres fiable';
  if (kr >= 0.6 && total >= 2) return 'Fiable';
  if (rr >= 0.8 && total >= 2) return 'Risque';
  if (total === 1)              return 'Insuffisant';
  return 'Ambigu';
}

// ─── 4. Construction du JSON hints ───────────────────────────────────────────

function buildHints(loaded) {
  var byClient = aggregate(loaded.records, loaded.rawRecords);

  var clients = Object.keys(byClient).sort().map(function(clientName) {
    var sigMap  = byClient[clientName];
    var signals = Object.keys(sigMap).sort().map(function(sig) {
      return computeHint(sigMap[sig]);
    });
    return {
      client:  clientName,
      signals: signals,
    };
  });

  return {
    generated_at:   new Date().toISOString(),
    source:         'review-decisions',
    files_read:     loaded.files.length,
    raw_total:      loaded.rawTotal,
    dedup_total:    loaded.records.length,
    clients:        clients,
  };
}

// ─── 5. Écriture ──────────────────────────────────────────────────────────────

var loaded = loadDecisions();
var hints  = buildHints(loaded);

if (DRY_RUN) {
  console.log('[--dry-run] Aperçu JSON (non écrit) :');
  console.log(JSON.stringify(hints, null, 2));
} else {
  // Créer le dossier data/client-learning si absent
  if (!fs.existsSync(HINTS_DIR)) {
    fs.mkdirSync(HINTS_DIR, { recursive: true });
    console.log('[INFO] Dossier créé : ' + HINTS_DIR);
  }

  fs.writeFileSync(HINTS_FILE, JSON.stringify(hints, null, 2), 'utf8');
  console.log('[OK] Hints écrits : ' + HINTS_FILE);

  // Résumé
  console.log('     fichiers lus   : ' + hints.files_read);
  console.log('     décisions brutes : ' + hints.raw_total);
  console.log('     dédupliquées   : ' + hints.dedup_total);
  console.log('     clients        : ' + hints.clients.length);

  hints.clients.forEach(function(c) {
    console.log('  Client : ' + c.client);
    c.signals.forEach(function(s) {
      console.log(
        '    ' + String(s.signal).padEnd(28) +
        ' effect=' + String(s.recommended_effect).padEnd(16) +
        ' adj=' + (s.score_adjustment >= 0 ? '+' : '') + s.score_adjustment +
        ' cyc=' + s.cycles_count +
        ' [' + s.verdict + ']'
      );
    });
  });
}
