/**
 * tests/unit/apply-review-reason-hints-shadow.test.ts
 *
 * SS-AH1..AH26 — Tests unitaires pour GD-039 (apply-review-reason-hints-shadow.js)
 * Pattern miroir : logique définie localement pour éviter TS7016.
 *
 * STRICT :
 *  - pending / rejected / active / applied → ignorés
 *  - seul status "human_approved_for_shadow" → appliqué
 *  - safety doit être "shadow_only"
 *  - human_validation_required doit être true
 *  - Ne modifie jamais scoreBC(), les poids, les seuils, le scoring brut
 *  - Ne mute jamais l'entrée source
 *  - Pas de budget/prix/montant/estimation
 *  - Aucun réseau/API/IA externe
 */

// ── Types locaux ────────────────────────────────────────────────────────────
interface ShadowEntry {
  client?:                       string;
  client_key?:                   string;
  clientName?:                   string;
  bc_id?:                        string;
  clean_score?:                  number;
  matched_signals?:              string | string[];
  auto_notify_candidate?:        boolean;
  review_candidate?:             boolean;
  ctx_context_key?:              string | undefined;
  context_key?:                  string | undefined;
  ctx_learnable_context_hint?:   string | undefined;
  ctx_negative_context_terms?:   string[] | undefined;
  ctx_positive_context_terms?:   string[] | undefined;
  review_reason_hint_applied?:   boolean;
  review_reason_hint_action?:    string;
  review_reason_hint_ids?:       string[];
  review_reason_hint_explanation?: string;
  [key: string]: unknown;
}

interface HintEffect {
  action:     string;
  scope:      string;
  applies_to: { client_key?: string; signal_key?: string; context_key?: string };
}

interface HintCandidate {
  candidate_id:              string;
  client_key?:               string;
  signal_key?:               string;
  context_key?:              string;
  hint_type?:                string;
  proposed_effect:           HintEffect;
  safety:                    string;
  status:                    string;
  human_validation_required: boolean;
  rationale?:                string;
}

interface LoadResult {
  approved_hints: HintCandidate[];
  skipped:        Array<{ reason: string; source: unknown }>;
  totals:         { input: number; approved: number; skipped: number };
}

// ── Constantes miroir ───────────────────────────────────────────────────────
const AH_STATUS_APPROVED     = 'human_approved_for_shadow';
const AH_FORBIDDEN_ACTIONS   = ['auto_notify','boost_score','change_threshold','change_weight','apply_to_prod','activate'] as const;
const AH_ALLOWED_ACTIONS     = ['block_auto_and_send_to_review','send_to_review','keep_review_candidate_only','observe_only'] as const;
const AH_FORBIDDEN_STATUSES  = ['applied','active'] as const;
const AH_SKIP_STATUSES       = ['candidate_pending_human_validation','human_rejected'] as const;

// ── Helpers miroir ──────────────────────────────────────────────────────────
function normSignal(s: string): string {
  if (!s) return '';
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function extractMatchedSignals(entry: ShadowEntry): string[] {
  const raw = entry.matched_signals;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normSignal).filter(Boolean);
  if (typeof raw === 'string') return raw.split(',').map(normSignal).filter(Boolean);
  return [];
}

