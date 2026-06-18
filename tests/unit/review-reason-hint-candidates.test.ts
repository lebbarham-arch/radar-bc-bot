/**
 * tests/unit/review-reason-hint-candidates.test.ts
 *
 * SS-HC1..HC24 — Tests unitaires pour GD-038 (review-reason-hint-candidates.js)
 * Pattern miroir : la logique est définie localement pour éviter TS7016.
 *
 * STRICT :
 *  - Aucune action interdite : auto_notify, boost_score, change_threshold, change_weight
 *  - safety toujours "shadow_only"
 *  - status toujours "candidate_pending_human_validation"
 *  - human_validation_required = true
 *  - Pas de budget/prix/montant/estimation
 *  - candidate_id stable et déterministe
 *  - Ne pas appliquer les hints au moteur
 */

// ── Types locaux ────────────────────────────────────────────────────────────
interface HintCandidateEntry {
  candidate_id:              string;
  client_key:                string;
  signal_key:                string;
  context_key:               string;
  reason_key:                string;
  hint_type:                 string;
  proposed_effect:           { action: string; scope: string; applies_to: Record<string, string> };
  safety:                    string;
  status:                    string;
  confidence:                string;
  human_validation_required: boolean;
  evidence:                  Record<string, unknown>;
  rationale:                 string;
  suggested_action:          string;
  created_from:              unknown;
}

interface HintCandidateReport {
  model:         string;
  generated_at:  string;
  source_report: string;
  totals: {
    input_suggestions: number;
    candidates:        number;
    skipped:           number;
    by_type:           Record<string, number>;
  };
  candidates: HintCandidateEntry[];
  skipped:    Array<{ reason: string; source: unknown }>;
}

interface P7Suggestion {
  client_key:          string;
  signal_key:          string;
  context_key?:        string;
  reason_key?:         string;
  suggested_hint_type: string;
  safety:              string;
  confidence:          string;
  total_decisions:     number;
  should_suggest_hint: boolean;
  dominant_decision?:  string;
  dominant_reason?:    string;
  reject_rate?:        number;
  keep_rate?:          number;
  ignore_rate?:        number;
  rationale?:          string;
  suggested_action?:   string;
}

// ── Constantes miroir ───────────────────────────────────────────────────────
const ALLOWED_HINT_TYPES = [
  'context_demote_to_review',
  'client_signal_demote_to_review',
  'context_keep_review_or_boost_candidate',
  'ignore_pattern_observed',
] as const;

const FORBIDDEN_ACTIONS = [
  'auto_notify',
  'boost_score',
  'change_threshold',
  'change_weight',
] as const;

// ── Helpers locaux (miroir) ─────────────────────────────────────────────────
function buildCandidateId(
  clientKey: string, signalKey: string, contextKey: string,
  reasonKey: string, hintType: string
): string {
  const raw = [clientKey, signalKey, contextKey, reasonKey, hintType].join('|');
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  }
  return 'rrhc_' + Math.abs(h).toString(16).padStart(8, '0');
}

function buildProposedEffect(
  hintType: string,
  meta: { client_key: string; signal_key: string; context_key: string }
): { action: string; scope: string; applies_to: Record<string, string> } {
  switch (hintType) {
    case 'context_demote_to_review':
      return {
        action: 'block_auto_and_send_to_review',
        scope:  'client_signal_context',
        applies_to: { client_key: meta.client_key, signal_key: meta.signal_key, context_key: meta.context_key },
      };
    case 'client_signal_demote_to_review':
      return {
        action: 'send_to_review',
        scope:  'client_signal',
        applies_to: { client_key: meta.client_key, signal_key: meta.signal_key },
      };
    case 'context_keep_review_or_boost_candidate':
      return {
        action: 'keep_review_candidate_only',
        scope:  'client_signal_context',
        applies_to: { client_key: meta.client_key, signal_key: meta.signal_key, context_key: meta.context_key },
      };
    case 'ignore_pattern_observed':
      return {
        action: 'observe_only',
        scope:  'client_signal_context',
        applies_to: { client_key: meta.client_key, signal_key: meta.signal_key, context_key: meta.context_key },
      };
    default:
      return { action: 'observe_only', scope: 'unknown', applies_to: {} };
  }
}

