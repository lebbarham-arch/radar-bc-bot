/**
 * tests/unit/feedback-learning-cycle.test.ts
 *
 * CFL-1..15 -- Tests unitaires pour scripts/run-client-feedback-learning-cycle.js (GD-137)
 *
 * Module pur : pas de réseau, pas de Supabase, pas d'écriture disque.
 * Teste uniquement les fonctions exportées (parseArgs, buildSteps, extracteurs).
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  parseArgs,
  buildSteps,
  extractJsonlPath,
  extractCsvPath,
  extractDecisionsPath,
  extractStats,
} = require('../../scripts/run-client-feedback-learning-cycle');

const UUID = '15a96b88-0c98-4de9-9f66-739e3a28dafa';
const ISO  = '2026-07-05T18:00:00Z';

// ---------------------------------------------------------------------------
// CFL-1..5 -- parseArgs
// ---------------------------------------------------------------------------

describe('CFL-1..5 -- parseArgs', () => {

  test('CFL-1: args complets -> parsing correct', () => {
    const opts = parseArgs(['--client-id', UUID, '--since', ISO]);
    expect(opts.clientId).toBe(UUID);
    expect(opts.since).toBe(ISO);
    expect(opts.radarType).toBe('bc');
    expect(opts.dryRun).toBe(false);
    expect(opts.error).toBeNull();
  });

  test('CFL-2: --client-id manquant -> error', () => {
    const opts = parseArgs(['--since', ISO]);
    expect(opts.error).not.toBeNull();
    expect(opts.error).toContain('--client-id');
  });

  test('CFL-3: --since manquant -> error', () => {
    const opts = parseArgs(['--client-id', UUID]);
    expect(opts.error).not.toBeNull();
    expect(opts.error).toContain('--since');
  });

  test('CFL-4: --dry-run -> dryRun=true', () => {
    const opts = parseArgs(['--client-id', UUID, '--since', ISO, '--dry-run']);
    expect(opts.dryRun).toBe(true);
    expect(opts.error).toBeNull();
  });

  test('CFL-5: --radar-type mp -> radarType=mp', () => {
    const opts = parseArgs(['--client-id', UUID, '--since', ISO, '--radar-type', 'mp']);
    expect(opts.radarType).toBe('mp');
    expect(opts.error).toBeNull();
  });

  test('CFL-5b: args vides -> error sur --client-id', () => {
    const opts = parseArgs([]);
    expect(opts.error).not.toBeNull();
    expect(opts.error).toContain('--client-id');
  });
});

// ---------------------------------------------------------------------------
// CFL-6..9 -- buildSteps
// ---------------------------------------------------------------------------

describe('CFL-6..9 -- buildSteps', () => {

  const BASE_OPTS = { clientId: UUID, since: ISO, radarType: 'bc', dryRun: false };

  test('CFL-6: buildSteps retourne exactement 5 étapes', () => {
    const steps = buildSteps(BASE_OPTS);
    expect(steps).toHaveLength(5);
  });

  test('CFL-7: --dry-run propagé dans les étapes 1 et 5', () => {
    const steps = buildSteps({ ...BASE_OPTS, dryRun: true });
    // Étape 1 (export) doit contenir --dry-run
    expect(steps[0].args).toContain('--dry-run');
    // Étape 5 (build-hints) doit contenir --dry-run
    expect(steps[4].args).toContain('--dry-run');
  });

  test('CFL-7b: sans --dry-run, aucun step ne contient --dry-run', () => {
    const steps = buildSteps(BASE_OPTS);
    steps.forEach((s: any) => {
      expect(s.args).not.toContain('--dry-run');
    });
  });

  test('CFL-8: étape 1 contient --client-id et l\'UUID', () => {
    const steps = buildSteps(BASE_OPTS);
    const step1 = steps[0];
    expect(step1.args).toContain('--client-id');
    expect(step1.args).toContain(UUID);
  });

  test('CFL-9: étape 1 contient --since et la date', () => {
    const steps = buildSteps(BASE_OPTS);
    const step1 = steps[0];
    expect(step1.args).toContain('--since');
    expect(step1.args).toContain(ISO);
  });

  test('CFL-9b: étape 1 contient --radar-type mp quand spécifié', () => {
    const steps = buildSteps({ ...BASE_OPTS, radarType: 'mp' });
    expect(steps[0].args).toContain('--radar-type');
    expect(steps[0].args).toContain('mp');
  });

  test('CFL-9c: étape 3 (import) contient --review-source client', () => {
    const steps = buildSteps(BASE_OPTS);
    const step3 = steps[2];
    expect(step3.args).toContain('--review-source');
    expect(step3.args).toContain('client');
  });

  test('CFL-9d: étapes ont les noms attendus', () => {
    const steps = buildSteps(BASE_OPTS);
    expect(steps[0].name).toBe('export-feedback');
    expect(steps[1].name).toBe('convert-to-csv');
    expect(steps[2].name).toBe('import-decisions');
    expect(steps[3].name).toBe('analyze-learning');
    expect(steps[4].name).toBe('build-hints');
  });

  test('CFL-9e: chaque étape a un champ script valide', () => {
    const steps = buildSteps(BASE_OPTS);
    steps.forEach((s: any) => {
      expect(typeof s.script).toBe('string');
      expect(s.script.length).toBeGreaterThan(0);
      expect(s.script.endsWith('.js')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// CFL-10..11 -- extractJsonlPath / extractCsvPath
// ---------------------------------------------------------------------------

describe('CFL-10..11 -- extractJsonlPath / extractCsvPath', () => {

  test('CFL-10a: extractJsonlPath depuis stdout complet', () => {
    const stdout = [
      '=== Resume ===',
      'Total recupere Supabase     : 5',
      'Total exporte               : 5',
      '',
      '[OK] JSONL ecrit : /home/user/project/data/feedback/feedback-events-client-2026-07-05T18-00-00.jsonl',
    ].join('\n');
    const result = extractJsonlPath(stdout);
    expect(result).toBe('/home/user/project/data/feedback/feedback-events-client-2026-07-05T18-00-00.jsonl');
  });

  test('CFL-10b: extractJsonlPath stdout sans chemin -> null', () => {
    const result = extractJsonlPath('[dry-run] Aucun fichier ecrit.');
    expect(result).toBeNull();
  });

  test('CFL-10c: extractJsonlPath strip les espaces en fin', () => {
    const result = extractJsonlPath('[OK] JSONL ecrit : /path/to/file.jsonl   ');
    expect(result).toBe('/path/to/file.jsonl');
  });

  test('CFL-11a: extractCsvPath depuis stdout complet', () => {
    const stdout = [
      'Input         : /path/to/input.jsonl',
      'Output        : /path/to/review-candidates-feedback-2026-07-05.csv',
      '',
      '[OK] CSV ecrit : /path/to/review-candidates-feedback-2026-07-05.csv',
    ].join('\n');
    const result = extractCsvPath(stdout);
    expect(result).toBe('/path/to/review-candidates-feedback-2026-07-05.csv');
  });

  test('CFL-11b: extractCsvPath stdout sans chemin -> null', () => {
    expect(extractCsvPath('aucune ligne OK ici')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CFL-12 -- extractDecisionsPath
// ---------------------------------------------------------------------------

describe('CFL-12 -- extractDecisionsPath', () => {

  test('CFL-12a: chemin standard "JSON ecrit : <path>"', () => {
    const stdout = '\nJSON ecrit : /path/to/review-decisions-2026-07-05T18-00-00-000Z.json\n';
    expect(extractDecisionsPath(stdout)).toBe('/path/to/review-decisions-2026-07-05T18-00-00-000Z.json');
  });

  test('CFL-12b: chemin fallback "JSON ecrit (fallback) : <path>"', () => {
    const stdout = '\nJSON ecrit (fallback) : /tmp/review-decisions-fallback.json\n';
    expect(extractDecisionsPath(stdout)).toBe('/tmp/review-decisions-fallback.json');
  });

  test('CFL-12c: dry-run stdout -> null', () => {
    expect(extractDecisionsPath('[DRY-RUN] Aucun fichier ecrit.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CFL-13..15 -- extractStats
// ---------------------------------------------------------------------------

describe('CFL-13..15 -- extractStats', () => {

  test('CFL-13a: extractStats fetched et exported depuis export stdout', () => {
    const stdout = [
      '=== Resume ===',
      'Total recupere Supabase     : 12',
      'Total exporte               : 10',
      'Exclus non numeriques       : 2',
    ].join('\n');
    const stats = extractStats(stdout);
    expect(stats.fetched).toBe(12);
    expect(stats.exported).toBe(10);
  });

  test('CFL-13b: fetched manquant -> null', () => {
    const stats = extractStats('Total exporte               : 5');
    expect(stats.fetched).toBeNull();
    expect(stats.exported).toBe(5);
  });

  test('CFL-14a: extractStats keep/reject/ignore depuis import stdout', () => {
    const stdout = [
      '=== Import Review Decisions ===',
      'Total         : 10',
      'keep     : 7',
      'reject   : 2',
      'ignore   : 1',
      'vide     : 0',
    ].join('\n');
    const stats = extractStats(stdout);
    expect(stats.keep).toBe(7);
    expect(stats.reject).toBe(2);
    expect(stats.ignore).toBe(1);
  });

  test('CFL-14b: aucune stat -> tous null', () => {
    const stats = extractStats('Aucune donnee ici.');
    expect(stats.fetched).toBeNull();
    expect(stats.exported).toBeNull();
    expect(stats.keep).toBeNull();
    expect(stats.reject).toBeNull();
    expect(stats.ignore).toBeNull();
  });

  test('CFL-15: extractStats stdout combiné export + import', () => {
    const stdout = [
      'Total recupere Supabase     : 8',
      'Total exporte               : 8',
      'keep     : 6',
      'reject   : 1',
      'ignore   : 1',
    ].join('\n');
    const stats = extractStats(stdout);
    expect(stats.fetched).toBe(8);
    expect(stats.exported).toBe(8);
    expect(stats.keep).toBe(6);
    expect(stats.reject).toBe(1);
    expect(stats.ignore).toBe(1);
  });
});

// --------
// ---------------------------------------------------------------------------
// CFL-16..25 -- Idempotency GD-138
// makeEventKey, readJsonlEvents, loadKnownEventKeys, filterNewEvents
// ---------------------------------------------------------------------------

const {
  makeEventKey,
  readJsonlEvents,
  loadKnownEventKeys,
  filterNewEvents,
} = require('../../scripts/run-client-feedback-learning-cycle');

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// CFL-16 -- makeEventKey
// ---------------------------------------------------------------------------

describe('CFL-16 -- makeEventKey', () => {
  test('CFL-16a: cle stable a partir des 6 champs', () => {
    const event = {
      client_id:  'abc-123',
      item_id:    'item-999',
      radar_type: 'bc',
      critere:    'nettoyage',
      type:       'reject',
      created_at: '2026-07-05T18:00:00Z',
    };
    const key = makeEventKey(event);
    expect(key).toBe('abc-123|item-999|bc|nettoyage|reject|2026-07-05T18:00:00Z');
  });

  test('CFL-16b: champs manquants -> chaines vides dans la cle', () => {
    const key = makeEventKey({ client_id: 'x' });
    expect(key).toBe('x|||||');
  });

  test('CFL-16c: deux events identiques -> meme cle', () => {
    const e1 = { client_id: 'a', item_id: 'b', radar_type: 'bc', critere: 'c', type: 'd', created_at: 'e' };
    const e2 = { ...e1 };
    expect(makeEventKey(e1)).toBe(makeEventKey(e2));
  });

  test('CFL-16d: champ different -> cles differentes', () => {
    const e1 = { client_id: 'a', item_id: 'b', radar_type: 'bc', critere: 'c', type: 'd', created_at: 'e' };
    const e2 = { ...e1, critere: 'x' };
    expect(makeEventKey(e1)).not.toBe(makeEventKey(e2));
  });

  test('CFL-16e: event vide -> cle avec 5 pipes uniquement', () => {
    const key = makeEventKey({});
    expect(key).toBe('|||||');
    expect((key.match(/\|/g) || []).length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// CFL-17 -- readJsonlEvents
// ---------------------------------------------------------------------------

describe('CFL-17 -- readJsonlEvents', () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), 'test-events-' + Date.now() + '.jsonl');
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  });

  test('CFL-17a: fichier inexistant -> tableau vide', () => {
    const events = readJsonlEvents('/tmp/inexistant-xyz-' + Date.now() + '.jsonl');
    expect(events).toEqual([]);
  });

  test('CFL-17b: fichier JSONL valide -> events parseables', () => {
    const e1 = { client_id: 'a', item_id: '1', radar_type: 'bc', critere: 'x', type: 'reject', created_at: '2026-01-01' };
    const e2 = { client_id: 'b', item_id: '2', radar_type: 'bc', critere: 'y', type: 'keep',   created_at: '2026-01-02' };
    fs.writeFileSync(tmpFile, JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n', 'utf8');
    const events = readJsonlEvents(tmpFile);
    expect(events).toHaveLength(2);
    expect(events[0].client_id).toBe('a');
    expect(events[1].client_id).toBe('b');
  });

  test('CFL-17c: ligne JSON invalide ignoree, autres parsees', () => {
    const e1 = { client_id: 'a', item_id: '1', radar_type: 'bc', critere: 'x', type: 'r', created_at: 't' };
    fs.writeFileSync(tmpFile, JSON.stringify(e1) + '\n' + 'INVALID_JSON\n', 'utf8');
    const events = readJsonlEvents(tmpFile);
    expect(events).toHaveLength(1);
    expect(events[0].client_id).toBe('a');
  });

  test('CFL-17d: fichier vide -> tableau vide', () => {
    fs.writeFileSync(tmpFile, '', 'utf8');
    const events = readJsonlEvents(tmpFile);
    expect(events).toEqual([]);
  });

  test('CFL-17e: lignes vides ignorees', () => {
    const e1 = { client_id: 'z', item_id: '9', radar_type: 'bc', critere: 'q', type: 'k', created_at: 'T' };
    fs.writeFileSync(tmpFile, '\n\n' + JSON.stringify(e1) + '\n\n', 'utf8');
    const events = readJsonlEvents(tmpFile);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CFL-18 -- loadKnownEventKeys
// ---------------------------------------------------------------------------

describe('CFL-18 -- loadKnownEventKeys', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
  });

  test('CFL-18a: dossier vide -> Set vide', () => {
    const keys = loadKnownEventKeys(tmpDir, null);
    expect(keys.size).toBe(0);
  });

  test('CFL-18b: un fichier JSONL -> cles chargees', () => {
    const e = { client_id: 'c1', item_id: 'i1', radar_type: 'bc', critere: 'nc', type: 'r', created_at: 'T' };
    const fpath = path.join(tmpDir, 'feedback-events-client-2026-01-01.jsonl');
    fs.writeFileSync(fpath, JSON.stringify(e) + '\n', 'utf8');
    const keys = loadKnownEventKeys(tmpDir, null);
    expect(keys.size).toBe(1);
    expect(keys.has(makeEventKey(e))).toBe(true);
  });

  test('CFL-18c: excludePath exclut le fichier du scan', () => {
    const e = { client_id: 'c2', item_id: 'i2', radar_type: 'bc', critere: 'nc', type: 'r', created_at: 'T' };
    const fpath = path.join(tmpDir, 'feedback-events-client-2026-01-02.jsonl');
    fs.writeFileSync(fpath, JSON.stringify(e) + '\n', 'utf8');
    const keys = loadKnownEventKeys(tmpDir, fpath);
    expect(keys.size).toBe(0);
  });

  test('CFL-18d: fichiers non-JSONL ignores', () => {
    fs.writeFileSync(path.join(tmpDir, 'other-file.txt'), '{}', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'review-decisions.json'), '{}', 'utf8');
    const keys = loadKnownEventKeys(tmpDir, null);
    expect(keys.size).toBe(0);
  });

  test('CFL-18e: deux fichiers JSONL -> union des cles', () => {
    const e1 = { client_id: 'c1', item_id: 'i1', radar_type: 'bc', critere: 'a', type: 'r', created_at: 'T1' };
    const e2 = { client_id: 'c2', item_id: 'i2', radar_type: 'bc', critere: 'b', type: 'k', created_at: 'T2' };
    fs.writeFileSync(path.join(tmpDir, 'feedback-events-client-2026-01-01.jsonl'), JSON.stringify(e1) + '\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'feedback-events-client-2026-01-02.jsonl'), JSON.stringify(e2) + '\n', 'utf8');
    const keys = loadKnownEventKeys(tmpDir, null);
    expect(keys.size).toBe(2);
    expect(keys.has(makeEventKey(e1))).toBe(true);
    expect(keys.has(makeEventKey(e2))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CFL-19 -- filterNewEvents
// ---------------------------------------------------------------------------

describe('CFL-19 -- filterNewEvents', () => {
  test('CFL-19a: aucun connu -> tous retournes', () => {
    const events = [
      { client_id: 'a', item_id: '1', radar_type: 'bc', critere: 'x', type: 'r', created_at: 'T' },
      { client_id: 'b', item_id: '2', radar_type: 'bc', critere: 'y', type: 'k', created_at: 'T' },
    ];
    const fresh = filterNewEvents(events, new Set());
    expect(fresh).toHaveLength(2);
  });

  test('CFL-19b: tous connus -> tableau vide', () => {
    const e = { client_id: 'a', item_id: '1', radar_type: 'bc', critere: 'x', type: 'r', created_at: 'T' };
    const keys = new Set([makeEventKey(e)]);
    const fresh = filterNewEvents([e], keys);
    expect(fresh).toHaveLength(0);
  });

  test('CFL-19c: mix connus/nouveaux -> seulement les nouveaux', () => {
    const eOld = { client_id: 'a', item_id: '1', radar_type: 'bc', critere: 'x', type: 'r', created_at: 'T1' };
    const eNew = { client_id: 'a', item_id: '2', radar_type: 'bc', critere: 'x', type: 'r', created_at: 'T2' };
    const keys = new Set([makeEventKey(eOld)]);
    const fresh = filterNewEvents([eOld, eNew], keys);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].item_id).toBe('2');
  });

  test('CFL-19d: events vides -> tableau vide', () => {
    const fresh = filterNewEvents([], new Set(['key1', 'key2']));
    expect(fresh).toHaveLength(0);
  });
});

export {};
