# Cycle local de calibration -- 2026-06-19

## Contexte

Cycle complet de calibration shadow exécuté en local le 2026-06-19.
Repo : `radar-bc-bot-clean-2` — mode snapshot-only, aucun impact prod.

---

## 1. Snapshot

| Paramètre        | Valeur                                |
|------------------|---------------------------------------|
| Fichier          | `data/input-snapshots/bc-input-*.jsonl` (dernier) |
| Nombre de BC     | 1 217                                 |
| Mode             | `RADAR_BC_SNAPSHOT_ONLY=1` (local uniquement) |
| Prod touchée     | Non                                   |

---

## 2. Shadow report

| Paramètre        | Valeur                                            |
|------------------|---------------------------------------------------|
| Fichier          | `data/shadow/shadow-bc-input-replay-2026-06-19T01-42-24.json` |
| Client           | TEST PROD - Nettoyage Hygiène                     |
| legacy           | 96                                                |
| clean            | 27                                                |
| both (legacy + clean) | 22                                           |
| legacy_only      | 74                                                |
| clean_only       | 5                                                 |
| fp_rate (legacy) | ~77 %                                             |

---

## 3. Candidats détectés (mode clean)

| Type             | Nombre | Détail                                             |
|------------------|--------|----------------------------------------------------|
| auto_candidates  | 1      | BC 352828 — score 20 — dératisation, désinsectisation |
| review_candidates | 4     | BC 353069, 351124, 351119, 352901 — signal hygiène |

---

## 4. Décisions humaines enregistrées

### Cycle 2026-06-19T00-20-06

| BC     | Décision | Raison                        | Commentaire                          |
|--------|----------|-------------------------------|--------------------------------------|
| 352828 | keep     | bon_signal_bon_contexte       | Désinsectisation + dératisation locaux CHU |
| 353069 | reject   | bon_signal_mauvais_contexte   | Signal hygiène issu du nom organisme, pas du besoin |
| 351124 | reject   | bon_signal_mauvais_contexte   | Contexte médico-technique hors profil |

### Cycle 2026-06-19T01-42-24

| BC     | Décision | Raison                        | Commentaire                          |
|--------|----------|-------------------------------|--------------------------------------|
| 352828 | keep     | autre                         | Désinsectisation/dératisation — besoin opérationnel hygiène |
| 351119 | keep     | autre                         | Achat insecticide/produits chimiques — besoin concret malgré contexte DMSPS |
| 352901 | reject   | bon_signal_mauvais_contexte   | Location voiture de service — signal hygiène vient du nom organisme |

---

## 5. Apprentissage P7 (analyze-review-reason-learning)

| Paramètre               | Valeur |
|-------------------------|--------|
| Décisions utilisées     | 12     |
| Groupes signal/contexte | 7      |
| Suggestions générées    | 1      |

Le script `analyze-review-reason-learning.js` a été exécuté en mode agrégé
sur l'ensemble du dossier `data/shadow/` pour inclure l'historique complet.

---

## 6. Candidat hint P8 (build-review-reason-hint-candidates)

| Champ           | Valeur                                        |
|-----------------|-----------------------------------------------|
| candidate_id    | `rrhc_0bb0c414b425`                           |
| signal_key      | `hygiène`                                     |
| client_key      | `TEST PROD - Nettoyage Hygiène`               |
| context_key     | `medical_admin_context`                       |
| hint_type       | `context_demote_to_review`                    |
| action          | `block_auto_and_send_to_review`               |
| evidence        | 3 décisions, 100 % reject                     |
| confidence      | medium                                        |

---

## 7. Approbation du hint

| Paramètre          | Valeur                                                       |
|--------------------|--------------------------------------------------------------|
| Fichier source     | `review-reason-hint-candidates-2026-06-19T13-01-02-753Z.json` |
| Fichier approved   | `review-reason-hint-candidates-approved-2026-06-19T13-05-40-671Z.json` |
| Approuvé le        | 2026-06-19T13:05:40.671Z                                     |
| Note               | 3/3 rejets sur hygiène+medical_admin_context (353069, 351124, 352901). Hint context_demote_to_review confirmé. |
| Safety             | `shadow_only` — inchangé                                     |
| human_validation_required | true                                                |

