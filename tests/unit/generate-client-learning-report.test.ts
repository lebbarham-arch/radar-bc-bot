/**
 * tests/unit/generate-client-learning-report.test.ts
 *
 * CLR-1..30 -- Tests unitaires pour scripts/generate-client-learning-report.js (GD-139)
 *
 * Module pur : pas de reseau, pas de Supabase, pas de process.env.
 * Toutes les fonctions travaillent sur des fixtures en memoire
 * ou sur des fichiers temporaires.
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  matchesClient,
  aggregateClientSignals,
  lookupClientHint,
  generateSignalRecommendation,
  formatSignalRow,
  generateReport,
  runReport,
  loadReviewDecisions,
} = require('../../scripts/generate-client-learning-report');

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';

const UUID = '15a96b88-0c98-4de9-9f66-739e3a28dafa';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RECORDS_UUID = [
  { client: UUID,                  signal: 'nettoyage', decision: 'reject' },
  { client: UUID,                  signal: 'nettoyage', decision: 'reject' },
  { client: UUID,                  signal: 'nettoyage', decision: 'keep'   },
  { client: 'autre-client',        signal: 'informatique', decision: 'keep' },
];

const RECORDS_NAMED = [
  { client: 'TEST PROD - Nettoyage', signal: 'nettoyage', decision: 'keep'   },
  { client: 'TEST PROD - Nettoyage', signal: 'nettoyage', decision: 'reject' },
  { client: 'TEST PROD - Nettoyage', signal: 'hygiene',   decision: 'ignore' },
];

const HINT_DEMOTE = {
  client: UUID,
  signals: [
    {
      signal: 'nettoyage',
      recommended_effect: 'demote_to_review',
      score_adjustment: -3,
      block_auto_notify: true,
      sources: ['client'],
      cycles_count: 2,
    },
  ],
};

const HINT_BOOST = {
  client: 'client-informatique',
  signals: [
    {
      signal: 'informatique',
      recommended_effect: 'boost',
      score_adjustment: 5,
      block_auto_notify: false,
      sources: ['operator'],
      cycles_count: 3,
    },
  ],
};

const HINTS_DATA_MULTI = {
  clients: [HINT_DEMOTE, HINT_BOOST],
};

// ---------------------------------------------------------------------------
// CLR-1..4 -- matchesClient
// ---------------------------------------------------------------------------

describe('CLR-1..4 -- matchesClient', () => {
  test('CLR-1: UUID exact -> true', () => {
    expect(matchesClient(UUID, UUID)).toBe(true);
  });

  test('CLR-2: nom exact -> true', () => {
    expect(matchesClient('TEST PROD - Nettoyage', 'TEST PROD - Nettoyage')).toBe(true);
  });

  test('CLR-3: insensible a la casse -> true', () => {
    expect(matchesClient('test prod - nettoyage', 'TEST PROD - Nettoyage')).toBe(true);
  });

  test('CLR-4: client different -> false', () => {
    expect(matchesClient('autre-client', UUID)).toBe(false);
  });

  test('CLR-4b: client null -> false', () => {
    expect(matchesClient(null, UUID)).toBe(false);
  });

  test('CLR-4c: clientIdOrName null -> false', () => {
    expect(matchesClient(UUID, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLR-5..9 -- aggregateClientSignals
// ---------------------------------------------------------------------------

describe('CLR-5..9 -- aggregateClientSignals', () => {
  test('CLR-5: agregation keep/reject par signal pour UUID', () => {
    const agg = aggregateClientSignals(RECORDS_UUID, UUID);
    expect(agg['nettoyage']).toBeDefined();
    expect(agg['nettoyage'].keep).toBe(1);
    expect(agg['nettoyage'].reject).toBe(2);
    expect(agg['nettoyage'].ignore).toBe(0);
    expect(agg['nettoyage'].total).toBe(3);
  });

  test('CLR-6: autre client exclu', () => {
    const agg = aggregateClientSignals(RECORDS_UUID, UUID);
    expect(agg['informatique']).toBeUndefined();
  });

  test('CLR-7: agregation par nom de client', () => {
    const agg = aggregateClientSignals(RECORDS_NAMED, 'TEST PROD - Nettoyage');
    expect(agg['nettoyage'].keep).toBe(1);
    expect(agg['nettoyage'].reject).toBe(1);
    expect(agg['hygiene'].ignore).toBe(1);
    expect(agg['hygiene'].total).toBe(1);
  });

  test('CLR-8: records vides -> objet vide', () => {
    const agg = aggregateClientSignals([], UUID);
    expect(Object.keys(agg)).toHaveLength(0);
  });

  test('CLR-9: client absent -> objet vide', () => {
    const agg = aggregateClientSignals(RECORDS_UUID, 'client-inexistant');
    expect(Object.keys(agg)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CLR-10..13 -- lookupClientHint
// ---------------------------------------------------------------------------

describe('CLR-10..13 -- lookupClientHint', () => {
  test('CLR-10: lookup par UUID -> retourne entry', () => {
    const entry = lookupClientHint(HINTS_DATA_MULTI, UUID);
    expect(entry).not.toBeNull();
    expect(entry!.client).toBe(UUID);
  });

  test('CLR-11: lookup par nom -> retourne entry', () => {
    const entry = lookupClientHint(HINTS_DATA_MULTI, 'client-informatique');
    expect(entry).not.toBeNull();
    expect(entry!.client).toBe('client-informatique');
  });

  test('CLR-12: client inconnu -> null', () => {
    const entry = lookupClientHint(HINTS_DATA_MULTI, 'inexistant');
    expect(entry).toBeNull();
  });

  test('CLR-13: hintsData null -> null', () => {
    const entry = lookupClientHint(null, UUID);
    expect(entry).toBeNull();
  });

  test('CLR-13b: insensible a la casse (toLowerCase sur les deux cotes)', () => {
    // L'implementation fait .toLowerCase() sur recordClient ET clientIdOrName.
    // Donc UUID.toUpperCase() matche bien -> retourne l'entree.
    const entry = lookupClientHint(HINTS_DATA_MULTI, UUID.toUpperCase());
    expect(entry).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLR-14..17 -- generateSignalRecommendation
// ---------------------------------------------------------------------------

describe('CLR-14..17 -- generateSignalRecommendation', () => {
  test('CLR-14: demote_to_review -> recommandation revue manuelle', () => {
    const hint = { recommended_effect: 'demote_to_review' };
    const reco = generateSignalRecommendation({ keep: 1, reject: 5, total: 6 }, hint);
    expect(reco).toContain('revue manuelle');
    expect(reco).toContain('penalis');
  });

  test('CLR-15: boost -> recommandation valorise', () => {
    const hint = { recommended_effect: 'boost' };
    const reco = generateSignalRecommendation({ keep: 8, reject: 1, total: 9 }, hint);
    expect(reco).toContain('valoris');
    expect(reco).toContain('score');
  });

  test('CLR-16: insufficient_data -> recommandation donnees insuffisantes', () => {
    const hint = { recommended_effect: 'insufficient_data' };
    const reco = generateSignalRecommendation({ keep: 1, reject: 0, total: 1 }, hint);
    expect(reco).toContain('insuffisantes');
  });

  test('CLR-17: sans hint -> recommandation donnees insuffisantes', () => {
    const reco = generateSignalRecommendation({ keep: 1, reject: 0, total: 1 }, null);
    expect(reco).toContain('insuffisantes');
  });

  test('CLR-17b: keep_review -> recommandation revue', () => {
    const hint = { recommended_effect: 'keep_review' };
    const reco = generateSignalRecommendation({ keep: 3, reject: 1, total: 4 }, hint);
    expect(reco).toContain('revue');
  });
});

// ---------------------------------------------------------------------------
// CLR-18..20 -- formatSignalRow
// ---------------------------------------------------------------------------

describe('CLR-18..20 -- formatSignalRow', () => {
  test('CLR-18: ligne avec hint -> contient toutes les colonnes', () => {
    const stats    = { keep: 6, reject: 10, ignore: 0, total: 16 };
    const hintSig  = {
      recommended_effect: 'demote_to_review',
      score_adjustment: -3,
      cycles_count: 2,
      sources: ['client'],
    };
    const row = formatSignalRow('nettoyage', stats, hintSig);
    expect(row).toContain('nettoyage');
    expect(row).toContain('6');
    expect(row).toContain('10');
    expect(row).toContain('16');
    expect(row).toContain('demote_to_review');
    expect(row).toContain('-3');
    expect(row).toContain('client');
    expect(row).toContain('2');
  });

  test('CLR-19: sans hint -> tirets dans les colonnes hint', () => {
    const stats = { keep: 2, reject: 1, ignore: 0, total: 3 };
    const row   = formatSignalRow('test-signal', stats, null);
    expect(row).toContain('test-signal');
    expect(row).toContain('-');
  });

  test('CLR-20: adj=0 -> tiret dans colonne Adj', () => {
    const stats   = { keep: 1, reject: 0, ignore: 0, total: 1 };
    const hintSig = { recommended_effect: 'insufficient_data', score_adjustment: 0, cycles_count: 1, sources: [] };
    const row     = formatSignalRow('signal-zero', stats, hintSig);
    // adj=0 -> affiche '-'
    const parts = row.split('|');
    const adjCol = parts[parts.length - 2].trim();
    expect(adjCol).toBe('-');
  });
});

// ---------------------------------------------------------------------------
// CLR-21..25 -- generateReport
// ---------------------------------------------------------------------------

describe('CLR-21..25 -- generateReport', () => {
  const SIGNAL_AGG = { nettoyage: { keep: 6, reject: 10, ignore: 0, total: 16 } };

  test('CLR-21: rapport contient le client ID', () => {
    const md = generateReport(UUID, SIGNAL_AGG, HINT_DEMOTE, { generatedAt: '2026-07-06T00:00:00Z' });
    expect(md).toContain(UUID);
  });

  test('CLR-22: rapport contient la date', () => {
    const md = generateReport(UUID, SIGNAL_AGG, HINT_DEMOTE, { generatedAt: '2026-07-06T00:00:00Z' });
    expect(md).toContain('2026-07-06T00:00:00Z');
  });

  test('CLR-23: rapport contient le signal nettoyage avec stats', () => {
    const md = generateReport(UUID, SIGNAL_AGG, HINT_DEMOTE, {});
    expect(md).toContain('nettoyage');
    expect(md).toContain('demote_to_review');
    expect(md).toContain('-3');
  });

  test('CLR-24: sans hint -> section hint absent', () => {
    const md = generateReport('client-sans-hint', {}, null, {});
    expect(md).toContain('Aucun hint');
  });

  test('CLR-25: noNewFeedback=true -> avertissement dans le rapport', () => {
    const md = generateReport(UUID, SIGNAL_AGG, HINT_DEMOTE, { noNewFeedback: true });
    expect(md).toContain('aucun nouveau feedback');
  });

  test('CLR-25b: signal boost -> section prochaine action mentionne validation', () => {
    const aggBoost = { informatique: { keep: 8, reject: 1, ignore: 0, total: 9 } };
    const md = generateReport('client-informatique', aggBoost, HINT_BOOST, {});
    expect(md).toContain('Valider');
  });

  test('CLR-25c: signal sans decisions ni hint -> aucun signal', () => {
    const md = generateReport('client-vide', {}, null, {});
    expect(md).toContain('aucun signal');
  });
});

// ---------------------------------------------------------------------------
// CLR-26..29 -- runReport
// ---------------------------------------------------------------------------

describe('CLR-26..29 -- runReport', () => {
  let tmpDecDir: string;
  let tmpHintsFile: string;

  beforeEach(() => {
    tmpDecDir    = fs.mkdtempSync(path.join(os.tmpdir(), 'rdec-'));
    tmpHintsFile = path.join(os.tmpdir(), 'hints-test-' + Date.now() + '.json');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDecDir, { recursive: true }); } catch (_) {}
    try { fs.unlinkSync(tmpHintsFile); } catch (_) {}
  });

  test('CLR-26: client avec decisions + hint -> ok=true, rapport Markdown', () => {
    // Ecrire un fichier de decisions
    const decFile = { records: [
      { client: UUID, matched_signals: ['nettoyage'], decision: 'reject' },
      { client: UUID, matched_signals: ['nettoyage'], decision: 'keep'   },
    ]};
    fs.writeFileSync(
      path.join(tmpDecDir, 'review-decisions-test.json'),
      JSON.stringify(decFile), 'utf8'
    );
    // Ecrire hints
    fs.writeFileSync(tmpHintsFile, JSON.stringify({ clients: [HINT_DEMOTE] }), 'utf8');

    const result = runReport(UUID, tmpDecDir, tmpHintsFile, {});
    expect(result.ok).toBe(true);
    expect(result.report).toContain('nettoyage');
    expect(result.report).toContain('demote_to_review');
    expect(result.error).toBeNull();
  });

  test('CLR-27: client par nom -> ok=true', () => {
    const decFile = { records: [
      { client: 'TEST PROD - Nettoyage', matched_signals: ['nettoyage'], decision: 'keep' },
    ]};
    fs.writeFileSync(
      path.join(tmpDecDir, 'review-decisions-test.json'),
      JSON.stringify(decFile), 'utf8'
    );
    const hintNamed = { clients: [{ client: 'TEST PROD - Nettoyage', signals: [
      { signal: 'nettoyage', recommended_effect: 'insufficient_data', score_adjustment: 0, block_auto_notify: false, sources: [], cycles_count: 1 },
    ]}]};
    fs.writeFileSync(tmpHintsFile, JSON.stringify(hintNamed), 'utf8');

    const result = runReport('TEST PROD - Nettoyage', tmpDecDir, tmpHintsFile, {});
    expect(result.ok).toBe(true);
    expect(result.report).toContain('TEST PROD - Nettoyage');
  });

  test('CLR-28: client inconnu (aucune decision ni hint) -> ok=false, error clair', () => {
    fs.writeFileSync(tmpHintsFile, JSON.stringify({ clients: [] }), 'utf8');
    const result = runReport('client-inexistant-xyz', tmpDecDir, tmpHintsFile, {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('client-inexistant-xyz');
    expect(result.report).toBeNull();
  });

  test('CLR-29: fichier JSON corrompu ignore, autres fichiers lus', () => {
    // Un fichier invalide
    fs.writeFileSync(path.join(tmpDecDir, 'review-decisions-bad.json'), '{"records": INVALID', 'utf8');
    // Un fichier valide
    const decFile = { records: [
      { client: UUID, matched_signals: ['nettoyage'], decision: 'keep' },
    ]};
    fs.writeFileSync(
      path.join(tmpDecDir, 'review-decisions-good.json'),
      JSON.stringify(decFile), 'utf8'
    );
    fs.writeFileSync(tmpHintsFile, JSON.stringify({ clients: [] }), 'utf8');

    const result = runReport(UUID, tmpDecDir, tmpHintsFile, {});
    // Le client a une decision dans le fichier valide -> ok
    expect(result.ok).toBe(true);
    expect(result.report).toContain('nettoyage');
  });
});

// ---------------------------------------------------------------------------
// CLR-30 -- loadReviewDecisions
// ---------------------------------------------------------------------------

describe('CLR-30 -- loadReviewDecisions', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdec2-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
  });

  test('CLR-30a: dossier vide -> tableau vide', () => {
    const recs = loadReviewDecisions(tmpDir);
    expect(recs).toEqual([]);
  });

  test('CLR-30b: fichiers non-review-decisions ignores', () => {
    fs.writeFileSync(path.join(tmpDir, 'other.json'), '{}', 'utf8');
    const recs = loadReviewDecisions(tmpDir);
    expect(recs).toEqual([]);
  });

  test('CLR-30c: fichier valide -> records expandus par signal', () => {
    const decFile = { records: [
      { client: 'X', matched_signals: ['a', 'b'], decision: 'keep' },
    ]};
    fs.writeFileSync(
      path.join(tmpDir, 'review-decisions-test.json'),
      JSON.stringify(decFile), 'utf8'
    );
    const recs = loadReviewDecisions(tmpDir);
    expect(recs).toHaveLength(2);
    expect(recs[0].signal).toBe('a');
    expect(recs[1].signal).toBe('b');
  });

  test('CLR-30d: matched_signals non-array ignores', () => {
    const decFile = { records: [
      { client: 'X', matched_signals: null, decision: 'keep' },
    ]};
    fs.writeFileSync(
      path.join(tmpDir, 'review-decisions-test.json'),
      JSON.stringify(decFile), 'utf8'
    );
    const recs = loadReviewDecisions(tmpDir);
    expect(recs).toEqual([]);
  });
});

export {};
