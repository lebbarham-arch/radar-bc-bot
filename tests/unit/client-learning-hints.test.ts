/**
 * Tests unitaires — client-learning-hints (P4b)
 *
 * Couvre la logique de scripts/build-client-learning-hints.js :
 *   - computeHint (5 règles génériques, sans spécificité signal/client)
 *   - buildHints (structure JSON de sortie)
 *
 * Miroir pur — aucune dépendance FS, aucun import des scripts JS.
 * Aucune règle spécifique à un signal ou un client.
 *
 * Nomenclature : SS-CLH (Scan Summary Client Learning Hints)
 */

// ─── Types miroir ─────────────────────────────────────────────────────────────

interface SigStats {
  signal:  string;
  keep:    number;
  reject:  number;
  ignore:  number;
  total:   number;
  cycles:  Set<string>;
  sources: Set<string>;
  // GD-124 : champs base (hors sources advisory)
  keep_base?:   number;
  reject_base?: number;
  ignore_base?: number;
  total_base?:  number;
  cycles_base?: Set<string>;
}

interface Hint {
  signal:             string;
  keep:               number;
  reject:             number;
  ignore:             number;
  total:              number;
  keep_rate:          number;
  reject_rate:        number;
  cycles_count:       number;
  sources:            string[];
  verdict:            string;
  promotion_ready:    boolean;
  recommended_effect: string;
  score_adjustment:   number;
  block_auto_notify:  boolean;
  reason:             string;
  // GD-124
  advisory_only?:             boolean;
  human_validation_required?: boolean;
}

// ─── Mirror : computeVerdict ──────────────────────────────────────────────────

function computeVerdict(keep: number, reject: number, total: number): string {
  if (!total) return 'Insuffisant';
  const kr = keep   / total;
  const rr = reject / total;
  if (kr >= 0.8 && total >= 2) return 'Tres fiable';
  if (kr >= 0.6 && total >= 2) return 'Fiable';
  if (rr >= 0.8 && total >= 2) return 'Risque';
  if (total === 1)              return 'Insuffisant';
  return 'Ambigu';
}

// ─── Mirror : computeHint (GD-124 — source-aware) ───────────────────────────
// Aucune règle spécifique à un signal ou un client.

// GD-124 : sources advisory — ne peuvent pas déclencher boost/promotion seules
const AI_ADVISORY_SOURCES_CLH = ['ai_assisted_validated'];
function isAdvisorySourceCLH(src: string): boolean {
  return AI_ADVISORY_SOURCES_CLH.indexOf(src) !== -1;
}

