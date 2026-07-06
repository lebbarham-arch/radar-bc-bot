/**
 * tests/unit/apply-client-learning-hints.test.ts
 *
 * CLH-1..10 -- Tests unitaires pour scripts/apply-client-learning-hints.js (GD-135)
 *
 * Module pur -- pas de reseau, pas de Supabase, pas de process.env.
 * Pas de modification scoring, guards, seuils ni prod.
 *
 * Couvre :
 *   lookupClientHints(hintsData, clientName, clientId)
 *   applySignalHints(clientHintEntry, signals)
 *   formatHintExplanation(hint)
 */

'use strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  lookupClientHints,
  applySignalHints,
  formatHintExplanation,
} = require('../../scripts/apply-client-learning-hints');

// ---------------------------------------------------------------------------
// Fixtures statiques (indépendantes du fichier JSON de production)
// ---------------------------------------------------------------------------

/** Entrée client avec signal boost positif */
const HINT_BOOST = {
  client: 'client-informatique',
  signals: [
    {
      signal: 'informatique',
      recommended_effect: 'boost',
      score_adjustment: 5,
      block_auto_notify: false,
      sources: ['operator'],
      cycles_count: 4,
    },
    {
      signal: 'logiciel',
      recommended_effect: 'boost',
      score_adjustment: 3,
      block_auto_notify: false,
      sources: ['operator'],
      cycles_count: 2,
    },
  ],
};

/** Entrée client avec signal demote_to_review + block */
const HINT_DEMOTE = {
  client: 'client-nettoyage',
  signals: [
    {
      signal: 'nettoyage',
      recommended_effect: 'demote_to_review',
      score_adjustment: -3,
      block_auto_notify: true,
      sources: ['client'],
      cycles_count: 2,
    },
  ],
};

/** Entrée client avec signal sans ajustement numérique */
const HINT_NO_ADJ = {
  client: 'client-insuf',
  signals: [
    {
      signal: 'cartouches',
      recommended_effect: 'insufficient_data',
      score_adjustment: 0,
      block_auto_notify: true,
      sources: ['operator'],
      cycles_count: 1,
    },
  ],
};

/** HintsData multi-clients */
const HINTS_DATA = {
  clients: [HINT_BOOST, HINT_DEMOTE, HINT_NO_ADJ],
};

// ---------------------------------------------------------------------------
// CLH-1 : boost adj positif en shadow
// ---------------------------------------------------------------------------

