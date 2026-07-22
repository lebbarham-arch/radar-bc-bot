#!/usr/bin/env node
/**
 * run-feedback-learning-cycle.js
 *
 * Ferme la boucle generique : feedback Supabase -> decisions client ->
 * rapport d'apprentissage -> hints shadow.
 *
 * Principes de securite :
 * - SELECT Supabase uniquement.
 * - Aucun scan, aucune notification, aucun appel Fly.
 * - Aucun changement scoring, seuil, guard ou regle metier.
 * - Checkpoint local idempotent dans data/feedback/ (gitignore).
 * - Un cycle_id stable par client + BC, pour eviter les faux cycles lors d'un rerun.
 *
 * Usage :
 *   node scripts/run-feedback-learning-cycle.js
 *   node scripts/run-feedback-learning-cycle.js --dry-run
 *   node scripts/run-feedback-learning-cycle.js --client-id <uuid>
 *   node scripts/run-feedback-learning-cycle.js --since <iso>
 */

'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var exporter = require('./export-client-feedback-events');
var converter = require('./convert-feedback-events-to-review-csv');

var PROJECT_ROOT = path.resolve(__dirname, '..');
var FEEDBACK_DIR = path.join(PROJECT_ROOT, 'data', 'feedback');
var DECISIONS_DIR = path.join(PROJECT_ROOT, 'data', 'review-decisions');
var STATE_FILE = path.join(FEEDBACK_DIR, 'feedback-learning-state.json');
var DEFAULT_SINCE = '1970-01-01T00:00:00.000Z';
var DEFAULT_PAGE_SIZE = 1000;

function parseArgs(argv) {
  var out = {
    dryRun: false,
    clientId: null,
    since: null,
    pageSize: DEFAULT_PAGE_SIZE,
  };

  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--client-id' && argv[i + 1]) {
      out.clientId = String(argv[++i]).trim();
    } else if (a === '--since' && argv[i + 1]) {
      out.since = String(argv[++i]).trim();
    } else if (a === '--page-size' && argv[i + 1]) {
      out.pageSize = parseInt(argv[++i], 10);
    }
  }

  if (!Number.isFinite(out.pageSize) || out.pageSize < 1 || out.pageSize > 5000) {
    throw new Error('--page-size doit etre un entier entre 1 et 5000');
  }
  if (out.since && !isValidIso(out.since)) {
    throw new Error('--since doit etre une date ISO valide');
  }
  return out;
}

