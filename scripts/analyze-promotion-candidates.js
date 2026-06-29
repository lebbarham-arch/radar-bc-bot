'use strict';
/**
 * analyze-promotion-candidates.js
 * Analyse les décisions humaines de review et classe les signaux en tiers
 * de confiance pour guider le renforcement shadow.
 *
 * Read-only :
 *   - Ne modifie aucun fichier
 *   - Ne touche pas au matching legacy ni aux notifications
 *   - Ne recommande jamais une activation production directe
 *
 * Usage :
 *   node scripts/analyze-promotion-candidates.js
 */

var fs   = require('fs');
var path = require('path');
var normalizeLearningKey = require('./learning-key-utils').normalizeLearningKey;

// ── Configuration ─────────────────────────────────────────────────────────────

var DECISIONS_DIR = path.join(__dirname, '..', 'data', 'review-decisions');

// ── Normalisation (GD-109 : via learning-key-utils) ──────────────────────────

function normSignal(s) {
  return normalizeLearningKey(s);
}

function signalKey(signals) {
  return (signals || []).map(normSignal).sort().join('|');
}

function dedupeKey(r) {
  return [
    String(r.client  || '').trim(),
    String(r.bc_id   || '').trim(),
    signalKey(r.matched_signals),
  ].join('::');
}

// ── Lecture + déduplication last-wins ────────────────────────────────────────

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
  var rawAll     = [];
  var map        = {};   // key → record (last-wins)

  files.forEach(function(fname) {
    var fpath = path.join(DECISIONS_DIR, fname);
    try {
      var records = JSON.parse(fs.readFileSync(fpath, 'utf8')).records || [];
      rawTotal += records.length;
      records.forEach(function(r) {
        r._source_file = fname;
        rawAll.push(r);
        map[dedupeKey(r)] = r;
      });
    } catch (e) {
      console.warn('[WARN] ' + fname + ' ignoré : ' + e.message);
    }
  });

  return {
    files:      files,
    rawTotal:   rawTotal,
    records:    Object.values(map),
    rawRecords: rawAll,
  };
}

// ── Agrégation par signal ─────────────────────────────────────────────────────

function aggregateBySignal(records, rawRecords) {
  var map = {};

  // Phase 1 : stats keep/reject/ignore et excerpts depuis records dédupliqués
  records.forEach(function(r) {
    var normSeen = {};
    (r.matched_signals || []).forEach(function(s) {
      var n = normSignal(s);
      if (normSeen[n]) return;
      normSeen[n] = true;

      if (!map[n]) {
        map[n] = {
          signal:   n,
          keep:     0,
          reject:   0,
          ignore:   0,
          cycles:   new Set(),   // cycle_id distincts (preuves indépendantes)
          sources:  new Set(),   // review_source distincts (operator / client / system)
          rejectExcerpts: [],
          ignoreExcerpts: [],
          keepExcerpts:   [],
        };
      }
      var entry = map[n];
      entry[r.decision]++;
      var ex = (r.clean_text_excerpt || '').slice(0, 100);
      if (r.decision === 'reject' && entry.rejectExcerpts.length < 3) entry.rejectExcerpts.push(ex);
      if (r.decision === 'ignore' && entry.ignoreExcerpts.length < 2) entry.ignoreExcerpts.push(ex);
      if (r.decision === 'keep'   && entry.keepExcerpts.length   < 1) entry.keepExcerpts.push(ex);
    });
  });

  // Phase 2 : cycles et sources depuis tous les records bruts (avant dedup)
  (rawRecords || records).forEach(function(r) {
    var normSeen = {};
    (r.matched_signals || []).forEach(function(s) {
      var n = normSignal(s);
      if (normSeen[n] || !map[n]) return;
      normSeen[n] = true;

      var entry = map[n];
      // cycle_id : null pour anciens records → ne pas incrémenter le compteur cycles
      if (r.cycle_id)  entry.cycles.add(r.cycle_id);
      // review_source : anciens records sans champ → traités comme operator
      entry.sources.add(r.review_source || 'operator');
    });
  });

  return Object.values(map);
}

