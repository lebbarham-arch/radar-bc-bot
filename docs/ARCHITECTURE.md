# Architecture — Anaho Intelligent BC Radar

## Vision produit

Anaho n'est pas un moteur d'alertes par mots-clés.  
C'est un système de **qualification intelligente de bons de commande publics marocains**.

La distinction fondamentale :

> Un système d'alerte dit : *"ce BC contient ton mot-clé"*.  
> Anaho dit : *"ce BC correspond à ton métier, avec ce niveau de confiance, pour ces raisons précises"*.

---

## Principe d'architecture : Legacy stable + Core progressif

Le système existant (`radar-bc-bot.js`) continue de tourner **sans modification**.  
Le nouveau core est construit à côté, branché progressivement sur des points de jonction précis.

### Règle absolue

```
radar-bc-bot.js  →  ne jamais modifier sauf régression scraping
core/            →  tout ce qui est nouveau se construit ici
```

---

## Structure cible

```
radar-bc-bot/
│
├── radar-bc-bot.js              ← LEGACY — ne pas toucher
│
├── core/
│   ├── schemas/
│   │   ├── bc.schema.js         ← Zod : BCItem, Article, BCDetail
│   │   ├── client.schema.js     ← Zod : Client, Critere, BusinessProfile
│   │   ├── scoring.schema.js    ← Zod : ScoreResult, MatchExplanation, Signal
│   │   └── feedback.schema.js   ← Zod : MatchFeedback, FeedbackEvent
│   │
│   ├── scoring/
│   │   ├── deterministic.js     ← Score 0–100 sans IA, reproductible
│   │   ├── signals.js           ← Extraction business_signals + technical_signals
│   │   └── explainer.js         ← Génère l'explication en français naturel
│   │
│   ├── intelligence/
│   │   ├── enrich.js            ← LLM : générer variantes d'un critère
│   │   ├── validate.js          ← LLM : validation assistive (jamais décideur)
│   │   └── profile.js           ← LLM : déduire profil métier du client
│   │
│   ├── matching/
│   │   └── matcher.js           ← matchCritere v2 : score + explication
│   │
│   └── feedback/
│       ├── learner.js           ← Ajustement poids depuis match_feedback
│       └── rollback.js          ← Restaurer profil à version antérieure
│
├── tests/
│   ├── fixtures/
│   │   └── golden_dataset.json  ← Cas de référence annotés manuellement
│   ├── scoring.test.js
│   ├── schemas.test.js
│   ├── matching.test.js
│   └── regression.test.js       ← Non-régression sur golden dataset
│
└── docs/                        ← Ce dossier
```

---

## Modules legacy — Ce qui ne change pas

| Module | Fichier (lignes) | Rôle | Statut |
|--------|-----------------|------|--------|
| Scraping Puppeteer | `radar-bc-bot.js:736–1780` | Navigation portail marchespublics.gov.ma | **Intouchable** |
| Login/Session | `radar-bc-bot.js:751–808` | Authentification portail | **Intouchable** |
| Cron scheduler | `radar-bc-bot.js:2323–2345` | Déclenchement toutes les 2h | **Inchangé** |
| Parsing HTML/PDF | `radar-bc-bot.js:1283–1422` | Extraction articles, texte, dates | **Inchangé** |
| HTTP server | `radar-bc-bot.js:2173–2322` | API + fichiers statiques | **Évolution lente** |

## Modules réutilisables — Extractibles dans core/

| Fonction | Lignes | Destination |
|----------|--------|-------------|
| `norm()`, `hasKw()`, `levenshtein()`, `hasAnyKw()` | 139–181 | `core/scoring/signals.js` |
| `enrichCritereWithAI()` | 445–498 | `core/intelligence/enrich.js` |
| `validateMatchWithAI()` | 499–533 | `core/intelligence/validate.js` |
| `callLLM()`, `callOllama()`, `callClaudeHaiku()` | 369–443 | `core/intelligence/llm.js` |
| `getMatchTrigger()` | 229–248 | `core/scoring/explainer.js` |
| `PACK_LIMITS`, `getPackLimits()` | 46–56 | `core/schemas/client.schema.js` |
| `sbReq()`, `db.*` | 256–364 | `core/db/supabase.js` |

## Ce qui est créé — Nouveau dans core/

| Module | Pourquoi c'est nouveau |
|--------|----------------------|
| `scoring/deterministic.js` | Le bot actuel retourne booléen. Anaho retourne score 0–100 |
| `scoring/signals.js` | Séparation business_signals / technical_signals inexistante aujourd'hui |
| `schemas/*.schema.js` | Aucune validation runtime aujourd'hui — données non typées |
| `feedback/learner.js` | Aucun apprentissage par feedback aujourd'hui |
| `feedback/rollback.js` | Aucune traçabilité des profils aujourd'hui |

---

## Points de jonction legacy → core

Le branchement se fait en **4 points précis** dans `radar-bc-bot.js`, sans réécriture :

```
Point 1 : après scrapeBCDetail()        → valider item avec BCDetail.schema
Point 2 : dans matchClient()            → remplacer matchCritere() par matcher.js
Point 3 : dans autoEnrichCriteres()     → appeler core/intelligence/enrich.js
Point 4 : HTTP server /api/feedback     → appeler core/feedback/learner.js
```

---

## Base de données — Tables à créer

Les tables existantes (`clients`, `criteres`, `bcs_envoyes`, `bcs_vus`) ne changent pas.  
Nouvelles tables pour le core Anaho :

```sql
-- Résultats de scoring (trace de chaque évaluation)
CREATE TABLE match_scores (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bc_id        TEXT NOT NULL,
  client_id    UUID NOT NULL REFERENCES clients(id),
  critere_id   UUID REFERENCES criteres(id),
  score        INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  explanation  JSONB NOT NULL,   -- { signals: [], reasons: [], trigger: string }
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Feedback utilisateur sur chaque match
CREATE TABLE match_feedback (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_score_id UUID REFERENCES match_scores(id),
  client_id    UUID NOT NULL REFERENCES clients(id),
  bc_id        TEXT NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('pertinent', 'non_pertinent', 'a_verifier')),
  commentaire  TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Snapshots de profil client (pour rollback)
CREATE TABLE client_profile_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    UUID NOT NULL REFERENCES clients(id),
  profile_data JSONB NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Flux de données Anaho (cible)

```
[Portail marchespublics.gov.ma]
        ↓ Puppeteer (legacy, inchangé)
[BCRaw] → validate(BCDetail.schema) → [BCItem validé]
        ↓
[Signals extraction]
  ├── business_signals  : secteur, type prestation, organisme pattern
  └── technical_signals : articles, spécifications, codes achats
        ↓
[Scoring déterministe] → score 0–100 + explanation[]
        ↓
[Seuil pack] : score >= threshold(pack) ?
        ↓ OUI
[LLM assistif] → résumé + flag pertinence (ne peut PAS rejeter seul)
        ↓
[Notification] Telegram / Email
        ↓
[match_scores] sauvegardé (trace complète)
        ↓ (optionnel)
[match_feedback] ← retour utilisateur
        ↓
[learner.js] ajuste poids scoring (traçable, rollbackable)
```
