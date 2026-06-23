# FEEDBACK_BETA_PROTOCOL — Protocole feedback client bêta (local uniquement)

> **STATUT : BÊTA LOCALE — PAS EN PROD**
> Ce document encadre l'utilisation du feedback client en environnement de test local.
> Aucune activation en production sans validation explicite.

---

## 1. État du feedback client

### Ce qui est prêt (socle local)

| Composant | Ticket | État |
|-----------|--------|------|
| Audit feedback client existant | GD-075 | ✅ OK |
| Convertisseur `feedback-events.jsonl` → CSV review | GD-076 | ✅ OK |
| Capture passive `?r=` + mapping reason → décision | GD-077 | ✅ OK |
| Liens feedback enrichis derrière flag | GD-078 | ✅ OK |
| Test synthétique JSONL + convertisseur dry-run | GD-079 | ✅ OK |
| Handler `/feedback` isolé et testable | GD-080 | ✅ OK |

### Ce qui reste désactivé par défaut

- `FEEDBACK_REASON_LINKS_ENABLED` est `false` par défaut — les liens feedback envoyés aux clients restent les 3 liens standard (`relevant`, `irrelevant`, `watch`) sans paramètre `?r=`.
- L'import automatique des feedbacks client vers Supabase est désactivé.
- Aucun scan, cron ou notification n'est déclenché par le feedback.
- Le scoring, les seuils, les poids et le matching ne sont pas touchés.

---

## 2. Parcours client prévu

### Flux standard (flag désactivé)

1. Le client reçoit une opportunité par notification (email ou Telegram).
2. Il clique sur un lien feedback inclus dans la notification.
3. Trois types de feedback sont disponibles :

   - `relevant` — "✅ Pertinent"
   - `irrelevant` — "❌ Pas pertinent"
   - `watch` — "👀 À surveiller"

4. Le clic déclenche une requête GET vers `/feedback?client_id=...&type=...&item_id=...&critere=...&radar_type=...`.
5. L'événement est enregistré dans `data/feedback/feedback-events.jsonl`.
6. Le client reçoit une page de confirmation HTML (`✅ Merci, votre retour a été enregistré.`).

### Flux enrichi (flag `FEEDBACK_REASON_LINKS_ENABLED=true` — local uniquement)

Lorsque le flag est activé localement, 8 liens sont proposés au lieu de 3, avec un paramètre `?r=<reason>` capturé passivement :

| Lien affiché | Type | Raison (`?r=`) |
|---|---|---|
| ✅ Pertinent | `relevant` | *(aucune)* |
| ❌ Pas mon métier | `irrelevant` | `not_my_business` |
| ❌ Mauvais acheteur | `irrelevant` | `wrong_buyer` |
| ❌ Mauvaise zone | `irrelevant` | `wrong_zone` |
| ❌ Mauvais produit | `irrelevant` | `wrong_product` |
| 👀 Pas sûr(e) | `watch` | `not_sure` |
| 👀 Infos insuffisantes | `watch` | `insufficient_info` |
| 👀 Autre | `watch` | `other` |

> La raison est optionnelle et capturée passivement : un lien sans `?r=` reste valide. Un `?r=` inconnu est ignoré silencieusement.

---

## 3. Mapping apprentissage

Le convertisseur (`convert-feedback-events-to-review-csv.js`) traduit les événements feedback en décisions de review selon le tableau suivant :

| Type | Raison (`?r=`) | Décision review | `human_review_reason` |
|---|---|---|---|
| `relevant` | *(toutes)* | `keep` | `bon_signal_bon_contexte` |
| `irrelevant` | *(absente ou inconnue)* | `reject` | `hors_profil` |
| `irrelevant` | `not_my_business` | `reject` | `hors_profil` |
| `irrelevant` | `wrong_buyer` | `reject` | `hors_profil` |
| `irrelevant` | `wrong_zone` | `reject` | `hors_profil` |
| `irrelevant` | `wrong_product` | `reject` | `bon_signal_mauvais_contexte` |
| `watch` | *(toutes)* | `ignore` | `ambigu` |
| `duplicate` | *(toutes)* | `ignore` | `ignore_non_decidable` |
| `out_of_scope` | *(toutes)* | `ignore` | `ignore_non_decidable` |
| `wrong_category` | *(toutes)* | `ignore` | `ignore_non_decidable` |

> La distinction `wrong_product` → `bon_signal_mauvais_contexte` est importante : elle indique que le matching était techniquement correct mais que le contexte client ne correspondait pas, ce qui est un signal qualitatif différent d'un vrai hors-profil.

---

## 4. Procédure bêta locale

### Étape 1 — Vérifier l'état du repo

```powershell
git status --short
npm test
npm run typecheck
```

Tous les tests doivent passer. Le repo doit être propre (pas de modifications non intentionnelles).

### Étape 2 — Vérifier les événements collectés