function computeHint(e: SigStats): Hint {
  const cyclesCount = e.cycles.size;
  const keepRate    = e.total > 0 ? Math.round(e.keep   / e.total * 100) : 0;
  const rejectRate  = e.total > 0 ? Math.round(e.reject / e.total * 100) : 0;

  let effect: string, scoreAdj: number, blockAuto: boolean, reason: string;

  if (cyclesCount < 2) {
    effect    = 'insufficient_data';
    scoreAdj  = 0;
    blockAuto = true;
    reason    = `Cycles insuffisants (${cyclesCount}/2 requis) — décision non fiable`;
  } else if (e.total < 3) {
    effect    = 'keep_review';
    scoreAdj  = 0;
    blockAuto = true;
    reason    = `Données insuffisantes (${e.total} décisions, minimum 3)`;
  } else if (e.reject > e.keep) {
    effect    = 'demote_to_review';
    scoreAdj  = -3;
    blockAuto = true;
    reason    = 'Signal rejeté/ignoré pour ce client sur plusieurs cycles';
  } else if (keepRate >= 80 && cyclesCount >= 2 && e.total >= 3) {
    effect    = 'boost';
    scoreAdj  = +5;
    blockAuto = false;
    reason    = `Signal fiable pour ce client (keep_rate=${keepRate}%, cycles=${cyclesCount})`;
  } else {
    effect    = 'keep_review';
    scoreAdj  = 0;
    blockAuto = true;
    reason    = 'Signal ambigu — maintenir en review humaine';
  }

  // GD-124 : si boost prévu mais uniquement dû à sources advisory, rétrograder.
  const sourcesArr  = Array.from(e.sources).sort();
  const hasAdvisory = sourcesArr.some(s => isAdvisorySourceCLH(s));
  let advisoryOnly  = false;
  if (hasAdvisory && effect === 'boost') {
    const kb       = e.keep_base   ?? 0;
    const rb       = e.reject_base ?? 0;
    const tb       = e.total_base  ?? 0;
    const csz      = e.cycles_base ? e.cycles_base.size : 0;
    const baseRate = tb > 0 ? Math.round(kb / tb * 100) : 0;
    const baseBoost = csz >= 2 && baseRate >= 80 && tb >= 3;
    if (!baseBoost) {
      advisoryOnly = true;
      effect    = 'keep_review';
      scoreAdj  = 0;
      blockAuto = true;
      reason    = `GD-124: boost bloqué — sources advisory uniquement (base keep_rate=${baseRate}%, base_cycles=${csz}, base_total=${tb}). Validation humaine requise.`;
    }
  }

  return {
    signal:             e.signal,
    keep:               e.keep,
    reject:             e.reject,
    ignore:             e.ignore,
    total:              e.total,
    keep_rate:          keepRate,
    reject_rate:        rejectRate,
    cycles_count:       cyclesCount,
    sources:            sourcesArr,
    verdict:            computeVerdict(e.keep, e.reject, e.total),
    promotion_ready:    cyclesCount >= 2 && keepRate >= 80 && e.total >= 3 && !advisoryOnly,
    recommended_effect: effect,
    score_adjustment:   scoreAdj,
    block_auto_notify:  blockAuto,
    reason,
    // GD-124
    advisory_only:             advisoryOnly,
    human_validation_required: advisoryOnly,
  };
}

// ─── Helper constructeur ─────────────────────────────────────────────────────

function makeSig(opts: {
  signal?: string;
  keep?: number; reject?: number; ignore?: number;
  cycles?: string[]; sources?: string[];
}): SigStats {
  const keep   = opts.keep   ?? 0;
  const reject = opts.reject ?? 0;
  const ignore = opts.ignore ?? 0;
  return {
    signal:  opts.signal  ?? 'sig',
    keep, reject, ignore,
    total:   keep + reject + ignore,
    cycles:  new Set(opts.cycles  ?? []),
    sources: new Set(opts.sources ?? ['operator']),
  };
}

// ─── Tests : règles génériques de hint ───────────────────────────────────────

