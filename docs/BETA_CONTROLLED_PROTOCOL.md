# BETA_CONTROLLED_PROTOCOL.md - Radar BC

> Protocole operationnel pour une beta controlee Radar BC.
> Version : 2026-06-20
> Perimetre : shadow-only local - aucune activation prod automatique.

---

## 1. Architecture actuelle

### 1.1 Couches du systeme

| Couche | Outil | Statut |
|---|---|---|
| **Prod legacy** | `radar-bc-bot.js` | Actif, stable, intouche |
| **Clean shadow** | `replay-shadow-from-input-snapshot.js` | Local uniquement |
| **Review humaine** | `analyze-shadow-report.js --export-review-csv` | Local uniquement |
| **Import decisions** | `import-review-decisions.js` | Local uniquement |
| **Learning hints** | `build-review-reason-hint-candidates.js` + `approve-*` | Shadow-only |
| **Application hints** | `apply-review-reason-hints-shadow.js` | Shadow-only |
| **Activation client** | Non disponible | Hors perimetre beta |

### 1.2 Garanties d'isolation

- Le matching clean ne touche pas Supabase, Fly, ni les notifications.
- `bcs_vus` n'est jamais ecrit par le pipeline shadow.
- Les hints ont `safety=shadow_only` et ne peuvent pas etre actives en prod.
- Aucun `auto_notify_candidate` n'est cree par un hint.
- Le score brut d'un BC n'est jamais modifie par un hint.

### 1.3 Flux de donnees

```
Prod legacy (Fly)
    |
    v
RADAR_BC_WRITE_INPUT_SNAPSHOT=1
    |
    v
data/input-snapshots/  <-- snapshot local
    |
    v
replay-shadow-from-input-snapshot.js
    |
    v
data/shadow/            <-- rapport shadow local
    |
    v
analyze-shadow-report.js --export-review-csv
    |
    v
[HUMAIN] decision keep / reject / ignore
    |
    v
import-review-decisions.js --> data/review-decisions/
    |
    v
build-review-reason-hint-candidates.js --> hint candidates
    |
    v
[HUMAIN] approve-review-reason-hint-candidate.js
    |
    v
apply-review-reason-hints-shadow.js --> replay avec hints
```

---

## 2. Flux quotidien recommande

### Etape 1 - Scan prod legacy (automatique)

La prod legacy tourne en cron sur Fly. Le snapshot d'entree est ecrit
automatiquement si `RADAR_BC_WRITE_INPUT_SNAPSHOT=1` est actif.

Verifier la disponibilite du snapshot :
```powershell
ls data\input-snapshots```

### Etape 2 - Replay shadow local

```powershell
node scripts/replay-shadow-from-input-snapshot.js
```

Sortie : `data/shadow/shadow-bc-input-replay-<date>.json`

### Etape 3 - Export review CSV

```powershell
node scripts/analyze-shadow-report.js data\shadow\shadow-bc-input-replay-<date>.json --export-review-csv
```

Sortie : `data/shadow/review-candidates-<date>.csv`

### Etape 4 - Decision humaine / client

Ouvrir le CSV. Pour chaque BC :
- `keep` : BC pertinent, a envoyer au client
- `reject` : BC non pertinent, faux positif
- `ignore` : Donnees insuffisantes, pas de decision

Sauvegarder le CSV complete.

### Etape 5 - Import des decisions

```powershell
node scripts/import-review-decisions.js data\shadoweview-candidates-<date>.csv
```

Sortie : `data/review-decisions/review-decisions-<date>.json`

### Etape 6 - Generation de hints candidates

```powershell
node scripts/build-review-reason-hint-candidates.js
```

Sortie : `data/review-learning/review-reason-hint-candidates-<date>.json`

### Etape 7 - Validation humaine des hints

Examiner chaque hint propose. Pour approuver :
```powershell
node scripts/approve-review-reason-hint-candidate.js <candidate_id>
```

Verifier avant d'approuver :
- Le hint est generique (pas de regles metier specifiques)
- Le contexte est fiable
- Le signal est non ambigu
- L'action est `block_auto_and_send_to_review` uniquement

### Etape 8 - Application shadow-only (mesure avant/apres)

Sans hint :
```powershell
node scripts/analyze-shadow-report.js data\shadow\shadow-bc-input-replay-<date>.json
```

