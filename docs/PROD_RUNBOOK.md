# PROD_RUNBOOK.md — Radar BC

> Runbook opérationnel — exploitation quotidienne.
> Architecture complète : `docs/ARCHITECTURE_RADAR_BC.md`.
> **Ne modifier aucun fichier JS/TS/config sans ticket validé.**

---

## 1. État prod de référence

| Élément | Valeur |
|---|---|
| App Fly | `radar-bc-bot` |
| Région principale | `fra` (Frankfurt) |
| Machine active | `d8d054dc2e6648` — état attendu : **started** |
| Machine CDG | `48e7364b99d778` — état attendu : **stopped** ⛔ |
| Fichier prod | `radar-bc-bot.js` (legacy Node.js monolithique) |
| Image de référence | `deployment-01KV9DHG84FXV91HXGP326K8R3` |
| Dernier scan validé | 17/06/2026 00:00 UTC |
| URL health | `https://radar-bc-bot.fly.dev/health` |
| URL status | `https://radar-bc-bot.fly.dev/api/status` |

---

## 2. Commandes de vérification santé

### 2.1 État des machines

```bash
fly machine list --app radar-bc-bot
```

Résultat attendu :

```
ID               REGION  STATE    IMAGE
d8d054dc2e6648   fra     started  deployment-01KV9DHG84FXV91HXGP326K8R3
48e7364b99d778   cdg     stopped  ...
```

⚠️ Si `48e7364b99d778` est `started` → stopper immédiatement :

```bash
fly machine stop 48e7364b99d778 --app radar-bc-bot
fly machine list --app radar-bc-bot   # vérifier
```

### 2.2 Health check

```bash
curl -s https://radar-bc-bot.fly.dev/health
```

Résultat attendu : `{"status":"ok", ...}`

Timeout ou `status != "ok"` → consulter les logs.

### 2.3 Status étendu

```bash
curl -s https://radar-bc-bot.fly.dev/api/status
```

Champs importants : `lastBcScanOk`, `lastBcScanAt`, `lastBcScanReason`, `uptime`.

### 2.4 Secrets présents

```bash
fly secrets list --app radar-bc-bot
```

| Secret | Obligatoire |
|---|---|
| `SUPABASE_URL` | ✅ sans lui : scans échouent |
| `SUPABASE_KEY` | ✅ sans lui : scans échouent |
| `TELEGRAM_BOT_TOKEN` | ✅ sans lui : 0 notifications |
| `RESEND_API_KEY` | Optionnel (email) |
| `ANTHROPIC_API_KEY` | Optionnel (LLM cloud) |

### 2.5 Logs

```bash
# Flux continu
fly logs --app radar-bc-bot

# 100 dernières lignes
fly logs --app radar-bc-bot -n 100

# Filtré sur les scans
fly logs --app radar-bc-bot | grep -E "SCAN BC|bcs_vus|known_count|FICHES|Telegram|markBC"
```

---

## 3. Surveillance d'un scan BC

### 3.1 Séquence normale

Un scan horaire (`0 * * * *` UTC) produit ces lignes dans l'ordre :

```
SCAN BC - <date> [source=cron runId=...]
[CTX] source=cron runId=... uptime=... scanningBC=true
[KNOWN_DIAG] bcs_vus_load total_loaded=11203 pages_loaded=12
[KNOWN_DIAG] known_count=11203 portal_total=... new=138
[BROWSER] launched ...
[FICHES] chargement N fiches BC en parallèle (concurrent=3)
[FICHES] N/M fiches chargees
markBCVus_result: N inseres
  -> Telegram OK
  -> markBCSent ...
Scan BC terminé en Xs [runId=...]
```

### 3.2 Signaux d'alerte

