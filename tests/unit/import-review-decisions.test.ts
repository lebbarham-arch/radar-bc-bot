/**
 * tests/unit/import-review-decisions.test.ts
 *
 * IRD-1..IRD-14 — Tests unitaires pour import-review-decisions.js (GD-058)
 * Transport des champs contextuels (ctx_*, human_review_reason, rrh_*) dans
 * les décisions importées.
 *
 * Pattern miroir — logique locale, pas de require du script CLI.
 *
 * STRICT :
 *  - Pas de scoring / seuil / poids modifié
 *  - Pas de prod / Supabase / Fly / notification / bcs_vus
 *  - keep / reject / ignore / vide uniquement
 *  - Décision invalide → remise à vide
 *  - Champs budget/prix/montant/estimation jamais utilisés comme raison review
 *  - ctx_negative_context_terms et ctx_positive_context_terms → array
 *  - Champs absents → omis du record (pas de clé avec '' ou null)
 */

// ── Types locaux ────────────────────────────────────────────────────────────
interface IRDRecord {
  client:             string;
  bc_id:              string;
  score:              number;
  signal_origin:      string;
  matched_signals:    string[];
  strength_reason:    string;
  weak_single_signal: boolean;
  clean_text_excerpt: string;
  decision:           string;
  cycle_id:           string | null;
  review_source:      string;
  reviewed_at:        string;
  // champs optionnels GD-058
  ctx_learnable_context_hint?:  string;
  ctx_profile_alignment?:       string;
  ctx_context_ambiguity?:       string;
  ctx_context_confidence?:      string;
  ctx_should_create_hint?:      string;
  ctx_negative_context_terms?:  string[];
  ctx_positive_context_terms?:  string[];
  human_review_reason?:         string;
  human_review_reason_label?:   string;
  human_review_comment?:        string;
  rrh_applied?:                 string;
  rrh_action?:                  string;
  rrh_ids?:                     string;
  rrh_explanation?:             string;
  [key: string]: unknown;
}

// ── Miroir inline des fonctions d'import ────────────────────────────────────

const OPT_STR_COLS = [
  'ctx_learnable_context_hint',
  'ctx_profile_alignment',
  'ctx_context_ambiguity',
  'ctx_context_confidence',
  'ctx_should_create_hint',
  'human_review_reason',
  'human_review_reason_label',
  'human_review_comment',
  'rrh_applied',
  'rrh_action',
  'rrh_ids',
  'rrh_explanation',
];

