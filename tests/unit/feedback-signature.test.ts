/**
 * tests/unit/feedback-signature.test.ts
 *
 * FBS-1..FBS-23 — Tests unitaires pour scripts/feedback-signature.js (GD-085)
 *
 * Couvre :
 *  - Flags : isFeedbackSignedLinksEnabled, isFeedbackSignatureRequired
 *  - Expiration : buildFeedbackExpiry (now injectable)
 *  - Payload canonique : buildCanonicalFeedbackPayload (ordre, champs optionnels)
 *  - Signature : signFeedbackParams (deterministique, sensible aux params)
 *  - Verification : verifyFeedbackSignature (valide, expire, absent, invalide)
 *  - Integration links-builder : liens signes vs non signes
 *  - Retro-compatibilite : comportement par defaut inchange
 *
 * STRICT :
 *  - Pas de CFG, process.env, Supabase, Puppeteer, cron, prod
 *  - Pas de scoring / seuils / poids / matching / guards modifie
 *  - auto_notify_candidate jamais impacte
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  DEFAULT_TTL_SECONDS,
  isFeedbackSignedLinksEnabled,
  isFeedbackSignatureRequired,
  buildFeedbackExpiry,
  buildCanonicalFeedbackPayload,
  signFeedbackParams,
  verifyFeedbackSignature,
} = require('../../scripts/feedback-signature');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildFeedbackReasonLinks,
  isFeedbackReasonLinksEnabled,
} = require('../../scripts/feedback-links-builder');

const SECRET = 'test-secret-gd085-hmac';
const NOW    = new Date('2026-06-23T10:00:00.000Z');
const NOW_TS = Math.floor(NOW.getTime() / 1000); // 1750676400

// Params canoniques de base
function baseParams(overrides: Record<string, unknown> = {}) {
  return Object.assign({
    client_id:  'client-test',
    radar_type: 'bc',
    item_id:    'BC-2026-001',
    critere:    'nettoyage',
    type:       'irrelevant',
    exp:        NOW_TS + 604800,
  }, overrides);
}

// ---------------------------------------------------------------------------
// FBS-1..2 — isFeedbackSignedLinksEnabled
// ---------------------------------------------------------------------------

describe('FBS-1..2 -- isFeedbackSignedLinksEnabled', () => {

  test('FBS-1: undefined / "false" / vide / "FALSE" -> false (defaut securise)', () => {
    expect(isFeedbackSignedLinksEnabled(undefined)).toBe(false);
    expect(isFeedbackSignedLinksEnabled('false')).toBe(false);
    expect(isFeedbackSignedLinksEnabled('')).toBe(false);
    expect(isFeedbackSignedLinksEnabled('FALSE')).toBe(false);
    expect(isFeedbackSignedLinksEnabled('1')).toBe(false);
  });

  test('FBS-2: "true" -> true (seule valeur activante)', () => {
    expect(isFeedbackSignedLinksEnabled('true')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FBS-3..4 — isFeedbackSignatureRequired
// ---------------------------------------------------------------------------

describe('FBS-3..4 -- isFeedbackSignatureRequired', () => {

  test('FBS-3: undefined / "false" / vide -> false (anciens liens acceptes par defaut)', () => {
    expect(isFeedbackSignatureRequired(undefined)).toBe(false);
    expect(isFeedbackSignatureRequired('false')).toBe(false);
    expect(isFeedbackSignatureRequired('')).toBe(false);
  });

  test('FBS-4: "true" -> true (rejet liens non signes actif)', () => {
    expect(isFeedbackSignatureRequired('true')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FBS-5..6 — buildFeedbackExpiry
// ---------------------------------------------------------------------------

describe('FBS-5..6 -- buildFeedbackExpiry', () => {

  test('FBS-5: retourne now_ts + ttlSeconds', () => {
    const exp = buildFeedbackExpiry(NOW, 3600);
    expect(exp).toBe(NOW_TS + 3600);
  });

  test('FBS-6: ttlSeconds absent -> DEFAULT_TTL_SECONDS (604800 = 7 jours)', () => {
    expect(DEFAULT_TTL_SECONDS).toBe(604800);
    const exp = buildFeedbackExpiry(NOW);
    expect(exp).toBe(NOW_TS + 604800);
    const exp2 = buildFeedbackExpiry(NOW, 0);   // 0 invalide -> defaut
    expect(exp2).toBe(NOW_TS + 604800);
  });
});

// ---------------------------------------------------------------------------
// FBS-7..9 — buildCanonicalFeedbackPayload
// ---------------------------------------------------------------------------

describe('FBS-7..9 -- buildCanonicalFeedbackPayload', () => {

  test('FBS-7: champs requis seulement -> payload deterministe', () => {
    const p = baseParams();
    const canonical = buildCanonicalFeedbackPayload(p);
    expect(canonical).toBe(
      `client_id=client-test&radar_type=bc&item_id=BC-2026-001&critere=nettoyage&type=irrelevant&exp=${p.exp}`
    );
  });

  test('FBS-8: champs optionnels inclus si presents (nid, mt, bt, r)', () => {
    const p = baseParams({ nid: 'nid-abc', mt: 'nettoyage', bt: 'Contrat nettoyage', r: 'wrong_product' });
    const canonical = buildCanonicalFeedbackPayload(p);
    expect(canonical).toContain('&nid=nid-abc');
    expect(canonical).toContain('&mt=nettoyage');
    expect(canonical).toContain('&bt=Contrat nettoyage');
    expect(canonical).toContain('&r=wrong_product');
  });

  test('FBS-9: exp toujours en dernier dans le payload', () => {
    const p = baseParams({ nid: 'nid-xyz', r: 'wrong_product' });
    const canonical = buildCanonicalFeedbackPayload(p);
    const lastPart = canonical.split('&').pop();
    expect(lastPart).toMatch(/^exp=\d+$/);
  });
});

// ---------------------------------------------------------------------------
// FBS-10..12 — signFeedbackParams
// ---------------------------------------------------------------------------

describe('FBS-10..12 -- signFeedbackParams', () => {

  test('FBS-10: retourne une chaine hex de 64 caracteres (SHA-256)', () => {
    const sig = signFeedbackParams(baseParams(), SECRET);
    expect(typeof sig).toBe('string');
    expect(sig).toHaveLength(64);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  test('FBS-11: deterministique -- memes params + meme secret => meme sig', () => {
    const p = baseParams({ r: 'wrong_product' });
    const sig1 = signFeedbackParams(p, SECRET);
    const sig2 = signFeedbackParams(p, SECRET);
    expect(sig1).toBe(sig2);
  });

  test('FBS-12: params differents => signature differente', () => {
    const sig1 = signFeedbackParams(baseParams({ type: 'irrelevant' }), SECRET);
    const sig2 = signFeedbackParams(baseParams({ type: 'relevant'  }), SECRET);
    const sig3 = signFeedbackParams(baseParams({ r: 'wrong_product' }), SECRET);
    expect(sig1).not.toBe(sig2);
    expect(sig1).not.toBe(sig3);
  });
});

// ---------------------------------------------------------------------------
// FBS-13..17 — verifyFeedbackSignature
// ---------------------------------------------------------------------------

describe('FBS-13..17 -- verifyFeedbackSignature', () => {

  // Construire une query signee valide pour les tests
  function makeSignedQuery(overrides: Record<string, unknown> = {}) {
    const params = baseParams({ r: 'wrong_product' });
    const sig = signFeedbackParams(params, SECRET);
    return Object.assign({
      client_id:  'client-test',
      radar_type: 'bc',
      item_id:    'BC-2026-001',
      critere:    'nettoyage',
      type:       'irrelevant',
      r:          'wrong_product',
      exp:        String(params.exp),
      sig:        sig,
    }, overrides);
  }

  test('FBS-13: signature valide, non expiree -> { valid: true }', () => {
    const query = makeSignedQuery();
    const result = verifyFeedbackSignature(query, SECRET, NOW);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('FBS-14: sig absent -> { valid: false, error: "signature absente" }', () => {
    const query = makeSignedQuery({ sig: '' });
    const result = verifyFeedbackSignature(query, SECRET, NOW);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('signature absente');
  });

  test('FBS-15: sig invalide -> { valid: false, error: "signature invalide" }', () => {
    const query = makeSignedQuery({ sig: 'a'.repeat(64) });
    const result = verifyFeedbackSignature(query, SECRET, NOW);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('signature invalide');
  });

  test('FBS-16: lien expire (exp dans le passe) -> { valid: false, error: "lien expire" }', () => {
    // exp = 1 heure avant NOW
    const expiredExp = NOW_TS - 3600;
    const params = baseParams({ r: 'wrong_product', exp: expiredExp });
    const sig = signFeedbackParams(params, SECRET);
    const query = makeSignedQuery({ exp: String(expiredExp), sig });
    const result = verifyFeedbackSignature(query, SECRET, NOW);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('expire');
  });

  test('FBS-17: exp absent -> { valid: false, error: "exp absent" }', () => {
    const query = makeSignedQuery({ exp: '' });
    const result = verifyFeedbackSignature(query, SECRET, NOW);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('exp absent');
  });
});

// ---------------------------------------------------------------------------
// FBS-18..20 — buildFeedbackReasonLinks : intégration signature
// ---------------------------------------------------------------------------

describe('FBS-18..20 -- buildFeedbackReasonLinks : integration signature', () => {

  const BASE  = 'https://feedback.example.com';
  const OPTS  = { notifId: 'nid-001', matchedTerms: 'nettoyage', bcTitle: 'Contrat nettoyage' };

  test('FBS-18: signatureOpts absent (defaut) -> aucun sig= ni exp= dans les URLs', () => {
    const plain = buildFeedbackReasonLinks(BASE, 'c1', 'BC-001', 'nettoyage', 'bc', OPTS, 'plain', false);
    expect(plain).not.toContain('&sig=');
    expect(plain).not.toContain('&exp=');
  });

  test('FBS-19: signatureOpts.enabled=false -> aucun sig= (meme si secret present)', () => {
    const sigOpts = { enabled: false, secret: SECRET, ttlSeconds: 3600, now: NOW };
    const plain = buildFeedbackReasonLinks(BASE, 'c1', 'BC-001', 'nettoyage', 'bc', OPTS, 'plain', false, sigOpts);
    expect(plain).not.toContain('&sig=');
    expect(plain).not.toContain('&exp=');
  });

  test('FBS-20: signatureOpts.enabled=true + secret -> sig= et exp= dans chaque URL', () => {
    const sigOpts = { enabled: true, secret: SECRET, ttlSeconds: 3600, now: NOW };
    const plain = buildFeedbackReasonLinks(BASE, 'c1', 'BC-001', 'nettoyage', 'bc', OPTS, 'plain', false, sigOpts);
    // Toutes les URLs (3 liens par defaut) doivent avoir sig= et exp=
    const urls = plain!.split('\n').filter((l: string) => l.includes('/feedback?'));
    expect(urls.length).toBeGreaterThan(0);
    urls.forEach((url: string) => {
      expect(url).toContain('&sig=');
      expect(url).toContain('&exp=');
    });
  });
});

// ---------------------------------------------------------------------------
// FBS-21 — reason=wrong_product correctement couverte par la signature
// ---------------------------------------------------------------------------

describe('FBS-21 -- reason wrong_product transportee dans la signature', () => {

  test('FBS-21: lien signe avec r=wrong_product -> verification OK avec reason', () => {
    // Simuler la generation du lien avec reason=wrong_product et verification
    const exp    = buildFeedbackExpiry(NOW, 3600);
    const params = {
      client_id: 'c1', radar_type: 'bc', item_id: 'BC-2026-004521',
      critere: 'nettoyage', type: 'irrelevant', r: 'wrong_product', exp,
    };
    const sig = signFeedbackParams(params, SECRET);

    const query = {
      client_id: 'c1', radar_type: 'bc', item_id: 'BC-2026-004521',
      critere: 'nettoyage', type: 'irrelevant', r: 'wrong_product',
      exp: String(exp), sig,
    };

    const result = verifyFeedbackSignature(query, SECRET, NOW);
    expect(result.valid).toBe(true);

    // Sans r=wrong_product : la verification doit echouer (sig ne correspond plus)
    const queryNoReason = Object.assign({}, query);
    delete (queryNoReason as any).r;
    const resultNoReason = verifyFeedbackSignature(queryNoReason, SECRET, NOW);
    expect(resultNoReason.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FBS-22..23 — Retro-compatibilite comportement par defaut
// ---------------------------------------------------------------------------

describe('FBS-22..23 -- Retro-compatibilite (flags absents)', () => {

  test('FBS-22: require=false -> lien non signe accepte (pas de rejet)', () => {
    // isFeedbackSignatureRequired(undefined) = false
    // => la route ne doit pas verifier la signature => anciens liens valides
    expect(isFeedbackSignatureRequired(undefined)).toBe(false);
    expect(isFeedbackSignatureRequired('false')).toBe(false);
  });

  test('FBS-23: signed=false -> buildFeedbackReasonLinks sans sig= => verification skip', () => {
    // Comportement identique a GD-078 : aucun sig= quand flag absent
    const plain = buildFeedbackReasonLinks(
      'https://example.com', 'c1', 'BC-001', 'nettoyage', 'bc', {}, 'plain',
      false,   // reasonLinksEnabled
      undefined // signatureOpts absent
    );
    const urls = plain!.split('\n').filter((l: string) => l.includes('/feedback?'));
    expect(urls.length).toBe(3); // 3 liens originaux
    urls.forEach((url: string) => {
      expect(url).not.toContain('&sig=');
      expect(url).not.toContain('&exp=');
      expect(url).not.toContain('&r=');
    });
  });
});

export {};
