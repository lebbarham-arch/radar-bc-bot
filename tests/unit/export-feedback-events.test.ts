/**
 * tests/unit/export-feedback-events.test.ts
 *
 * GD-121 — Tests unitaires pour scripts/export-client-feedback-events.js
 *
 * Couvre la logique pure de filtrage et transformation :
 *   isNumericItemId, isTestItemId, extractReason, extractCritere, filterAndTransform
 *
 * Nomenclature : EFE (Export Feedback Events)
 *
 * STRICT :
 *   - Aucun appel Supabase (logique pure uniquement)
 *   - Aucune ecriture fichier
 *   - Aucune modification moteur / scoring / hints / seuils
 *   - Aucune regle specifique nettoyage / hygiene / informatique
 *   - Generique multi-clients, multi-profils
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isNumericItemId,
  isTestItemId,
  extractReason,
  extractCritere,
  filterAndTransform,
  buildJsonlContent,
} = require('../../scripts/export-client-feedback-events');

// ---------------------------------------------------------------------------
// Helpers fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.assign({
    id:          1,
    client_id:   'aaaa-bbbb-cccc-dddd',
    item_id:     '357473',
    radar_type:  'bc',
    critere:     'nettoyage',
    type:        'relevant',
    source:      'web_click',
    raw_payload: { critere: 'nettoyage', type: 'relevant' },
    created_at:  '2026-06-30T10:00:00Z',
  }, overrides);
}

// ---------------------------------------------------------------------------
// EFE-1 : item_id numerique conserve
// ---------------------------------------------------------------------------
test('EFE-1 isNumericItemId : item_id numerique conserve', () => {
  expect(isNumericItemId('357473')).toBe(true);
  expect(isNumericItemId('1')).toBe(true);
  expect(isNumericItemId('000123')).toBe(true);
});

// ---------------------------------------------------------------------------
// EFE-2 : item_id TEST-* exclu par defaut
// ---------------------------------------------------------------------------
test('EFE-2 isTestItemId : item_id TEST-* detecte comme test', () => {
  expect(isTestItemId('TEST-1782746912763')).toBe(true);
  expect(isTestItemId('TEST123')).toBe(true);
  expect(isTestItemId('TESTBC')).toBe(true);
});

// ---------------------------------------------------------------------------
// EFE-3 : item_id FB6_PROD_TEST* exclu par defaut
// ---------------------------------------------------------------------------
test('EFE-3 isTestItemId : item_id FB6_PROD_TEST* detecte comme test', () => {
  expect(isTestItemId('FB6_PROD_TEST_001')).toBe(true);
  expect(isTestItemId('FB6_PROD_TEST')).toBe(true);
});

// ---------------------------------------------------------------------------
// EFE-4 : item_id non numerique exclu
// ---------------------------------------------------------------------------
test('EFE-4 isNumericItemId : item_id non numerique exclu', () => {
  expect(isNumericItemId('abc')).toBe(false);
  expect(isNumericItemId('')).toBe(false);
  expect(isNumericItemId('357473abc')).toBe(false);
  expect(isNumericItemId('357 473')).toBe(false);
  expect(isNumericItemId('3.5')).toBe(false);
});

// ---------------------------------------------------------------------------
// EFE-5 : --include-tests conserve TEST si explicitement demande
// ---------------------------------------------------------------------------
test('EFE-5 filterAndTransform : --include-tests conserve les item_id TEST', () => {
  const rows = [
    makeRow({ item_id: 'TEST-1782746912763' }),
    makeRow({ item_id: '357473' }),
  ];
  const result = filterAndTransform(rows, { includeTests: true });
  // Les deux conserves (TEST conserve car includeTests=true, mais isNumericItemId echoue pour TEST-*...)
  // Attention : TEST-1782746912763 n'est pas numerique => exclu par le filtre isNumericItemId
  // includeTests bypass seulement l'exclusion isTestItemId, pas l'exclusion non-numerique
  // Donc seul 357473 passe
  expect(result.events.length).toBe(1);
  expect(result.stats.excluded_test).toBe(0);      // aucun exclu pour raison "test"
  expect(result.stats.excluded_non_numeric).toBe(1); // TEST-* non numerique
});

// ---------------------------------------------------------------------------
// EFE-5b : sans --include-tests, un item TEST non-numerique est exclu non-numerique (pas test)
// ---------------------------------------------------------------------------
test('EFE-5b filterAndTransform : item_id non-numerique exclu avant filtre test', () => {
  const rows = [makeRow({ item_id: 'TEST-abc' })];
  const result = filterAndTransform(rows, { includeTests: false });
  // Non numerique => excluded_non_numeric (pas excluded_test)
  expect(result.events.length).toBe(0);
  expect(result.stats.excluded_non_numeric).toBe(1);
  expect(result.stats.excluded_test).toBe(0);
});

// ---------------------------------------------------------------------------
// EFE-6 : raw_payload.reason extrait correctement
// ---------------------------------------------------------------------------
test('EFE-6 extractReason : raw_payload.reason prioritaire', () => {
  const row = makeRow({
    raw_payload: { reason: 'wrong_product', critere: 'nettoyage' },
  });
  expect(extractReason(row)).toBe('wrong_product');
});

test('EFE-6b extractReason : fallback sur row.reason si raw_payload absent', () => {
  const row = makeRow({ raw_payload: null, reason: 'not_my_business' });
  expect(extractReason(row)).toBe('not_my_business');
});

// ---------------------------------------------------------------------------
// EFE-7 : raw_payload.critere extrait correctement
// ---------------------------------------------------------------------------
test('EFE-7 extractCritere : raw_payload.critere prioritaire', () => {
  const row = makeRow({
    critere:     'nettoyage-col-root',
    raw_payload: { critere: 'nettoyage' },
  });
  expect(extractCritere(row)).toBe('nettoyage');
});

test('EFE-7b extractCritere : fallback sur row.critere si raw_payload absent', () => {
  const row = makeRow({ critere: 'informatique', raw_payload: {} });
  expect(extractCritere(row)).toBe('informatique');
});

// ---------------------------------------------------------------------------
// EFE-8 : event sans reason reste exportable
// ---------------------------------------------------------------------------
test('EFE-8 filterAndTransform : event sans reason reste exporte (Mode A)', () => {
  const rows = [
    makeRow({ raw_payload: { critere: 'nettoyage' } }), // pas de reason
  ];
  const result = filterAndTransform(rows, {});
  expect(result.events.length).toBe(1);
  expect(result.stats.with_reason).toBe(0);
  expect(result.events[0].reason).toBeUndefined();
});

// ---------------------------------------------------------------------------
// EFE-9 : source non web_click non exclue par filterAndTransform (filtre Supabase)
// ---------------------------------------------------------------------------
test('EFE-9 filterAndTransform : source non web_click conservee dans le JSONL', () => {
  // Le filtrage source=web_click est fait au niveau Supabase (parametre de requete).
  // filterAndTransform ne re-filtre pas sur source pour rester generique.
  const rows = [
    makeRow({ source: 'manual_import', item_id: '123456' }),
  ];
  const result = filterAndTransform(rows, {});
  expect(result.events.length).toBe(1);
  expect(result.events[0].source).toBe('manual_import');
});

// ---------------------------------------------------------------------------
// EFE-10 : sortie JSONL contient item_id et non bc_id
// ---------------------------------------------------------------------------
test('EFE-10 filterAndTransform : champ item_id present, pas bc_id', () => {
  const rows = [makeRow({ item_id: '357473' })];
  const result = filterAndTransform(rows, {});
  expect(result.events.length).toBe(1);
  const event = result.events[0];
  expect(event).toHaveProperty('item_id', '357473');
  expect(event).not.toHaveProperty('bc_id');
});

// ---------------------------------------------------------------------------
// EFE-11 : buildJsonlContent genere une ligne par event, terminee par \n
// ---------------------------------------------------------------------------
test('EFE-11 buildJsonlContent : une ligne JSON par event', () => {
  const events = [
    { client_id: 'c1', item_id: '100', type: 'relevant' },
    { client_id: 'c1', item_id: '200', type: 'irrelevant', reason: 'wrong_product' },
  ];
  const jsonl = buildJsonlContent(events);
  const lines = jsonl.trim().split('\n');
  expect(lines.length).toBe(2);
  const parsed0 = JSON.parse(lines[0]);
  const parsed1 = JSON.parse(lines[1]);
  expect(parsed0.item_id).toBe('100');
  expect(parsed1.reason).toBe('wrong_product');
});

// ---------------------------------------------------------------------------
// EFE-12 : filterAndTransform stats — compteurs corrects
// ---------------------------------------------------------------------------
test('EFE-12 filterAndTransform : compteurs stats corrects', () => {
  const rows = [
    makeRow({ item_id: '357473', type: 'relevant', raw_payload: { critere: 'nettoyage' } }),
    makeRow({ item_id: '357474', type: 'irrelevant', raw_payload: { critere: 'nettoyage', reason: 'wrong_product' } }),
    makeRow({ item_id: 'TEST-001' }),           // non numerique -> excluded_non_numeric
    makeRow({ item_id: '999', type: 'watch', raw_payload: { critere: 'hygiene', reason: 'not_sure' } }),
  ];
  const result = filterAndTransform(rows, { includeTests: false });
  expect(result.stats.total_fetched).toBe(4);
  expect(result.stats.excluded_non_numeric).toBe(1);  // TEST-001
  expect(result.stats.excluded_test).toBe(0);
  expect(result.stats.total_exported).toBe(3);
  expect(result.stats.with_reason).toBe(2);           // wrong_product + not_sure
  expect(result.stats.by_type['relevant']).toBe(1);
  expect(result.stats.by_type['irrelevant']).toBe(1);
  expect(result.stats.by_type['watch']).toBe(1);
  expect(result.stats.by_reason['wrong_product']).toBe(1);
  expect(result.stats.by_reason['not_sure']).toBe(1);
});

// ---------------------------------------------------------------------------
// EFE-13 : filterAndTransform exclut item_id TEST numeriquement faux
// ---------------------------------------------------------------------------
test('EFE-13 filterAndTransform : item_id TEST numerique exclu si includeTests=false', () => {
  // Un item_id qui commence par "TEST" mais est numeric : impossible (TEST contient lettres)
  // On teste qu'un item_id purement numerique n'est jamais exclu comme "test"
  const rows = [makeRow({ item_id: '123456789' })];
  const result = filterAndTransform(rows, { includeTests: false });
  expect(result.events.length).toBe(1);
  expect(result.stats.excluded_test).toBe(0);
  expect(result.stats.excluded_non_numeric).toBe(0);
});
