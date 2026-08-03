/*
 * Identite client canonique pour les historiques learning.
 *
 * Politique verrouillee :
 *   - UUID toujours prioritaire ;
 *   - nom = metadonnee d'affichage, jamais cle de production ;
 *   - rattachement nom -> UUID uniquement sur preuve explicite ;
 *   - collision ou absence de preuve = historiques separes, non executoires.
 *
 * Nomenclature : CID-N.
 */

'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ident = require('../../scripts/client-identity-utils.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const runtime = require('../../core/learning/client-learning-runtime.js');

const UUID_A = '15a96b88-0c98-4de9-9f66-739e3a28dafa';
const UUID_B = '99999999-0000-4000-8000-000000000000';
const NAME_A = 'TEST PROD - Nettoyage Hygiène';
const NAME_A_VARIANT = 'TEST PROD - Nettoyage Hygiene';

/* ------------------------------------------------------------------ */

describe('client-identity - primitives', () => {
  test('CID-1 reconnait un UUID canonique et rejette le reste', () => {
    expect(ident.isUuid(UUID_A)).toBe(true);
    expect(ident.isUuid(UUID_A.toUpperCase())).toBe(true);
    expect(ident.isUuid(NAME_A)).toBe(false);
    expect(ident.isUuid('')).toBe(false);
    expect(ident.isUuid(null)).toBe(false);
    expect(ident.isUuid('15a96b88-0c98-4de9-9f66')).toBe(false);
  });

  test('CID-2 canonicalUuid normalise la casse, vide sinon', () => {
    expect(ident.canonicalUuid('  ' + UUID_A.toUpperCase() + ' ')).toBe(UUID_A);
    expect(ident.canonicalUuid(NAME_A)).toBe('');
  });

  test('CID-3 client_id est prioritaire sur tous les autres champs', () => {
    const r = ident.extractRawIdentity({
      client_id: UUID_A,
      clientId: UUID_B,
      client: NAME_A,
      client_name: 'autre libelle',
    });
    expect(r.uuid).toBe(UUID_A);
    expect(r.name).toBe('autre libelle');
  });

  test('CID-4 `client` fournit l UUID s il en contient un, sinon le nom', () => {
    expect(ident.extractRawIdentity({ client: UUID_A }).uuid).toBe(UUID_A);
    expect(ident.extractRawIdentity({ client: UUID_A }).name).toBe('');

    const byName = ident.extractRawIdentity({ client: NAME_A });
    expect(byName.uuid).toBe('');
    expect(byName.name).toBe(NAME_A);
  });
});

