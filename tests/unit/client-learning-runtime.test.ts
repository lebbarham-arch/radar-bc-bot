/*
 * Pont runtime entre les hints d'apprentissage client et le quality gate.
 *
 * Politique verrouillee par ces tests :
 *   - flag desactive par defaut : aucun changement ;
 *   - fail-open sur fichier absent / JSON invalide ;
 *   - resolution du client par client_id exact, jamais par nom ;
 *   - seul demote_to_review avec preuves suffisantes durcit allow -> block ;
 *   - aucune transition block -> allow, aucun envoi force.
 *
 * Nomenclature : CLR-N (loader) - GATE-N (integration quality gate).
 */

'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const learning = require('../../core/learning/client-learning-runtime.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gate = require('../../core/scoring/notification-quality-gate.runtime.js');

const CLIENT_A = '15a96b88-0c98-4de9-9f66-739e3a28dafa';
const CLIENT_B = '99999999-0000-4000-8000-000000000000';

interface Hint {
  signal: string;
  keep: number;
  reject: number;
  ignore: number;
  total: number;
  cycles_count: number;
  recommended_effect: string;
  block_auto_notify: boolean;
  reason?: string;
}

/** Hint satisfaisant integralement la politique stricte. */
function blockingHint(signal: string): Hint {
  return {
    signal,
    keep: 4,
    reject: 8,
    ignore: 2,
    total: 14,
    cycles_count: 3,
    recommended_effect: 'demote_to_review',
    block_auto_notify: true,
    reason: 'preuves suffisantes',
  };
}

let tmpDir: string;
let hintsPath: string;

function writeHints(payload: unknown): void {
  fs.writeFileSync(hintsPath, JSON.stringify(payload), 'utf8');
  learning.resetCache();
}

function writeRaw(content: string): void {
  fs.writeFileSync(hintsPath, content, 'utf8');
  learning.resetCache();
}

function removeHints(): void {
  if (fs.existsSync(hintsPath)) fs.unlinkSync(hintsPath);
  learning.resetCache();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-learning-runtime-'));
  hintsPath = path.join(tmpDir, 'client-learning-hints.json');
  process.env.CLIENT_LEARNING_RUNTIME_HINTS_PATH = hintsPath;
  delete process.env.CLIENT_LEARNING_RUNTIME_ENABLED;
  learning.resetCache();
});

afterEach(() => {
  delete process.env.CLIENT_LEARNING_RUNTIME_HINTS_PATH;
  delete process.env.CLIENT_LEARNING_RUNTIME_ENABLED;
  learning.resetCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe('client-learning-runtime - feature flag', () => {
  test('CLR-1 desactive par defaut', () => {
    expect(learning.isRuntimeLearningEnabled(undefined)).toBe(false);
    expect(learning.isRuntimeLearningEnabled(null)).toBe(false);
    expect(learning.isRuntimeLearningEnabled('')).toBe(false);
    expect(learning.isRuntimeLearningEnabled('false')).toBe(false);
    expect(learning.isRuntimeLearningEnabled('0')).toBe(false);
    expect(learning.isRuntimeLearningEnabled('yes')).toBe(false);
  });

  test('CLR-2 active uniquement sur 1 ou true', () => {
    expect(learning.isRuntimeLearningEnabled('1')).toBe(true);
    expect(learning.isRuntimeLearningEnabled('true')).toBe(true);
    expect(learning.isRuntimeLearningEnabled('TRUE')).toBe(true);
    expect(learning.isRuntimeLearningEnabled(' true ')).toBe(true);
  });

  test('CLR-3 flag desactive : aucun changement meme avec hint bloquant', () => {
    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });

    const verdict = learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_A,
      critereValeur: 'nettoyage',
      env: { CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });

    expect(verdict).toBeNull();
  });
});

