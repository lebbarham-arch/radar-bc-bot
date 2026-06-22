/**
 * tests/unit/feedback-reason-mapping.test.ts
 *
 * FRM-1..FRM-22 -- Tests unitaires pour scripts/feedback-reason-mapping.js (GD-077)
 * + miroir de validateFeedbackQuery (capture passive reason)
 *
 * Pattern miroir -- logique locale, pas d'acces fichier, pas de Supabase.
 *
 * STRICT :
 *  - Pas de scoring / seuil / poids modifie
 *  - Pas de prod / Supabase / Fly / notification / bcs_vus
 *  - Aucun lien existant n'est modifie
 *  - reason absent => comportement identique a avant GD-077
 *  - reason invalide => ignore silencieusement (pas d'erreur)
 *  - auto_notify_candidate jamais impacte
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  VALID_FEEDBACK_REASONS,
  mapFeedbackToReview,
  isValidFeedbackReason,
} = require('../../scripts/feedback-reason-mapping');

// ---------------------------------------------------------------------------
// FRM-1..3 -- VALID_FEEDBACK_REASONS : contenu et completude
// ---------------------------------------------------------------------------

describe('FRM-1..3 -- VALID_FEEDBACK_REASONS', () => {

  test('FRM-1: liste non vide', () => {
    expect(Array.isArray(VALID_FEEDBACK_REASONS)).toBe(true);
    expect(VALID_FEEDBACK_REASONS.length).toBeGreaterThan(0);
  });

  test('FRM-2: contient les 8 raisons GD-071', () => {
    const expected = [
      'not_my_business', 'wrong_buyer', 'wrong_zone', 'wrong_product',
      'not_sure', 'duplicate', 'insufficient_info', 'other',
    ];
    expected.forEach(r => {
      expect(VALID_FEEDBACK_REASONS).toContain(r);
    });
  });

  test('FRM-3: isValidFeedbackReason valide les codes connus et rejette les inconnus', () => {
    expect(isValidFeedbackReason('wrong_buyer')).toBe(true);
    expect(isValidFeedbackReason('not_my_business')).toBe(true);
    expect(isValidFeedbackReason('unknown_reason')).toBe(false);
    expect(isValidFeedbackReason('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FRM-4..8 -- mapFeedbackToReview : mapping type=relevant
// ---------------------------------------------------------------------------

describe('FRM-4 -- mapFeedbackToReview : relevant', () => {

  test('FRM-4: relevant sans reason -> keep / bon_signal_bon_contexte', () => {
    const r = mapFeedbackToReview('relevant', undefined);
    expect(r).not.toBeNull();
    expect(r!.decision).toBe('keep');
    expect(r!.human_review_reason).toBe('bon_signal_bon_contexte');
  });
});

// ---------------------------------------------------------------------------
// FRM-5..8 -- mapFeedbackToReview : type=irrelevant avec raisons
// ---------------------------------------------------------------------------

describe('FRM-5..8 -- mapFeedbackToReview : irrelevant + raisons', () => {

  test('FRM-5: irrelevant + not_my_business -> reject / hors_profil', () => {
    const r = mapFeedbackToReview('irrelevant', 'not_my_business');
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('hors_profil');
  });

  test('FRM-6: irrelevant + wrong_buyer -> reject / hors_profil', () => {
    const r = mapFeedbackToReview('irrelevant', 'wrong_buyer');
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('hors_profil');
  });

  test('FRM-7: irrelevant + wrong_zone -> reject / hors_profil', () => {
    const r = mapFeedbackToReview('irrelevant', 'wrong_zone');
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('hors_profil');
  });

  test('FRM-8: irrelevant + wrong_product -> reject / bon_signal_mauvais_contexte', () => {
    const r = mapFeedbackToReview('irrelevant', 'wrong_product');
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('bon_signal_mauvais_contexte');
  });
});

// ---------------------------------------------------------------------------
// FRM-9..12 -- mapFeedbackToReview : type=watch
// ---------------------------------------------------------------------------

describe('FRM-9..12 -- mapFeedbackToReview : watch + raisons', () => {

  test('FRM-9: watch sans reason -> ignore / ambigu', () => {
    const r = mapFeedbackToReview('watch', undefined);
    expect(r!.decision).toBe('ignore');
    expect(r!.human_review_reason).toBe('ambigu');
  });

  test('FRM-10: watch + not_sure -> ignore / ambigu', () => {
    const r = mapFeedbackToReview('watch', 'not_sure');
    expect(r!.decision).toBe('ignore');
    expect(r!.human_review_reason).toBe('ambigu');
  });

  test('FRM-11: watch + insufficient_info -> ignore / ambigu', () => {
    const r = mapFeedbackToReview('watch', 'insufficient_info');
    expect(r!.decision).toBe('ignore');
    expect(r!.human_review_reason).toBe('ambigu');
  });

  test('FRM-12: watch + other -> ignore / ambigu', () => {
    const r = mapFeedbackToReview('watch', 'other');
    expect(r!.decision).toBe('ignore');
    expect(r!.human_review_reason).toBe('ambigu');
  });
});

// ---------------------------------------------------------------------------
// FRM-13..14 -- mapFeedbackToReview : type=duplicate
// ---------------------------------------------------------------------------

describe('FRM-13..14 -- mapFeedbackToReview : duplicate', () => {

  test('FRM-13: duplicate sans reason -> ignore / ignore_non_decidable', () => {
    const r = mapFeedbackToReview('duplicate', undefined);
    expect(r!.decision).toBe('ignore');
    expect(r!.human_review_reason).toBe('ignore_non_decidable');
  });

  test('FRM-14: duplicate + reason=duplicate -> ignore / ignore_non_decidable', () => {
    const r = mapFeedbackToReview('duplicate', 'duplicate');
    expect(r!.decision).toBe('ignore');
    expect(r!.human_review_reason).toBe('ignore_non_decidable');
  });
});

// ---------------------------------------------------------------------------
// FRM-15..16 -- mapFeedbackToReview : out_of_scope, wrong_category
// ---------------------------------------------------------------------------

describe('FRM-15..16 -- mapFeedbackToReview : out_of_scope / wrong_category', () => {

  test('FRM-15: out_of_scope -> reject / hors_profil', () => {
    const r = mapFeedbackToReview('out_of_scope', undefined);
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('hors_profil');
  });

  test('FRM-16: wrong_category -> reject / bon_signal_mauvais_contexte', () => {
    const r = mapFeedbackToReview('wrong_category', undefined);
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('bon_signal_mauvais_contexte');
  });
});

// ---------------------------------------------------------------------------
// FRM-17..18 -- mapFeedbackToReview : cas limites
// ---------------------------------------------------------------------------

describe('FRM-17..18 -- mapFeedbackToReview : cas limites', () => {

  test('FRM-17: type inconnu -> null', () => {
    const r = mapFeedbackToReview('unknown_type', undefined);
    expect(r).toBeNull();
  });

  test('FRM-18: reason inconnue -> utilise _default du type', () => {
    // reason inconnue pour irrelevant -> _default = hors_profil
    const r = mapFeedbackToReview('irrelevant', 'totally_unknown_reason');
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('hors_profil');
  });
});

// ---------------------------------------------------------------------------
// FRM-19..22 -- Miroir validateFeedbackQuery (capture passive reason GD-077)
// Logique locale sans require du bot -- verifie le contrat attendu.
// ---------------------------------------------------------------------------

describe('FRM-19..22 -- validateFeedbackQuery miroir : capture passive reason', () => {

  /**
   * Miroir local de la logique validateFeedbackQuery GD-077.
   * Reproduit uniquement la logique du champ reason.
   */
  function extractReason(queryR: string | undefined, validReasons: string[]): string | undefined {
    if (typeof queryR !== 'string') return undefined;
    const trimmed = queryR.slice(0, 64).trim();
    return validReasons.includes(trimmed) ? trimmed : undefined;
  }

  test('FRM-19: reason valide -> inclus dans data', () => {
    const r = extractReason('wrong_buyer', VALID_FEEDBACK_REASONS);
    expect(r).toBe('wrong_buyer');
  });

  test('FRM-20: reason absente -> non incluse dans data (undefined)', () => {
    const r = extractReason(undefined, VALID_FEEDBACK_REASONS);
    expect(r).toBeUndefined();
  });

  test('FRM-21: reason invalide -> ignoree silencieusement (undefined)', () => {
    const r = extractReason('injected_value; DROP TABLE', VALID_FEEDBACK_REASONS);
    expect(r).toBeUndefined();
  });

  test('FRM-22: reason trop longue -> tronquee a 64 chars puis validee', () => {
    // 'wrong_buyer' + padding long -> tronque a 64 -> 'wrong_buyer...' != any valid reason -> undefined
    const longInput = 'wrong_buyer' + 'x'.repeat(60);
    const r = extractReason(longInput, VALID_FEEDBACK_REASONS);
    expect(r).toBeUndefined();
  });
});

export {};