// ── Promotion ready ───────────────────────────────────────────────────────────
//
// Un signal ne peut être promu que s'il a été observé sur au moins 2 cycles
// de review distincts (preuves indépendantes).
// Un cycle = un batch de review candidates issu d'un scan shadow distinct.
// Les anciens records sans cycle_id contribuent aux stats mais pas au compteur cycles.
function isPromotionReady(sig) {
  return !!(sig.cycles && sig.cycles.size >= 2);
}

// ── Classification ────────────────────────────────────────────────────────────
//
//  Très fiable   : total >= 3, reject=0, ignore=0, keep_rate >= 90%
//  Fiable/garde  : total >= 5, keep_rate >= 75%, reject > 0
//  Ambigu        : keep_rate entre 40% et 75% OU ignore > 0
//  Risqué        : reject > keep OU keep_rate < 40%
//  En attente    : total < 3 et les autres critères ne s'appliquent pas encore

function classify(sig) {
  var total    = sig.keep + sig.reject + sig.ignore;
  var keepRate = total > 0 ? sig.keep / total : 0;

  if (total === 0)                                                  return 'en_attente';
  if (sig.reject === 0 && sig.ignore === 0
      && total >= 3 && keepRate >= 0.90)                           return 'tres_fiable';
  if (total >= 5 && keepRate >= 0.75 && sig.reject > 0)           return 'fiable_garde';
  if (sig.reject > sig.keep || keepRate < 0.40)                   return 'risque';
  if (sig.ignore > 0 || (keepRate >= 0.40 && keepRate < 0.75))    return 'ambigu';
  if (total < 3 && sig.reject === 0 && sig.ignore === 0
      && keepRate >= 0.90)                                         return 'en_attente';
  return 'en_attente';
}

// ── Formatage ─────────────────────────────────────────────────────────────────

function pct(n, d) {
  if (!d) return '  — ';
  return String(Math.round(100 * n / d)).padStart(3) + '%';
}

function pad(s, n, left) {
  s = String(s || '');
  if (s.length > n) s = s.slice(0, n - 1) + '…';
  return left ? s.padEnd(n) : s.padStart(n);
}

function hr(c, n) { return (c || '─').repeat(n || 60); }

function printSig(sig) {
  var total      = sig.keep + sig.reject + sig.ignore;
  var cyclesSz   = sig.cycles ? sig.cycles.size : 0;
  var cyclesStr  = '  cycles=' + cyclesSz;
  var sourcesArr = sig.sources ? Array.from(sig.sources).sort() : [];
  var sourcesStr = sourcesArr.length ? '  sources=' + sourcesArr.join('/') : '';
  var readyStr   = isPromotionReady(sig) ? '' : '  [bloqué: cycles insuffisants]';
  console.log(
    '  ' + pad(sig.signal, 30, true) +
    '  keep=' + sig.keep +
    '  rej=' + sig.reject +
    '  ign=' + sig.ignore +
    '  total=' + total +
    '  (' + pct(sig.keep, total).trim() + ' keep)' +
    cyclesStr +
    sourcesStr +
    readyStr
  );
}

function printExcerpts(label, arr) {
  arr.forEach(function(ex) {
    console.log('      [' + label + '] ' + ex);
  });
}

// ── Rapport principal ─────────────────────────────────────────────────────────

var loaded  = loadAndDedup();
var signals = aggregateBySignal(loaded.records, loaded.rawRecords);

var totalKeep   = loaded.records.filter(function(r) { return r.decision === 'keep';   }).length;
var totalReject = loaded.records.filter(function(r) { return r.decision === 'reject'; }).length;
var totalIgnore = loaded.records.filter(function(r) { return r.decision === 'ignore'; }).length;

var groups = {
  tres_fiable:  [],
  fiable_garde: [],
  ambigu:       [],
  risque:       [],
  en_attente:   [],
};
signals.forEach(function(s) { groups[classify(s)].push(s); });

// ── Affichage ─────────────────────────────────────────────────────────────────

console.log('');
console.log('╔' + hr('═', 62) + '╗');
console.log('║   Candidats à renforcer en shadow — radar-bc-bot        ║');
console.log('╚' + hr('═', 62) + '╝');

