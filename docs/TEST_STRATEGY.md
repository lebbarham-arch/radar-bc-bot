# Test Strategy — Anaho

## Principes

1. **Tests non-régression avant tout** : un bug corrigé est couvert par un test avant le merge.
2. **Golden dataset comme référence** : tout changement de scoring est validé contre le dataset annoté.
3. **Pas de test sur le scraping** : le scraping Puppeteer est trop couplé au portail tiers. On teste ce qui sort du scraping, pas le scraping lui-même.
4. **Tests rapides par défaut** : la suite principale tourne en < 30 secondes sans dépendances réseau.

---

## Structure des tests

```
tests/
├── fixtures/
│   ├── golden_dataset.json        ← Cas annotés manuellement (source de vérité)
│   ├── bc_samples/
│   │   ├── bc_cable_reseau.json   ← BC réel anonymisé
│   │   ├── bc_peinture_lycee.json ← Faux positif de référence
│   │   └── bc_fourniture_bu.json  ← BC générique
│   └── clients/
│       ├── client_reseau.json     ← Profil fournisseur réseau
│       └── client_imprimerie.json ← Profil imprimerie
│
├── schemas.test.js                ← Validation Zod : parse/reject
├── scoring.test.js                ← Score déterministe : calcul + signaux
├── matching.test.js               ← Matching v2 : score vs booléen legacy
├── exclusions.test.js             ← Règles d'exclusion contextuelles
├── regression.test.js             ← Golden dataset complet
└── feedback.test.js               ← Learner + rollback profil
```

---

## Types de tests

### 1. Tests de schemas (`schemas.test.js`)

Valide que les schémas Zod acceptent des données valides et rejettent des données invalides.

```js
describe('BCItem schema', () => {
  test('accepte un item complet valide', () => {
    const result = BCItem.safeParse(fixtures.bc_cable_reseau);
    expect(result.success).toBe(true);
  });

  test('accepte un item sans articles (champ optionnel)', () => {
    const result = BCItem.safeParse({ ...fixtures.bc_minimal, articles: undefined });
    expect(result.success).toBe(true);
    expect(result.data.articles).toEqual([]);  // default appliqué
  });

  test('rejette un item sans id', () => {
    const result = BCItem.safeParse({ ...fixtures.bc_cable_reseau, id: undefined });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(['id']);
  });

  test('rejette une url invalide', () => {
    const result = BCItem.safeParse({ ...fixtures.bc_cable_reseau, url: 'pas-une-url' });
    expect(result.success).toBe(false);
  });
});
```

**Couverture attendue** : 100% des champs de chaque schema (valid + invalid + defaults).

---

### 2. Tests de scoring (`scoring.test.js`)

Valide la logique déterministe : même input → même score → même explication.

```js
describe('computeScore', () => {
  test('BC câble RJ45 + client réseau → score élevé', () => {
    const result = computeScore(fixtures.bc_cable_reseau, fixtures.client_reseau, fixtures.criteres_reseau);
    expect(result.score).toBeGreaterThanOrEqual(65);
    expect(result.signals.some(s => s.name === 'article_exact_match')).toBe(true);
    expect(result.explanation).toContain('câble');
  });

  test('BC peinture lycée + client réseau → score faible', () => {
    const result = computeScore(fixtures.bc_peinture_lycee, fixtures.client_reseau, fixtures.criteres_reseau);
    expect(result.score).toBeLessThan(30);
  });

  test('score est déterministe : deux appels identiques = même résultat', () => {
    const r1 = computeScore(fixtures.bc_cable_reseau, fixtures.client_reseau, fixtures.criteres_reseau);
    const r2 = computeScore(fixtures.bc_cable_reseau, fixtures.client_reseau, fixtures.criteres_reseau);
    expect(r1.score).toBe(r2.score);
    expect(r1.signals).toEqual(r2.signals);
  });

  test('hard_excluded force score à 0', () => {
    const clientAvecBlacklist = {
      ...fixtures.client_reseau,
      business_profile: {
        ...fixtures.client_reseau.business_profile,
        organismes_blacklist: ['Lycée Ibn Battouta'],
      },
    };
    const result = computeScore(fixtures.bc_peinture_lycee, clientAvecBlacklist, []);
    expect(result.score).toBe(0);
    expect(result.hard_excluded).toBe(true);
  });

  test('score ne peut pas être négatif', () => {
    const result = computeScore(fixtures.bc_hors_sujet, fixtures.client_reseau, fixtures.criteres_reseau);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
```

---

### 3. Tests de matching (`matching.test.js`)

Compare le matching v2 (score) avec le matching legacy (booléen) sur des cas connus.

