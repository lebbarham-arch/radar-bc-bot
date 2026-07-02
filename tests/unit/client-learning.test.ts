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

// GD-124 : sources consultatives — advisory only, ne peuvent pas déclencher promotion seules
const AI_ADVISORY_SOURCES_CL = ['ai_assisted_validated'];
function isAdvisorySourceCL(src: string): boolean {
  return AI_ADVISORY_SOURCES_CL.indexOf(src) !== -1;
}

function computeReadiness(sig: {
  cycles: Set<string>; verdict: string; reject: number; keep: number; total: number;
  keep_base?: number; reject_base?: number; ignore_base?: number; total_base?: number;
  cycles_base?: Set<string>; has_advisory_source?: boolean;
}) {
  const cyclesSz = sig.cycles.size;
  const blockers: string[] = [];
  if (cyclesSz < 2)              blockers.push('insufficient_cycles');
  if (sig.reject > sig.keep)     blockers.push('risky_signal');
  if (sig.total  < 3)            blockers.push('insufficient_data');
  // GD-124 : si le signal serait READY mais contient des sources advisory,
  // vérifier que les stats base (hors advisory) suffisent seules.
  if (blockers.length === 0 && POSITIVE_VERDICTS.includes(sig.verdict) && sig.has_advisory_source) {
    const kb  = sig.keep_base   ?? 0;
    const rb  = sig.reject_base ?? 0;
    const tb  = sig.total_base  ?? 0;
    const csz = sig.cycles_base ? sig.cycles_base.size : 0;
    const baseVerdict  = classifyVerdictCL(kb, rb, tb);
    const baseBlockers: string[] = [];
    if (csz < 2) baseBlockers.push('insufficient_cycles');
    if (rb > kb) baseBlockers.push('risky_signal');
    if (tb < 3)  baseBlockers.push('insufficient_data');
    const baseReady = baseBlockers.length === 0 && POSITIVE_VERDICTS.includes(baseVerdict);
    if (!baseReady) blockers.push('blocked_by_ai_assisted_only');
  }
  const ready = blockers.length === 0 && POSITIVE_VERDICTS.includes(sig.verdict);
  return { ready, blockers };
}

// ─── Mirror : normalizeLearningKey (GD-109) ──────────────────────────────────
// Identique à scripts/learning-key-utils.js

