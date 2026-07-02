#!/usr/bin/env node
// scripts/export-client-feedback-events.js
// GD-121 — Export read-only des feedbacks client depuis Supabase vers JSONL.
//
// Usage :
//   node scripts/export-client-feedback-events.js --client-id <uuid> --since <iso>
//   node scripts/export-client-feedback-events.js --client-id <uuid> --since <iso> --dry-run
//   node scripts/export-client-feedback-events.js --client-id <uuid> --since <iso> --output <path>
//   node scripts/export-client-feedback-events.js --client-id <uuid> --since <iso> --include-tests
//   node scripts/export-client-feedback-events.js --client-id <uuid> --since <iso> --radar-type mp
//
// Options :
//   --client-id <uuid>   (OBLIGATOIRE) UUID client Supabase
//   --since <iso>        (OBLIGATOIRE) Date ISO minimale created_at (ex: 2026-06-29T15:35:00Z)
//   --radar-type <type>  "bc" | "mp"  (defaut: "bc")
//   --output <path>      Chemin de sortie JSONL (defaut: data/feedback/feedback-events-client-<ts>.jsonl)
//   --limit <n>          Nombre max d'enregistrements Supabase (defaut: 500)
//   --dry-run            Compteurs + preview, aucun fichier ecrit
//   --include-tests      Conserver les item_id TEST et FB6_PROD_TEST (desactive par defaut)
//
// SECURITE :
//   - Lecture Supabase uniquement (SELECT) — aucun INSERT / UPDATE / DELETE
//   - Ne modifie pas radar-bc-bot.js, le moteur, scoring, hints, seuils
//   - Ne lance pas import-review-decisions.js
//   - Ne touche pas Fly, secrets, prod
//   - Aucune regle specifique nettoyage / hygiene / informatique
//   - Compatible multi-clients, multi-profils

'use strict';

var fs   = require('fs');
var path = require('path');

// ---------------------------------------------------------------------------
// Chargement .env local (si variable d'env absente)
// ---------------------------------------------------------------------------
function loadEnvFile() {
  var envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(function(line) {
    var m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim();
    }
  });
}

// ---------------------------------------------------------------------------
// Logique pure de filtrage / transformation (exportee pour tests unitaires)
// ---------------------------------------------------------------------------

/**
 * Determine si un item_id est numerique pur.
 * @param {string} itemId
 * @returns {boolean}
 */
function isNumericItemId(itemId) {
  return typeof itemId === 'string' && /^\d+$/.test(itemId);
}

/**
 * Determine si un item_id est un item de test.
 * @param {string} itemId
 * @returns {boolean}
 */
function isTestItemId(itemId) {
  if (typeof itemId !== 'string') return false;
  return itemId.startsWith('TEST') || itemId.startsWith('FB6_PROD_TEST');
}

/**
 * Extrait la raison depuis un enregistrement Supabase (raw_payload.reason en priorite).
 * @param {object} row  Ligne Supabase
 * @returns {string|undefined}
 */
function extractReason(row) {
  if (row && row.raw_payload && typeof row.raw_payload.reason === 'string' && row.raw_payload.reason.trim()) {
    return row.raw_payload.reason.trim();
  }
  if (row && typeof row.reason === 'string' && row.reason.trim()) {
    return row.reason.trim();
  }
  return undefined;
}

/**
 * Extrait le critere depuis un enregistrement Supabase (raw_payload.critere en priorite).
 * @param {object} row  Ligne Supabase
 * @returns {string}
 */
function extractCritere(row) {
  if (row && row.raw_payload && typeof row.raw_payload.critere === 'string' && row.raw_payload.critere.trim()) {
    return row.raw_payload.critere.trim();
  }
  return (row && typeof row.critere === 'string') ? row.critere.trim() : '';
}

/**
 * Filtre et transforme une liste de lignes Supabase en evenements JSONL.
 *
 * @param {object[]} rows         Lignes brutes Supabase
 * @param {object}   opts
 * @param {boolean}  opts.includeTests  true = conserver TEST/FB6_PROD_TEST (defaut false)
 * @returns {{ events: object[], stats: object }}
 */
