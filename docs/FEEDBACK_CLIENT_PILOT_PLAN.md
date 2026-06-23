# FEEDBACK_CLIENT_PILOT_PLAN.md

Plan opérationnel client pilote feedback — référence GD-088/GD-089.

> **Périmètre strict** : bêta locale + 1 client pilote uniquement.
> Prod large : NO-GO. Import automatique : interdit. Scoring : non touché.

---

## 1. Verdict synthétique

| Périmètre | Verdict |
|-----------|---------|
| Bêta client pilote (Mode A, sans flag avancé) | ✅ GO |
| Prod feedback simple (après pilote validé) | ✅ GO conditionnel |
| Prod feedback signé strict | ❌ NO-GO |
| Import automatique (toute phase) | ❌ NO-GO |
| Modification scoring sur retours pilote | ❌ NO-GO |

**Mode recommandé** : Mode A — feedback simple sans `?r=`, sans signature, sans flag avancé. Comportement historique côté client, circuit de collecte local activé.

---

## 2. Périmètre pilote

- **1 client pilote** — profil métier clair, critères précis, zone connue, disponible pour donner un retour rapide.
- **1 à 3 critères/mots-clés** — choisir des critères que le client connaît bien pour maximiser la qualité des retours.
- **5 à 10 opportunités** — volume délibérément faible. L'objectif est de valider le circuit technique, pas de produire de la statistique.
- **Durée 3 à 5 jours** — assez long pour cumuler quelques clics, assez court pour garder le contexte en tête lors de la relecture.
- **Objectif** : vérifier que le handler `/feedback` collecte bien les événements, que le convertisseur produit un CSV cohérent, et que l'import manuel fonctionne sans erreur. Ne pas utiliser ces données pour recalibrer le scoring.

Le client doit être informé que ses clics sont collectés dans le cadre d'un test bêta.

---

## 3. Ce qui reste désactivé

Ces éléments sont **off par défaut** et doivent le rester pendant toute la durée du pilote :

- `FEEDBACK_REASON_LINKS_ENABLED` — non défini → 3 liens standard (`relevant`, `irrelevant`, `watch`), sans `?r=`.
- `FEEDBACK_SIGNED_LINKS_ENABLED` — non défini → aucun `sig=`, aucun `exp=` dans les URLs.
- `FEEDBACK_REQUIRE_SIGNATURE` — non défini → liens non signés acceptés, aucune rupture.
- **Import automatique** — inexistant et interdit. Chaque import est précédé d'un dry-run et d'une relecture humaine.
- **Mode clean/shadow prod** — désactivé, non touché pendant le pilote.
- **Promotion automatique** — aucune promotion de décision client vers le scoring sans analyse humaine explicite.

---

## 4. Déroulé opérationnel

### J0 — Préparation

Vérifier l'état du repo et des tests avant tout envoi :

```powershell
git status --short
npm test
npm run typecheck
```

Tous les tests doivent passer (1132/1132). Repo propre. Typecheck sans erreur.

S'assurer que `FEEDBACK_BASE_URL` est configuré (en local ou en prod) pour que les liens feedback soient générés correctement.

Identifier et informer le client pilote.

### J0 → J3/J5 — Envoi des opportunités

Envoyer 5 à 10 opportunités au client via le canal habituel (Telegram ou email). Les liens feedback sont les 3 liens standard sans modification. Aucun flag activé, aucune variable d'environnement modifiée.

### J3/J5 — Collecte et vérification

```powershell
# Vérifier que des événements ont été collectés
Get-Content data\feedback\feedback-events.jsonl | Select-Object -First 10
```

Chaque ligne doit être un JSON valide avec au minimum : `client_id`, `radar_type`, `item_id`, `critere`, `type`, `created_at`.

### Dry-run convertisseur (obligatoire avant toute génération CSV)

```powershell
node scripts/convert-feedback-events-to-review-csv.js --dry-run
```

Vérifier :
- Nombre d'événements traités
- Répartition `keep` / `reject` / `ignore`
- Cohérence des `human_review_reason`
- Absence d'événements corrompus ou mal formés

Ne pas continuer si le dry-run affiche des incohérences.

### Génération CSV

```powershell
node scripts/convert-feedback-events-to-review-csv.js `
  --input data/feedback/feedback-events.jsonl `
  --output data/feedback/review-pilot-$(Get-Date -Format 'yyyyMMdd').csv `
  --dedupe
```

L'option `--dedupe` conserve le feedback le plus récent par `(client_id, item_id, type)`, ce qui évite les doublons si le client a cliqué plusieurs fois sur la même opportunité.

### Relecture humaine (obligatoire)

Ouvrir le CSV dans Excel ou un éditeur texte. Lire chaque ligne. Vérifier :
- La décision correspond au feedback reçu.
- `review_source` est bien `client`.
- Aucune décision aberrante (`keep` sur un signal clairement hors-profil, etc.).
- Les cas douteux sont notés et traités avant l'import.

Ne pas importer si une ligne est douteuse et non résolue.

### Import manuel

```powershell
node scripts/import-review-decisions.js `
  data/feedback/review-pilot-<date>.csv `
  --review-source client
```

Remplacer `<date>` par la date réelle du fichier CSV. Ne jamais utiliser `--review-source operator` pour des données client.

### Analyse post-import

```powershell
node scripts/analyze-review-decisions.js --review-source client
```

Observer la répartition des décisions, les raisons les plus fréquentes, les signaux concernés. Ne pas modifier le scoring sur la base de ce premier pilote.

---

## 5. Commandes exactes PowerShell

```powershell
# Contrôle repo avant démarrage
git status --short
git log --oneline -5
npm test
npm run typecheck

