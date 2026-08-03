/*
 * Delivery policy for the runtime notification quality gate.
 * Ambiguous matches are retained for review and are not delivered.
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gate = require('../../core/scoring/notification-quality-gate.runtime.js');

describe('notification quality delivery policy', () => {
  test('holds an ambiguous nettoyage mention for review', () => {
    const result = gate.checkNotificationQuality({
      critere_valeur: 'nettoyage',
      objet: 'Travaux de reparation de batiment avec nettoyage final',
      bodyText: '',
      matched_terms: ['nettoyage'],
      radar_type: 'bc',
      is_cancelled: false,
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('Revue requise');
  });

  test('allows nettoyage with strong business context', () => {
    const result = gate.checkNotificationQuality({
      critere_valeur: 'nettoyage',
      objet: "Achat de produits d entretien et d hygiene",
      bodyText: '',
      matched_terms: ['nettoyage'],
      radar_type: 'bc',
      is_cancelled: false,
    });

    expect(result.decision).toBe('allow');
  });

  test('allows informatique with strong technical context', () => {
    const result = gate.checkNotificationQuality({
      critere_valeur: 'informatique',
      objet: 'Achat de materiel informatique et serveurs',
      bodyText: '',
      matched_terms: ['informatique'],
      radar_type: 'bc',
      is_cancelled: false,
    });

    expect(result.decision).toBe('allow');
  });

  test('holds an empty object for review', () => {
    const result = gate.checkNotificationQuality({
      critere_valeur: 'photocopieur',
      objet: '',
      bodyText: '',
      matched_terms: [],
      radar_type: 'bc',
      is_cancelled: false,
    });

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('Revue requise');
  });
});