function filterAndTransform(rows, opts) {
  opts = opts || {};
  var includeTests = opts.includeTests === true;

  var stats = {
    total_fetched:          rows.length,
    excluded_non_numeric:   0,
    excluded_test:          0,
    total_exported:         0,
    with_reason:            0,
    by_type:                {},
    by_reason:              {},
    by_critere:             {},
  };

  var events = [];

  rows.forEach(function(row) {
    var itemId = String(row.item_id || '').trim();

    // Exclure item_id non numeriques
    if (!isNumericItemId(itemId)) {
      stats.excluded_non_numeric++;
      return;
    }

    // Exclure les item_id de test (sauf si --include-tests)
    if (!includeTests && isTestItemId(itemId)) {
      stats.excluded_test++;
      return;
    }

    var reason  = extractReason(row);
    var critere = extractCritere(row);
    var type    = (row.type || '').trim();
    var source  = (row.source || '').trim();

    // Construire l'evenement JSONL (format compatible convert-feedback-events-to-review-csv.js)
    // Champ obligatoire : item_id (pas bc_id)
    var event = {
      client_id:  String(row.client_id || '').trim(),
      item_id:    itemId,
      radar_type: String(row.radar_type || 'bc').trim(),
      critere:    critere,
      type:       type,
      created_at: String(row.created_at || '').trim(),
      source:     source,
    };
    if (reason !== undefined) event.reason = reason;

    events.push(event);
    stats.total_exported++;
    if (reason) stats.with_reason++;
    if (type)   stats.by_type[type]     = (stats.by_type[type]     || 0) + 1;
    if (reason) stats.by_reason[reason] = (stats.by_reason[reason] || 0) + 1;
    if (critere) stats.by_critere[critere] = (stats.by_critere[critere] || 0) + 1;
  });

  return { events: events, stats: stats };
}

/**
 * Serialise une liste d'evenements en contenu JSONL.
 * @param {object[]} events
 * @returns {string}
 */
function buildJsonlContent(events) {
  return events.map(function(e) { return JSON.stringify(e); }).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Requete Supabase (I/O — non testee en unitaire)
// ---------------------------------------------------------------------------

/**
 * Interroge Supabase (SELECT uniquement) et retourne les lignes brutes.
 * @param {object} opts
 * @param {string} opts.sbUrl        URL Supabase
 * @param {string} opts.sbKey        Cle Supabase
 * @param {string} opts.clientId     UUID client
 * @param {string} opts.since        ISO date minimum created_at
 * @param {string} opts.radarType    "bc" | "mp"
 * @param {number} opts.limit        Nombre max de lignes
 * @returns {Promise<object[]>}
 */
async function fetchFromSupabase(opts) {
  var params = [
    'client_id=eq.' + encodeURIComponent(opts.clientId),
    'created_at=gte.' + encodeURIComponent(opts.since),
    'radar_type=eq.'  + encodeURIComponent(opts.radarType),
    'order=created_at.asc',
    'limit=' + opts.limit,
    'select=id,client_id,item_id,radar_type,critere,type,source,raw_payload,created_at',
  ].join('&');

  var url = opts.sbUrl + '/rest/v1/client_feedback_events?' + params;

  var res = await fetch(url, {
    method: 'GET',
    headers: {
      'apikey':        opts.sbKey,
      'Authorization': 'Bearer ' + opts.sbKey,
      'Content-Type':  'application/json',
    },
  });

  if (!res.ok) {
    var body = '';
    try { body = await res.text(); } catch (_e) { /* ignore */ }
    throw new Error('Supabase HTTP ' + res.status + ': ' + body.slice(0, 200));
  }

  var data = await res.json().catch(function(e) {
    throw new Error('Supabase reponse non-JSON: ' + e.message);
  });

  if (!Array.isArray(data)) {
    throw new Error('Supabase: reponse inattendue (non-tableau)');
  }

  return data;
}

// ---------------------------------------------------------------------------
// Exports (pour tests)
// ---------------------------------------------------------------------------
module.exports = {
  isNumericItemId:    isNumericItemId,
  isTestItemId:       isTestItemId,
  extractReason:      extractReason,
  extractCritere:     extractCritere,
  filterAndTransform: filterAndTransform,
  buildJsonlContent:  buildJsonlContent,
};

// ---------------------------------------------------------------------------
// CLI — execution directe uniquement
// ---------------------------------------------------------------------------
if (require.main !== module) return;

// -- Parsing des arguments
var args       = process.argv.slice(2);
var clientId   = null;
var since      = null;
var radarType  = 'bc';
var outputPath = null;
var limit      = 500;
var dryRun     = false;
var includeTests = false;

for (var _i = 0; _i < args.length; _i++) {
  var _a = args[_i];
  if (_a === '--dry-run')     { dryRun = true; continue; }
  if (_a === '--include-tests') { includeTests = true; continue; }
  if (_a === '--client-id'   && args[_i + 1]) { clientId  = args[++_i]; continue; }
  if (_a === '--since'       && args[_i + 1]) { since     = args[++_i]; continue; }
  if (_a === '--radar-type'  && args[_i + 1]) { radarType = args[++_i]; continue; }
  if (_a === '--output'      && args[_i + 1]) { outputPath = args[++_i]; continue; }
  if (_a === '--limit'       && args[_i + 1]) {
    limit = parseInt(args[++_i], 10);
    if (isNaN(limit) || limit < 1) { console.error('ERROR: --limit doit etre un entier >= 1'); process.exit(1); }
    continue;
  }
}

// -- Validation arguments obligatoires
if (!clientId) {
  console.error('ERROR: --client-id est obligatoire');
  console.error('Usage: node scripts/export-client-feedback-events.js --client-id <uuid> --since <iso>');
  process.exit(1);
}
if (!since) {
  console.error('ERROR: --since est obligatoire (ex: 2026-06-29T15:35:00Z)');
  process.exit(1);
}
if (!['bc', 'mp'].includes(radarType)) {
  console.error('ERROR: --radar-type doit etre "bc" ou "mp"');
  process.exit(1);
}

// -- Chargement env
loadEnvFile();
var sbUrl = process.env.SUPABASE_URL;
var sbKey  = process.env.SUPABASE_KEY;
if (!sbUrl || !sbKey) {
  console.error('ERROR: SUPABASE_URL et SUPABASE_KEY doivent etre definis (env ou .env)');
  process.exit(1);
}

// -- Chemin de sortie par defaut
if (!outputPath) {
  var ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+$/, '');
  var feedbackDir = path.resolve(__dirname, '..', 'data', 'feedback');
  outputPath = path.join(feedbackDir, 'feedback-events-client-' + ts + '.jsonl');
}

