/**
 * Tests — scoring.schema.ts
 *
 * Couvre :
 *   - SignalSchema          : validation, defaults
 *   - ScoreResultSchema     : validation complète, verdict
 *   - computeBreakdown()    : décomposition par catégorie + clamping
 *   - getActiveSignals()    : filtrage + tri par points
 *   - safeParseScoreResult  : échec propre
 */

import {
  SignalSchema,
  ScoreResultSchema,
  safeParseScoreResult,
  computeBreakdown,
  getActiveSignals,
  type Signal,
  type ScoreResult,
} from '@core/schemas/scoring.schema';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

const makeSignal = (overrides: Partial<Signal> = {}): Signal =>
  SignalSchema.parse({
    id:       'BS-01',
    category: 'business',
    label:    'Secteur matché',
    points:   25,
    matched:  true,
    evidence: 'réseau informatique',
    trigger:  'exact',
    ...overrides,
  });

const VALID_SCORE_RAW = {
  score:               82,
  verdict:             'match',
  signals:             [],
  explanations:        [],
  matched_critere_ids: ['crit-001'],
  bc_id:               'BC-001',
  client_id:           'client-001',
  scored_at:           NOW,
  explanation:         'BC très pertinent — câble réseau matché exactement.',
};

// ─── SignalSchema ─────────────────────────────────────────────────────────────

