/**
 * tests/unit/review-reason-learning-report.test.ts — GD-037
 *
 * Tests unitaires de review-reason-learning-report.js (rule-based).
 * SS-RL1..SS-RL20 — miroir pur, aucun import FS, aucun appel réseau.
 */

// ─── Miroir local ────────────────────────────────────────────────────────────

const LEARNING_MODEL_T = 'rule-based-review-reason-learning-v1';

interface LearningReviewEntry {
  client?:                    string;
  client_name?:               string;
  client_id?:                 string;
  bc_id?:                     string;
  decision?:                  string;
  human_review_reason?:       string;
  human_review_comment?:      string;
  matched_signals?:           unknown;
  ctx_profile_alignment?:     string;
  ctx_context_ambiguity?:     string;
  ctx_context_confidence?:    string;
  ctx_positive_context_terms?:string[];
  ctx_negative_context_terms?:string[];
  ctx_learnable_context_hint? :string;
  ctx_should_create_hint?:    boolean;
  signal_origin?:             string;
  score?:                     number;
}

interface GroupSummary {
  total:                number;
  total_decisions:      number;
  keep_count:           number;
  reject_count:         number;
  ignore_count:         number;
  pending_review_count: number;
  dominant_decision:    string;
  dominant_reason:      string;
  reject_rate:          number;
  keep_rate:            number;
  ignore_rate:          number;
  dominance_rate:       number;
  confidence:           'low' | 'medium' | 'high';
}

interface Suggestion {
  client_key:          string;
  signal_key:          string;
  context_key:         string;
  reason_key:          string;
  should_suggest_hint: boolean;
  suggested_hint_type: string;
  suggested_action:    string;
  rationale:           string;
  safety:              string;
}

// ── Helpers miroir ────────────────────────────────────────────────────────────

function normStrT(s: unknown): string {
  return String(s || '').trim();
}

function parseSignalsT(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return (raw as unknown[])
      .map(v => normStrT(v))
      .filter(s => s && !s.includes('bloque('));
  }
  return String(raw).split(/[,;]/)
    .map(s => s.trim())
    .filter(s => s && !s.includes('bloque('));
}

function signalKeyT(entry: LearningReviewEntry): string {
  const sigs = parseSignalsT(entry.matched_signals);
  if (sigs.length === 0) return '_none_';
  return sigs.slice().sort().join('+');
}

function contextKeyT(entry: LearningReviewEntry): string {
  const align     = normStrT(entry.ctx_profile_alignment);
  const ambiguity = normStrT(entry.ctx_context_ambiguity);
  if (align === 'unclear' && ambiguity === 'high') return 'no_context';
  if (align === 'unclear') return 'no_context';
  if (!align && !normStrT(entry.ctx_learnable_context_hint)) return 'no_context';
  if (align) return 'ctx_' + align + (ambiguity ? '_' + ambiguity : '');
  return 'no_context';
}

function clientKeyT(entry: LearningReviewEntry): string {
  const c = normStrT(entry.client) || normStrT(entry.client_name) || normStrT(entry.client_id);
  return c || 'unknown_client';
}

function reasonKeyT(entry: LearningReviewEntry): string {
  const r = normStrT(entry.human_review_reason);
  return r || 'unspecified';
}

function decisionKeyT(entry: LearningReviewEntry): string {
  const d = normStrT(entry.decision).toLowerCase();
  return ['keep', 'reject', 'ignore'].includes(d) ? d : '';
}

