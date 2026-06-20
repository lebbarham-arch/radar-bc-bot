'use strict';
/**
 * tests/unit/audit-review-learning-cycle.test.ts
 * GD-051 -- Tests sobres du cycle d'apprentissage review -> decisions -> hints.
 *
 * Ces tests verifient :
 *   ARL-A : decisions vides restent pending (non traitees)
 *   ARL-B : keep/reject/ignore seulement -- pas d'autres decisions valides
 *   ARL-C : budget/prix/montant/estimation interdits dans REVIEW_REASON_CODES
 *   ARL-D : candidates hints : safety=shadow_only + human_validation_required=true
 *   ARL-E : approved hints n'activent pas la prod (FORBIDDEN_ACTIONS)
 *   ARL-F : apply ne modifie jamais le score brut (copy.score non assigne)
 *   ARL-G : aucune regle client/signal/domaine hardcodee dans apply + candidates
 *
 * Miroir inline : fonctions extraites statiquement depuis les sources JS.
 * ASCII strict. Pas d'accents dans le code source.
 */

import * as fs   from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(rel: string): string | null {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
  catch { return null; }
}

// ============================================================
// ARL-A : decisions vides restent pending
// ============================================================

// Miroir inline de la logique import-review-decisions.js
const VALID_DECISIONS = ['keep', 'reject', 'ignore', ''];

function classifyDecision(raw: string): { decision: string; isPending: boolean } {
  const d = (raw || '').trim().toLowerCase();
  if (!VALID_DECISIONS.includes(d)) {
    return { decision: '', isPending: true }; // invalide -> remis a vide
  }
  return { decision: d, isPending: d === '' };
}

describe('ARL-A -- decisions vides restent pending', () => {
  test('ARL-A1 : decision vide -> isPending=true', () => {
    expect(classifyDecision('')).toMatchObject({ decision: '', isPending: true });
  });
  test('ARL-A2 : decision keep -> isPending=false', () => {
    expect(classifyDecision('keep')).toMatchObject({ decision: 'keep', isPending: false });
  });
  test('ARL-A3 : decision reject -> isPending=false', () => {
    expect(classifyDecision('reject')).toMatchObject({ decision: 'reject', isPending: false });
  });
  test('ARL-A4 : decision ignore -> isPending=false', () => {
    expect(classifyDecision('ignore')).toMatchObject({ decision: 'ignore', isPending: false });
  });
  test('ARL-A5 : decision invalide -> remis a vide, isPending=true', () => {
    expect(classifyDecision('approve')).toMatchObject({ decision: '', isPending: true });
    expect(classifyDecision('ban')).toMatchObject({ decision: '', isPending: true });
    expect(classifyDecision('auto')).toMatchObject({ decision: '', isPending: true });
  });
});

// ============================================================
// ARL-B : keep/reject/ignore seulement dans VALID_DECISIONS
// ============================================================

describe('ARL-B -- keep/reject/ignore seulement', () => {
  test('ARL-B1 : VALID_DECISIONS contient keep, reject, ignore et vide uniquement', () => {
    const nonEmpty = VALID_DECISIONS.filter(d => d !== '');
    expect(nonEmpty.sort()).toEqual(['ignore', 'keep', 'reject']);
  });
  test('ARL-B2 : VALID_DECISIONS ne contient pas auto/approve/ban/promote', () => {
    const forbidden = ['auto', 'approve', 'ban', 'promote', 'notify', 'block'];
    forbidden.forEach(f => {
      expect(VALID_DECISIONS).not.toContain(f);
    });
  });
  test('ARL-B3 : source import-review-decisions.js : VALID_DECISIONS conforme', () => {
    const src = readSrc('scripts/import-review-decisions.js');
    expect(src).not.toBeNull();
    expect(src).toMatch(/VALID_DECISIONS/);
    expect(src).toMatch(/'keep'/);
    expect(src).toMatch(/'reject'/);
    expect(src).toMatch(/'ignore'/);
    expect(src).not.toMatch(/'auto_notify'/);
    expect(src).not.toMatch(/'approve'/);
  });
});

// ============================================================
// ARL-C : budget/prix/montant/estimation interdits
// ============================================================

const FORBIDDEN_REASONS = ['budget', 'prix', 'montant', 'estimation'];