describe('client-learning-runtime - fail-open', () => {
  test('CLR-4 fichier absent : index vide, aucun verdict', () => {
    removeHints();

    const index = learning.loadHintsIndex({
      env: { CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });
    expect(Object.keys(index)).toHaveLength(0);

    const verdict = learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_A,
      critereValeur: 'nettoyage',
      env: { CLIENT_LEARNING_RUNTIME_ENABLED: 'true', CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });
    expect(verdict).toBeNull();
  });

  test('CLR-5 JSON invalide : index vide, aucune exception', () => {
    writeRaw('{ ceci nest pas du json');

    expect(() =>
      learning.loadHintsIndex({ env: { CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath } })
    ).not.toThrow();

    const verdict = learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_A,
      critereValeur: 'nettoyage',
      env: { CLIENT_LEARNING_RUNTIME_ENABLED: 'true', CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });
    expect(verdict).toBeNull();
  });

  test('CLR-6 structure inattendue : ignoree silencieusement', () => {
    writeHints({ clients: 'pas-un-tableau' });
    const index = learning.loadHintsIndex({
      env: { CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });
    expect(Object.keys(index)).toHaveLength(0);

    writeHints({ clients: [{ client: CLIENT_A, signals: null }, null, 42] });
    const index2 = learning.loadHintsIndex({
      env: { CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });
    expect(Object.keys(index2)).toHaveLength(0);
  });
});

describe('client-learning-runtime - resolution client et signal', () => {
  test('CLR-7 client_id different : aucun verdict', () => {
    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });

    const verdict = learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_B,
      critereValeur: 'nettoyage',
      env: { CLIENT_LEARNING_RUNTIME_ENABLED: 'true', CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });

    expect(verdict).toBeNull();
  });

  test('CLR-8 nom du client jamais utilise comme repli', () => {
    writeHints({
      clients: [{ client: 'TEST PROD - Fournitures Bureau', signals: [blockingHint('cartouches')] }],
    });

    const verdict = learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_A,
      critereValeur: 'cartouches',
      env: { CLIENT_LEARNING_RUNTIME_ENABLED: 'true', CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });

    expect(verdict).toBeNull();
  });

  test('CLR-9 signal different : aucun verdict', () => {
    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });

    const verdict = learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_A,
      critereValeur: 'transport',
      env: { CLIENT_LEARNING_RUNTIME_ENABLED: 'true', CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });

    expect(verdict).toBeNull();
  });

  test('CLR-10 normalisation accents casse espaces du signal', () => {
    expect(learning.normalizeSignal('  NETTOYAGE  ')).toBe('nettoyage');
    expect(learning.normalizeSignal('Securite Incendie')).toBe('securite incendie');
    expect(learning.normalizeSignal('MAINTENANCE   preventive')).toBe('maintenance preventive');

    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('securite incendie')] }] });

    const verdict = learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_A,
      critereValeur: '  Securite   Incendie ',
      env: { CLIENT_LEARNING_RUNTIME_ENABLED: 'true', CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });

    expect(verdict).not.toBeNull();
    expect(verdict.decision).toBe('block');
  });

  test('CLR-11 client_id vide ou absent : aucun verdict', () => {
    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });
    const env = { CLIENT_LEARNING_RUNTIME_ENABLED: 'true', CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath };

    expect(
      learning.evaluateLearningDecision({ gateDecision: 'allow', clientId: null, critereValeur: 'nettoyage', env })
    ).toBeNull();
    expect(
      learning.evaluateLearningDecision({ gateDecision: 'allow', clientId: '', critereValeur: 'nettoyage', env })
    ).toBeNull();
    expect(
      learning.evaluateLearningDecision({ gateDecision: 'allow', clientId: '   ', critereValeur: 'nettoyage', env })
    ).toBeNull();
  });
});

