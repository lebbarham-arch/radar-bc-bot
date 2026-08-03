'use strict';

/**
 * scripts/report-client-identity-consolidation.js
 *
 * Rapport d'audit de la consolidation des identites learning.
 * Lecture seule : n'active rien, ne modifie aucun hint, n'ecrit que
 * sous data/reports.
 *
 * Usage :
 *   node scripts/report-client-identity-consolidation.js
 *   node scripts/report-client-identity-consolidation.js --dry-run
 */

var fs   = require('fs');
var path = require('path');
var normalizeLearningKey = require('./learning-key-utils').normalizeLearningKey;
var _identity = require('./client-identity-utils');

var DECISIONS_DIR = path.join(__dirname, '..', 'data', 'review-decisions');
var REPORTS_DIR   = path.join(__dirname, '..', 'data', 'reports');

var DRY_RUN = process.argv.indexOf('--dry-run') !== -1;

/* Conditions d'executabilite, alignees sur la politique du runtime. */
var MIN_TOTAL  = 5;
var MIN_CYCLES = 2;

function isExecutable(signal) {
  if (!signal) return false;
  if (signal.recommended_effect !== 'demote_to_review') return false;
  if (signal.block_auto_notify !== true) return false;
  if (typeof signal.total !== 'number' || signal.total < MIN_TOTAL) return false;
  if (typeof signal.cycles_count !== 'number' || signal.cycles_count < MIN_CYCLES) return false;
  if (typeof signal.keep !== 'number' || typeof signal.reject !== 'number'
      || typeof signal.ignore !== 'number') return false;
  return (signal.reject + signal.ignore) > signal.keep;
}

function loadRawRecords() {
  var files = fs.readdirSync(DECISIONS_DIR)
    .filter(function(f) { return /^review-decisions-.*\.json$/.test(f); })
    .sort();

  var records = [];
  files.forEach(function(f) {
    try {
      var d = JSON.parse(fs.readFileSync(path.join(DECISIONS_DIR, f), 'utf8'));
      (d.records || []).forEach(function(r) { records.push(r); });
    } catch (e) { /* fichier ignore */ }
  });

  return { files: files, records: records };
}

/**
 * Agregation par cle client, avec la meme deduplication last-wins que le
 * builder (cle client + bc_id). Les cycles sont comptes sur les records
 * bruts, comme dans le builder.
 *
 * `keyFn(record)` fournit la cle client : brute pour l'etat "avant",
 * canonique pour l'etat "apres".
 */
function aggregateWithDedup(records, keyFn) {
  var map = {};
  records.forEach(function(r) {
    map[keyFn(r) + '::' + String(r.bc_id || '')] = r;
  });
  var deduped = Object.keys(map).map(function(k) { return map[k]; });

  var out = {};

  function slot(ck, sk) {
    if (!out[ck]) out[ck] = { signals: {} };
    if (!out[ck].signals[sk]) {
      out[ck].signals[sk] = { keep: 0, reject: 0, ignore: 0, total: 0, cycles: {} };
    }
    return out[ck].signals[sk];
  }

  /* Stats sur les records dedupliques. */
  deduped.forEach(function(r) {
    var ck = keyFn(r);
    (Array.isArray(r.matched_signals) ? r.matched_signals : []).forEach(function(s) {
      var sk = normalizeLearningKey(s) || String(s || '').trim();
      if (!sk) return;
      var e = slot(ck, sk);
      var d = r.decision || '';
      if (d === 'keep' || d === 'reject' || d === 'ignore') e[d]++;
      e.total++;
    });
  });

  /* Cycles depuis les records bruts. */
  records.forEach(function(r) {
    var ck = keyFn(r);
    if (!out[ck] || !r.cycle_id) return;
    (Array.isArray(r.matched_signals) ? r.matched_signals : []).forEach(function(s) {
      var sk = normalizeLearningKey(s) || String(s || '').trim();
      if (!sk || !out[ck].signals[sk]) return;
      out[ck].signals[sk].cycles[r.cycle_id] = true;
    });
  });

  return out;
}

function rawClientKey(r) {
  var raw = String(r.client || '(inconnu)').trim();
  return normalizeLearningKey(raw) || raw;
}

