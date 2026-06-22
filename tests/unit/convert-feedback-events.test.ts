/**
 * tests/unit/convert-feedback-events.test.ts
 *
 * CFE-1..CFE-20 -- Tests unitaires pour scripts/convert-feedback-events-to-review-csv.js (GD-076)
 *
 * Pattern miroir -- logique locale, pas d'acces fichier reel, pas de Supabase.
 * Tous les evenements feedback sont en memoire.
 *
 * STRICT :
 *  - Pas de scoring / seuil / poids modifie
 *  - Pas de prod / Supabase / Fly / notification / bcs_vus
 *  - Pas d'ecriture dans data/
 *  - Mapping feedback type -> decision uniquement via FEEDBACK_TYPE_MAP
 *  - auto_notify_candidate jamais true
 *  - Dedupe par (client_id + item_id + type), plus recent gagne
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  convertFeedbackEvent,
  dedupeReviews,
  parseFeedbackJsonl,
  buildCsvContent,
  FEEDBACK_TYPE_MAP,
  CSV_HEADER,
} = require('../../scripts/convert-feedback-events-to-review-csv');

// ---------------------------------------------------------------------------
// Fixtures en memoire
// ---------------------------------------------------------------------------

function makeFeedbackEvent(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    client_id:    'test-client-1',
    radar_type:   'bc',
    item_id:      'BC-12345',
    critere:      'nettoyage',
    type:         'relevant',
    source:       'web_click',
    raw_payload:  {},
    created_at:   '2026-06-22T10:00:00.000Z',
    bc_title:     'Prestation nettoyage batiments',
    matched_terms:'nettoyage, nettoyage locaux',
    notif_id:     'abc12345',
  }, overrides);
}

// ---------------------------------------------------------------------------
// CFE-1..6 -- convertFeedbackEvent : mapping type -> decision
// ---------------------------------------------------------------------------

describe('CFE-1..6 -- convertFeedbackEvent : mapping type -> decision', () => {

  test('CFE-1: type=relevant -> decision=keep, reason=bon_signal_bon_contexte', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ type: 'relevant' }));
    expect(r).not.toBeNull();
    expect(r.decision).toBe('keep');
    expect(r.human_review_reason).toBe('bon_signal_bon_contexte');
  });

  test('CFE-2: type=irrelevant -> decision=reject, reason=hors_profil', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ type: 'irrelevant' }));
    expect(r.decision).toBe('reject');
    expect(r.human_review_reason).toBe('hors_profil');
  });

  test('CFE-3: type=watch -> decision=ignore, reason=ambigu', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ type: 'watch' }));
    expect(r.decision).toBe('ignore');
    expect(r.human_review_reason).toBe('ambigu');
  });

  test('CFE-4: type=duplicate -> decision=ignore, reason=ignore_non_decidable', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ type: 'duplicate' }));
    expect(r.decision).toBe('ignore');
    expect(r.human_review_reason).toBe('ignore_non_decidable');
  });

  test('CFE-5: type=out_of_scope -> decision=reject, reason=hors_profil', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ type: 'out_of_scope' }));
    expect(r.decision).toBe('reject');
    expect(r.human_review_reason).toBe('hors_profil');
  });

  test('CFE-6: type=wrong_category -> decision=reject, reason=bon_signal_mauvais_contexte', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ type: 'wrong_category' }));
    expect(r.decision).toBe('reject');
    expect(r.human_review_reason).toBe('bon_signal_mauvais_contexte');
  });
});

// ---------------------------------------------------------------------------
// CFE-7..10 -- convertFeedbackEvent : champs de sortie
// ---------------------------------------------------------------------------

describe('CFE-7..10 -- convertFeedbackEvent : champs de sortie', () => {

  test('CFE-7: bc_id = item_id', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ item_id: 'BC-99999' }));
    expect(r.bc_id).toBe('BC-99999');
  });

  test('CFE-8: client = client_id', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ client_id: 'mon-client' }));
    expect(r.client).toBe('mon-client');
  });

  test('CFE-9: matched_signals = matched_terms si disponible, sinon critere', () => {
    const r1 = convertFeedbackEvent(makeFeedbackEvent({ matched_terms: 'nettoyage, hygiene', critere: 'nettoyage' }));
    expect(r1.matched_signals).toBe('nettoyage, hygiene');

    const r2 = convertFeedbackEvent(makeFeedbackEvent({ matched_terms: '', critere: 'hygiene' }));
    expect(r2.matched_signals).toBe('hygiene');
  });

  test('CFE-10: clean_text_excerpt = bc_title si disponible', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ bc_title: 'Nettoyage des locaux' }));
    expect(r.clean_text_excerpt).toBe('Nettoyage des locaux');
  });
});

// ---------------------------------------------------------------------------
// CFE-11..13 -- convertFeedbackEvent : human_review_comment
// ---------------------------------------------------------------------------

describe('CFE-11..13 -- convertFeedbackEvent : human_review_comment', () => {

  test('CFE-11: comment contient type, critere, notif_id', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({
      type: 'irrelevant', critere: 'hygiene', notif_id: 'abc123',
    }));
    expect(r.human_review_comment).toContain('type=irrelevant');
    expect(r.human_review_comment).toContain('critere=hygiene');
    expect(r.human_review_comment).toContain('notif_id=abc123');
  });

  test('CFE-12: comment inclut raw_payload.reason si present', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({
      raw_payload: { reason: 'mauvaise_zone' },
    }));
    expect(r.human_review_comment).toContain('reason=mauvaise_zone');
  });

  test('CFE-13: comment sans raw_payload.reason si absent', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ raw_payload: {} }));
    expect(r.human_review_comment).not.toContain('reason=');
  });
});

// ---------------------------------------------------------------------------
// CFE-14..15 -- convertFeedbackEvent : cas invalides -> null
// ---------------------------------------------------------------------------

describe('CFE-14..15 -- convertFeedbackEvent : cas invalides', () => {

  test('CFE-14: retourne null si type inconnu', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ type: 'unknown_type' }));
    expect(r).toBeNull();
  });

  test('CFE-15: retourne null si item_id absent', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({ item_id: '' }));
    expect(r).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CFE-16 -- dedupeReviews
// ---------------------------------------------------------------------------

describe('CFE-16 -- dedupeReviews', () => {

  test('CFE-16: dedupe par (client+bc_id+type), garde le plus recent created_at', () => {
    const reviews = [
      { client: 'c1', bc_id: 'BC-1', _type: 'irrelevant', _created_at: '2026-06-22T09:00:00Z', decision: 'reject', human_review_reason: 'hors_profil' },
      { client: 'c1', bc_id: 'BC-1', _type: 'irrelevant', _created_at: '2026-06-22T11:00:00Z', decision: 'reject', human_review_reason: 'hors_profil' }, // plus recent
      { client: 'c1', bc_id: 'BC-2', _type: 'relevant',   _created_at: '2026-06-22T10:00:00Z', decision: 'keep',   human_review_reason: 'bon_signal_bon_contexte' },
    ];
    const deduped = dedupeReviews(reviews as any[]);
    expect(deduped).toHaveLength(2);
    const bc1 = deduped.find((r: any) => r.bc_id === 'BC-1');
    expect(bc1._created_at).toBe('2026-06-22T11:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// CFE-17..18 -- parseFeedbackJsonl
// ---------------------------------------------------------------------------

describe('CFE-17..18 -- parseFeedbackJsonl', () => {

  test('CFE-17: parse un JSONL valide et retourne les reviews', () => {
    const jsonl = [
      JSON.stringify(makeFeedbackEvent({ type: 'relevant', item_id: 'BC-1' })),
      JSON.stringify(makeFeedbackEvent({ type: 'irrelevant', item_id: 'BC-2' })),
    ].join('\n');
    const result = parseFeedbackJsonl(jsonl, {});
    expect(result.reviews).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  test('CFE-18: ignore les lignes vides et JSON invalide', () => {
    const jsonl = [
      '',
      'not-json',
      JSON.stringify(makeFeedbackEvent({ type: 'watch', item_id: 'BC-3' })),
    ].join('\n');
    const result = parseFeedbackJsonl(jsonl, {});
    expect(result.reviews).toHaveLength(1);
    expect(result.skipped).toBe(1); // 'not-json' compte, ligne vide ne compte pas
  });
});

// ---------------------------------------------------------------------------
// CFE-19..20 -- buildCsvContent
// ---------------------------------------------------------------------------

describe('CFE-19..20 -- buildCsvContent', () => {

  test('CFE-19: CSV contient le header avec toutes les colonnes requises', () => {
    const csv = buildCsvContent([]);
    const firstLine = csv.replace(/^﻿/, '').split('\n')[0];
    const cols = firstLine.split(';');
    // Colonnes requises par import-review-decisions.js
    ['client', 'bc_id', 'score', 'matched_signals', 'decision'].forEach(col => {
      expect(cols).toContain(col);
    });
  });

  test('CFE-20: CSV commence par BOM UTF-8 et chaque review devient une ligne', () => {
    const reviews = [
      convertFeedbackEvent(makeFeedbackEvent({ type: 'relevant', item_id: 'BC-10' })),
      convertFeedbackEvent(makeFeedbackEvent({ type: 'irrelevant', item_id: 'BC-11' })),
    ];
    const csv = buildCsvContent(reviews as any[]);
    expect(csv.charCodeAt(0)).toBe(0xFEFF); // BOM
    const lines = csv.replace(/^﻿/, '').split('\n').filter(Boolean);
    expect(lines).toHaveLength(3); // header + 2 lignes
  });
});


// ---------------------------------------------------------------------------
// CFE-21..25 -- GD-077B : mapping enrichi avec reason
// ---------------------------------------------------------------------------

describe('CFE-21..25 -- GD-077B : mapping enrichi (type + reason)', () => {

  test('CFE-21: irrelevant + reason=wrong_product -> reject / bon_signal_mauvais_contexte', () => {
    // wrong_product distingue hors_profil (default) de bon_signal_mauvais_contexte
    const r = convertFeedbackEvent(makeFeedbackEvent({
      type: 'irrelevant',
      reason: 'wrong_product',
    }));
    expect(r).not.toBeNull();
    expect(r.decision).toBe('reject');
    expect(r.human_review_reason).toBe('bon_signal_mauvais_contexte');
  });

  test('CFE-22: irrelevant + reason=wrong_buyer -> reject / hors_profil', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({
      type: 'irrelevant',
      reason: 'wrong_buyer',
    }));
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('hors_profil');
  });

  test('CFE-23: reason lu depuis event.reason (prioritaire sur raw_payload.reason)', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({
      type: 'irrelevant',
      reason: 'wrong_product',           // event.reason => bon_signal_mauvais_contexte
      raw_payload: { reason: 'wrong_buyer' }, // raw_payload.reason => hors_profil si prioritaire
    }));
    // event.reason doit prendre la precedence
    expect(r!.human_review_reason).toBe('bon_signal_mauvais_contexte');
    expect(r!.human_review_comment).toContain('reason=wrong_product');
  });

  test('CFE-24: reason lu depuis raw_payload.reason quand event.reason absent', () => {
    const r = convertFeedbackEvent(makeFeedbackEvent({
      type: 'irrelevant',
      raw_payload: { reason: 'wrong_product' },
    }));
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('bon_signal_mauvais_contexte');
    expect(r!.human_review_comment).toContain('reason=wrong_product');
  });

  test('CFE-25: reason inconnu -> fallback _default du type (comportement GD-076 inchange)', () => {
    // reason inconnu => mapFeedbackToReview retourne _default = hors_profil pour irrelevant
    const r = convertFeedbackEvent(makeFeedbackEvent({
      type: 'irrelevant',
      reason: 'totally_unknown_reason',
    }));
    expect(r!.decision).toBe('reject');
    expect(r!.human_review_reason).toBe('hors_profil');
  });
});

export {};