function summarizeGroupT(group: LearningReviewEntry[]): GroupSummary {
  let keepCount = 0, rejectCount = 0, ignoreCount = 0, pendingCount = 0;
  group.forEach(e => {
    const d = decisionKeyT(e);
    if (d === 'keep') keepCount++;
    else if (d === 'reject') rejectCount++;
    else if (d === 'ignore') ignoreCount++;
    else pendingCount++;
  });
  const totalDecisions = keepCount + rejectCount + ignoreCount;

  let dominantDecision = '', dominantCount = 0;
  if (totalDecisions > 0) {
    if (keepCount >= rejectCount && keepCount >= ignoreCount)
      { dominantDecision = 'keep';   dominantCount = keepCount;   }
    else if (rejectCount >= keepCount && rejectCount >= ignoreCount)
      { dominantDecision = 'reject'; dominantCount = rejectCount; }
    else
      { dominantDecision = 'ignore'; dominantCount = ignoreCount; }
  }

  const reasonCounts: Record<string, number> = {};
  group.forEach(e => {
    if (decisionKeyT(e)) {
      const r = reasonKeyT(e);
      reasonCounts[r] = (reasonCounts[r] || 0) + 1;
    }
  });
  let dominantReason = '', dominantReasonCount = 0;
  Object.keys(reasonCounts).forEach(r => {
    if ((reasonCounts[r] ?? 0) > dominantReasonCount)
      { dominantReason = r; dominantReasonCount = (reasonCounts[r] ?? 0); }
  });

  const rejectRate     = totalDecisions > 0 ? Math.round(rejectCount / totalDecisions * 100) : 0;
  const keepRate       = totalDecisions > 0 ? Math.round(keepCount   / totalDecisions * 100) : 0;
  const ignoreRate     = totalDecisions > 0 ? Math.round(ignoreCount / totalDecisions * 100) : 0;
  const dominanceRate  = totalDecisions > 0 ? Math.round(dominantCount / totalDecisions * 100) : 0;

  let confidence: 'low' | 'medium' | 'high';
  if (totalDecisions >= 5 && dominanceRate >= 80) confidence = 'high';
  else if (totalDecisions >= 3 && dominanceRate >= 67) confidence = 'medium';
  else confidence = 'low';

  return {
    total: group.length, total_decisions: totalDecisions,
    keep_count: keepCount, reject_count: rejectCount, ignore_count: ignoreCount,
    pending_review_count: pendingCount,
    dominant_decision: dominantDecision, dominant_reason: dominantReason,
    reject_rate: rejectRate, keep_rate: keepRate, ignore_rate: ignoreRate,
    dominance_rate: dominanceRate, confidence,
  };
}

function suggestHintT(summary: GroupSummary, meta: {client_key:string; signal_key:string; context_key:string; reason_key:string}): Suggestion {
  const base: Suggestion = {
    ...meta,
    should_suggest_hint: false,
    suggested_hint_type: '',
    suggested_action:    '',
    rationale:           '',
    safety:              'shadow_only',
  };
  if (summary.total_decisions < 3) { base.rationale = 'Pas assez de décisions.'; return base; }
  if (summary.confidence === 'low') { base.rationale = 'Confiance insuffisante.'; return base; }

  const dom = summary.dominant_decision;
  const rea = summary.dominant_reason;
  if (dom === 'reject') {
    base.should_suggest_hint = true;
    if (rea === 'mauvais_contexte' || rea === 'bon_signal_mauvais_contexte') {
      base.suggested_hint_type = 'context_demote_to_review';
      base.suggested_action    = 'Bloquer l\'auto-notification et envoyer en review dans ce contexte pour ce client.';
    } else if (rea === 'hors_activite') {
      base.suggested_hint_type = 'client_signal_demote_to_review';
      base.suggested_action    = 'Dégrader ce signal vers review pour ce client, sans règle globale.';
    } else {
      base.suggested_hint_type = 'client_signal_demote_to_review';
      base.suggested_action    = 'Surveiller ce signal pour ce client.';
    }
    base.rationale = 'Rejet répété (' + summary.reject_count + '/' + summary.total_decisions + ').';
  } else if (dom === 'keep') {
    base.should_suggest_hint = true;
    base.suggested_hint_type = 'context_keep_review_or_boost_candidate';
    base.suggested_action    = 'Conserver comme signal pertinent dans ce contexte pour ce client. Ne pas basculer en auto-notify sans validation humaine.';
    base.rationale           = 'Maintiens répétés.';
  } else if (dom === 'ignore') {
    base.should_suggest_hint = true;
    base.suggested_hint_type = 'ignore_pattern_observed';
    base.suggested_action    = 'Ne pas apprendre automatiquement ; motif ignoré observé.';
    base.rationale           = 'Ignores répétés.';
  }
  return base;
}

