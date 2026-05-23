# Roadmap — Migration progressive vers Anaho

## Principe directeur

> À chaque phase, le système en production continue de fonctionner exactement comme avant.  
> Le `radar-bc-bot.js` ne plante pas, ne régresse pas.  
> Chaque phase se valide par des tests avant de passer à la suivante.

---

## Phase 0 — Stabilisation (maintenant, avant tout)

**Objectif** : corriger les bugs bloquants de la version actuelle avant de commencer la migration.

| Tâche | Fichier | Priorité |
|-------|---------|----------|
| Fix RLS Supabase — critères non sauvegardés | `migration_v10_fix.sql` | 🔴 Critique |
| Fix route `/` — JSON au lieu du portail | `radar-bc-bot.js:2190` | 🔴 Critique |
| Fix `loadClient()` — auto-création si absent | `web/index.html` | 🔴 Critique |
| Endpoint `POST /api/enrich-critere` | `radar-bc-bot.js` | 🟠 Important |
| Tests manuels E2E en production | — | 🟠 Important |

**Sortie de Phase 0** : le portail client fonctionne, les critères s'enregistrent, l'enrichissement IA est déclenché.

---

## Phase 1 — Schemas (Semaine 1–2)

**Objectif** : introduire la validation runtime sans changer aucun comportement.

### Livrables

```
core/schemas/bc.schema.js        ← BCItem, Article, BCDetail
core/schemas/client.schema.js    ← Client, Critere, BusinessProfile, TechnicalProfile
core/schemas/scoring.schema.js   ← ScoreResult, Signal, MatchExplanation
core/schemas/feedback.schema.js  ← MatchFeedback, ProfileSnapshot
tests/schemas.test.js            ← Tests Zod : parse/reject sur données réelles
```

### Point de jonction (1 ligne dans le legacy)

Dans `runGlobalScanBC()`, après `loadDetails()` :
```js
// Avant matching : valider chaque item
const validItems = items.map(i => BCItem.safeParse(i)).filter(r => r.success).map(r => r.data);
```

Les items invalides sont loggés et ignorés, sans planter le scan.

### Critères de sortie de phase
- [ ] Tous les schemas Zod définis et exportés
- [ ] `tests/schemas.test.js` passe à 100%
- [ ] Aucun item valide rejeté par les schemas sur 2 scans réels
- [ ] Aucun item invalide ne plante le pipeline

---

## Phase 2 — Scoring déterministe (Semaine 3–4)

**Objectif** : remplacer le booléen `matchCritere()` par un score 0–100 avec explication.

### Livrables

```
core/scoring/signals.js          ← Extraction business_signals + technical_signals
core/scoring/deterministic.js    ← score(), retourne ScoreResult
core/scoring/explainer.js        ← Génère explication en français
core/matching/matcher.js         ← matchCritereV2() : ScoreResult au lieu de boolean
tests/scoring.test.js            ← Tests sur golden dataset
tests/matching.test.js           ← Tests comparatifs v1/v2
```

### Seuils de score par pack (proposition initiale)

| Pack | Seuil notification | Commentaire |
|------|--------------------|-------------|
| Starter | ≥ 50 | Large, peu de faux positifs |
| Pro | ≥ 40 | Plus sensible, LLM valide ensuite |
| Business | ≥ 35 | Maximal, LLM toujours actif |

Ces seuils sont configurables sans redéploiement (table `pack_config`).

### Point de jonction (1 remplacement dans le legacy)

Dans `matchClient()` :
```js
// Avant (legacy)
if (!itemMatchesCriteres(item, criteres)) continue;

// Après (core branché)
const scoreResult = matchCritereV2(item, criteres, packLimits);
if (scoreResult.score < packLimits.scoreThreshold) continue;
await saveMatchScore(client.id, item.id, scoreResult);  // trace
```

### Critères de sortie de phase
- [ ] `core/scoring/` complet et testé
- [ ] Score cohérent avec le matching legacy sur golden dataset (≥95% d'accord)
- [ ] Explication lisible retournée pour chaque match
- [ ] `match_scores` persisté en base pour chaque notification envoyée

---

## Phase 3 — Intelligence séparée (Semaine 5–6)

**Objectif** : séparer business intent / technical intent. Migrer l'IA dans core/.

### Livrables

```
core/intelligence/enrich.js      ← enrichCritereWithAI() migré + typé
core/intelligence/validate.js    ← validateMatchWithAI() migré + LLM assistif seulement
core/intelligence/profile.js     ← Déduction profil métier depuis historique critères
core/intelligence/llm.js         ← Couche unifiée Ollama/Claude (extraite du legacy)
```

### Règle LLM dans cette phase

```
LLM peut : enrichir variantes, générer résumé, flaguer "à vérifier"
LLM ne peut pas : décider de ne pas envoyer une notification si score > seuil
```

Le flag `⚠️ À vérifier` est ajouté au message mais la notification est toujours envoyée.

### Critères de sortie de phase
- [ ] Séparation `business_signals` / `technical_signals` dans les schemas
- [ ] LLM n'a plus de pouvoir de rejet autonome
- [ ] Enrichissement migré dans `core/intelligence/` sans régression
- [ ] `tests/regression.test.js` passe à 100% sur golden dataset

---

## Phase 4 — Feedback loop (Semaine 7–8)

**Objectif** : rendre le système apprenant de façon traçable et rollbackable.

### Livrables

```
core/feedback/learner.js         ← Ajuste poids scoring depuis match_feedback
core/feedback/rollback.js        ← Restaure profil à snapshot antérieur
```

### Migrations SQL

```sql
CREATE TABLE match_scores          ← trace de chaque scoring
CREATE TABLE match_feedback        ← retour utilisateur (pertinent/non_pertinent)
CREATE TABLE client_profile_snapshots ← rollback de profil
```

### Endpoint HTTP (dans le server legacy existant)

```
POST /api/feedback?secret=xxx
Body: { match_score_id, verdict: 'pertinent'|'non_pertinent'|'a_verifier', commentaire? }
```

### Règles du learner

- Un seul feedback ne change rien
- 3 feedbacks négatifs sur le même pattern → candidat à ajustement
- Tout ajustement de poids → snapshot préalable du profil
- Ajustement validé manuellement en Phase 4, automatique seulement en Phase 5

### Critères de sortie de phase
- [ ] Feedback enregistré et lié au match_score
- [ ] Snapshot créé avant tout ajustement
- [ ] Rollback testé et fonctionnel
- [ ] Dashboard admin affiche les feedbacks reçus

---

## Phase 5 — IA locale (Futur, non daté)

**Prérequis stricts avant d'envisager cette phase :**

- Phase 1–4 en production depuis ≥ 30 jours
- Golden dataset ≥ 50 cas annotés, couvrant faux positifs et vrais positifs
- Tests non-régression à 100% depuis ≥ 2 semaines
- Feedback loop actif avec ≥ 20 feedbacks réels reçus

**Objectif** : remplacer les appels Claude API par un modèle local (Ollama/qwen) pour réduire les coûts et la latence.

---

## Métriques de suivi

| Métrique | Cible | Mesurée comment |
|----------|-------|-----------------|
| Taux de faux positifs | < 15% | Ratio feedbacks négatifs / total envois |
| Score moyen des vrais positifs | > 65 | `match_scores` WHERE verdict = 'pertinent' |
| Temps enrichissement LLM | < 3s | Logs Supabase `ai_cache` |
| Couverture tests | > 90% | Jest coverage |
| Fiabilité scraping | > 99% | `scan_logs` erreurs / total |
