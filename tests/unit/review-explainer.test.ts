/**
 * tests/unit/review-explainer.test.ts — GD-034
 *
 * Tests unitaires du module review-explainer.js (rule-based-v1).
 * SS-RE1..RE13 — miroir pur de la logique, aucun import FS, aucun appel réseau.
 *
 * Règles :
 *  - Aucune règle spécifique à un signal ou à un client.
 *  - L'explication ne modifie jamais auto_notify_candidate / review_candidate.
 *  - ai_suggested_decision est TOUJOURS "review".
 */

// ─── Miroir de la logique review-explainer.js ────────────────────────────────

const EXPLAINER_MODEL_T   = 'rule-based-v1';
const STRONG_THRESHOLD_T  = 15;
const WEAK_THRESHOLD_T    = 5;

interface ReviewEntry {
  bc_id?:               string;
  clean_score?:         number;
  matched_signals?:     string[];
  signal_origin?:       string;
  hint_block_auto?:     boolean;
  hint_applied?:        string;
  hint_score_adj?:      number;
  weak_single_signal?:  boolean;
  exclusion_hit?:       boolean;
  strength_reason?:     string;
  clean_text_excerpt?:  string;
  auto_notify_candidate?: boolean;
  review_candidate?:      boolean;
}

interface ExplainResult {
  ai_review_explanation:  string;
  ai_relevance_reasons:   string[];
  ai_risk_reasons:        string[];
  ai_suggested_decision:  string;
  ai_confidence:          string;
  ai_review_model:        string;
  ai_review_generated_at: string;
}

interface ExplainOpts {
  generatedAt?:     string;
  signalRiskTable?: Record<string, string>;
}