```powershell
# Vérifier que le fichier existe et contient des événements valides
Get-Content data/feedback/feedback-events.jsonl | Select-Object -First 5
```

Chaque ligne doit être un JSON valide avec au minimum : `client_id`, `radar_type`, `item_id`, `critere`, `type`, `created_at`.

### Étape 3 — Convertir en CSV (dry-run obligatoire)

```powershell
node scripts/convert-feedback-events-to-review-csv.js `
  --input data/feedback/feedback-events.jsonl `
  --dry-run
```

Le dry-run affiche les statistiques et les lignes CSV sans écrire de fichier. Vérifier :
- Le nombre d'événements traités
- La répartition `keep` / `reject` / `ignore`
- La cohérence des `human_review_reason`

### Étape 4 — Générer le CSV (après validation dry-run)

```powershell
node scripts/convert-feedback-events-to-review-csv.js `
  --input data/feedback/feedback-events.jsonl `
  --output data/review/feedback-review-$(Get-Date -Format 'yyyyMMdd').csv
```

### Étape 5 — Relire le CSV manuellement

Ouvrir le CSV et vérifier ligne par ligne :
- Les décisions sont cohérentes avec les feedbacks reçus.
- Aucune décision aberrante (ex: `keep` sur un signal clairement hors-profil).
- Les `review_source` sont bien `client` et non `operator`.

### Étape 6 — Importer après validation humaine

```powershell
node scripts/import-review-decisions.js `
  data/review/feedback-review-<date>.csv `
  --review-source client
```

> **Import manuel uniquement.** Ne jamais automatiser cette étape sans validation explicite.

---

## 5. Règles de sécurité

Ces règles sont impératives et ne doivent pas être contournées :

1. **Pas d'import automatique** — Les feedbacks client ne doivent jamais être importés automatiquement. Toujours passer par le dry-run + relecture manuelle + import explicite.

2. **Pas de mélange de sources** — Ne jamais mélanger `review_source=client` et `review_source=operator` dans un même cycle d'import. Les décisions operator priment toujours.

3. **Pas de modification directe du scoring** — Le feedback client n'affecte jamais directement les seuils, poids, guards ou le matching. Il alimente uniquement les données de review, qui sont analysées séparément.

4. **Pas de liens enrichis en prod sans validation** — `FEEDBACK_REASON_LINKS_ENABLED=true` ne doit pas être défini dans les secrets Fly avant validation complète en local (tests, volume bêta, relecture).

5. **Pas de commit de données** — Ne jamais committer `data/feedback/feedback-events.jsonl` ni les CSV générés, sauf décision explicite documentée.

6. **Pas d'activation clean/shadow en prod** — Le mode shadow et le mode clean restent désactivés en production pendant toute la phase bêta feedback.

---

## 6. Critères GO pour bêta client

Tous ces critères doivent être vérifiés avant d'engager un client pilote :

- [ ] Repo propre (`git status --short` ne montre rien d'inattendu)
- [ ] Tests complets OK (`npm test` — tous passent)
- [ ] Typecheck OK (`npm run typecheck` — 0 erreur)
- [ ] Handler feedback testé localement (FBH-1..28 ✅)
- [ ] Convertisseur testé localement (CFE-1..25 ✅)
- [ ] Liens feedback testés localement (FBL-1..20 ✅)
- [ ] Test synthétique JSONL → CSV validé (GD-079 ✅)
- [ ] Client pilote identifié et informé du protocole bêta
- [ ] Volume de départ faible (1 client, quelques opportunités)
- [ ] Import manuel prévu et planifié
- [ ] Revue humaine avant toute promotion de décision
- [ ] Aucun secret Fly modifié

---

## 7. Critères NO-GO

Si l'un de ces critères est vrai, ne pas lancer la bêta :

- Production instable (erreurs récentes, alertes actives)
- Supabase non vérifiée ou connexion incertaine
- Liens feedback non testés localement
- Client non informé du protocole bêta et de l'usage de ses données
- Import automatique de feedbacks envisagé sans revue humaine
- Mode clean/shadow activé en production
- `FEEDBACK_REASON_LINKS_ENABLED=true` défini en prod sans validation locale préalable
- Tests échouants ou typecheck avec erreurs

---

## 8. Commandes de contrôle

Commandes à exécuter systématiquement avant et après chaque opération feedback :

```powershell
# État du repo
git status --short

# Tests complets
npm test

# Vérification des types
npm run typecheck

# Vérification whitespace/marqueurs
git diff --check

# Diff ciblé sur les fichiers feedback
git diff -- scripts/feedback-handler.js scripts/feedback-links-builder.js scripts/convert-feedback-events-to-review-csv.js radar-bc-bot.js
```

---

## Historique du document

| Date | Version | Description |
|---|---|---|
| 2026-06-23 | 1.0 | Création initiale — GD-081 |

---

*Ce document est une référence opérationnelle locale. Il ne décrit pas un déploiement production.*
*Toute modification de ce protocole doit être validée avant application.*
