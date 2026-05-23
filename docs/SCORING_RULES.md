# Scoring Rules — Anaho

## Principe

Le score est **déterministe, reproductible, explicable**.  
Même input → même score → même explication.  
Pas de probabilités, pas de "boîte noire".

Le score final est un entier entre 0 et 100.  
Chaque point est justifié par un signal nommé avec un poids documenté.

---

## Architecture du score

```
Score total = Σ(poids_signal × activation_signal)
           = signal_articles + signal_titre + signal_organisme
           + signal_region + signal_contexte + signal_exclusion
```

Le score est **plafonné à 100** et **ne peut pas être négatif**.  
Les exclusions soustraient des points mais ne peuvent pas rendre le score négatif.

---

## Signaux business

Les signaux business évaluent la cohérence entre le profil métier du client et le contexte du BC.

### BS-01 : Correspondance secteur métier
**Poids** : 0–25 points

| Condition | Points |
|-----------|--------|
| Secteur principal du client == secteur BC | 25 |
| Secteur secondaire du client ∩ secteur BC | 15 |
| Secteur BC ambigu (plurisectoriel) | 8 |
| Aucune correspondance secteur | 0 |

**Source** : `client.business_profile.secteurs` vs `bc.secteur_detected`

### BS-02 : Type de prestation
**Poids** : 0–20 points

| Type prestation BC | Client = fournisseur | Client = prestataire service | Autre |
|-------------------|---------------------|------------------------------|-------|
| Fourniture matériel | 20 | 5 | 0 |
| Maintenance/SAV | 5 | 20 | 5 |
| Travaux | 0 | 0 | 20 si pertinent |
| Formation | 2 | 15 | 2 |
| Impression/reprographie | 15 | 5 | 0 |

**Source** : détection dans `bc.objet` + `bc.bodyText`

### BS-03 : Organisme acheteur
**Poids** : 0–15 points

| Condition | Points |
|-----------|--------|
| Organisme dans la whitelist client | 15 |
| Famille d'organismes ciblée (ex: CHU → hôpitaux) | 10 |
| Organisme neutre (non ciblé, non exclu) | 5 |
| Organisme dans la blacklist client | −20 |

**Source** : `client.business_profile.organismes_cibles` vs `bc.organisme`

### BS-04 : Région géographique
**Poids** : 0–10 points

| Condition | Points |
|-----------|--------|
| Région exacte == région client | 10 |
| Région voisine (même zone économique) | 5 |
| Toutes régions (pas de filtre) | 3 |
| Région explicitement exclue par client | −10 |

---

## Signaux techniques

Les signaux techniques évaluent la correspondance entre les articles du BC et le catalogue du client.

### TS-01 : Match exact article
**Poids** : 0–40 points

| Condition | Points |
|-----------|--------|
| Article.designation contient le critère exact (normalisé) | 40 |
| Article.designation contient une inclusion IA du critère | 30 |
| Article.specifications contient le critère | 20 |
| bodyText contient le critère (hors articles) | 10 |
| Match fuzzy (Levenshtein ≤ 2) | 15 |

**Règle** : le score maximum de cette catégorie est 40 même si plusieurs articles matchent.  
Le trigger retenu est l'article avec le score le plus élevé.

### TS-02 : Densité de match
**Poids** : 0–10 points

| Nombre d'articles matchants | Points |
|-----------------------------|--------|
| 1 article | 3 |
| 2–3 articles | 6 |
| 4+ articles | 10 |

Un BC avec 5 articles de câblage réseau pour un fournisseur réseau est plus pertinent qu'un BC avec 1 article câblage parmi 20 articles de bureau.

### TS-03 : Spécifications techniques
**Poids** : 0–5 points

| Condition | Points |
|-----------|--------|
| Spécifications contiennent des codes/normes du profil client | 5 |
| Spécifications compatibles avec le profil technique | 3 |
| Spécifications neutres | 0 |

---

## Exclusions contextuelles

Les exclusions retirent des points mais ne peuvent pas forcer un score à 0 si le score brut est élevé.  
Elles signalent un doute, pas une certitude.

**Exception** : une exclusion flaggée `hard: true` force le score à 0, quelle que soit la valeur.

### EX-01 : Exclusion par type de prestation

