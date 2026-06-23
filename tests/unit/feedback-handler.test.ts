/**
 * tests/unit/feedback-handler.test.ts
 *
 * FBH-1..FBH-28 -- Tests unitaires pour scripts/feedback-handler.js (GD-080)
 * + test E2E local sans serveur : query -> validateFeedbackQuery -> buildFeedbackEvent
 *   -> appendFeedbackEventToJsonl (tmp) -> convertisseur dry-run -> mapping verifie
 *
 * Aucun demarrage de bot, de Puppeteer, de Supabase, de cron ou de port HTTP.
 *
 * STRICT :
 *  - Pas de scoring / seuil / poids / matching modifie
 *  - Pas de prod / Supabase / Fly / notification / bcs_vus
 *  - appendFeedbackEventToJsonl : fichier tmp uniquement, nettoye apres chaque test
 *  - auto_notify_candidate jamais impacte
 */

'use strict';

import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import * as cp   from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  VALID_FEEDBACK_TYPES,
  VALID_RADAR_TYPES,
  VALID_FEEDBACK_REASONS,
  FEEDBACK_SUCCESS_HTML,
  validateFeedbackQuery,
  buildFeedbackEvent,
  appendFeedbackEventToJsonl,
} = require('../../scripts/feedback-handler');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpFile(): string {
  return path.join(os.tmpdir(), 'fbh-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.jsonl');
}

function validQuery(overrides: Record<string, string> = {}): Record<string, string> {
  return Object.assign({
    client_id:  'client-test',
    radar_type: 'bc',
    item_id:    'BC-TEST-001',
    critere:    'nettoyage',
    type:       'relevant',
  }, overrides);
}

// ---------------------------------------------------------------------------
// FBH-1..4 -- Constantes exportees
// ---------------------------------------------------------------------------

describe('FBH-1..4 -- Constantes', () => {

  test('FBH-1: VALID_FEEDBACK_TYPES contient les 6 types attendus', () => {
    const expected = ['relevant', 'irrelevant', 'duplicate', 'out_of_scope', 'wrong_category', 'watch'];
    expected.forEach(t => expect(VALID_FEEDBACK_TYPES).toContain(t));
    expect(VALID_FEEDBACK_TYPES).toHaveLength(6);
  });

  test('FBH-2: VALID_RADAR_TYPES contient bc et mp', () => {
    expect(VALID_RADAR_TYPES).toContain('bc');
    expect(VALID_RADAR_TYPES).toContain('mp');
    expect(VALID_RADAR_TYPES).toHaveLength(2);
  });

  test('FBH-3: VALID_FEEDBACK_REASONS contient les 8 raisons GD-077', () => {
    const expected = ['not_my_business','wrong_buyer','wrong_zone','wrong_product',
                      'not_sure','duplicate','insufficient_info','other'];
    expected.forEach(r => expect(VALID_FEEDBACK_REASONS).toContain(r));
    expect(VALID_FEEDBACK_REASONS).toHaveLength(8);
  });

  test('FBH-4: FEEDBACK_SUCCESS_HTML contient ✅ Merci', () => {
    expect(FEEDBACK_SUCCESS_HTML).toContain('Merci');
    expect(FEEDBACK_SUCCESS_HTML).toContain('<!DOCTYPE html>');
  });
});

// ---------------------------------------------------------------------------
// FBH-5..12 -- validateFeedbackQuery : cas valides
// ---------------------------------------------------------------------------

describe('FBH-5..12 -- validateFeedbackQuery : cas valides', () => {

  test('FBH-5: query minimale valide -> { valid: true }', () => {
    const r = validateFeedbackQuery(validQuery());
    expect(r.valid).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.data).toBeDefined();
  });

  test('FBH-6: champs de base presents dans data', () => {
    const r = validateFeedbackQuery(validQuery({ type: 'irrelevant' }));
    expect(r.data.client_id).toBe('client-test');
    expect(r.data.radar_type).toBe('bc');
    expect(r.data.item_id).toBe('BC-TEST-001');
    expect(r.data.critere).toBe('nettoyage');
    expect(r.data.type).toBe('irrelevant');
  });

  test('FBH-7: query valide sans reason -> data.reason absent', () => {
    const r = validateFeedbackQuery(validQuery({ type: 'irrelevant' }));
    expect(r.valid).toBe(true);
    expect(r.data.reason).toBeUndefined();
  });

  test('FBH-8: query valide avec r=wrong_product -> data.reason = wrong_product', () => {
    const r = validateFeedbackQuery(validQuery({ type: 'irrelevant', r: 'wrong_product' }));
    expect(r.valid).toBe(true);
    expect(r.data.reason).toBe('wrong_product');
  });

  test('FBH-9: reason inconnue -> ignoree silencieusement (data.reason absent)', () => {
    const r = validateFeedbackQuery(validQuery({ type: 'irrelevant', r: 'totally_unknown' }));
    expect(r.valid).toBe(true);
    expect(r.data.reason).toBeUndefined();
  });

  test('FBH-10: champ nid (notif_id) present dans data', () => {
    const r = validateFeedbackQuery(validQuery({ nid: 'nid-abc123' }));
    expect(r.data.notif_id).toBe('nid-abc123');
  });

  test('FBH-11: champ mt (matched_terms) present dans data', () => {
    const r = validateFeedbackQuery(validQuery({ mt: 'nettoyage locaux' }));
    expect(r.data.matched_terms).toBe('nettoyage locaux');
  });

  test('FBH-12: champ bt (bc_title) tronque a 60 chars', () => {
    const long = 'A'.repeat(80);
    const r = validateFeedbackQuery(validQuery({ bt: long }));
    expect(r.data.bc_title).toHaveLength(60);
  });
});

