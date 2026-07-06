#!/usr/bin/env node
// scripts/generate-client-learning-report.js
// GD-139 / GD-140 -- Rapport local lisible du learning client (Markdown).
//
// Lit :
//   data/review-decisions/*.json          -> decisions par signal (dédupliquées client::bc_id)
//   data/client-learning/client-learning-hints.json -> hints actifs
//
// DEDUPLICATION (identique a analyze-client-learning.js) :
//   - Clé : client::bc_id
//   - Ordre : fichiers tries alphabetiquement, dernière version gagne (last-wins)
//   - Stats keep/reject/ignore/total : calculées depuis records dédupliqués
//   - Cycles + sources : calculés depuis rawRecords (avant dedup)
//
// Usage :
//   node scripts/generate-client-learning-report.js --client-id <uuid|nom>
//   node scripts/generate-client-learning-report.js --client-id <uuid|nom> --output data/reports/client-report.md
//
// SECURITE :
//   Ne modifie pas radar-bc-bot.js, le moteur, les profils, Fly.
//   Lecture seule sur les donnees existantes.
//   Generique multi-clients, aucune regle metier codee en dur.

'use strict';

var fs   = require('fs');
var path = require('path');
var normalizeLearningKey = require('./learning-key-utils').normalizeLearningKey;

var ROOT          = path.join(__dirname, '..');
var DECISIONS_DIR = path.join(ROOT, 'data', 'review-decisions');
var HINTS_FILE    = path.join(ROOT, 'data', 'client-learning', 'client-learning-hints.json');

// ---------------------------------------------------------------------------
// loadAndDedup -- lecture + déduplication last-wins (même logique que
//   analyze-client-learning.js)
//
// Clé de dédup : client::bc_id
// Fichiers lus dans l'ordre alphabétique, la dernière version gagne.
// Retourne { records, rawRecords, filesRead, rawTotal, dedupTotal }
// ---------------------------------------------------------------------------

function loadAndDedup(decisionsDir) {
  var dir = decisionsDir || DECISIONS_DIR;
  var rawRecords = [];
  var map        = {};   // client::bc_id -> record (last-wins)
  var files      = [];
  var rawTotal   = 0;

  try {
    files = fs.readdirSync(dir)
      .filter(function(f) { return /^review-decisions-.*\.json$/.test(f); })
      .sort();
  } catch (_) {
    return { records: [], rawRecords: [], filesRead: 0, rawTotal: 0, dedupTotal: 0 };
  }

  files.forEach(function(fname) {
    var fpath = path.join(dir, fname);
    try {
      var data    = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      var records = data.records || [];
      rawTotal += records.length;
      records.forEach(function(r) {
        rawRecords.push(r);
        var key = String(r.client || '') + '::' + String(r.bc_id || '');
        map[key] = r;
      });
    } catch (_) {}
  });

  var records = Object.values(map);

  return {
    records:    records,
    rawRecords: rawRecords,
    filesRead:  files.length,
    rawTotal:   rawTotal,
    dedupTotal: records.length,
  };
}

// ---------------------------------------------------------------------------
// matchesClient -- verifie si un record appartient au client demande
// Accepte UUID exact OU nom exact (insensible a la casse).
// ---------------------------------------------------------------------------

function matchesClient(recordClient, clientIdOrName) {
  if (!recordClient || !clientIdOrName) return false;
  if (recordClient === clientIdOrName) return true;
  if (recordClient.toLowerCase() === clientIdOrName.toLowerCase()) return true;
  return false;
}

// ---------------------------------------------------------------------------
// aggregateClientSignalsDedup -- agrege keep/reject/ignore par signal
//   Phase 1 : stats depuis records dédupliqués (last-wins)
//   Phase 2 : cycles + sources depuis rawRecords
//
// Retourne un objet { signal -> { keep, reject, ignore, total, cycles_count, sources } }
// Utilise normalizeLearningKey pour les clés de signal (cohérent avec analyze-client-learning.js)
// ---------------------------------------------------------------------------