// -- Main
(async function main() {
  console.log('');
  console.log('=== export-client-feedback-events (GD-121) ===');
  console.log('client-id   :', clientId);
  console.log('since       :', since);
  console.log('radar-type  :', radarType);
  console.log('limit       :', limit);
  console.log('dry-run     :', dryRun);
  console.log('include-tests:', includeTests);
  console.log('output      :', dryRun ? '(dry-run, aucun fichier)' : outputPath);
  console.log('');

  var rows;
  try {
    console.log('[Supabase] Requete en cours...');
    rows = await fetchFromSupabase({ sbUrl: sbUrl, sbKey: sbKey, clientId: clientId, since: since, radarType: radarType, limit: limit });
    console.log('[Supabase] ' + rows.length + ' ligne(s) recues');
  } catch (e) {
    console.error('ERROR Supabase:', e.message);
    // GD-121B : process.exitCode + return au lieu de process.exit(1) pour eviter
    // l'assertion libuv Windows (UV_HANDLE_CLOSING) apres un fetch async.
    process.exitCode = 1;
    return;
  }

  var result = filterAndTransform(rows, { includeTests: includeTests });
  var stats  = result.stats;
  var events = result.events;

  // -- Resume
  console.log('');
  console.log('=== Resume ===');
  console.log('Total recupere Supabase     :', stats.total_fetched);
  console.log('Total exporte               :', stats.total_exported);
  console.log('Exclus non numeriques       :', stats.excluded_non_numeric);
  console.log('Exclus TEST/FB6_PROD_TEST   :', stats.excluded_test);
  console.log('Avec reason (Mode B)        :', stats.with_reason);

  if (Object.keys(stats.by_type).length) {
    console.log('\nRepartition par type :');
    Object.keys(stats.by_type).sort().forEach(function(t) {
      console.log('  ' + t.padEnd(14) + ': ' + stats.by_type[t]);
    });
  }

  if (Object.keys(stats.by_reason).length) {
    console.log('\nRepartition par reason :');
    Object.keys(stats.by_reason).sort(function(a, b) { return stats.by_reason[b] - stats.by_reason[a]; }).forEach(function(r) {
      console.log('  ' + r.padEnd(22) + ': ' + stats.by_reason[r]);
    });
  }

  if (Object.keys(stats.by_critere).length) {
    console.log('\nCriteres concernes :');
    Object.keys(stats.by_critere).sort(function(a, b) { return stats.by_critere[b] - stats.by_critere[a]; }).forEach(function(c) {
      console.log('  ' + c.padEnd(22) + ': ' + stats.by_critere[c]);
    });
  }

  if (events.length === 0) {
    console.log('\nAucun evenement a exporter.');
    // GD-121B : return naturel — evite l'assertion libuv Windows post-fetch.
    return;
  }

  // -- Dry-run : preview uniquement
  if (dryRun) {
    console.log('\n--- Preview (5 premiers evenements) ---');
    events.slice(0, 5).forEach(function(e) { console.log(JSON.stringify(e)); });
    console.log('\n[dry-run] Aucun fichier ecrit.');
    // GD-121B : return naturel — evite l'assertion libuv Windows post-fetch.
    return;
  }

  // -- Ecriture JSONL
  var outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, buildJsonlContent(events), 'utf8');

  console.log('\n[OK] JSONL ecrit : ' + outputPath);
  console.log('\nCommande de conversion :');
  console.log('  node scripts/convert-feedback-events-to-review-csv.js --input "' + outputPath + '" --dedupe --dry-run');
  console.log('');
})();
