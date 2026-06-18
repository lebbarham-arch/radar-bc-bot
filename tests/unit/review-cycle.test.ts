/**
 * Tests unitaires — review-cycle (P2 : cycle_id, review_source, promotion_ready)
 *
 * Couvre les fonctions ajoutées dans :
 *   - scripts/import-review-decisions.js  (extractCycleId, review_source par défaut)
 *   - scripts/analyze-review-decisions.js (cycles_count par signal)
 *   - scripts/analyze-promotion-candidates.js (isPromotionReady)
 *
 * Miroir pur — aucune dépendance FS, aucun import des scripts JS.
 * Aucune règle spécifique à un signal ou un client.
 *
 * Nomenclature : SS-C (Scan Summary Cycle)
 */

// ─── Mirror : extractCycleId ─────────────────────────────────────────────────
//
// Extrait le cycle_id depuis le basename du fichier CSV.
// Pattern attendu : YYYY-MM-DDTHH-MM-SS
// Retourne null si le pattern est absent.

function extractCycleId(filePath: string): string | null {
  const basename = filePath.split(/[\\/]/).pop() || '';
  const m = basename.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
  return m ? (m[1] ?? null) : null;
}

// ─── Mirror : agrégation par signal avec cycles ───────────────────────────────

interface RecordInput {
  matched_signals?: string[];
  decision:         string;
  cycle_id?:        string | null;
  review_source?:   string;
}

interface AggSignal {
  signal:  string;
  keep:    number;
  reject:  number;
  ignore:  number;
  cycles:  Set<string>;
  sources: Set<string>;
}

function aggregateBySignal(records: RecordInput[]): Map<string, AggSignal> {
  const map = new Map<string, AggSignal>();
  for (const r of records) {
    for (const s of (r.matched_signals || [])) {
      if (!map.has(s)) {
        map.set(s, { signal: s, keep: 0, reject: 0, ignore: 0, cycles: new Set(), sources: new Set() });
      }
      const e = map.get(s)!;
      if (r.decision === 'keep' || r.decision === 'reject' || r.decision === 'ignore') {
        const eRec = e as unknown as Record<string, unknown>;
        eRec[r.decision] = (eRec[r.decision] as number) + 1;
      }
      // anciens records sans cycle_id → ne pas incrémenter cycles
      if (r.cycle_id) e.cycles.add(r.cycle_id);
      // anciens records sans review_source → operator par défaut
      e.sources.add(r.review_source || 'operator');
    }
  }
  return map;
}

// ─── Mirror : isPromotionReady ────────────────────────────────────────────────
//
// Un signal est prêt pour promotion seulement si cycles distincts >= 2.
// Un fort ratio statistique sur un seul cycle n'est pas suffisant.

function isPromotionReady(sig: AggSignal): boolean {
  return sig.cycles.size >= 2;
}

// ─── Mirror : isStatisticallyStrong (tier très_fiable) ───────────────────────

function isStatisticallyStrong(sig: AggSignal): boolean {
  const total = sig.keep + sig.reject + sig.ignore;
  return total >= 3
    && sig.reject === 0
    && sig.ignore === 0
    && (sig.keep / total) >= 0.90;
}

// ─── Tests : extractCycleId ───────────────────────────────────────────────────

describe('review-cycle — extractCycleId depuis le nom de fichier CSV', () => {

  // SS-C1 : pattern dans review-candidates
  test('SS-C1 — review-candidates-2026-06-17T22-15-41.csv → cycle_id correct', () => {
    expect(extractCycleId('review-candidates-2026-06-17T22-15-41.csv'))
      .toBe('2026-06-17T22-15-41');
  });

  // SS-C2 : pattern dans auto-candidates-admin
  test('SS-C2 — auto-candidates-admin-2026-06-18T09-00-00.csv → cycle_id correct', () => {
    expect(extractCycleId('auto-candidates-admin-2026-06-18T09-00-00.csv'))
      .toBe('2026-06-18T09-00-00');
  });

  // SS-C2b : chemin complet (séparateur Windows ou Unix)
  test('SS-C2b — chemin complet avec répertoires → cycle_id extrait du basename', () => {
    expect(extractCycleId('data/shadow/review-candidates-2026-06-17T22-15-41.csv'))
      .toBe('2026-06-17T22-15-41');
    expect(extractCycleId('data\\shadow\\review-candidates-2026-06-17T22-15-41.csv'))
      .toBe('2026-06-17T22-15-41');
  });

  // SS-C3 : fichier sans timestamp → null
  test('SS-C3 — review.csv (sans pattern timestamp) → null', () => {
    expect(extractCycleId('review.csv')).toBeNull();
    expect(extractCycleId('decisions.json')).toBeNull();
    expect(extractCycleId('')).toBeNull();
  });

});

