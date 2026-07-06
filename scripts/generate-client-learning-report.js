#!/usr/bin/env node
// scripts/generate-client-learning-report.js
// GD-139 -- Rapport local lisible du learning client (Markdown).
//
// Lit :
//   data/review-decisions/*.json          -> decisions par signal
//   data/client-learning/client-learning-hints.json -> hints actifs
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

var ROOT          = path.join(__dirname, '..');
var DECISIONS_DIR = path.join(ROOT, 'data', 'review-decisions');
var HINTS_FILE    = path.join(ROOT, 'data', 'client-learning', 'client-learning-hints.json');

// ---------------------------------------------------------------------------
// loadReviewDecisions -- lit tous les fichiers review-decisions/*.json
// Retourne un tableau plat de records { client, signal, decision }
// Ignore les fichiers JSON corrompus sans exception.
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
// aggregateClientSignals -- agrege keep/reject/ignore par signal pour un client
// Retourne un objet { signal -> { keep, reject, ignore, total } }
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
  var total  = sigStats ? sigStats.total : 0;
  var keep   = sigStats ? sigStats.keep  : 0;

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
    if (keep > 0 && total > 0) {
      return 'Signal positif mais non promotable — continuer la revue manuelle pour consolider les cycles.';
    }
    return 'Signal maintenu en revue — pas de promotion automatique recommandee.';
  }
  return 'Effet inconnu — revue manuelle conseilee.';
}

// ---------------------------------------------------------------------------
// formatSignalRow -- ligne de tableau Markdown pour un signal
// ---------------------------------------------------------------------------

function formatSignalRow(signal, sigStats, hintSignal) {
  var k = sigStats ? sigStats.keep   : 0;
  var r = sigStats ? sigStats.reject : 0;
  var ig = sigStats ? sigStats.ignore : 0;
  var t  = sigStats ? sigStats.total  : 0;
  var effect  = hintSignal ? (hintSignal.recommended_effect || '-') : '-';
  var adj     = hintSignal && hintSignal.score_adjustment ? hintSignal.score_adjustment : 0;
  var adjStr  = adj !== 0 ? String(adj) : '-';
  var cycles  = hintSignal ? (hintSignal.cycles_count || 0) : 0;
  var sources = hintSignal && Array.isArray(hintSignal.sources)
    ? hintSignal.sources.join('+')
    : '-';

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
//   clientIdOrName : string
//   signalAgg      : objet { signal -> { keep, reject, ignore, total } }
//   clientHintEntry: entree hints du client (ou null)
//   opts.generatedAt : string ISO
//   opts.noNewFeedback : bool (si vrai, section avertissement)
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

  // Union de tous les signaux (decisions + hints)
  var allSignals = new Set(Object.keys(signalAgg).concat(Object.keys(hintSignals)));
  var signalList = Array.from(allSignals).sort();

  var lines = [];

  lines.push('# Rapport Learning Client');
  lines.push('');
  lines.push('**Client :** `' + clientIdOrName + '`  ');
  lines.push('**Genere le :** ' + generatedAt);
  lines.push('');

  // Avertissement si aucun feedback recent
  if (options.noNewFeedback) {
    lines.push('> ⚠️ Ce rapport est base sur les donnees existantes — aucun nouveau feedback dans ce cycle.');
    lines.push('');
  }

  // Hint actif
  if (clientHintEntry) {
    lines.push('## Hint actif');
    lines.push('');
    lines.push('Hint present dans `client-learning-hints.json` : **' + clientHintEntry.signals.length + ' signal(s)** configure(s).');
    lines.push('');
  } else {
    lines.push('## Hint actif');
    lines.push('');
    lines.push('_Aucun hint configure pour ce client._');
    lines.push('');
  }

  // Tableau des signaux
  lines.push('## Signaux et decisions');
  lines.push('');
  lines.push('| Signal | K | R | I | Total | Cycles | Sources | Effet | Adj |');
  lines.push('|--------|---|---|---|-------|--------|---------|-------|-----|');

  if (signalList.length === 0) {
    lines.push('| _(aucun signal)_ | — | — | — | — | — | — | — | — |');
  } else {
    signalList.forEach(function(sig) {
      var stats    = signalAgg[sig]  || null;
      var hintSig  = hintSignals[sig] || null;
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
      var stats    = signalAgg[sig]  || null;
      var hintSig  = hintSignals[sig] || null;
      var reco     = generateSignalRecommendation(stats, hintSig);
      lines.push('**' + sig + '** : ' + reco);
      lines.push('');
    });
  }

  // Prochaine action
  lines.push('## Prochaine action');
  lines.push('');
  var hasBlock = clientHintEntry && clientHintEntry.signals.some(function(s) {
    return s.block_auto_notify;
  });
  var hasDemote = clientHintEntry && clientHintEntry.signals.some(function(s) {
    return s.recommended_effect === 'demote_to_review';
  });
  var hasBoost = clientHintEntry && clientHintEntry.signals.some(function(s) {
    return s.recommended_effect === 'boost';
  });

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
// runReport -- point d'entree principal (pur, testable)
// ---------------------------------------------------------------------------

function runReport(clientIdOrName, decisionsDir, hintsFile, opts) {
  var options = opts || {};

  var records       = loadReviewDecisions(decisionsDir);
  var signalAgg     = aggregateClientSignals(records, clientIdOrName);
  var hintsData     = loadHintsData(hintsFile);
  var clientHint    = lookupClientHint(hintsData, clientIdOrName);
  var allSignals    = Object.keys(signalAgg).concat(
    clientHint ? clientHint.signals.map(function(s) { return s.signal; }) : []
  );

  if (allSignals.length === 0 && !clientHint) {
    return {
      ok:      false,
      error:   'Client introuvable : aucune decision ni hint pour "' + clientIdOrName + '"',
      report:  null,
    };
  }

  var report = generateReport(clientIdOrName, signalAgg, clientHint, options);
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
  loadReviewDecisions:       loadReviewDecisions,
  matchesClient:             matchesClient,
  aggregateClientSignals:    aggregateClientSignals,
  loadHintsData:             loadHintsData,
  lookupClientHint:          lookupClientHint,
  generateSignalRecommendation: generateSignalRecommendation,
  formatSignalRow:           formatSignalRow,
  generateReport:            generateReport,
  runReport:                 runReport,
};