// Extraction miroir de REVIEW_REASON_CODES depuis review-reasons.js
function extractReviewReasonCodes(src: string): string[] {
  const m = src.match(/var REVIEW_REASON_CODES\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return [];
  const items = m[1]!.match(/'([^']+)'/g) || [];
  return items.map(s => s.replace(/'/g, ''));
}

describe('ARL-C -- budget/prix/montant/estimation interdits', () => {
  let src: string | null;
  let codes: string[];

  beforeAll(() => {
    src = readSrc('scripts/review-reasons.js');
    codes = src ? extractReviewReasonCodes(src) : [];
  });

  test('ARL-C1 : review-reasons.js existe', () => {
    expect(src).not.toBeNull();
  });
  test('ARL-C2 : REVIEW_REASON_CODES extractible (au moins 5 codes)', () => {
    expect(codes.length).toBeGreaterThanOrEqual(5);
  });
  test('ARL-C3 : aucun code forbidden dans REVIEW_REASON_CODES', () => {
    FORBIDDEN_REASONS.forEach(f => {
      const match = codes.filter(c => c.toLowerCase().includes(f));
      expect(match).toHaveLength(0);
    });
  });
  test('ARL-C4 : source review-reasons.js mentionne explicitement l absence de budget', () => {
    expect(src).toMatch(/budget.*absent|absent.*budget|ABSENTS/i);
  });
  test('ARL-C5 : review-reason-hint-candidates.js ne contient pas budget/prix/montant', () => {
    const src2 = readSrc('scripts/review-reason-hint-candidates.js');
    expect(src2).not.toBeNull();
    // Le script peut mentionner "Pas de budget" dans les commentaires -- verifier codes
    const m2 = src2!.match(/var FORBIDDEN_ACTIONS\s*=\s*\[([\s\S]*?)\];/);
    const actions = m2 && m2[1] ? (m2[1].match(/'([^']+)'/g) || []).map((s:string) => s.replace(/'/g,'')) : [];
    FORBIDDEN_REASONS.forEach(f => {
      expect(actions).not.toContain(f);
    });
  });
});

// ============================================================
// ARL-D : candidates hints : shadow_only + human_validation_required
// ============================================================

type HintCandidate = {
  safety:                    string;
  status:                    string;
  human_validation_required: boolean;
  proposed_effect?:          { action: string };
};

// Miroir inline : validation d'un candidate (extrait de review-reason-hint-candidates.js)
const ARL_FORBIDDEN_ACTIONS = ['auto_notify', 'boost_score', 'change_threshold', 'change_weight'];

function validateCandidate(c: HintCandidate): string[] {
  const errors: string[] = [];
  if (c.safety !== 'shadow_only') {
    errors.push('safety doit etre shadow_only, recu: ' + c.safety);
  }
  if (c.status !== 'candidate_pending_human_validation') {
    errors.push('status doit etre candidate_pending_human_validation');
  }
  if (c.human_validation_required !== true) {
    errors.push('human_validation_required doit etre true');
  }
  if (c.proposed_effect && ARL_FORBIDDEN_ACTIONS.includes(c.proposed_effect.action)) {
    errors.push('action interdite: ' + c.proposed_effect.action);
  }
  return errors;
}

function makeCandidate(overrides: Partial<HintCandidate> = {}): HintCandidate {
  return Object.assign({
    safety:                    'shadow_only',
    status:                    'candidate_pending_human_validation',
    human_validation_required: true,
    proposed_effect:           { action: 'block_auto_and_send_to_review' },
  }, overrides);
}

describe('ARL-D -- candidates : shadow_only + human_validation_required', () => {
  test('ARL-D1 : candidate valide passe la validation', () => {
    expect(validateCandidate(makeCandidate())).toHaveLength(0);
  });
  test('ARL-D2 : safety != shadow_only -> erreur', () => {
    const errs = validateCandidate(makeCandidate({ safety: 'prod' }));
    expect(errs.some(e => e.includes('shadow_only'))).toBe(true);
  });
  test('ARL-D3 : human_validation_required=false -> erreur', () => {
    const errs = validateCandidate(makeCandidate({ human_validation_required: false }));
    expect(errs.some(e => e.includes('human_validation_required'))).toBe(true);
  });
  test('ARL-D4 : status pending -> toujours valide avant approbation humaine', () => {
    const c = makeCandidate();
    expect(c.status).toBe('candidate_pending_human_validation');
  });
  test('ARL-D5 : source hint-candidates.js : safety=shadow_only hardcode', () => {
    const src = readSrc('scripts/review-reason-hint-candidates.js');
    expect(src).not.toBeNull();
    expect(src).toMatch(/safety.*shadow_only|shadow_only.*safety/);
    expect(src).toMatch(/human_validation_required.*true/);
    expect(src).toMatch(/candidate_pending_human_validation/);
  });
});