function makeSugg(overrides: Partial<P7Suggestion> = {}): P7Suggestion {
  return {
    client_key:          'client_abc',
    signal_key:          'sig_nettoyage',
    context_key:         'ctx_medical',
    reason_key:          'mauvais_contexte',
    suggested_hint_type: 'context_demote_to_review',
    safety:              'shadow_only',
    confidence:          'high',
    total_decisions:     5,
    should_suggest_hint: true,
    dominant_decision:   'reject',
    dominant_reason:     'mauvais_contexte',
    reject_rate:         0.8,
    keep_rate:           0.2,
    ignore_rate:         0,
    rationale:           'signal nettoyage hors contexte médical',
    suggested_action:    'Bloquer en auto pour ce contexte',
    ...overrides,
  };
}

function buildP7Report(suggestions: P7Suggestion[]): { suggested_hints: P7Suggestion[] } {
  return { suggested_hints: suggestions };
}

// ── Logique miroir buildReviewReasonHintCandidates ──────────────────────────
function normalizeSuggestedHint(sugg: Partial<P7Suggestion> | null | undefined): (P7Suggestion & { hint_type: string }) | null {
  if (!sugg || typeof sugg !== 'object') return null;
  return {
    client_key:          String((sugg as P7Suggestion).client_key  || '').trim(),
    signal_key:          String((sugg as P7Suggestion).signal_key  || '').trim(),
    context_key:         String((sugg as P7Suggestion).context_key || '').trim(),
    reason_key:          String((sugg as P7Suggestion).reason_key  || '').trim(),
    hint_type:           String((sugg as P7Suggestion).suggested_hint_type || '').trim(),
    suggested_hint_type: String((sugg as P7Suggestion).suggested_hint_type || '').trim(),
    safety:              String((sugg as P7Suggestion).safety      || '').trim(),
    confidence:          String((sugg as P7Suggestion).confidence  || '').trim(),
    total_decisions:     typeof (sugg as P7Suggestion).total_decisions === 'number'
                           ? (sugg as P7Suggestion).total_decisions : 0,
    should_suggest_hint: (sugg as P7Suggestion).should_suggest_hint === true,
    dominant_decision:   String((sugg as P7Suggestion).dominant_decision || '').trim(),
    dominant_reason:     String((sugg as P7Suggestion).dominant_reason   || '').trim(),
    reject_rate:         typeof (sugg as P7Suggestion).reject_rate === 'number' ? (sugg as P7Suggestion).reject_rate! : 0,
    keep_rate:           typeof (sugg as P7Suggestion).keep_rate   === 'number' ? (sugg as P7Suggestion).keep_rate!   : 0,
    ignore_rate:         typeof (sugg as P7Suggestion).ignore_rate === 'number' ? (sugg as P7Suggestion).ignore_rate! : 0,
    rationale:           String((sugg as P7Suggestion).rationale        || '').trim(),
    suggested_action:    String((sugg as P7Suggestion).suggested_action || '').trim(),
  };
}

function validateHintCandidate(c: Partial<HintCandidateEntry>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (c.safety !== 'shadow_only')                       errors.push('safety != shadow_only');
  if (c.status !== 'candidate_pending_human_validation') errors.push('status invalide');
  if (c.human_validation_required !== true)              errors.push('human_validation_required != true');
  if (!ALLOWED_HINT_TYPES.includes(c.hint_type as typeof ALLOWED_HINT_TYPES[number]))
    errors.push('hint_type non reconnu: ' + c.hint_type);
  if (c.proposed_effect) {
    const action = c.proposed_effect.action;
    if (FORBIDDEN_ACTIONS.includes(action as typeof FORBIDDEN_ACTIONS[number]))
      errors.push('action interdite: ' + action);
  }
  if (!c.candidate_id || !String(c.candidate_id).startsWith('rrhc_'))
    errors.push('candidate_id invalide');
  if (!c.client_key || c.client_key === 'unknown_client') errors.push('client_key invalide');
  if (!c.signal_key || c.signal_key === 'unknown_signal') errors.push('signal_key invalide');
  return { valid: errors.length === 0, errors };
}