describe('client-learning-hints — règles génériques', () => {

  // SS-CLH1 : cycles_count < 2 → insufficient_data
  test('SS-CLH1 — cycles_count < 2 → insufficient_data, adj=0, block_auto=true', () => {
    const sig = makeSig({ keep: 5, reject: 0, cycles: ['C1'] });  // 1 seul cycle
    const h   = computeHint(sig);
    expect(h.recommended_effect).toBe('insufficient_data');
    expect(h.score_adjustment).toBe(0);
    expect(h.block_auto_notify).toBe(true);
  });

  // SS-CLH1b : cycles_count = 0 (legacy sans cycle_id) → insufficient_data
  test('SS-CLH1b — cycles_count = 0 → insufficient_data', () => {
    const sig = makeSig({ keep: 10, reject: 0, cycles: [] });
    const h   = computeHint(sig);
    expect(h.recommended_effect).toBe('insufficient_data');
    expect(h.cycles_count).toBe(0);
  });

  // SS-CLH2 : total < 3, cycles >= 2 → keep_review
  test('SS-CLH2 — total < 3 (même cycles >= 2) → keep_review, adj=0', () => {
    const sig = makeSig({ keep: 2, reject: 0, cycles: ['C1', 'C2'] });  // total=2
    const h   = computeHint(sig);
    expect(h.recommended_effect).toBe('keep_review');
    expect(h.score_adjustment).toBe(0);
    expect(h.block_auto_notify).toBe(true);
  });

  // SS-CLH3 : reject > keep, cycles >= 2, total >= 3 → demote_to_review
  test('SS-CLH3 — reject > keep, cycles >= 2, total >= 3 → demote_to_review, adj=-3, block=true', () => {
    const sig = makeSig({ keep: 1, reject: 3, ignore: 0, cycles: ['C1', 'C2'] });
    const h   = computeHint(sig);
    expect(h.recommended_effect).toBe('demote_to_review');
    expect(h.score_adjustment).toBe(-3);
    expect(h.block_auto_notify).toBe(true);
  });

  // SS-CLH3b : reject = keep (égalité) → pas demote_to_review
  test('SS-CLH3b — reject = keep → pas de demote_to_review', () => {
    const sig = makeSig({ keep: 2, reject: 2, ignore: 1, cycles: ['C1', 'C2'] });
    const h   = computeHint(sig);
    expect(h.recommended_effect).not.toBe('demote_to_review');
  });

  // SS-CLH4 : keep_rate >= 80, cycles >= 2, total >= 3 → boost
  test('SS-CLH4 — keep_rate >= 80%, cycles >= 2, total >= 3 → boost, adj=+5, block=false', () => {
    const sig = makeSig({ keep: 4, reject: 0, ignore: 1, cycles: ['C1', 'C2'] });  // 80% keep
    const h   = computeHint(sig);
    expect(h.recommended_effect).toBe('boost');
    expect(h.score_adjustment).toBe(5);
    expect(h.block_auto_notify).toBe(false);
  });

  // SS-CLH4b : keep_rate = 100%, 4 records, 3 cycles → boost
  test('SS-CLH4b — keep_rate = 100%, cycles >= 2, total >= 3 → boost', () => {
    const sig = makeSig({ keep: 4, reject: 0, cycles: ['C1', 'C2', 'C3'] });
    const h   = computeHint(sig);
    expect(h.recommended_effect).toBe('boost');
    expect(h.promotion_ready).toBe(true);
  });

  // SS-CLH5 : cas neutre (keep_rate = 60%, cycles >= 2, total >= 3) → keep_review
  test('SS-CLH5 — keep_rate entre 40% et 79%, cycles >= 2 → keep_review, adj=0', () => {
    const sig = makeSig({ keep: 3, reject: 2, cycles: ['C1', 'C2'] });  // 60% keep
    const h   = computeHint(sig);
    expect(h.recommended_effect).toBe('keep_review');
    expect(h.score_adjustment).toBe(0);
    expect(h.block_auto_notify).toBe(true);
  });

});

// ─── Tests : champs conservés dans le hint ────────────────────────────────────

describe('client-learning-hints — champs de sortie', () => {

  // SS-CLH6 : sources operator/client conservées dans l'ordre alphabétique
  test('SS-CLH6 — sources triées et conservées dans hint', () => {
    const sig = makeSig({ keep: 5, cycles: ['C1', 'C2', 'C3'], sources: ['client', 'operator'] });
    const h   = computeHint(sig);
    expect(h.sources).toEqual(['client', 'operator']);  // triées
    expect(h.sources).toContain('operator');
    expect(h.sources).toContain('client');
  });

  // SS-CLH7 : généricité — mêmes règles pour n'importe quel signal
  test('SS-CLH7 — même règle appliquée quel que soit le nom du signal', () => {
    const signals = ['hygiene', 'nettoyage', 'photocopieur', 'desinfection'];
    signals.forEach(function(name) {
      const sig = makeSig({ signal: name, keep: 0, reject: 3, cycles: ['C1', 'C2'] });
      const h   = computeHint(sig);
      expect(h.recommended_effect).toBe('demote_to_review');
      expect(h.score_adjustment).toBe(-3);
    });
  });

  // SS-CLH8 : structure JSON de sortie conforme
  test('SS-CLH8 — hint contient tous les champs requis', () => {
    const sig = makeSig({ keep: 2, reject: 1, ignore: 0, cycles: ['C1', 'C2'] });
    const h   = computeHint(sig);
    const REQUIRED = [
      'signal', 'keep', 'reject', 'ignore', 'total',
      'keep_rate', 'reject_rate', 'cycles_count', 'sources',
      'verdict', 'promotion_ready',
      'recommended_effect', 'score_adjustment', 'block_auto_notify', 'reason',
    ];
    REQUIRED.forEach(function(field) {
      expect(h).toHaveProperty(field);
    });
  });

  // SS-CLH8b : keep_rate et reject_rate sont des entiers (0–100)
  test('SS-CLH8b — keep_rate et reject_rate sont des entiers entre 0 et 100', () => {
    const sig = makeSig({ keep: 2, reject: 1, ignore: 0, cycles: ['C1', 'C2'] });
    const h   = computeHint(sig);
    expect(Number.isInteger(h.keep_rate)).toBe(true);
    expect(Number.isInteger(h.reject_rate)).toBe(true);
    expect(h.keep_rate).toBeGreaterThanOrEqual(0);
    expect(h.keep_rate).toBeLessThanOrEqual(100);
  });

});