const OPT_ARR_COLS = [
  'ctx_negative_context_terms',
  'ctx_positive_context_terms',
];

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) { fields.push(''); break; }
    if (line[i] === '"') {
      let buf = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { buf += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { buf += line[i++]; }
      }
      fields.push(buf);
      if (line[i] === ';') i++;
    } else {
      const end = line.indexOf(';', i);
      if (end === -1) { fields.push(line.slice(i)); break; }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

function parseCsv(raw: string): string[][] {
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n')
    .map(parseCsvLine);
}

function optStr(row: string[], idx: number): string {
  if (idx === -1 || idx >= row.length) return '';
  return (row[idx] || '').trim();
}

function optTerms(row: string[], idx: number): string[] | null {
  const v = optStr(row, idx);
  if (!v) return null;
  return v.split(',').map(s => s.trim()).filter(Boolean);
}

const VALID_DECISIONS = ['keep', 'reject', 'ignore', ''];

function importCsv(csvRaw: string, cycleId: string | null = null): IRDRecord[] {
  const rows = parseCsv(csvRaw).filter(r => r.join('').trim() !== '');
  const header = rows[0]!;

  const COL = {
    client:             header.indexOf('client'),
    bc_id:              header.indexOf('bc_id'),
    score:              header.indexOf('score'),
    signal_origin:      header.indexOf('signal_origin'),
    matched_signals:    header.indexOf('matched_signals'),
    strength_reason:    header.indexOf('strength_reason'),
    weak_single_signal: header.indexOf('weak_single_signal'),
    clean_text_excerpt: header.indexOf('clean_text_excerpt'),
    decision:           header.indexOf('decision'),
  };

  const COL_OPT: Record<string, number> = {};
  OPT_STR_COLS.concat(OPT_ARR_COLS).forEach(k => { COL_OPT[k] = header.indexOf(k); });

  const records: IRDRecord[] = [];

  rows.slice(1).forEach(row => {
    let decision = (row[COL.decision] || '').trim().toLowerCase();
    if (VALID_DECISIONS.indexOf(decision) === -1) decision = '';

    const signals = (row[COL.matched_signals] || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    const rec: IRDRecord = {
      client:             row[COL.client]             || '',
      bc_id:              row[COL.bc_id]              || '',
      score:              Number(row[COL.score])       || 0,
      signal_origin:      row[COL.signal_origin]       || '',
      matched_signals:    signals,
      strength_reason:    row[COL.strength_reason]     || '',
      weak_single_signal: row[COL.weak_single_signal] === 'true',
      clean_text_excerpt: row[COL.clean_text_excerpt]  || '',
      decision,
      cycle_id:    cycleId,
      review_source: 'operator',
      reviewed_at: '2026-06-20T12:00:00.000Z',
    };

    // Transport champs contextuels optionnels
    OPT_STR_COLS.forEach(k => {
      const v = optStr(row, COL_OPT[k] ?? -1);
      if (v) rec[k] = v;
    });
    OPT_ARR_COLS.forEach(k => {
      const arr = optTerms(row, COL_OPT[k] ?? -1);
      if (arr && arr.length) rec[k] = arr;
    });

    records.push(rec);
  });

  return records;
}

// ── Helpers CSV de test ───────────────────────────────────────────────────────
// CSV minimal (sans colonnes ctx_*)
const HEADER_MIN = 'client;bc_id;score;signal_origin;matched_signals;strength_reason;weak_single_signal;clean_text_excerpt;decision';

// CSV complet (avec colonnes ctx_*)
const HEADER_FULL = [
  'client', 'bc_id', 'score', 'signal_origin', 'matched_signals',
  'strength_reason', 'weak_single_signal', 'clean_text_excerpt', 'decision',
  'ctx_learnable_context_hint', 'ctx_negative_context_terms',
  'ctx_positive_context_terms', 'ctx_profile_alignment',
  'ctx_context_ambiguity', 'ctx_context_confidence', 'ctx_should_create_hint',
  'human_review_reason', 'human_review_reason_label', 'human_review_comment',
  'rrh_applied', 'rrh_action', 'rrh_ids', 'rrh_explanation',
].join(';');

function minRow(
  client: string, bcId: string, score: number,
  signals: string, decision: string,
): string {
  return [client, bcId, String(score), 'primary', signals,
          'raison_test', 'non', 'extrait test', decision].join(';');
}

function fullRow(fields: Partial<{
  client: string; bc_id: string; score: number; matched_signals: string;
  decision: string; ctx_learnable_context_hint: string;
  ctx_negative_context_terms: string; ctx_positive_context_terms: string;
  ctx_profile_alignment: string; ctx_context_ambiguity: string;
  ctx_context_confidence: string; ctx_should_create_hint: string;
  human_review_reason: string; human_review_reason_label: string;
  human_review_comment: string;
  rrh_applied: string; rrh_action: string; rrh_ids: string; rrh_explanation: string;
}>): string {
  return [
    fields.client             ?? 'CLIENT TEST',
    fields.bc_id              ?? '999001',
    String(fields.score       ?? 10),
    'primary',
    fields.matched_signals    ?? 'nettoyage',
    'raison_test', 'non', 'extrait test',
    fields.decision           ?? 'keep',
    fields.ctx_learnable_context_hint    ?? '',
    fields.ctx_negative_context_terms    ?? '',
    fields.ctx_positive_context_terms    ?? '',
    fields.ctx_profile_alignment         ?? '',
    fields.ctx_context_ambiguity         ?? '',
    fields.ctx_context_confidence        ?? '',
    fields.ctx_should_create_hint        ?? '',
    fields.human_review_reason           ?? '',
    fields.human_review_reason_label     ?? '',
    fields.human_review_comment          ?? '',
    fields.rrh_applied                   ?? '',
    fields.rrh_action                    ?? '',
    fields.rrh_ids                       ?? '',
    fields.rrh_explanation               ?? '',
  ].join(';');
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('IRD — import-review-decisions ctx transport (GD-058)', () => {

  // ── IRD-1 : ctx_learnable_context_hint transporté ──────────────────────────
  test('IRD-1 : ctx_learnable_context_hint transporté depuis le CSV', () => {
    const csv = [
      HEADER_FULL,
      fullRow({ ctx_learnable_context_hint: 'cleaning_disinfection_context', decision: 'keep' }),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec!.ctx_learnable_context_hint).toBe('cleaning_disinfection_context');
  });

  // ── IRD-2 : CSV sans colonnes ctx_* — pas de crash, pas de champ ctx_ ──────
  test('IRD-2 : CSV minimal sans ctx_* — import OK, aucun champ ctx_ dans le record', () => {
    const csv = [
      HEADER_MIN,
      minRow('CLIENT A', '100001', 10, 'nettoyage', 'keep'),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec!.decision).toBe('keep');
    expect(rec!.bc_id).toBe('100001');
    // Aucun champ ctx_* dans le record
    const ctxKeys = Object.keys(rec!).filter(k => k.startsWith('ctx_'));
    expect(ctxKeys).toHaveLength(0);
  });

  // ── IRD-3 : ctx_negative_context_terms parsé comme array ───────────────────
  test('IRD-3 : ctx_negative_context_terms parsé comme array de termes', () => {
    const csv = [
      HEADER_FULL,
      fullRow({ ctx_negative_context_terms: 'hopital, soins, chp' }),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(Array.isArray(rec!.ctx_negative_context_terms)).toBe(true);
    expect(rec!.ctx_negative_context_terms).toEqual(['hopital', 'soins', 'chp']);
  });

  // ── IRD-4 : ctx_positive_context_terms parsé comme array ───────────────────
  test('IRD-4 : ctx_positive_context_terms parsé comme array de termes', () => {
    const csv = [
      HEADER_FULL,
      fullRow({ ctx_positive_context_terms: 'nettoyage, batiment, administration' }),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(Array.isArray(rec!.ctx_positive_context_terms)).toBe(true);
    expect(rec!.ctx_positive_context_terms).toEqual(['nettoyage', 'batiment', 'administration']);
  });

  // ── IRD-5 : ctx_profile_alignment transporté comme string ──────────────────
  test('IRD-5 : ctx_profile_alignment transporté comme string', () => {
    const csv = [
      HEADER_FULL,
      fullRow({ ctx_profile_alignment: 'high' }),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec!.ctx_profile_alignment).toBe('high');
  });

  // ── IRD-6 : human_review_reason transporté ─────────────────────────────────
  test('IRD-6 : human_review_reason transporté si présent', () => {
    const csv = [
      HEADER_FULL,
      fullRow({ human_review_reason: 'bon_signal_mauvais_contexte', decision: 'reject' }),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec!.human_review_reason).toBe('bon_signal_mauvais_contexte');
    expect(rec!.decision).toBe('reject');
  });

  // ── IRD-7 : human_review_comment transporté ────────────────────────────────
  test('IRD-7 : human_review_comment transporté si présent', () => {
    const csv = [
      HEADER_FULL,
      fullRow({ human_review_comment: 'Contexte hospitalier exclu du profil', decision: 'ignore' }),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec!.human_review_comment).toBe('Contexte hospitalier exclu du profil');
    expect(rec!.decision).toBe('ignore');
  });

  // ── IRD-8 : rrh_applied et rrh_action transportés ──────────────────────────
  test('IRD-8 : rrh_applied et rrh_action transportés si présents', () => {
    const csv = [
      HEADER_FULL,
      fullRow({ rrh_applied: 'true', rrh_action: 'context_keep_review_or_boost_candidate' }),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec!.rrh_applied).toBe('true');
    expect(rec!.rrh_action).toBe('context_keep_review_or_boost_candidate');
  });

  // ── IRD-9 : décision vide → '' (pending) ───────────────────────────────────
  test('IRD-9 : decision vide reste vide (pending)', () => {
    const csv = [
      HEADER_MIN,
      minRow('CLIENT A', '100002', 5, 'hygiene', ''),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec!.decision).toBe('');
  });

  // ── IRD-10 : décision invalide → remise à vide ─────────────────────────────
  test('IRD-10 : decision invalide remise a vide', () => {
    const csv = [
      HEADER_MIN,
      minRow('CLIENT A', '100003', 5, 'hygiene', 'boost'),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec!.decision).toBe('');
  });

  // ── IRD-11 : keep / reject / ignore uniquement valides ─────────────────────
  test('IRD-11 : keep / reject / ignore sont les seules decisions valides', () => {
    const csv = [
      HEADER_MIN,
      minRow('C', '1', 10, 'nettoyage', 'keep'),
      minRow('C', '2', 10, 'nettoyage', 'reject'),
      minRow('C', '3', 10, 'nettoyage', 'ignore'),
      minRow('C', '4', 10, 'nettoyage', 'activate'),
      minRow('C', '5', 10, 'nettoyage', 'auto_notify'),
    ].join('\n');
    const recs = importCsv(csv);
    expect(recs[0]!.decision).toBe('keep');
    expect(recs[1]!.decision).toBe('reject');
    expect(recs[2]!.decision).toBe('ignore');
    expect(recs[3]!.decision).toBe('');   // invalide → vide
    expect(recs[4]!.decision).toBe('');   // invalide → vide
  });

  // ── IRD-12 : champs vides non inclus dans le record ────────────────────────
  test('IRD-12 : ctx fields vides omis du record', () => {
    const csv = [
      HEADER_FULL,
      fullRow({
        ctx_learnable_context_hint: '',
        ctx_negative_context_terms: '',
        human_review_reason:        '',
        rrh_applied:                '',
      }),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec).not.toHaveProperty('ctx_learnable_context_hint');
    expect(rec).not.toHaveProperty('ctx_negative_context_terms');
    expect(rec).not.toHaveProperty('human_review_reason');
    expect(rec).not.toHaveProperty('rrh_applied');
  });

  // ── IRD-13 : pas de champ budget/prix/montant/estimation ───────────────────
  test('IRD-13 : aucun champ budget/prix/montant/estimation dans les records', () => {
    const csv = [
      HEADER_FULL,
      fullRow({ decision: 'keep', human_review_reason: 'bon_signal_bon_contexte' }),
    ].join('\n');
    const [rec] = importCsv(csv);
    expect(rec).toBeDefined();
    const forbidden = ['budget', 'prix', 'montant', 'estimation', 'amount', 'price'];
    forbidden.forEach(f => {
      const found = Object.keys(rec!).some(k => k.toLowerCase().includes(f));
      expect(found).toBe(false);
    });
  });

  // ── IRD-14 : plusieurs records — champs ctx_ indépendants par ligne ──────
  test('IRD-14 : champs ctx_ independants par ligne', () => {
    const csv = [
      HEADER_FULL,
      fullRow({
        bc_id: '201',
        ctx_learnable_context_hint: 'cleaning_disinfection_context',
        ctx_negative_context_terms: '',
        decision: 'keep',
      }),
      fullRow({
        bc_id: '202',
        ctx_learnable_context_hint: '',
        ctx_negative_context_terms: 'hopital, soins',
        decision: 'ignore',
      }),
    ].join('\n');
    const recs = importCsv(csv);

    // Record 1 : hint présent, pas de neg_terms
    expect(recs[0]!.ctx_learnable_context_hint).toBe('cleaning_disinfection_context');
    expect(recs[0]).not.toHaveProperty('ctx_negative_context_terms');

    // Record 2 : neg_terms array, pas de hint
    expect(recs[1]).not.toHaveProperty('ctx_learnable_context_hint');
    expect(recs[1]!.ctx_negative_context_terms).toEqual(['hopital', 'soins']);
  });
});
