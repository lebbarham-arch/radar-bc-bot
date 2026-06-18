/**
 * tests/unit/contextual-review-insights.test.ts — GD-035
 *
 * Tests unitaires du module contextual-review-insights.js (rule-based-context-v1).
 * SS-CTX1..SS-CTX9 — miroir pur, aucun import FS, aucun appel réseau.
 *
 * Règles :
 *  - Aucune règle spécifique à un signal ou à un client.
 *  - L'analyse ne modifie jamais auto_notify_candidate / review_candidate.
 *  - Jamais "toujours rejeter" ou "toujours accepter" dans un hint.
 *  - should_create_context_hint=false si pas de décision humaine.
 */

// ─── Miroir de la logique contextual-review-insights.js ─────────────────────

const CONTEXT_MODEL_T = 'rule-based-context-v1';

// Familles génériques (sous-ensemble représentatif pour les tests)
const FAMILIES_T = [
  {
    key: 'food_or_beverage',
    label: 'food_or_beverage_context',
    terms: ['cafe', 'cafes', 'boisson', 'boissons', 'denree', 'restauration',
            'alimentaire', 'alimentation', 'epicerie', 'traiteur'],
  },
  {
    key: 'medical_admin',
    label: 'medical_admin_context',
    terms: ['medical', 'medicament', 'hopital', 'soins', 'clinique', 'pharmacie',
            'chp', 'chu', 'dms', 'dmsps', 'medico', 'sanitaire'],
  },
  {
    key: 'cleaning_disinfection',
    label: 'cleaning_disinfection_context',
    terms: ['nettoyage', 'desinfection', 'insecticide', 'detergent', 'savon',
            'desinfectant', 'deratisation', 'nettoyant', 'proprete', 'nettoiement'],
  },
  {
    key: 'office_supplies',
    label: 'office_supplies_context',
    terms: ['fourniture', 'papier', 'stylo', 'cartouche', 'encre', 'imprimante', 'toner'],
  },
  {
    key: 'it',
    label: 'it_context',
    terms: ['logiciel', 'serveur', 'informatique', 'reseau', 'cloud', 'ordinateur', 'licence'],
  },
  {
    key: 'event',
    label: 'event_context',
    terms: ['manifestation', 'ceremonie', 'seminaire', 'colloque', 'gala', 'banquet'],
  },
  {
    key: 'construction_or_works',
    label: 'construction_or_works_context',
    terms: ['travaux', 'construction', 'batiment', 'peinture', 'renovation', 'terrassement'],
  },
];

interface ClientProfile {
  client_name?:      string;
  business_profile?: string;
  technical_profile?: string;
}

interface ReviewEntry {
  clean_text_excerpt?: string;
  matched_signals?:    string[];
  hint_block_auto?:    boolean;
  hint_applied?:       string;
  hint_score_adj?:     number;
  weak_single_signal?: boolean;
  exclusion_hit?:      boolean;
  auto_notify_candidate?: boolean;
  review_candidate?:      boolean;
}

interface ContextResult {
  context_model:              string;
  context_generated_at:       string;
  profile_alignment:          string;
  decision_interpretation:    string;
  why_it_matched:             string;
  why_it_may_be_wrong:        string;
  rejection_context_reason:   string;
  acceptance_context_reason:  string;
  positive_context_terms:     string[];
  negative_context_terms:     string[];
  context_ambiguity:          string;
  context_confidence:         string;
  learnable_context_hint:     string;
  should_create_context_hint: boolean;
}