// 1. Résumé global
console.log('');
console.log(hr('─', 63));
console.log('  1. Résumé global');
console.log(hr('─', 63));
console.log('  Fichiers lus         : ' + loaded.files.length);
console.log('  Entrées brutes       : ' + loaded.rawTotal);
console.log('  Entrées dédupliquées : ' + loaded.records.length + '  (last-wins)');
console.log('  keep=' + totalKeep + '  reject=' + totalReject + '  ignore=' + totalIgnore);
console.log('  Signaux distincts    : ' + signals.length);
console.log('');
console.log('  Répartition par tiers :');
console.log('    Très fiable     : ' + groups.tres_fiable.length + ' signal(s)');
console.log('    Fiable + garde  : ' + groups.fiable_garde.length + ' signal(s)');
console.log('    Ambigu          : ' + groups.ambigu.length + ' signal(s)');
console.log('    Risqué          : ' + groups.risque.length + ' signal(s)');
console.log('    En attente      : ' + groups.en_attente.length + ' signal(s)  (données insuffisantes)');

// 2. Candidats à renforcer (très fiables)
console.log('');
console.log(hr('─', 63));
console.log('  2. Signaux très fiables — renforcement shadow prioritaire');
console.log(hr('─', 63));
console.log('  Critère : total >= 3, reject=0, ignore=0, keep_rate >= 90%');
console.log('  Action  : score inclusion +10 déjà appliqué (GD-023)');
console.log('            continuer la revue humaine, ne pas activer en production');
console.log('');
if (groups.tres_fiable.length === 0) {
  console.log('  (aucun signal dans ce tier)');
} else {
  groups.tres_fiable.sort(function(a, b) { return b.keep - a.keep; }).forEach(function(sig) {
    printSig(sig);
    if (sig.keepExcerpts.length) printExcerpts('keep', sig.keepExcerpts);
  });
}

// 3. Fiables avec garde
console.log('');
console.log(hr('─', 63));
console.log('  3. Signaux fiables avec garde — renforcement conditionnel');
console.log(hr('─', 63));
console.log('  Critère : total >= 5, keep_rate >= 75%, reject > 0');
console.log('  Action  : maintenir les guards existants, renforcer en shadow');
console.log('            ne pas promouvoir directement sans guard confirmé');
console.log('');
if (groups.fiable_garde.length === 0) {
  console.log('  (aucun signal dans ce tier)');
} else {
  groups.fiable_garde.sort(function(a, b) { return b.keep - a.keep; }).forEach(function(sig) {
    printSig(sig);
    if (sig.keepExcerpts.length) printExcerpts('keep', sig.keepExcerpts);
    if (sig.rejectExcerpts.length) {
      console.log('      → Exemples de rejets (patterns à couvrir par garde) :');
      printExcerpts('rej', sig.rejectExcerpts);
    }
  });
}

// Note spéciale produits alimentaires
if (groups.fiable_garde.some(function(s) { return s.signal === 'produits alimentaires'; })) {
  console.log('');
  console.log('  ⚠  Note "produits alimentaires" :');
  console.log('     Les 2 rejets correspondent à des contextes laboratoire/ONSSA :');
  console.log('       - dosage / analyse / bisulfites / crustacées → contrôle qualité alimentaire');
  console.log('       - impression diffusion ONSSA → communication institutionnelle');
  console.log('     Ces patterns sont couverts par le guard existant (FOOD_PURCHASE list).');
  console.log('     Renforcement shadow OK, mais ne pas activer sans vérification du guard.');
}

// 4. Ambigus
console.log('');
console.log(hr('─', 63));
console.log('  4. Signaux ambigus — continuer la revue humaine');
console.log(hr('─', 63));
console.log('  Critère : keep_rate entre 40% et 75%, ou ignore > 0');
console.log('  Action  : accumuler plus de données avant toute décision');
console.log('');
if (groups.ambigu.length === 0) {
  console.log('  (aucun signal dans ce tier)');
} else {
  groups.ambigu.sort(function(a, b) {
    var ta = a.keep + a.reject + a.ignore;
    var tb = b.keep + b.reject + b.ignore;
    return tb - ta;
  }).forEach(function(sig) {
    printSig(sig);
    if (sig.rejectExcerpts.length) printExcerpts('rej', sig.rejectExcerpts);
    if (sig.ignoreExcerpts.length) printExcerpts('ign', sig.ignoreExcerpts);
  });
}