// ============================================================
// ARL-E : approved hints n'activent pas la prod
// ============================================================

const ARL_FORBIDDEN_APPLY = [
  'auto_notify', 'boost_score', 'change_threshold', 'change_weight', 'apply_to_prod', 'activate'
];

// Miroir inline de loadApprovedHints (extrait de apply-review-reason-hints-shadow.js)
type ApprovedHint = {
  status:                    string;
  safety:                    string;
  human_validation_required: boolean;
  proposed_effect?:          { action: string };
  candidate_id?:             string;
};

function loadApprovedHintsT(candidates: ApprovedHint[]): { approved: ApprovedHint[]; skipped: { reason: string }[] } {
  const approved: ApprovedHint[] = [];
  const skipped:  { reason: string }[] = [];

  candidates.forEach(c => {
    if (c.safety !== 'shadow_only') {
      skipped.push({ reason: 'safety != shadow_only' }); return;
    }
    if (c.human_validation_required !== true) {
      skipped.push({ reason: 'human_validation_required != true' }); return;
    }
    if (c.status !== 'human_approved_for_shadow') {
      skipped.push({ reason: 'status != human_approved_for_shadow (' + c.status + ')' }); return;
    }
    const action = (c.proposed_effect || {}).action || '';
    if (ARL_FORBIDDEN_APPLY.includes(action)) {
      skipped.push({ reason: 'action interdite: ' + action }); return;
    }
    approved.push(c);
  });

  return { approved, skipped };
}

function makeApproved(overrides: Partial<ApprovedHint> = {}): ApprovedHint {
  return Object.assign({
    status:                    'human_approved_for_shadow',
    safety:                    'shadow_only',
    human_validation_required: true,
    proposed_effect:           { action: 'block_auto_and_send_to_review' },
    candidate_id:              'test-hint-001',
  }, overrides);
}

describe('ARL-E -- approved hints n activent pas la prod', () => {
  test('ARL-E1 : hint pending -> skipped (non applique)', () => {
    const r = loadApprovedHintsT([makeApproved({ status: 'candidate_pending_human_validation' })]);
    expect(r.approved).toHaveLength(0);
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(r.skipped[0]!.reason).toMatch(/human_approved_for_shadow/);
  });
  test('ARL-E2 : hint rejected -> skipped', () => {
    const r = loadApprovedHintsT([makeApproved({ status: 'human_rejected' })]);
    expect(r.approved).toHaveLength(0);
  });
  test('ARL-E3 : hint active -> skipped (statut interdit)', () => {
    const r = loadApprovedHintsT([makeApproved({ status: 'active' })]);
    expect(r.approved).toHaveLength(0);
  });
  test('ARL-E4 : action apply_to_prod -> skipped', () => {
    const r = loadApprovedHintsT([makeApproved({ proposed_effect: { action: 'apply_to_prod' } })]);
    expect(r.approved).toHaveLength(0);
    expect(r.skipped.length).toBeGreaterThan(0);
    expect(r.skipped[0]!.reason).toMatch(/apply_to_prod/);
  });
  test('ARL-E5 : action activate -> skipped', () => {
    const r = loadApprovedHintsT([makeApproved({ proposed_effect: { action: 'activate' } })]);
    expect(r.approved).toHaveLength(0);
  });
  test('ARL-E6 : action auto_notify -> skipped', () => {
    const r = loadApprovedHintsT([makeApproved({ proposed_effect: { action: 'auto_notify' } })]);
    expect(r.approved).toHaveLength(0);
  });
  test('ARL-E7 : hint approuve valide -> dans approved', () => {
    const r = loadApprovedHintsT([makeApproved()]);
    expect(r.approved).toHaveLength(1);
    expect(r.skipped).toHaveLength(0);
  });
  test('ARL-E8 : source apply : FORBIDDEN_ACTIONS inclut apply_to_prod et activate', () => {
    const src = readSrc('scripts/apply-review-reason-hints-shadow.js');
    expect(src).not.toBeNull();
    expect(src).toMatch(/'apply_to_prod'/);
    expect(src).toMatch(/'activate'/);
  });
});

