/**
 * Tests — feedback.schema.ts
 *
 * Couvre :
 *   - FeedbackVerdictSchema  : enum strict
 *   - FeedbackEventSchema    : validation, immutabilité, defaults
 *   - ProfileSnapshotSchema  : validation, reason enum
 *   - FeedbackSummarySchema  : validation
 *   - computePrecision()     : calcul correct, edge cases
 *   - serializeSnapshot()    : sérialisation JSON
 */

import {
  FeedbackVerdictSchema,
  FeedbackEventSchema,
  ProfileSnapshotSchema,
  FeedbackSummarySchema,
  safeParseFeedbackEvent,
  computePrecision,
  serializeSnapshot,
} from '@core/schemas/feedback.schema';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

const VALID_FEEDBACK = {
  id:            'fb-001',
  client_id:     'client-001',
  bc_id:         'BC-001',
  verdict:       'relevant' as const,
  score_at_time: 78,
  created_at:    NOW,
};

const VALID_SNAPSHOT = {
  id:         'snap-001',
  client_id:  'client-001',
  snapshot:   '{"pack":"pro","criteres":[]}',
  reason:     'feedback_update' as const,
  created_at: NOW,
};

// ─── FeedbackVerdictSchema ────────────────────────────────────────────────────

describe('FeedbackVerdictSchema', () => {
  it('accepte relevant, not_relevant, partial', () => {
    expect(FeedbackVerdictSchema.safeParse('relevant').success).toBe(true);
    expect(FeedbackVerdictSchema.safeParse('not_relevant').success).toBe(true);
    expect(FeedbackVerdictSchema.safeParse('partial').success).toBe(true);
  });

  it('rejette toute valeur hors enum', () => {
    expect(FeedbackVerdictSchema.safeParse('positive').success).toBe(false);
    expect(FeedbackVerdictSchema.safeParse('').success).toBe(false);
  });
});

// ─── FeedbackEventSchema ──────────────────────────────────────────────────────

describe('FeedbackEventSchema', () => {
  it('valide un feedback complet', () => {
    expect(FeedbackEventSchema.safeParse(VALID_FEEDBACK).success).toBe(true);
  });

  it('rejette si id manquant', () => {
    expect(FeedbackEventSchema.safeParse({ ...VALID_FEEDBACK, id: '' }).success).toBe(false);
  });

  it('rejette si client_id manquant', () => {
    expect(FeedbackEventSchema.safeParse({ ...VALID_FEEDBACK, client_id: '' }).success).toBe(false);
  });

  it('rejette si bc_id manquant', () => {
    expect(FeedbackEventSchema.safeParse({ ...VALID_FEEDBACK, bc_id: '' }).success).toBe(false);
  });

  it('rejette un verdict invalide', () => {
    expect(FeedbackEventSchema.safeParse({ ...VALID_FEEDBACK, verdict: 'spam' }).success).toBe(false);
  });

  it('rejette score_at_time hors [0, 100]', () => {
    expect(FeedbackEventSchema.safeParse({ ...VALID_FEEDBACK, score_at_time: -1 }).success).toBe(false);
    expect(FeedbackEventSchema.safeParse({ ...VALID_FEEDBACK, score_at_time: 101 }).success).toBe(false);
  });

  it('accepte score_at_time à 0 et 100', () => {
    expect(FeedbackEventSchema.safeParse({ ...VALID_FEEDBACK, score_at_time: 0 }).success).toBe(true);
    expect(FeedbackEventSchema.safeParse({ ...VALID_FEEDBACK, score_at_time: 100 }).success).toBe(true);
  });

  it('applique commentaire default ""', () => {
    const result = FeedbackEventSchema.safeParse(VALID_FEEDBACK);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.commentaire).toBe('');
  });

  it('critere_id est optionnel', () => {
    const result = FeedbackEventSchema.safeParse(VALID_FEEDBACK);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.critere_id).toBeUndefined();
  });

  it('rejette si created_at n\'est pas un datetime ISO', () => {
    expect(FeedbackEventSchema.safeParse({ ...VALID_FEEDBACK, created_at: '01/01/2024' }).success).toBe(false);
  });
});