function normalizeLearningKey(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ─── Mirror : aggregate (GD-109 : clés normalisées pour agrégation) ───────────
// Clé interne = normalisée (fusionne hygiene + hygiène).
// Résultat Map = indexé par label original (premier vu) pour rétrocompatibilité.

interface InternalSigEntry {
  signal: string; label: string;
  keep: number; reject: number; ignore: number;
  total: number;
  // GD-124 : stats hors sources advisory
  keep_base: number; reject_base: number; ignore_base: number; total_base: number;
  cycles: Set<string>; cycles_base: Set<string>;
  sources: Set<string>;
  has_advisory_source: boolean;
}

function aggregate(records: ReviewRecord[], rawRecords?: ReviewRecord[]): Map<string, SigEntry[]> {
  // byClient : clé = ck (normalisée), valeur = { _label, [sk]: InternalSigEntry }
  const byClient = new Map<string, Map<string, InternalSigEntry | string>>();
  // labels map : ck → rawClient label
  const clientLabels = new Map<string, string>();

  // Phase 1 : stats keep/reject/ignore/total depuis les records dédupliqués
  for (const r of records) {
    const rawClient = (r.client || '(inconnu)').trim();
    const ck        = normalizeLearningKey(rawClient) || rawClient;

    if (!byClient.has(ck)) {
      byClient.set(ck, new Map());
      clientLabels.set(ck, rawClient);  // premier label vu
    }
    const sigMap = byClient.get(ck)!;

    if (!Array.isArray(r.matched_signals) || r.matched_signals.length === 0) continue;

    for (const s of r.matched_signals) {
      const rawSig = (s || '').trim();
      if (!rawSig) continue;
      const sk = normalizeLearningKey(rawSig) || rawSig;

      if (!sigMap.has(sk)) {
        sigMap.set(sk, {
          signal: sk, label: rawSig,
          keep: 0, reject: 0, ignore: 0, total: 0,
          // GD-124 : champs base (hors advisory)
          keep_base: 0, reject_base: 0, ignore_base: 0, total_base: 0,
          cycles: new Set(), cycles_base: new Set(),
          sources: new Set(),
          has_advisory_source: false,
        });
      }
      const e = sigMap.get(sk) as InternalSigEntry;
      if (r.decision === 'keep' || r.decision === 'reject' || r.decision === 'ignore') {
        (e as unknown as Record<string, unknown>)[r.decision] = ((e as unknown as Record<string, unknown>)[r.decision] as number ?? 0) + 1;
      }
      e.total++;
      // GD-124 : stats base (hors advisory) depuis les records dédupliqués
      const src_dedup = r.review_source || 'operator';
      if (!isAdvisorySourceCL(src_dedup)) {
        if (r.decision === 'keep') e.keep_base++;
        else if (r.decision === 'reject') e.reject_base++;
        else if (r.decision === 'ignore') e.ignore_base++;
        e.total_base++;
      }
    }
  }

  // Phase 2 : cycles et sources depuis tous les records bruts (avant dedup)
  for (const r of (rawRecords ?? records)) {
    const rawClient = (r.client || '(inconnu)').trim();
    const ck        = normalizeLearningKey(rawClient) || rawClient;
    const src       = r.review_source || 'operator';

    if (!byClient.has(ck)) continue;
    const sigMap = byClient.get(ck)!;

    if (!Array.isArray(r.matched_signals) || r.matched_signals.length === 0) continue;

    for (const s of r.matched_signals) {
      const rawSig = (s || '').trim();
      if (!rawSig) continue;
      const sk = normalizeLearningKey(rawSig) || rawSig;
      if (!sigMap.has(sk)) continue;

      const e = sigMap.get(sk) as InternalSigEntry;
      if (r.cycle_id)  e.cycles.add(r.cycle_id);
      e.sources.add(src);
      // GD-124 : cycles_base et has_advisory_source depuis rawRecords
      if (isAdvisorySourceCL(src)) {
        e.has_advisory_source = true;
      } else {
        if (r.cycle_id) e.cycles_base.add(r.cycle_id);
      }
    }
  }

  // Construction du résultat indexé par label original (rétrocompatibilité)
  const result = new Map<string, SigEntry[]>();
  for (const [ck, sigMap] of byClient) {
    const clientLabel = clientLabels.get(ck) || ck;
    const sigReport: SigEntry[] = [];
    for (const [, entry] of sigMap) {
      const e       = entry as InternalSigEntry;
      const verdict = classifyVerdictCL(e.keep, e.reject, e.total);
      const readiness = computeReadiness({
        cycles: e.cycles, verdict, reject: e.reject, keep: e.keep, total: e.total,
        // GD-124 : champs base pour détection blocked_by_ai_assisted_only
        keep_base: e.keep_base, reject_base: e.reject_base, ignore_base: e.ignore_base,
        total_base: e.total_base, cycles_base: e.cycles_base,
        has_advisory_source: e.has_advisory_source,
      });
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
    result.set(clientLabel, sigReport);
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

// ─── Tests P4 : historique multi-cycles (rawRecords séparés) ─────────────────

describe('client-learning P4 — cycles depuis rawRecords', () => {

  // SS-CL-P4-1 : même bc_id sur 2 cycles → dedup=1 record, cycles_count=2
  test('SS-CL-P4-1 — même bc_id sur 2 cycles → decision dédupliquée=1, cycles_count=2', () => {
    const raw: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep',   matched_signals: ['sig'], cycle_id: 'C1' },
      { client: 'X', bc_id: '1', decision: 'reject',  matched_signals: ['sig'], cycle_id: 'C2' },
    ];
    // Simulation last-wins : seul le dernier record par bc_id
    const deduped: ReviewRecord[] = [raw[1]!];
    const report = aggregate(deduped, raw);
    const sig = report.get('X')![0]!;
    expect(sig.keep).toBe(0);       // deduped : uniquement le reject
    expect(sig.reject).toBe(1);     // deduped : uniquement le reject
    expect(sig.total).toBe(1);
    expect(sig.cycles.size).toBe(2);  // raw : C1 + C2
  });

  // SS-CL-P4-2 : 2 bc_ids distincts sur 2 cycles → cycles_count=2
  test('SS-CL-P4-2 — 2 bc_ids distincts sur 2 cycles → cycles_count=2', () => {
    const raw: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1' },
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C2' },
    ];
    const report = aggregate(raw, raw);
    const sig = report.get('X')![0]!;
    expect(sig.total).toBe(2);
    expect(sig.cycles.size).toBe(2);
  });

  // SS-CL-P4-3 : legacy sans cycle_id dans raw → compté dans stats, pas dans cycles
  test('SS-CL-P4-3 — legacy sans cycle_id dans raw → stats ok, cycles.size inchangé', () => {
    const raw: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'] },  // pas de cycle_id
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1' },
    ];
    const report = aggregate(raw, raw);
    const sig = report.get('X')![0]!;
    expect(sig.total).toBe(2);
    expect(sig.cycles.size).toBe(1);  // seulement C1, pas le legacy
  });

  // SS-CL-P4-4 : sources calculées depuis rawRecords → mix operator+client détecté
  test('SS-CL-P4-4 — sources depuis rawRecords → warn_mixed_sources=true même si dedup=1', () => {
    const raw: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1', review_source: 'operator' },
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C2', review_source: 'client'   },
    ];
    // Simulation last-wins : seul le dernier record (client source)
    const deduped: ReviewRecord[] = [raw[1]!];
    const report = aggregate(deduped, raw);
    const sig = report.get('X')![0]!;
    expect(sig.cycles.size).toBe(2);               // C1 + C2 depuis raw
    expect(sig.sources.has('operator')).toBe(true); // depuis raw
    expect(sig.sources.has('client')).toBe(true);   // depuis raw
    expect(sig.warn_mixed_sources).toBe(true);
  });

});

