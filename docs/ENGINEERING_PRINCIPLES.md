# Engineering Principles — Anaho

Ces principes sont non-négociables.  
Ils s'appliquent à tout code écrit dans `core/`.  
Le code legacy (`radar-bc-bot.js`) n'est pas retouché pour les respecter — il est isolé.

---

## 1. Schema-first architecture

Le schéma définit la vérité. Le code s'adapte au schéma, jamais l'inverse.

**Règle** : toute structure de données qui traverse une frontière de module doit avoir un schéma Zod déclaré avant que le code qui l'utilise soit écrit.

```js
// ✅ Correct — le schéma existe avant la fonction
import { BCItem } from '../schemas/bc.schema.js';

function scoreBC(raw) {
  const item = BCItem.parse(raw);  // validation runtime, lance si invalide
  // ...
}

// ❌ Interdit — données non validées
function scoreBC(raw) {
  const objet = raw.objet;  // raw peut être n'importe quoi
  // ...
}
```

---

## 2. Validation runtime obligatoire — Zod comme source de vérité

**Zod** est le seul système de validation autorisé dans `core/`.  
Pas de validation manuelle (`if (!item.objet) throw`).  
Pas de casting implicite.

```js
// Schéma canonical d'un article BC
export const Article = z.object({
  designation:    z.string().min(1),
  specifications: z.string().default(''),
  quantite:       z.string().default(''),
  unite:          z.string().default(''),
});

// Schéma canonical d'un item BC
export const BCItem = z.object({
  id:          z.string().min(1),
  objet:       z.string().default(''),
  organisme:   z.string().default(''),
  wilaya:      z.string().default(''),
  lieu:        z.string().default(''),
  date_limite: z.string().default(''),
  url:         z.string().url(),
  articles:    z.array(Article).default([]),
  bodyText:    z.string().default(''),
  montant:     z.number().nullable().default(null),
});
```

**Aucun `any`** dans `core/`. Jamais. Si TypeScript est introduit, `strict: true` + `noImplicitAny: true`.

---

## 3. Scoring déterministe avant IA

L'IA n'entre en jeu qu'**après** que le score déterministe a été calculé.  
Le score déterministe est la base de toute décision.

```
Score déterministe (0–100)
    ↓
Seuil atteint ?  →  OUI  →  LLM enrichit le résumé (assistif)
                  →  NON  →  pas de notification, pas de LLM
```

**Règle** : un BC qui passe uniquement grâce au LLM est un bug de conception.  
Le LLM peut améliorer un message, mais ne peut pas créer un match.

---

## 4. No silent magic

Chaque décision prise par le système doit être **lisible, loggable, testable**.

```js
// ✅ Correct — chaque signal est nommé et tracé
return {
  score: 72,
  signals: [
    { name: 'article_exact_match',   weight: 40, matched: 'câble RJ45' },
    { name: 'organisme_whitelist',   weight: 20, matched: 'CHU' },
    { name: 'region_match',          weight: 12, matched: 'Casablanca' },
  ],
  explanation: 'BC pertinent : article "câble RJ45" détecté (40pts), organisme CHU (20pts), région Casablanca (12pts)',
};

// ❌ Interdit — score sans raison
return { score: 72 };
```

---

## 5. LLM assistif, jamais décideur principal

Le LLM a deux rôles autorisés :

1. **Enrichissement offline** : générer des variantes pour un critère (se fait une fois, en cache)
2. **Résumé de notification** : produire un texte humain pour la notification

Le LLM a un rôle interdit :

- **Rejeter un match** sans que le score déterministe soit en dessous du seuil

```js
// ✅ Correct — LLM enrichit, ne décide pas
const aiSummary = await llm.summarize(item, matchedCriteres);
await notify(client, item, score, aiSummary);

// ❌ Interdit — LLM qui décide d'envoyer ou non
const decision = await llm.shouldNotify(item, client);
if (decision.send) await notify(...);
```

---