# Lecture des événements collectés
Get-Content data\feedback\feedback-events.jsonl | Select-Object -First 10

# Nombre total d'événements
(Get-Content data\feedback\feedback-events.jsonl).Count

# Dry-run convertisseur (toujours en premier)
node scripts/convert-feedback-events-to-review-csv.js --dry-run

# Génération CSV avec déduplification
node scripts/convert-feedback-events-to-review-csv.js `
  --input data/feedback/feedback-events.jsonl `
  --output data/feedback/review-pilot-$(Get-Date -Format 'yyyyMMdd').csv `
  --dedupe

# Import manuel (--review-source client obligatoire)
node scripts/import-review-decisions.js `
  data/feedback/review-pilot-<date>.csv `
  --review-source client

# Analyse post-import
node scripts/analyze-review-decisions.js --review-source client

# Vérification que data/feedback/ est ignoré par Git
git check-ignore -v data/feedback/feedback-events.jsonl

# Contrôle final
git status --short
git diff --check
```

---

## 6. Règles de sécurité

Ces règles sont impératives et ne souffrent aucune exception :

1. **Ne jamais importer automatiquement** — chaque import est précédé d'un dry-run et d'une relecture humaine. Aucun cron, aucun script automatisé ne déclenche un import.

2. **Ne jamais mélanger `client` et `operator`** — les imports `--review-source client` et `--review-source operator` sont toujours séparés. Les décisions operator priment. Ne jamais utiliser `--review-source operator` pour des données client.

3. **Ne jamais modifier le scoring après quelques clics** — 5 à 10 feedbacks ne sont pas statistiquement représentatifs. Ces données alimentent uniquement les review decisions. Le scoring moteur (seuils, poids, guards, hints, matching) n'est jamais modifié sur la base du pilote.

4. **Ne jamais committer `data/feedback/`** — les fichiers JSONL et CSV générés restent locaux. Vérifier avec `git check-ignore -v data/feedback/feedback-events.jsonl`.

5. **Ne jamais mettre de secret en Git** — `FEEDBACK_SIGNING_SECRET`, si utilisé en bêta locale future, ne va jamais dans `.env` versionné, ni dans un script commité.

6. **Ne pas activer `FEEDBACK_REQUIRE_SIGNATURE=true` en prod** — tuerait tous les anciens liens en circulation. Activer uniquement en local pour test, après une phase de transition documentée.

---

## 7. Critères GO avant import

Tous ces critères doivent être satisfaits avant de lancer l'import manuel :

- [ ] Les feedbacks collectés sont lisibles et bien formés (JSON valide, champs présents)
- [ ] Le dry-run s'est exécuté sans erreur
- [ ] La répartition keep/reject/ignore est cohérente avec les feedbacks attendus
- [ ] Le CSV a été relu ligne par ligne
- [ ] Chaque décision correspond au feedback reçu
- [ ] `review_source=client` est présent dans le CSV
- [ ] Aucun cas douteux non résolu
- [ ] Volume faible assumé — pas d'extrapolation sur le scoring prévue

---

## 8. Critères STOP

Arrêter le pilote et ne pas importer si l'un de ces critères est vrai :

- [ ] Les feedbacks collectés sont incohérents (même signal alternativement `relevant` et `irrelevant`)
- [ ] Le client pilote n'a pas le bon profil (critères trop larges, zone non applicable)
- [ ] Le CSV contient des lignes ambiguës non résolues après relecture
- [ ] Doute sur la `review_source` (risque de mélange client/operator)
- [ ] Le client n'a pas été informé du protocole bêta
- [ ] `git status` révèle des modifications inattendues sur des fichiers critiques
- [ ] `data/feedback/` n'est pas ignoré par Git (`git check-ignore` échoue)
- [ ] `npm test` ou `npx tsc --noEmit` échoue

---

## 9. Risques à surveiller

**Lien partageable** : un lien feedback n'est pas protégé par authentification. N'importe qui ayant le lien peut cliquer. Risque faible à volume bêta (1 client, quelques liens), à surveiller si le volume augmente.

**Clics émotionnels ou non représentatifs** : un client mécontent peut rejeter des opportunités pertinentes, ou cliquer par réflexe sans avoir lu le contenu. La relecture humaine du CSV est le seul garde-fou avant import.

**Faible volume statistique** : 5 à 10 feedbacks ne permettent pas de valider ni d'invalider un signal. Ne pas conclure sur la pertinence d'un critère à partir du pilote. L'objectif est technique, pas analytique.

**Erreur humaine d'import** : utiliser `--review-source operator` au lieu de `client` mélangerait les sources. La commande doit être copiée depuis ce document, pas retapée de mémoire.

**Sur-apprentissage** : ne pas modifier les hints, seuils ou poids immédiatement après le pilote. Observer d'abord plusieurs cycles, analyser les tendances, puis décider manuellement après validation humaine.

**Interprétation trop rapide** : un client qui clique `irrelevant` sur 3 opportunités de suite ne signifie pas que le critère est mauvais. Il peut s'agir d'un problème de timing, de contexte, ou d'un cas particulier. Attendre un volume suffisant sur plusieurs clients avant toute conclusion.

---

## Historique

| Date | Version | Description |
|------|---------|-------------|
| 2026-06-24 | 1.0 | Création initiale — GD-089 (bilan GD-088) |

---

*Ce document est une référence opérationnelle locale. Il ne décrit pas un déploiement production.*
*Toute modification de ce protocole doit être validée avant application.*