function buildReportT(entries: LearningReviewEntry[], opts?: {generatedAt?:string; sourceFiles?:string[]}): Record<string, unknown> {
  opts = opts || {};
  const genAt = opts.generatedAt || new Date().toISOString();
  const sourceFiles = opts.sourceFiles || [];

  if (!entries || entries.length === 0) {
    return { model: LEARNING_MODEL_T, generated_at: genAt, source_files: sourceFiles,
      totals: { entries: 0, with_decision: 0, pending_review: 0, groups: 0, suggested_hints: 0 },
      clients: [], suggested_hints: [] };
  }

  const groups: Record<string, { client_key: string; signal_key: string; context_key: string; reason_key: string; entries: LearningReviewEntry[] }> = {};
  entries.forEach(e => {
    const ck = clientKeyT(e), sk = signalKeyT(e), ctk = contextKeyT(e), rk = reasonKeyT(e);
    const key = [ck, sk, ctk, rk].join('||');
    if (!groups[key]) groups[key] = { client_key: ck, signal_key: sk, context_key: ctk, reason_key: rk, entries: [] };
    groups[key].entries.push(e);
  });

  const totalWithDecision = entries.filter(e => !!decisionKeyT(e)).length;
  const totalPending      = entries.length - totalWithDecision;
  const clientsMap: Record<string, { client_key: string; groups: unknown[] }> = {};
  const allSuggestions: unknown[] = [];

  Object.values(groups).forEach(g => {
    const summary    = summarizeGroupT(g.entries);
    const suggestion = suggestHintT(summary, { client_key: g.client_key, signal_key: g.signal_key, context_key: g.context_key, reason_key: g.reason_key });
    const groupRecord = { signal_key: g.signal_key, context_key: g.context_key, reason_key: g.reason_key, summary, suggestion };
    if (!clientsMap[g.client_key]) clientsMap[g.client_key] = { client_key: g.client_key, groups: [] };
    clientsMap[g.client_key]!.groups.push(groupRecord);
    if (suggestion.should_suggest_hint) allSuggestions.push(suggestion);
  });

  return {
    model: LEARNING_MODEL_T, generated_at: genAt, source_files: sourceFiles,
    totals: { entries: entries.length, with_decision: totalWithDecision, pending_review: totalPending,
              groups: Object.keys(groups).length, suggested_hints: allSuggestions.length },
    clients: Object.values(clientsMap), suggested_hints: allSuggestions,
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE_ENTRY: LearningReviewEntry = {
  client: 'Client TEST',
  matched_signals: ['hygiene'],
  ctx_profile_alignment: 'low',
  ctx_context_ambiguity: 'low',
};

const mkEntry = (overrides: Partial<LearningReviewEntry>): LearningReviewEntry => ({ ...BASE_ENTRY, ...overrides });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('review-reason-learning-report — gestion des décisions vides', () => {

  // SS-RL1 : décision vide → pending_review_count, ignorée pour l'apprentissage
  test('SS-RL1 — décision vide → pending_review_count incrémenté, non compté dans decisions', () => {
    const entries = [
      mkEntry({ decision: '', human_review_reason: 'mauvais_contexte' }),
      mkEntry({ decision: 'reject', human_review_reason: 'mauvais_contexte' }),
    ];
    const report = buildReportT(entries);
    const totals = report.totals as Record<string, number>;
    expect(totals.with_decision).toBe(1);
    expect(totals.pending_review).toBe(1);
    expect(totals.entries).toBe(2);
  });

  // SS-RL1b : entrées sans décision → included dans total mais pas dans with_decision
  test('SS-RL1b — entries sans décision comptées en pending', () => {
    const entries = [
      mkEntry({ decision: '' }),
      mkEntry({ decision: '' }),
      mkEntry({ decision: 'keep' }),
    ];
    const report = buildReportT(entries);
    const totals = report.totals as Record<string, number>;
    expect(totals.pending_review).toBe(2);
    expect(totals.with_decision).toBe(1);
  });

});

describe('review-reason-learning-report — groupement', () => {

  // SS-RL2 : même client+signal+ctx+raison → un seul groupe
  test('SS-RL2 — même client+signal+ctx+raison → un seul groupe', () => {
    const entries = [
      mkEntry({ decision: 'reject', human_review_reason: 'mauvais_contexte' }),
      mkEntry({ decision: 'reject', human_review_reason: 'mauvais_contexte' }),
    ];
    const report = buildReportT(entries);
    const clients = report.clients as Array<{ client_key: string; groups: unknown[] }>;
    expect(clients).toHaveLength(1);
    expect(clients[0]!.groups).toHaveLength(1);
  });

  // SS-RL2b : signaux différents → groupes différents
  test('SS-RL2b — signaux différents → groupes différents', () => {
    const entries = [
      mkEntry({ matched_signals: ['hygiene'], decision: 'reject' }),
      mkEntry({ matched_signals: ['nettoyage'], decision: 'reject' }),
    ];
    const report = buildReportT(entries);
    const clients = report.clients as Array<{ client_key: string; groups: unknown[] }>;
    expect(clients[0]!.groups).toHaveLength(2);
  });

});

describe('review-reason-learning-report — matched_signals string et array', () => {

  // SS-RL3 : matched_signals string avec virgule → parsé
  test('SS-RL3 — matched_signals string "hygiene, nettoyage" → parsé', () => {
    const e = mkEntry({ matched_signals: 'hygiene, nettoyage' as unknown as string[] });
    const sk = signalKeyT(e);
    expect(sk).toContain('hygiene');
    expect(sk).toContain('nettoyage');
  });

  // SS-RL3b : matched_signals tableau → accepté
  test('SS-RL3b — matched_signals tableau → accepté', () => {
    const e = mkEntry({ matched_signals: ['signal-a', 'signal-b'] });
    const sk = signalKeyT(e);
    expect(sk).toContain('signal-a');
    expect(sk).toContain('signal-b');
  });

  // SS-RL3c : signaux bloque(*) filtrés
  test('SS-RL3c — signaux bloque(*) filtrés', () => {
    const e = mkEntry({ matched_signals: ['hygiene', 'bloque(foo)'] });
    const sk = signalKeyT(e);
    expect(sk).not.toContain('bloque(');
    expect(sk).toContain('hygiene');
  });

});

describe('review-reason-learning-report — valeurs vides par défaut', () => {

  // SS-RL4 : human_review_reason vide → "unspecified"
  test('SS-RL4 — human_review_reason vide → reason_key "unspecified"', () => {
    const e = mkEntry({ human_review_reason: '' });
    expect(reasonKeyT(e)).toBe('unspecified');
  });

  // SS-RL5 : contexte absent → "no_context"
  test('SS-RL5 — contexte absent → context_key "no_context"', () => {
    const e: LearningReviewEntry = { client: 'X', matched_signals: ['sig'] }; // pas de ctx_*
    expect(contextKeyT(e)).toBe('no_context');
  });

  // SS-RL5b : profile_alignment="unclear" → "no_context"
  test('SS-RL5b — profile_alignment unclear → "no_context"', () => {
    const e = mkEntry({ ctx_profile_alignment: 'unclear', ctx_context_ambiguity: 'low' });
    expect(contextKeyT(e)).toBe('no_context');
  });

  // SS-RL6 : client vide → "unknown_client"
  test('SS-RL6 — client vide → client_key "unknown_client"', () => {
    const e: LearningReviewEntry = { matched_signals: ['sig'] }; // pas de client
    expect(clientKeyT(e)).toBe('unknown_client');
  });

});

describe('review-reason-learning-report — confidence', () => {

  // SS-RL7 : moins de 3 décisions → confidence low
  test('SS-RL7 — 2 décisions → confidence low', () => {
    const group = [
      mkEntry({ decision: 'reject', human_review_reason: 'hors_activite' }),
      mkEntry({ decision: 'reject', human_review_reason: 'hors_activite' }),
    ];
    const s = summarizeGroupT(group);
    expect(s.confidence).toBe('low');
  });

  // SS-RL8 : 3 décisions dominance >= 67% → confidence medium
  test('SS-RL8 — 3 décisions, 2/3 même décision → confidence medium', () => {
    const group = [
      mkEntry({ decision: 'reject', human_review_reason: 'mauvais_contexte' }),
      mkEntry({ decision: 'reject', human_review_reason: 'mauvais_contexte' }),
      mkEntry({ decision: 'keep',   human_review_reason: '' }),
    ];
    const s = summarizeGroupT(group);
    expect(s.total_decisions).toBe(3);
    expect(s.confidence).toBe('medium');
  });

  // SS-RL9 : 5 décisions dominance >= 80% → confidence high
  test('SS-RL9 — 5 décisions, 4/5 même → confidence high', () => {
    const group = Array(4).fill(null).map(() => mkEntry({ decision: 'reject', human_review_reason: 'hors_activite' }))
      .concat([mkEntry({ decision: 'keep' })]);
    const s = summarizeGroupT(group);
    expect(s.total_decisions).toBe(5);
    expect(s.dominance_rate).toBe(80);
    expect(s.confidence).toBe('high');
  });

});

describe('review-reason-learning-report — suggestions consultatives', () => {

  // SS-RL10 : reject + mauvais_contexte → context_demote_to_review
  test('SS-RL10 — reject + mauvais_contexte → context_demote_to_review', () => {
    const group = Array(3).fill(null).map(() => mkEntry({ decision: 'reject', human_review_reason: 'mauvais_contexte' }));
    const s = summarizeGroupT(group);
    const sg = suggestHintT(s, { client_key: 'C', signal_key: 'S', context_key: 'ctx', reason_key: 'mauvais_contexte' });
    expect(sg.should_suggest_hint).toBe(true);
    expect(sg.suggested_hint_type).toBe('context_demote_to_review');
    expect(sg.safety).toBe('shadow_only');
  });

  // SS-RL11 : reject + bon_signal_mauvais_contexte → context_demote_to_review
  test('SS-RL11 — reject + bon_signal_mauvais_contexte → context_demote_to_review', () => {
    const group = Array(3).fill(null).map(() => mkEntry({ decision: 'reject', human_review_reason: 'bon_signal_mauvais_contexte' }));
    const s = summarizeGroupT(group);
    const sg = suggestHintT(s, { client_key: 'C', signal_key: 'S', context_key: 'ctx', reason_key: 'bon_signal_mauvais_contexte' });
    expect(sg.suggested_hint_type).toBe('context_demote_to_review');
  });

  // SS-RL12 : reject + hors_activite → client_signal_demote_to_review
  test('SS-RL12 — reject + hors_activite → client_signal_demote_to_review', () => {
    const group = Array(3).fill(null).map(() => mkEntry({ decision: 'reject', human_review_reason: 'hors_activite' }));
    const s = summarizeGroupT(group);
    const sg = suggestHintT(s, { client_key: 'C', signal_key: 'S', context_key: 'ctx', reason_key: 'hors_activite' });
    expect(sg.suggested_hint_type).toBe('client_signal_demote_to_review');
  });

  // SS-RL13 : keep → context_keep_review_or_boost_candidate, sans auto-activation
  test('SS-RL13 — keep → context_keep_review_or_boost_candidate, sans auto-activation', () => {
    const group = Array(3).fill(null).map(() => mkEntry({ decision: 'keep', human_review_reason: '' }));
    const s = summarizeGroupT(group);
    const sg = suggestHintT(s, { client_key: 'C', signal_key: 'S', context_key: 'ctx', reason_key: 'unspecified' });
    expect(sg.suggested_hint_type).toBe('context_keep_review_or_boost_candidate');
    // Le libellé ne doit pas imposer une règle globale d'auto-activation
    expect(sg.suggested_hint_type).toBe('context_keep_review_or_boost_candidate');
    expect(sg.suggested_action.toLowerCase()).toContain('sans validation humaine');
  });

  // SS-RL14 : ignore → ignore_pattern_observed, pas d'apprentissage fort
  test('SS-RL14 — ignore → ignore_pattern_observed, ne pas apprendre automatiquement', () => {
    const group = Array(3).fill(null).map(() => mkEntry({ decision: 'ignore', human_review_reason: '' }));
    const s = summarizeGroupT(group);
    const sg = suggestHintT(s, { client_key: 'C', signal_key: 'S', context_key: 'ctx', reason_key: 'unspecified' });
    expect(sg.suggested_hint_type).toBe('ignore_pattern_observed');
    expect(sg.suggested_action.toLowerCase()).toContain('ne pas apprendre automatiquement');
  });

  // SS-RL15 : confidence low → pas de suggestion
  test('SS-RL15 — confidence low (2 décisions) → should_suggest_hint=false', () => {
    const group = [
      mkEntry({ decision: 'reject', human_review_reason: 'hors_activite' }),
      mkEntry({ decision: 'reject', human_review_reason: 'hors_activite' }),
    ];
    const s  = summarizeGroupT(group);
    const sg = suggestHintT(s, { client_key: 'C', signal_key: 'S', context_key: 'ctx', reason_key: 'hors_activite' });
    expect(sg.should_suggest_hint).toBe(false);
  });

  // SS-RL16 : safety est toujours "shadow_only"
  test('SS-RL16 — safety est toujours "shadow_only"', () => {
    const cases = [
      { dec: 'reject', reason: 'hors_activite' },
      { dec: 'keep',   reason: '' },
      { dec: 'ignore', reason: '' },
    ];
    cases.forEach(c => {
      const group = Array(5).fill(null).map(() => mkEntry({ decision: c.dec, human_review_reason: c.reason }));
      const s  = summarizeGroupT(group);
      const sg = suggestHintT(s, { client_key: 'C', signal_key: 'S', context_key: 'ctx', reason_key: c.reason || 'unspecified' });
      expect(sg.safety).toBe('shadow_only');
    });
  });

});

describe('review-reason-learning-report — absence de budget/prix/montant', () => {

  // SS-RL17 : les codes de hint_type ne contiennent pas budget/prix/montant
  test('SS-RL17 — suggested_hint_type ne contient pas budget/prix/montant/estimation', () => {
    const hintTypes = [
      'context_demote_to_review',
      'client_signal_demote_to_review',
      'context_keep_review_or_boost_candidate',
      'ignore_pattern_observed',
    ];
    const forbidden = ['budget', 'prix', 'montant', 'estimation'];
    hintTypes.forEach(ht => {
      forbidden.forEach(f => {
        expect(ht.toLowerCase()).not.toContain(f);
      });
    });
  });

  // SS-RL18 : rapport complet sans budget
  test('SS-RL18 — rapport complet ne mentionne pas budget dans les champs clés', () => {
    const entries = Array(3).fill(null).map(() => mkEntry({ decision: 'reject', human_review_reason: 'hors_activite' }));
    const report  = buildReportT(entries);
    const json    = JSON.stringify(report);
    expect(json.toLowerCase()).not.toContain('budget');
    expect(json.toLowerCase()).not.toContain('montant');
    expect(json.toLowerCase()).not.toContain('estimation');
  });

});

describe('review-reason-learning-report — invariants candidatures', () => {

  // SS-RL19 : buildReport ne modifie pas les entrées originales
  test('SS-RL19 — buildReport ne modifie pas les entrées originales', () => {
    const entry = mkEntry({ decision: 'reject', human_review_reason: 'hors_activite' });
    const origDecision = entry.decision;
    const origReason   = entry.human_review_reason;
    buildReportT([entry, mkEntry({ decision: 'reject' }), mkEntry({ decision: 'reject' })]);
    expect(entry.decision).toBe(origDecision);
    expect(entry.human_review_reason).toBe(origReason);
  });

  // SS-RL20 : rapport vide si entrées vides
  test('SS-RL20 — rapport vide si entrées vides', () => {
    const report = buildReportT([]);
    const totals = report.totals as Record<string, number>;
    expect(totals.entries).toBe(0);
    const clients = report.clients as unknown[];
    expect(clients).toHaveLength(0);
    const hints = report.suggested_hints as unknown[];
    expect(hints).toHaveLength(0);
  });

});
