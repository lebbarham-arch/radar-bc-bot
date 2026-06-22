/**
 * tests/unit/feedback-links.test.ts
 *
 * FBL-1..FBL-20 -- Tests unitaires pour scripts/feedback-links-builder.js (GD-078)
 *
 * Teste directement le module pur -- pas de CFG, pas de process.env, pas de Supabase.
 *
 * STRICT :
 *  - flag absent/false => comportement identique a avant GD-078 (3 liens, aucun r=)
 *  - flag true => liens enrichis (8 entrees avec r= par raison)
 *  - aucune r= inconnue (toutes dans _VALID_FEEDBACK_REASONS)
 *  - Aucun lien prod modifie tant que FEEDBACK_REASON_LINKS_ENABLED != "true"
 *  - Pas de scoring / seuils / poids / matching touches
 *  - auto_notify_candidate jamais impacte
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isFeedbackReasonLinksEnabled,
  buildFeedbackReasonLinks,
  FEEDBACK_REASON_ENTRIES,
  FEEDBACK_TYPES_DEFAULT,
} = require('../../scripts/feedback-links-builder');

// Raisons valides -- miroir de _VALID_FEEDBACK_REASONS dans radar-bc-bot.js (GD-077)
const VALID_FEEDBACK_REASONS = [
  'not_my_business', 'wrong_buyer', 'wrong_zone', 'wrong_product',
  'not_sure', 'duplicate', 'insufficient_info', 'other',
];

// Params communs pour buildFeedbackReasonLinks
const BASE   = 'https://feedback.example.com';
const CLIENT = 'client-test';
const ITEM   = 'BC-99999';
const CRIT   = 'nettoyage';
const RADAR  = 'bc';
const OPTS   = { notifId: 'nid123', matchedTerms: 'nettoyage', bcTitle: 'Contrat nettoyage locaux' };

// ---------------------------------------------------------------------------
// FBL-1..3 -- isFeedbackReasonLinksEnabled
// ---------------------------------------------------------------------------

describe('FBL-1..3 -- isFeedbackReasonLinksEnabled', () => {

  test('FBL-1: undefined -> false (defaut securise)', () => {
    expect(isFeedbackReasonLinksEnabled(undefined)).toBe(false);
  });

  test('FBL-2: "false", "", "0", "FALSE" -> false', () => {
    expect(isFeedbackReasonLinksEnabled('false')).toBe(false);
    expect(isFeedbackReasonLinksEnabled('')).toBe(false);
    expect(isFeedbackReasonLinksEnabled('0')).toBe(false);
    expect(isFeedbackReasonLinksEnabled('FALSE')).toBe(false);
  });

  test('FBL-3: "true" -> true (seule valeur activante)', () => {
    expect(isFeedbackReasonLinksEnabled('true')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FBL-4..6 -- buildFeedbackReasonLinks : flag false -> comportement original
// ---------------------------------------------------------------------------

describe('FBL-4..6 -- buildFeedbackReasonLinks : flag false (comportement original)', () => {

  test('FBL-4: flag=false -> exactement 3 liens (relevant, irrelevant, watch)', () => {
    const output = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'plain', false);
    expect(output).not.toBeNull();
    const lines = output!.split('\n').filter((l: string) => l.includes('/feedback?'));
    expect(lines).toHaveLength(3);
  });

  test('FBL-5: flag=false -> aucun parametre r= dans les URLs', () => {
    const html  = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'html',  false);
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'plain', false);
    expect(html).not.toContain('&r=');
    expect(plain).not.toContain('&r=');
  });

  test('FBL-6: flag=false -> types present: relevant, irrelevant, watch', () => {
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'plain', false);
    expect(plain).toContain('type=relevant');
    expect(plain).toContain('type=irrelevant');
    expect(plain).toContain('type=watch');
  });
});

// ---------------------------------------------------------------------------
// FBL-7..11 -- buildFeedbackReasonLinks : flag true -> liens enrichis
// ---------------------------------------------------------------------------

describe('FBL-7..11 -- buildFeedbackReasonLinks : flag true (liens enrichis)', () => {

  test('FBL-7: flag=true -> 8 liens (1 relevant + 4 irrelevant + 3 watch)', () => {
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'plain', true);
    const lines = plain!.split('\n').filter((l: string) => l.includes('/feedback?'));
    expect(lines).toHaveLength(8);
  });

  test('FBL-8: flag=true -> relevant sans r=', () => {
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'plain', true);
    // Trouver la ligne avec type=relevant
    const relevantLines = plain!.split('\n').filter((l: string) => l.includes('type=relevant'));
    expect(relevantLines).toHaveLength(1);
    expect(relevantLines[0]).not.toContain('&r=');
  });

  test('FBL-9: flag=true -> irrelevant x4 avec r=not_my_business, wrong_buyer, wrong_zone, wrong_product', () => {
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'plain', true);
    expect(plain).toContain('type=irrelevant&');
    expect(plain).toContain('&r=not_my_business');
    expect(plain).toContain('&r=wrong_buyer');
    expect(plain).toContain('&r=wrong_zone');
    expect(plain).toContain('&r=wrong_product');
    // Compter les lignes irrelevant
    const irr = plain!.split('\n').filter((l: string) => l.includes('type=irrelevant'));
    expect(irr).toHaveLength(4);
  });

  test('FBL-10: flag=true -> watch x3 avec r=not_sure, insufficient_info, other', () => {
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'plain', true);
    expect(plain).toContain('&r=not_sure');
    expect(plain).toContain('&r=insufficient_info');
    expect(plain).toContain('&r=other');
    const watchLines = plain!.split('\n').filter((l: string) => l.includes('type=watch'));
    expect(watchLines).toHaveLength(3);
  });

  test('FBL-11: securite -- toutes les r= values dans les liens enrichis sont dans VALID_FEEDBACK_REASONS', () => {
    // Extraire toutes les valeurs r= des entrees enrichies
    const reasons = FEEDBACK_REASON_ENTRIES
      .map((e: any) => e.reason)
      .filter((r: any) => r !== null);
    reasons.forEach((r: string) => {
      expect(VALID_FEEDBACK_REASONS).toContain(r);
    });
  });
});

// ---------------------------------------------------------------------------
// FBL-12..13 -- mode html vs plain
// ---------------------------------------------------------------------------

describe('FBL-12..13 -- mode html vs plain', () => {

  test('FBL-12: mode=html -> liens dans <a href="...">', () => {
    const html = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'html', false);
    expect(html).toContain('<a href="');
    expect(html).toContain('</a>');
    // Pas de format "label — url" attendu en mode html
    expect(html).not.toMatch(/Pertinent — http/);
  });

  test('FBL-13: mode=plain -> liens format "label — url"', () => {
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, OPTS, 'plain', false);
    expect(plain).not.toContain('<a href');
    expect(plain).toContain(' — ');
  });
});

// ---------------------------------------------------------------------------
// FBL-14..16 -- URLs contiennent les parametres requis
// ---------------------------------------------------------------------------

describe('FBL-14..16 -- parametres URL obligatoires', () => {

  test('FBL-14: URLs contiennent client_id, radar_type, item_id, critere, type', () => {
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, {}, 'plain', false);
    expect(plain).toContain('client_id=client-test');
    expect(plain).toContain('radar_type=bc');
    expect(plain).toContain('item_id=BC-99999');
    expect(plain).toContain('critere=nettoyage');
    expect(plain).toContain('type=');
  });

  test('FBL-15: opts.notifId -> nid= dans URL', () => {
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, { notifId: 'abc123' }, 'plain', false);
    expect(plain).toContain('&nid=abc123');
  });

  test('FBL-16: opts.matchedTerms -> mt= dans URL', () => {
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, { matchedTerms: 'signal_test' }, 'plain', false);
    expect(plain).toContain('&mt=signal_test');
  });
});

// ---------------------------------------------------------------------------
// FBL-17 -- opts.bcTitle -> bt= tronque a 60 chars
// ---------------------------------------------------------------------------

describe('FBL-17 -- opts.bcTitle', () => {

  test('FBL-17: opts.bcTitle -> bt= inclus (tronque a 60 chars)', () => {
    const long = 'A'.repeat(80);
    const plain = buildFeedbackReasonLinks(BASE, CLIENT, ITEM, CRIT, RADAR, { bcTitle: long }, 'plain', false);
    // bt doit etre present et tronque a 60 chars encodes
    expect(plain).toContain('&bt=');
    const match = plain!.match(/&bt=([^&\n ]+)/);
    expect(match).not.toBeNull();
    // decode et verifier longueur <= 60
    const decoded = decodeURIComponent(match![1]);
    expect(decoded.length).toBeLessThanOrEqual(60);
  });
});

// ---------------------------------------------------------------------------
// FBL-18 -- base vide -> null
// ---------------------------------------------------------------------------

describe('FBL-18 -- base vide', () => {

  test('FBL-18: base vide -> null (comportement prod inchange si FEEDBACK_BASE_URL absent)', () => {
    expect(buildFeedbackReasonLinks('', CLIENT, ITEM, CRIT, RADAR, {}, 'plain', false)).toBeNull();
    expect(buildFeedbackReasonLinks('  ', CLIENT, ITEM, CRIT, RADAR, {}, 'plain', true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FBL-19 -- FEEDBACK_TYPES_DEFAULT : contenu et ordre
// ---------------------------------------------------------------------------

describe('FBL-19 -- FEEDBACK_TYPES_DEFAULT (3 entrees originales)', () => {

  test('FBL-19: 3 entrees dans l\'ordre relevant, irrelevant, watch', () => {
    expect(FEEDBACK_TYPES_DEFAULT).toHaveLength(3);
    expect(FEEDBACK_TYPES_DEFAULT[0].type).toBe('relevant');
    expect(FEEDBACK_TYPES_DEFAULT[1].type).toBe('irrelevant');
    expect(FEEDBACK_TYPES_DEFAULT[2].type).toBe('watch');
    // Aucune reason dans les entrees par defaut
    FEEDBACK_TYPES_DEFAULT.forEach((e: any) => {
      expect(e.reason).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// FBL-20 -- FEEDBACK_REASON_ENTRIES : 8 entrees, types corrects
// ---------------------------------------------------------------------------

describe('FBL-20 -- FEEDBACK_REASON_ENTRIES (8 entrees enrichies)', () => {

  test('FBL-20: 8 entrees, types et reasons corrects', () => {
    expect(FEEDBACK_REASON_ENTRIES).toHaveLength(8);
    const types = FEEDBACK_REASON_ENTRIES.map((e: any) => e.type);
    // 1 relevant, 4 irrelevant, 3 watch
    expect(types.filter((t: string) => t === 'relevant')).toHaveLength(1);
    expect(types.filter((t: string) => t === 'irrelevant')).toHaveLength(4);
    expect(types.filter((t: string) => t === 'watch')).toHaveLength(3);
    // Premiere entree (relevant) : reason null
    expect(FEEDBACK_REASON_ENTRIES[0].reason).toBeNull();
    // Les 7 autres ont une reason non nulle
    FEEDBACK_REASON_ENTRIES.slice(1).forEach((e: any) => {
      expect(e.reason).not.toBeNull();
      expect(typeof e.reason).toBe('string');
    });
  });
});

export {};
