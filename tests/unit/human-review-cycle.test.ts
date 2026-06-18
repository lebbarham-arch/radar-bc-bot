/**
 * tests/unit/human-review-cycle.test.ts
 *
 * SS-HRC1..HRC22 — Tests unitaires pour P10 (human-review-cycle)
 * Couvre : prepare, import, approve, reject.
 * Pattern miroir — logique locale, pas d'import JS.
 *
 * STRICT :
 *  - Pas de budget/prix/montant/estimation
 *  - approve ne produit jamais active/applied
 *  - import normalise decisions et reasons
 *  - pending ne sont jamais appliqués
 */

// ── Types locaux ────────────────────────────────────────────────────────────
interface ReviewItem {
  client:                    string;
  bc_id:                     string;
  score?:                    number | string;
  matched_signals?:          string | string[];
  clean_text_excerpt?:       string;
  ai_explanation?:           string;
  ctx_profile_alignment?:    string;
  ctx_context_ambiguity?:    string;
  ctx_negative_context_terms?: string[];
  ctx_positive_context_terms?: string[];
  ctx_learnable_context_hint?: string;
  human_review_decision?:    string;
  human_review_reason?:      string;
  human_review_comment?:     string;
}

interface PrepareOutput {
  generated_at:      string;
  source_review_file: string;
  instructions: {
    allowed_decisions: string[];
    allowed_reasons:   string[];
    note:              string;
  };
  items: ReviewItem[];
}

interface ImportDecision {
  client:                    string;
  bc_id:                     string;
  decision:                  string;
  human_review_reason:       string;
  human_review_reason_label: string;
  human_review_comment:      string;
  matched_signals:           string[];
}

interface ImportOutput {
  generated_at: string;
  source_file:  string;
  totals: {
    input_items:    number;
    reviewed_items: number;
    keep:           number;
    reject:         number;
    ignore:         number;
    skipped:        number;
  };
  decisions: ImportDecision[];
  skipped:   Array<{ index: number; bc_id: string; reason: string }>;
}

interface HRCHintCandidate {
  candidate_id:              string;
  safety:                    string;
  status:                    string;
  human_validation_required: boolean;
  human_approved_at?:        string;
  human_rejected_at?:        string;
  human_approval_note?:      string;
  human_rejection_note?:     string;
  [key: string]: unknown;
}

// ── Constantes ──────────────────────────────────────────────────────────────
const ALLOWED_DECISIONS   = ['keep', 'reject', 'ignore'] as const;
const ALLOWED_REASONS_HRC = [
  'hors_activite','mauvais_contexte','bon_signal_mauvais_contexte',
  'organisme_non_pertinent','zone_non_pertinente','doublon_deja_vu',
  'information_insuffisante','faux_positif_evident','autre',
] as const;
const FORBIDDEN_STATUSES_HRC = ['active', 'applied'] as const;

// ── Helpers miroir ──────────────────────────────────────────────────────────
function normalizeDecision(raw: string): string {
  const s = String(raw || '').trim().toLowerCase();
  return (ALLOWED_DECISIONS as readonly string[]).includes(s) ? s : '';
}

function normalizeReason(raw: string): string {
  const s = String(raw || '').trim().toLowerCase();
  if ((ALLOWED_REASONS_HRC as readonly string[]).includes(s)) return s;
  if (!s) return '';
  return 'autre'; // inconnu → autre
}

function prepareItems(candidates: ReviewItem[]): ReviewItem[] {
  return candidates.map((c) => ({
    client:                    c.client   || '',
    bc_id:                     c.bc_id    || '',
    score:                     c.score    ?? '',
    matched_signals:           typeof c.matched_signals === 'string'
      ? c.matched_signals
      : Array.isArray(c.matched_signals) ? c.matched_signals.join(', ') : '',
    clean_text_excerpt:        String(c.clean_text_excerpt || '').slice(0, 300),
    ai_explanation:            String(c.ai_explanation || '').slice(0, 300),
    ctx_profile_alignment:     String(c.ctx_profile_alignment || ''),
    ctx_context_ambiguity:     String(c.ctx_context_ambiguity || ''),
    ctx_negative_context_terms: Array.isArray(c.ctx_negative_context_terms) ? c.ctx_negative_context_terms : [],
    ctx_positive_context_terms: Array.isArray(c.ctx_positive_context_terms) ? c.ctx_positive_context_terms : [],
    ctx_learnable_context_hint: String(c.ctx_learnable_context_hint || ''),
    human_review_decision: '',
    human_review_reason:   '',
    human_review_comment:  '',
  }));
}

