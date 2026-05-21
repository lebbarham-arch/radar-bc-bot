# Radar BC Maroc — SaaS Setup

## Ce qui a été fait

| Fichier | Description |
|---|---|
| `radar-bc-bot.js` | Bot v6.3 — cron 2h, token Telegram partagé |
| `web/index.html` | Interface SaaS complète (auth + dashboard + critères + profil) |
| `web/migration.sql` | Script SQL à exécuter dans Supabase |

---

## ETAPE 1 — Supabase SQL (à faire UNE SEULE FOIS)

1. Ouvrir https://supabase.com/dashboard → votre projet
2. Cliquer **SQL Editor** → **New Query**
3. Coller le contenu de `web/migration.sql` → **Run**

---

## ETAPE 2 — Mettre à jour les secrets Fly.io

```bash
# Token Telegram partagé (votre bot @RadarBCMarocBot)
flyctl secrets set TELEGRAM_BOT_TOKEN=<votre_token_bot_telegram>

# Clé service_role (pour bypass RLS)
flyctl secrets set SUPABASE_KEY=<votre_service_role_key>
```

---

## ETAPE 3 — Déployer le bot v6.3

```bash
cd radar-bc-bot
git add radar-bc-bot.js
git commit -m "v6.3: cron 2h + token Telegram partagé"
git push origin main
flyctl deploy --ha=false
```

---

## ETAPE 4 — Publier l'interface web

### Option A : GitHub Pages (gratuit)
```bash
cd radar-bc-bot/web
git add index.html migration.sql
git commit -m "SaaS interface v1"
git push
# Aller sur GitHub → Settings → Pages → Source: main, /web
```

### Option B : Vercel (recommandé, HTTPS auto)
```bash
npm i -g vercel
cd radar-bc-bot/web
vercel deploy --prod
```

Le lien sera du type : https://radar-bc.vercel.app

---

## ETAPE 5 — Configurer Supabase Auth

Dans le dashboard Supabase :
1. **Authentication → Settings** → activer "Email confirmations" si voulu
2. **Authentication → URL Configuration** → ajouter votre domaine dans "Redirect URLs"

---

## Comment ça marche pour vos clients

1. Le client va sur votre URL → s'inscrit avec email/mot de passe
2. Un compte "client" est créé automatiquement dans Supabase (trigger SQL)
3. Il ajoute ses critères (contenu/titre/région/organisme)
4. Il renseigne son Chat ID Telegram ou son numéro WhatsApp
5. Le bot scanne toutes les 2h et notifie automatiquement

---

## Note : Token Telegram partagé

Créez UN seul bot Telegram pour tous vos clients :
1. Ouvrir @BotFather sur Telegram
2. Taper `/newbot` → nommer votre bot (ex: RadarBCMarocBot)
3. Copier le token → `flyctl secrets set TELEGRAM_BOT_TOKEN=<token>`
4. Chaque client démarre une conversation avec @VotreBot et récupère son Chat ID
