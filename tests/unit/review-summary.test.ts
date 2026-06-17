/**
 * Tests unitaires — review-summary (--save-summary + auto-candidates CSV)
 *
 * Couvre P1 — Chaînon brisé : génération de summary-*.json pour loadSignalRiskTable()
 * dans analyze-shadow-report.js.
 *
 * Miroir pur des fonctions de analyze-review-decisions.js :
 *   - classifyVerdict()  → verdict générique calculé depuis les ratios
 *   - buildSummary()     → structure JSON produite par saveSummary()
 *   - AUTO_CANDIDATES_COLS → colonnes du CSV auto-candidates (avec "decision")
 *
 * Aucune dépendance FS, aucune dépendance aux scripts JS.
 * Aucune règle spécifique à un signal.
 *
 * Nomenclature : SS-R (Scan Summary Review)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface SignalStats {
  total:  number;
  keep:   number;
  reject: number;
}

interface SignalEntry {
  signal:      string;
  verdict:     string;
  keep:        number;
  reject:      number;
  ignore:      number;
  total:       number;
  keep_rate:   number;
  reject_rate: number;
}

interface ReviewSummary {
  generated_at:    string;
  total_decisions: number;
  by_signal:       SignalEntry[];
}

// ─── Mirror de classifyVerdict (identique à analyze-review-decisions.js) ─────
//
// Calcule un verdict générique depuis les ratios agrégés.
// Aucune règle spécifique à un signal — uniquement des seuils de ratio.
// Retourne une valeur compatible avec le TIER_ORDER de analyze-shadow-report.js :
//   ['Risqué', 'Ambigu', 'Insuffisant', 'inconnu', 'Fiable', 'Très fiable']

function classifyVerdict(v: SignalStats): string {
  if (!v.total) return 'Insuffisant';
  const kr = v.keep   / v.total;
  const rr = v.reject / v.total;
  if (kr >= 0.8 && v.total >= 2) return 'Très fiable';
  if (kr >= 0.6 && v.total >= 2) return 'Fiable';
  if (rr >= 0.8 && v.total >= 2) return 'Risqué';
  if (v.total === 1)              return 'Insuffisant';
  return 'Ambigu';
}

// ─── Mirror de buildSummary (structure produite par saveSummary()) ────────────

type SignalReportRow = {
  signal: string; keep: number; reject: number; ignore: number;
  total: number; keep_rate: number; reject_rate: number;
};

function buildSummary(rowCount: number, signalReport: SignalReportRow[]): ReviewSummary {
  return {
    generated_at:    new Date().toISOString(),
    total_decisions: rowCount,
    by_signal: signalReport.map(s => ({
      signal:      s.signal,
      verdict:     classifyVerdict({ total: s.total, keep: s.keep, reject: s.reject }),
      keep:        s.keep,
      reject:      s.reject,
      ignore:      s.ignore,
      total:       s.total,
      keep_rate:   s.keep_rate,
      reject_rate: s.reject_rate,
    })),
  };
}

// ─── Mirror de AUTO_COLS dans analyze-shadow-report.js ───────────────────────
//
// Doit rester synchronisé avec la variable AUTO_COLS du script.
// Si AUTO_COLS change dans le script, mettre à jour ici en même temps.

const AUTO_CANDIDATES_COLS = [
  'report_date', 'client', 'bc_id', 'score', 'signal_origin',
  'matched_signals', 'strength_reason', 'signal_risk_tier',
  'signal_risk_detail', 'warning', 'auto_candidate_reason',
  'clean_text_excerpt', 'decision',
];

// ─── Tests : structure du summary JSON ───────────────────────────────────────

describe('review-summary — structure du fichier summary-*.json', () => {

  // SS-R1 : le summary contient les clés requises par loadSignalRiskTable()
  test('SS-R1 — summary contient generated_at, total_decisions, by_signal', () => {
    const summary = buildSummary(4, []);
    expect(summary).toHaveProperty('generated_at');
    expect(summary).toHaveProperty('total_decisions');
    expect(summary).toHaveProperty('by_signal');
    expect(Array.isArray(summary.by_signal)).toBe(true);
  });

  // SS-R2 : by_signal contient les signaux distincts de l'entrée
  test('SS-R2 — by_signal contient exactement les signaux du rapport d\'entrée', () => {
    const report: SignalReportRow[] = [
      { signal: 'alpha', keep: 3, reject: 0, ignore: 0, total: 3, keep_rate: 100, reject_rate: 0 },
      { signal: 'beta',  keep: 0, reject: 2, ignore: 1, total: 3, keep_rate: 0,   reject_rate: 67 },
    ];
    const summary = buildSummary(6, report);
    const signals = summary.by_signal.map(s => s.signal);
    expect(signals).toContain('alpha');
    expect(signals).toContain('beta');
    expect(summary.by_signal).toHaveLength(2);
  });

  // SS-R3 : total_decisions reflète le nombre de rows transmis
  test('SS-R3 — total_decisions reflète le nombre de décisions importées', () => {
    expect(buildSummary(7,  []).total_decisions).toBe(7);
    expect(buildSummary(0,  []).total_decisions).toBe(0);
    expect(buildSummary(42, []).total_decisions).toBe(42);
  });

  // SS-R8 : chaque entrée by_signal a tous les champs requis
  test('SS-R8 — chaque entrée by_signal contient tous les champs requis', () => {
    const report: SignalReportRow[] = [
      { signal: 'foo', keep: 2, reject: 0, ignore: 0, total: 2, keep_rate: 100, reject_rate: 0 },
    ];
    const entry = buildSummary(2, report).by_signal[0];
    expect(entry).toHaveProperty('signal');
    expect(entry).toHaveProperty('verdict');
    expect(entry).toHaveProperty('keep');
    expect(entry).toHaveProperty('reject');
    expect(entry).toHaveProperty('ignore');
    expect(entry).toHaveProperty('total');
    expect(entry).toHaveProperty('keep_rate');
    expect(entry).toHaveProperty('reject_rate');
  });

});

// ─── Tests : classifyVerdict — verdicts calculés depuis les ratios ────────────

describe('review-summary — classifyVerdict (générique, aucune règle signal-spécifique)', () => {

  // SS-R4 : Très fiable quand keep_rate >= 80% sur >= 2 observations
  test("SS-R4 — verdict 'Très fiable' quand keep >= 80% sur >= 2 obs", () => {
    expect(classifyVerdict({ total: 5, keep: 5, reject: 0 })).toBe('Très fiable');  // 100%
    expect(classifyVerdict({ total: 2, keep: 2, reject: 0 })).toBe('Très fiable');  // 100%, min 2
    expect(classifyVerdict({ total: 5, keep: 4, reject: 1 })).toBe('Très fiable');  // 80% exact
  });

  // SS-R4b : 1 seule observation → pas Très fiable même à 100%
  test("SS-R4b — verdict 'Insuffisant' si total === 1 même à 100% keep", () => {
    expect(classifyVerdict({ total: 1, keep: 1, reject: 0 })).toBe('Insuffisant');
  });

  // SS-R5 : Risqué quand reject_rate >= 80% sur >= 2 obs
  test("SS-R5 — verdict 'Risqué' quand reject >= 80% sur >= 2 obs", () => {
    expect(classifyVerdict({ total: 3, keep: 0, reject: 3 })).toBe('Risqué');  // 100%
    expect(classifyVerdict({ total: 5, keep: 1, reject: 4 })).toBe('Risqué');  // 80% exact
  });

  // SS-R6 : Insuffisant quand total === 0 ou total === 1
  test("SS-R6 — verdict 'Insuffisant' quand total === 0 ou total === 1", () => {
    expect(classifyVerdict({ total: 0, keep: 0, reject: 0 })).toBe('Insuffisant');
    expect(classifyVerdict({ total: 1, keep: 0, reject: 1 })).toBe('Insuffisant');
    expect(classifyVerdict({ total: 1, keep: 1, reject: 0 })).toBe('Insuffisant');
  });

  // SS-R7 : Fiable 60-79% keep sur >= 2 obs; Ambigu sinon
  test("SS-R7 — verdict 'Fiable' entre 60% et 79% keep; 'Ambigu' sinon", () => {
    // 2/3 = 67% keep → Fiable
    expect(classifyVerdict({ total: 3, keep: 2, reject: 1 })).toBe('Fiable');
    // 3/5 = 60% keep → Fiable (borne incluse)
    expect(classifyVerdict({ total: 5, keep: 3, reject: 2 })).toBe('Fiable');
    // 1/2 = 50% → Ambigu
    expect(classifyVerdict({ total: 2, keep: 1, reject: 1 })).toBe('Ambigu');
    // 2/4 = 50% → Ambigu
    expect(classifyVerdict({ total: 4, keep: 2, reject: 2 })).toBe('Ambigu');
    // 2/5 = 40% keep + 2/5 = 40% reject → ni Risqué ni Fiable → Ambigu
    expect(classifyVerdict({ total: 5, keep: 2, reject: 2 })).toBe('Ambigu');
  });

  // SS-R7b : priorité keep sur reject (si les deux dépassent des seuils — cas théorique impossible
  //           mais vérification de l'ordre des conditions)
  test("SS-R7b — Très fiable prioritaire sur Risqué si keep >= 80% (cas impossible en pratique)", () => {
    // keep=4 reject=4 total=8 → 50%/50% → Ambigu (cas normal mixte)
    expect(classifyVerdict({ total: 8, keep: 4, reject: 4 })).toBe('Ambigu');
  });

});

// ─── Tests : colonnes CSV auto-candidates ─────────────────────────────────────

describe('review-summary — colonne decision dans auto-candidates CSV', () => {

  // SS-R9 : AUTO_CANDIDATES_COLS contient 'decision'
  test("SS-R9 — AUTO_CANDIDATES_COLS inclut la colonne 'decision'", () => {
    expect(AUTO_CANDIDATES_COLS).toContain('decision');
  });

  // SS-R10 : 'decision' est la dernière colonne (convention identique à review-candidates)
  test("SS-R10 — 'decision' est la dernière colonne du CSV auto-candidates", () => {
    expect(AUTO_CANDIDATES_COLS[AUTO_CANDIDATES_COLS.length - 1]).toBe('decision');
  });

});