Avec hint approuve :
```powershell
node scripts/analyze-shadow-report.js data\shadow\shadow-bc-input-replay-<date>.json   --review-reason-hints dataeview-learningeview-reason-hint-candidates-approved-<date>.json
```

Comparer : nombre d'auto, nombre de review, BC deplaces auto->review.

---

## 3. Regles GO / NO-GO

### GO - Notifier automatiquement (auto_notify_candidate)

- Score >= 15
- Pas de signal risque seul (`hygiene`, `informatique` seuls)
- Pas de `weak_single_signal`
- Contexte client clair (profil defini)
- Aucun hint `block_auto_and_send_to_review` applicable

### REVIEW - Garder en review humaine

- Score entre 5 et 14
- Signal unique faible (`weak_single_signal=true`)
- Signal ambigu ou risque sans contexte primaire
- Hint applicable avec action `send_to_review`
- `ctx_alignment=unclear` ou `ctx_ambiguity=high`

### BLOCK - Bloquer l'auto et envoyer en review

- Hint approuve avec action `block_auto_and_send_to_review`
- Signal `hygiÃ¨ne` en contexte medical (risque d'inadÃ©quation)
- Score >= 15 mais hint interdit l'auto

### IGNORE - Ne rien apprendre

- BC sans decision humaine claire
- BC avec donnees insuffisantes
- BC hors profil client (pas de signal principal)
- Decisions contradictoires sur un meme pattern

---

## 4. Garde-fous obligatoires

| Regle | Detail |
|---|---|
| **Pas de prod automatique** | Aucun hint ne peut activer `auto_notify_candidate=true` |
| **Validation humaine obligatoire** | `human_validation_required=true` sur tout hint |
| **Shadow-only permanent** | `safety=shadow_only` inchangeable dans le code |
| **Pas de budget/prix** | `budget`, `prix`, `montant`, `estimation` interdits dans les raisons |
| **Pas de scoring modifie** | Le score brut (`clean_score`) n'est jamais touche par un hint |
| **Pas de seuil modifie** | Les seuils (15, 5) restent constants |
| **Pas de regles metier codees** | Aucun hardcode client, signal, domaine dans le code |
| **Pas d'activation clean prod** | Le pipeline clean reste local uniquement |
| **Pas de Supabase/bcs_vus** | Aucune ecriture en base depuis le pipeline shadow |
| **Pas de deploy/Fly** | Le protocole beta ne touche pas l'infra Fly |
| **Pas de notification** | Aucun message Telegram/WhatsApp/Email depuis shadow |

---

## 5. Indicateurs simples pour la beta

### 5.1 Indicateurs de base (par cycle quotidien)

| Indicateur | Source | Cible |
|---|---|---|
| BC auto notifies | `auto_candidates` dans rapport shadow | Stable, croissant |
| BC en review | `review_candidates` dans rapport shadow | A qualifier |
| Faux positifs auto | Decisions `reject` sur auto | Minimiser |
| Bons BC en review | Decisions `keep` sur review | Maximiser |
| Decisions `keep` | `data/review-decisions/` | > 50% |
| Decisions `reject` | `data/review-decisions/` | < 30% |
| Decisions `ignore` | `data/review-decisions/` | < 20% |

### 5.2 Indicateurs de learning

| Indicateur | Source | Cible |
|---|---|---|
| Hints proposes | `build-review-reason-hint-candidates.js` | Qualite > quantite |
| Hints approuves | `approve-review-reason-hint-candidate.js` | Uniquement hints fiables |
| Hints appliques (shadow) | `review_reason_hint_applied=true` | Coherent avec decisions |
| Delta auto->review par hint | Comparaison avant/apres | > 0 si hint pertinent |
| Score moyen auto | Rapport shadow | >= 15, stable |

### 5.3 Indicateurs de stabilite

| Indicateur | Commande | Attendu |
|---|---|---|
| Tests passes | `npm test` | 100% |
| Typecheck | `npm run typecheck` | 0 erreur |
| Audit learning cycle | `node scripts/audit-review-learning-cycle.js` | 0 FAIL |
| Ratio weak_single | rapport shadow | < 70% |
| Taux risque auto | rapport shadow | 0 signal risque seul en auto |

---

## 6. Criteres de passage en beta client

Le passage en beta client signifie que le client reelle commence a recevoir
les decisions de review pour feedback. La prod legacy reste inchangee.

### Criteres obligatoires (tous requis)

- [ ] Prod legacy stable depuis >= 7 jours sans regression
- [ ] Clean shadow stable sur >= 3 cycles quotidiens consecutifs
- [ ] Ratio `auto_strong` / `auto_total` >= 80% (peu de weak_single en auto)
- [ ] Review exportable et exploitable par le client
- [ ] Au moins un cycle complet keep/reject/ignore importe avec succes
- [ ] Au moins un hint genere, valide, applique en shadow
- [ ] Tests 100% passes
- [ ] Audit `audit-review-learning-cycle.js` : 0 FAIL
- [ ] Rollback defini : retour prod legacy en < 5 minutes (juste cesser le replay shadow)

### Conditions de passage progressif

1. Phase 1 : partage du CSV review avec le client pilote (pas de code)
2. Phase 2 : import des decisions client dans le systeme
3. Phase 3 : generation et validation des hints avec le client
4. Phase 4 : mesure de l'impact shadow avec les hints client

---

## 7. Criteres d'interdiction

Toute condition ci-dessous bloque l'avancement ou impose un retour arriere.

### 7.1 Interdictions absolues (bloquantes immediates)

| Condition | Action |
|---|---|
| Auto candidate avec signal risque seul (`hygiene` seul, `informatique` seul) | Bloquer, deplacer en review |
| Hint avec `scope=global` ou `context_key` vide | Refuser le hint |
| Hint avec action `auto_notify`, `boost_score`, `change_threshold`, `change_weight`, `apply_to_prod`, `activate` | Rejet automatique par le code |
| Score modifie apres application de hint | Incident grave, arreter le pipeline |
| `auto_notify_candidate=true` cree par un hint | Incident grave, arreter le pipeline |

### 7.2 Interdictions de progression (bloquantes pour la beta client)

| Condition | Action |
|---|---|
| Tests rouges | Bloquer, corriger avant tout |
| Typecheck avec erreurs | Bloquer, corriger avant tout |
| Audit `audit-review-learning-cycle.js` avec FAIL | Bloquer, analyser |
| Hint trop large (signal generique sans contexte) | Refuser le hint |
| Contexte non fiable (`ctx_alignment=unclear` > 50% des BC) | Revoir le profil client |
| Profil client incomplet (champs manquants) | Completer le profil avant generation de hints |
| Donnees insuffisantes (< 3 cycles de decisions) | Attendre plus de cycles |

### 7.3 Interdictions permanentes (inchangeables)

| Regle | Justification |
|---|---|
| `safety=shadow_only` sur les hints | Jamais modifiable dans le code |
| Pas d'ecriture dans `bcs_vus` depuis le pipeline shadow | Isolation prod garantie |
| Pas de modification du scoring (seuils, poids) | Stabilite du referentiel |
| Pas de deploy Fly depuis ce protocole | Hors perimetre beta |
| Pas de hint avec raison budgetaire | Hors perimetre metier du radar |

---

## Annexe - Commandes de reference rapide

```powershell
# Verifier l'etat du repo avant toute operation
git status --short
npm test
npm run typecheck
node scripts/audit-review-learning-cycle.js

# Cycle complet (adapter les dates)
node scripts/replay-shadow-from-input-snapshot.js
node scripts/analyze-shadow-report.js data\shadow\shadow-bc-input-replay-<date>.json --export-review-csv
# [HUMAIN] completer le CSV
node scripts/import-review-decisions.js data\shadow\review-candidates-<date>.csv
node scripts/build-review-reason-hint-candidates.js
# [HUMAIN] approuver les hints
node scripts/approve-review-reason-hint-candidate.js <candidate_id>
# Mesure avant/apres
node scripts/analyze-shadow-report.js data\shadow\shadow-bc-input-replay-<date>.json
node scripts/analyze-shadow-report.js data\shadow\shadow-bc-input-replay-<date>.json --review-reason-hints data\review-learning\review-reason-hint-candidates-approved-<date>.json
```

---

*Document cree GD-055 - 2026-06-20. Ne pas modifier sans ticket valide.*