```js
// Exemple de règle d'exclusion contextuelle
{
  id:          'EX-travaux-batiment',
  description: 'BC de travaux de bâtiment non pertinent pour fournisseur matériel',
  hard:        false,  // soustrait des points, ne force pas 0
  penalty:     30,
  conditions: [
    { field: 'type_prestation', operator: 'contains', value: 'travaux' },
    { field: 'secteur',         operator: 'equals',   value: 'bâtiment' },
  ],
  logic: 'AND',
}
```

### EX-02 : Exclusion par organisme

```js
{
  id:          'EX-organisme-blacklist',
  description: 'Organisme explicitement exclu par le client',
  hard:        true,  // force score = 0
  conditions: [
    { field: 'organisme', operator: 'contains', value: '[valeur de la blacklist]' },
  ],
  logic: 'AND',
}
```

### EX-03 : Exclusion lexicale dans contexte inactif

Les exclusions lexicales (`ai_exclusions`) du système actuel sont traitées comme des **hints**, pas des décisions.

```
Mot exclu présent dans le texte ET contexte confirmé  →  -15 pts
Mot exclu présent dans le texte MAIS contexte ambigu  →  -5 pts  (+ flag "à vérifier")
Mot exclu absent                                       →  0 pt
```

---

## Calcul du score final

```js
function computeScore(bc, client, criteres) {
  const signals = [];

  // Business signals
  const bs01 = computeSecteurMatch(bc, client);
  const bs02 = computeTypePrestation(bc, client);
  const bs03 = computeOrganismeMatch(bc, client);
  const bs04 = computeRegionMatch(bc, client);

  // Technical signals
  const ts01 = computeArticleMatch(bc, criteres);
  const ts02 = computeMatchDensity(bc, criteres);
  const ts03 = computeSpecsMatch(bc, client);

  // Exclusions
  const exclusions = computeExclusions(bc, client, criteres);

  const rawScore = bs01.score + bs02.score + bs03.score + bs04.score
                 + ts01.score + ts02.score + ts03.score;
  const penalty  = exclusions.reduce((acc, e) => acc + e.penalty, 0);

  const finalScore = Math.max(0, Math.min(100, rawScore - penalty));
  const hardExcluded = exclusions.some(e => e.hard && e.active);

  return {
    score:       hardExcluded ? 0 : finalScore,
    signals:     [...signals, ...exclusions],
    explanation: buildExplanation(finalScore, signals, exclusions),
    hard_excluded: hardExcluded,
  };
}
```

---

## Format de sortie (ScoreResult)

```js
// Exemple de ScoreResult pour un BC câblage réseau
{
  score: 78,
  hard_excluded: false,
  signals: [
    { name: 'article_exact_match',  category: 'technical', score: 40, trigger: 'câble RJ45' },
    { name: 'match_density',        category: 'technical', score: 6,  trigger: '3 articles' },
    { name: 'secteur_match',        category: 'business',  score: 25, trigger: 'informatique' },
    { name: 'type_prestation',      category: 'business',  score: 15, trigger: 'fourniture' },
    { name: 'organisme_whitelist',  category: 'business',  score: 0,  trigger: null },
    { name: 'region_match',         category: 'business',  score: 10, trigger: 'Casablanca' },
    { name: 'excl_travaux_bat',     category: 'exclusion', score: -10, trigger: 'peinture' },
  ],
  explanation: "BC pertinent (78/100) : article \"câble RJ45\" détecté (40pts), "
             + "3 articles réseau (6pts), secteur informatique (25pts), "
             + "fourniture matériel (15pts), région Casablanca (10pts). "
             + "Signal mineur : contexte peinture détecté (-10pts, non bloquant).",
  trigger: {
    keyword:          'câble réseau',
    matched_term:     'câble RJ45',
    is_enrichissement: true,
    source_article:   'Fourniture câble RJ45 Cat6 — 500ml',
  }
}
```

---

## Seuils de notification par pack

| Pack | Seuil | Comportement LLM |
|------|-------|-----------------|
| `starter` | ≥ 50 | Pas de LLM |
| `pro` | ≥ 40 | LLM génère résumé + flag si score 40–55 |
| `business` | ≥ 35 | LLM génère résumé toujours |

**Le LLM ne peut pas notifier sous le seuil.**  
**Le LLM ne peut pas bloquer au-dessus du seuil** (sauf `hard_excluded = true`).

---

## Évolution des poids

Les poids sont des constantes documentées dans `core/scoring/deterministic.js`.  
Ils ne sont jamais modifiés dynamiquement par le LLM.  
Ils peuvent être ajustés manuellement après analyse des feedbacks (Phase 4).  
Tout changement de poids déclenche un run complet du golden dataset avant merge.