describe('client-identity - registre de preuves', () => {
  test('CID-5 une paire UUID+nom constitue une preuve', () => {
    const reg = ident.buildIdentityRegistry([{ uuid: UUID_A, name: NAME_A }]);
    expect(reg.byNameKey['test prod nettoyage hygiene']).toEqual([UUID_A]);
    expect(reg.displayName[UUID_A]).toBe(NAME_A);
    expect(reg.collisions).toHaveLength(0);
  });

  test('CID-6 une paire incomplete n est jamais une preuve', () => {
    const reg = ident.buildIdentityRegistry([
      { uuid: UUID_A, name: '' },
      { uuid: '', name: NAME_A },
      { uuid: 'pas-un-uuid', name: NAME_A },
      null,
    ]);
    expect(Object.keys(reg.byNameKey)).toHaveLength(0);
  });

  test('CID-7 variantes typographiques du meme nom partagent la cle', () => {
    const reg = ident.buildIdentityRegistry([
      { uuid: UUID_A, name: NAME_A },
      { uuid: UUID_A, name: NAME_A_VARIANT },
    ]);
    expect(reg.byNameKey['test prod nettoyage hygiene']).toEqual([UUID_A]);
    expect(reg.aliasesByUuid[UUID_A].sort()).toEqual([NAME_A_VARIANT, NAME_A].sort());
  });

  test('CID-8 un nom pour deux UUID produit une collision', () => {
    const reg = ident.buildIdentityRegistry([
      { uuid: UUID_A, name: NAME_A },
      { uuid: UUID_B, name: NAME_A_VARIANT },
    ]);
    expect(reg.collisions).toHaveLength(1);
    expect(reg.collisions[0].uuids.sort()).toEqual([UUID_A, UUID_B].sort());
  });

  test('CID-9 preuves collectees depuis les decisions portant UUID + nom', () => {
    const pairs = ident.collectEvidenceFromRecords([
      { client: UUID_A, client_name: NAME_A },
      { client: NAME_A },                       // pas de preuve
      { client_id: UUID_B },                    // pas de preuve
    ]);
    expect(pairs).toEqual([{ uuid: UUID_A, name: NAME_A }]);
  });

  test('CID-10 preuves lues depuis l etat du cycle, fail-open si absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-identity-'));
    try {
      const stateFile = path.join(tmp, 'state.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        version: 2,
        streams: {
          [`${UUID_A}|bc`]: { client_id: UUID_A, client_name: NAME_A, radar_type: 'bc' },
        },
      }), 'utf8');

      expect(ident.readEvidenceFromCycleState(stateFile))
        .toEqual([{ uuid: UUID_A, name: NAME_A }]);

      expect(ident.readEvidenceFromCycleState(path.join(tmp, 'absent.json'))).toEqual([]);

      fs.writeFileSync(stateFile, '{ invalide', 'utf8');
      expect(ident.readEvidenceFromCycleState(stateFile)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('client-identity - resolution', () => {
  const registry = ident.buildIdentityRegistry([{ uuid: UUID_A, name: NAME_A }]);

  test('CID-11 decision UUID seul : resolue via client_id', () => {
    const r = ident.resolveClientIdentity({ client: UUID_A }, registry);
    expect(r.resolved).toBe(true);
    expect(r.via).toBe('client_id');
    expect(r.key).toBe(UUID_A);
    expect(r.client_id).toBe(UUID_A);
    expect(r.warning).toBeNull();
  });

  test('CID-12 decision nom seul sans preuve : non resolue, non executoire', () => {
    const empty = ident.buildIdentityRegistry([]);
    const r = ident.resolveClientIdentity({ client: 'TEST PROD - Informatique' }, empty);
    expect(r.resolved).toBe(false);
    expect(r.client_id).toBe('');
    expect(r.key).toBe('test prod informatique');
    expect(r.warning).toContain('aucune preuve');
  });

  test('CID-13 decision UUID + nom : consolidation sous l UUID', () => {
    const r = ident.resolveClientIdentity({ client_id: UUID_A, client_name: NAME_A }, registry);
    expect(r.key).toBe(UUID_A);
    expect(r.client_name).toBe(NAME_A);
    expect(r.resolved).toBe(true);
  });

  test('CID-14 nom relie par preuve : rattache a l UUID', () => {
    const r = ident.resolveClientIdentity({ client: NAME_A }, registry);
    expect(r.resolved).toBe(true);
    expect(r.via).toBe('evidence');
    expect(r.key).toBe(UUID_A);
    expect(r.client_id).toBe(UUID_A);
  });

  test('CID-15 variante d accent et de casse du nom relie : meme UUID', () => {
    const variants = [NAME_A_VARIANT, NAME_A.toUpperCase(), '  test prod - nettoyage hygiene  '];
    variants.forEach((v) => {
      const r = ident.resolveClientIdentity({ client: v }, registry);
      expect(r.resolved).toBe(true);
      expect(r.key).toBe(UUID_A);
    });
  });

  test('CID-16 collision : aucune fusion automatique, avertissement d audit', () => {
    const colliding = ident.buildIdentityRegistry([
      { uuid: UUID_A, name: NAME_A },
      { uuid: UUID_B, name: NAME_A_VARIANT },
    ]);
    const r = ident.resolveClientIdentity({ client: NAME_A }, colliding);
    expect(r.resolved).toBe(false);
    expect(r.client_id).toBe('');
    expect(r.key).toBe('test prod nettoyage hygiene');
    expect(r.warning).toContain('plusieurs UUID');
  });

  test('CID-17 identite absente : cle inconnue, non executoire', () => {
    const r = ident.resolveClientIdentity({}, registry);
    expect(r.resolved).toBe(false);
    expect(r.key).toBe('(inconnu)');
    expect(r.warning).toContain('absente');
  });

  test('CID-18 deduplication last-wins apres canonicalisation', () => {
    // Le meme BC vu sous l UUID puis sous le nom relie ne compte qu une fois.
    const records = [
      { client: UUID_A, bc_id: 'BC-1', decision: 'keep' },
      { client: NAME_A, bc_id: 'BC-1', decision: 'reject' },
      { client: NAME_A_VARIANT, bc_id: 'BC-2', decision: 'keep' },
    ];
    const map: Record<string, unknown> = {};
    records.forEach((r) => {
      const k = ident.resolveClientIdentity(r, registry).key + '::' + r.bc_id;
      map[k] = r;
    });
    expect(Object.keys(map).sort()).toEqual([
      `${UUID_A}::BC-1`,
      `${UUID_A}::BC-2`,
    ]);
    // last-wins : la derniere decision sur BC-1 l emporte
    expect((map[`${UUID_A}::BC-1`] as { decision: string }).decision).toBe('reject');
  });

  test('CID-19 le nom ne sert jamais de cle quand un UUID est connu', () => {
    const r = ident.resolveClientIdentity({ client_id: UUID_B, client_name: NAME_A }, registry);
    // NAME_A pointe vers UUID_A dans le registre, mais client_id prime.
    expect(r.key).toBe(UUID_B);
    expect(r.client_id).toBe(UUID_B);
  });
});

/* ------------------------------------------------------------------ */
/* Runtime : lookup strictement par UUID                               */
/* ------------------------------------------------------------------ */

describe('runtime - lookup par UUID uniquement', () => {
  let tmpDir: string;
  let hintsPath: string;

  const blockingSignal = (signal: string) => ({
    signal, keep: 4, reject: 8, ignore: 2, total: 14, cycles_count: 3,
    recommended_effect: 'demote_to_review', block_auto_notify: true,
  });

  function writeHints(payload: unknown): void {
    fs.writeFileSync(hintsPath, JSON.stringify(payload), 'utf8');
    runtime.resetCache();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-runtime-identity-'));
    hintsPath = path.join(tmpDir, 'hints.json');
    process.env.CLIENT_LEARNING_RUNTIME_HINTS_PATH = hintsPath;
    delete process.env.CLIENT_LEARNING_RUNTIME_ENABLED;
    runtime.resetCache();
  });

  afterEach(() => {
    delete process.env.CLIENT_LEARNING_RUNTIME_HINTS_PATH;
    delete process.env.CLIENT_LEARNING_RUNTIME_ENABLED;
    runtime.resetCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const opts = () => ({ env: { CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath } });

  test('CID-20 client_id indexe en priorite', () => {
    writeHints({
      clients: [{
        client: UUID_A, client_id: UUID_A, client_name: NAME_A,
        aliases: [NAME_A, NAME_A_VARIANT],
        signals: [blockingSignal('nettoyage')],
      }],
    });
    expect(runtime.lookupHint(UUID_A, 'nettoyage', opts())).not.toBeNull();
  });

  test('CID-21 `client` accepte uniquement s il contient un UUID', () => {
    writeHints({ clients: [{ client: UUID_A, signals: [blockingSignal('nettoyage')] }] });
    expect(runtime.lookupHint(UUID_A, 'nettoyage', opts())).not.toBeNull();

    writeHints({ clients: [{ client: NAME_A, signals: [blockingSignal('nettoyage')] }] });
    expect(runtime.lookupHint(NAME_A, 'nettoyage', opts())).toBeNull();
  });

  test('CID-22 client_name n est jamais une cle de lookup', () => {
    writeHints({
      clients: [{
        client: UUID_A, client_id: UUID_A, client_name: NAME_A,
        signals: [blockingSignal('nettoyage')],
      }],
    });
    expect(runtime.lookupHint(NAME_A, 'nettoyage', opts())).toBeNull();
    expect(runtime.lookupHint(NAME_A_VARIANT, 'nettoyage', opts())).toBeNull();
  });

  test('CID-23 aliases ne sont jamais une cle de lookup', () => {
    writeHints({
      clients: [{
        client: UUID_A, client_id: UUID_A, client_name: NAME_A,
        aliases: ['ANCIEN LIBELLE', NAME_A_VARIANT],
        signals: [blockingSignal('nettoyage')],
      }],
    });
    expect(runtime.lookupHint('ANCIEN LIBELLE', 'nettoyage', opts())).toBeNull();
    expect(runtime.lookupHint(NAME_A_VARIANT, 'nettoyage', opts())).toBeNull();
    expect(runtime.lookupHint(UUID_A, 'nettoyage', opts())).not.toBeNull();
  });

  test('CID-24 unresolved_clients n est jamais indexe', () => {
    writeHints({
      clients: [],
      unresolved_clients: [{
        client_key: 'test prod informatique',
        client_name: 'TEST PROD - Informatique',
        executable: false,
        signals: [blockingSignal('informatique')],
      }],
    });
    expect(runtime.lookupHint('TEST PROD - Informatique', 'informatique', opts())).toBeNull();
    expect(runtime.lookupHint('test prod informatique', 'informatique', opts())).toBeNull();
  });

  test('CID-25 historique consolide : un seul lookup UUID couvre tout', () => {
    // Reproduit le cas reel : deux historiques fragmentes fusionnes.
    writeHints({
      clients: [{
        client: UUID_A, client_id: UUID_A, client_name: NAME_A,
        aliases: [NAME_A, NAME_A_VARIANT],
        signals: [{
          signal: 'nettoyage', keep: 46, reject: 22, ignore: 1, total: 69,
          cycles_count: 13, recommended_effect: 'demote_to_review', block_auto_notify: true,
        }],
      }],
    });

    const hint = runtime.lookupHint(UUID_A, 'nettoyage', opts());
    expect(hint).not.toBeNull();
    expect(hint.total).toBe(69);      // 27 + 42 consolides
    expect(hint.keep).toBe(46);       // 12 + 34
    expect(hint.reject).toBe(22);     // 15 + 7
    expect(hint.cycles_count).toBe(13);
  });

  test('CID-26 feature flag desactive : aucune decision modifiee', () => {
    writeHints({
      clients: [{
        client: UUID_A, client_id: UUID_A, signals: [blockingSignal('nettoyage')],
      }],
    });
    const verdict = runtime.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: UUID_A,
      critereValeur: 'nettoyage',
      env: { CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });
    expect(verdict).toBeNull();
  });

  test('CID-27 un client_id non UUID ne peut jamais declencher un blocage', () => {
    writeHints({ clients: [{ client: NAME_A, signals: [blockingSignal('nettoyage')] }] });
    const verdict = runtime.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: NAME_A,
      critereValeur: 'nettoyage',
      env: {
        CLIENT_LEARNING_RUNTIME_ENABLED: 'true',
        CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath,
      },
    });
    expect(verdict).toBeNull();
  });
});