function aggregateClientSignalsDedup(dedupRecords, rawRecords, clientIdOrName) {
  var sigMap = {};   // normalized key -> { keep, reject, ignore, total, label, cyclesSet, sourcesSet }

  // Phase 1 : stats depuis records dédupliqués
  dedupRecords.forEach(function(r) {
    if (!matchesClient(r.client, clientIdOrName)) return;
    var signals = r.matched_signals;
    if (!Array.isArray(signals)) return;
    signals.forEach(function(s) {
      var raw = String(s || '').trim();
      if (!raw) return;
      var sk = normalizeLearningKey(raw) || raw;
      if (!sigMap[sk]) {
        sigMap[sk] = {
          keep: 0, reject: 0, ignore: 0, total: 0,
          label:       raw,
          cyclesSet:   new Set(),
          sourcesSet:  new Set(),
        };
      }
      var e   = sigMap[sk];
      var dec = r.decision || '';
      if (dec === 'keep')   e.keep++;
      if (dec === 'reject') e.reject++;
      if (dec === 'ignore') e.ignore++;
      e.total++;
    });
  });

  // Phase 2 : cycles + sources depuis rawRecords (avant dedup)
  var raw = rawRecords || dedupRecords;
  raw.forEach(function(r) {
    if (!matchesClient(r.client, clientIdOrName)) return;
    var signals = r.matched_signals;
    if (!Array.isArray(signals)) return;
    signals.forEach(function(s) {
      var rawSig = String(s || '').trim();
      if (!rawSig) return;
      var sk = normalizeLearningKey(rawSig) || rawSig;
      if (!sigMap[sk]) return;   // signal pas dans dedup records -> ignore
      var e = sigMap[sk];
      if (r.cycle_id) e.cyclesSet.add(r.cycle_id);
      e.sourcesSet.add(r.review_source || 'operator');
    });
  });

  // Finaliser : convertir Set -> comptes + tableaux
  var result = {};
  Object.keys(sigMap).forEach(function(sk) {
    var e = sigMap[sk];
    result[sk] = {
      keep:         e.keep,
      reject:       e.reject,
      ignore:       e.ignore,
      total:        e.total,
      label:        e.label,
      cycles_count: e.cyclesSet.size,
      sources:      Array.from(e.sourcesSet).sort(),
    };
  });
  return result;
}

// ---------------------------------------------------------------------------
// aggregateClientSignals -- version simple (sans dedup, conservée pour
//   compatibilité avec les tests unitaires existants qui passent des records
//   plats {client, signal, decision}).
// ---------------------------------------------------------------------------

function aggregateClientSignals(records, clientIdOrName) {
  var agg = {};
  records.forEach(function(rec) {
    if (!matchesClient(rec.client, clientIdOrName)) return;
    var sig = rec.signal;
    if (!sig) return;
    if (!agg[sig]) {
      agg[sig] = { keep: 0, reject: 0, ignore: 0, total: 0 };
    }
    var d = rec.decision;
    if (d === 'keep')   agg[sig].keep++;
    if (d === 'reject') agg[sig].reject++;
    if (d === 'ignore') agg[sig].ignore++;
    agg[sig].total++;
  });
  return agg;
}

// ---------------------------------------------------------------------------
// loadReviewDecisions -- version simple (lecture seule, sans dedup)
// Conservée pour compatibilité avec les tests unitaires existants.
// Retourne un tableau plat de records { client, signal, decision }.
// Pour la production, utiliser loadAndDedup() + aggregateClientSignalsDedup().
// ---------------------------------------------------------------------------