// ─── Tests GD-109 : normalisation des clés learning ──────────────────────────

describe('client-learning GD-109 — normalisation client_key + signal_key', () => {

  // SS-CL-N1 : "Nettoyage Hygiene" et "Nettoyage Hygiène" → même bucket client
  test('SS-CL-N1 — clients avec/sans accent → bucket client fusionné', () => {
    const records: ReviewRecord[] = [
      { client: 'Nettoyage Hygiene',  bc_id: '1', decision: 'keep',   matched_signals: ['nettoyage'], cycle_id: 'C1' },
      { client: 'Nettoyage Hygiène',  bc_id: '2', decision: 'keep',   matched_signals: ['nettoyage'], cycle_id: 'C2' },
    ];
    const report = aggregate(records);
    // Un seul client agrégé (les deux labels normalisés → même clé)
    expect(report.size).toBe(1);
    // Le signal agrégé a 2 keeps
    const sigs = Array.from(report.values())[0]!;
    const sig  = sigs.find(s => s.signal === 'nettoyage')!;
    expect(sig).toBeTruthy();
    expect(sig.keep).toBe(2);
    expect(sig.total).toBe(2);
  });

  // SS-CL-N2 : "hygiene" et "hygiène" dans même client → bucket signal fusionné
  test('SS-CL-N2 — signaux hygiene + hygiène → bucket signal fusionné', () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep',   matched_signals: ['hygiene'],  cycle_id: 'C1' },
      { client: 'X', bc_id: '2', decision: 'reject',  matched_signals: ['hygiène'], cycle_id: 'C2' },
    ];
    const report = aggregate(records);
    const sigs   = report.get('X')!;
    // Un seul bucket signal (hygiene + hygiène fusionnés)
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.keep).toBe(1);
    expect(sigs[0]!.reject).toBe(1);
    expect(sigs[0]!.total).toBe(2);
  });

  // SS-CL-N3 : "deratisation" et "dératisation" → fusionnés
  test('SS-CL-N3 — deratisation + dératisation → bucket signal fusionné', () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['deratisation'],  cycle_id: 'C1' },
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['dératisation'], cycle_id: 'C2' },
    ];
    const report = aggregate(records);
    const sigs   = report.get('X')!;
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.total).toBe(2);
    expect(sigs[0]!.keep).toBe(2);
    expect(sigs[0]!.cycles.size).toBe(2);
  });

  // SS-CL-N4 : signaux sémantiquement différents restent distincts
  test('SS-CL-N4 — nettoyage ≠ hygiene après normalisation', () => {
    const records: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['nettoyage'], cycle_id: 'C1' },
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['hygiene'],   cycle_id: 'C2' },
    ];
    const report = aggregate(records);
    const sigs   = report.get('X')!;
    // Deux buckets distincts
    expect(sigs.length).toBe(2);
  });

  // SS-CL-N5 : scores/décisions non modifiés par la normalisation
  test('SS-CL-N5 — normalisation ne modifie pas les décisions ou scores', () => {
    const records: ReviewRecord[] = [
      { client: 'ClientA', bc_id: '10', decision: 'keep',   matched_signals: ['hygiene'],  cycle_id: 'C1' },
      { client: 'ClientA', bc_id: '11', decision: 'keep',   matched_signals: ['hygiène'],  cycle_id: 'C2' },
      { client: 'ClientA', bc_id: '12', decision: 'reject',  matched_signals: ['hygiene'],  cycle_id: 'C3' },
    ];
    const report = aggregate(records);
    const sigs   = report.get('ClientA')!;
    const sig    = sigs[0]!;
    // Statistiques préservées exactement
    expect(sig.keep).toBe(2);
    expect(sig.reject).toBe(1);
    expect(sig.ignore).toBe(0);
    expect(sig.total).toBe(3);
    expect(sig.cycles.size).toBe(3);
  });

});