function importItems(items: ReviewItem[]): ImportOutput {
  const decisions: ImportDecision[] = [];
  const skipped: Array<{ index: number; bc_id: string; reason: string }> = [];
  const counts = { keep: 0, reject: 0, ignore: 0 };

  items.forEach((item, idx) => {
    const decision = normalizeDecision(item.human_review_decision || '');
    if (!decision) { skipped.push({ index: idx, bc_id: item.bc_id || '', reason: 'decision vide' }); return; }

    const reason      = normalizeReason(item.human_review_reason || '');
    const reasonLabel = reason || '(non spécifié)';
    counts[decision as 'keep'|'reject'|'ignore']++;

    const signals = typeof item.matched_signals === 'string'
      ? item.matched_signals.split(',').map((s) => s.trim()).filter(Boolean)
      : Array.isArray(item.matched_signals) ? item.matched_signals : [];

    decisions.push({
      client: item.client || '', bc_id: item.bc_id || '',
      decision, human_review_reason: reason, human_review_reason_label: reasonLabel,
      human_review_comment: String(item.human_review_comment || '').trim(),
      matched_signals: signals,
    });
  });

  return {
    generated_at: new Date().toISOString(),
    source_file: 'test',
    totals: { input_items: items.length, reviewed_items: decisions.length, ...counts, skipped: skipped.length },
    decisions,
    skipped,
  };
}

function approveCandidate(candidates: HRCHintCandidate[], id: string, opts: { reject?: boolean; note?: string } = {}): HRCHintCandidate[] {
  const newStatus = opts.reject ? 'human_rejected' : 'human_approved_for_shadow';
  if ((FORBIDDEN_STATUSES_HRC as readonly string[]).includes(newStatus)) throw new Error('Status interdit');
  const now = new Date().toISOString();
  return candidates.map((c) => {
    if (c.candidate_id !== id) return { ...c };
    const u: HRCHintCandidate = { ...c, status: newStatus, safety: 'shadow_only', human_validation_required: true };
    if (opts.reject) { u.human_rejected_at = now; if (opts.note) u.human_rejection_note = opts.note; }
    else             { u.human_approved_at = now; if (opts.note) u.human_approval_note  = opts.note; }
    return u;
  });
}

// ── Factories ───────────────────────────────────────────────────────────────
function makeCandidate(overrides: Partial<HRCHintCandidate> = {}): HRCHintCandidate {
  return {
    candidate_id: 'rrhc_hrc_001', safety: 'shadow_only',
    status: 'candidate_pending_human_validation', human_validation_required: true,
    ...overrides,
  };
}

function makeRawItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    client: 'Client Test', bc_id: 'BC-001', score: 8,
    matched_signals: 'nettoyage', clean_text_excerpt: 'Extrait test',
    ctx_profile_alignment: 'low', ctx_context_ambiguity: 'high',
    human_review_decision: '', human_review_reason: '', human_review_comment: '',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('P10 human-review-cycle', () => {

  // ── PREPARE ───────────────────────────────────────────────────────────────

  // SS-HRC1 : items préparés avec champs vides
  test('SS-HRC1 — prepare produit items avec decision/reason/comment vides', () => {
    const items = prepareItems([makeRawItem()]);
    expect(items[0]!.human_review_decision).toBe('');
    expect(items[0]!.human_review_reason).toBe('');
    expect(items[0]!.human_review_comment).toBe('');
  });

  // SS-HRC2 : allowed_decisions contient keep/reject/ignore
  test('SS-HRC2 — ALLOWED_DECISIONS contient keep/reject/ignore', () => {
    expect(ALLOWED_DECISIONS).toContain('keep');
    expect(ALLOWED_DECISIONS).toContain('reject');
    expect(ALLOWED_DECISIONS).toContain('ignore');
    expect(ALLOWED_DECISIONS).toHaveLength(3);
  });

  // SS-HRC3 : raisons autorisées sans budget/prix/montant/estimation
  test('SS-HRC3 — raisons autorisées sans budget/prix/montant/estimation', () => {
    const forbidden = ['budget', 'prix', 'montant', 'estimation'];
    ALLOWED_REASONS_HRC.forEach((reason) => {
      forbidden.forEach((word) => {
        expect(reason.toLowerCase()).not.toContain(word);
      });
    });
  });

  // SS-HRC4 : prepare préserve les champs CTX
  test('SS-HRC4 — prepare préserve ctx_negative et ctx_positive', () => {
    const items = prepareItems([makeRawItem({ ctx_negative_context_terms: ['médical'], ctx_positive_context_terms: ['nettoyage'] })]);
    expect(items[0]!.ctx_negative_context_terms).toEqual(['médical']);
    expect(items[0]!.ctx_positive_context_terms).toEqual(['nettoyage']);
  });

  // ── IMPORT ────────────────────────────────────────────────────────────────

  // SS-HRC5 : import ignore les items sans décision
  test('SS-HRC5 — import ignore les items sans human_review_decision', () => {
    const out = importItems([makeRawItem({ human_review_decision: '' })]);
    expect(out.totals.reviewed_items).toBe(0);
    expect(out.totals.skipped).toBe(1);
  });

  // SS-HRC6 : import normalise keep/reject/ignore
  test('SS-HRC6 — import normalise keep/reject/ignore', () => {
    const items = [
      makeRawItem({ bc_id: 'BC-A', human_review_decision: 'KEEP',   human_review_reason: 'autre' }),
      makeRawItem({ bc_id: 'BC-B', human_review_decision: 'Reject', human_review_reason: 'hors_activite' }),
      makeRawItem({ bc_id: 'BC-C', human_review_decision: 'IGNORE', human_review_reason: '' }),
    ];
    const out = importItems(items);
    expect(out.decisions[0]!.decision).toBe('keep');
    expect(out.decisions[1]!.decision).toBe('reject');
    expect(out.decisions[2]!.decision).toBe('ignore');
  });

  // SS-HRC7 : import refuse décision inconnue
  test('SS-HRC7 — import ignore (skips) décision inconnue', () => {
    const out = importItems([makeRawItem({ human_review_decision: 'supprimer' })]);
    expect(out.totals.reviewed_items).toBe(0);
    expect(out.totals.skipped).toBe(1);
  });

  // SS-HRC8 : import normalise reason via normalizeReason
  test('SS-HRC8 — import normalise reason reconnue', () => {
    const out = importItems([makeRawItem({ human_review_decision: 'reject', human_review_reason: 'mauvais_contexte' })]);
    expect(out.decisions[0]!.human_review_reason).toBe('mauvais_contexte');
  });

  // SS-HRC9 : import convertit reason inconnue en "autre"
  test('SS-HRC9 — import convertit reason inconnue non-vide en "autre"', () => {
    const out = importItems([makeRawItem({ human_review_decision: 'reject', human_review_reason: 'raison_inexistante' })]);
    expect(out.decisions[0]!.human_review_reason).toBe('autre');
  });

  // SS-HRC10 : import normalise signaux string → tableau
  test('SS-HRC10 — matched_signals string → tableau dans decisions', () => {
    const out = importItems([makeRawItem({ human_review_decision: 'reject', human_review_reason: 'autre', matched_signals: 'nettoyage, hygiène' })]);
    expect(out.decisions[0]!.matched_signals).toEqual(['nettoyage', 'hygiène']);
  });

  // SS-HRC11 : totaux corrects
  test('SS-HRC11 — totaux keep/reject/ignore/skipped corrects', () => {
    const items = [
      makeRawItem({ bc_id: 'A', human_review_decision: 'keep',   human_review_reason: 'autre' }),
      makeRawItem({ bc_id: 'B', human_review_decision: 'reject', human_review_reason: 'hors_activite' }),
      makeRawItem({ bc_id: 'C', human_review_decision: 'ignore', human_review_reason: '' }),
      makeRawItem({ bc_id: 'D', human_review_decision: '' }),
    ];
    const out = importItems(items);
    expect(out.totals.keep).toBe(1);
    expect(out.totals.reject).toBe(1);
    expect(out.totals.ignore).toBe(1);
    expect(out.totals.skipped).toBe(1);
    expect(out.totals.input_items).toBe(4);
  });

  // ── APPROVE ───────────────────────────────────────────────────────────────

  // SS-HRC12 : approve pending → human_approved_for_shadow
  test('SS-HRC12 — approve change pending → human_approved_for_shadow', () => {
    const result = approveCandidate([makeCandidate()], 'rrhc_hrc_001');
    expect(result[0]!.status).toBe('human_approved_for_shadow');
  });

  // SS-HRC13 : approve garde safety shadow_only
  test('SS-HRC13 — approve garde safety=shadow_only', () => {
    const result = approveCandidate([makeCandidate()], 'rrhc_hrc_001');
    expect(result[0]!.safety).toBe('shadow_only');
  });

  // SS-HRC14 : approve garde human_validation_required true
  test('SS-HRC14 — approve garde human_validation_required=true', () => {
    const result = approveCandidate([makeCandidate()], 'rrhc_hrc_001');
    expect(result[0]!.human_validation_required).toBe(true);
  });

  // SS-HRC15 : approve ne produit jamais active/applied
  test('SS-HRC15 — approve ne produit jamais active/applied', () => {
    const result = approveCandidate([makeCandidate()], 'rrhc_hrc_001');
    expect(result[0]!.status).not.toBe('active');
    expect(result[0]!.status).not.toBe('applied');
  });

  // SS-HRC16 : approve ajoute human_approved_at
  test('SS-HRC16 — approve ajoute human_approved_at', () => {
    const result = approveCandidate([makeCandidate()], 'rrhc_hrc_001');
    expect(result[0]!.human_approved_at).toBeTruthy();
  });

  // SS-HRC17 : approve avec note ajoute human_approval_note
  test('SS-HRC17 — approve avec note ajoute human_approval_note', () => {
    const result = approveCandidate([makeCandidate()], 'rrhc_hrc_001', { note: 'Validé en test' });
    expect(result[0]!.human_approval_note).toBe('Validé en test');
  });

  // SS-HRC18 : reject produit human_rejected
  test('SS-HRC18 — reject produit status=human_rejected', () => {
    const result = approveCandidate([makeCandidate()], 'rrhc_hrc_001', { reject: true });
    expect(result[0]!.status).toBe('human_rejected');
  });

  // SS-HRC19 : reject garde safety et human_validation_required
  test('SS-HRC19 — reject garde safety=shadow_only et human_validation_required=true', () => {
    const result = approveCandidate([makeCandidate()], 'rrhc_hrc_001', { reject: true });
    expect(result[0]!.safety).toBe('shadow_only');
    expect(result[0]!.human_validation_required).toBe(true);
  });

  // SS-HRC20 : autres candidates non touchés
  test('SS-HRC20 — approve ne touche pas les autres candidates', () => {
    const cands = [
      makeCandidate({ candidate_id: 'rrhc_001' }),
      makeCandidate({ candidate_id: 'rrhc_002' }),
    ];
    const result = approveCandidate(cands, 'rrhc_001');
    expect(result[1]!.status).toBe('candidate_pending_human_validation');
  });

  // SS-HRC21 : pas de budget/prix/montant/estimation
  test('SS-HRC21 — aucun budget/prix/montant/estimation dans les raisons', () => {
    const forbidden = ['budget', 'prix', 'montant', 'estimation'];
    ALLOWED_REASONS_HRC.forEach((r) => {
      forbidden.forEach((w) => expect(r).not.toContain(w));
    });
    const out = importItems([makeRawItem({ human_review_decision: 'reject', human_review_reason: 'mauvais_contexte' })]);
    const json = JSON.stringify(out);
    forbidden.forEach((w) => expect(json).not.toContain(w));
  });

  // SS-HRC22 : fixture sample contient 3 décisions cohérentes
  test('SS-HRC22 — fixture sample : 2 reject + 1 keep', () => {
    const fixtureItems: ReviewItem[] = [
      { client: 'C', bc_id: 'F1', human_review_decision: 'reject', human_review_reason: 'mauvais_contexte', human_review_comment: '' },
      { client: 'C', bc_id: 'F2', human_review_decision: 'reject', human_review_reason: 'bon_signal_mauvais_contexte', human_review_comment: '' },
      { client: 'C', bc_id: 'F3', human_review_decision: 'keep',   human_review_reason: 'autre', human_review_comment: '' },
    ];
    const out = importItems(fixtureItems);
    expect(out.totals.reject).toBe(2);
    expect(out.totals.keep).toBe(1);
    expect(out.totals.skipped).toBe(0);
  });

});