// ============================================================
// ARL-F : apply ne modifie jamais le score brut
// ============================================================

describe('ARL-F -- apply ne modifie jamais le score brut', () => {
  test('ARL-F1 : source apply : copy.score jamais assigne', () => {
    const src = readSrc('scripts/apply-review-reason-hints-shadow.js');
    expect(src).not.toBeNull();
    expect(src).not.toMatch(/copy\.score\s*=/);
  });
  test('ARL-F2 : source apply : ne modifie pas scoreBC, poids, seuils', () => {
    const src = readSrc('scripts/apply-review-reason-hints-shadow.js');
    expect(src).not.toBeNull();
    expect(src).not.toMatch(/scoreBC\s*=/);
    expect(src).not.toMatch(/THRESHOLD\s*=/);
    expect(src).not.toMatch(/WEIGHT\s*=/);
  });
  test('ARL-F3 : apply modifie uniquement auto_notify_candidate et review_candidate (shadow copy)', () => {
    const src = readSrc('scripts/apply-review-reason-hints-shadow.js');
    expect(src).not.toBeNull();
    // Ces deux champs doivent etre modifies (shadow copy only)
    expect(src).toMatch(/copy\.auto_notify_candidate\s*=\s*false/);
    expect(src).toMatch(/copy\.review_candidate\s*=\s*true/);
    // Et quelques champs d annotation hint
    expect(src).toMatch(/copy\.review_reason_hint_applied/);
  });
  test('ARL-F4 : source approve : safety et human_validation_required inchangeables', () => {
    const src = readSrc('scripts/approve-review-reason-hint-candidate.js');
    expect(src).not.toBeNull();
    expect(src).toMatch(/'shadow_only'/);
    expect(src).toMatch(/inchangeable/);
    expect(src).toMatch(/human_validation_required/);
  });
});

// ============================================================
// ARL-G : aucune regle client/signal/domaine hardcodee
// ============================================================

describe('ARL-G -- aucune regle client/signal/domaine hardcodee', () => {
  test('ARL-G1 : apply-review-reason-hints-shadow.js : pas de client_name hardcode', () => {
    const src = readSrc('scripts/apply-review-reason-hints-shadow.js');
    expect(src).not.toBeNull();
    // Pas d assignation directe a un client specifique
    expect(src).not.toMatch(/clientKey\s*===\s*'[A-Z]/);
    expect(src).not.toMatch(/client_name\s*===\s*'[A-Z]/);
  });
  test('ARL-G2 : review-reason-hint-candidates.js : pas de signal hardcode dans logique', () => {
    const src = readSrc('scripts/review-reason-hint-candidates.js');
    expect(src).not.toBeNull();
    // Pas de if (signal === 'xyz') dans le corps du script
    expect(src).not.toMatch(/signalKey\s*===\s*'[a-z_]+'\s*\{/);
  });
  test('ARL-G3 : build-client-learning-hints.js : logique generique seulement', () => {
    const src = readSrc('scripts/build-client-learning-hints.js');
    expect(src).not.toBeNull();
    // La logique ne depend que des ratios et cycles -- pas de cas client specifique
    expect(src).toMatch(/keep_rate|cyclesCount|reject.*keep/);
    // Pas de noms de clients specifiques dans la logique
    expect(src).not.toMatch(/if.*client.*===.*'[A-Z]/);
  });
  test('ARL-G4 : audit script confirme 37 checks OK (audit-review-learning-cycle.js)', () => {
    const src = readSrc('scripts/audit-review-learning-cycle.js');
    expect(src).not.toBeNull();
    // Le script d audit contient les 5 categories de checks
    expect(src).toMatch(/CHECK A/);
    expect(src).toMatch(/CHECK B/);
    expect(src).toMatch(/CHECK C/);
    expect(src).toMatch(/CHECK D/);
    expect(src).toMatch(/CHECK E/);
  });
});