function normClient(s: string | undefined | null): string {
  if (!s) return '';
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function clientMatches(entry: ShadowEntry, clientKey: string): boolean {
  if (!clientKey || clientKey === 'unknown_client') return false;
  const ec = String(entry.client || entry.client_key || entry.clientName || '').trim();
  if (!ec) return false;
  return normClient(ec) === normClient(clientKey);
}

function signalMatches(entry: ShadowEntry, signalKey: string): boolean {
  if (!signalKey || signalKey === 'unknown_signal' || signalKey === '_none_') return false;
  return extractMatchedSignals(entry).includes(normSignal(signalKey));
}

// ── Résolution contextuelle miroir (identique à resolveEntryContextKey prod) ──
const AH_KNOWN_CONTEXT_LABELS = [
  'medical_admin_context', 'cleaning_disinfection_context', 'food_or_beverage_context',
  'office_supplies_context', 'it_context', 'event_context', 'construction_or_works_context',
] as const;

const AH_MEDICAL_NEG_TERMS = [
  'medico', 'materiel medico', 'medico technique', 'dmsps', 'dmspsf',
  'santé', 'sante', 'centre hospitalier', 'hopital', 'hôpital', 'chp', 'chr',
  'hygiène du milieu', 'ministère de la santé', 'delegation de la sante',
];

const AH_CLEANING_TERMS = [
  'desinfection', 'désinfection', 'deratisation', 'dératisation',
  'desinsectisation', 'désinsectisation', 'nettoyage', 'nettoiement',
];

function resolveEntryContextKeyT(entry: ShadowEntry): string {
  // A. ctx_context_key explicite
  const ctk = String(entry.ctx_context_key || entry.context_key || '').trim();
  if (ctk && ctk !== 'no_context' && ctk !== 'unknown_context') return ctk;
  // B. ctx_learnable_context_hint contient label connu
  const hint = String(entry.ctx_learnable_context_hint || '').toLowerCase();
  for (const lbl of AH_KNOWN_CONTEXT_LABELS) {
    if (hint.includes(lbl)) return lbl;
  }
  // C. ctx_negative_context_terms
  const neg = (entry.ctx_negative_context_terms || []).map(t => t.toLowerCase());
  if (AH_MEDICAL_NEG_TERMS.some(term => neg.some(t => t.includes(term)))) return 'medical_admin_context';
  if (AH_CLEANING_TERMS.some(term => neg.some(t => t.includes(term)))) return 'cleaning_disinfection_context';
  // C2. ctx_positive_context_terms
  const pos = (entry.ctx_positive_context_terms || []).map(t => t.toLowerCase());
  if (AH_CLEANING_TERMS.some(term => pos.some(t => t.includes(term)))) return 'cleaning_disinfection_context';
  return 'no_context';
}

function contextMatches(entry: ShadowEntry, contextKey: string): boolean {
  if (!contextKey) return true;
  return resolveEntryContextKeyT(entry) === contextKey;
}

function loadApprovedHints(raw: { candidates?: HintCandidate[] } | HintCandidate[]): LoadResult {
  const approved: HintCandidate[] = [];
  const skipped: Array<{ reason: string; source: unknown }> = [];
  const candidates: HintCandidate[] = Array.isArray(raw) ? raw
    : Array.isArray((raw as { candidates?: HintCandidate[] }).candidates)
      ? (raw as { candidates: HintCandidate[] }).candidates
      : [];

  candidates.forEach((c) => {
    if (!c) { skipped.push({ reason: 'null', source: '' }); return; }
    if (!c.candidate_id) { skipped.push({ reason: 'candidate_id manquant', source: '' }); return; }
    if (c.safety !== 'shadow_only') { skipped.push({ reason: 'safety != shadow_only', source: c.candidate_id }); return; }
    if (c.human_validation_required !== true) { skipped.push({ reason: 'human_validation_required != true', source: c.candidate_id }); return; }
    if ((AH_SKIP_STATUSES as readonly string[]).includes(c.status)) { skipped.push({ reason: 'status ignoré (' + c.status + ')', source: c.candidate_id }); return; }
    if ((AH_FORBIDDEN_STATUSES as readonly string[]).includes(c.status)) { skipped.push({ reason: 'status interdit', source: c.candidate_id }); return; }
    if (c.status !== AH_STATUS_APPROVED) { skipped.push({ reason: 'status non reconnu', source: c.candidate_id }); return; }
    if (!c.proposed_effect) { skipped.push({ reason: 'proposed_effect manquant', source: c.candidate_id }); return; }
    const action = c.proposed_effect.action;
    if ((AH_FORBIDDEN_ACTIONS as readonly string[]).includes(action)) { skipped.push({ reason: 'action interdite', source: c.candidate_id }); return; }
    if (!(AH_ALLOWED_ACTIONS as readonly string[]).includes(action)) { skipped.push({ reason: 'action inconnue', source: c.candidate_id }); return; }
    approved.push(c);
  });

  return { approved_hints: approved, skipped, totals: { input: candidates.length, approved: approved.length, skipped: skipped.length } };
}

function evaluateHintForEntry(entry: ShadowEntry, hint: HintCandidate): { matches: boolean; reason: string } {
  const effect  = hint.proposed_effect;
  const applyTo = effect.applies_to;
  const scope   = effect.scope;
  const action  = effect.action;
  const cKey    = String(applyTo.client_key  || hint.client_key  || '').trim();
  const sKey    = String(applyTo.signal_key  || hint.signal_key  || '').trim();
  const ctxKey  = String(applyTo.context_key || hint.context_key || '').trim();

  if ((AH_FORBIDDEN_ACTIONS as readonly string[]).includes(action)) return { matches: false, reason: 'action interdite' };
  if (!clientMatches(entry, cKey))  return { matches: false, reason: 'client mismatch' };
  if (!signalMatches(entry, sKey))  return { matches: false, reason: 'signal mismatch' };
  if (scope === 'client_signal_context' && ctxKey && !contextMatches(entry, ctxKey)) {
    return { matches: false, reason: 'context mismatch' };
  }
  return { matches: true, reason: 'ok' };
}

function applyHintsToEntry(entry: ShadowEntry, hints: HintCandidate[]): ShadowEntry {
  if (!hints.length) return { ...entry };
  const matched: string[] = [];
  const actions: string[] = [];
  const explanations: string[] = [];

  hints.forEach((hint) => {
    const ev = evaluateHintForEntry(entry, hint);
    if (!ev.matches) return;
    matched.push(hint.candidate_id);
    actions.push(hint.proposed_effect.action);
    explanations.push(hint.rationale || hint.proposed_effect.action);
  });

  if (!matched.length) return { ...entry };

  const copy: ShadowEntry = { ...entry };
  copy.review_reason_hint_applied     = true;
  copy.review_reason_hint_action      = actions[0] ?? '';
  copy.review_reason_hint_ids         = matched;
  copy.review_reason_hint_explanation = explanations.join(' | ');

  const dominantAction = actions[0] ?? '';
  if (dominantAction === 'block_auto_and_send_to_review') {
    copy.auto_notify_candidate = false;
    copy.review_candidate      = true;
  } else if (dominantAction === 'send_to_review') {
    copy.auto_notify_candidate = false;
    copy.review_candidate      = true;
  } else if (dominantAction === 'keep_review_candidate_only') {
    copy.auto_notify_candidate = false;
  }
  // observe_only : aucun changement de bucket

  return copy;
}

// ── Factories ───────────────────────────────────────────────────────────────
function makeHint(overrides: Partial<HintCandidate> = {}): HintCandidate {
  return {
    candidate_id: 'rrhc_test_001',
    client_key:   'Client ABC',
    signal_key:   'nettoyage',
    context_key:  'ctx_medical',
    proposed_effect: {
      action:     'block_auto_and_send_to_review',
      scope:      'client_signal_context',
      applies_to: { client_key: 'Client ABC', signal_key: 'nettoyage', context_key: 'ctx_medical' },
    },
    safety:                    'shadow_only',
    status:                    AH_STATUS_APPROVED,
    human_validation_required: true,
    rationale:                 'signal nettoyage hors contexte médical',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ShadowEntry> = {}): ShadowEntry {
  return {
    client:              'Client ABC',
    bc_id:               'BC-001',
    clean_score:         12,
    matched_signals:     ['nettoyage', 'hygiène'],
    auto_notify_candidate: false,
    review_candidate:    true,
    ctx_context_key:     'ctx_medical',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('GD-039 apply-review-reason-hints-shadow', () => {

  // ── SS-AH1 : candidate pending → ignoré ──────────────────────────────────
  test('SS-AH1 — candidate_pending_human_validation → skipped', () => {
    const r = loadApprovedHints({ candidates: [makeHint({ status: 'candidate_pending_human_validation' })] });
    expect(r.approved_hints).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain('ignoré');
  });

  // ── SS-AH2 : candidate rejected → ignoré ─────────────────────────────────
  test('SS-AH2 — human_rejected → skipped', () => {
    const r = loadApprovedHints({ candidates: [makeHint({ status: 'human_rejected' })] });
    expect(r.approved_hints).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain('ignoré');
  });

  // ── SS-AH3 : status active → interdit/ignoré ─────────────────────────────
  test('SS-AH3 — status=active → interdit/ignoré', () => {
    const r = loadApprovedHints({ candidates: [makeHint({ status: 'active' })] });
    expect(r.approved_hints).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain('interdit');
  });

  // ── SS-AH4 : status applied → interdit/ignoré ────────────────────────────
  test('SS-AH4 — status=applied → interdit/ignoré', () => {
    const r = loadApprovedHints({ candidates: [makeHint({ status: 'applied' })] });
    expect(r.approved_hints).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain('interdit');
  });

  // ── SS-AH5 : human_approved_for_shadow → chargé ──────────────────────────
  test('SS-AH5 — human_approved_for_shadow + shadow_only → approuvé', () => {
    const r = loadApprovedHints({ candidates: [makeHint()] });
    expect(r.approved_hints).toHaveLength(1);
    expect(r.totals.approved).toBe(1);
  });

  // ── SS-AH6 : safety != shadow_only → ignoré ──────────────────────────────
  test('SS-AH6 — safety != shadow_only → skipped', () => {
    const r = loadApprovedHints({ candidates: [makeHint({ safety: 'prod_active' })] });
    expect(r.approved_hints).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain('shadow_only');
  });

  // ── SS-AH7 : human_validation_required=false → ignoré ────────────────────
  test('SS-AH7 — human_validation_required=false → skipped', () => {
    const r = loadApprovedHints({ candidates: [makeHint({ human_validation_required: false })] });
    expect(r.approved_hints).toHaveLength(0);
    expect(r.skipped[0]!.reason).toContain('human_validation_required');
  });

  // ── SS-AH8 : action interdite → ignoré ───────────────────────────────────
  test('SS-AH8 — action interdite dans proposed_effect → skipped', () => {
    const forbiddenActions = ['auto_notify', 'boost_score', 'change_threshold', 'change_weight', 'apply_to_prod', 'activate'];
    forbiddenActions.forEach((fa) => {
      const hint = makeHint();
      hint.proposed_effect = { action: fa, scope: 'client_signal_context', applies_to: { client_key: 'c', signal_key: 's' } };
      const r = loadApprovedHints({ candidates: [hint] });
      expect(r.approved_hints).toHaveLength(0);
    });
  });

  // ── SS-AH9 : type A — block_auto_and_send_to_review ──────────────────────
  test('SS-AH9 — block_auto_and_send_to_review force review, bloque auto', () => {
    const hints = loadApprovedHints({ candidates: [makeHint({ proposed_effect: {
      action: 'block_auto_and_send_to_review', scope: 'client_signal_context',
      applies_to: { client_key: 'Client ABC', signal_key: 'nettoyage', context_key: 'ctx_medical' },
    }})] }).approved_hints;
    const entry = makeEntry({ auto_notify_candidate: true });
    const result = applyHintsToEntry(entry, hints);
    expect(result.auto_notify_candidate).toBe(false);
    expect(result.review_candidate).toBe(true);
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.review_reason_hint_action).toBe('block_auto_and_send_to_review');
  });

  // ── SS-AH10 : type B — send_to_review ────────────────────────────────────
  test('SS-AH10 — send_to_review force review, pas d\'auto', () => {
    const hints = loadApprovedHints({ candidates: [makeHint({
      proposed_effect: {
        action: 'send_to_review', scope: 'client_signal',
        applies_to: { client_key: 'Client ABC', signal_key: 'nettoyage' },
      },
    })] }).approved_hints;
    const entry = makeEntry({ auto_notify_candidate: true, review_candidate: false });
    const result = applyHintsToEntry(entry, hints);
    expect(result.auto_notify_candidate).toBe(false);
    expect(result.review_candidate).toBe(true);
    expect(result.review_reason_hint_applied).toBe(true);
  });

  // ── SS-AH11 : type C — keep_review_candidate_only ────────────────────────
  test('SS-AH11 — keep_review_candidate_only ne booste pas, ne force pas auto', () => {
    const hints = loadApprovedHints({ candidates: [makeHint({
      proposed_effect: {
        action: 'keep_review_candidate_only', scope: 'client_signal_context',
        applies_to: { client_key: 'Client ABC', signal_key: 'nettoyage', context_key: 'ctx_medical' },
      },
    })] }).approved_hints;
    const entry = makeEntry({ auto_notify_candidate: true, review_candidate: true });
    const result = applyHintsToEntry(entry, hints);
    expect(result.auto_notify_candidate).toBe(false);
    // review_candidate inchangé (keep = garder, pas transformer clean → review)
    expect(result.clean_score).toBe(entry.clean_score); // score brut intact
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.review_reason_hint_action).toBe('keep_review_candidate_only');
  });

  // ── SS-AH12 : type D — observe_only ──────────────────────────────────────
  test('SS-AH12 — observe_only ne modifie pas les buckets', () => {
    const hints = loadApprovedHints({ candidates: [makeHint({
      proposed_effect: {
        action: 'observe_only', scope: 'client_signal_context',
        applies_to: { client_key: 'Client ABC', signal_key: 'nettoyage', context_key: 'ctx_medical' },
      },
    })] }).approved_hints;
    const entry = makeEntry({ auto_notify_candidate: false, review_candidate: true });
    const result = applyHintsToEntry(entry, hints);
    // observe_only : aucun changement de bucket
    expect(result.auto_notify_candidate).toBe(entry.auto_notify_candidate);
    expect(result.review_candidate).toBe(entry.review_candidate);
    // Mais la trace est bien là
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.review_reason_hint_action).toBe('observe_only');
  });

  // ── SS-AH13 : client mismatch → pas d'application ────────────────────────
  test('SS-AH13 — client mismatch → hint non appliqué', () => {
    const hints = loadApprovedHints({ candidates: [makeHint()] }).approved_hints;
    const entry = makeEntry({ client: 'Autre Client' });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBeFalsy();
  });

  // ── SS-AH14 : signal mismatch → pas d'application ────────────────────────
  test('SS-AH14 — signal mismatch → hint non appliqué', () => {
    const hints = loadApprovedHints({ candidates: [makeHint()] }).approved_hints;
    const entry = makeEntry({ matched_signals: ['plomberie', 'chauffage'] });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBeFalsy();
  });

  // ── SS-AH15 : contexte absent pour hint contextuel → pas d'application ───
  test('SS-AH15 — contexte absent pour hint client_signal_context → non appliqué', () => {
    const hints = loadApprovedHints({ candidates: [makeHint()] }).approved_hints;
    const entry = makeEntry({ ctx_context_key: undefined, context_key: undefined, ctx_learnable_context_hint: undefined });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBeFalsy();
  });

  // ── SS-AH16 : matched_signals en string avec virgules ────────────────────
  test('SS-AH16 — matched_signals string séparé par virgules', () => {
    const hints = loadApprovedHints({ candidates: [makeHint()] }).approved_hints;
    const entry = makeEntry({ matched_signals: 'nettoyage, hygiène, entretien' });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBe(true);
  });

  // ── SS-AH17 : matched_signals en tableau ─────────────────────────────────
  test('SS-AH17 — matched_signals tableau', () => {
    const hints = loadApprovedHints({ candidates: [makeHint()] }).approved_hints;
    const entry = makeEntry({ matched_signals: ['nettoyage', 'hygiène'] });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBe(true);
  });

  // ── SS-AH18 : pas de mutation de l'entrée source ─────────────────────────
  test('SS-AH18 — l\'entrée source n\'est pas mutée', () => {
    const hints = loadApprovedHints({ candidates: [makeHint()] }).approved_hints;
    const entry = makeEntry({ auto_notify_candidate: true });
    const originalAutoNotify = entry.auto_notify_candidate;
    const originalReview     = entry.review_candidate;
    const _ = applyHintsToEntry(entry, hints);
    // L'entrée originale reste intacte
    expect(entry.auto_notify_candidate).toBe(originalAutoNotify);
    expect(entry.review_candidate).toBe(originalReview);
    expect(entry.review_reason_hint_applied).toBeUndefined();
  });

  // ── SS-AH19 : plusieurs hints tracés dans review_reason_hint_ids ─────────
  test('SS-AH19 — plusieurs hints matchants → tracés dans hint_ids', () => {
    const hint1 = makeHint({ candidate_id: 'rrhc_001' });
    const hint2 = makeHint({
      candidate_id: 'rrhc_002',
      proposed_effect: {
        action: 'send_to_review', scope: 'client_signal',
        applies_to: { client_key: 'Client ABC', signal_key: 'nettoyage' },
      },
    });
    const hints = loadApprovedHints({ candidates: [hint1, hint2] }).approved_hints;
    const entry = makeEntry();
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_ids).toContain('rrhc_001');
    expect(result.review_reason_hint_ids).toContain('rrhc_002');
  });

  // ── SS-AH20 : 0 hints → retour copie identique ───────────────────────────
  test('SS-AH20 — 0 hints approved → retour copie entrée sans champs RRH', () => {
    const entry = makeEntry();
    const result = applyHintsToEntry(entry, []);
    expect(result.review_reason_hint_applied).toBeUndefined();
    expect(result.bc_id).toBe(entry.bc_id);
  });

  // ── SS-AH21 : score brut non modifié par A/B/C/D ─────────────────────────
  test('SS-AH21 — score brut non modifié par aucun type de hint', () => {
    const types = [
      'block_auto_and_send_to_review',
      'send_to_review',
      'keep_review_candidate_only',
      'observe_only',
    ];
    types.forEach((action) => {
      const scope = action === 'send_to_review' ? 'client_signal' : 'client_signal_context';
      const applyTo = action === 'send_to_review'
        ? { client_key: 'Client ABC', signal_key: 'nettoyage' }
        : { client_key: 'Client ABC', signal_key: 'nettoyage', context_key: 'ctx_medical' };
      const hints = loadApprovedHints({ candidates: [makeHint({ proposed_effect: { action, scope, applies_to: applyTo } })] }).approved_hints;
      const entry = makeEntry({ clean_score: 42 });
      const result = applyHintsToEntry(entry, hints);
      expect(result.clean_score).toBe(42);
    });
  });

  // ── SS-AH22 : totaux loadApprovedHints corrects ───────────────────────────
  test('SS-AH22 — totaux input/approved/skipped corrects', () => {
    const r = loadApprovedHints({ candidates: [
      makeHint(),
      makeHint({ candidate_id: 'rrhc_002', status: 'candidate_pending_human_validation' }),
      makeHint({ candidate_id: 'rrhc_003', status: 'human_rejected' }),
    ]});
    expect(r.totals.input).toBe(3);
    expect(r.totals.approved).toBe(1);
    expect(r.totals.skipped).toBe(2);
  });

  // ── SS-AH23 : matching via ctx_learnable_context_hint (label connu) ─────────
  // La résolution contextuelle B reconnaît un label connu par substring dans learnable_hint.
  // Seuls les labels de KNOWN_CONTEXT_LABELS sont reconnus (pas les labels arbitraires).
  test('SS-AH23 — context match via ctx_learnable_context_hint contenant un label connu', () => {
    const medHint = makeHint({
      context_key: 'medical_admin_context',
      proposed_effect: {
        action: 'block_auto_and_send_to_review',
        scope:  'client_signal_context',
        applies_to: { client_key: 'Client ABC', signal_key: 'nettoyage', context_key: 'medical_admin_context' },
      },
    });
    const hints = loadApprovedHints({ candidates: [medHint] }).approved_hints;
    const entry = makeEntry({
      ctx_context_key: undefined,
      context_key:     undefined,
      ctx_learnable_context_hint: 'medical_admin_context — score faible',
    });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBe(true);
  });

  // ── SS-AH24 : hint scope client_signal ignore le contexte ────────────────
  test('SS-AH24 — scope=client_signal, pas de contexte requis', () => {
    const hints = loadApprovedHints({ candidates: [makeHint({
      proposed_effect: {
        action: 'send_to_review', scope: 'client_signal',
        applies_to: { client_key: 'Client ABC', signal_key: 'nettoyage' },
      },
    })] }).approved_hints;
    // Pas de contexte dans l'entrée
    const entry = makeEntry({ ctx_context_key: undefined, context_key: undefined });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBe(true);
  });

  // ── SS-AH25 : pas de budget/prix/montant/estimation ──────────────────────
  test('SS-AH25 — aucune mention budget/prix/montant/estimation', () => {
    const forbidden = ['budget', 'prix', 'montant', 'estimation'];
    const hints = loadApprovedHints({ candidates: [makeHint()] }).approved_hints;
    const result = applyHintsToEntry(makeEntry(), hints);
    const json = JSON.stringify(result);
    forbidden.forEach((word) => {
      expect(json.toLowerCase()).not.toContain(word);
    });
  });

  // ── SS-AH26 : candidats approuvés depuis tableau brut (sans wrapper) ──────
  test('SS-AH26 — loadApprovedHints accepte un tableau brut de candidates', () => {
    const r = loadApprovedHints([makeHint()] as unknown as { candidates?: HintCandidate[] });
    expect(r.totals.approved).toBe(1);
  });

});