// ─── Tests : review_source par défaut ────────────────────────────────────────

describe('review-cycle — review_source (operator / client / system)', () => {

  // SS-C4 : record sans review_source → traité comme operator
  test('SS-C4 — record sans review_source → sources contient "operator"', () => {
    const records: RecordInput[] = [
      { matched_signals: ['alpha'], decision: 'keep', cycle_id: 'C1' },
    ];
    const agg = aggregateBySignal(records);
    const sig = agg.get('alpha')!;
    expect(sig.sources.has('operator')).toBe(true);
  });

  // SS-C5 : review_source=client accepté et propagé
  test('SS-C5 — review_source="client" est propagé dans sources', () => {
    const records: RecordInput[] = [
      { matched_signals: ['alpha'], decision: 'keep', cycle_id: 'C1', review_source: 'client' },
    ];
    const agg = aggregateBySignal(records);
    const sig = agg.get('alpha')!;
    expect(sig.sources.has('client')).toBe(true);
    expect(sig.sources.has('operator')).toBe(false);
  });

  // SS-C5b : mix operator + client → les deux dans sources
  test('SS-C5b — mix operator + client → les deux dans sources', () => {
    const records: RecordInput[] = [
      { matched_signals: ['alpha'], decision: 'keep',   cycle_id: 'C1', review_source: 'operator' },
      { matched_signals: ['alpha'], decision: 'keep',   cycle_id: 'C2', review_source: 'client' },
    ];
    const agg = aggregateBySignal(records);
    const sig = agg.get('alpha')!;
    expect(sig.sources.has('operator')).toBe(true);
    expect(sig.sources.has('client')).toBe(true);
    expect(sig.sources.size).toBe(2);
  });

});

// ─── Tests : cycles_count ─────────────────────────────────────────────────────

describe('review-cycle — cycles_count (preuves indépendantes)', () => {

  // SS-C6 : plusieurs records du même cycle_id → cycles_count = 1
  test('SS-C6 — 3 records sur le même cycle_id → cycles.size = 1', () => {
    const records: RecordInput[] = [
      { matched_signals: ['alpha'], decision: 'keep',   cycle_id: 'C1' },
      { matched_signals: ['alpha'], decision: 'keep',   cycle_id: 'C1' },
      { matched_signals: ['alpha'], decision: 'reject', cycle_id: 'C1' },
    ];
    const agg = aggregateBySignal(records);
    expect(agg.get('alpha')!.cycles.size).toBe(1);
  });

  // SS-C7 : records sur 2 cycle_id différents → cycles_count = 2
  test('SS-C7 — 3 records sur 2 cycle_id distincts → cycles.size = 2', () => {
    const records: RecordInput[] = [
      { matched_signals: ['alpha'], decision: 'keep', cycle_id: 'C1' },
      { matched_signals: ['alpha'], decision: 'keep', cycle_id: 'C2' },
      { matched_signals: ['alpha'], decision: 'keep', cycle_id: 'C2' },
    ];
    const agg = aggregateBySignal(records);
    expect(agg.get('alpha')!.cycles.size).toBe(2);
  });

  // SS-C8 : anciens records sans cycle_id ne cassent pas l'analyse
  test('SS-C8 — anciens records sans cycle_id : keep/reject/ignore comptés, cycles.size inchangé', () => {
    const records: RecordInput[] = [
      { matched_signals: ['beta'], decision: 'keep',   cycle_id: null },
      { matched_signals: ['beta'], decision: 'keep',   cycle_id: null },
      { matched_signals: ['beta'], decision: 'reject'                 },  // undefined
    ];
    const agg = aggregateBySignal(records);
    const sig = agg.get('beta')!;
    expect(sig.keep).toBe(2);
    expect(sig.reject).toBe(1);
    expect(sig.cycles.size).toBe(0);   // aucun cycle_id valide → 0
  });

  // SS-C8b : mix ancien + nouveau
  test('SS-C8b — mix ancien (sans cycle_id) + nouveau (avec cycle_id) → cycles compte seulement les nouveaux', () => {
    const records: RecordInput[] = [
      { matched_signals: ['gamma'], decision: 'keep', cycle_id: null },  // ancien
      { matched_signals: ['gamma'], decision: 'keep', cycle_id: 'C1' }, // nouveau
    ];
    const agg = aggregateBySignal(records);
    const sig = agg.get('gamma')!;
    expect(sig.keep).toBe(2);
    expect(sig.cycles.size).toBe(1);   // seul C1 est compté
  });

});