describe('CLH-1 -- boost adj positif', () => {
  test('CLH-1a: signal boost -> scoreAdj=5, blockAuto=false', () => {
    const entry  = HINT_BOOST;
    const result = applySignalHints(entry, ['informatique']);
    expect(result.scoreAdj).toBe(5);
    expect(result.blockAuto).toBe(false);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toContain('informatique');
  });

  test('CLH-1b: deux signaux boost -> scoreAdj cumulatif (5+3=8)', () => {
    const result = applySignalHints(HINT_BOOST, ['informatique', 'logiciel']);
    expect(result.scoreAdj).toBe(8);
    expect(result.blockAuto).toBe(false);
    expect(result.applied).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// CLH-2 : demote_to_review adj négatif + block_auto
// ---------------------------------------------------------------------------

describe('CLH-2 -- demote_to_review + block_auto', () => {
  test('CLH-2a: signal demote -> scoreAdj=-3, blockAuto=true', () => {
    const result = applySignalHints(HINT_DEMOTE, ['nettoyage']);
    expect(result.scoreAdj).toBe(-3);
    expect(result.blockAuto).toBe(true);
    expect(result.applied).toHaveLength(1);
  });

  test('CLH-2b: explanations contient effect + adj + source + cycles', () => {
    const result = applySignalHints(HINT_DEMOTE, ['nettoyage']);
    expect(result.explanations).toHaveLength(1);
    const expl = result.explanations[0];
    expect(expl).toContain('demote_to_review');
    expect(expl).toContain('adj=-3');
    expect(expl).toContain('source=client');
    expect(expl).toContain('cycles=2');
  });
});

// ---------------------------------------------------------------------------
// CLH-3 : hint absent / signal non matché -> aucun changement
// ---------------------------------------------------------------------------

describe('CLH-3 -- signal absent -> aucun changement', () => {
  test('CLH-3a: signal inconnu -> scoreAdj=0, blockAuto=false, applied vide', () => {
    const result = applySignalHints(HINT_BOOST, ['signal_inconnu']);
    expect(result.scoreAdj).toBe(0);
    expect(result.blockAuto).toBe(false);
    expect(result.applied).toHaveLength(0);
    expect(result.explanations).toHaveLength(0);
  });

  test('CLH-3b: liste signals vide -> résultat neutre', () => {
    const result = applySignalHints(HINT_BOOST, []);
    expect(result.scoreAdj).toBe(0);
    expect(result.blockAuto).toBe(false);
  });

  test('CLH-3c: entry null -> résultat neutre', () => {
    const result = applySignalHints(null, ['informatique']);
    expect(result.scoreAdj).toBe(0);
    expect(result.blockAuto).toBe(false);
    expect(result.applied).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CLH-4 : client différent -> aucun changement
// ---------------------------------------------------------------------------

describe('CLH-4 -- client différent -> lookup retourne null', () => {
  test('CLH-4a: nom différent -> lookupClientHints retourne null', () => {
    const found = lookupClientHints(HINTS_DATA, 'client-inconnu', undefined);
    expect(found).toBeNull();
  });

  test('CLH-4b: hintsData null -> lookupClientHints retourne null', () => {
    const found = lookupClientHints(null, 'client-informatique', undefined);
    expect(found).toBeNull();
  });

  test('CLH-4c: hintsData sans clients -> lookupClientHints retourne null', () => {
    const found = lookupClientHints({ clients: [] }, 'client-informatique', undefined);
    expect(found).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLH-5 : lookup par nom
// ---------------------------------------------------------------------------

describe('CLH-5 -- lookup par nom (clientName)', () => {
  test('CLH-5a: nom exact -> retourne l\'entrée client', () => {
    const found = lookupClientHints(HINTS_DATA, 'client-nettoyage', undefined);
    expect(found).not.toBeNull();
    expect(found!.client).toBe('client-nettoyage');
  });

  test('CLH-5b: nom présent + id absent -> lookup par nom réussit', () => {
    const found = lookupClientHints(HINTS_DATA, 'client-insuf', null);
    expect(found).not.toBeNull();
    expect(found!.client).toBe('client-insuf');
  });
});

// ---------------------------------------------------------------------------
// CLH-6 : lookup par UUID (clientId)
// ---------------------------------------------------------------------------

describe('CLH-6 -- lookup par UUID (clientId)', () => {
  const UUID_DATA = {
    clients: [
      {
        client: '15a96b88-0c98-4de9-9f66-739e3a28dafa',
        signals: [
          { signal: 'nettoyage', recommended_effect: 'demote_to_review', score_adjustment: -3, block_auto_notify: true, sources: ['client'], cycles_count: 2 },
        ],
      },
    ],
  };

  test('CLH-6a: lookup par UUID exact -> retourne l\'entrée', () => {
    const found = lookupClientHints(UUID_DATA, undefined, '15a96b88-0c98-4de9-9f66-739e3a28dafa');
    expect(found).not.toBeNull();
    expect(found!.client).toBe('15a96b88-0c98-4de9-9f66-739e3a28dafa');
  });

  test('CLH-6b: nom absent + UUID correct -> lookup réussit', () => {
    const found = lookupClientHints(UUID_DATA, null, '15a96b88-0c98-4de9-9f66-739e3a28dafa');
    expect(found).not.toBeNull();
  });

  test('CLH-6c: nom absent + UUID incorrect -> retourne null', () => {
    const found = lookupClientHints(UUID_DATA, null, 'aaaaaaaa-0000-0000-0000-000000000000');
    expect(found).toBeNull();
  });

  test('CLH-6d: nom OU UUID suffit (clientId prioritaire si nom aussi fourni)', () => {
    // L'entrée n'est stockée que par UUID, le nom fourni ne correspond pas
    const found = lookupClientHints(UUID_DATA, 'nom-qui-nexiste-pas', '15a96b88-0c98-4de9-9f66-739e3a28dafa');
    expect(found).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLH-7 : formatHintExplanation
// ---------------------------------------------------------------------------

describe('CLH-7 -- formatHintExplanation', () => {
  test('CLH-7a: format complet learning_hint: effect adj= source= cycles=', () => {
    const hint = {
      signal: 'nettoyage',
      recommended_effect: 'demote_to_review',
      score_adjustment: -3,
      sources: ['client'],
      cycles_count: 2,
    };
    const result = formatHintExplanation(hint);
    expect(result).toBe('learning_hint: demote_to_review adj=-3 source=client cycles=2');
  });

  test('CLH-7b: adj=0 -> pas de adj= dans le résultat', () => {
    const hint = {
      signal: 'cartouches',
      recommended_effect: 'insufficient_data',
      score_adjustment: 0,
      sources: ['operator'],
      cycles_count: 1,
    };
    const result = formatHintExplanation(hint);
    expect(result).not.toContain('adj=');
    expect(result).toContain('learning_hint:');
    expect(result).toContain('insufficient_data');
    expect(result).toContain('source=operator');
  });

  test('CLH-7c: sources multiples -> jointure par +', () => {
    const hint = {
      signal: 'test',
      recommended_effect: 'boost',
      score_adjustment: 5,
      sources: ['client', 'operator'],
      cycles_count: 3,
    };
    const result = formatHintExplanation(hint);
    expect(result).toContain('source=client+operator');
  });

  test('CLH-7d: cycles_count=0 -> pas de cycles= dans le résultat', () => {
    const hint = {
      signal: 'test',
      recommended_effect: 'boost',
      score_adjustment: 5,
      sources: ['operator'],
      cycles_count: 0,
    };
    const result = formatHintExplanation(hint);
    expect(result).not.toContain('cycles=');
  });
});

// ---------------------------------------------------------------------------
// CLH-8 : fixture client réel (UUID 15a96b88) — validation, pas règle codée
// ---------------------------------------------------------------------------

describe('CLH-8 -- fixture client réel 15a96b88', () => {
  // Fixture extraite de data/client-learning/client-learning-hints.json
  // Utilisée comme test de régression, pas comme règle métier codée.
  const REAL_CLIENT_FIXTURE = {
    clients: [
      {
        client: '15a96b88-0c98-4de9-9f66-739e3a28dafa',
        signals: [
          {
            signal: 'nettoyage',
            recommended_effect: 'demote_to_review',
            score_adjustment: -3,
            block_auto_notify: true,
            sources: ['client'],
            cycles_count: 2,
            verdict: 'Ambigu',
          },
        ],
      },
    ],
  };

  test('CLH-8a: lookup par UUID -> entry trouvée', () => {
    const entry = lookupClientHints(REAL_CLIENT_FIXTURE, null, '15a96b88-0c98-4de9-9f66-739e3a28dafa');
    expect(entry).not.toBeNull();
  });

  test('CLH-8b: signal nettoyage -> demote_to_review, scoreAdj=-3, blockAuto=true', () => {
    const entry  = lookupClientHints(REAL_CLIENT_FIXTURE, null, '15a96b88-0c98-4de9-9f66-739e3a28dafa');
    const result = applySignalHints(entry!, ['nettoyage']);
    expect(result.scoreAdj).toBe(-3);
    expect(result.blockAuto).toBe(true);
    expect(result.applied[0]).toContain('nettoyage');
    expect(result.applied[0]).toContain('demote_to_review');
  });

  test('CLH-8c: explication contient learning_hint: demote_to_review adj=-3 source=client cycles=2', () => {
    const entry  = lookupClientHints(REAL_CLIENT_FIXTURE, null, '15a96b88-0c98-4de9-9f66-739e3a28dafa');
    const result = applySignalHints(entry!, ['nettoyage']);
    expect(result.explanations[0]).toBe('learning_hint: demote_to_review adj=-3 source=client cycles=2');
  });
});

// ---------------------------------------------------------------------------
// CLH-9 : prod/legacy non impacté — module pur, pas d'effet de bord
// ---------------------------------------------------------------------------

describe('CLH-9 -- module pur sans effet de bord', () => {
  test('CLH-9a: applySignalHints ne modifie pas l\'entry passée en entrée', () => {
    const entry = {
      client: 'test',
      signals: [
        { signal: 'x', recommended_effect: 'boost', score_adjustment: 5, block_auto_notify: false, sources: [], cycles_count: 1 },
      ],
    };
    const signalsBefore = JSON.stringify(entry.signals);
    applySignalHints(entry, ['x']);
    expect(JSON.stringify(entry.signals)).toBe(signalsBefore);
  });

  test('CLH-9b: lookupClientHints ne modifie pas hintsData', () => {
    const data   = JSON.parse(JSON.stringify(HINTS_DATA));
    const before = JSON.stringify(data);
    lookupClientHints(data, 'client-informatique', null);
    expect(JSON.stringify(data)).toBe(before);
  });

  test('CLH-9c: deux appels successifs retournent des résultats identiques (pur)', () => {
    const r1 = applySignalHints(HINT_DEMOTE, ['nettoyage']);
    const r2 = applySignalHints(HINT_DEMOTE, ['nettoyage']);
    expect(r1.scoreAdj).toBe(r2.scoreAdj);
    expect(r1.blockAuto).toBe(r2.blockAuto);
    expect(r1.explanations).toEqual(r2.explanations);
  });
});

// ---------------------------------------------------------------------------
// CLH-10 : multiple signaux correspondants — cumul + block partiel
// ---------------------------------------------------------------------------

describe('CLH-10 -- plusieurs signaux correspondants', () => {
  const MULTI_HINT = {
    client: 'multi-client',
    signals: [
      { signal: 'a', recommended_effect: 'boost',          score_adjustment:  5, block_auto_notify: false, sources: ['operator'], cycles_count: 3 },
      { signal: 'b', recommended_effect: 'boost',          score_adjustment:  3, block_auto_notify: false, sources: ['operator'], cycles_count: 2 },
      { signal: 'c', recommended_effect: 'demote_to_review', score_adjustment: -2, block_auto_notify: true,  sources: ['client'],   cycles_count: 1 },
    ],
  };

  test('CLH-10a: signaux [a, b] -> scoreAdj=8, blockAuto=false', () => {
    const result = applySignalHints(MULTI_HINT, ['a', 'b']);
    expect(result.scoreAdj).toBe(8);
    expect(result.blockAuto).toBe(false);
    expect(result.applied).toHaveLength(2);
  });

  test('CLH-10b: signaux [a, b, c] -> scoreAdj=6, blockAuto=true (un seul block suffit)', () => {
    const result = applySignalHints(MULTI_HINT, ['a', 'b', 'c']);
    expect(result.scoreAdj).toBe(6); // 5 + 3 - 2
    expect(result.blockAuto).toBe(true);
    expect(result.applied).toHaveLength(3);
    expect(result.explanations).toHaveLength(3);
  });

  test('CLH-10c: signal [c] seul -> scoreAdj=-2, blockAuto=true', () => {
    const result = applySignalHints(MULTI_HINT, ['c']);
    expect(result.scoreAdj).toBe(-2);
    expect(result.blockAuto).toBe(true);
  });

  test('CLH-10d: signal non présent dans hints [d] -> scoreAdj=0 malgré autres signaux dans entry', () => {
    const result = applySignalHints(MULTI_HINT, ['d']);
    expect(result.scoreAdj).toBe(0);
    expect(result.blockAuto).toBe(false);
    expect(result.applied).toHaveLength(0);
  });
});

export {};
