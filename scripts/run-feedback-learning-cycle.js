#!/usr/bin/env node
/**
 * run-feedback-learning-cycle.js
 *
 * Pilote multi-clients pour l'orchestrateur existant
 * run-client-feedback-learning-cycle.js.
 *
 * Objectif : fermer automatiquement la boucle feedback Supabase -> learning
 * pour tous les clients actifs, sans dupliquer la logique de conversion,
 * d'import, d'analyse ou de construction des hints.
 *
 * Securite :
 * - SELECT Supabase uniquement pour lister les clients actifs.
 * - Aucun scan, aucune notification, aucun appel Fly.
 * - Aucun changement scoring, seuil, guard ou regle metier.
 * - Checkpoint local dans data/feedback/ (deja gitignore).
 * - En cas d'echec d'un client, son checkpoint n'avance pas.
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
var spawnSync = require('child_process').spawnSync;

var ROOT = path.resolve(__dirname, '..');
var STATE_FILE = path.join(ROOT, 'data', 'feedback', 'feedback-learning-state.json');
var ORCHESTRATOR = path.join(__dirname, 'run-client-feedback-learning-cycle.js');
var DEFAULT_SINCE = '1970-01-01T00:00:00.000Z';

function isValidIso(value) {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function parseArgs(argv) {
  var opts = {
    dryRun: false,
    clientId: null,
    since: null,
    radarType: 'bc',
  };

  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--client-id' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      opts.clientId = String(argv[++i]).trim();
    } else if (a === '--since' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      opts.since = String(argv[++i]).trim();
    } else if (a === '--radar-type' && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      opts.radarType = String(argv[++i]).trim();
    }
  }

  if (opts.since && !isValidIso(opts.since)) {
    throw new Error('--since doit etre une date ISO valide');
  }
  if (opts.radarType !== 'bc' && opts.radarType !== 'mp') {
    throw new Error('--radar-type doit etre bc ou mp');
  }
  return opts;
}

function normalizeCheckpoint(value, fallback) {
  var raw = isValidIso(value) ? value : fallback;
  if (!isValidIso(raw)) raw = DEFAULT_SINCE;
  return new Date(raw).toISOString();
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) return { version: 1, clients: {} };
  try {
    var parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, clients: {} };
    if (!parsed.clients || typeof parsed.clients !== 'object') parsed.clients = {};
    parsed.version = 1;
    return parsed;
  } catch (e) {
    throw new Error('Checkpoint invalide: ' + e.message);
  }
}

function writeStateAtomic(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  var tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function buildClientsQuery(clientId) {
  var params = [
    'actif=eq.true',
    'select=id,nom',
    'order=nom.asc',
  ];
  if (clientId) params.push('id=eq.' + encodeURIComponent(clientId));
  return params.join('&');
}

async function fetchActiveClients(sbUrl, sbKey, clientId) {
  var url = sbUrl.replace(/\/$/, '') + '/rest/v1/clients?' + buildClientsQuery(clientId);
  var res = await fetch(url, {
    method: 'GET',
    headers: {
      apikey: sbKey,
      Authorization: 'Bearer ' + sbKey,
      'Content-Type': 'application/json',
    },
  });
  var text = await res.text();
  var data;
  try { data = text ? JSON.parse(text) : null; }
  catch (_e) { throw new Error('Supabase reponse non-JSON: ' + text.slice(0, 200)); }
  if (!res.ok) throw new Error('Supabase HTTP ' + res.status + ': ' + text.slice(0, 200));
  if (!Array.isArray(data)) throw new Error('Supabase clients: reponse inattendue');
  return data;
}

function buildChildArgs(clientId, since, radarType, dryRun) {
  var args = [
    ORCHESTRATOR,
    '--client-id', clientId,
    '--since', since,
    '--radar-type', radarType,
  ];
  if (dryRun) args.push('--dry-run');
  return args;
}

function runClientCycle(clientId, since, radarType, dryRun) {
  var result = spawnSync(process.execPath, buildChildArgs(clientId, since, radarType, dryRun), {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  var code = result.status !== null ? result.status : (result.error ? 1 : 0);
  return {
    ok: code === 0 && !result.error,
    code: code,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function main(argv) {
  var opts = parseArgs(argv || process.argv.slice(2));
  require('dotenv').config({ path: path.join(ROOT, '.env') });

  var sbUrl = process.env.SUPABASE_URL || '';
  var sbKey = process.env.SUPABASE_KEY || '';
  if (!sbUrl || !sbKey) throw new Error('SUPABASE_URL et SUPABASE_KEY requis');

  var state = loadState(STATE_FILE);
  var clients = await fetchActiveClients(sbUrl, sbKey, opts.clientId);
  if (!clients.length) throw new Error('Aucun client actif trouve');

  var runStartedAt = new Date().toISOString();
  var okCount = 0;
  var failed = [];

  console.log('');
  console.log('=== FEEDBACK LEARNING AUTOPILOT ===');
  console.log('clients    : ' + clients.length);
  console.log('radar-type : ' + opts.radarType);
  console.log('dry-run    : ' + opts.dryRun);
  console.log('state      : ' + STATE_FILE);

  for (var i = 0; i < clients.length; i++) {
    var client = clients[i];
    var saved = state.clients[client.id] && state.clients[client.id].since;
    var since = normalizeCheckpoint(opts.since || saved, DEFAULT_SINCE);

    console.log('');
    console.log('[CLIENT] ' + (client.nom || client.id));
    console.log('  client-id : ' + client.id);
    console.log('  since     : ' + since);

    var result = runClientCycle(client.id, since, opts.radarType, opts.dryRun);
    if (!result.ok) {
      failed.push({ client_id: client.id, client_name: client.nom || '', code: result.code });
      console.error('[AUTOPILOT] Echec client=' + client.id + ' code=' + result.code + ' checkpoint inchange');
      continue;
    }

    okCount++;
    if (!opts.dryRun) {
      state.clients[client.id] = {
        client_name: client.nom || '',
        since: runStartedAt,
        updated_at: new Date().toISOString(),
        radar_type: opts.radarType,
      };
      writeStateAtomic(STATE_FILE, state);
    }
  }

  console.log('');
  console.log('=== AUTOPILOT TERMINE ===');
  console.log('clients OK     : ' + okCount);
  console.log('clients echec  : ' + failed.length);
  if (opts.dryRun) console.log('checkpoint     : inchange (dry-run)');
  else console.log('checkpoint     : ' + STATE_FILE);

  if (failed.length) {
    failed.forEach(function(f) {
      console.log('  - ' + (f.client_name || f.client_id) + ' code=' + f.code);
    });
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs: parseArgs,
  normalizeCheckpoint: normalizeCheckpoint,
  loadState: loadState,
  buildClientsQuery: buildClientsQuery,
  buildChildArgs: buildChildArgs,
  runClientCycle: runClientCycle,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch(function(err) {
    console.error('[AUTOPILOT] ' + err.message);
    process.exit(1);
  });
}
