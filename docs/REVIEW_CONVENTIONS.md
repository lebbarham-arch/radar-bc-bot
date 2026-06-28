# REVIEW_CONVENTIONS.md -- Radar BC

> Conventions operationnelles pour la revue humaine des BCs.
> Ces regles s'appliquent a toutes les decisions (keep/reject/ignore) quel que soit le profil client.
> Ces regles sont des guides de classification. Elles ne modifient pas le moteur de scoring.
> Source : GD-104 (analyse generique des patterns d'erreur), formalise en GD-105.
> Derniere mise a jour : 2026-06-29

---

## 0. Rappel : decisions valides

| Decision | Signification |
|---|---|
| `keep`   | BC pertinent pour le profil client -- a notifier au client |
| `reject` | BC definitivement hors creneau -- signal negatif fort, ne plus afficher |
| `ignore` | BC ambigu ou cas limite -- remettre en revue au prochain cycle |

**Principe fondamental :**
`reject` != `ignore`. Ne jamais utiliser `ignore` pour des cas dont la reponse est evidente.
Un IGNORE sur un cas evident pollue les metriques signal et bloque la promotion.

---

## A. BC annule -- toujours REJECT

**Convention :**
Tout BC portant explicitement la mention "Annule" avec date d'annulation, motif et/ou
piece jointe d'annulation doit etre classe `REJECT`.

Un BC annule n'est pas un cas ambigu. Il n'existe plus en tant qu'opportunite commerciale.
Le classer IGNORE est une erreur de classification.

**Signaux d'annulation dans le bodyText :**
- `INFORMATIONS LIEES A L'ANNULATION`
- `Date d'annulation : JJ/MM/AAAA`
- `Reference annulation / Motif : ...`
- Statut affiche `Annule` dans le titre ou le header du BC

**Regle :** BC annule -> `REJECT` sans exception.

**Pourquoi pas IGNORE ?**
La pertinence du contenu ne change pas le statut d'annulation. Meme si le signal
est fort et l'objet dans le creneau, le BC ne donne lieu a aucune opportunite.
Un IGNORE sur BC annule penalise artificiellement les signaux (ignore bloque la
promotion) pour une raison administrative independante du signal.

**Exemples observes (GD-102/GD-103) :**
- BC 356182 : materiel IT + logiciel, annule (erreur de saisie) -- classe IGNORE -> devrait etre REJECT
- BC 349068 : equipement informatique HACA, annule (modification articles) -- classe IGNORE -> devrait etre REJECT
- BC 348693 : produit hygiene, annule (vice de procedure) -- classe IGNORE -> devrait etre REJECT

---

## B. Desinfection / Hygiene en milieu hospitalier -- deux sous-cas distincts

Ce pattern est la principale source de confusion dans les decisions review du profil
Nettoyage Hygiene. Les deux sous-cas ont des decisions differentes et ne doivent pas
etre melanges.

### B1. Achat de produit desinfectant/chimique/medico-technique par un hopital -> REJECT

**Cas :** L'hopital ou le CHP achete des produits pour ses propres besoins medicaux
internes (desinfectants de paillasses, produits de soins, consommables medicaux,
materiel medico-technique).

**Indicateurs :**
- Acheteur public = CHP / CHR / Centre Hospitalier Provincial / Regional
- Nature de prestation = "Fournitures medico-techniques" ou "Produits chimiques et
  de laboratoire, pesticides et insecticides"
- Objet = desinfection des surfaces de soins, paillasses, materiel medical
- Categorie = Fournitures (pas Services)

**Decision : `REJECT`**
Ce n'est pas le creneau d'un prestataire de nettoyage/hygiene de locaux.
L'hopital achete pour usage propre medical, pas pour sous-traiter une prestation.

### B2. Prestation de service de nettoyage/entretien des locaux hospitaliers -> evaluer

**Cas :** Un prestataire externe est recherche pour assurer le nettoyage ou l'entretien
des locaux d'un hopital (couloirs, chambres, espaces communs).

**Indicateurs :**
- Nature de prestation = "Prestation de nettoyage" / "Services de jardinage, gardiennage
  et de nettoyage"
- Categorie = Services (pas Fournitures)
- L'hopital cherche une entreprise de nettoyage externe

**Decision : `KEEP` ou `IGNORE` selon le profil client.**
Un client specialise en nettoyage industriel ou hospitalier peut y repondre.

**Regle de distinction :**
- Fournisseur de produit pour usage medical interne -> B1 -> REJECT
- Prestataire de service de nettoyage des locaux -> B2 -> evaluer selon profil

**Exemples observes :**
- BC 356708 (nettoyage locaux hopitaux Sidi Bennour -- Services) -> B2 -> IGNORE/KEEP
- BC 353465 (desinfection CHP Taza -- produits) -> B1 -> devrait etre REJECT
- BC 352653 (desinfection paillasses CHP Ifrane -- produits) -> B1 -> devrait etre REJECT

---

## C. Materiel informatique direct -- depend du profil client

**Pattern :** Signal `informatique` capte des marches d'achat simple de PC, imprimantes,
consommables ou fournitures informatiques par des organismes publics pour leur usage interne.

**Ce n'est PAS un faux positif absolu.** La decision depend du profil client :

| Type de client IT       | Decision recommandee                                       |
|-------------------------|------------------------------------------------------------|
| Revendeur materiel IT   | `KEEP` -- dans le creneau                                  |
| SSII / integrateur      | `IGNORE` ou `REJECT` -- achat direct sans prestation IT    |
| Editeur logiciel        | `REJECT` -- pas du materiel                                |
| Mainteneur IT           | `KEEP` si maintenance/configuration incluse, sinon `IGNORE`|

**Regle : ne pas coder de guard generique pour ce pattern.**
La distinction doit etre definie dans le profil client (hint client/profil) afin que
le moteur puisse filtrer automatiquement selon le type de prestataire vise.

**Indicateurs "achat materiel direct sans prestation" :**
- Objet = "Achat de fournitures informatiques" / "Achat de materiel informatique"
- Nature de prestation = "Fournitures et pieces de rechange pour materiel technique
  et informatique"
- Articles = PC de bureau, imprimantes, consommables d'impression, cables

**Volume observe (GD-101) :** environ 20-25 des 35 review candidates Informatique
sur le snapshot 28 juin entrent dans ce pattern. C'est la famille la plus volumineuse.

---

## D. Hygiene du milieu / Sante publique environnementale -- observer avant d'agir

**Pattern :** Signal `hygiene`/`hygiène` capte des marches des delegations provinciales
de sante pour leurs unites "hygiene du milieu" (surveillance sanitaire environnementale :
qualite de l'eau, lutte anti-vectorielle, épidemiologie).

**Ces marches sont hors creneau pour tout profil Nettoyage Hygiene.**

**Indicateurs recurrents :**
- "hygiene du milieu" / "du milieu relevant de"
- "DMSPS" (Delegation du Ministere de la Sante et de la Protection Sociale)
- "delegation du ministere de la sante a la province de [X]"
- Nature = "Achat de produits chimiques et de laboratoire, pesticides et insecticides"
- Nature = "Fourniture d'equipements medico-techniques"

**Decision actuelle : `REJECT`** pour les cas clairement "hygiene du milieu sante publique".

**Regle moteur : ne pas coder de guard maintenant.**
Continuer a observer sur 2-3 snapshots supplementaires. Si le pattern est confirme
stable (0% keep sur >= 15 occurrences), envisager un guard generique base sur
co-occurrence de "milieu" + "delegation sante" + "chimiques" (pas de valeur
hardcodee par organisme).

**Frequence observee (GD-104) :** 10 occurrences sur 113 decisions (9% du corpus).
0 keep sur 10 occurrences. Pattern le plus frequent des erreurs connues.

---

## E. Familles anecdotiques -- observer, ne rien coder

Ces familles ont ete identifiees en GD-104 mais ne justifient pas encore de regle moteur.

### E1. Signal `papier` dans contexte imprimerie / communication / biologie

- Exemples : roll-up, X-banner, banderoles, papier buvard pour reactifs medicaux
- Frequence : 3 occurrences (GD-101) -- insuffisant pour generaliser
- Decision : `REJECT` si le contexte imprimerie/communication/biologique est evident

### E2. Signal `classeurs` ou `fournitures scolaires` hors profil

- Exemples : "classeurs" dans "routes non classees" (faux positif de tokenisation),
  "fournitures scolaires" dans un atelier de patisserie-boulangerie
- Frequence : 2 occurrences -- anecdotique
- Decision : `REJECT` si hors profil evident

### E3. Signal `hygiene` capte via le nom de l'organisme

- Exemple : "location de voiture de service" par un organisme dont le nom contient
  "preservation de l'hygiene"
- Frequence : 1 occurrence
- Decision : `REJECT` si la prestation n'a aucun rapport avec l'hygiene

**Regle pour E1-E3 :** pas de code maintenant. Signaler dans les prochains cycles
si la frequence augmente (seuil : >= 5 occurrences avec 0% keep).

---

## F. Raisons de review valides -- budget interdit (regle F6)

### Raisons acceptables en review humaine (champ `reason`) :

- Pertinence de l'objet par rapport au creneau du client
- Contexte de l'organisme acheteur (sante / education / collectivite territoriale)
- Nature de la prestation (service vs fourniture directe)
- Signal unique faible (score <= 5) sans contexte confirmatoire
- Signaux multiples ambigus (combinaison inédite de signaux)
- BC annule / modifie / expire (-> voir Convention A)
- Sous-traitance vs achat direct (prestataire recherche vs achat interne)

### Raison interdite : le budget / montant / prix

Les BCs du portail marchespublics.gov.ma ne contiennent pas de budget exploitable
dans le bodyText. Toute decision basee sur un budget suppose est non reproductible
et non verifiable entre cycles.

**Implements :** `budget`, `prix`, `montant`, `estimation` sont interdits dans
`REVIEW_REASON_CODES` (verifie par `scripts/review-reasons.js` et le test ARL-C).

---

## G. Signaux faibles isoles -- toujours en review, jamais auto-candidate

**Convention :** Un BC avec un seul signal de score <= 5 (`weak_single_signal=true`)
ne doit jamais etre auto-candidate. Il doit toujours passer par la review humaine.

Cela est deja implemente dans le moteur (shadow runner). Cette convention rappelle
que l'operateur ne doit pas "forcer" un KEEP sur un signal faible isole uniquement
parce que l'objet semble pertinent. Le score 5 (signal faible unique) necessite
au moins un element confirmatoire dans le bodyText ou les articles.

---

## Audit automatise des violations

Le script `scripts/audit-review-learning-cycle.js` inclut un CHECK I (GD-105)
qui detecte de maniere non-bloquante les violations des conventions A et B1 dans
les fichiers `data/review-decisions/*.json` existants.

Ce rapport est informatif seulement. Il ne modifie aucune decision, aucun signal,
aucun score.

Pour lancer l'audit complet :
```
node scripts/audit-review-learning-cycle.js --verbose
```

---

## References

- `docs/DECISIONS_LOG.md` -- decisions techniques actees
- `docs/GOLDEN_DATASET.md` -- cas annotes de reference pour le scoring
- `docs/REGRESSION_RULES.md` -- regles anti-regression absolues
- `docs/SCORING_RULES.md` -- regles du moteur de scoring
- `scripts/audit-review-learning-cycle.js` -- audit automatise des garde-fous
- GD-104 -- analyse generique des patterns d'erreur (source de ces conventions)