| Signal | Cause | Action |
|---|---|---|
| `known_count=1000` exact | Pagination bcs_vus plafonnée (PostgREST) | Créer ticket — vérifier `sbFetchAllPages` |
| `tg_token=empty` / `no_token` | `TELEGRAM_BOT_TOKEN` absent | `fly secrets set TELEGRAM_BOT_TOKEN=...` |
| `result is not defined` | Erreur JS runtime | Lire la stack trace complète dans les logs |
| `Cannot find module './dist/core/shadow/runner'` | `SHADOW_MODE_ENABLED=true` sans `dist/` compilé | Vérifier secrets — ne jamais activer shadow en prod |
| `Supabase: ...` puis arrêt scan | Supabase KO ou clé invalide | Vérifier secrets + dashboard Supabase |
| `Scan BC precedent en cours, skip` répété | Scan bloqué (timeout Puppeteer) | `fly machine restart d8d054dc2e6648 --app radar-bc-bot` |
| `SCAN BC FAILED` | Échec scraping portail | Attendre prochain cron (1h) — si persiste, ticket |
| `no_delivery_retry > 0` | Livraisons Telegram échouées | Vérifier token Telegram + logs `sendTelegram` |

### 3.3 Déclenchement manuel d'un scan

```bash
curl -X POST https://radar-bc-bot.fly.dev/api/scan-now \
  -H "Content-Type: application/json"
```

---

## 4. Procédure après deploy

Exécuter dans cet ordre **immédiatement après chaque `fly deploy`** :

```bash
# 1. Vérifier l'état des machines
fly machine list --app radar-bc-bot

# 2. Stopper CDG si elle a redémarré (TOUJOURS vérifier)
fly machine stop 48e7364b99d778 --app radar-bc-bot
fly machine list --app radar-bc-bot   # → cdg doit être stopped

# 3. Health check
curl -s https://radar-bc-bot.fly.dev/health
# → {"status":"ok", ...}

# 4. Vérifier que les secrets sont toujours présents
fly secrets list --app radar-bc-bot
# → SUPABASE_URL, SUPABASE_KEY, TELEGRAM_BOT_TOKEN présents

# 5. Surveiller le démarrage
fly logs --app radar-bc-bot -n 50
# Chercher : "Bot demarre", "Cache charge", "Premier scan BC dans Xs"
# Absence de : "Supabase KO", "tg_token=empty", "Cannot find module"

# 6. Attendre ou déclencher le premier scan
curl -X POST https://radar-bc-bot.fly.dev/api/scan-now
fly logs --app radar-bc-bot | grep -E "SCAN BC|known_count|Telegram|Scan BC terminé"
```

---

## 5. Procédure de rollback

> ⚠️ Rollback uniquement en cas d'urgence confirmée : scan bloqué, 0 notifications
> sur plusieurs scans consécutifs, erreur non résoluble par config.

```bash
# Lister les releases disponibles
fly releases --app radar-bc-bot

# Revenir à une release précédente (remplacer <id> par l'identifiant voulu)
fly deploy --image registry.fly.io/radar-bc-bot:deployment-<id>
```

Image de référence stable : `deployment-01KV9DHG84FXV91HXGP326K8R3`

**Après le rollback — obligatoire :**

```bash
# Vérifier les machines
fly machine list --app radar-bc-bot

# Stopper CDG si started
fly machine stop 48e7364b99d778 --app radar-bc-bot

# Health check
curl -s https://radar-bc-bot.fly.dev/health

# Surveiller les logs
fly logs --app radar-bc-bot -n 50
```

---

## 6. Snapshots et replay/debug

### 6.1 Nature des snapshots

Deux types de fichiers sont écrits après chaque scan :

| Type | Répertoire | Contenu | Flag requis |
|---|---|---|---|
| Scan (décisions) | `SNAPSHOT_DIR/scan-snapshots/` | 1 ligne JSONL par décision de matching (NOTIFY / SKIP / EXPIRED…) | Toujours actif |
| Entrée (BCs bruts) | `INPUT_SNAPSHOT_DIR/input-snapshots/` | 1 ligne JSONL par BC détaillé avant matching | `RADAR_BC_WRITE_INPUT_SNAPSHOT=1` |

Chaque type produit un fichier horodaté **et** un alias `latest-*.jsonl` écrasé à chaque scan.

### 6.2 Volatilité sur Fly.io

> ⚠️ `/app/data/` n'est **pas** une persistance garantie sur Fly.io.

Sans volume Fly monté (`RADAR_BC_SNAPSHOT_DIR` non défini), les snapshots sont écrits dans la couche writable du container Docker. Ils sont **perdus** à chaque :