function normTextT(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectFamiliesT(text: string): Record<string, string[]> {
  const norm = normTextT(text);
  const result: Record<string, string[]> = {};
  FAMILIES_T.forEach(fam => {
    const found: string[] = [];
    fam.terms.forEach(term => {
      const nt = normTextT(term);
      if (!nt) return;
      if (nt.length >= 5) {
        if (norm.indexOf(nt) !== -1) found.push(term);
      } else {
        const re = new RegExp('(^|\\s)' + nt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)');
        if (re.test(norm)) found.push(term);
      }
    });
    if (found.length > 0) result[fam.key] = found;
  });
  return result;
}

function detectProfileT(profile: ClientProfile | null | undefined): Record<string, string[]> {
  if (!profile) return {};
  const txt = [profile.client_name || '', profile.business_profile || '', profile.technical_profile || ''].join(' ');
  return detectFamiliesT(txt);
}

function alignmentT(bcFams: Record<string, string[]>, profFams: Record<string, string[]>): string {
  const bcK   = Object.keys(bcFams);
  const profK = Object.keys(profFams);
  if (profK.length === 0 || bcK.length === 0) return 'unclear';
  const overlap = bcK.filter(k => profK.indexOf(k) !== -1);
  if (overlap.length === 0)                           return 'low';
  if (overlap.length >= Math.ceil(bcK.length * 0.5)) return 'high';
  return 'medium';
}

function ambiguityT(bcFams: Record<string, string[]>): string {
  const n = Object.keys(bcFams).length;
  if (n === 1) return 'low';
  if (n === 2) return 'medium';
  return 'high';
}

function shouldCreateT(
  decision: string,
  alignment: string,
  ambiguity: string,
  hintBlock: boolean,
  posTerms: string[],
  negTerms: string[]
): boolean {
  const dec = (decision || '').toLowerCase().trim();
  if (!dec)                          return false;
  if (hintBlock && !dec)             return false;
  if (dec === 'ignore')              return false;
  if (ambiguity === 'high')          return false;
  if (alignment === 'unclear')       return false;
  if (dec === 'reject') return negTerms.length >= 1 && (alignment === 'low' || alignment === 'medium');
  if (dec === 'keep')   return posTerms.length >= 1 && (alignment === 'high' || alignment === 'medium');
  return false;
}

function analyzeReviewContextT(
  entry: ReviewEntry,
  profile: ClientProfile | null | undefined,
  decision: string,
  opts?: { generatedAt?: string }
): ContextResult {
  const genAt   = (opts || {}).generatedAt || new Date().toISOString();
  const dec     = (decision || '').toLowerCase().trim();
  const excerpt = entry.clean_text_excerpt || '';
  const sigs    = (entry.matched_signals || []).filter((s: string) => s.indexOf('bloque(') === -1);
  const bcText  = excerpt + ' ' + sigs.join(' ');

  const hintBlock     = !!entry.hint_block_auto;
  const bcFams        = detectFamiliesT(bcText);
  const profFams      = detectProfileT(profile);
  const posTerms: string[] = [];
  const negTerms: string[] = [];

  if (Object.keys(profFams).length > 0) {
    Object.keys(bcFams).forEach(fk => {
      if (profFams[fk]) posTerms.push(...(bcFams[fk] as string[]));
      else              negTerms.push(...(bcFams[fk] as string[]));
    });
  }

  const alignment  = alignmentT(bcFams, profFams);
  const ambiguity  = ambiguityT(bcFams);
  const confidence = (ambiguity === 'high' || alignment === 'unclear' || !dec) ? 'low' : 'medium';

  let decInterp: string;
  if (!dec)             decInterp = 'needs_review';
  else if (dec === 'keep')   decInterp = 'accepted_context';
  else if (dec === 'reject') decInterp = 'rejected_context';
  else if (dec === 'ignore') decInterp = 'ignored_context';
  else                  decInterp = 'needs_review';

  const detectedLabels = FAMILIES_T.filter(f => bcFams[f.key]).map(f => f.label);

  let whyMatched: string;
  if (sigs.length > 0 && posTerms.length > 0) {
    whyMatched = 'Signal(s) (' + sigs.join(', ') + ') dans un contexte aligné avec le profil (' + posTerms.slice(0, 3).join(', ') + ').';
  } else if (sigs.length > 0 && detectedLabels.length > 0) {
    whyMatched = 'Signal(s) détecté(s) : ' + sigs.join(', ') + '. Contexte identifié : ' + detectedLabels.join(', ') + '.';
  } else {
    whyMatched = sigs.length > 0
      ? 'Signal(s) détecté(s) : ' + sigs.join(', ') + '. Contexte métier non clairement identifié.'
      : 'Correspondance sans signal thématique identifiable.';
  }

  let whyWrong: string;
  if (negTerms.length > 0) {
    whyWrong = 'Contexte potentiellement hors profil : termes détectés (' + negTerms.slice(0, 3).join(', ') + ').';
  } else if (hintBlock) {
    whyWrong = "Hint client actif bloquant l'auto-notification.";
  } else if (ambiguity === 'high') {
    whyWrong = 'Contexte ambigu ou non identifiable.';
  } else {
    whyWrong = "Aucun indicateur fort de faux positif détecté.";
  }

  const profLabels = FAMILIES_T.filter(f => profFams[f.key]).map(f => f.label);

  let learnableHint: string;
  if (!dec) {
    learnableHint = detectedLabels.length > 0
      ? 'Contexte détecté : ' + detectedLabels.join(', ') + '. Vérifier si ce contexte correspond au profil attendu avant de décider. Un historique de décisions permettra de formuler un hint contextuel plus précis.'
      : 'Aucun contexte métier clairement identifié. Revue manuelle recommandée.';
  } else if (dec === 'reject') {
    const neg = negTerms.length > 0 ? ' (ex : ' + negTerms.slice(0, 3).join(', ') + ')' : '';
    const pl  = profLabels.length  > 0 ? ' — profil principal : ' + profLabels.join(', ') : '';
    learnableHint = 'Dégrader ce signal quand le contexte contient des termes hors profil' + neg + pl + '. Vérifier la nature du BC avant toute généralisation : ce signal peut rester pertinent dans un contexte différent.';
  } else if (dec === 'keep') {
    const pos = posTerms.length > 0 ? ' (ex : ' + posTerms.slice(0, 3).join(', ') + ')' : '';
    const plk = profLabels.length > 0 ? ' correspondant au profil ' + profLabels.join(', ') : '';
    learnableHint = 'Renforcer ce signal quand il apparaît avec des termes contextuels pertinents' + pos + plk + '. Ce contexte confirme l\'adéquation avec le profil client.';
  } else {
    learnableHint = 'BC ignoré : contexte hors scope ou signal trop faible. Ne pas généraliser.';
  }

  const shouldCreate = shouldCreateT(decision, alignment, ambiguity, hintBlock, posTerms, negTerms);
  const rejReason    = negTerms.length > 0 && alignment === 'low'
    ? 'Contexte à dominante ' + detectedLabels.join('/') + ' — en dehors du profil principal.'
    : '';
  const accReason    = posTerms.length > 0 && (alignment === 'high' || alignment === 'medium')
    ? 'Contexte aligné avec le profil client (' + posTerms.slice(0, 3).join(', ') + ').'
    : '';

  return {
    context_model:              CONTEXT_MODEL_T,
    context_generated_at:       genAt,
    profile_alignment:          alignment,
    decision_interpretation:    decInterp,
    why_it_matched:             whyMatched,
    why_it_may_be_wrong:        whyWrong,
    rejection_context_reason:   rejReason,
    acceptance_context_reason:  accReason,
    positive_context_terms:     posTerms,
    negative_context_terms:     negTerms,
    context_ambiguity:          ambiguity,
    context_confidence:         confidence,
    learnable_context_hint:     learnableHint,
    should_create_context_hint: shouldCreate,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('contextual-review-insights — decision vide', () => {

  // SS-CTX1 : décision vide → needs_review, should_create=false
  test('SS-CTX1 — decision vide → decision_interpretation="needs_review", should_create=false', () => {
    const r = analyzeReviewContextT(
      { clean_text_excerpt: 'achat logiciel serveur', matched_signals: ['signal-x'] },
      { client_name: 'Client IT', business_profile: 'informatique' },
      ''
    );
    expect(r.decision_interpretation).toBe('needs_review');
    expect(r.should_create_context_hint).toBe(false);
    expect(r.context_model).toBe('rule-based-context-v1');
  });

  // SS-CTX2 : hint_block_auto=true + decision vide → reste needs_review, pas rejected
  test('SS-CTX2 — hint_block_auto=true + decision vide → needs_review, not rejected, should_create=false', () => {
    const r = analyzeReviewContextT(
      {
        clean_text_excerpt: 'achat produits desinfection nettoyage',
        matched_signals: ['signal-y'],
        hint_block_auto: true,
        hint_applied: 'signal-y:demote_to_review',
      },
      { client_name: 'Client nettoyage', business_profile: 'nettoyage' },
      undefined as unknown as string
    );
    expect(r.decision_interpretation).toBe('needs_review');
    expect(r.decision_interpretation).not.toBe('rejected_context');
    expect(r.should_create_context_hint).toBe(false);
  });

});

describe('contextual-review-insights — contexte food + profil nettoyage + reject', () => {

  // SS-CTX3 : contexte boisson/alimentaire + profil nettoyage + reject
  // → profile_alignment low, negative_context_terms non vide, should_create=true
  test('SS-CTX3 — food context + profil nettoyage + reject → alignment low, negTerms présents, should_create=true', () => {
    const r = analyzeReviewContextT(
      {
        clean_text_excerpt: 'fourniture cafe boissons restauration cantine',
        matched_signals: ['signal-z'],
      },
      { client_name: 'Client nettoyage entretien', business_profile: 'nettoyage' },
      'reject'
    );
    expect(r.profile_alignment).toBe('low');
    expect(r.negative_context_terms.length).toBeGreaterThan(0);
    expect(r.decision_interpretation).toBe('rejected_context');
    expect(r.should_create_context_hint).toBe(true);
    // Hint contextuel, pas global
    expect(r.learnable_context_hint.toLowerCase()).not.toMatch(/toujours rejeter/);
    expect(r.learnable_context_hint.toLowerCase()).not.toMatch(/toujours accepter/);
  });

  // SS-CTX3b : hint doit mentionner le contexte hors profil, pas le signal lui-même
  test('SS-CTX3b — hint de rejet est contextuel (non global)', () => {
    const r = analyzeReviewContextT(
      { clean_text_excerpt: 'achat cafe boissons traiteur', matched_signals: ['signal-abc'] },
      { client_name: 'Client nettoyage', business_profile: 'nettoyage' },
      'reject'
    );
    // Le hint ne doit pas généraliser sur le signal global
    expect(r.learnable_context_hint).not.toMatch(/toujours/);
    // Doit mentionner le contexte ou profil
    expect(r.learnable_context_hint.length).toBeGreaterThan(20);
  });

});

describe('contextual-review-insights — contexte nettoyage + profil nettoyage + keep', () => {

  // SS-CTX4 : contexte désinfection/nettoyage + profil nettoyage + keep
  // → profile_alignment medium/high, positive_context_terms, should_create=true
  test('SS-CTX4 — cleaning context + profil nettoyage + keep → alignment ≥ medium, posTerms présents, should_create=true', () => {
    const r = analyzeReviewContextT(
      {
        clean_text_excerpt: 'achat produits desinfection insecticide nettoyant proprete',
        matched_signals: ['signal-a', 'signal-b'],
      },
      { client_name: 'Societe nettoyage', business_profile: 'nettoyage desinfection' },
      'keep'
    );
    expect(['medium', 'high']).toContain(r.profile_alignment);
    expect(r.positive_context_terms.length).toBeGreaterThan(0);
    expect(r.decision_interpretation).toBe('accepted_context');
    expect(r.should_create_context_hint).toBe(true);
    expect(r.learnable_context_hint.toLowerCase()).not.toMatch(/toujours/);
  });

});

describe('contextual-review-insights — deux contextes différents pour le même signal', () => {

  // SS-CTX5 : même signal, deux excerpts différents → positive/negative terms diffèrent
  test('SS-CTX5 — même signal, contextes différents → termes et hints différents', () => {
    const profile = { client_name: 'Client nettoyage', business_profile: 'nettoyage' };

    const r1 = analyzeReviewContextT(
      { clean_text_excerpt: 'achat cafe boissons cantine', matched_signals: ['signal-x'] },
      profile, 'reject'
    );
    const r2 = analyzeReviewContextT(
      { clean_text_excerpt: 'achat insecticide desinfection nettoyant', matched_signals: ['signal-x'] },
      profile, 'keep'
    );

    // Les familles détectées diffèrent
    expect(r1.negative_context_terms.length).toBeGreaterThan(0);
    expect(r2.positive_context_terms.length).toBeGreaterThan(0);
    // Les hints diffèrent
    expect(r1.learnable_context_hint).not.toBe(r2.learnable_context_hint);
    // Les interprétations diffèrent
    expect(r1.decision_interpretation).toBe('rejected_context');
    expect(r2.decision_interpretation).toBe('accepted_context');
  });

});

describe('contextual-review-insights — contexte ambigu', () => {

  // SS-CTX6 : 3+ familles détectées → context_ambiguity high, should_create=false malgré reject
  test('SS-CTX6 — contexte trop mixte (3+ familles) → ambiguity high, should_create=false', () => {
    const r = analyzeReviewContextT(
      {
        // Food + IT + nettoyage + construction = 4 familles
        clean_text_excerpt: 'cafe logiciel serveur nettoyage travaux construction insecticide',
        matched_signals: ['signal-x'],
      },
      { client_name: 'Client nettoyage', business_profile: 'nettoyage' },
      'reject'
    );
    expect(r.context_ambiguity).toBe('high');
    expect(r.should_create_context_hint).toBe(false);
  });

});

describe('contextual-review-insights — clientProfile absent', () => {

  // SS-CTX7 : clientProfile null → profile_alignment="unclear", pas de crash
  test('SS-CTX7 — clientProfile null → profile_alignment="unclear", pas de crash', () => {
    expect(() => {
      const r = analyzeReviewContextT(
        { clean_text_excerpt: 'achat desinfection nettoyage', matched_signals: ['signal-a'] },
        null,
        'reject'
      );
      expect(r.profile_alignment).toBe('unclear');
      expect(r.positive_context_terms.length).toBe(0);
      expect(r.negative_context_terms.length).toBe(0);
      expect(r.should_create_context_hint).toBe(false);
    }).not.toThrow();
  });

  // SS-CTX7b : clientProfile undefined → même comportement
  test('SS-CTX7b — clientProfile undefined → profile_alignment="unclear", should_create=false', () => {
    const r = analyzeReviewContextT(
      { clean_text_excerpt: 'achat nettoyage', matched_signals: ['signal-b'] },
      undefined,
      'keep'
    );
    expect(r.profile_alignment).toBe('unclear');
    expect(r.should_create_context_hint).toBe(false);
  });

});

describe('contextual-review-insights — qualité du hint', () => {

  // SS-CTX8 : hint ne contient jamais "toujours rejeter" ou "toujours accepter"
  test('SS-CTX8 — hint est contextuel : jamais de règle globale', () => {
    const cases = [
      { text: 'cafe boissons restauration', profile: 'nettoyage', dec: 'reject' },
      { text: 'nettoyage insecticide desinfection', profile: 'nettoyage', dec: 'keep' },
      { text: 'logiciel serveur cloud', profile: 'informatique', dec: 'ignore' },
      { text: 'achat generique', profile: '', dec: '' },
    ];
    cases.forEach(c => {
      const r = analyzeReviewContextT(
        { clean_text_excerpt: c.text, matched_signals: ['signal-gen'] },
        c.profile ? { client_name: c.profile, business_profile: c.profile } : null,
        c.dec
      );
      expect(r.learnable_context_hint.toLowerCase()).not.toMatch(/toujours rejeter/);
      expect(r.learnable_context_hint.toLowerCase()).not.toMatch(/toujours accepter/);
    });
  });

  // SS-CTX8b : hint de rejet mentionne "différent" ou similaire (non globalisant)
  test('SS-CTX8b — hint de rejet mentionne prudence ou contexte différent', () => {
    const r = analyzeReviewContextT(
      { clean_text_excerpt: 'cafe boissons traiteur', matched_signals: ['signal-x'] },
      { client_name: 'nettoyage', business_profile: 'nettoyage' },
      'reject'
    );
    expect(r.learnable_context_hint.toLowerCase()).toMatch(/contexte|profil|different|prudence|generalisation/);
  });

});

describe('contextual-review-insights — invariants de candidature', () => {

  // SS-CTX9 : analyzeReviewContext ne modifie pas les champs de candidature
  test('SS-CTX9 — analyzeReviewContext ne modifie pas auto_notify_candidate ni review_candidate', () => {
    const entry: ReviewEntry = {
      clean_text_excerpt: 'achat cafe boissons',
      matched_signals: ['signal-a'],
      auto_notify_candidate: false,
      review_candidate: true,
    };
    const autoBefore   = entry.auto_notify_candidate;
    const reviewBefore = entry.review_candidate;

    analyzeReviewContextT(entry, { client_name: 'Client nettoyage', business_profile: 'nettoyage' }, 'reject');

    expect(entry.auto_notify_candidate).toBe(autoBefore);
    expect(entry.review_candidate).toBe(reviewBefore);
  });

});


// ═══════════════════════════════════════════════════════════════════════════════
// PATCH P5b — valueToSearchText + detectClientProfileFamilies enrichi
// SS-CTX-P1..SS-CTX-P6
// ═══════════════════════════════════════════════════════════════════════════════

// ── Miroir de valueToSearchText ───────────────────────────────────────────────
function valueToSearchTextT(value: unknown, depth?: number): string {
  if (depth === undefined) depth = 0;
  if (depth > 6) return '';
  if (value === null || value === undefined) return '';
  const t = typeof value;
  if (t === 'string')  return value as string;
  if (t === 'number' || t === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return (value as unknown[]).map(v => valueToSearchTextT(v, (depth as number) + 1)).join(' ');
  }
  if (t === 'object') {
    return Object.keys(value as object).map(k =>
      valueToSearchTextT((value as Record<string, unknown>)[k], (depth as number) + 1)
    ).join(' ');
  }
  return '';
}

// ── Miroir étendu de detectClientProfileFamilies ──────────────────────────────
function detectProfileExtT(profile: Record<string, unknown> | null | undefined): Record<string, string[]> {
  if (!profile) return {};
  const profileText = [
    valueToSearchTextT(profile['client_name']),
    valueToSearchTextT(profile['business_profile']),
    valueToSearchTextT(profile['technical_profile']),
    valueToSearchTextT(profile['criteres']),
    valueToSearchTextT(profile['ai_inclusions']),
    valueToSearchTextT(profile['exclusions']),
  ].join(' ');
  return detectFamiliesT(profileText);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('PATCH P5b — valueToSearchText (miroir)', () => {

  // SS-CTX-P1 : types primitifs
  test('SS-CTX-P1 — types primitifs : string, number, boolean, null, undefined → texte ou ""', () => {
    expect(valueToSearchTextT('nettoyage')).toBe('nettoyage');
    expect(valueToSearchTextT(42)).toBe('42');
    expect(valueToSearchTextT(true)).toBe('true');
    expect(valueToSearchTextT(null)).toBe('');
    expect(valueToSearchTextT(undefined)).toBe('');
  });

  // SS-CTX-P2 : array → éléments concaténés
  test('SS-CTX-P2 — array → éléments récursifs concaténés', () => {
    const result = valueToSearchTextT(['nettoyage', 'desinfection', 'insecticide']);
    expect(result).toContain('nettoyage');
    expect(result).toContain('desinfection');
    expect(result).toContain('insecticide');
    expect(result).not.toContain('[object Object]');
  });

  // SS-CTX-P3 : objet → valeurs concaténées, jamais "[object Object]"
  test('SS-CTX-P3 — objet → valeurs extraites, pas "[object Object]"', () => {
    const obj = { label: 'nettoyage', code: 'NET', score: 5 };
    const result = valueToSearchTextT(obj);
    expect(result).toContain('nettoyage');
    expect(result).not.toContain('[object Object]');
  });

  // SS-CTX-P4 : objet imbriqué → valeurs profondes lues
  test('SS-CTX-P4 — objet imbriqué → valeurs profondes accessibles', () => {
    const nested = { secteur: { detail: 'insecticide' }, type: 'nettoyage' };
    const result = valueToSearchTextT(nested);
    expect(result).toContain('insecticide');
    expect(result).toContain('nettoyage');
  });

  // SS-CTX-P4b : tableau d'objets
  test("SS-CTX-P4b — tableau d'objets → toutes les valeurs extraites", () => {
    const arr = [{ nom: 'nettoyage' }, { nom: 'desinfection' }];
    const result = valueToSearchTextT(arr);
    expect(result).toContain('nettoyage');
    expect(result).toContain('desinfection');
  });

});

describe('PATCH P5b — detectClientProfileFamilies étendu (miroir)', () => {

  // SS-CTX-P5 : business_profile objet → familles correctes
  test('SS-CTX-P5 — business_profile objet contenant "nettoyage" → cleaning_disinfection détecté', () => {
    const profile = {
      client_name: 'Client nettoyage',
      business_profile: { label: 'nettoyage desinfection', code: 'NET' },
    };
    const fams = detectProfileExtT(profile);
    expect(fams['cleaning_disinfection']).toBeDefined();
    expect((fams['cleaning_disinfection'] as string[]).length).toBeGreaterThan(0);
  });

  // SS-CTX-P5b : technical_profile tableau → termes lus
  test('SS-CTX-P5b — technical_profile tableau → familles lues', () => {
    const profile = {
      client_name: 'Client IT',
      technical_profile: ['logiciel', 'serveur', 'cloud'],
    };
    const fams = detectProfileExtT(profile);
    expect(fams['it']).toBeDefined();
  });

  // SS-CTX-P5c : criteres objet imbriqué
  test('SS-CTX-P5c — criteres objet → familles détectées', () => {
    const profile = {
      client_name: 'Hopital',
      criteres: { domaine: 'medical soins clinique' },
    };
    const fams = detectProfileExtT(profile);
    expect(fams['medical_admin']).toBeDefined();
  });

  // SS-CTX-P6 : clientProfile null → {} sans crash
  test('SS-CTX-P6 — clientProfile null → {} sans crash', () => {
    expect(() => {
      const fams = detectProfileExtT(null);
      expect(Object.keys(fams).length).toBe(0);
    }).not.toThrow();
  });

  // SS-CTX-P6b : clientProfile avec champs undefined → pas de "[object Object]" dans la détection
  test('SS-CTX-P6b — champs undefined → pas de crash, pas de faux positif "[object Object]"', () => {
    const profile = {
      client_name: undefined as unknown as string,
      business_profile: undefined as unknown as string,
    };
    // Vérifier que valueToSearchText gère undefined sans produire "[object Object]"
    const text = [
      valueToSearchTextT(profile.client_name),
      valueToSearchTextT(profile.business_profile),
    ].join(' ');
    expect(text).not.toContain('[object Object]');
    expect(text.trim()).toBe('');
  });

});