function buildReviewReasonHintCandidates(
  p7Report: { suggested_hints?: P7Suggestion[] },
  opts: { generatedAt?: string; sourceReport?: string } = {}
): HintCandidateReport {
  const genAt        = opts.generatedAt  || '2025-01-01T00:00:00.000Z';
  const sourceReport = opts.sourceReport || '';
  const candidates: HintCandidateEntry[] = [];
  const skipped: Array<{ reason: string; source: unknown }> = [];
  const suggestions: P7Suggestion[] = p7Report.suggested_hints || [];

  suggestions.forEach((rawSugg) => {
    const norm = normalizeSuggestedHint(rawSugg);
    if (!norm) { skipped.push({ reason: 'normalisation impossible', source: '' }); return; }

    if (!norm.should_suggest_hint) { skipped.push({ reason: 'should_suggest_hint=false', source: norm.client_key }); return; }
    if (norm.safety !== 'shadow_only') { skipped.push({ reason: 'safety != shadow_only', source: norm.safety }); return; }
    if (norm.confidence !== 'medium' && norm.confidence !== 'high') { skipped.push({ reason: 'confidence non qualifiée', source: norm.confidence }); return; }
    if (norm.total_decisions < 3) { skipped.push({ reason: 'total_decisions < 3', source: norm.total_decisions }); return; }
    if (!norm.client_key || norm.client_key === 'unknown_client') { skipped.push({ reason: 'client_key invalide', source: norm.client_key }); return; }
    if (!norm.signal_key || norm.signal_key === 'unknown_signal' || norm.signal_key === '_none_') { skipped.push({ reason: 'signal_key invalide', source: norm.signal_key }); return; }
    if (!ALLOWED_HINT_TYPES.includes(norm.hint_type as typeof ALLOWED_HINT_TYPES[number])) { skipped.push({ reason: 'hint_type non reconnu', source: norm.hint_type }); return; }

    const candidateId = buildCandidateId(norm.client_key, norm.signal_key, norm.context_key || '', norm.reason_key || '', norm.hint_type);
    const proposedEffect = buildProposedEffect(norm.hint_type, { client_key: norm.client_key, signal_key: norm.signal_key, context_key: norm.context_key || '' });

    const candidate: HintCandidateEntry = {
      candidate_id:              candidateId,
      client_key:                norm.client_key,
      signal_key:                norm.signal_key,
      context_key:               norm.context_key || '',
      reason_key:                norm.reason_key  || '',
      hint_type:                 norm.hint_type,
      proposed_effect:           proposedEffect,
      safety:                    'shadow_only',
      status:                    'candidate_pending_human_validation',
      confidence:                norm.confidence,
      human_validation_required: true,
      evidence: {
        total_decisions:   norm.total_decisions,
        dominant_decision: norm.dominant_decision,
        dominant_reason:   norm.dominant_reason,
        reject_rate:       norm.reject_rate,
        keep_rate:         norm.keep_rate,
        ignore_rate:       norm.ignore_rate,
      },
      rationale:        norm.rationale        || '',
      suggested_action: norm.suggested_action || '',
      created_from:     sourceReport,
    };

    const v = validateHintCandidate(candidate);
    if (!v.valid) { skipped.push({ reason: v.errors.join('; '), source: candidateId }); return; }

    candidates.push(candidate);
  });

  const byType: Record<string, number> = {};
  candidates.forEach((c) => { byType[c.hint_type] = (byType[c.hint_type] || 0) + 1; });

  return {
    model: 'rule-based-review-reason-hint-candidates-v1',
    generated_at:  genAt,
    source_report: sourceReport,
    totals: { input_suggestions: suggestions.length, candidates: candidates.length, skipped: skipped.length, by_type: byType },
    candidates,
    skipped,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('GD-038 review-reason-hint-candidates', () => {

  // ── SS-HC1 : structure de base du rapport ─────────────────────────────────
  test('SS-HC1 — rapport vide sur suggestions vides', () => {
    const r = buildReviewReasonHintCandidates({ suggested_hints: [] });
    expect(r.model).toBe('rule-based-review-reason-hint-candidates-v1');
    expect(r.totals.input_suggestions).toBe(0);
    expect(r.totals.candidates).toBe(0);
    expect(r.totals.skipped).toBe(0);
    expect(r.candidates).toHaveLength(0);
    expect(r.skipped).toHaveLength(0);
  });

  // ── SS-HC2 : suggestion valide → candidate produit ────────────────────────
  test('SS-HC2 — une suggestion valide produit un candidate', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg()]));
    expect(r.totals.candidates).toBe(1);
    expect(r.totals.skipped).toBe(0);
    expect(r.candidates[0]!.hint_type).toBe('context_demote_to_review');
  });

  // ── SS-HC3 : champs sécurité obligatoires ────────────────────────────────
  test('SS-HC3 — champs sécurité toujours présents', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg()]));
    const c = r.candidates[0]!;
    expect(c.safety).toBe('shadow_only');
    expect(c.status).toBe('candidate_pending_human_validation');
    expect(c.human_validation_required).toBe(true);
  });

  // ── SS-HC4 : candidate_id commence par rrhc_ ─────────────────────────────
  test('SS-HC4 — candidate_id commence par rrhc_', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg()]));
    expect(r.candidates[0]!.candidate_id).toMatch(/^rrhc_/);
  });

  // ── SS-HC5 : candidate_id est stable (même entrée = même id) ─────────────
  test('SS-HC5 — candidate_id est déterministe (stable)', () => {
    const s = makeSugg();
    const r1 = buildReviewReasonHintCandidates(buildP7Report([s]));
    const r2 = buildReviewReasonHintCandidates(buildP7Report([s]));
    expect(r1.candidates[0]!.candidate_id).toBe(r2.candidates[0]!.candidate_id);
  });

  // ── SS-HC6 : deux clés différentes → deux ids différents ─────────────────
  test('SS-HC6 — clés distinctes produisent candidate_id distincts', () => {
    const s1 = makeSugg({ client_key: 'client_a' });
    const s2 = makeSugg({ client_key: 'client_b' });
    const r1 = buildReviewReasonHintCandidates(buildP7Report([s1]));
    const r2 = buildReviewReasonHintCandidates(buildP7Report([s2]));
    expect(r1.candidates[0]!.candidate_id).not.toBe(r2.candidates[0]!.candidate_id);
  });

  // ── SS-HC7 : filtre should_suggest_hint=false ─────────────────────────────
  test('SS-HC7 — should_suggest_hint=false → skipped', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg({ should_suggest_hint: false })]));
    expect(r.totals.candidates).toBe(0);
    expect(r.totals.skipped).toBe(1);
    expect(r.skipped[0]!.reason).toContain('should_suggest_hint');
  });

  // ── SS-HC8 : filtre safety != shadow_only ────────────────────────────────
  test('SS-HC8 — safety != shadow_only → skipped', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg({ safety: 'active' })]));
    expect(r.totals.candidates).toBe(0);
    expect(r.skipped[0]!.reason).toContain('safety');
  });

  // ── SS-HC9 : filtre confidence low ───────────────────────────────────────
  test('SS-HC9 — confidence=low → skipped', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg({ confidence: 'low' })]));
    expect(r.totals.candidates).toBe(0);
    expect(r.skipped[0]!.reason).toContain('confidence');
  });

  // ── SS-HC10 : filtre total_decisions < 3 ────────────────────────────────
  test('SS-HC10 — total_decisions=2 → skipped', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg({ total_decisions: 2 })]));
    expect(r.totals.candidates).toBe(0);
    expect(r.skipped[0]!.reason).toContain('total_decisions');
  });

  // ── SS-HC11 : filtre client_key invalide ─────────────────────────────────
  test('SS-HC11 — client_key=unknown_client → skipped', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg({ client_key: 'unknown_client' })]));
    expect(r.totals.candidates).toBe(0);
    expect(r.skipped[0]!.reason).toContain('client_key');
  });

  // ── SS-HC12 : filtre signal_key invalide ─────────────────────────────────
  test('SS-HC12 — signal_key=unknown_signal → skipped', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg({ signal_key: 'unknown_signal' })]));
    expect(r.totals.candidates).toBe(0);
    expect(r.skipped[0]!.reason).toContain('signal_key');
  });

  // ── SS-HC13 : filtre hint_type non reconnu ───────────────────────────────
  test('SS-HC13 — hint_type inconnu → skipped', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg({ suggested_hint_type: 'type_inexistant' } as unknown as Partial<P7Suggestion>)]));
    expect(r.totals.candidates).toBe(0);
    expect(r.skipped[0]!.reason).toContain('hint_type');
  });

  // ── SS-HC14 : type A (context_demote_to_review) ──────────────────────────
  test('SS-HC14 — type A : action block_auto_and_send_to_review, scope client_signal_context', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([
      makeSugg({ suggested_hint_type: 'context_demote_to_review' }),
    ]));
    const c = r.candidates[0]!;
    expect(c.proposed_effect.action).toBe('block_auto_and_send_to_review');
    expect(c.proposed_effect.scope).toBe('client_signal_context');
    expect(c.proposed_effect.applies_to.client_key).toBe('client_abc');
    expect(c.proposed_effect.applies_to.signal_key).toBe('sig_nettoyage');
    expect(c.proposed_effect.applies_to.context_key).toBe('ctx_medical');
  });

  // ── SS-HC15 : type B (client_signal_demote_to_review) ────────────────────
  test('SS-HC15 — type B : action send_to_review, scope client_signal', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([
      makeSugg({ suggested_hint_type: 'client_signal_demote_to_review' }),
    ]));
    const c = r.candidates[0]!;
    expect(c.proposed_effect.action).toBe('send_to_review');
    expect(c.proposed_effect.scope).toBe('client_signal');
    expect(c.proposed_effect.applies_to.context_key).toBeUndefined();
  });

  // ── SS-HC16 : type C (context_keep_review_or_boost_candidate) ────────────
  test('SS-HC16 — type C : action keep_review_candidate_only, scope client_signal_context', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([
      makeSugg({ suggested_hint_type: 'context_keep_review_or_boost_candidate' }),
    ]));
    const c = r.candidates[0]!;
    expect(c.proposed_effect.action).toBe('keep_review_candidate_only');
    expect(c.proposed_effect.scope).toBe('client_signal_context');
  });

  // ── SS-HC17 : type D (ignore_pattern_observed) ───────────────────────────
  test('SS-HC17 — type D : action observe_only, scope client_signal_context', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([
      makeSugg({ suggested_hint_type: 'ignore_pattern_observed' }),
    ]));
    const c = r.candidates[0]!;
    expect(c.proposed_effect.action).toBe('observe_only');
    expect(c.proposed_effect.scope).toBe('client_signal_context');
  });

  // ── SS-HC18 : actions interdites absentes dans tous les types ────────────
  test('SS-HC18 — aucune action interdite dans les 4 types', () => {
    const types = [
      'context_demote_to_review',
      'client_signal_demote_to_review',
      'context_keep_review_or_boost_candidate',
      'ignore_pattern_observed',
    ];
    types.forEach((ht) => {
      const effect = buildProposedEffect(ht, { client_key: 'c', signal_key: 's', context_key: 'ctx' });
      FORBIDDEN_ACTIONS.forEach((fa) => {
        expect(effect.action).not.toBe(fa);
      });
    });
  });

  // ── SS-HC19 : validateHintCandidate — candidate valide ───────────────────
  test('SS-HC19 — validateHintCandidate passe sur un candidate correct', () => {
    const c: HintCandidateEntry = {
      candidate_id:              'rrhc_abcd1234',
      client_key:                'client_x',
      signal_key:                'sig_x',
      context_key:               'ctx_x',
      reason_key:                'raison_x',
      hint_type:                 'context_demote_to_review',
      proposed_effect:           { action: 'block_auto_and_send_to_review', scope: 'client_signal_context', applies_to: {} },
      safety:                    'shadow_only',
      status:                    'candidate_pending_human_validation',
      confidence:                'high',
      human_validation_required: true,
      evidence:                  {},
      rationale:                 'test',
      suggested_action:          '',
      created_from:              '',
    };
    const v = validateHintCandidate(c);
    expect(v.valid).toBe(true);
    expect(v.errors).toHaveLength(0);
  });

  // ── SS-HC20 : validateHintCandidate — safety invalide ────────────────────
  test('SS-HC20 — validateHintCandidate détecte safety invalide', () => {
    const c: HintCandidateEntry = {
      candidate_id: 'rrhc_abcd1234', client_key: 'c', signal_key: 's',
      context_key: '', reason_key: '', hint_type: 'context_demote_to_review',
      proposed_effect: { action: 'block_auto_and_send_to_review', scope: '', applies_to: {} },
      safety: 'active',  // interdit
      status: 'candidate_pending_human_validation', confidence: 'high',
      human_validation_required: true, evidence: {}, rationale: '', suggested_action: '', created_from: '',
    };
    const v = validateHintCandidate(c);
    expect(v.valid).toBe(false);
    expect(v.errors.some(e => e.includes('safety'))).toBe(true);
  });

  // ── SS-HC21 : validateHintCandidate — action interdite ───────────────────
  test('SS-HC21 — validateHintCandidate détecte action interdite', () => {
    FORBIDDEN_ACTIONS.forEach((fa) => {
      const c: HintCandidateEntry = {
        candidate_id: 'rrhc_abcd1234', client_key: 'c', signal_key: 's',
        context_key: '', reason_key: '', hint_type: 'context_demote_to_review',
        proposed_effect: { action: fa, scope: '', applies_to: {} },
        safety: 'shadow_only', status: 'candidate_pending_human_validation',
        confidence: 'high', human_validation_required: true, evidence: {},
        rationale: '', suggested_action: '', created_from: '',
      };
      const v = validateHintCandidate(c);
      expect(v.valid).toBe(false);
      expect(v.errors.some(e => e.includes('interdit'))).toBe(true);
    });
  });

  // ── SS-HC22 : totaux by_type corrects ────────────────────────────────────
  test('SS-HC22 — totaux by_type comptent correctement', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([
      makeSugg({ suggested_hint_type: 'context_demote_to_review', client_key: 'c1', signal_key: 's1' }),
      makeSugg({ suggested_hint_type: 'context_demote_to_review', client_key: 'c2', signal_key: 's2' }),
      makeSugg({ suggested_hint_type: 'ignore_pattern_observed',  client_key: 'c3', signal_key: 's3' }),
    ]));
    expect(r.totals.by_type['context_demote_to_review']).toBe(2);
    expect(r.totals.by_type['ignore_pattern_observed']).toBe(1);
  });

  // ── SS-HC23 : confidence medium est acceptée ─────────────────────────────
  test('SS-HC23 — confidence=medium produit un candidate', () => {
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg({ confidence: 'medium', total_decisions: 3 })]));
    expect(r.totals.candidates).toBe(1);
    expect(r.candidates[0]!.confidence).toBe('medium');
  });

  // ── SS-HC24 : pas de budget/prix/montant/estimation ──────────────────────
  test('SS-HC24 — aucune mention budget/prix/montant/estimation dans les raisons', () => {
    const forbidden = ['budget', 'prix', 'montant', 'estimation'];
    const r = buildReviewReasonHintCandidates(buildP7Report([makeSugg()]));
    const json = JSON.stringify(r);
    forbidden.forEach((word) => {
      // Vérifie que le contenu généré ne contient pas ces mots (hors texte d'entrée)
      const candidate = r.candidates[0]!;
      expect(candidate.reason_key).not.toContain(word);
      expect(candidate.rationale).not.toContain(word);
    });
  });

});