// ─── Tests : isPromotionReady ─────────────────────────────────────────────────

describe('review-cycle — isPromotionReady (bloqué si cycles insuffisants)', () => {

  // SS-C9 : statistiquement très fiable mais 1 seul cycle → promotion_ready = false
  test('SS-C9 — Très fiable statistiquement, cycles.size=1 → promotion_ready=false', () => {
    const records: RecordInput[] = [
      { matched_signals: ['sig'], decision: 'keep', cycle_id: 'C1' },
      { matched_signals: ['sig'], decision: 'keep', cycle_id: 'C1' },
      { matched_signals: ['sig'], decision: 'keep', cycle_id: 'C1' },
    ];
    const agg = aggregateBySignal(records);
    const sig = agg.get('sig')!;
    expect(isStatisticallyStrong(sig)).toBe(true);   // fort statistiquement
    expect(isPromotionReady(sig)).toBe(false);        // bloqué : 1 seul cycle
  });

  // SS-C10 : très fiable et 2 cycles distincts → promotion_ready = true
  test('SS-C10 — Très fiable statistiquement, cycles.size=2 → promotion_ready=true', () => {
    const records: RecordInput[] = [
      { matched_signals: ['sig'], decision: 'keep', cycle_id: 'C1' },
      { matched_signals: ['sig'], decision: 'keep', cycle_id: 'C1' },
      { matched_signals: ['sig'], decision: 'keep', cycle_id: 'C2' },
    ];
    const agg = aggregateBySignal(records);
    const sig = agg.get('sig')!;
    expect(isStatisticallyStrong(sig)).toBe(true);
    expect(isPromotionReady(sig)).toBe(true);
  });

  // SS-C10b : cycles=0 (tous legacy) → promotion_ready = false même si stats fortes
  test('SS-C10b — anciens records sans cycle_id → promotion_ready=false même si stats fortes', () => {
    const records: RecordInput[] = [
      { matched_signals: ['sig'], decision: 'keep', cycle_id: null },
      { matched_signals: ['sig'], decision: 'keep', cycle_id: null },
      { matched_signals: ['sig'], decision: 'keep', cycle_id: null },
    ];
    const agg = aggregateBySignal(records);
    const sig = agg.get('sig')!;
    expect(isStatisticallyStrong(sig)).toBe(true);    // total=3, 100% keep
    expect(sig.cycles.size).toBe(0);
    expect(isPromotionReady(sig)).toBe(false);         // bloqué : aucun cycle tracé
  });

  // SS-C10c : exactement 2 cycles (borne minimale)
  test('SS-C10c — cycles.size=2 est la borne minimale pour promotion_ready=true', () => {
    const buildSig = (nCycles: number): AggSignal => {
      const records: RecordInput[] = Array.from({ length: nCycles }, (_, i) => ({
        matched_signals: ['sig'], decision: 'keep', cycle_id: 'C' + (i + 1),
      }));
      return aggregateBySignal(records).get('sig')!;
    };
    expect(isPromotionReady(buildSig(1))).toBe(false);
    expect(isPromotionReady(buildSig(2))).toBe(true);
    expect(isPromotionReady(buildSig(3))).toBe(true);

  });

});
