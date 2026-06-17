/**
 * Tests unitaires — client-learning (P3 : rapport apprentissage par client)
 *
 * Couvre les fonctions ajoutées dans :
 *   - scripts/analyze-client-learning.js
 *     (aggregate, classifyVerdict, computeReadiness)
 *
 * Miroir pur — aucune dépendance FS, aucun import des scripts JS.
 * Aucune règle spécifique à un signal ou un client.
 *
 * Nomenclature : SS-CL (Scan Summary Client Learning)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReviewRecord {
  client:          string;
  bc_id:           string;
  decision:        string;
  matched_signals?: string[];
  cycle_id?:       string | null;
  review_source?:  string;
}

interface SigEntry {
  signal:          string;
  keep:            number;
  reject:          number;
  ignore:          number;
  total:           number;
  cycles:          Set<string>;
  sources:         Set<string>;
  verdict:         string;
  promotion_ready: boolean;
  blockers:        string[];
  warn_mixed_sources: boolean;
}

// ─── Mirror : classifyVerdict ─────────────────────────────────────────────────

function classifyVerdictCL(keep: number, reject: number, total: number): string {
  if (!total) return 'Insuffisant';
  const kr = keep   / total;
  const rr = reject / total;
  if (kr >= 0.8 && total >= 2) return 'Tres fiable';
  if (kr >= 0.6 && total >= 2) return 'Fiable';
  if (rr >= 0.8 && total >= 2) return 'Risque';
  if (total === 1)              return 'Insuffisant';
  return 'Ambigu';
}

// ─── Mirror : computeReadiness ────────────────────────────────────────────────

const POSITIVE_VERDICTS = ['Tres fiable', 'Fiable'];

function computeReadiness(sig: { cycles: Set<string>; verdict: string; reject: number; keep: number; total: number }) {
  const cyclesSz = sig.cycles.size;
  const blockers: string[] = [];
  if (cyclesSz < 2)              blockers.push('insufficient_cycles');
  if (sig.reject > sig.keep)     blockers.push('risky_signal');
  if (sig.total  < 3)            blockers.push('insufficient_data');
  const ready = blockers.length === 0 && POSITIVE_VERDICTS.includes(sig.verdict);
  return { ready, blockers };
}

// ─── Mirror : aggregate ───────────────────────────────────────────────────────

function aggregate(records: ReviewRecord[]): Map<string, SigEntry[]> {
  const byClient = new Map<string, Map<string, {
    signal: string; keep: number; reject: number; ignore: number;
    total: number; cycles: Set<string>; sources: Set<string>;
  }>>();

  for (const r of records) {
    const client = (r.client || '(inconnu)').trim();
    const src    = r.review_source || 'operator';

    if (!byClient.has(client)) byClient.set(client, new Map());
    const sigMap = byClient.get(client)!;

    if (!Array.isArray(r.matched_signals) || r.matched_signals.length === 0) continue;

    for (const s of r.matched_signals) {
      const sig = (s || '').trim();
      if (!sig) continue;

      if (!sigMap.has(sig)) {
        sigMap.set(sig, { signal: sig, keep: 0, reject: 0, ignore: 0, total: 0, cycles: new Set(), sources: new Set() });
      }
      const e = sigMap.get(sig)!;
      if (r.decision === 'keep' || r.decision === 'reject' || r.decision === 'ignore') {
        const eRec = e as unknown as Record<string, unknown>;
        eRec[r.decision] = ((eRec[r.decision] as number | undefined) ?? 0) + 1;
      }
      e.total++;
      if (r.cycle_id)  e.cycles.add(r.cycle_id);
      e.sources.add(src);
    }
  }

  const result = new Map<string, SigEntry[]>();
  for (const [client, sigMap] of byClient) {
    const sigReport: SigEntry[] = [];
    for (const [, e] of sigMap) {
      const verdict   = classifyVerdictCL(e.keep, e.reject, e.total);
      const readiness = computeReadiness({ cycles: e.cycles, verdict, reject: e.reject, keep: e.keep, total: e.total });
      sigReport.push({
        signal:          e.signal,
        keep:            e.keep,
        reject:          e.reject,
        ignore:          e.ignore,
        total:           e.total,
        cycles:          e.cycles,
        sources:         e.sources,
        verdict,
        promotion_ready: readiness.ready,
        blockers:        readiness.blockers,
        warn_mixed_sources: e.sources.size > 1,
      });
    }
    result.set(client, sigReport);
  }
  return result;
}

// ─── Tests : agrégation par client distinct ───────────────────────────────────

describe('client-learning — agrégation par client distinct', () => {

  // SS-CL1 : deux clients distincts → deux entrées séparées
  test('SS-CL1 — deux clients distincts → deux clés dans le rapport', () => {
    const records: ReviewRecord[] = [
      { client: 'ClientA', bc_id: '1', decision: 'keep',   matched_signals: ['alpha'], cycle_id: 'C1' },
      { client: 'ClientB', bc_id: '2', decision: 'reject', matched_signals: ['alpha'], cycle_id: 'C1' },
    ];
    const report = aggregate(records);
    expect(report.has('ClientA')).toBe(true);
    expect(report.has('ClientB')).toBe(true);
    expect(report.size).toBe(2);
  });

  // SS-CL2 : même signal, deux clients → stats indépendantes
  test('SS-CL2 — même signal chez deux clients → stats indépendantes', () => {
    const records: ReviewRecord[] = [
      { client: 'ClientA', bc_id: '1', decision: 'keep',   matched_signals: ['alpha'], cycle_id: 'C1' },
      { client: 'ClientA', bc_id: '2', decision: 'keep',   matched_signals: ['alpha'], cycle_id: 'C1' },
      { client: 'ClientB', bc_id: '3', decision: 'reject', matched_signals: ['alpha'], cycle_id: 'C1' },
    ];
    const report = aggregate(records);
    const sigA = report.get('ClientA')!.find(s => s.signal === 'alpha')!;
    const sigB = report.get('ClientB')!.find(s => s.signal === 'alpha')!;
    expect(sigA.keep).toBe(2);
    expect(sigA.reject).toBe(0);
    expect(sigB.keep).toBe(0);
    expect(sigB.reject).toBe(1);
  });

});

// ─── Tests : cycles_count par signal ─────────────────────────────────────────

describe('client-learning — cycles_count par signal', () => {

  // SS-CL3 : plusieurs records du même cycle → cycles.size = 1
  test('SS-CL3 — 3 records sur le même cycle_id → cycles_count = 1', () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1' },
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1' },
    ];
    const report = aggregate(records);
    const sig = report.get('X')![0]!;
    expect(sig.cycles.size).toBe(1);
  });

  // SS-CL4 : deux cycles distincts → cycles.size = 2
  test('SS-CL4 — records sur 2 cycle_id distincts → cycles_count = 2', () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1' },
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C2' },
    ];
    const report = aggregate(records);
    const sig = report.get('X')![0]!;
    expect(sig.cycles.size).toBe(2);
  });

});

// ─── Tests : compatibilité anciens records ────────────────────────────────────

describe('client-learning — compatibilité anciens records sans cycle_id', () => {

  // SS-CL5 : anciens records sans cycle_id → keep/reject comptés, cycles=0
  test('SS-CL5 — anciens records sans cycle_id : stats comptées, cycles.size = 0', () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep',   matched_signals: ['sig'] },  // pas de cycle_id
      { client: 'X', bc_id: '2', decision: 'reject',  matched_signals: ['sig'] },
    ];
    const report = aggregate(records);
    const sig = report.get('X')![0]!;
    expect(sig.keep).toBe(1);
    expect(sig.reject).toBe(1);
    expect(sig.cycles.size).toBe(0);  // aucun cycle tracé
  });

  // SS-CL6 : record sans matched_signals → ignoré pour l'agrégation signal
  test('SS-CL6 — record sans matched_signals → aucun signal agrégé', () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep' },  // pas de matched_signals
    ];
    const report = aggregate(records);
    // le client n'est pas dans le rapport car aucun signal n'a été agrégé
    const sigs = report.get('X');
    expect(!sigs || sigs.length === 0).toBe(true);
  });

});

// ─── Tests : review_source défaut operator ────────────────────────────────────

describe('client-learning — review_source défaut operator', () => {

  // SS-CL7 : record sans review_source → sources contient 'operator'
  test("SS-CL7 — record sans review_source → sources contient 'operator'", () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1' },
      // pas de review_source
    ];
    const report = aggregate(records);
    const sig = report.get('X')![0]!;
    expect(sig.sources.has('operator')).toBe(true);
  });

});

// ─── Tests : promotion_ready ──────────────────────────────────────────────────

describe('client-learning — promotion_ready', () => {

  // SS-CL8 : fort statistiquement mais 1 seul cycle → promotion_ready = false
  test('SS-CL8 — cycles_count=1, verdict positif → promotion_ready=false', () => {
    const sig = {
      cycles: new Set(['C1']),
      verdict: 'Tres fiable',
      reject: 0, keep: 3, total: 3,
    };
    const { ready, blockers } = computeReadiness(sig);
    expect(ready).toBe(false);
    expect(blockers).toContain('insufficient_cycles');
  });

  // SS-CL9 : 2 cycles + verdict Tres fiable → promotion_ready = true
  test('SS-CL9 — cycles_count=2, verdict Tres fiable → promotion_ready=true', () => {
    const sig = {
      cycles: new Set(['C1', 'C2']),
      verdict: 'Tres fiable',
      reject: 0, keep: 4, total: 4,
    };
    const { ready, blockers } = computeReadiness(sig);
    expect(ready).toBe(true);
    expect(blockers).toHaveLength(0);
  });

  // SS-CL9b : 2 cycles + verdict Fiable → promotion_ready = true
  test('SS-CL9b — cycles_count=2, verdict Fiable → promotion_ready=true', () => {
    const sig = {
      cycles: new Set(['C1', 'C2']),
      verdict: 'Fiable',
      reject: 1, keep: 3, total: 4,
    };
    const { ready } = computeReadiness(sig);
    expect(ready).toBe(true);
  });

});

// ─── Tests : risky_signal ─────────────────────────────────────────────────────

describe('client-learning — risky_signal blocker', () => {

  // SS-CL10 : reject > keep → risky_signal dans blockers
  test('SS-CL10 — reject > keep → blocker risky_signal', () => {
    const sig = {
      cycles: new Set(['C1', 'C2']),
      verdict: 'Risque',
      reject: 3, keep: 0, total: 3,
    };
    const { ready, blockers } = computeReadiness(sig);
    expect(ready).toBe(false);
    expect(blockers).toContain('risky_signal');
  });

  // SS-CL10b : reject = keep → pas de risky_signal
  test('SS-CL10b — reject = keep → pas de risky_signal', () => {
    const sig = {
      cycles: new Set(['C1', 'C2']),
      verdict: 'Ambigu',
      reject: 2, keep: 2, total: 4,
    };
    const { blockers } = computeReadiness(sig);
    expect(blockers).not.toContain('risky_signal');
  });

});

// ─── Tests : warning sources mixtes ──────────────────────────────────────────

describe('client-learning — warning sources mixtes', () => {

  // SS-CL11 : mix operator + client → warn_mixed_sources = true
  test('SS-CL11 — sources operator + client → warn_mixed_sources=true', () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1', review_source: 'operator' },
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C2', review_source: 'client'   },
    ];
    const report = aggregate(records);
    const sig = report.get('X')![0]!;
    expect(sig.warn_mixed_sources).toBe(true);
    expect(sig.sources.has('operator')).toBe(true);
    expect(sig.sources.has('client')).toBe(true);
  });

  // SS-CL12 : source unique operator → warn_mixed_sources = false
  test('SS-CL12 — source unique operator → warn_mixed_sources=false', () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1', review_source: 'operator' },
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C2', review_source: 'operator' },
    ];
    const report = aggregate(records);
    const sig = report.get('X')![0]!;
    expect(sig.warn_mixed_sources).toBe(false);
  });

});
