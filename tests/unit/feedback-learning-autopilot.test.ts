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

  test('separe les checkpoints bc et mp', () => {
    expect(autopilot.buildStateKey('client-1', 'bc')).toBe('client-1|bc');
    expect(autopilot.buildStateKey('client-1', 'mp')).toBe('client-1|mp');
  });
});

describe('feedback learning autopilot - requetes', () => {
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

  test('feedback query reste read-only et cible web_click', () => {
    const query = decodeURIComponent(autopilot.buildFeedbackQuery('client-1', 'bc', 0));
    expect(query).toContain('client_id=eq.client-1');
    expect(query).toContain('radar_type=eq.bc');
    expect(query).toContain('source=eq.web_click');
    expect(query).toContain('select=id,client_id,item_id');
    expect(query).not.toContain('insert');
    expect(query).not.toContain('update');
    expect(query).not.toContain('delete');
  });
});

describe('feedback learning autopilot - reconciliation historique', () => {
  const baseEvent = {
    client_id: 'client-1',
    item_id: '368767',
    radar_type: 'bc',
    critere: 'nettoyage',
    source: 'web_click',
    created_at: '2026-07-22T22:00:00Z',
  };

  test('mappe les trois types vers les decisions attendues', () => {
    expect(autopilot.feedbackDecisionKey({ ...baseEvent, type: 'relevant' }))
      .toBe('client-1|368767|keep');
    expect(autopilot.feedbackDecisionKey({ ...baseEvent, type: 'irrelevant' }))
      .toBe('client-1|368767|reject');
    expect(autopilot.feedbackDecisionKey({ ...baseEvent, type: 'watch' }))
      .toBe('client-1|368767|ignore');
  });

  test('selectionne seulement les feedbacks deja importes', () => {
    const events = [
      { ...baseEvent, item_id: '100', type: 'relevant' },
      { ...baseEvent, item_id: '200', type: 'irrelevant' },
      { ...baseEvent, item_id: '300', type: 'watch' },
    ];
    const imported = new Set([
      'client-1|100|keep',
      'client-1|300|ignore',
    ]);
    const selected = autopilot.selectBootstrapEvents(events, imported);
    expect(selected.map((e: any) => e.item_id)).toEqual(['100', '300']);
  });

  test('un changement de decision reste nouveau', () => {
    const events = [{ ...baseEvent, item_id: '100', type: 'irrelevant' }];
    const imported = new Set(['client-1|100|keep']);
    expect(autopilot.selectBootstrapEvents(events, imported)).toHaveLength(0);
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