function explainReviewCandidate(entry: ReviewEntry, opts?: ExplainOpts): ExplainResult {
  const o             = opts || {};
  const generatedAt   = o.generatedAt || new Date().toISOString();
  const riskTable     = o.signalRiskTable || {};

  const score         = entry.clean_score != null ? Number(entry.clean_score) : 0;
  const sigs          = (entry.matched_signals || []).filter((s: string) => s.indexOf('bloque(') === -1);
  const origin        = entry.signal_origin   || 'unknown';
  const hintBlock     = !!entry.hint_block_auto;
  const hintApplied   = entry.hint_applied    ? String(entry.hint_applied) : null;
  const hintAdj       = entry.hint_score_adj  != null ? Number(entry.hint_score_adj) : 0;
  const weakSingle    = !!entry.weak_single_signal;
  const exclHit       = !!entry.exclusion_hit;
  const strengthRsn   = entry.strength_reason || null;

  const relevanceReasons: string[] = [];
  const riskReasons: string[]      = [];

  // ── Pertinence ──────────────────────────────────────────────────────────────
  if (sigs.length > 0) {
    relevanceReasons.push('Signal(s) détecté(s) : ' + sigs.join(', ') + '.');
  }
  if (origin === 'primary') {
    relevanceReasons.push('Match issu de critères primaires — pertinence structurelle élevée.');
  } else if (origin === 'inclusion') {
    relevanceReasons.push("Match issu de critères d'inclusion — confirme la thématique mais non discriminant seul.");
  }
  if (score >= STRONG_THRESHOLD_T) {
    const adj = hintAdj !== 0 ? ' (avant ajustement hint : ' + hintAdj + ')' : '';
    relevanceReasons.push('Score ' + score + ' ≥ ' + STRONG_THRESHOLD_T + ' : seuil fort atteint' + adj + '.');
  } else if (score >= WEAK_THRESHOLD_T) {
    relevanceReasons.push('Score ' + score + ' dans la plage review (' + WEAK_THRESHOLD_T + '–' + (STRONG_THRESHOLD_T - 1) + ').');
  }
  if (strengthRsn) {
    relevanceReasons.push('Raison de force : ' + strengthRsn + '.');
  }
  sigs.forEach((s: string) => {
    function normKey(str: string): string {
      return str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    }
    const verdict = riskTable[normKey(s)];
    if (verdict) {
      relevanceReasons.push('Signal "' + s + '" : tier ' + verdict + ' selon l\'historique des décisions.');
    }
  });

  // ── Risques ──────────────────────────────────────────────────────────────────
  if (weakSingle) {
    riskReasons.push('Signal unique de niveau secondaire — insuffisant seul pour confirmer la pertinence sans contexte primaire.');
  }
  if (hintBlock) {
    const hintDetail = hintApplied ? ' (' + hintApplied + ')' : '';
    riskReasons.push('Hint client actif' + hintDetail + ' : l\'auto-notification est bloquée sur la base des décisions historiques de ce client pour ce signal.');
    if (hintAdj < 0) {
      const effective = score + hintAdj;
      riskReasons.push('Ajustement de score appliqué : ' + hintAdj + ' (score effectif : ' + effective + ').');
    }
  }
  if (exclHit) {
    riskReasons.push("Critère d'exclusion déclenché — risque de faux positif élevé.");
  }
  if (sigs.length === 0) {
    riskReasons.push('Aucun signal thématique actif identifiable — correspondance probablement générique ou bruit.');
  }

  // ── Confiance ────────────────────────────────────────────────────────────────
  let confidence: string;
  if (sigs.length === 0 || weakSingle) {
    confidence = 'low';
  } else if (hintBlock || exclHit) {
    confidence = 'medium';
  } else if (sigs.length >= 2 && score >= STRONG_THRESHOLD_T) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // ── Suggested decision : TOUJOURS "review" ───────────────────────────────────
  const suggestedDecision = 'review';

  // ── Texte narratif ────────────────────────────────────────────────────────────
  const parts: string[] = [];
  if (sigs.length > 0) {
    parts.push('Ce BC contient ' + sigs.length + ' signal(s) actif(s) (' + sigs.join(', ') + ')' +
      (origin !== 'unknown' ? ', issu(s) de critères de type "' + origin + '"' : '') + '.');
  } else {
    parts.push('Aucun signal thématique clair identifié dans ce BC.');
  }
  if (riskReasons.length > 0) parts.push(riskReasons.join(' '));
  const extraRel = relevanceReasons.slice(1);
  if (extraRel.length > 0) parts.push('Éléments de contexte : ' + extraRel.join(' '));
  parts.push('Décision recommandée : revue humaine (keep / reject / ignore).');

  return {
    ai_review_explanation:  parts.join(' '),
    ai_relevance_reasons:   relevanceReasons,
    ai_risk_reasons:        riskReasons,
    ai_suggested_decision:  suggestedDecision,
    ai_confidence:          confidence,
    ai_review_model:        EXPLAINER_MODEL_T,
    ai_review_generated_at: generatedAt,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('review-explainer — structure de sortie', () => {

  // SS-RE1 : tous les champs obligatoires sont présents
  test('SS-RE1 — la sortie contient tous les champs ai_* obligatoires', () => {
    const entry: ReviewEntry = { clean_score: 5, matched_signals: ['signal-a'] };
    const r = explainReviewCandidate(entry);
    expect(r).toHaveProperty('ai_review_explanation');
    expect(r).toHaveProperty('ai_relevance_reasons');
    expect(r).toHaveProperty('ai_risk_reasons');
    expect(r).toHaveProperty('ai_suggested_decision');
    expect(r).toHaveProperty('ai_confidence');
    expect(r).toHaveProperty('ai_review_model');
    expect(r).toHaveProperty('ai_review_generated_at');
  });

  // SS-RE2 : ai_suggested_decision est TOUJOURS "review"
  test('SS-RE2 — ai_suggested_decision est toujours "review" (l\'IA ne décide pas)', () => {
    const cases: ReviewEntry[] = [
      { clean_score: 5,  matched_signals: ['sig1'] },
      { clean_score: 15, matched_signals: ['sig1', 'sig2'] },
      { clean_score: 25, matched_signals: ['sig1', 'sig2', 'sig3'] },
      { clean_score: 0,  matched_signals: [] },
    ];
    for (const c of cases) {
      expect(explainReviewCandidate(c).ai_suggested_decision).toBe('review');
    }
  });

  // SS-RE3 : model identifier
  test('SS-RE3 — ai_review_model est "rule-based-v1"', () => {
    const r = explainReviewCandidate({ clean_score: 5, matched_signals: ['sig'] });
    expect(r.ai_review_model).toBe('rule-based-v1');
  });

  // SS-RE4 : ai_review_generated_at accepte une valeur injectée
  test('SS-RE4 — ai_review_generated_at accepte une valeur injectée', () => {
    const fixed = '2026-01-01T00:00:00.000Z';
    const r = explainReviewCandidate({ clean_score: 5 }, { generatedAt: fixed });
    expect(r.ai_review_generated_at).toBe(fixed);
  });

});

describe('review-explainer — confiance (ai_confidence)', () => {

  // SS-RE5 : aucun signal → confidence low
  test('SS-RE5 — aucun signal → confidence "low"', () => {
    const r = explainReviewCandidate({ clean_score: 5, matched_signals: [] });
    expect(r.ai_confidence).toBe('low');
    expect(r.ai_risk_reasons.length).toBeGreaterThan(0);
  });

  // SS-RE6 : weak_single_signal=true → confidence low
  test('SS-RE6 — weak_single_signal=true → confidence "low"', () => {
    const r = explainReviewCandidate({
      clean_score: 5,
      matched_signals: ['signal-unique'],
      weak_single_signal: true,
    });
    expect(r.ai_confidence).toBe('low');
    expect(r.ai_risk_reasons.some((rr: string) => rr.toLowerCase().includes('unique'))).toBe(true);
  });

  // SS-RE7 : hint_block_auto=true → confidence medium
  test('SS-RE7 — hint_block_auto=true + signaux présents → confidence "medium"', () => {
    const r = explainReviewCandidate({
      clean_score: 15,
      matched_signals: ['signal-a', 'signal-b'],
      hint_block_auto: true,
      hint_applied: 'signal-a:demote_to_review',
      hint_score_adj: -3,
    });
    expect(r.ai_confidence).toBe('medium');
  });

  // SS-RE8 : multi-signaux + score fort → confidence medium (jamais high)
  test('SS-RE8 — multi-signaux + score fort → confidence "medium" (jamais "high")', () => {
    const r = explainReviewCandidate({
      clean_score: 20,
      matched_signals: ['signal-a', 'signal-b'],
    });
    expect(r.ai_confidence).toBe('medium');
    expect(r.ai_confidence).not.toBe('high');
  });

});

describe('review-explainer — raisons de risque', () => {

  // SS-RE9 : hint_block_auto=true → risk reason contient info sur le blocage
  test('SS-RE9 — hint_block_auto=true → risk reason mentionne le blocage + ajustement', () => {
    const r = explainReviewCandidate({
      clean_score: 15,
      matched_signals: ['signal-x', 'signal-y'],
      hint_block_auto: true,
      hint_applied: 'signal-x:demote_to_review',
      hint_score_adj: -3,
    });
    const combined = r.ai_risk_reasons.join(' ');
    expect(combined.toLowerCase()).toMatch(/hint|bloqu/);
    expect(combined).toMatch(/-3/);
  });

  // SS-RE10 : exclusion_hit=true → risk reason mentionne exclusion
  test('SS-RE10 — exclusion_hit=true → risk reason mentionne exclusion', () => {
    const r = explainReviewCandidate({
      clean_score: 5,
      matched_signals: ['signal-z'],
      exclusion_hit: true,
    });
    expect(r.ai_risk_reasons.some((rr: string) => rr.toLowerCase().includes('exclusion'))).toBe(true);
  });

  // SS-RE11 : entrée saine sans blocages et signaux multiples → risk_reasons vide
  test('SS-RE11 — entrée sans blocage ni signal faible → ai_risk_reasons vide', () => {
    const r = explainReviewCandidate({
      clean_score: 10,
      matched_signals: ['signal-a', 'signal-b'],
      signal_origin: 'primary',
    });
    expect(r.ai_risk_reasons.length).toBe(0);
  });

});

describe('review-explainer — invariants de candidature', () => {

  // SS-RE12 : l'explainer ne touche JAMAIS auto_notify_candidate ni review_candidate
  test('SS-RE12 — l\'explainer ne modifie pas auto_notify_candidate ni review_candidate', () => {
    const entry: ReviewEntry = {
      clean_score: 15,
      matched_signals: ['signal-a', 'signal-b'],
      auto_notify_candidate: false,
      review_candidate:      true,
      hint_block_auto:       true,
    };
    const autoBefore   = entry.auto_notify_candidate;
    const reviewBefore = entry.review_candidate;

    explainReviewCandidate(entry);

    expect(entry.auto_notify_candidate).toBe(autoBefore);
    expect(entry.review_candidate).toBe(reviewBefore);
  });

});

describe('review-explainer — généricité (aucune règle signal/client)', () => {

  // SS-RE13 : même structure pour deux signaux différents avec mêmes flags
  test('SS-RE13 — généricité : même confidence/decision/nb_risk quel que soit le signal', () => {
    const base = { clean_score: 15, hint_block_auto: true, hint_score_adj: -3 };
    const r1 = explainReviewCandidate({ ...base, matched_signals: ['signal-aaa'] });
    const r2 = explainReviewCandidate({ ...base, matched_signals: ['signal-bbb'] });

    expect(r1.ai_confidence).toBe(r2.ai_confidence);
    expect(r1.ai_suggested_decision).toBe(r2.ai_suggested_decision);
    expect(r1.ai_risk_reasons.length).toBe(r2.ai_risk_reasons.length);
  });

});