function isValidIso(value) {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function normalizeCheckpoint(checkpoint, fallbackSince) {
  var fallback = isValidIso(fallbackSince) ? new Date(fallbackSince).toISOString() : DEFAULT_SINCE;
  var createdAt = checkpoint && isValidIso(checkpoint.created_at)
    ? new Date(checkpoint.created_at).toISOString()
    : fallback;
  var eventId = checkpoint && checkpoint.event_id !== undefined && checkpoint.event_id !== null
    ? String(checkpoint.event_id)
    : '';
  return { created_at: createdAt, event_id: eventId };
}

function compareEventIds(a, b) {
  var sa = String(a === undefined || a === null ? '' : a);
  var sb = String(b === undefined || b === null ? '' : b);
  if (/^\d+$/.test(sa) && /^\d+$/.test(sb)) {
    var na = BigInt(sa || '0');
    var nb = BigInt(sb || '0');
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function compareRows(a, b) {
  var ta = Date.parse(a.created_at || '');
  var tb = Date.parse(b.created_at || '');
  if (ta !== tb) return ta < tb ? -1 : 1;
  return compareEventIds(a.id, b.id);
}

function isRowAfterCheckpoint(row, checkpoint) {
  if (!row || !isValidIso(row.created_at)) return false;
  var cpNorm = normalizeCheckpoint(checkpoint, DEFAULT_SINCE);
  var rowTs = Date.parse(row.created_at);
  var cpTs = Date.parse(cpNorm.created_at);
  if (rowTs > cpTs) return true;
  if (rowTs < cpTs) return false;
  return compareEventIds(row.id, cpNorm.event_id) > 0;
}

function selectRowsAfterCheckpoint(rows, checkpoint) {
  return (rows || [])
    .filter(function(row) { return isRowAfterCheckpoint(row, checkpoint); })
    .sort(compareRows);
}

function checkpointFromRows(rows, previous) {
  var ordered = (rows || []).filter(function(r) { return isValidIso(r.created_at); }).slice().sort(compareRows);
  if (!ordered.length) return normalizeCheckpoint(previous, DEFAULT_SINCE);
  var last = ordered[ordered.length - 1];
  return {
    created_at: new Date(last.created_at).toISOString(),
    event_id: String(last.id === undefined || last.id === null ? '' : last.id),
  };
}

function dedupeLatestByItem(events) {
  var map = Object.create(null);
  (events || []).forEach(function(event, index) {
    if (!event || !event.client_id || !event.item_id) return;
    var key = String(event.client_id) + '|' + String(event.item_id);
    var prev = map[key];
    if (!prev) {
      map[key] = { event: event, index: index };
      return;
    }
    var prevTs = Date.parse(prev.event.created_at || '') || 0;
    var nextTs = Date.parse(event.created_at || '') || 0;
    if (nextTs > prevTs || (nextTs === prevTs && index > prev.index)) {
      map[key] = { event: event, index: index };
    }
  });
  return Object.keys(map)
    .map(function(k) { return map[k]; })
    .sort(function(a, b) {
      var ta = Date.parse(a.event.created_at || '') || 0;
      var tb = Date.parse(b.event.created_at || '') || 0;
      if (ta !== tb) return ta - tb;
      return a.index - b.index;
    })
    .map(function(x) { return x.event; });
}

function cycleIdForEvent(event) {
  return 'client-feedback-bc-' + String(event.item_id || '').trim();
}

function sanitizeFilePart(value) {
  return String(value || 'client')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'client';
}

function buildFeedbackQuery(opts) {
  var params = [
    'client_id=eq.' + encodeURIComponent(opts.clientId),
    'radar_type=eq.bc',
    'source=eq.web_click',
    'created_at=gte.' + encodeURIComponent(opts.since),
    'order=created_at.asc,id.asc',
    'limit=' + opts.limit,
    'offset=' + opts.offset,
    'select=id,client_id,item_id,radar_type,critere,type,source,raw_payload,created_at',
  ];
  return params.join('&');
}

function loadState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { version: 1, clients: {} };
    var parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, clients: {} };
    if (!parsed.clients || typeof parsed.clients !== 'object') parsed.clients = {};
    parsed.version = 1;
    return parsed;
  } catch (e) {
    throw new Error('Etat checkpoint invalide: ' + e.message);
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  var tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

async function fetchJson(url, headers) {
  var res = await fetch(url, { method: 'GET', headers: headers });
  var text = await res.text();
  var data;
  try { data = text ? JSON.parse(text) : null; }
  catch (_e) { throw new Error('Reponse non-JSON HTTP ' + res.status + ': ' + text.slice(0, 200)); }
  if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + JSON.stringify(data).slice(0, 300));
  return data;
}

async function fetchActiveClients(sbUrl, sbKey, clientId) {
  var params = [
    'actif=eq.true',
    'select=id,nom',
    'order=nom.asc',
  ];
  if (clientId) params.push('id=eq.' + encodeURIComponent(clientId));
  var url = sbUrl.replace(/\/$/, '') + '/rest/v1/clients?' + params.join('&');
  var rows = await fetchJson(url, {
    apikey: sbKey,
    Authorization: 'Bearer ' + sbKey,
    'Content-Type': 'application/json',
  });
  if (!Array.isArray(rows)) throw new Error('Liste clients Supabase invalide');
  return rows;
}

async function fetchFeedbackRows(sbUrl, sbKey, clientId, since, pageSize) {
  var rows = [];
  var offset = 0;
  var headers = {
    apikey: sbKey,
    Authorization: 'Bearer ' + sbKey,
    'Content-Type': 'application/json',
  };

  while (true) {
    var query = buildFeedbackQuery({
      clientId: clientId,
      since: since,
      limit: pageSize,
      offset: offset,
    });
    var url = sbUrl.replace(/\/$/, '') + '/rest/v1/client_feedback_events?' + query;
    var chunk = await fetchJson(url, headers);
    if (!Array.isArray(chunk)) throw new Error('Feedback Supabase invalide');
    rows = rows.concat(chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

function runNode(scriptRelative, args) {
  var script = path.join(PROJECT_ROOT, scriptRelative);
  var result = cp.spawnSync(process.execPath, [script].concat(args || []), {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('Commande echouee (' + result.status + '): node ' + scriptRelative);
  }
}

function writeEventArtifacts(client, event, stamp) {
  var clientPart = sanitizeFilePart(client.nom || client.id);
  var itemPart = sanitizeFilePart(event.item_id);
  var base = clientPart + '-' + itemPart + '-' + stamp;
  var jsonlPath = path.join(FEEDBACK_DIR, 'feedback-events-client-' + base + '.jsonl');
  var csvPath = path.join(FEEDBACK_DIR, 'review-candidates-feedback-' + base + '.csv');

  fs.mkdirSync(FEEDBACK_DIR, { recursive: true });
  fs.writeFileSync(jsonlPath, exporter.buildJsonlContent([event]), 'utf8');

  var review = converter.convertFeedbackEvent(event);
  if (!review) throw new Error('Feedback non convertible pour item_id=' + event.item_id);
  fs.writeFileSync(csvPath, converter.buildCsvContent([review]), 'utf8');

  return { jsonlPath: jsonlPath, csvPath: csvPath };
}

function hasReviewDecisionFiles() {
  if (!fs.existsSync(DECISIONS_DIR)) return false;
  return fs.readdirSync(DECISIONS_DIR).some(function(name) {
    return /^review-decisions-.*\.json$/.test(name);
  });
}

async function main(argv) {
  var opts = parseArgs(argv || process.argv.slice(2));
  require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });

  var sbUrl = process.env.SUPABASE_URL || '';
  var sbKey = process.env.SUPABASE_KEY || '';
  if (!sbUrl || !sbKey) throw new Error('SUPABASE_URL et SUPABASE_KEY requis');

  var state = loadState(STATE_FILE);
  var clients = await fetchActiveClients(sbUrl, sbKey, opts.clientId);
  if (!clients.length) throw new Error('Aucun client actif trouve');

  var totalFetched = 0;
  var totalNewRaw = 0;
  var totalImported = 0;
  var stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');

  console.log('');
  console.log('=== FEEDBACK LEARNING CYCLE ===');
  console.log('clients : ' + clients.length);
  console.log('dry-run : ' + opts.dryRun);
  console.log('state   : ' + STATE_FILE);

  for (var i = 0; i < clients.length; i++) {
    var client = clients[i];
    var previous = normalizeCheckpoint(state.clients[client.id], opts.since || DEFAULT_SINCE);

    console.log('');
    console.log('[CLIENT] ' + (client.nom || client.id));
    console.log('  checkpoint : ' + previous.created_at + ' / id=' + (previous.event_id || '(vide)'));

    var fetched = await fetchFeedbackRows(sbUrl, sbKey, client.id, previous.created_at, opts.pageSize);
    var newRows = selectRowsAfterCheckpoint(fetched, previous);
    totalFetched += fetched.length;
    totalNewRaw += newRows.length;

    var transformed = exporter.filterAndTransform(newRows, { includeTests: false });
    var latestEvents = dedupeLatestByItem(transformed.events);

    console.log('  Supabase recus : ' + fetched.length);
    console.log('  nouveaux bruts : ' + newRows.length);
    console.log('  feedbacks reels: ' + latestEvents.length);
    console.log('  exclus non-num : ' + transformed.stats.excluded_non_numeric);

    if (opts.dryRun) {
      latestEvents.forEach(function(event) {
        console.log('    [DRY] item=' + event.item_id + ' type=' + event.type + ' cycle=' + cycleIdForEvent(event));
      });
      continue;
    }

    for (var j = 0; j < latestEvents.length; j++) {
      var event = latestEvents[j];
      var artifacts = writeEventArtifacts(client, event, stamp);
      runNode('scripts/import-review-decisions.js', [
        artifacts.csvPath,
        '--review-source', 'client',
        '--cycle-id', cycleIdForEvent(event),
      ]);
      totalImported++;
    }

    state.clients[client.id] = checkpointFromRows(newRows, previous);
    state.clients[client.id].client_name = client.nom || '';
    state.clients[client.id].updated_at = new Date().toISOString();
    writeJsonAtomic(STATE_FILE, state);
  }

  if (!opts.dryRun && hasReviewDecisionFiles()) {
    console.log('');
    console.log('[LEARNING] rapport consultatif...');
    runNode('scripts/analyze-review-reason-learning.js', ['data/review-decisions']);
    console.log('[LEARNING] reconstruction hints shadow...');
    runNode('scripts/build-client-learning-hints.js', []);
  }

  console.log('');
  console.log('=== CYCLE TERMINE ===');
  console.log('feedbacks Supabase lus : ' + totalFetched);
  console.log('nouveaux evenements    : ' + totalNewRaw);
  console.log('decisions importees    : ' + totalImported);
  if (opts.dryRun) console.log('aucune ecriture (dry-run)');
}

module.exports = {
  parseArgs: parseArgs,
  normalizeCheckpoint: normalizeCheckpoint,
  compareEventIds: compareEventIds,
  isRowAfterCheckpoint: isRowAfterCheckpoint,
  selectRowsAfterCheckpoint: selectRowsAfterCheckpoint,
  checkpointFromRows: checkpointFromRows,
  dedupeLatestByItem: dedupeLatestByItem,
  cycleIdForEvent: cycleIdForEvent,
  sanitizeFilePart: sanitizeFilePart,
  buildFeedbackQuery: buildFeedbackQuery,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch(function(err) {
    console.error('[ERREUR] ' + err.message);
    process.exit(1);
  });
}