// ─── Tests GD-124 : source-awareness (SA) ─────────────────────────────────────
// Valide que ai_assisted_validated est advisory only et ne peut pas déclencher
// promotion_ready seul (blocked_by_ai_assisted_only).

describe('client-learning GD-124 — source-awareness', () => {

  // SA-1 : signal READY (operator seul) → reste READY même si advisory présent en plus
  test('SA-1 — base operator suffit → READY même avec advisory mixte (pas de blocage)', () => {
    const sig = {
      cycles: new Set(['C1', 'C2', 'ai-cycle']),
      verdict: 'Tres fiable',
      reject: 0, keep: 5, total: 5,
      keep_base: 3, reject_base: 0, ignore_base: 0, total_base: 3,
      cycles_base: new Set(['C1', 'C2']),
      has_advisory_source: true,   // advisory présent, mais base suffit
    };
    const { ready, blockers } = computeReadiness(sig);
    expect(ready).toBe(true);
    expect(blockers).not.toContain('blocked_by_ai_assisted_only');
    expect(blockers).toHaveLength(0);
  });

  // SA-2 : signal READY uniquement via ai_assisted_validated → bloqué
  test('SA-2 — base vide (advisory only) → blocked_by_ai_assisted_only, ready=false', () => {
    const sig = {
      cycles: new Set(['ai-cycle-1', 'ai-cycle-2']),
      verdict: 'Tres fiable',
      reject: 0, keep: 5, total: 5,
      keep_base: 0, reject_base: 0, ignore_base: 0, total_base: 0,  // base vide
      cycles_base: new Set<string>(),
      has_advisory_source: true,
    };
    const { ready, blockers } = computeReadiness(sig);
    expect(ready).toBe(false);
    expect(blockers).toContain('blocked_by_ai_assisted_only');
  });

  // SA-3 : has_advisory_source=false → la logique GD-124 ne se déclenche pas
  test('SA-3 — has_advisory_source=false → pas de blocked_by_ai_assisted_only', () => {
    const sig = {
      cycles: new Set(['C1', 'C2']),
      verdict: 'Tres fiable',
      reject: 0, keep: 3, total: 3,
      keep_base: 3, reject_base: 0, ignore_base: 0, total_base: 3,
      cycles_base: new Set(['C1', 'C2']),
      has_advisory_source: false,
    };
    const { ready, blockers } = computeReadiness(sig);
    expect(ready).toBe(true);
    expect(blockers).not.toContain('blocked_by_ai_assisted_only');
  });

  // SA-4 : cycles ai_assisted_validated exclus de cycles_base
  // Scénario : 3 keeps operator sur 1 seul cycle (C1) + 1 keep advisory sur cycle distinct
  // → cycles total=2 (C1 + ai-cycle), cycles_base=1 (C1 seul) → base bloquée par insufficient_cycles
  // → blocked_by_ai_assisted_only attendu
  test('SA-4 — cycles advisory exclus de cycles_base → bloqué si 1 seul cycle base', () => {
    const raw: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1', review_source: 'operator' },
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1', review_source: 'operator' },
      { client: 'X', bc_id: '3', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1', review_source: 'operator' },
      { client: 'X', bc_id: '4', decision: 'keep', matched_signals: ['sig'], cycle_id: 'ai-cycle', review_source: 'ai_assisted_validated' },
    ];
    const report = aggregate(raw, raw);
    const sig = report.get('X')![0]!;
    // cycles total = 2 (C1 + ai-cycle) — suffirait sans GD-124
    expect(sig.cycles.size).toBe(2);
    // total = 4 — suffisant
    expect(sig.total).toBe(4);
    // Mais cycles_base = 1 (seul C1), donc base bloquée par insufficient_cycles
    // → blocked_by_ai_assisted_only
    expect(sig.blockers).toContain('blocked_by_ai_assisted_only');
    expect(sig.promotion_ready).toBe(false);
  });

  // SA-7 : source mixte (operator + advisory), base déjà READY → READY sans blocage
  // Scénario : 3 keeps operator sur 2 cycles (C1, C2) + 2 keeps advisory
  // → base: kb=3, tb=3, csz=2 → READY → pas de blocked_by_ai_assisted_only
  test('SA-7 — base operator déjà READY + advisory mixte → READY, pas de blocage', () => {
    const raw: ReviewRecord[] = [
      { client: 'X', bc_id: '1', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C1', review_source: 'operator' },
      { client: 'X', bc_id: '2', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C2', review_source: 'operator' },
      { client: 'X', bc_id: '3', decision: 'keep', matched_signals: ['sig'], cycle_id: 'C2', review_source: 'operator' },
      { client: 'X', bc_id: '4', decision: 'keep', matched_signals: ['sig'], cycle_id: 'ai-c1', review_source: 'ai_assisted_validated' },
      { client: 'X', bc_id: '5', decision: 'keep', matched_signals: ['sig'], cycle_id: 'ai-c2', review_source: 'ai_assisted_validated' },
    ];
    const report = aggregate(raw, raw);
    const sig = report.get('X')![0]!;
    expect(sig.promotion_ready).toBe(true);
    expect(sig.blockers).not.toContain('blocked_by_ai_assisted_only');
    expect(sig.blockers).toHaveLength(0);
  });

});

export {};