```js
describe('matchCritereV2 vs legacy', () => {
  test('vrais positifs : v2 score > seuil partout où legacy matchait', () => {
    const truePositives = fixtures.golden_dataset.filter(c => c.expected === 'match');

    for (const cas of truePositives) {
      const legacyMatch = matchCritereLegacy(cas.bc, cas.critere);
      const v2Result    = matchCritereV2(cas.bc, cas.critere);

      if (legacyMatch) {
        // Si le legacy matchait, le v2 doit scorer >= seuil (40 par défaut)
        expect(v2Result.score).toBeGreaterThanOrEqual(40);
      }
    }
  });

  test('faux positifs : v2 score < seuil sur faux positifs annotés', () => {
    const falsePositives = fixtures.golden_dataset.filter(c => c.expected === 'no_match');

    let correctedCount = 0;
    for (const cas of falsePositives) {
      const v2Result = matchCritereV2(cas.bc, cas.critere);
      if (v2Result.score < 50) correctedCount++;
    }
    // Le v2 doit corriger au moins 70% des faux positifs identifiés
    expect(correctedCount / falsePositives.length).toBeGreaterThanOrEqual(0.7);
  });
});
```

---

### 4. Tests de non-régression (`regression.test.js`)

Run automatique sur le golden dataset complet à chaque modification de `core/scoring/`.

```js
describe('Non-régression golden dataset', () => {
  const dataset = require('./fixtures/golden_dataset.json');

  test.each(dataset)('cas $id : $description', (cas) => {
    const result = computeScore(cas.bc, cas.client, cas.criteres);

    // Le score ne doit pas s'éloigner de plus de ±5 du score de référence
    expect(result.score).toBeGreaterThanOrEqual(cas.expected_score - 5);
    expect(result.score).toBeLessThanOrEqual(cas.expected_score + 5);

    // Le verdict (match/no_match) ne doit jamais s'inverser
    const matchResult = result.score >= cas.client.pack_threshold;
    expect(matchResult).toBe(cas.expected_verdict === 'match');
  });
});
```

**Règle CI** : ce test bloque tout merge si un cas régresse.

---

### 5. Tests d'exclusion (`exclusions.test.js`)

```js
describe('Exclusions contextuelles', () => {
  test('exclusion lexicale seule ne bloque pas un BC pertinent', () => {
    // BC "Fourniture peinture industrielle CHU" pour client peinture industrielle
    // Le mot "peinture" ne doit pas exclure ce BC
    const result = computeScore(fixtures.bc_peinture_chu, fixtures.client_peinture_industrielle, fixtures.criteres);
    expect(result.score).toBeGreaterThanOrEqual(50);
    expect(result.hard_excluded).toBe(false);
  });

  test('exclusion contextuelle bloque un BC hors-sujet', () => {
    // BC "Travaux peinture lycée" pour client fournisseur matériel réseau
    const result = computeScore(fixtures.bc_travaux_peinture, fixtures.client_reseau, fixtures.criteres_reseau);
    expect(result.score).toBeLessThan(35);
  });

  test('hard exclusion force score = 0', () => {
    const result = computeScore(fixtures.bc_organisme_blackliste, fixtures.client_avec_blacklist, []);
    expect(result.score).toBe(0);
    expect(result.hard_excluded).toBe(true);
    expect(result.explanation).toContain('exclu');
  });
});
```

---

### 6. Tests feedback + rollback (`feedback.test.js`)

```js
describe('Feedback loop', () => {
  test('snapshot créé avant ajustement de profil', async () => {
    const snapshotsBefore = await db.countSnapshots(fixtures.client_reseau.id);
    await learner.applyFeedback(fixtures.client_reseau.id, fixtures.feedback_negatif);
    const snapshotsAfter = await db.countSnapshots(fixtures.client_reseau.id);
    expect(snapshotsAfter).toBe(snapshotsBefore + 1);
  });

  test('rollback restaure le profil exact', async () => {
    const profileBefore = await db.getProfile(fixtures.client_reseau.id);
    const { snapshotId } = await rollback.createSnapshot(fixtures.client_reseau.id);
    await learner.applyFeedback(fixtures.client_reseau.id, fixtures.feedback_negatif);
    await rollback.restoreSnapshot(fixtures.client_reseau.id, snapshotId);
    const profileAfter = await db.getProfile(fixtures.client_reseau.id);
    expect(profileAfter).toEqual(profileBefore);
  });
});
```

---

## Configuration Jest

```json
// package.json
{
  "scripts": {
    "test":            "jest",
    "test:watch":      "jest --watch",
    "test:coverage":   "jest --coverage",
    "test:regression": "jest tests/regression.test.js --verbose"
  },
  "jest": {
    "testEnvironment": "node",
    "transform":       {},
    "testMatch":       ["**/tests/**/*.test.js"],
    "coverageThreshold": {
      "global": {
        "branches":   80,
        "functions":  90,
        "lines":      90
      }
    }
  }
}
```

---

## Workflow CI (GitHub Actions)

```yaml
# .github/workflows/test.yml
name: Tests Anaho Core

on:
  pull_request:
    paths: ['core/**', 'tests/**']

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm test
      - run: npm run test:regression  # golden dataset — bloquant
```

---

## Règles de qualité

| Règle | Seuil |
|-------|-------|
| Couverture lignes `core/` | ≥ 90% |
| Couverture branches `core/scoring/` | ≥ 85% |
| Golden dataset accord score | ±5 pts maximum |
| Golden dataset accord verdict | 100% (bloquant) |
| Durée suite complète | < 30 secondes |
| Tests avec dépendance réseau | 0 dans la suite principale |