// ══════════════════════════════════════════════════════════════════════════════
//  CTX PROPAGATION TESTS (SS-HRC23..34)
// ══════════════════════════════════════════════════════════════════════════════

// ── Interfaces CTX étendues ──────────────────────────────────────────────────
interface ReviewCandidateWithCTX {
  client:                    string;
  bc_id:                     string;
  score?:                    number | string;
  matched_signals?:          string | string[];
  signal_origin?:            string;
  strength_reason?:          string;
  clean_text_excerpt?:       string;
  ctx_context_key?:          string;
  ctx_profile_alignment?:    string;
  ctx_context_ambiguity?:    string;
  ctx_context_confidence?:   string;
  ctx_negative_context_terms?: string[];
  ctx_positive_context_terms?: string[];
  ctx_learnable_context_hint?: string;
  ctx_should_create_context_hint?: boolean;
  ctx_should_create_hint?:   boolean;
}

// ── Miroir de prepareItems avec CTX ─────────────────────────────────────────
function prepareItemsWithCTX(candidates: ReviewCandidateWithCTX[]) {
  return candidates.map((c) => {
    let signals = c.matched_signals;
    if (Array.isArray(signals)) signals = signals.join(', ');
    signals = String(signals || '');
    return {
      client:                    c.client || '',
      bc_id:                     c.bc_id || '',
      score:                     c.score ?? '',
      matched_signals:           signals,
      signal_origin:             c.signal_origin || '',
      strength_reason:           c.strength_reason || '',
      clean_text_excerpt:        String(c.clean_text_excerpt || '').slice(0, 300),
      ctx_context_key:           c.ctx_context_key || '',
      ctx_profile_alignment:     c.ctx_profile_alignment || '',
      ctx_context_ambiguity:     c.ctx_context_ambiguity || '',
      ctx_context_confidence:    c.ctx_context_confidence || '',
      ctx_negative_context_terms: Array.isArray(c.ctx_negative_context_terms)
        ? c.ctx_negative_context_terms : [],
      ctx_positive_context_terms: Array.isArray(c.ctx_positive_context_terms)
        ? c.ctx_positive_context_terms : [],
      ctx_learnable_context_hint:  c.ctx_learnable_context_hint || '',
      ctx_should_create_hint:      c.ctx_should_create_context_hint === true || c.ctx_should_create_hint === true,
      human_review_decision: '',
      human_review_reason:   '',
      human_review_comment:  '',
    };
  });
}