// ---------------------------------------------------------------------------
// FBH-13..18 -- validateFeedbackQuery : cas invalides
// ---------------------------------------------------------------------------

describe('FBH-13..18 -- validateFeedbackQuery : cas invalides', () => {

  test('FBH-13: client_id absent -> { valid: false, error }', () => {
    const r = validateFeedbackQuery(validQuery({ client_id: '' }));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('client_id');
  });

  test('FBH-14: radar_type invalide -> { valid: false }', () => {
    const r = validateFeedbackQuery(validQuery({ radar_type: 'xxx' }));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('radar_type');
  });

  test('FBH-15: item_id absent -> { valid: false }', () => {
    const r = validateFeedbackQuery(validQuery({ item_id: '' }));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('item_id');
  });

  test('FBH-16: critere absent -> { valid: false }', () => {
    const r = validateFeedbackQuery(validQuery({ critere: '' }));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('critere');
  });

  test('FBH-17: type invalide -> { valid: false }', () => {
    const r = validateFeedbackQuery(validQuery({ type: 'hacker_injection' }));
    expect(r.valid).toBe(false);
    expect(r.error).toContain('type');
  });

  test('FBH-18: reason trop longue -> tronquee a 64 chars -> non valide -> ignoree', () => {
    // 'wrong_product' + padding -> tronque -> ne matche plus -> reason absente
    const r = validateFeedbackQuery(validQuery({
      type: 'irrelevant',
      r: 'wrong_product' + 'x'.repeat(60),
    }));
    expect(r.valid).toBe(true);  // query globale valide
    expect(r.data.reason).toBeUndefined();  // reason tronquee -> invalide -> ignoree
  });
});

// ---------------------------------------------------------------------------
// FBH-19..21 -- buildFeedbackEvent
// ---------------------------------------------------------------------------

describe('FBH-19..21 -- buildFeedbackEvent', () => {

  test('FBH-19: retourne un objet avec created_at ISO', () => {
    const data = validQuery({ type: 'irrelevant', r: 'wrong_product' });
    const validated = validateFeedbackQuery(data).data;
    const event = buildFeedbackEvent(validated);
    expect(event.created_at).toBeDefined();
    expect(() => new Date(event.created_at)).not.toThrow();
    expect(event.type).toBe('irrelevant');
    expect(event.client_id).toBe('client-test');
  });

  test('FBH-20: now injectable -> created_at utilise la date fournie', () => {
    const fixed = new Date('2026-06-23T12:00:00.000Z');
    const validated = validateFeedbackQuery(validQuery()).data;
    const event = buildFeedbackEvent(validated, fixed);
    expect(event.created_at).toBe('2026-06-23T12:00:00.000Z');
  });

  test('FBH-21: reason transportee dans event si presente dans validated', () => {
    const validated = validateFeedbackQuery(validQuery({ type: 'irrelevant', r: 'wrong_product' })).data;
    const event = buildFeedbackEvent(validated);
    expect(event.reason).toBe('wrong_product');
  });
});

// ---------------------------------------------------------------------------
// FBH-22..24 -- appendFeedbackEventToJsonl (fichier tmp, nettoye)
// ---------------------------------------------------------------------------

