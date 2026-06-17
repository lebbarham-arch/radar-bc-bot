# DECISIONS_LOG.md — Radar BC

> Journal des décisions techniques et opérationnelles actées.
> Toute décision listée ici est définitive jusqu'à révision explicite par ticket.
> Références : `docs/ARCHITECTURE_RADAR_BC.md`, `docs/PROD_RUNBOOK.md`, `docs/REGRESSION_RULES.md`

---

## 1. Décisions production

| Date | Décision | Statut | Raison | Référence |
|---|---|---|---|---|
| 2026-06-17 | `radar-bc-bot.js` reste le seul moteur de production | ✅ Actée | Fichier legacy éprouvé, aucun bug critique depuis v9.6. Toute modification de comportement prod passe par ce fichier uniquement. | `ARCHITECTURE_RADAR_BC.md §1.1` |
| 2026-06-17 | `core/` reste expérimental — shadow/review uniquement | ✅ Actée | `dist/` absent du Dockerfile actuel. Le shadow runner TS n'a pas été validé en prod. Branchement prod interdit sans ticket dédié. | `ARCHITECTURE_RADAR_BC.md §1.3` |
| 2026-06-17 | `SHADOW_MODE_ENABLED` reste `false` en prod | ✅ Actée | `require('./dist/core/shadow/runner')` échouerait silencieusement (dist/ absent). Aucune validation staging effectuée. | `REGRESSION_RULES.md §4` |
| 2026-06-17 | `RADAR_BC_MATCH_SHADOW` reste `0` en prod | ✅ Actée | Écrit dans `data/shadow/` sur `/tmp` Fly (éphémère, aucune valeur opérationnelle). | `ARCHITECTURE_RADAR_BC.md §5.4` |
| 2026-06-17 | Une seule machine active : FRA `d8d054dc2e6648` | ✅ Actée | Deux machines actives = double scan + double notification client. Une seule région suffit pour la charge actuelle. | `PROD_RUNBOOK.md §1` |
| 2026-06-17 | Machine CDG `48e7364b99d778` doit rester stopped | ✅ Actée | Région redondante non nécessaire. Risque de redémarrage automatique à chaque `fly deploy` → à vérifier après chaque deploy. | `PROD_RUNBOOK.md §2.1` |

---

## 2. Décisions scan BC

| Date | Décision | Statut | Raison | Référence |
|---|---|---|---|---|
| 2026-06-17 | Pagination Supabase `bcs_vus` obligatoire via `sbFetchAllPages` | ✅ Actée | PostgREST plafonne à 1 000 lignes par défaut. Sans pagination, les BCs vus au-delà de 1 000 seraient ignorés → faux nouveaux BCs et notifications en double. | `ARCHITECTURE_RADAR_BC.md §3.1` |
| 2026-06-17 | `known_count=1000` exact dans les logs = signal d'arrêt immédiat | ✅ Actée | Indique que la pagination est plafonnée et que des BCs connus sont traités comme nouveaux. Ticket correctif prioritaire requis. | `REGRESSION_RULES.md §6` |
| 2026-06-17 | `MAX_NEW_BC_DETAILS_PER_SCAN` maintenu à 250 (défaut) | ✅ Actée | Au-delà, risque OOM sur 1 GB RAM Fly (Puppeteer + N fiches en parallèle). Modifier uniquement avec décision explicite et mesure mémoire préalable. | `ARCHITECTURE_RADAR_BC.md §5.3` |
| 2026-06-17 | `BC_DETAIL_CONCURRENT` maintenu à 3 (défaut) | ✅ Actée | Fly 1 GB RAM. Chaque instance Puppeteer parallèle consomme ~200–300 MB. Dépasser 4 = risque OOM. Modifier uniquement après test de charge. | `ARCHITECTURE_RADAR_BC.md §5.3` |
| 2026-06-17 | Early stop listing (`BC_LISTING_EARLY_STOP_PAGES`) non activé | ⏸ En attente | La prod n'a pas été observée assez longtemps pour calibrer le bon seuil de pages consécutives déjà connues. Activer prématurément = BC manqués. | `ARCHITECTURE_RADAR_BC.md §5.3` |
| 2026-06-17 | `LEGACY_USE_AI_INCLUSIONS` maintenu à `0` (off) | ✅ Actée | Mode conservateur. Les `ai_inclusions` en BDD n'ont pas été auditées. Activer uniquement après vérification complète des données Supabase. | `REGRESSION_RULES.md §4` |
| 2026-06-17 | Radar MP (`FEATURES.enableMP`) reste désactivé | ✅ Actée | `mps_vus` utilise `limit=20000` hardcodé (non paginé). Risque de dépassement si MP activé en prod. Ticket dédié requis avant activation. | `ARCHITECTURE_RADAR_BC.md §8.1` |