// ── Miroir de importItems avec CTX ──────────────────────────────────────────
interface ReviewItemWithCTX {
  client: string;
  bc_id: string;
  matched_signals?: string | string[];
  human_review_decision?: string;
  human_review_reason?: string;
  human_review_comment?: string;
  ctx_context_key?: string;
  ctx_profile_alignment?: string;
  ctx_context_ambiguity?: string;
  ctx_context_confidence?: string;
  ctx_negative_context_terms?: string[];
  ctx_positive_context_terms?: string[];
  ctx_learnable_context_hint?: string;
  ctx_should_create_hint?: boolean;
  clean_text_excerpt?: string;
  score?: number | string;
  signal_origin?: string;
  strength_reason?: string;
}

function importItemsWithCTX(items: ReviewItemWithCTX[]) {
  const decisions: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[]   = [];

  items.forEach((item, idx) => {
    const d = normalizeDecision(item.human_review_decision || '');
    if (!d) { skipped.push({ index: idx, bc_id: item.bc_id }); return; }

    const signals = typeof item.matched_signals === 'string'
      ? item.matched_signals.split(',').map(s => s.trim()).filter(Boolean)
      : Array.isArray(item.matched_signals) ? item.matched_signals : [];

    decisions.push({
      client: item.client, bc_id: item.bc_id, decision: d,
      matched_signals: signals,
      ctx_context_key:           item.ctx_context_key || '',
      ctx_profile_alignment:     item.ctx_profile_alignment || '',
      ctx_context_ambiguity:     item.ctx_context_ambiguity || '',
      ctx_context_confidence:    item.ctx_context_confidence || '',
      ctx_negative_context_terms: Array.isArray(item.ctx_negative_context_terms)
        ? item.ctx_negative_context_terms : [],
      ctx_positive_context_terms: Array.isArray(item.ctx_positive_context_terms)
        ? item.ctx_positive_context_terms : [],
      ctx_learnable_context_hint: item.ctx_learnable_context_hint || '',
      ctx_should_create_hint:     item.ctx_should_create_hint === true,
    });
  });

  const learningRecords = decisions.map((d) => {
    const item = items.find(it => it.bc_id === d['bc_id'] && it.client === d['client']) || {};
    return {
      ...d,
      ctx_context_key:           (item as ReviewItemWithCTX).ctx_context_key || '',
      ctx_learnable_context_hint: (item as ReviewItemWithCTX).ctx_learnable_context_hint || '',
      ctx_negative_context_terms: (item as ReviewItemWithCTX).ctx_negative_context_terms || [],
    };
  });

  return { decisions, learningRecords, skipped };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const KNOWN_CONTEXT_LABELS_HRC = [
  'medical_admin_context', 'cleaning_disinfection_context', 'food_or_beverage_context',
  'office_supplies_context', 'it_context', 'event_context', 'construction_or_works_context',
];
const MEDICAL_NEG_TERMS_HRC = [
  'medico', 'materiel medico', 'dmsps', 'santé', 'sante', 'centre hospitalier',
];
function deriveContextKey(item: ReviewItemWithCTX): string {
  const hint = (item.ctx_learnable_context_hint || '').trim().toLowerCase();
  if (hint && KNOWN_CONTEXT_LABELS_HRC.some(l => hint.includes(l))) {
    return KNOWN_CONTEXT_LABELS_HRC.find(l => hint.includes(l)) || 'no_context';
  }
  const ctk = (item.ctx_context_key || '').trim();
  if (ctk && ctk !== 'no_context' && ctk !== 'unknown_context') return ctk;
  const neg = item.ctx_negative_context_terms || [];
  const negLow = neg.map(t => t.toLowerCase());
  if (MEDICAL_NEG_TERMS_HRC.some(term => negLow.some(t => t.includes(term)))) return 'medical_admin_context';
  return 'no_context';
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('P10 human-review-cycle — CTX propagation (SS-HRC23..34)', () => {

  const BASE_CANDIDATE_CTX: ReviewCandidateWithCTX = {
    client: 'TEST PROD - Nettoyage Hygiène',
    bc_id:  'BC-CTX-001',
    score:  5,
    matched_signals: ['hygiène'],
    signal_origin: 'inclusion',
    ctx_profile_alignment:     'low',
    ctx_context_ambiguity:     'low',
    ctx_context_confidence:    'low',
    ctx_negative_context_terms: ['medico', 'materiel medico', 'dmsps'],
    ctx_positive_context_terms: [],
    ctx_learnable_context_hint: 'Contexte détecté : medical_admin_context. Vérifier si ce contexte correspond au profil.',
    ctx_should_create_context_hint: false,
  };

  // SS-HRC23 : prepare préserve ctx_negative_context_terms
  test('SS-HRC23 — prepare préserve ctx_negative_context_terms', () => {
    const items = prepareItemsWithCTX([BASE_CANDIDATE_CTX]);
    expect(items[0]!.ctx_negative_context_terms).toEqual(['medico', 'materiel medico', 'dmsps']);
  });

  // SS-HRC24 : prepare préserve ctx_learnable_context_hint
  test('SS-HRC24 — prepare préserve ctx_learnable_context_hint', () => {
    const items = prepareItemsWithCTX([BASE_CANDIDATE_CTX]);
    expect(items[0]!.ctx_learnable_context_hint).toContain('medical_admin_context');
  });

  // SS-HRC25 : prepare préserve ctx_profile_alignment
  test('SS-HRC25 — prepare préserve ctx_profile_alignment', () => {
    const items = prepareItemsWithCTX([BASE_CANDIDATE_CTX]);
    expect(items[0]!.ctx_profile_alignment).toBe('low');
  });

  // SS-HRC26 : prepare préserve signal_origin et strength_reason
  test('SS-HRC26 — prepare préserve signal_origin', () => {
    const items = prepareItemsWithCTX([BASE_CANDIDATE_CTX]);
    expect(items[0]!.signal_origin).toBe('inclusion');
  });

  // SS-HRC27 : prepare — human_review_decision reste vide
  test('SS-HRC27 — prepare : human_review_decision reste vide même si CTX présents', () => {
    const items = prepareItemsWithCTX([BASE_CANDIDATE_CTX]);
    expect(items[0]!.human_review_decision).toBe('');
  });

  // SS-HRC28 : import préserve ctx_negative_context_terms dans decisions
  test('SS-HRC28 — import préserve ctx_negative_context_terms dans decisions', () => {
    const item: ReviewItemWithCTX = {
      client: 'C', bc_id: 'BC1',
      human_review_decision: 'reject',
      human_review_reason: 'bon_signal_mauvais_contexte',
      ctx_negative_context_terms: ['medico', 'dmsps'],
      ctx_learnable_context_hint: 'medical_admin_context',
    };
    const out = importItemsWithCTX([item]);
    expect(out.decisions[0]!['ctx_negative_context_terms']).toEqual(['medico', 'dmsps']);
  });

  // SS-HRC29 : import préserve ctx_learnable_context_hint dans learningRecords
  test('SS-HRC29 — import préserve ctx_learnable_context_hint dans learningRecords', () => {
    const item: ReviewItemWithCTX = {
      client: 'C', bc_id: 'BC1',
      human_review_decision: 'reject',
      ctx_learnable_context_hint: 'Contexte détecté : medical_admin_context.',
    };
    const out = importItemsWithCTX([item]);
    expect(out.learningRecords[0]!['ctx_learnable_context_hint']).toContain('medical_admin_context');
  });

  // SS-HRC30 : import — ctx_context_key préservé si présent
  test('SS-HRC30 — import préserve ctx_context_key explicite', () => {
    const item: ReviewItemWithCTX = {
      client: 'C', bc_id: 'BC1',
      human_review_decision: 'reject',
      ctx_context_key: 'medical_admin_context',
    };
    const out = importItemsWithCTX([item]);
    expect(out.decisions[0]!['ctx_context_key']).toBe('medical_admin_context');
  });

  // SS-HRC31 : pipeline minimal — ctx_learnable_context_hint → context_key = medical_admin_context
  test('SS-HRC31 — pipeline : ctx_learnable_context_hint avec medical_admin_context → deriveContextKey=medical_admin_context', () => {
    const item: ReviewItemWithCTX = {
      client: 'C', bc_id: 'BC1',
      human_review_decision: 'reject',
      ctx_learnable_context_hint: 'Contexte détecté : medical_admin_context. Vérifier profil.',
    };
    const ctk = deriveContextKey(item);
    expect(ctk).toBe('medical_admin_context');
  });

  // SS-HRC32 : pipeline minimal — ctx_negative_terms médicaux → medical_admin_context
  test('SS-HRC32 — pipeline : ctx_negative_terms médicaux → deriveContextKey=medical_admin_context', () => {
    const item: ReviewItemWithCTX = {
      client: 'C', bc_id: 'BC1',
      human_review_decision: 'reject',
      ctx_negative_context_terms: ['medico', 'dmsps'],
    };
    const ctk = deriveContextKey(item);
    expect(ctk).toBe('medical_admin_context');
  });

  // SS-HRC33 : pipeline minimal — sans CTX → no_context
  test('SS-HRC33 — pipeline : sans CTX → deriveContextKey=no_context', () => {
    const item: ReviewItemWithCTX = { client: 'C', bc_id: 'BC1', human_review_decision: 'reject' };
    const ctk = deriveContextKey(item);
    expect(ctk).toBe('no_context');
  });

  // SS-HRC34 : import — ctx_should_create_hint false si absent
  test('SS-HRC34 — import : ctx_should_create_hint = false si absent dans source', () => {
    const item: ReviewItemWithCTX = {
      client: 'C', bc_id: 'BC1',
      human_review_decision: 'reject',
    };
    const out = importItemsWithCTX([item]);
    expect(out.decisions[0]!['ctx_should_create_hint']).toBe(false);
  });

});