// ─── Tests : priorité des règles ─────────────────────────────────────────────

describe('client-learning-hints — priorité des règles', () => {

  // SS-CLH9 : cycles < 2 prime sur reject > keep
  test('SS-CLH9 — cycles_count < 2 prime sur reject > keep → insufficient_data', () => {
    // reject > keep ET cycles=1 (insuffisant) → insufficient_data prioritaire
    const sig = makeSig({ keep: 0, reject: 5, ignore: 0, cycles: ['C1'] });
    const h   = computeHint(sig);
    expect(h.recommended_effect).toBe('insufficient_data');
  });

  // SS-CLH10 : total < 3 prime sur keep_rate >= 80%
  test('SS-CLH10 — total < 3 prime sur keep_rate >= 80% → keep_review', () => {
    // keep_rate=100% mais total=2 → keep_review
    const sig = makeSig({ keep: 2, reject: 0, cycles: ['C1', 'C2'] });  // total=2
    const h   = computeHint(sig);
    expect(h.recommended_effect).toBe('keep_review');
    expect(h.recommended_effect).not.toBe('boost');
  });

});

// ─── Tests : application dans enrichEntry (shadow report) ────────────────────
// Miroir de la logique de analyze-shadow-report.js::enrichEntry
// Vérifie que hint_block_auto force auto_notify_candidate=false

const CLEAN_STRONG_THRESHOLD_T = 15;
const CLEAN_WEAK_THRESHOLD_T   = 5;

interface CleanOnlyEntry {
  bc_id:              string;
  clean_score:        number;
  matched_signals:    string[];
  strength?:          string;
  exclusion_hit?:     boolean;
  hint_block_auto?:   boolean;
  hint_score_adj?:    number;
  hint_applied?:      string;
}

interface EnrichedEntry {
  bc_id:                 string;
  auto_notify_candidate: boolean;
  review_candidate:      boolean;
}

function enrichEntry(e: CleanOnlyEntry): EnrichedEntry {
  const sigs     = (e.matched_signals || []).filter(s => s.indexOf('bloque(') === -1);
  const isWeak   = sigs.length === 1 && (e.clean_score || 0) < CLEAN_STRONG_THRESHOLD_T;
  const isStrong = (e.clean_score || 0) >= CLEAN_STRONG_THRESHOLD_T;
  const exclHit  = e.exclusion_hit || false;
  let   isAuto   = isStrong && !isWeak && !exclHit;
  // GD-033 : respect hint_block_auto — prioritaire sur recalcul score
  if (e.hint_block_auto) isAuto = false;
  return {
    bc_id:                 e.bc_id,
    auto_notify_candidate: isAuto,
    review_candidate:      !isAuto && (e.clean_score || 0) >= CLEAN_WEAK_THRESHOLD_T,
  };
}