describe('client-learning-runtime - politique stricte des preuves', () => {
  const env = () => ({
    CLIENT_LEARNING_RUNTIME_ENABLED: 'true',
    CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath,
  });

  function verdictFor(hint: Partial<Hint>) {
    const merged = Object.assign(blockingHint('nettoyage'), hint);
    writeHints({ clients: [{ client: CLIENT_A, signals: [merged] }] });
    return learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_A,
      critereValeur: 'nettoyage',
      env: env(),
    });
  }

  test('CLR-12 preuves suffisantes : allow devient block', () => {
    const verdict = verdictFor({});
    expect(verdict).not.toBeNull();
    expect(verdict.decision).toBe('block');
    expect(verdict.effect).toBe('demote_to_review');
    expect(verdict.client_id).toBe(CLIENT_A);
    expect(verdict.signal).toBe('nettoyage');
    expect(verdict.total).toBe(14);
    expect(verdict.cycles_count).toBe(3);
  });

  test('CLR-13 total insuffisant : aucun blocage', () => {
    expect(verdictFor({ total: 4, keep: 1, reject: 2, ignore: 1 })).toBeNull();
  });

  test('CLR-14 cycles insuffisants : aucun blocage', () => {
    expect(verdictFor({ cycles_count: 1 })).toBeNull();
  });

  test('CLR-15 reject + ignore non superieur a keep : aucun blocage', () => {
    expect(verdictFor({ keep: 10, reject: 3, ignore: 2, total: 15 })).toBeNull();
    expect(verdictFor({ keep: 7, reject: 5, ignore: 2, total: 14 })).toBeNull();
  });

  test('CLR-16 block_auto_notify absent ou faux : aucun blocage', () => {
    expect(verdictFor({ block_auto_notify: false })).toBeNull();
    const withoutFlag = blockingHint('nettoyage') as Partial<Hint>;
    delete withoutFlag.block_auto_notify;
    writeHints({ clients: [{ client: CLIENT_A, signals: [withoutFlag] }] });
    expect(
      learning.evaluateLearningDecision({
        gateDecision: 'allow',
        clientId: CLIENT_A,
        critereValeur: 'nettoyage',
        env: env(),
      })
    ).toBeNull();
  });

  test('CLR-17 compteurs non numeriques : aucun blocage', () => {
    expect(verdictFor({ total: 'beaucoup' as unknown as number })).toBeNull();
    expect(verdictFor({ keep: null as unknown as number })).toBeNull();
  });
});

describe('client-learning-runtime - effets consultatifs', () => {
  const env = () => ({
    CLIENT_LEARNING_RUNTIME_ENABLED: 'true',
    CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath,
  });

  function verdictForEffect(effect: string) {
    const hint = Object.assign(blockingHint('nettoyage'), { recommended_effect: effect });
    writeHints({ clients: [{ client: CLIENT_A, signals: [hint] }] });
    return learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_A,
      critereValeur: 'nettoyage',
      env: env(),
    });
  }

  test('CLR-18 boost reste consultatif et ne force jamais allow', () => {
    expect(verdictForEffect('boost')).toBeNull();
  });

  test('CLR-19 keep_review ne bloque pas dans cette version', () => {
    expect(verdictForEffect('keep_review')).toBeNull();
  });

  test('CLR-20 insufficient_data reste consultatif', () => {
    expect(verdictForEffect('insufficient_data')).toBeNull();
  });

  test('CLR-21 effet inconnu reste consultatif', () => {
    expect(verdictForEffect('effet_inexistant')).toBeNull();
    expect(verdictForEffect('')).toBeNull();
  });
});

describe('client-learning-runtime - sens unique de la decision', () => {
  test('CLR-22 une decision block reste block, jamais convertie en allow', () => {
    writeHints({
      clients: [
        {
          client: CLIENT_A,
          signals: [
            Object.assign(blockingHint('nettoyage'), {
              recommended_effect: 'boost',
              block_auto_notify: false,
            }),
          ],
        },
      ],
    });

    const verdict = learning.evaluateLearningDecision({
      gateDecision: 'block',
      clientId: CLIENT_A,
      critereValeur: 'nettoyage',
      env: { CLIENT_LEARNING_RUNTIME_ENABLED: 'true', CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });

    expect(verdict).toBeNull();
  });

  test('CLR-23 aucun verdict ne retourne jamais allow', () => {
    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });

    const verdict = learning.evaluateLearningDecision({
      gateDecision: 'allow',
      clientId: CLIENT_A,
      critereValeur: 'nettoyage',
      env: { CLIENT_LEARNING_RUNTIME_ENABLED: 'true', CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath },
    });

    expect(verdict.decision).not.toBe('allow');
    expect(verdict.decision).toBe('block');
  });
});