---

## 3. Décisions notifications

| Date | Décision | Statut | Raison | Référence |
|---|---|---|---|---|
| 2026-06-17 | `TELEGRAM_BOT_TOKEN` est un secret obligatoire | ✅ Actée | Sans token valide, 0 notifications envoyées. Le bot démarre mais les clients ne reçoivent rien. Signal `tg_token=empty` dans les logs au démarrage. | `PROD_RUNBOOK.md §2.4` |
| 2026-06-17 | `tg_token=empty` / `no_token` = signal d'arrêt immédiat | ✅ Actée | Indique absence ou invalidité du token Telegram. Action : `fly secrets set TELEGRAM_BOT_TOKEN=...` avant le prochain scan. | `REGRESSION_RULES.md §6` |
| 2026-06-17 | `no_delivery_retry > 0` doit être diagnostiqué avant le scan suivant | ✅ Actée | Indique que des notifications ont échoué et ont été retentées. Peut signaler un token révoqué, un bot Telegram bloqué ou un réseau Fly dégradé. | `PROD_RUNBOOK.md §3.2` |
| 2026-06-17 | `markSent()` conditionnel à une livraison réelle | ✅ Actée | Un BC n'est marqué envoyé (`bcs_envoyes`) que si au moins une notification (Telegram/WhatsApp/Email) a réussi. Évite les faux positifs de déduplication. | `radar-bc-bot.js` patch livraison conditionnelle |
| 2026-06-17 | CallMeBot WhatsApp ne doit pas être utilisé comme canal fiable | ✅ Actée | API tierce non officielle, rate limits imprévisibles, pas de garantie de livraison. Telegram reste le canal principal. WhatsApp = bonus non critique. | — |

---

## 4. Décisions documentation et process

| Date | Décision | Statut | Raison | Référence |
|---|---|---|---|---|
| 2026-06-17 | Chaque changement doit être traité par ticket fermé et documenté | ✅ Actée | Les sessions de correction sans ticket ont causé des régressions en cascade (matchers.ts tronqué, test thresholds obsolètes, final_decision vs decision). | `REGRESSION_RULES.md §7` |
| 2026-06-17 | Format ticket obligatoire : Objectif + Fichiers autorisés + Fichiers interdits + Tests + Vérification + Livrable | ✅ Actée | Un ticket sans liste de fichiers autorisés/interdits expose au risque de modification accidentelle du JS prod ou de fly.toml. | `REGRESSION_RULES.md §7` |
| 2026-06-17 | Aucun push code sans tests verts (394/394) | ✅ Actée | Règle absolue. Un push avec tests rouges = risque de régression cachée en prod au prochain deploy. | `REGRESSION_RULES.md §2` |
| 2026-06-17 | Les commits de documentation ne nécessitent pas de deploy | ✅ Actée | `docs/*.md` sont dans le repo mais ne sont pas exécutés par le bot. Modifier uniquement `docs/DECISIONS_LOG.md` ne justifie pas un `fly deploy`. | — |
| 2026-06-17 | `git add .` interdit — staging explicite fichier par fichier | ✅ Actée | Sur NTFS, `git add .` peut stager des fichiers modifiés par Windows (fins de ligne, timestamps) ou des fichiers de migration SQL non désirés. | `REGRESSION_RULES.md §1` |
| 2026-06-17 | `GIT_INDEX_FILE=/tmp/git-index-radar` utilisé sur NTFS | ✅ Actée | Contourne la corruption d'index git sur le montage NTFS dans le sandbox Linux. Résout les faux positifs D+?? dans `git status`. | `REGRESSION_RULES.md §1` |

---

## 5. Dernier état stable connu

| Champ | Valeur |
|---|---|
| Date validation | 2026-06-17 00:00 UTC |
| Image Fly | `deployment-01KV9DHG84FXV91HXGP326K8R3` |
| Machine FRA | `d8d054dc2e6648` — started |
| Machine CDG | `48e7364b99d778` — stopped |
| `known_count` | `11203` |
| `pages_loaded` bcs_vus | `12` (pagination correcte, < 20 000) |
| `new` BC détectés | `138` |
| Notifications | Telegram OK |
| `no_delivery_retry` | `0` |
| Tests Jest | `394/394` verts |
| `node --check radar-bc-bot.js` | OK |
| Commit HEAD docs | `137e76c` (DOC-002 REGRESSION_RULES) |

---

*Architecture : `docs/ARCHITECTURE_RADAR_BC.md`*
*Runbook prod : `docs/PROD_RUNBOOK.md`*
*Règles anti-régression : `docs/REGRESSION_RULES.md`*
