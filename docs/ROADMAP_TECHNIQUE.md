# ROADMAP_TECHNIQUE.md — Radar BC

> Priorisation de la dette technique et des prochaines actions.
> Basé sur l'état réel du projet au 2026-06-17.
> Ne pas inventer de nouvelle architecture — agir sur ce qui existe.
> Références : `docs/ARCHITECTURE_RADAR_BC.md`, `docs/DECISIONS_LOG.md`

---

## Légende des priorités

| Niveau | Signification |
|---|---|
| **P0** | Urgent — risque prod immédiat, à traiter avant tout autre ticket |
| **P1** | Important — robustesse et maintenabilité, à traiter dans les 2 semaines |
| **P2** | Amélioration — confort opérationnel, à traiter dans le mois |
| **P3** | Expérimental — ne pas démarrer tant que P0/P1 ne sont pas soldés |

---

## P0 — Urgent / sécurité prod

---

### P0-1 — Machine CDG : empêcher le redémarrage automatique au deploy

| Champ | Détail |
|---|---|
| **Problème** | `fly deploy` peut relancer la machine CDG `48e7364b99d778` selon la stratégie rolling. Un double scan = double notification client. |
| **Risque si non traité** | Clients notifiés deux fois pour le même BC. Scan concurrent non détecté si `_scanningBC` est local à chaque instance. |
| **Action recommandée** | Vérifier si Fly permet de désactiver une machine de façon permanente (`fly machine destroy` ou config `stopped_on_init`). Sinon, formaliser la procédure de stop post-deploy dans un script `post-deploy.sh`. |
| **Fichiers concernés** | `fly.toml` (éventuel), `docs/PROD_RUNBOOK.md` (procédure) |
| **Tests attendus** | Aucun test Jest — vérification manuelle : `fly machine list` après deploy |
| **Déployable ?** | Non (action Fly hors code) |
| **Terminé quand** | CDG ne redémarre plus après un `fly deploy`, ou script de stop automatique documenté et testé. |

---

### P0-2 — Index Git NTFS : clarifier et stabiliser

| Champ | Détail |
|---|---|
| **Problème** | Sur NTFS (sandbox Linux montant un volume Windows), `git status` affiche des faux positifs `D` + `??` sur des fichiers non modifiés. La cause est la corruption d'index due aux fins de ligne Windows (CRLF). `GIT_INDEX_FILE=/tmp/git-index-radar` contourne le problème mais doit être rappelé à chaque session. |
| **Risque si non traité** | Un `git add .` non intentionnel sur un index corrompu peut stager des fichiers de migration SQL, des secrets locaux, ou des fichiers binaires dans un commit prod. |
| **Action recommandée** | Documenter la cause dans `REGRESSION_RULES.md` (déjà fait). Créer un alias shell ou script `git-radar.sh` encapsulant `GIT_INDEX_FILE=/tmp/git-index-radar`. Vérifier si `.gitattributes` avec `* text=auto` stabilise le problème. |
| **Fichiers concernés** | `.gitattributes` (à créer ou vérifier), `docs/REGRESSION_RULES.md` |
| **Tests attendus** | `git status --short` ne doit plus afficher `D` + `??` sur les fichiers non modifiés |
| **Déployable ?** | Non |
| **Terminé quand** | `git status --short` propre sur NTFS sans `GIT_INDEX_FILE` manuel, ou script d'encapsulation utilisé systématiquement. |

---

### P0-3 — Confirmer que `data/` et `/tmp` ne sont pas considérés persistants