// ─── ProfileSnapshotSchema ────────────────────────────────────────────────────

describe('ProfileSnapshotSchema', () => {
  it('valide un snapshot complet', () => {
    expect(ProfileSnapshotSchema.safeParse(VALID_SNAPSHOT).success).toBe(true);
  });

  it('accepte tous les types reason valides', () => {
    const reasons = ['feedback_update', 'manual_edit', 'ai_suggestion', 'rollback'] as const;
    for (const reason of reasons) {
      expect(ProfileSnapshotSchema.safeParse({ ...VALID_SNAPSHOT, reason }).success).toBe(true);
    }
  });

  it('rejette un reason invalide', () => {
    expect(ProfileSnapshotSchema.safeParse({ ...VALID_SNAPSHOT, reason: 'auto' }).success).toBe(false);
  });

  it('rejette snapshot vide', () => {
    expect(ProfileSnapshotSchema.safeParse({ ...VALID_SNAPSHOT, snapshot: '' }).success).toBe(false);
  });

  it('rolled_back_at est optionnel', () => {
    const result = ProfileSnapshotSchema.safeParse(VALID_SNAPSHOT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.rolled_back_at).toBeUndefined();
  });

  it('applique feedback_ids default []', () => {
    const result = ProfileSnapshotSchema.safeParse(VALID_SNAPSHOT);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.feedback_ids).toEqual([]);
  });
});

// ─── safeParseFeedbackEvent ───────────────────────────────────────────────────

describe('safeParseFeedbackEvent', () => {
  it('ne lance pas d\'exception sur entrée invalide', () => {
    expect(() => safeParseFeedbackEvent(null)).not.toThrow();
    expect(safeParseFeedbackEvent(null).success).toBe(false);
  });

  it('retourne success: true pour un feedback valide', () => {
    expect(safeParseFeedbackEvent(VALID_FEEDBACK).success).toBe(true);
  });
});

// ─── computePrecision ─────────────────────────────────────────────────────────

describe('computePrecision', () => {
  it('retourne null si total = 0', () => {
    expect(computePrecision({ total: 0, relevant: 0, not_relevant: 0, partial: 0 })).toBeNull();
  });

  it('retourne 1.0 si tous les feedbacks sont relevant', () => {
    expect(computePrecision({ total: 5, relevant: 5, not_relevant: 0, partial: 0 })).toBe(1);
  });

  it('retourne 0 si tous les feedbacks sont not_relevant', () => {
    expect(computePrecision({ total: 3, relevant: 0, not_relevant: 3, partial: 0 })).toBe(0);
  });

  it('pondère partial à 0.5', () => {
    const precision = computePrecision({ total: 2, relevant: 1, not_relevant: 0, partial: 2 });
    // (1 + 2*0.5) / (1 + 0 + 2) = 2/3
    expect(precision).toBeCloseTo(2 / 3);
  });

  it('retourne une valeur entre 0 et 1', () => {
    const cases = [
      { total: 10, relevant: 7, not_relevant: 2, partial: 1 },
      { total: 5,  relevant: 0, not_relevant: 5, partial: 0 },
      { total: 3,  relevant: 3, not_relevant: 0, partial: 0 },
    ];
    for (const c of cases) {
      const p = computePrecision(c);
      if (p !== null) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ─── serializeSnapshot ────────────────────────────────────────────────────────

describe('serializeSnapshot', () => {
  it('sérialise un profil en JSON valide', () => {
    const profile = { pack: 'pro', criteres: [], nom: 'Test' };
    const serialized = serializeSnapshot(profile);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(JSON.parse(serialized)).toEqual(profile);
  });

  it('sérialise un objet vide', () => {
    const serialized = serializeSnapshot({});
    expect(serialized).toBe('{}');
  });
});
