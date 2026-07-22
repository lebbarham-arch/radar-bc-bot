/*
 * Tests purs du pilote multi-clients feedback learning.
 * Aucun reseau, aucune ecriture Supabase, aucun scan, aucune notification.
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const autopilot = require('../../scripts/run-feedback-learning-cycle');

describe('feedback learning autopilot - arguments', () => {
  test('valeurs par defaut', () => {
    expect(autopilot.parseArgs([])).toEqual({
      dryRun: false,
      clientId: null,
      since: null,
      radarType: 'bc',
    });
  });

  test('options explicites', () => {
    expect(autopilot.parseArgs([
      '--dry-run',
      '--client-id', 'client-1',
      '--since', '2026-07-01T00:00:00Z',
      '--radar-type', 'mp',
    ])).toEqual({
      dryRun: true,
      clientId: 'client-1',
      since: '2026-07-01T00:00:00Z',
      radarType: 'mp',
    });
  });

  test('date invalide refusee', () => {
    expect(() => autopilot.parseArgs(['--since', 'pas-une-date'])).toThrow(/date ISO/);
  });

  test('radar-type invalide refuse', () => {
    expect(() => autopilot.parseArgs(['--radar-type', 'autre'])).toThrow(/bc ou mp/);
  });
});

describe('feedback learning autopilot - checkpoint', () => {
  test('normalise une date valide', () => {
    expect(autopilot.normalizeCheckpoint('2026-07-01T00:00:00Z', null))
      .toBe('2026-07-01T00:00:00.000Z');
  });

  test('utilise le fallback', () => {
    expect(autopilot.normalizeCheckpoint(null, '2026-06-01T00:00:00Z'))
      .toBe('2026-06-01T00:00:00.000Z');
  });

  test('fallback ultime epoch', () => {
    expect(autopilot.normalizeCheckpoint(null, null))
      .toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('feedback learning autopilot - requete clients', () => {
  test('liste tous les clients actifs par defaut', () => {
    const query = decodeURIComponent(autopilot.buildClientsQuery(null));
    expect(query).toContain('actif=eq.true');
    expect(query).toContain('select=id,nom');
    expect(query).toContain('order=nom.asc');
    expect(query).not.toContain('id=eq.');
  });

  test('filtre un client explicite', () => {
    const query = decodeURIComponent(autopilot.buildClientsQuery('client-1'));
    expect(query).toContain('id=eq.client-1');
  });
});

describe('feedback learning autopilot - delegation unique', () => {
  test('construit les arguments de l orchestrateur existant', () => {
    const args = autopilot.buildChildArgs(
      'client-1',
      '2026-07-01T00:00:00.000Z',
      'bc',
      false,
    );
    expect(args[0]).toMatch(/run-client-feedback-learning-cycle\.js$/);
    expect(args).toEqual(expect.arrayContaining([
      '--client-id', 'client-1',
      '--since', '2026-07-01T00:00:00.000Z',
      '--radar-type', 'bc',
    ]));
    expect(args).not.toContain('--dry-run');
  });

  test('propage dry-run', () => {
    const args = autopilot.buildChildArgs(
      'client-1',
      '2026-07-01T00:00:00.000Z',
      'bc',
      true,
    );
    expect(args).toContain('--dry-run');
  });
});