## 6. Séparation business intent / technical intent

Chaque critère client a deux dimensions indépendantes :

```
business_intent  →  "Je fournis du matériel informatique aux administrations"
technical_intent →  "câble RJ45", "switch réseau", "onduleur"
```

Ces deux dimensions sont stockées et évaluées séparément.  
Un match sur la dimension technique sans cohérence business est un faux positif candidat.

```js
export const BusinessProfile = z.object({
  secteurs:         z.array(z.string()),    // ex: ['informatique', 'bureautique']
  types_prestation: z.array(z.string()),    // ex: ['fourniture', 'maintenance']
  organismes_cibles: z.array(z.string()),   // ex: ['CHU', 'Ministère', 'Université']
  exclusions_metier: z.array(z.string()),   // ex: ['travaux', 'BTP', 'génie civil']
});

export const TechnicalProfile = z.object({
  produits:       z.array(z.string()),      // ex: ['câble RJ45', 'switch Cisco']
  specifications: z.array(z.string()),      // ex: ['Cat6', '24 ports', 'PoE']
  codes_achats:   z.array(z.string()),      // ex: ['30213000', '32420000']
});
```

---

## 7. Exclusions contextuelles, jamais lexicales

Une exclusion n'est pas "bannir un mot". C'est "rejeter un contexte".

```
❌ Approche lexicale : exclure le mot "peinture"
   → Rate les BCs "Fourniture peinture industrielle CHU" (pertinent)
   → Exclut correctement "Travaux peinture lycée" (non pertinent)
   mais de façon accidentelle

✅ Approche contextuelle : exclure si (type_prestation = 'travaux') ET (secteur = 'bâtiment')
   → La règle est explicite, testable, rollbackable
```

Les exclusions sont déclarées comme des règles composées, pas comme des listes de mots interdits :

```js
export const ExclusionRule = z.object({
  id:          z.string(),
  description: z.string(),                    // "Travaux bâtiment"
  conditions:  z.array(z.object({
    field:    z.string(),                     // 'type_prestation'
    operator: z.enum(['contains', 'equals', 'not_contains']),
    value:    z.string(),                     // 'travaux'
  })),
  logic:       z.enum(['AND', 'OR']),
});
```

---

## 8. Feedback learning traçable

Chaque modification du profil client issue d'un feedback est :

- Horodatée
- Liée au feedback qui l'a déclenchée
- Réversible (snapshot avant modification)

```js
// Avant toute modification de profil → snapshot
await saveProfileSnapshot(clientId, currentProfile, reason: 'feedback_#abc123');

// Modifier
await updateProfile(clientId, newProfile);

// En cas de problème → rollback
await rollbackProfile(clientId, snapshotId);
```

Aucun ajustement automatique de profil sans snapshot préalable.

---

## 9. Tests non-régression obligatoires

Tout nouveau module dans `core/` doit être accompagné de tests.  
Le pipeline CI refuse un merge si les tests régressent sur le golden dataset.

**Règle des 3 tests minimum par fonction publique** :
1. Cas nominal (match attendu)
2. Cas limite (score au seuil)
3. Cas de faux positif (ne doit PAS matcher)

---

## 10. IA locale — seulement après base déterministe stable

L'intégration d'un LLM local (Ollama) ou embarqué n'est envisagée qu'**après** :

- Le scoring déterministe est en production et stable (>30 jours)
- Le golden dataset couvre >50 cas annotés
- Les tests de non-régression passent à 100%
- Le feedback loop est fonctionnel

Pas de LLM local pour accélérer le développement d'une base instable.

---

## Checklist avant tout PR dans core/

```
[ ] Schéma Zod défini avant la fonction
[ ] Aucun `any` dans le code
[ ] Chaque signal de score est nommé et a un poids documenté
[ ] Tests écrits : nominal + limite + faux positif
[ ] Pas de décision cachée dans le LLM
[ ] Snapshot si modification de profil
[ ] Explication lisible retournée avec le score
```