describe('client-learning-runtime - cache mtime', () => {
  test('CLR-24 le cache se rafraichit quand le fichier change', () => {
    const opts = { env: { CLIENT_LEARNING_RUNTIME_HINTS_PATH: hintsPath } };

    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });
    expect(learning.lookupHint(CLIENT_A, 'nettoyage', opts)).not.toBeNull();

    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('transport')] }] });
    expect(learning.lookupHint(CLIENT_A, 'nettoyage', opts)).toBeNull();
    expect(learning.lookupHint(CLIENT_A, 'transport', opts)).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Integration avec le quality gate de production                      */
/* ------------------------------------------------------------------ */

describe('quality gate - integration learning', () => {
  const allowInput = {
    critere_valeur: 'nettoyage',
    objet: "Achat de produits d entretien et d hygiene",
    bodyText: '',
    matched_terms: ['nettoyage'],
    radar_type: 'bc',
    is_cancelled: false,
    client_id: CLIENT_A,
  };

  test('GATE-1 flag desactive : la decision du gate est inchangee', () => {
    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });

    const result = gate.checkNotificationQuality(allowInput);

    expect(result.decision).toBe('allow');
    expect(result.learning_applied).toBeUndefined();
  });

  test('GATE-2 flag actif et preuves suffisantes : allow devient block', () => {
    process.env.CLIENT_LEARNING_RUNTIME_ENABLED = 'true';
    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });

    const result = gate.checkNotificationQuality(allowInput);

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('Revue requise');
    expect(result.learning_applied).toBe(true);
    expect(result.learning.client_id).toBe(CLIENT_A);
    expect(result.learning.effect).toBe('demote_to_review');
  });

  test('GATE-3 flag actif mais preuves insuffisantes : allow conserve', () => {
    process.env.CLIENT_LEARNING_RUNTIME_ENABLED = 'true';
    const weak = Object.assign(blockingHint('nettoyage'), { total: 3, cycles_count: 1 });
    writeHints({ clients: [{ client: CLIENT_A, signals: [weak] }] });

    const result = gate.checkNotificationQuality(allowInput);

    expect(result.decision).toBe('allow');
    expect(result.learning_applied).toBeUndefined();
  });

  test('GATE-4 boost ne transforme jamais block en allow', () => {
    process.env.CLIENT_LEARNING_RUNTIME_ENABLED = 'true';
    const boost = Object.assign(blockingHint('nettoyage'), { recommended_effect: 'boost' });
    writeHints({ clients: [{ client: CLIENT_A, signals: [boost] }] });

    // Objet ambigu : le gate metier bloque deja.
    const result = gate.checkNotificationQuality({
      critere_valeur: 'nettoyage',
      objet: 'Travaux de reparation de batiment avec nettoyage final',
      bodyText: '',
      matched_terms: ['nettoyage'],
      radar_type: 'bc',
      is_cancelled: false,
      client_id: CLIENT_A,
    });

    expect(result.decision).toBe('block');
    expect(result.learning_applied).toBeUndefined();
  });

  test('GATE-5 fichier absent : le gate se comporte comme avant', () => {
    process.env.CLIENT_LEARNING_RUNTIME_ENABLED = 'true';
    removeHints();

    const result = gate.checkNotificationQuality(allowInput);
    expect(result.decision).toBe('allow');
    expect(result.learning_applied).toBeUndefined();
  });

  test('GATE-6 sans client_id le learning ne s applique jamais', () => {
    process.env.CLIENT_LEARNING_RUNTIME_ENABLED = 'true';
    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });

    const noClient = Object.assign({}, allowInput);
    delete (noClient as { client_id?: string }).client_id;

    const result = gate.checkNotificationQuality(noClient);
    expect(result.decision).toBe('allow');
    expect(result.learning_applied).toBeUndefined();
  });

  test('GATE-7 le coeur metier reste accessible et non modifie', () => {
    process.env.CLIENT_LEARNING_RUNTIME_ENABLED = 'true';
    writeHints({ clients: [{ client: CLIENT_A, signals: [blockingHint('nettoyage')] }] });

    const core = gate.checkNotificationQualityCore(allowInput);
    expect(core.decision).toBe('allow');
    expect(core.learning_applied).toBeUndefined();
  });
});