describe('SignalSchema', () => {
  it('valide un signal complet', () => {
    expect(SignalSchema.safeParse({
      id: 'BS-01', category: 'business', label: 'Secteur', points: 25, matched: true,
    }).success).toBe(true);
  });

  it('accepte des points négatifs (pénalité)', () => {
    const result = SignalSchema.safeParse({
      id: 'EX-01', category: 'exclusion', label: 'Travaux bâtiment', points: -30, matched: true,
    });
    expect(result.success).toBe(true);
  });

  it('applique trigger default "none"', () => {
    const result = SignalSchema.safeParse({
      id: 'TS-01', category: 'technical', label: 'Article match', points: 40, matched: false,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.trigger).toBe('none');
  });

  it('applique evidence default ""', () => {
    const result = SignalSchema.safeParse({
      id: 'TS-01', category: 'technical', label: 'Article', points: 10, matched: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.evidence).toBe('');
  });

  it('rejette une catégorie inconnue', () => {
    expect(SignalSchema.safeParse({
      id: 'X-01', category: 'unknown', label: 'X', points: 10, matched: true,
    }).success).toBe(false);
  });

  it('rejette un trigger inconnu', () => {
    expect(SignalSchema.safeParse({
      id: 'TS-01', category: 'technical', label: 'X', points: 10, matched: true,
      trigger: 'semantic',
    }).success).toBe(false);
  });

  it('rejette si id manquant', () => {
    expect(SignalSchema.safeParse({
      id: '', category: 'business', label: 'X', points: 10, matched: true,
    }).success).toBe(false);
  });
});

// ─── ScoreResultSchema ────────────────────────────────────────────────────────

describe('ScoreResultSchema', () => {
  it('valide un résultat complet', () => {
    expect(ScoreResultSchema.safeParse(VALID_SCORE_RAW).success).toBe(true);
  });

  it('rejette un score hors [0, 100]', () => {
    expect(ScoreResultSchema.safeParse({ ...VALID_SCORE_RAW, score: -1 }).success).toBe(false);
    expect(ScoreResultSchema.safeParse({ ...VALID_SCORE_RAW, score: 101 }).success).toBe(false);
  });

  it('accepte score 0 et score 100', () => {
    expect(ScoreResultSchema.safeParse({ ...VALID_SCORE_RAW, score: 0, verdict: 'no_match' }).success).toBe(true);
    expect(ScoreResultSchema.safeParse({ ...VALID_SCORE_RAW, score: 100, verdict: 'match' }).success).toBe(true);
  });

  it('rejette un verdict invalide', () => {
    expect(ScoreResultSchema.safeParse({ ...VALID_SCORE_RAW, verdict: 'maybe' }).success).toBe(false);
  });

  it('rejette si bc_id manquant', () => {
    expect(ScoreResultSchema.safeParse({ ...VALID_SCORE_RAW, bc_id: '' }).success).toBe(false);
  });

  it('rejette si scored_at n\'est pas un datetime ISO', () => {
    expect(ScoreResultSchema.safeParse({ ...VALID_SCORE_RAW, scored_at: 'pas une date' }).success).toBe(false);
  });

  it('applique signals default []', () => {
    const { signals: _s, ...withoutSignals } = VALID_SCORE_RAW;
    const result = ScoreResultSchema.safeParse(withoutSignals);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.signals).toEqual([]);
  });
});

// ─── safeParseScoreResult ─────────────────────────────────────────────────────

describe('safeParseScoreResult', () => {
  it('ne lance pas d\'exception sur entrée invalide', () => {
    expect(() => safeParseScoreResult(null)).not.toThrow();
    expect(safeParseScoreResult(null).success).toBe(false);
  });

  it('retourne success: true pour un résultat valide', () => {
    expect(safeParseScoreResult(VALID_SCORE_RAW).success).toBe(true);
  });
});

// ─── computeBreakdown ─────────────────────────────────────────────────────────

describe('computeBreakdown', () => {
  it('décompose correctement les signaux', () => {
    const signals: Signal[] = [
      makeSignal({ id: 'BS-01', category: 'business',   points: 25, matched: true }),
      makeSignal({ id: 'BS-02', category: 'business',   points: 20, matched: true }),
      makeSignal({ id: 'TS-01', category: 'technical',  points: 40, matched: true }),
      makeSignal({ id: 'EX-01', category: 'exclusion',  points: -30, matched: true }),
    ];

    const bd = computeBreakdown(signals);
    expect(bd.business_score).toBe(45);
    expect(bd.technical_score).toBe(40);
    expect(bd.exclusion_penalty).toBe(-30);
    expect(bd.total).toBe(55);
  });

  it('ignore les signaux non matchés', () => {
    const signals: Signal[] = [
      makeSignal({ id: 'BS-01', category: 'business',  points: 25, matched: true }),
      makeSignal({ id: 'BS-02', category: 'business',  points: 20, matched: false }),
    ];

    const bd = computeBreakdown(signals);
    expect(bd.business_score).toBe(25);
    expect(bd.total).toBe(25);
  });

  it('clamp le total à 100 maximum', () => {
    const signals: Signal[] = [
      makeSignal({ id: 'BS-01', category: 'business',  points: 70, matched: true }),
      makeSignal({ id: 'TS-01', category: 'technical', points: 55, matched: true }),
    ];

    const bd = computeBreakdown(signals);
    expect(bd.total).toBe(100);
  });

  it('clamp le total à 0 minimum', () => {
    const signals: Signal[] = [
      makeSignal({ id: 'EX-01', category: 'exclusion', points: -200, matched: true }),
    ];

    const bd = computeBreakdown(signals);
    expect(bd.total).toBe(0);
  });

  it('retourne tout à 0 pour un tableau vide', () => {
    const bd = computeBreakdown([]);
    expect(bd.business_score).toBe(0);
    expect(bd.technical_score).toBe(0);
    expect(bd.exclusion_penalty).toBe(0);
    expect(bd.total).toBe(0);
  });
});

// ─── getActiveSignals ─────────────────────────────────────────────────────────

describe('getActiveSignals', () => {
  it('filtre uniquement les signaux matchés', () => {
    const signals: Signal[] = [
      makeSignal({ id: 'BS-01', points: 25, matched: true }),
      makeSignal({ id: 'BS-02', points: 20, matched: false }),
      makeSignal({ id: 'TS-01', points: 40, matched: true }),
    ];

    const active = getActiveSignals(signals);
    expect(active).toHaveLength(2);
    expect(active.map(s => s.id)).toEqual(expect.arrayContaining(['BS-01', 'TS-01']));
  });

  it('trie par points décroissants', () => {
    const signals: Signal[] = [
      makeSignal({ id: 'BS-01', points: 15, matched: true }),
      makeSignal({ id: 'TS-01', points: 40, matched: true }),
      makeSignal({ id: 'BS-02', points: 25, matched: true }),
    ];

    const active = getActiveSignals(signals);
    expect(active[0]?.id).toBe('TS-01');
    expect(active[1]?.id).toBe('BS-02');
    expect(active[2]?.id).toBe('BS-01');
  });

  it('retourne un tableau vide si aucun signal actif', () => {
    const signals: Signal[] = [
      makeSignal({ matched: false }),
    ];
    expect(getActiveSignals(signals)).toEqual([]);
  });
});