describe('FBH-22..24 -- appendFeedbackEventToJsonl', () => {

  test('FBH-22: cree le fichier JSONL si absent et ecrit une ligne JSON', () => {
    const tmp = tmpFile();
    try {
      const event = { client_id: 'c1', type: 'relevant', created_at: '2026-06-23T00:00:00Z' };
      appendFeedbackEventToJsonl(event, tmp);
      expect(fs.existsSync(tmp)).toBe(true);
      const line = fs.readFileSync(tmp, 'utf8').trim();
      const parsed = JSON.parse(line);
      expect(parsed.client_id).toBe('c1');
      expect(parsed.type).toBe('relevant');
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  test('FBH-23: deux appels successifs -> deux lignes JSONL', () => {
    const tmp = tmpFile();
    try {
      appendFeedbackEventToJsonl({ id: 1 }, tmp);
      appendFeedbackEventToJsonl({ id: 2 }, tmp);
      const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).id).toBe(1);
      expect(JSON.parse(lines[1]!).id).toBe(2);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  });

  test('FBH-24: cree le dossier parent si absent', () => {
    const tmpDir = path.join(os.tmpdir(), 'fbh-test-dir-' + Date.now());
    const tmp    = path.join(tmpDir, 'nested', 'feedback.jsonl');
    try {
      appendFeedbackEventToJsonl({ x: 1 }, tmp);
      expect(fs.existsSync(tmp)).toBe(true);
    } finally {
      if (fs.existsSync(tmp))   fs.unlinkSync(tmp);
      if (fs.existsSync(path.join(tmpDir, 'nested')))
        fs.rmdirSync(path.join(tmpDir, 'nested'));
      if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
    }
  });
});

// ---------------------------------------------------------------------------
// FBH-25..28 -- Test E2E local sans serveur :
//   query -> validate -> buildEvent -> appendJsonl(tmp) -> convertisseur dry-run
//   Verifie que wrong_product -> bon_signal_mauvais_contexte
// ---------------------------------------------------------------------------

describe('FBH-25..28 -- E2E local : chain complete sans bot', () => {

  let tmpJSONL: string;

  beforeEach(() => { tmpJSONL = tmpFile(); });
  afterEach(() => { if (fs.existsSync(tmpJSONL)) fs.unlinkSync(tmpJSONL); });

  test('FBH-25: irrelevant + r=wrong_product -> event avec reason=wrong_product', () => {
    const query = {
      client_id: 'test-client-1', radar_type: 'bc', item_id: 'BC-E2E-001',
      critere: 'insecticide', type: 'irrelevant', r: 'wrong_product',
      nid: 'nid-e2e', mt: 'insecticide',
      bt: 'Achat de produits chimiques et insecticides',
    };
    const validation = validateFeedbackQuery(query);
    expect(validation.valid).toBe(true);
    const event = buildFeedbackEvent(validation.data, new Date('2026-06-23T10:00:00Z'));
    expect(event.reason).toBe('wrong_product');
    expect(event.type).toBe('irrelevant');

    appendFeedbackEventToJsonl(event, tmpJSONL);
    const line = JSON.parse(fs.readFileSync(tmpJSONL, 'utf8').trim());
    expect(line.reason).toBe('wrong_product');
    expect(line.type).toBe('irrelevant');
  });

  test('FBH-26: convertisseur dry-run sur tmp -> decision=reject', () => {
    // Ecrire l'event dans tmp
    const query = {
      client_id: 'test-client-1', radar_type: 'bc', item_id: 'BC-E2E-002',
      critere: 'insecticide', type: 'irrelevant', r: 'wrong_product',
      nid: 'nid-e2e-2', mt: 'insecticide',
      bt: 'Achat de produits chimiques et insecticides',
    };
    const event = buildFeedbackEvent(validateFeedbackQuery(query).data,
                                     new Date('2026-06-23T10:00:00Z'));
    appendFeedbackEventToJsonl(event, tmpJSONL);

    // Lancer le convertisseur en dry-run
    const result = cp.spawnSync('node', [
      'scripts/convert-feedback-events-to-review-csv.js',
      '--input', tmpJSONL, '--dry-run',
    ], { cwd: REPO_ROOT, encoding: 'utf8' });

    expect(result.status).toBe(0);
    const out = result.stdout;
    expect(out).toContain('reject=1');
    expect(out).toContain(';reject');
  });

  test('FBH-27: convertisseur dry-run -> human_review_reason=bon_signal_mauvais_contexte', () => {
    const query = {
      client_id: 'test-client-1', radar_type: 'bc', item_id: 'BC-E2E-003',
      critere: 'insecticide', type: 'irrelevant', r: 'wrong_product',
    };
    const event = buildFeedbackEvent(validateFeedbackQuery(query).data,
                                     new Date('2026-06-23T10:00:00Z'));
    appendFeedbackEventToJsonl(event, tmpJSONL);

    const result = cp.spawnSync('node', [
      'scripts/convert-feedback-events-to-review-csv.js',
      '--input', tmpJSONL, '--dry-run',
    ], { cwd: REPO_ROOT, encoding: 'utf8' });

    expect(result.stdout).toContain('bon_signal_mauvais_contexte');
    // Pas hors_profil -- le mapping reason-aware fonctionne
    const lines = result.stdout.split('\n').filter(l => l.includes('BC-E2E-003'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).not.toContain('hors_profil');
  });

  test('FBH-28: convertisseur dry-run -> commentaire contient reason=wrong_product', () => {
    const query = {
      client_id: 'test-client-1', radar_type: 'bc', item_id: 'BC-E2E-004',
      critere: 'insecticide', type: 'irrelevant', r: 'wrong_product',
      nid: 'nid-e2e-4',
    };
    const event = buildFeedbackEvent(validateFeedbackQuery(query).data,
                                     new Date('2026-06-23T10:00:00Z'));
    appendFeedbackEventToJsonl(event, tmpJSONL);

    const result = cp.spawnSync('node', [
      'scripts/convert-feedback-events-to-review-csv.js',
      '--input', tmpJSONL, '--dry-run',
    ], { cwd: REPO_ROOT, encoding: 'utf8' });

    expect(result.stdout).toContain('reason=wrong_product');
    expect(result.stdout).toContain('notif_id=nid-e2e-4');
  });
});

export {};