| Champ | Détail |
|---|---|
| **Problème** | Les snapshots JSONL et `ai_cache.json` sont écrits dans `/app/data/` (image Docker) ou `/tmp/` (tmpfs Fly). Les deux sont volatils au restart. Si une procédure ou un script suppose que ces fichiers survivent, elle est fausse. |
| **Risque si non traité** | Un opérateur qui compte sur `/api/snapshot/latest` après un restart obtiendra un résultat vide et diagnostiquera un faux bug. Pire : une décision de matching basée sur un snapshot censé être "récent" mais vide. |
| **Action recommandée** | Ajouter une note explicite dans `PROD_RUNBOOK.md` (section snapshots). Vérifier dans le code que `/api/snapshot/latest` gère proprement le cas "aucun snapshot présent" sans erreur 500. |
| **Fichiers concernés** | `docs/PROD_RUNBOOK.md`, `radar-bc-bot.js` (lecture snapshot — vérif défensive uniquement) |
| **Tests attendus** | `curl /api/snapshot/latest` sans snapshot présent → réponse JSON propre (pas d'erreur 500) |
| **Déployable ?** | Oui (si patch défensif radar-bc-bot.js, après tests verts) |
| **Terminé quand** | L'endpoint retourne une réponse documentée quand aucun snapshot n'est disponible. |

---

### P0-4 — Garder `known_count > 1000` comme garde-fou actif

| Champ | Détail |
|---|---|
| **Problème** | Si `sbFetchAllPages` régresse (pagination cassée, Supabase timeout), `known_count` plafonnera à 1000 et des BCs déjà vus seront retraités comme nouveaux → doublons de notifications. |
| **Risque si non traité** | Clients spammés. Confiance dans le service dégradée. |
| **Action recommandée** | Ajouter une assertion dans `runGlobalScanBC()` : si `vusIds.size === 1000` exactement → log `[WARN] known_count plafond atteint — pagination suspecte` et continuer sans marquer de nouveaux BC. Ce garde-fou est déjà documenté comme signal d'alerte mais n'est pas encore vérifié dans le code. |
| **Fichiers concernés** | `radar-bc-bot.js` (une seule ligne de garde dans `runGlobalScanBC`) |
| **Tests attendus** | `npm test -- --runInBand supabase-pagination` + `npm test -- --runInBand` → 394/394 |
| **Déployable ?** | Oui (après `node --check` + 394/394 verts) |
| **Terminé quand** | Log `[WARN]` visible dans les tests quand `vusIds.size === 1000`. |

---

## P1 — Important / robustesse

---

### P1-1 — Snapshots persistants ou téléchargeables

| Champ | Détail |
|---|---|
| **Problème** | Les snapshots JSONL (`scan-snapshots/`, `input-snapshots/`) sont perdus à chaque restart Fly. L'audit offline des décisions de matching est impossible après un incident. |
| **Risque si non traité** | Impossible de rejouer un scan post-incident. Débogage aveugle sur les scans passés. |
| **Action recommandée** | Option A : créer un volume Fly monté sur `/data` (`fly volumes create`). Option B : exporter les snapshots vers Supabase Storage ou une table dédiée. Option A est plus simple mais ajoute un coût Fly. |
| **Fichiers concernés** | `fly.toml` (volume), `radar-bc-bot.js` (chemin snapshot déjà configurable via `RADAR_BC_SNAPSHOT_DIR`) |
| **Tests attendus** | Vérification manuelle post-restart : snapshots toujours présents |
| **Déployable ?** | Oui (volume Fly sans changement de code si `RADAR_BC_SNAPSHOT_DIR` pointe vers le volume) |
| **Terminé quand** | `fly machine restart` ne vide plus les snapshots du scan précédent. |

---

### P1-2 — Ajouter `build:core` au Dockerfile (prérequis shadow)

| Champ | Détail |
|---|---|
| **Problème** | `dist/` est absent du Dockerfile. Si `SHADOW_MODE_ENABLED=true` est activé, le `require('./dist/core/shadow/runner')` échoue silencieusement. Le shadow runner TS est inactif même avec le flag. |
| **Risque si non traité** | Impossible d'activer le shadow en prod de façon fiable. Les tests Jest passent (TypeScript compilé localement) mais le comportement prod diffère. |
| **Action recommandée** | Ajouter `RUN npm run build:core` dans le Dockerfile avant `CMD`. Vérifier que la taille de l'image reste acceptable. Conditionner l'activation du shadow à un ticket dédié P3-1. |
| **Fichiers concernés** | `Dockerfile` |
| **Tests attendus** | Image buildée avec `dist/` présent → `node -e "require('./dist/core/shadow/runner')"` sans erreur |
| **Déployable ?** | Oui (changement Dockerfile seul, après build test) |
| **Terminé quand** | `fly deploy` produit une image avec `dist/` compilé. `/health` toujours OK. |

---

### P1-3 — Clarifier les flags shadow/clean utilisables ou non en prod

| Champ | Détail |
|---|---|
| **Problème** | Il existe deux mécanismes shadow distincts dans le bot : (1) `RADAR_BC_MATCH_SHADOW=1` (shadow local JS dans `data/shadow/`) et (2) `SHADOW_MODE_ENABLED=true` (shadow runner TS dans `core/`). Les deux sont désactivés en prod mais leur documentation est dispersée. |
| **Risque si non traité** | Un opérateur peut activer le mauvais flag, croire que le shadow fonctionne alors que `dist/` est absent, et déboguer un faux problème. |
| **Action recommandée** | Créer une section dédiée dans `ARCHITECTURE_RADAR_BC.md` listant les deux mécanismes, leurs flags, leurs prérequis, et leur statut prod. Ajouter un commentaire dans `radar-bc-bot.js` au niveau des deux constantes. |
| **Fichiers concernés** | `docs/ARCHITECTURE_RADAR_BC.md` |
| **Tests attendus** | Aucun test Jest |
| **Déployable ?** | Non (documentation seule) |
| **Terminé quand** | Les deux mécanismes shadow sont documentés dans le même endroit avec leurs différences. |

---

### P1-4 — Contrôle automatique post-deploy

| Champ | Détail |
|---|---|
| **Problème** | La procédure post-deploy (§4 du PROD_RUNBOOK) est manuelle et dépend d'un opérateur attentif. Si CDG redémarre la nuit après un deploy automatique, personne ne le voit avant le lendemain. |
| **Risque si non traité** | Double scan silencieux pendant des heures. |
| **Action recommandée** | Créer un script `scripts/post-deploy-check.sh` qui : (1) liste les machines, (2) stop CDG si started, (3) teste `/health`, (4) affiche le résultat. À lancer manuellement après `fly deploy` ou intégrer dans le CI. |
| **Fichiers concernés** | `scripts/post-deploy-check.sh` (nouveau) |
| **Tests attendus** | Exécution manuelle sur la machine de dev |
| **Déployable ?** | Non (script local) |
| **Terminé quand** | `bash scripts/post-deploy-check.sh` détecte CDG started et la stoppe automatiquement. |

---

## P2 — Amélioration / confort

---

### P2-1 — Commande locale unique de diagnostic prod

| Champ | Détail |
|---|---|
| **Problème** | Le diagnostic prod nécessite 5–6 commandes `fly` + `curl` à enchaîner manuellement depuis le PROD_RUNBOOK. |
| **Risque si non traité** | Oubli d'une étape (ex : vérifier CDG) lors d'un diagnostic rapide sous pression. |
| **Action recommandée** | Créer `scripts/diag-prod.sh` : machines + health + status + 20 dernières lignes de logs filtrées. |
| **Fichiers concernés** | `scripts/diag-prod.sh` (nouveau) |
| **Tests attendus** | Exécution manuelle |
| **Déployable ?** | Non |
| **Terminé quand** | Une seule commande donne une vue complète de l'état prod en < 10 secondes. |

---

### P2-2 — Commande locale de diagnostic Git propre

| Champ | Détail |
|---|---|
| **Problème** | `GIT_INDEX_FILE=/tmp/git-index-radar git status --short` doit être retapé à chaque session. |
| **Risque si non traité** | Oubli du préfixe → faux positifs → staging accidentel. |
| **Action recommandée** | Créer un alias bash ou `scripts/git-status.sh` encapsulant `GIT_INDEX_FILE=/tmp/git-index-radar git "$@"`. Documenter dans `REGRESSION_RULES.md`. |
| **Fichiers concernés** | `scripts/git-radar.sh` (nouveau), `docs/REGRESSION_RULES.md` |
| **Tests attendus** | `bash scripts/git-radar.sh status --short` → sortie propre sans D+?? |
| **Déployable ?** | Non |
| **Terminé quand** | Alias ou script utilisé systématiquement en session. |

---

### P2-3 — Rapport scan plus lisible

| Champ | Détail |
|---|---|
| **Problème** | Les logs de scan sont verbeux et mélangent BROWSER, FICHES, KNOWN_DIAG, matchCritere dans un flux continu. Difficile à lire en cas d'incident. |
| **Risque si non traité** | Temps de diagnostic allongé sous pression. |
| **Action recommandée** | Ajouter une ligne de résumé structuré en fin de scan : `[SCAN_SUMMARY] runId=... duration=Xs known=N new=M loaded=L notified=K errors=0`. Ce résumé est déjà partiellement dans "Scan BC terminé" mais sans tous les champs. |
| **Fichiers concernés** | `radar-bc-bot.js` (fin de `runGlobalScanBC`) |
| **Tests attendus** | `node --check radar-bc-bot.js` + `npm test -- --runInBand` → 394/394 |
| **Déployable ?** | Oui |
| **Terminé quand** | `fly logs | grep SCAN_SUMMARY` donne une vue complète d'un scan en une ligne. |

---

### P2-4 — Documenter les variables d'environnement dans `.env.example`

| Champ | Détail |
|---|---|
| **Problème** | `.env.example` liste les variables principales mais pas les flags de comportement (`BC_LISTING_EARLY_STOP_PAGES`, `MAX_NEW_BC_DETAILS_PER_SCAN`, `SHADOW_MODE_ENABLED`, etc.). |
| **Risque si non traité** | Un nouvel opérateur ne connaît pas les leviers disponibles et les cherche dans le code. |
| **Action recommandée** | Compléter `.env.example` avec toutes les variables listées dans `ARCHITECTURE_RADAR_BC.md §5`, avec valeurs par défaut et commentaires. |
| **Fichiers concernés** | `.env.example` |
| **Tests attendus** | Aucun |
| **Déployable ?** | Non |
| **Terminé quand** | `.env.example` est la référence complète de toutes les variables. |

---

### P2-5 — Réduire le bruit des logs debug en prod stable

| Champ | Détail |
|---|---|
| **Problème** | Des logs `[KNOWN_DIAG]`, `[CTX]`, `[SCHED] heartbeat` s'affichent toutes les minutes et noient les événements importants. |
| **Risque si non traité** | Signal d'alerte réel noyé dans le bruit lors d'un incident. |
| **Action recommandée** | Conditionner les logs de heartbeat à une variable `RADAR_BC_VERBOSE_LOGS=1` (off par défaut). Garder les logs d'alerte inconditionnels. |
| **Fichiers concernés** | `radar-bc-bot.js` (quelques `if (VERBOSE)` autour des logs heartbeat) |
| **Tests attendus** | `node --check radar-bc-bot.js` + `npm test -- --runInBand` → 394/394 |
| **Déployable ?** | Oui |
| **Terminé quand** | `fly logs` en prod stable n'affiche que les événements significatifs sans `[SCHED] heartbeat` toutes les 60 s. |

---

## P3 — Plus tard / expérimental

> ⚠️ Ne pas démarrer un ticket P3 tant qu'un P0 est ouvert.
> Ces fonctionnalités nécessitent des tickets dédiés, une validation staging, et des tests spécifiques.

---

### P3-1 — Activer le shadow runner TS en prod (core/shadow)

| Champ | Détail |
|---|---|
| **Problème** | Le shadow runner `core/shadow/runner.ts` est prêt côté code mais `dist/` est absent du Dockerfile. Jamais validé en prod. |
| **Prérequis** | P1-2 (build:core dans Dockerfile) soldé. Staging dédié avec `SHADOW_MODE_ENABLED=true` sur une app Fly séparée. |
| **Action recommandée** | Créer une app Fly `radar-bc-bot-staging`, activer shadow, observer les `shadow_run_log` et `shadow_opportunity` pendant 2 semaines. |
| **Déployable ?** | Non (staging uniquement en première phase) |

---

### P3-2 — Clean matching (core/scoring/engine.ts en prod)

| Champ | Détail |
|---|---|
| **Problème** | Le moteur de scoring explicable `core/scoring/engine.ts` (394/394 tests verts) n'est pas branché en prod. Il remplace le matching legacy `hasKw + fuzzy`. |
| **Prérequis** | P3-1 validé en staging. Shadow comparison legacy vs clean pendant N scans. Décision explicite de bascule. |
| **Action recommandée** | Activer via `SHADOW_MODE_ENABLED=true` + analyse des divergences dans `shadow_run_log`. Bascule prod uniquement si divergence < 5% et 0 faux négatif. |
| **Déployable ?** | Non (expérimental) |

---

### P3-3 — Enrichissement IA activé en prod (`LEGACY_USE_AI_INCLUSIONS=1`)

| Champ | Détail |
|---|---|
| **Problème** | Les `ai_inclusions` sont stockées en BDD mais non utilisées dans le matching (flag off). |
| **Prérequis** | Audit complet des `ai_inclusions` en Supabase. Vérification qu'aucun terme générique (ex : `"eau"`, `"papier"`) n'est dans les inclusions. Golden dataset validé. |
| **Action recommandée** | Audit SQL des inclusions + test sur les BCs du golden dataset avant activation. |
| **Déployable ?** | Oui (flag uniquement) — mais pas avant audit |

---

### P3-4 — WhatsApp officiel / API fiable

| Champ | Détail |
|---|---|
| **Problème** | `sendWhatsApp` utilise CallMeBot (API tierce non officielle). Rate limits imprévisibles, aucune garantie de livraison. |
| **Action recommandée** | Évaluer WhatsApp Business API (Meta) ou Twilio WhatsApp. Ticket dédié avec analyse coût/valeur. |
| **Déployable ?** | Non (évaluation préalable requise) |

---

### P3-5 — Interface admin avancée

| Champ | Détail |
|---|---|
| **Problème** | `web/admin.html` fournit les fonctions de base mais sans historique scan, vue graphique des BCs manqués, ou gestion des enrichissements IA. |
| **Action recommandée** | Définir les besoins opérationnels réels avant de coder. Ne pas construire une interface sans cas d'usage validé. |
| **Déployable ?** | Non (conception préalable) |

---

## 6. Ordre recommandé des 5 prochains tickets

Séquence réaliste sans code risqué en début de roadmap :

| # | Ticket | Type | Risque | Prérequis |
|---|---|---|---|---|
| 1 | **P0-2** — Script `git-radar.sh` + `.gitattributes` | Docs + script shell | Nul | Aucun |
| 2 | **P0-3** — Vérifier `/api/snapshot/latest` sur snapshot vide | Fix défensif JS | Faible | `node --check` + 394/394 |
| 3 | **P1-4** — Script `scripts/post-deploy-check.sh` | Script shell | Nul | Aucun |
| 4 | **P0-4** — Garde-fou `known_count === 1000` dans le bot | Fix JS minimal | Faible | `node --check` + 394/394 |
| 5 | **P2-3** — Ligne `[SCAN_SUMMARY]` en fin de scan | Amélioration JS | Faible | `node --check` + 394/394 |

> Les tickets P1-2 (Dockerfile) et P3-x (shadow/clean) sont volontairement hors
> de cette séquence initiale — ils nécessitent une validation staging dédiée.

---

*Architecture : `docs/ARCHITECTURE_RADAR_BC.md`*
*Décisions actées : `docs/DECISIONS_LOG.md`*
*Règles anti-régression : `docs/REGRESSION_RULES.md`*
*Runbook prod : `docs/PROD_RUNBOOK.md`*
