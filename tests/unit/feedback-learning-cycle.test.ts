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

export {};