// 5. Risqués
console.log('');
console.log(hr('─', 63));
console.log('  5. Signaux risqués — ne pas renforcer');
console.log(hr('─', 63));
console.log('  Critère : reject > keep, ou keep_rate < 40%');
console.log('  Action  : maintenir les guards existants (ou en ajouter)');
console.log('            ne pas modifier le scoring clean pour ces signaux');
console.log('');
if (groups.risque.length === 0) {
  console.log('  (aucun signal dans ce tier)');
} else {
  groups.risque.sort(function(a, b) { return a.keep - b.keep; }).forEach(function(sig) {
    printSig(sig);
    if (sig.rejectExcerpts.length) printExcerpts('rej', sig.rejectExcerpts);
    if (sig.ignoreExcerpts.length) printExcerpts('ign', sig.ignoreExcerpts);
  });
}

// 6. En attente
console.log('');
console.log(hr('─', 63));
console.log('  6. Signaux en attente — données insuffisantes (total < 3)');
console.log(hr('─', 63));
console.log('  Action  : accumuler plus de passages en review avant de classer');
console.log('');
if (groups.en_attente.length === 0) {
  console.log('  (aucun signal dans ce tier)');
} else {
  groups.en_attente.sort(function(a, b) { return b.keep - a.keep; }).forEach(function(sig) {
    printSig(sig);
  });
}

// 7. Recommandations
console.log('');
console.log(hr('─', 63));
console.log('  7. Recommandations prudentes');
console.log(hr('─', 63));

var fiables = groups.tres_fiable;
if (fiables.length) {
  console.log('');
  console.log('  [Shadow - OK] Renforcement score +10 déjà appliqué (GD-023) pour :');
  fiables.forEach(function(s) {
    var ready  = isPromotionReady(s);
    var cycles = s.cycles ? s.cycles.size : 0;
    var suffix = ready
      ? '  ✓ promotion_ready (cycles=' + cycles + ')'
      : '  ⚠ bloqué : cycles insuffisants (' + cycles + '/2 requis)';
    console.log('    • ' + s.signal + suffix);
  });
  console.log('  → Ces signaux peuvent être promus en auto_candidate si score >= 15');
  console.log('    (ex : deux trusted inclusions matchant simultanément).');
  console.log('  → Ne pas activer clean en production sans validation de plusieurs cycles.');
}

if (groups.fiable_garde.length) {
  console.log('');
  console.log('  [Shadow - Conditionnel] Signaux fiables avec garde :');
  groups.fiable_garde.forEach(function(s) { console.log('    • ' + s.signal); });
  console.log('  → Maintenir les guards existants dans _shadowContextGuardBlocked.');
  console.log('  → Renforcer shadow uniquement si les rejets connus sont tous couverts.');
  console.log('  → Ne pas modifier le legacy ni les notifications.');
}

if (groups.ambigu.length) {
  console.log('');
  console.log('  [En observation] Signaux ambigus :');
  groups.ambigu.forEach(function(s) { console.log('    • ' + s.signal); });
  console.log('  → Continuer la revue humaine sur plusieurs cycles de scan.');
  console.log('  → Identifier les patterns récurrents avant d\'envisager un guard.');
}

if (groups.risque.length) {
  console.log('');
  console.log('  [Ne pas renforcer] Signaux risqués :');
  groups.risque.forEach(function(s) { console.log('    • ' + s.signal); });
  console.log('  → Guards existants à maintenir tels quels.');
  console.log('  → Aucune modification de score envisagée.');
}

console.log('');
console.log(hr('─', 63));
console.log('  Rappel : ce rapport est consultatif, read-only, shadow uniquement.');
console.log('  Aucune activation production ne doit être déclenchée depuis ce script.');
console.log(hr('─', 63));
console.log('');