function buildReport() {
  var loaded = loadRawRecords();

  var registry = _identity.buildIdentityRegistry(
    _identity.collectEvidenceFromRecords(loaded.records)
      .concat(_identity.readEvidenceFromCycleState())
  );

  /* Identites resolues et non resolues. */
  var identities  = {};
  var unresolved  = {};
  var mergedCount = 0;

  loaded.records.forEach(function(r) {
    var id  = _identity.resolveClientIdentity(r, registry);
    var raw = _identity.extractRawIdentity(r);

    if (id.resolved) {
      if (!identities[id.client_id]) {
        identities[id.client_id] = {
          client_id:    id.client_id,
          client_name:  id.client_name,
          names:        [],
          decisions:    0,
          via:          {},
        };
      }
      var slot = identities[id.client_id];
      slot.decisions++;
      slot.via[id.via] = (slot.via[id.via] || 0) + 1;
      if (raw.name && slot.names.indexOf(raw.name) === -1) slot.names.push(raw.name);
      /* Une decision rattachee par preuve est une decision fusionnee. */
      if (id.via === 'evidence') mergedCount++;
    } else {
      if (!unresolved[id.key]) {
        unresolved[id.key] = {
          client_key:  id.key,
          client_name: id.client_name,
          names:       [],
          decisions:   0,
          reason:      id.warning,
        };
      }
      var u = unresolved[id.key];
      u.decisions++;
      if (raw.name && u.names.indexOf(raw.name) === -1) u.names.push(raw.name);
    }
  });

  /* Avant / apres par signal, avec la deduplication du builder des deux cotes. */
  var before = aggregateWithDedup(loaded.records, rawClientKey);
  var after  = aggregateWithDedup(loaded.records, function(r) {
    return _identity.resolveClientIdentity(r, registry).key;
  });
  var deltas = [];

  Object.keys(identities).sort().forEach(function(uuid) {
    var ident = identities[uuid];
    var sourceKeys = [normalizeLearningKey(uuid) || uuid, uuid];
    ident.names.forEach(function(n) {
      var k = normalizeLearningKey(n);
      if (k && sourceKeys.indexOf(k) === -1) sourceKeys.push(k);
    });
    sourceKeys = sourceKeys.filter(function(k, i) { return sourceKeys.indexOf(k) === i; });

    var afterSignals = (after[uuid] && after[uuid].signals) || {};

    Object.keys(afterSignals).sort().forEach(function(sk) {
      var parts = [];
      sourceKeys.forEach(function(k) {
        var e = before[k] && before[k].signals[sk];
        if (!e) return;
        parts.push({
          source_key: k,
          keep: e.keep, reject: e.reject, ignore: e.ignore,
          total: e.total, cycles_count: Object.keys(e.cycles).length,
        });
      });

      if (parts.length < 2) return;  // aucun regroupement : pas de delta a montrer

      var a = afterSignals[sk];
      deltas.push({
        client_id: uuid,
        signal:    sk,
        before:    parts,
        after: {
          keep: a.keep, reject: a.reject, ignore: a.ignore,
          total: a.total, cycles_count: Object.keys(a.cycles).length,
        },
      });
    });
  });

  /* Hints executoires apres consolidation, lus depuis le builder consolide. */
  var executable = [];
  var hintsPath = path.join(__dirname, '..', 'data', 'client-learning', 'client-learning-hints.json');
  try {
    var hints = JSON.parse(fs.readFileSync(hintsPath, 'utf8'));
    (hints.clients || []).forEach(function(c) {
      var cid = c.client_id || c.client;
      if (!_identity.isUuid(cid)) return;
      (c.signals || []).forEach(function(s) {
        if (!isExecutable(s)) return;
        executable.push({
          client_id: _identity.canonicalUuid(cid),
          signal:    s.signal,
          total:     s.total,
          cycles_count: s.cycles_count,
          keep: s.keep, reject: s.reject, ignore: s.ignore,
        });
      });
    });
  } catch (e) { /* hints absents : liste vide */ }

  return {
    generated_at:  new Date().toISOString(),
    activation:    'none',
    files_read:    loaded.files.length,
    decisions_total: loaded.records.length,
    identities:    Object.keys(identities).sort().map(function(k) { return identities[k]; }),
    unresolved:    Object.keys(unresolved).sort().map(function(k) { return unresolved[k]; }),
    collisions:    registry.collisions || [],
    merged_decisions: mergedCount,
    signal_deltas: deltas,
    executable_hints: executable,
  };
}