describe('client-learning-hints — application enrichEntry (GD-033)', () => {

  // SS-CLH11 : hint_block_auto=true sur un BC fort → auto_notify=false, review=true
  test('SS-CLH11 — hint_block_auto=true sur BC fort (score>=15) → auto_notify=false, review_candidate=true', () => {
    const entry: CleanOnlyEntry = {
      bc_id: '349922',
      clean_score: 15,
      matched_signals: ['hygiène', 'insecticide'],
      strength: 'weak',          // déjà marqué par le replay
      hint_block_auto: true,
      hint_score_adj: -3,
      hint_applied: 'hygiène:demote_to_review',
    };
    const enriched = enrichEntry(entry);
    expect(enriched.auto_notify_candidate).toBe(false);
    expect(enriched.review_candidate).toBe(true);
  });

  // SS-CLH12 : sans hint_block_auto → comportement inchangé (score fort = auto)
  test('SS-CLH12 — sans hint_block_auto, BC fort → auto_notify_candidate=true', () => {
    const entry: CleanOnlyEntry = {
      bc_id: '999',
      clean_score: 15,
      matched_signals: ['desinfection', 'savon'],
      strength: 'strong',
    };
    const enriched = enrichEntry(entry);
    expect(enriched.auto_notify_candidate).toBe(true);
    expect(enriched.review_candidate).toBe(false);
  });

  // SS-CLH13 : hint_block_auto=true mais score faible → review_candidate=true déjà (pas de régression)
  test('SS-CLH13 — hint_block_auto=true + score faible → review_candidate=true', () => {
    const entry: CleanOnlyEntry = {
      bc_id: '888',
      clean_score: 7,
      matched_signals: ['hygiène'],
      strength: 'weak',
      hint_block_auto: true,
      hint_score_adj: -3,
    };
    const enriched = enrichEntry(entry);
    expect(enriched.auto_notify_candidate).toBe(false);
    expect(enriched.review_candidate).toBe(true);
  });

});

// ─── Tests GD-124 : advisory_only dans computeHint (SA-5, SA-6) ───────────────
// Valide que computeHint détecte advisory_only et rétrograde boost → keep_review.

describe('client-learning-hints GD-124 — advisory_only', () => {

  // SA-5 : hint advisory_only=true quand boost uniquement via ai_assisted_validated
  // Scénario : 3 keeps total, 2 cycles total — mais base (hors advisory) : 0 keep, 0 cycles
  test('SA-5 — boost advisory only → advisory_only=true, effect=keep_review, adj=0', () => {
    const sig: SigStats = {
      signal: 'nettoyage', keep: 3, reject: 0, ignore: 0, total: 3,
      cycles: new Set(['ai-c1', 'ai-c2']),
      sources: new Set(['ai_assisted_validated']),
      keep_base: 0, reject_base: 0, ignore_base: 0, total_base: 0,
      cycles_base: new Set<string>(),
    };
    const h = computeHint(sig);
    expect(h.advisory_only).toBe(true);
    expect(h.recommended_effect).toBe('keep_review');
    expect(h.score_adjustment).toBe(0);
    expect(h.block_auto_notify).toBe(true);
    expect(h.human_validation_required).toBe(true);
    expect(h.reason).toContain('GD-124');
  });

  // SA-6 : promotion_ready=false quand advisory_only=true
  test('SA-6 — advisory_only=true → promotion_ready=false', () => {
    const sig: SigStats = {
      signal: 'desinfection', keep: 5, reject: 0, ignore: 0, total: 5,
      cycles: new Set(['ai-c1', 'ai-c2', 'ai-c3']),
      sources: new Set(['ai_assisted_validated']),
      keep_base: 0, reject_base: 0, ignore_base: 0, total_base: 0,
      cycles_base: new Set<string>(),
    };
    const h = computeHint(sig);
    expect(h.advisory_only).toBe(true);
    expect(h.promotion_ready).toBe(false);
  });

  // SA-5b : base operator suffisante → advisory_only=false, boost maintenu
  test('SA-5b — base operator READY + advisory → advisory_only=false, boost maintenu', () => {
    const sig: SigStats = {
      signal: 'hygiene', keep: 5, reject: 0, ignore: 0, total: 5,
      cycles: new Set(['C1', 'C2', 'ai-c1']),
      sources: new Set(['operator', 'ai_assisted_validated']),
      keep_base: 3, reject_base: 0, ignore_base: 0, total_base: 3,
      cycles_base: new Set(['C1', 'C2']),
    };
    const h = computeHint(sig);
    expect(h.advisory_only).toBe(false);
    expect(h.recommended_effect).toBe('boost');
    expect(h.promotion_ready).toBe(true);
    expect(h.score_adjustment).toBe(5);
  });

});