function loadReviewDecisions(decisionsDir) {
  var records = [];
  var dir = decisionsDir || DECISIONS_DIR;
  try {
    var files = fs.readdirSync(dir).filter(function(f) {
      return /^review-decisions-.*\.json$/.test(f);
    });
    files.forEach(function(fname) {
      var fpath = path.join(dir, fname);
      try {
        var d = JSON.parse(fs.readFileSync(fpath, 'utf8'));
        var recs = d.records || [];
        recs.forEach(function(rec) {
          var signals = rec.matched_signals;
          if (!Array.isArray(signals)) return;
          signals.forEach(function(sig) {
            if (typeof sig !== 'string') return;
            records.push({
              client:   rec.client   || '',
              signal:   sig.trim(),
              decision: rec.decision || '',
            });
          });
        });
      } catch (_) {}
    });
  } catch (_) {}
  return records;
}

// ---------------------------------------------------------------------------
// loadHintsData -- charge client-learning-hints.json
// ---------------------------------------------------------------------------

function loadHintsData(hintsFile) {
  var fpath = hintsFile || HINTS_FILE;
  try {
    return JSON.parse(fs.readFileSync(fpath, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// lookupClientHint -- trouve l'entree client dans hintsData
// Accepte UUID ou nom exact (insensible a la casse).
// ---------------------------------------------------------------------------

function lookupClientHint(hintsData, clientIdOrName) {
  if (!hintsData || !clientIdOrName) return null;
  var clients = hintsData.clients || [];
  for (var i = 0; i < clients.length; i++) {
    var entry = clients[i];
    if (!entry.client) continue;
    if (entry.client === clientIdOrName) return entry;
    if (entry.client.toLowerCase() === clientIdOrName.toLowerCase()) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// generateSignalRecommendation -- recommandation sobre selon stats + effect
// Regle purement numerique, aucun metier code en dur.
// ---------------------------------------------------------------------------

function generateSignalRecommendation(sigStats, hintSignal) {
  var effect = hintSignal ? hintSignal.recommended_effect : null;

  if (!effect || effect === 'insufficient_data') {
    return 'Donnees insuffisantes — collecter davantage de feedbacks avant de tirer des conclusions.';
  }
  if (effect === 'demote_to_review') {
    return 'Signal penalise — maintenir en revue manuelle, ne pas notifier automatiquement, continuer a collecter des feedbacks.';
  }
  if (effect === 'boost') {
    return 'Signal valorise — eligible a la remontee de score. Valider en contexte operateur avant de promouvoir.';
  }
  if (effect === 'keep_review') {
    return 'Signal maintenu en revue — pas de promotion automatique recommandee.';
  }
  return 'Effet inconnu — revue manuelle conseillee.';
}

// ---------------------------------------------------------------------------
// formatSignalRow -- ligne de tableau Markdown pour un signal
// sigStats peut venir de aggregateClientSignalsDedup (avec cycles_count, sources[])
//   ou de aggregateClientSignals (compatibilite tests).
// ---------------------------------------------------------------------------

function formatSignalRow(signal, sigStats, hintSignal) {
  var k   = sigStats ? sigStats.keep   : 0;
  var r   = sigStats ? sigStats.reject : 0;
  var ig  = sigStats ? sigStats.ignore : 0;
  var t   = sigStats ? sigStats.total  : 0;
  var effect = hintSignal ? (hintSignal.recommended_effect || '-') : '-';
  var adj    = hintSignal && hintSignal.score_adjustment ? hintSignal.score_adjustment : 0;
  var adjStr = adj !== 0 ? String(adj) : '-';

  // Cycles : priorite stats (from dedup agg), fallback hint
  var cycles;
  if (sigStats && sigStats.cycles_count != null) {
    cycles = sigStats.cycles_count;
  } else if (hintSignal && hintSignal.cycles_count) {
    cycles = hintSignal.cycles_count;
  } else {
    cycles = 0;
  }

  // Sources : priorite stats (from dedup agg), fallback hint
  var sources;
  if (sigStats && Array.isArray(sigStats.sources) && sigStats.sources.length > 0) {
    sources = sigStats.sources.join('+');
  } else if (hintSignal && Array.isArray(hintSignal.sources) && hintSignal.sources.length > 0) {
    sources = hintSignal.sources.join('+');
  } else {
    sources = '-';
  }

  return '| ' + [
    signal,
    String(k),
    String(r),
    String(ig),
    String(t),
    String(cycles),
    sources,
    effect,
    adjStr,
  ].join(' | ') + ' |';
}

// ---------------------------------------------------------------------------
// generateReport -- produit le rapport Markdown complet
// Options :
//   clientIdOrName  : string
//   signalAgg       : objet { signal -> { keep, reject, ignore, total, ... } }
//   clientHintEntry : entree hints du client (ou null)
//   opts.generatedAt    : string ISO
//   opts.noNewFeedback  : bool
//   opts.dedupTotal     : int (nb records apres dedup)
//   opts.rawTotal       : int (nb records bruts)
// ---------------------------------------------------------------------------

function generateReport(clientIdOrName, signalAgg, clientHintEntry, opts) {
  var options      = opts || {};
  var generatedAt  = options.generatedAt || new Date().toISOString();
  var hintSignals  = {};

  if (clientHintEntry && Array.isArray(clientHintEntry.signals)) {
    clientHintEntry.signals.forEach(function(hs) {
      if (hs.signal) hintSignals[hs.signal] = hs;
    });
  }

  // Union de tous les signaux (decisions + hints), tries
  var allSignals = new Set(Object.keys(signalAgg).concat(Object.keys(hintSignals)));
  var signalList = Array.from(allSignals).sort();

  var lines = [];

  lines.push('# Rapport Learning Client');
  lines.push('');
  lines.push('**Client :** `' + clientIdOrName + '`  ');
  lines.push('**Genere le :** ' + generatedAt);

  // Transparence deduplication
  var rawTotal   = options.rawTotal   != null ? options.rawTotal   : null;
  var dedupTotal = options.dedupTotal != null ? options.dedupTotal : null;
  if (rawTotal != null && dedupTotal != null) {
    lines.push('**Decisions dedupl.:** ' + dedupTotal + ' / ' + rawTotal
      + ' (last-wins client::bc_id)');
  } else {
    lines.push('**Decisions dédupliquées :** oui (last-wins client::bc_id)');
  }
  lines.push('');

  // Avertissement si aucun feedback recent
  if (options.noNewFeedback) {
    lines.push('> Avertissement : Ce rapport est base sur les donnees existantes — aucun nouveau feedback dans ce cycle.');
    lines.push('');
  }

  // Hint actif
  lines.push('## Hint actif');
  lines.push('');
  if (clientHintEntry) {
    lines.push('Hint present dans `client-learning-hints.json` : **' + clientHintEntry.signals.length + ' signal(s)** configure(s).');
  } else {
    lines.push('_Aucun hint configure pour ce client._');
  }
  lines.push('');

  // Tableau des signaux
  lines.push('## Signaux et decisions');
  lines.push('');
  lines.push('| Signal | K | R | I | Total | Cycles | Sources | Effet | Adj |');
  lines.push('|--------|---|---|---|-------|--------|---------|-------|-----|');

  if (signalList.length === 0) {
    lines.push('| _(aucun signal)_ | — | — | — | — | — | — | — | — |');
  } else {
    signalList.forEach(function(sig) {
      var stats   = signalAgg[sig]  || null;
      var hintSig = hintSignals[sig] || null;
      lines.push(formatSignalRow(sig, stats, hintSig));
    });
  }

  lines.push('');
  lines.push('_K=keep R=reject I=ignore_');
  lines.push('');

  // Recommandations par signal
  if (signalList.length > 0) {
    lines.push('## Recommandations');
    lines.push('');
    signalList.forEach(function(sig) {
      var stats   = signalAgg[sig]  || null;
      var hintSig = hintSignals[sig] || null;
      var reco    = generateSignalRecommendation(stats, hintSig);
      lines.push('**' + sig + '** : ' + reco);
      lines.push('');
    });
  }

  // Prochaine action
  lines.push('## Prochaine action');
  lines.push('');
  var hasBlock  = clientHintEntry && clientHintEntry.signals.some(function(s) { return s.block_auto_notify; });
  var hasDemote = clientHintEntry && clientHintEntry.signals.some(function(s) { return s.recommended_effect === 'demote_to_review'; });
  var hasBoost  = clientHintEntry && clientHintEntry.signals.some(function(s) { return s.recommended_effect === 'boost'; });

  if (hasDemote || hasBlock) {
    lines.push('- Verifier manuellement les appels d\'offres passes en revue pour ce client.');
    lines.push('- Ne pas activer la notification automatique sur les signaux penalises.');
    lines.push('- Relancer un cycle feedback apres nouvelles decisions pour consolider le learning.');
  } else if (hasBoost) {
    lines.push('- Valider les signaux boostes en contexte metier avant toute promotion automatique.');
    lines.push('- Relancer un cycle feedback apres validation pour confirmer le signal.');
  } else {
    lines.push('- Collecter davantage de feedbacks pour atteindre le seuil de confiance (2 cycles minimum).');
    lines.push('- Relancer le cycle apres nouvelles decisions.');
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// runReport -- point d'entree principal (utilise la deduplication correcte)
// ---------------------------------------------------------------------------

function runReport(clientIdOrName, decisionsDir, hintsFile, opts) {
  var options = opts || {};

  var loaded       = loadAndDedup(decisionsDir);
  var signalAgg    = aggregateClientSignalsDedup(loaded.records, loaded.rawRecords, clientIdOrName);
  var hintsData    = loadHintsData(hintsFile);
  var clientHint   = lookupClientHint(hintsData, clientIdOrName);
  var allSignals   = Object.keys(signalAgg).concat(
    clientHint ? clientHint.signals.map(function(s) { return s.signal; }) : []
  );

  if (allSignals.length === 0 && !clientHint) {
    return {
      ok:     false,
      error:  'Client introuvable : aucune decision ni hint pour "' + clientIdOrName + '"',
      report: null,
    };
  }

  var report = generateReport(clientIdOrName, signalAgg, clientHint, {
    generatedAt:   options.generatedAt || new Date().toISOString(),
    noNewFeedback: options.noNewFeedback || false,
    rawTotal:      loaded.rawTotal,
    dedupTotal:    loaded.dedupTotal,
  });
  return { ok: true, error: null, report: report };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  var argv       = process.argv.slice(2);
  var clientId   = null;
  var outputPath = null;

  for (var i = 0; i < argv.length; i++) {
    if (argv[i] === '--client-id' && argv[i + 1]) {
      clientId = argv[++i];
    } else if (argv[i] === '--output' && argv[i + 1]) {
      outputPath = argv[++i];
    }
  }

  if (!clientId) {
    console.error('[GD-139] Argument manquant : --client-id <uuid|nom>');
    console.error('Usage : node scripts/generate-client-learning-report.js --client-id <uuid|nom> [--output <path>]');
    process.exit(1);
  }

  var result = runReport(clientId, DECISIONS_DIR, HINTS_FILE, {
    generatedAt: new Date().toISOString(),
  });

  if (!result.ok) {
    console.error('[GD-139] ERREUR : ' + result.error);
    process.exit(1);
  }

  if (outputPath) {
    var dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, result.report, 'utf8');
    console.log('[GD-139] Rapport ecrit : ' + outputPath);
  } else {
    process.stdout.write(result.report);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Fonctions de production (avec dedup -- GD-140)
  loadAndDedup:                 loadAndDedup,
  aggregateClientSignalsDedup:  aggregateClientSignalsDedup,
  // Fonctions utilitaires pures
  matchesClient:                matchesClient,
  lookupClientHint:             lookupClientHint,
  generateSignalRecommendation: generateSignalRecommendation,
  formatSignalRow:              formatSignalRow,
  generateReport:               generateReport,
  runReport:                    runReport,
  // Compat backwards (tests existants)
  loadReviewDecisions:          loadReviewDecisions,
  aggregateClientSignals:       aggregateClientSignals,
};