// ══════════════════════════════════════════════════════════════════════════════
//  RÉSOLUTION CONTEXTUELLE P9 (SS-AH27..35)
// ══════════════════════════════════════════════════════════════════════════════

describe('GD-039 apply-review-reason-hints-shadow — résolution contextuelle (SS-AH27..35)', () => {

  // Hint médical de référence (medical_admin_context)
  function makeMedicalHint(overrides: Partial<HintCandidate> = {}): HintCandidate {
    return {
      candidate_id: 'rrhc_medical_001',
      client_key:   'TEST PROD - Nettoyage Hygiène',
      signal_key:   'hygiène',
      context_key:  'medical_admin_context',
      proposed_effect: {
        action:     'block_auto_and_send_to_review',
        scope:      'client_signal_context',
        applies_to: {
          client_key:  'TEST PROD - Nettoyage Hygiène',
          signal_key:  'hygiène',
          context_key: 'medical_admin_context',
        },
      },
      safety:                    'shadow_only',
      status:                    'human_approved_for_shadow',
      human_validation_required: true,
      rationale:                 'Rejet répété dans contexte médical',
      ...overrides,
    };
  }

  function makeMedicalEntry(overrides: Partial<ShadowEntry> = {}): ShadowEntry {
    return {
      client:          'TEST PROD - Nettoyage Hygiène',
      bc_id:           'BC-MEDICAL-001',
      clean_score:     5,
      matched_signals: ['hygiène'],
      review_candidate: true,
      auto_notify_candidate: false,
      ...overrides,
    };
  }

  const medHints = () => loadApprovedHints({ candidates: [makeMedicalHint()] }).approved_hints;

  // SS-AH27 : ctx_context_key explicite = medical_admin_context → appliqué
  test('SS-AH27 — ctx_context_key explicite = medical_admin_context → hint appliqué', () => {
    const entry = makeMedicalEntry({ ctx_context_key: 'medical_admin_context' });
    const result = applyHintsToEntry(entry, medHints());
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.review_reason_hint_action).toBe('block_auto_and_send_to_review');
  });

  // SS-AH28 : ctx_context_key vide + ctx_learnable contient medical_admin_context → appliqué
  test('SS-AH28 — ctx_learnable_context_hint contient medical_admin_context → hint appliqué', () => {
    const entry = makeMedicalEntry({
      ctx_context_key: '',
      ctx_learnable_context_hint: 'Contexte détecté : medical_admin_context. Vérifier si ce contexte correspond au profil attendu.',
    });
    const result = applyHintsToEntry(entry, medHints());
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.review_reason_hint_action).toBe('block_auto_and_send_to_review');
  });

  // SS-AH29 : ctx_context_key vide + ctx_negative_context_terms médicaux → appliqué
  test('SS-AH29 — ctx_negative_context_terms [medico, materiel medico, medico technique] → hint appliqué', () => {
    const entry = makeMedicalEntry({
      ctx_context_key:            '',
      ctx_negative_context_terms: ['medico', 'materiel medico', 'medico technique'],
    });
    const result = applyHintsToEntry(entry, medHints());
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.review_reason_hint_ids).toContain('rrhc_medical_001');
  });

  // SS-AH30 : resolveContextKey → cleaning_disinfection ≠ medical_admin → pas appliqué
  test('SS-AH30 — contexte résolu = cleaning_disinfection_context ≠ medical_admin_context → pas appliqué', () => {
    const entry = makeMedicalEntry({
      ctx_context_key: '',
      ctx_learnable_context_hint: 'Contexte détecté : cleaning_disinfection_context.',
    });
    const result = applyHintsToEntry(entry, medHints());
    expect(result.review_reason_hint_applied).toBeUndefined();
  });

  // SS-AH31 : status = candidate_pending_human_validation → pas appliqué
  test('SS-AH31 — status=candidate_pending_human_validation → hint non appliqué', () => {
    const entry = makeMedicalEntry({ ctx_negative_context_terms: ['medico', 'dmsps'] });
    const hints = loadApprovedHints({ candidates: [makeMedicalHint({ status: 'candidate_pending_human_validation' })] }).approved_hints;
    expect(hints).toHaveLength(0);
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBeUndefined();
  });

  // SS-AH32 : safety != shadow_only → pas appliqué
  test('SS-AH32 — safety != shadow_only → hint non appliqué', () => {
    const entry = makeMedicalEntry({ ctx_negative_context_terms: ['medico'] });
    const hints = loadApprovedHints({ candidates: [makeMedicalHint({ safety: 'prod_active' })] }).approved_hints;
    expect(hints).toHaveLength(0);
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBeUndefined();
  });

  // SS-AH33 : human_validation_required = false → pas appliqué
  test('SS-AH33 — human_validation_required=false → hint non appliqué', () => {
    const entry = makeMedicalEntry({ ctx_negative_context_terms: ['medico'] });
    const hints = loadApprovedHints({ candidates: [makeMedicalHint({ human_validation_required: false })] }).approved_hints;
    expect(hints).toHaveLength(0);
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBeUndefined();
  });

  // SS-AH34 : signal hygiène != désinfection → pas appliqué

  // SS-AH34 : signal — signal ne correspond pas au hint
  test('SS-AH34 — signal entry=desinfection, hint=hygiene → pas appliqué', () => {
    const entry = makeMedicalEntry({
      matched_signals: ['desinfection'],
      ctx_negative_context_terms: ['medico'],
    });
    const result = applyHintsToEntry(entry, medHints());
    expect(result.review_reason_hint_applied).toBeUndefined();
  });

  // SS-AH35 : score non modifié
  test('SS-AH35 — score reste inchangé après application du hint', () => {
    const entry = makeMedicalEntry({
      clean_score: 5,
      ctx_negative_context_terms: ['medico', 'dmsps'],
    });
    const result = applyHintsToEntry(entry, medHints());
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.clean_score).toBe(5);
  });

  // -- AH-36..AH-40 : normalisation accent dans clientMatches (generique)

  // AH-36 : normClient strip accents et lowercase
  test('AH-36 - normClient strip accents et lowercase', () => {
    expect(normClient('CLIENT ÉCOLE TEST')).toBe('client ecole test');
    expect(normClient('client ecole test')).toBe('client ecole test');
    expect(normClient('CLIENT ÉCOLE TEST')).toBe(normClient('client ecole test'));
  });

  // AH-37 : normClient normalise espaces multiples
  test('AH-37 - normClient normalise espaces multiples', () => {
    expect(normClient('client  ecole  test')).toBe('client ecole test');
    expect(normClient('  CLIENT   ECOLE  TEST  ')).toBe('client ecole test');
  });

  // AH-38 : clients vraiment differents ne matchent pas
  test('AH-38 - normClient : clients differents restent differents', () => {
    expect(normClient('Client Alpha')).not.toBe(normClient('Client Beta'));
    expect(normClient('MAIRIE A')).not.toBe(normClient('MAIRIE B'));
  });

  // AH-39 : hint applique quand entry sans accent matche hint avec accent
  test('AH-39 - hint applique : entry sans accent matche hint avec accent', () => {
    const genericHint = makeHint({
      candidate_id: 'rrhc_generic_001',
      client_key:   'CLIENT ÉCOLE TEST',
      signal_key:   'signal_test',
      context_key:  'context_test',
      proposed_effect: {
        action:     'block_auto_and_send_to_review',
        scope:      'client_signal_context',
        applies_to: { client_key: 'CLIENT ÉCOLE TEST', signal_key: 'signal_test', context_key: 'context_test' },
      },
    });
    const hints = loadApprovedHints({ candidates: [genericHint] }).approved_hints;
    expect(hints).toHaveLength(1);
    const entry = makeEntry({
      client:          'client ecole test',
      matched_signals: ['signal_test'],
      ctx_context_key: 'context_test',
    });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBe(true);
  });

  // AH-40 : score non modifie apres application hint via accent-matching
  test('AH-40 - score non modifie apres hint via accent-matching', () => {
    const genericHint = makeHint({
      candidate_id: 'rrhc_generic_002',
      client_key:   'CLIENT ÉCOLE TEST',
      signal_key:   'signal_test',
      context_key:  'context_test',
      proposed_effect: {
        action:     'block_auto_and_send_to_review',
        scope:      'client_signal_context',
        applies_to: { client_key: 'CLIENT ÉCOLE TEST', signal_key: 'signal_test', context_key: 'context_test' },
      },
    });
    const hints = loadApprovedHints({ candidates: [genericHint] }).approved_hints;
    const entry = makeEntry({
      client:          'client ecole test',
      matched_signals: ['signal_test'],
      ctx_context_key: 'context_test',
      clean_score:     9,
    });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.clean_score).toBe(9);
  });

  // -- AH-41..AH-47 : normalisation accent dans signalMatches (generique, GD-054)

  // AH-41 : normSignal strip accents et lowercase
  test('AH-41 - normSignal strip accents et lowercase', () => {
    expect(normSignal('SIGNAL ÉCOLE TEST')).toBe('signal ecole test');
    expect(normSignal('signal ecole test')).toBe('signal ecole test');
    expect(normSignal('SIGNAL ÉCOLE TEST')).toBe(normSignal('signal ecole test'));
  });

  // AH-42 : normSignal normalise espaces multiples
  test('AH-42 - normSignal normalise espaces multiples', () => {
    expect(normSignal('signal  ecole  test')).toBe('signal ecole test');
    expect(normSignal('  SIGNAL   ECOLE  TEST  ')).toBe('signal ecole test');
  });

  // AH-43 : signaux differents ne matchent pas
  test('AH-43 - normSignal : signaux differents restent differents', () => {
    expect(normSignal('signal alpha')).not.toBe(normSignal('signal beta'));
    expect(normSignal('nettoyage')).not.toBe(normSignal('desinfection'));
  });

  // AH-44 : hint applique quand signal entry sans accent matche hint avec accent
  test('AH-44 - hint applique : signal sans accent matche hint avec accent', () => {
    const h = makeHint({
      candidate_id: 'rrhc_sig_001',
      client_key:   'CLIENT ÉCOLE TEST',
      signal_key:   'SIGNAL ÉCOLE TEST',
      context_key:  'context_test',
      proposed_effect: {
        action:     'block_auto_and_send_to_review',
        scope:      'client_signal_context',
        applies_to: { client_key: 'CLIENT ÉCOLE TEST', signal_key: 'SIGNAL ÉCOLE TEST', context_key: 'context_test' },
      },
    });
    const hints = loadApprovedHints({ candidates: [h] }).approved_hints;
    expect(hints).toHaveLength(1);
    const entry = makeEntry({
      client:          'client ecole test',
      matched_signals: ['signal ecole test'],
      ctx_context_key: 'context_test',
    });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBe(true);
  });

  // AH-45 : hint non applique si contexte different
  test('AH-45 - hint non applique si contexte different', () => {
    const h = makeHint({
      candidate_id: 'rrhc_sig_002',
      client_key:   'CLIENT ÉCOLE TEST',
      signal_key:   'SIGNAL ÉCOLE TEST',
      context_key:  'context_test',
      proposed_effect: {
        action:     'block_auto_and_send_to_review',
        scope:      'client_signal_context',
        applies_to: { client_key: 'CLIENT ÉCOLE TEST', signal_key: 'SIGNAL ÉCOLE TEST', context_key: 'context_test' },
      },
    });
    const hints = loadApprovedHints({ candidates: [h] }).approved_hints;
    const entry = makeEntry({
      client:          'client ecole test',
      matched_signals: ['signal ecole test'],
      ctx_context_key: 'other_context',
    });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBeUndefined();
  });

  // AH-46 : score non modifie par hint via signal accent-matching
  test('AH-46 - score non modifie par hint via signal accent-matching', () => {
    const h = makeHint({
      candidate_id: 'rrhc_sig_003',
      client_key:   'CLIENT ÉCOLE TEST',
      signal_key:   'SIGNAL ÉCOLE TEST',
      context_key:  'context_test',
      proposed_effect: {
        action:     'block_auto_and_send_to_review',
        scope:      'client_signal_context',
        applies_to: { client_key: 'CLIENT ÉCOLE TEST', signal_key: 'SIGNAL ÉCOLE TEST', context_key: 'context_test' },
      },
    });
    const hints = loadApprovedHints({ candidates: [h] }).approved_hints;
    const entry = makeEntry({
      client:          'client ecole test',
      matched_signals: ['signal ecole test'],
      ctx_context_key: 'context_test',
      clean_score:     11,
    });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.clean_score).toBe(11);
  });

  // AH-47 : auto_notify_candidate jamais mis a true par hint
  test('AH-47 - auto_notify_candidate jamais true apres hint signal accent', () => {
    const h = makeHint({
      candidate_id: 'rrhc_sig_004',
      client_key:   'CLIENT ÉCOLE TEST',
      signal_key:   'SIGNAL ÉCOLE TEST',
      context_key:  'context_test',
      proposed_effect: {
        action:     'block_auto_and_send_to_review',
        scope:      'client_signal_context',
        applies_to: { client_key: 'CLIENT ÉCOLE TEST', signal_key: 'SIGNAL ÉCOLE TEST', context_key: 'context_test' },
      },
    });
    const hints = loadApprovedHints({ candidates: [h] }).approved_hints;
    const entry = makeEntry({
      client:          'client ecole test',
      matched_signals: ['signal ecole test'],
      ctx_context_key: 'context_test',
      auto_notify_candidate: false,
    });
    const result = applyHintsToEntry(entry, hints);
    expect(result.review_reason_hint_applied).toBe(true);
    expect(result.auto_notify_candidate).not.toBe(true);
  });

});