Commande utilisée :
```
node scripts/approve-review-reason-hint-candidate.js \
  data/review-learning/review-reason-hint-candidates-2026-06-19T13-01-02-753Z.json \
  rrhc_0bb0c414b425 \
  --note "Approuve le 2026-06-19 : 3/3 rejets sur hygiène+medical_admin_context (353069, 351124, 352901). Hint context_demote_to_review confirmé."
```

---

## 8. Validation shadow (analyze-shadow-report)

Commande de validation :
```
node scripts/analyze-shadow-report.js \
  data/shadow/shadow-bc-input-replay-2026-06-19T01-42-24.json \
  --export-review --export-review-csv \
  --review-reason-hints data/review-learning/review-reason-hint-candidates-approved-2026-06-19T13-05-40-671Z.json
```

Résultat :

| Vérification                        | Statut |
|-------------------------------------|--------|
| Hint chargé (`[RRH] 1 hint(s)`)    | OK     |
| BC 353069 → review_candidate + hint actif | OK |
| BC 351124 → review_candidate + hint actif | OK |
| BC 351119 → review_candidate (score effectif 12) + hint actif | OK |
| BC 352901 → review_candidate + hint actif | OK |
| BC 352828 → auto_candidate (dératisation/désinsectisation, hint non applicable) | OK |

Message hint appliqué sur les 4 BCs concernés :
> `Hint client actif (hygiène:demote_to_review) : l'auto-notification est bloquée sur la base des décisions historiques de ce client pour ce signal.`

### Exports générés

| Fichier                                              | Contenu             |
|------------------------------------------------------|---------------------|
| `data/shadow/review-candidates-2026-06-19T13-06-01.json` | 4 review candidates |
| `data/shadow/review-candidates-2026-06-19T13-06-01.csv`  | idem, CSV           |
| `data/shadow/auto-candidates-admin-2026-06-19T13-06-01.json` | 1 auto candidate |
| `data/shadow/legacy-vs-clean-admin-2026-06-19T13-06-01.json` | 79 lignes comparaison |

---

## 9. Garanties de non-régression

| Contrainte                          | Vérifiée |
|-------------------------------------|----------|
| Prod non touchée                    | Oui      |
| clean non activé en production      | Oui      |
| Fly non appelé                      | Oui      |
| Supabase bcs_vus non modifié        | Oui      |
| Notifications non envoyées          | Oui      |
| Scoring/seuils/poids non modifiés   | Oui      |
| Aucun commit sur les artefacts data | Oui      |
| Aucun push                          | Oui      |

---

## 10. Fichiers créés ou modifiés lors de ce cycle

```
data/human-review-input/human-review-input-filled-2026-06-19T00-20-06.json
data/human-review-input/human-review-input-filled-2026-06-19T01-42-24.json
data/human-review/human-review-decisions-2026-06-19T12-53-19-718Z.json
data/human-review/human-review-decisions-for-learning-2026-06-19T12-53-19-718Z.json
data/review-learning/review-reason-learning-report-2026-06-19T12-53-25.json
data/review-learning/review-reason-hint-candidates-2026-06-19T12-53-29-688Z.json
data/review-learning/review-reason-hint-candidates-2026-06-19T13-01-02-753Z.json
data/review-learning/review-reason-hint-candidates-approved-2026-06-19T13-05-40-671Z.json
data/shadow/review-candidates-2026-06-19T13-06-01.json
data/shadow/review-candidates-2026-06-19T13-06-01.csv
data/shadow/auto-candidates-admin-2026-06-19T13-06-01.json
data/shadow/auto-candidates-admin-2026-06-19T13-06-01.csv
data/shadow/legacy-vs-clean-admin-2026-06-19T13-06-01.json
data/shadow/legacy-vs-clean-admin-2026-06-19T13-06-01.csv
docs/LOCAL_REVIEW_CYCLE_2026-06-19.md   ← ce fichier
```

Aucun fichier de code source modifié.