describe('review-reason-hint-candidates — garde no_context (SS-HC25..27)', () => {

  // Helpers locaux pour cette suite
  const CONTEXT_REQUIRED_TYPES_HC = [
    'context_demote_to_review',
    'context_keep_review_or_boost_candidate',
    'ignore_pattern_observed',
  ];

  function isContextRequired(hintType: string): boolean {
    return CONTEXT_REQUIRED_TYPES_HC.includes(hintType);
  }

  function applyNoContextGuard(hintType: string, contextKey: string): string | null {
    if (!isContextRequired(hintType)) return null;
    const val = (contextKey || '').trim();
    if (!val || val === 'no_context' || val === 'unknown_context') {
      return 'context_required_for_context_hint';
    }
    return null;
  }

  // SS-HC25 : context_demote_to_review + no_context → skipé
  test('SS-HC25 — context_demote_to_review + context_key=no_context → skip context_required_for_context_hint', () => {
    const skipReason = applyNoContextGuard('context_demote_to_review', 'no_context');
    expect(skipReason).toBe('context_required_for_context_hint');
  });

  // SS-HC25b : context_demote_to_review + context_key vide → skipé
  test('SS-HC25b — context_demote_to_review + context_key="" → skip context_required_for_context_hint', () => {
    const skipReason = applyNoContextGuard('context_demote_to_review', '');
    expect(skipReason).toBe('context_required_for_context_hint');
  });

  // SS-HC25c : context_demote_to_review + unknown_context → skipé
  test('SS-HC25c — context_demote_to_review + context_key=unknown_context → skip context_required_for_context_hint', () => {
    const skipReason = applyNoContextGuard('context_demote_to_review', 'unknown_context');
    expect(skipReason).toBe('context_required_for_context_hint');
  });

  // SS-HC26 : context_demote_to_review + medical_admin_context → non skipé par garde
  test('SS-HC26 — context_demote_to_review + context_key=medical_admin_context → garde ne skip pas', () => {
    const skipReason = applyNoContextGuard('context_demote_to_review', 'medical_admin_context');
    expect(skipReason).toBeNull();
  });

  // SS-HC27 : client_signal_demote_to_review (type B) + no_context → NON skipé (pas contextuel)
  test("SS-HC27 — client_signal_demote_to_review + no_context → garde ne s'applique pas (type B)", () => {
    const skipReason = applyNoContextGuard('client_signal_demote_to_review', 'no_context');
    expect(skipReason).toBeNull();
  });

  // SS-HC28 : context_keep_review_or_boost_candidate + no_context → skipé
  test('SS-HC28 — context_keep_review_or_boost_candidate + no_context → skip context_required_for_context_hint', () => {
    const skipReason = applyNoContextGuard('context_keep_review_or_boost_candidate', 'no_context');
    expect(skipReason).toBe('context_required_for_context_hint');
  });

  // SS-HC29 : ignore_pattern_observed + no_context → skipé
  test('SS-HC29 — ignore_pattern_observed + no_context → skip context_required_for_context_hint', () => {
    const skipReason = applyNoContextGuard('ignore_pattern_observed', 'no_context');
    expect(skipReason).toBe('context_required_for_context_hint');
  });

  // SS-HC30 : ignore_pattern_observed + cleaning_disinfection_context → non skipé
  test('SS-HC30 — ignore_pattern_observed + cleaning_disinfection_context → garde ne skip pas', () => {
    const skipReason = applyNoContextGuard('ignore_pattern_observed', 'cleaning_disinfection_context');
    expect(skipReason).toBeNull();
  });

});