- restart machine (`fly machine restart`)
- redeploy (`fly deploy`)
- remplacement de machine par Fly

**Impact sur la prod :** aucun. Le matching, les notifications Telegram et le scheduler ne dépendent pas des snapshots. Les routes de diagnostic retournent une réponse 404 JSON propre si aucun snapshot n'est présent.

### 6.3 Routes de diagnostic — comportement après restart

| Route | Comportement si snapshot absent |
|---|---|
| `GET /api/snapshot/latest` | `404` JSON avec hint — normal |
| `GET /api/replay-notify/list` | Liste vide, `latest_exists: false` — normal |
| `GET /api/replay-notify` | `404` JSON `"Aucun snapshot disponible"` — normal |
| `GET /api/debug-snapshot-notify` | `404` JSON `"Snapshot vide ou absent"` — normal |

Un 404 sur ces routes **ne signifie pas** que la prod est en erreur — il signifie simplement qu'aucun snapshot n'a été écrit depuis le dernier restart.

### 6.4 Télécharger le snapshot courant (avant restart)

```bash
# Snapshot des décisions (scan)
curl -s "https://radar-bc-bot.fly.dev/api/snapshot/latest?secret=<ADMIN_SECRET>&type=scan" \
  -o latest-bc-scan.jsonl

# Snapshot d'entrée (BCs bruts — requis RADAR_BC_WRITE_INPUT_SNAPSHOT=1)
curl -s "https://radar-bc-bot.fly.dev/api/snapshot/latest?secret=<ADMIN_SECRET>&type=input" \
  -o latest-bc-input.jsonl
```

A exécuter **avant** tout `fly machine restart` ou `fly deploy` si un diagnostic replay est nécessaire.

### 6.5 Persistance réelle (ticket P1-1)

Pour des snapshots survivant aux restarts, créer un volume Fly et définir `RADAR_BC_SNAPSHOT_DIR` vers ce volume. Ce changement est un ticket séparé (voir `docs/ROADMAP_TECHNIQUE.md §P1-1`) — **ne pas activer sans volume monté**.

---

## 7. Règles interdites en prod

```
❌ Ne jamais modifier fly secrets pendant qu'un scan est en cours
   Attendre "Scan BC terminé" dans les logs avant de toucher aux secrets.

❌ Ne jamais activer SHADOW_MODE_ENABLED=true en prod
   dist/ est absent du Dockerfile — require échoue silencieusement.
   Le shadow runner TS n'a pas été validé en prod.

❌ Ne jamais activer RADAR_BC_MATCH_SHADOW=1 en prod
   Écrit dans data/shadow/ (éphémère sur Fly, aucune valeur).

❌ Ne jamais déployer avec des tests Jest rouges
   npm test -- --runInBand doit afficher 394/394 avant tout deploy.

❌ Ne jamais utiliser git add .
   Toujours stager explicitement : git add <fichier>

❌ Ne jamais lancer npm audit fix
   Peut casser les dépendances Puppeteer (versions épinglées).

❌ Ne jamais modifier package.json, fly.toml, ou le scheduler
   (cron.schedule / setInterval) sans ticket et tests verts.

❌ Ne jamais activer LEGACY_USE_AI_INCLUSIONS=1
   sans vérifier que les ai_inclusions en BDD sont propres et validées.
```

---

## 8. Dernier état stable connu

| Champ | Valeur |
|---|---|
| Image validée | `deployment-01KV9DHG84FXV91HXGP326K8R3` |
| Scan validé | 17/06/2026 00:00 UTC |
| Source scan | `cron` |
| `known_count` | `11203` |
| `pages_loaded` bcs_vus | `12` (pagination correcte) |
| `new` BC détectés | `138` |
| Notifications | Telegram OK |
| `no_delivery_retry` | `0` |
| Tests Jest | `394/394` verts |
| `node --check radar-bc-bot.js` | OK |
| Machine FRA `d8d054dc2e6648` | started |
| Machine CDG `48e7364b99d778` | stopped |

---

*Architecture complète : `docs/ARCHITECTURE_RADAR_BC.md`*
*Règles scoring : `docs/SCORING_RULES.md`*
*Stratégie de tests : `docs/TEST_STRATEGY.md`*
