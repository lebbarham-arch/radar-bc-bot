/**
 * tests/unit/review-reasons.test.ts — GD-036
 *
 * Tests unitaires du module review-reasons.js (rule-based).
 * SS-RR1..SS-RR15 — miroir pur, aucun import FS, aucun appel réseau.
 *
 * Règles :
 *  - Aucune raison budget/prix/montant/estimation.
 *  - normalizeReviewReason : null/vide → "", variantes → code, inconnu → "autre".
 *  - explainReviewReason   : libellés FR attendus.
 *  - buildReviewReasonTemplate : template consultative, champs vides par défaut.
 */

// ─── Miroir local du module review-reasons.js ────────────────────────────────

const REVIEW_REASON_CODES_T = [
  'hors_activite',
  'mauvais_contexte',
  'bon_signal_mauvais_contexte',
  'organisme_non_pertinent',
  'zone_non_pertinente',
  'doublon_deja_vu',
  'information_insuffisante',
  'faux_positif_evident',
  'autre',
] as const;

type ReasonCode = typeof REVIEW_REASON_CODES_T[number] | '';

const REVIEW_REASON_LABELS_T: Record<string, string> = {
  hors_activite:               'Hors activité du client',
  mauvais_contexte:            'Mauvais contexte',
  bon_signal_mauvais_contexte: 'Bon signal, mais mauvais contexte',
  organisme_non_pertinent:     'Organisme non pertinent',
  zone_non_pertinente:         'Zone non pertinente',
  doublon_deja_vu:             'Doublon ou déjà vu',
  information_insuffisante:    'Information insuffisante',
  faux_positif_evident:        'Faux positif évident',
  autre:                       'Autre raison',
};

const REASON_VARIANTS_T: Record<string, string> = {
  'hors_activite':              'hors_activite',
  'hors activite':              'hors_activite',
  'hors activite du client':    'hors_activite',
  'hors_activite_du_client':    'hors_activite',
  'mauvais_contexte':           'mauvais_contexte',
  'mauvais contexte':           'mauvais_contexte',
  'bon_signal_mauvais_contexte':        'bon_signal_mauvais_contexte',
  'bon signal mauvais contexte':        'bon_signal_mauvais_contexte',
  'bon signal, mais mauvais contexte':  'bon_signal_mauvais_contexte',
  'bon signal mais mauvais contexte':   'bon_signal_mauvais_contexte',
  'organisme_non_pertinent':    'organisme_non_pertinent',
  'organisme non pertinent':    'organisme_non_pertinent',
  'zone_non_pertinente':        'zone_non_pertinente',
  'zone non pertinente':        'zone_non_pertinente',
  'doublon_deja_vu':            'doublon_deja_vu',
  'doublon deja vu':            'doublon_deja_vu',
  'doublon':                    'doublon_deja_vu',
  'deja vu':                    'doublon_deja_vu',
  'deja-vu':                    'doublon_deja_vu',
  'information_insuffisante':   'information_insuffisante',
  'information insuffisante':   'information_insuffisante',
  'infos insuffisantes':        'information_insuffisante',
  'info insuffisante':          'information_insuffisante',
  'faux_positif_evident':       'faux_positif_evident',
  'faux positif evident':       'faux_positif_evident',
  'faux positif':               'faux_positif_evident',
  'faux_positif':               'faux_positif_evident',
  'autre':                      'autre',
  'autre raison':               'autre',
  'other':                      'autre',
};

function normReasonT(s: unknown): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['']/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeReviewReasonT(reason: unknown): string {
  if (reason === null || reason === undefined) return '';
  const raw = String(reason).trim();
  if (!raw) return '';
  const norm = normReasonT(raw);
  if (!norm) return '';
  if (REASON_VARIANTS_T[norm]) return REASON_VARIANTS_T[norm];
  return 'autre';
}