function toMarkdown(rep) {
  var L = [];
  L.push('# Consolidation des identites learning');
  L.push('');
  L.push('Genere le ' + rep.generated_at + ' - **aucune activation**.');
  L.push('');
  L.push('- fichiers lus : ' + rep.files_read);
  L.push('- decisions    : ' + rep.decisions_total);
  L.push('- decisions rattachees par preuve : ' + rep.merged_decisions);
  L.push('');

  L.push('## Identites UUID resolues');
  L.push('');
  if (!rep.identities.length) { L.push('_aucune_'); }
  else {
    L.push('| client_id | libelle | noms consolides | decisions |');
    L.push('|---|---|---|---|');
    rep.identities.forEach(function(i) {
      L.push('| `' + i.client_id + '` | ' + (i.client_name || '-') + ' | ' +
             (i.names.length ? i.names.join('<br>') : '-') + ' | ' + i.decisions + ' |');
    });
  }
  L.push('');

  L.push('## Identites non resolues (non executoires)');
  L.push('');
  if (!rep.unresolved.length) { L.push('_aucune_'); }
  else {
    L.push('| cle | libelle | decisions | motif |');
    L.push('|---|---|---|---|');
    rep.unresolved.forEach(function(u) {
      L.push('| `' + u.client_key + '` | ' + (u.client_name || '-') + ' | ' +
             u.decisions + ' | ' + (u.reason || '-') + ' |');
    });
  }
  L.push('');

  L.push('## Collisions nom -> plusieurs UUID');
  L.push('');
  if (!rep.collisions.length) { L.push('_aucune_'); }
  else {
    rep.collisions.forEach(function(c) {
      L.push('- `' + c.name_key + '` -> ' + c.uuids.join(', '));
    });
  }
  L.push('');

  L.push('## Avant / apres par signal');
  L.push('');
  if (!rep.signal_deltas.length) { L.push('_aucun regroupement_'); }
  else {
    rep.signal_deltas.forEach(function(d) {
      L.push('### `' + d.client_id + '` - ' + d.signal);
      L.push('');
      L.push('| source | keep | reject | ignore | total | cycles |');
      L.push('|---|---|---|---|---|---|');
      d.before.forEach(function(p) {
        L.push('| `' + p.source_key + '` | ' + p.keep + ' | ' + p.reject + ' | ' +
               p.ignore + ' | ' + p.total + ' | ' + p.cycles_count + ' |');
      });
      L.push('| **apres** | **' + d.after.keep + '** | **' + d.after.reject + '** | **' +
             d.after.ignore + '** | **' + d.after.total + '** | **' + d.after.cycles_count + '** |');
      L.push('');
    });
  }

  L.push('## Hints executoires apres consolidation');
  L.push('');
  if (!rep.executable_hints.length) { L.push('_aucun hint executoire_'); }
  else {
    L.push('| client_id | signal | keep | reject | ignore | total | cycles |');
    L.push('|---|---|---|---|---|---|---|');
    rep.executable_hints.forEach(function(h) {
      L.push('| `' + h.client_id + '` | ' + h.signal + ' | ' + h.keep + ' | ' + h.reject +
             ' | ' + h.ignore + ' | ' + h.total + ' | ' + h.cycles_count + ' |');
    });
  }
  L.push('');

  return L.join('\n');
}

module.exports = { buildReport: buildReport, toMarkdown: toMarkdown, isExecutable: isExecutable };

if (require.main === module) {
  var rep = buildReport();

  if (DRY_RUN) {
    console.log(JSON.stringify(rep, null, 2));
  } else {
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });
    var ts = rep.generated_at.replace(/[:.]/g, '-');
    var jsonPath = path.join(REPORTS_DIR, 'client-identity-consolidation-' + ts + '.json');
    var mdPath   = path.join(REPORTS_DIR, 'client-identity-consolidation-' + ts + '.md');
    fs.writeFileSync(jsonPath, JSON.stringify(rep, null, 2), 'utf8');
    fs.writeFileSync(mdPath, toMarkdown(rep), 'utf8');
    console.log('[OK] ' + jsonPath);
    console.log('[OK] ' + mdPath);
  }

  console.log('  identites resolues  : ' + rep.identities.length);
  console.log('  non resolues        : ' + rep.unresolved.length);
  console.log('  collisions          : ' + rep.collisions.length);
  console.log('  hints executoires   : ' + rep.executable_hints.length);
}