function explainReviewReasonT(code: unknown): string {
  if (!code) return '';
  const norm = normalizeReviewReasonT(code);
  if (!norm) return '';
  return REVIEW_REASON_LABELS_T[norm] || '';
}

interface ReasonTemplate {
  review_reason:          string;
  review_reason_label:    string;
  review_comment:         string;
  allowed_review_reasons: Array<{ code: string; label: string }>;
}

function buildReviewReasonTemplateT(entry: Record<string, unknown> | null | undefined): ReasonTemplate {
  const e = entry || {};
  const rawReason  = (e['human_review_reason'] || e['review_reason'] || e['decision_reason'] || '') as string;
  const normalized = normalizeReviewReasonT(rawReason);
  const rawComment = (e['human_review_comment'] || e['review_comment'] || e['decision_comment'] || '') as string;
  const allowed    = REVIEW_REASON_CODES_T.map(code => ({
    code,
    label: REVIEW_REASON_LABELS_T[code] || code,
  }));
  return {
    review_reason:          normalized,
    review_reason_label:    explainReviewReasonT(normalized),
    review_comment:         String(rawComment || '').trim(),
    allowed_review_reasons: allowed,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('review-reasons — REVIEW_REASON_CODES', () => {

  // SS-RR1 : liste complète sans budget/prix/montant/estimation
  test('SS-RR1 — liste des codes ne contient pas budget/prix/montant/estimation', () => {
    const forbidden = ['budget', 'prix', 'montant', 'estimation'];
    REVIEW_REASON_CODES_T.forEach(code => {
      forbidden.forEach(f => {
        expect(code).not.toContain(f);
      });
    });
  });

  // SS-RR2 : liste contient les 9 codes attendus
  test('SS-RR2 — liste contient exactement les 9 codes attendus', () => {
    expect(REVIEW_REASON_CODES_T).toHaveLength(9);
    expect(REVIEW_REASON_CODES_T).toContain('hors_activite');
    expect(REVIEW_REASON_CODES_T).toContain('mauvais_contexte');
    expect(REVIEW_REASON_CODES_T).toContain('bon_signal_mauvais_contexte');
    expect(REVIEW_REASON_CODES_T).toContain('organisme_non_pertinent');
    expect(REVIEW_REASON_CODES_T).toContain('zone_non_pertinente');
    expect(REVIEW_REASON_CODES_T).toContain('doublon_deja_vu');
    expect(REVIEW_REASON_CODES_T).toContain('information_insuffisante');
    expect(REVIEW_REASON_CODES_T).toContain('faux_positif_evident');
    expect(REVIEW_REASON_CODES_T).toContain('autre');
  });

  // SS-RR3 : libellés sans "budget"
  test('SS-RR3 — aucun libellé ne contient "budget"', () => {
    Object.values(REVIEW_REASON_LABELS_T).forEach(label => {
      expect(label.toLowerCase()).not.toContain('budget');
    });
  });

});

describe('review-reasons — normalizeReviewReason', () => {

  // SS-RR4 : null / undefined / vide → ""
  test('SS-RR4 — null/undefined/chaîne vide → ""', () => {
    expect(normalizeReviewReasonT(null)).toBe('');
    expect(normalizeReviewReasonT(undefined)).toBe('');
    expect(normalizeReviewReasonT('')).toBe('');
    expect(normalizeReviewReasonT('   ')).toBe('');
  });

  // SS-RR5 : codes déjà normalisés → inchangés
  test('SS-RR5 — codes déjà valides → même code retourné', () => {
    REVIEW_REASON_CODES_T.forEach(code => {
      expect(normalizeReviewReasonT(code)).toBe(code);
    });
  });

  // SS-RR6 : variantes avec accents et espaces
  test('SS-RR6 — variantes avec accents → code normalisé', () => {
    expect(normalizeReviewReasonT('hors activité')).toBe('hors_activite');
    expect(normalizeReviewReasonT('hors activite')).toBe('hors_activite');
    expect(normalizeReviewReasonT('hors activité du client')).toBe('hors_activite');
    expect(normalizeReviewReasonT('mauvais contexte')).toBe('mauvais_contexte');
    expect(normalizeReviewReasonT('Mauvais Contexte')).toBe('mauvais_contexte');
    expect(normalizeReviewReasonT('organisme non pertinent')).toBe('organisme_non_pertinent');
    expect(normalizeReviewReasonT('zone non pertinente')).toBe('zone_non_pertinente');
    expect(normalizeReviewReasonT('information insuffisante')).toBe('information_insuffisante');
    expect(normalizeReviewReasonT('faux positif')).toBe('faux_positif_evident');
    expect(normalizeReviewReasonT('bon signal mauvais contexte')).toBe('bon_signal_mauvais_contexte');
  });

  // SS-RR7 : variantes "doublon" et "déjà vu"
  test('SS-RR7 — "doublon" et "déjà vu" → doublon_deja_vu', () => {
    expect(normalizeReviewReasonT('doublon')).toBe('doublon_deja_vu');
    expect(normalizeReviewReasonT('déjà vu')).toBe('doublon_deja_vu');
    expect(normalizeReviewReasonT('deja vu')).toBe('doublon_deja_vu');
    expect(normalizeReviewReasonT('deja-vu')).toBe('doublon_deja_vu');
    expect(normalizeReviewReasonT('doublon deja vu')).toBe('doublon_deja_vu');
  });

  // SS-RR8 : valeur inconnue non vide → "autre" (choix documenté)
  test('SS-RR8 — valeur inconnue non vide → "autre" (comportement documenté)', () => {
    expect(normalizeReviewReasonT('valeur_inconnue_xyz')).toBe('autre');
    expect(normalizeReviewReasonT('prix_trop_eleve')).toBe('autre');
    expect(normalizeReviewReasonT('budget insuffisant')).toBe('autre');
    expect(normalizeReviewReasonT('montant hors plafond')).toBe('autre');
    // Même si l'utilisateur tape "budget", ça devient "autre", pas un code budget
    expect(normalizeReviewReasonT('budget')).toBe('autre');
  });

  // SS-RR8b : "autre raison" et "other" → "autre"
  test('SS-RR8b — "autre raison" et "other" → "autre"', () => {
    expect(normalizeReviewReasonT('autre raison')).toBe('autre');
    expect(normalizeReviewReasonT('other')).toBe('autre');
  });

});

describe('review-reasons — explainReviewReason', () => {

  // SS-RR9 : libellés FR attendus pour chaque code
  test('SS-RR9 — libellés FR corrects pour tous les codes', () => {
    expect(explainReviewReasonT('hors_activite')).toBe('Hors activité du client');
    expect(explainReviewReasonT('mauvais_contexte')).toBe('Mauvais contexte');
    expect(explainReviewReasonT('bon_signal_mauvais_contexte')).toBe('Bon signal, mais mauvais contexte');
    expect(explainReviewReasonT('organisme_non_pertinent')).toBe('Organisme non pertinent');
    expect(explainReviewReasonT('zone_non_pertinente')).toBe('Zone non pertinente');
    expect(explainReviewReasonT('doublon_deja_vu')).toBe('Doublon ou déjà vu');
    expect(explainReviewReasonT('information_insuffisante')).toBe('Information insuffisante');
    expect(explainReviewReasonT('faux_positif_evident')).toBe('Faux positif évident');
    expect(explainReviewReasonT('autre')).toBe('Autre raison');
  });

  // SS-RR10 : code vide → ""
  test('SS-RR10 — code vide ou null → ""', () => {
    expect(explainReviewReasonT('')).toBe('');
    expect(explainReviewReasonT(null)).toBe('');
    expect(explainReviewReasonT(undefined)).toBe('');
  });

  // SS-RR10b : variante avec accents → libellé correct (normalize + explain enchaîné)
  test('SS-RR10b — variante avec accent → libellé FR correct', () => {
    expect(explainReviewReasonT('hors activité')).toBe('Hors activité du client');
    expect(explainReviewReasonT('faux positif')).toBe('Faux positif évident');
    expect(explainReviewReasonT('doublon')).toBe('Doublon ou déjà vu');
  });

  // SS-RR10c : libellés ne contiennent pas "budget"
  test('SS-RR10c — aucun libellé retourné par explain ne contient "budget"', () => {
    REVIEW_REASON_CODES_T.forEach(code => {
      const label = explainReviewReasonT(code);
      expect(label.toLowerCase()).not.toContain('budget');
    });
  });

});

describe('review-reasons — buildReviewReasonTemplate', () => {

  // SS-RR11 : entrée null → champs vides + liste complète
  test('SS-RR11 — entrée null → review_reason/comment vides, liste complète', () => {
    const tpl = buildReviewReasonTemplateT(null);
    expect(tpl.review_reason).toBe('');
    expect(tpl.review_reason_label).toBe('');
    expect(tpl.review_comment).toBe('');
    expect(Array.isArray(tpl.allowed_review_reasons)).toBe(true);
    expect(tpl.allowed_review_reasons).toHaveLength(REVIEW_REASON_CODES_T.length);
  });

  // SS-RR12 : allowed_review_reasons contient code + label pour chaque raison
  test('SS-RR12 — allowed_review_reasons : chaque entrée a code et label', () => {
    const tpl = buildReviewReasonTemplateT(null);
    tpl.allowed_review_reasons.forEach(item => {
      expect(typeof item.code).toBe('string');
      expect(item.code.length).toBeGreaterThan(0);
      expect(typeof item.label).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
    });
  });

  // SS-RR13 : allowed_review_reasons ne contient pas "budget"
  test('SS-RR13 — allowed_review_reasons sans budget/prix/montant', () => {
    const tpl = buildReviewReasonTemplateT(null);
    const forbidden = ['budget', 'prix', 'montant', 'estimation'];
    tpl.allowed_review_reasons.forEach(item => {
      forbidden.forEach(f => {
        expect(item.code.toLowerCase()).not.toContain(f);
        expect(item.label.toLowerCase()).not.toContain(f);
      });
    });
  });

  // SS-RR14 : entrée avec human_review_reason → normalisé dans le template
  test('SS-RR14 — entrée avec human_review_reason → normalisé dans review_reason', () => {
    const tpl = buildReviewReasonTemplateT({
      human_review_reason:  'hors activité',
      human_review_comment: 'Mauvais domaine géographique',
    });
    expect(tpl.review_reason).toBe('hors_activite');
    expect(tpl.review_reason_label).toBe('Hors activité du client');
    expect(tpl.review_comment).toBe('Mauvais domaine géographique');
  });

  // SS-RR14b : fallback vers review_reason et decision_reason
  test('SS-RR14b — fallback : review_reason puis decision_reason', () => {
    const tpl1 = buildReviewReasonTemplateT({ review_reason: 'doublon' });
    expect(tpl1.review_reason).toBe('doublon_deja_vu');

    const tpl2 = buildReviewReasonTemplateT({ decision_reason: 'faux positif' });
    expect(tpl2.review_reason).toBe('faux_positif_evident');
  });

  // SS-RR15 : template ne contient pas de logique métier (buckets/candidatures inchangées)
  test('SS-RR15 — template ne modifie pas les champs de candidature de l\'entrée', () => {
    const entry = {
      bc_id: 12345,
      auto_notify_candidate: false,
      review_candidate:      true,
      clean_score:           8,
    };
    const autoBefore   = entry.auto_notify_candidate;
    const reviewBefore = entry.review_candidate;
    const scoreBefore  = entry.clean_score;

    buildReviewReasonTemplateT(entry);

    expect(entry.auto_notify_candidate).toBe(autoBefore);
    expect(entry.review_candidate).toBe(reviewBefore);
    expect(entry.clean_score).toBe(scoreBefore);
  });

});
