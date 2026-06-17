# REGRESSION_RULES.md — Radar BC

> Règles absolues anti-régression.
> À lire avant toute modification du projet.
> Références : `docs/ARCHITECTURE_RADAR_BC.md`, `docs/PROD_RUNBOOK.md`

---

## 1. Règles Git

```
❌ Ne jamais utiliser git add .
   Chaque fichier stagé doit être choisi explicitement.
   Risque : committer des fichiers de config, secrets, ou migrations non voulues.

✅ Toujours vérifier git status --short avant de stager
   Confirmer que seuls les fichiers attendus apparaissent comme modifiés.

✅ Toujours vérifier git diff (non stagé) puis git diff --cached (stagé)
   Confirmer le contenu exact de chaque changement avant commit.

❌ Ne jamais committer si git status --short affiche D + ?? incohérents
   D = supprimé dans l'index, ?? = non traqué avec le même nom → indice
   de corruption d'index NTFS. Corriger avec :
     GIT_INDEX_FILE=/tmp/git-index-radar git <commande>
   avant tout commit.

✅ Toujours utiliser GIT_INDEX_FILE=/tmp/git-index-radar sur NTFS
   Évite les faux positifs de modification dus aux fins de ligne Windows.

✅ Sur Windows, utiliser scripts\diagnose-git.ps1 pour détecter D + ?? et MM
   powershell -ExecutionPolicy Bypass -File scripts\diagnose-git.ps1
   Le script propose git restore --staged <fichier> sans jamais l'exécuter.
```

---

## 2. Règles tests

```
❌ Aucun push code sans tests verts
   npm test -- --runInBand doit afficher 394/394 avant tout commit
   touchant à la logique (core/, tests/).

✅ Tests ciblés obligatoires si radar-bc-bot.js est modifié
   - Si modification du scheduler : npm test -- --runInBand cron-sched
   - Si modification scan/pagination  : npm test -- --runInBand supabase-pagination
   - Si modification snapshot         : npm test -- --runInBand snapshot-dir
   - Si modification scoring engine   : npm test -- --runInBand scoring.engine
   - Si modification pipeline/parser  : npm test -- --runInBand pipeline

✅ node --check radar-bc-bot.js obligatoire si JS prod modifié
   Vérifie la syntaxe sans exécuter le bot.
   Doit retourner exit 0 (aucune sortie = OK).

❌ Ne jamais affaiblir un test pour le faire passer
   Ajuster les seuils de test uniquement si le comportement du moteur
   est justifié et documenté (comme en commit ccb6184).

❌ Ne jamais lancer npm audit fix
   Peut casser les versions épinglées de Puppeteer.
```

---

## 3. Règles prod Fly

```
❌ Pas de deploy sans validation locale complète
   Séquence obligatoire avant fly deploy :
     1. node --check radar-bc-bot.js
     2. npm test -- --runInBand   (394/394)
     3. git diff --cached         (confirmer le contenu)

✅ Après chaque deploy, vérifier les machines immédiatement
     fly machine list --app radar-bc-bot

✅ La machine CDG (48e7364b99d778) doit rester stopped
   Si started après un deploy → stopper sans délai :
     fly machine stop 48e7364b99d778 --app radar-bc-bot
   Une machine CDG active = double scan + double notification.

✅ Vérifier /health après chaque deploy
     curl -s https://radar-bc-bot.fly.dev/health
   Résultat attendu : {"status":"ok", ...}

✅ Surveiller le premier scan après deploy
     fly logs --app radar-bc-bot | grep -E "SCAN BC|known_count|Telegram|terminé"
   Attendre la séquence normale complète (section 3 du PROD_RUNBOOK).
```

---

## 4. Règles secrets et variables d'environnement

```
❌ Ne jamais modifier fly secrets pendant qu'un scan est en cours
   Attendre "Scan BC terminé" dans les logs.
   Un restart provoqué par un secret change = perte du scan en cours.

❌ Ne jamais activer SHADOW_MODE_ENABLED=true en prod
   dist/ est absent du Dockerfile actuel.
   Le require('./dist/core/shadow/runner') échoue silencieusement.
   Aucune validation staging du shadow runner TS n'a été faite.

❌ Ne jamais activer RADAR_BC_MATCH_SHADOW=1 en prod
   Écrit dans data/shadow/ sur /tmp (éphémère Fly, aucune valeur opérationnelle).

⚠️  Ne pas changer MAX_NEW_BC_DETAILS_PER_SCAN sans décision explicite
   Valeur actuelle : 250 (défaut). Augmenter = risque OOM sur 1 GB RAM.
   Diminuer = BC potentiellement manqués sur les scans chargés.

⚠️  Ne pas changer BC_DETAIL_CONCURRENT sans test de charge
   Valeur actuelle : 3 (défaut, max 6). Dépasser 4 = risque OOM Puppeteer.

❌ Ne jamais activer LEGACY_USE_AI_INCLUSIONS=1 sans audit BDD
   Les ai_inclusions doivent être propres et validées avant activation.
```

---

## 5. Règles architecture

```
✅ radar-bc-bot.js est le seul moteur de production
   Toute modification de comportement prod passe par ce fichier.
   core/ n'est pas exécuté en prod (sauf hooks shadow désactivés par défaut).

✅ core/ est expérimental — pas de branchement prod sans ticket validé
   Le code TypeScript dans core/ est compilé vers dist/ uniquement
   si npm run build:core est lancé manuellement.
   dist/ n'est pas dans le Dockerfile actuel.

❌ Ne pas mélanger refactor core/ et correctif prod dans le même ticket
   Un ticket doit cibler soit :
     - un correctif radar-bc-bot.js (prod) — tests JS, node --check
     - un développement core/ (expérimental) — tests Jest TypeScript
   Mélanger les deux rend le diff illisible et le rollback difficile.

❌ Ne pas modifier le scheduler (cron.schedule / setInterval) sans tests
   Le scheduler est la colonne vertébrale des scans horaires.
   Toute modification doit être couverte par tests/unit/cron-sched.test.ts.

✅ Le matching legacy (matchCritere, hasKw, hasKwFuzzy) ne doit pas être
   modifié pendant un patch snapshot ou scoring
   Isoler les domaines : matching d'un côté, scoring/snapshot de l'autre.
```

---

## 6. Signaux d'arrêt immédiat

Si l'un de ces signaux apparaît dans les logs, **arrêter l'analyse en cours
et traiter en priorité** avant tout autre travail.

| Signal | Signification | Action immédiate |
|---|---|---|
| `known_count=1000` exact | Pagination bcs_vus plafonnée — BCs manqués | Créer ticket prioritaire |
| `tg_token=empty` / `no_token` | Token Telegram absent | `fly secrets set TELEGRAM_BOT_TOKEN=...` |
| `result is not defined` | Erreur JS runtime matching | Lire stack trace complète — ticket correctif |
| `Cannot find module './dist/core/shadow/runner'` | Shadow activé sans dist/ | Vérifier secrets — désactiver `SHADOW_MODE_ENABLED` |
| `no_delivery_retry > 0` | Notifications Telegram échouées | Vérifier token + logs `sendTelegram` |
| Machine CDG `48e7364b99d778` = **started** | Double scan actif | `fly machine stop 48e7364b99d778 --app radar-bc-bot` |
| `Scan BC precedent en cours, skip` répété | Scan bloqué | Redémarrer machine FRA |
| `Supabase: ...` puis arrêt scan | Supabase KO | Vérifier secrets + dashboard Supabase |

---

## 7. Format obligatoire des futurs tickets Claude

Tout ticket soumis à Claude pour modifier ce projet doit inclure les sections
suivantes. Un ticket sans ces sections sera refusé ou produira un résultat
imprévisible.

```markdown
## TICKET <ID> — <Titre court>

### Objectif
<Ce que le ticket doit accomplir — en 1-3 phrases précises.>

### Fichiers autorisés
<Liste explicite des fichiers que Claude peut créer ou modifier.>
Exemple :
- core/scoring/engine.ts
- tests/unit/scoring.engine.test.ts

### Fichiers interdits
<Liste explicite des fichiers que Claude ne doit PAS toucher.>
Exemple :
- radar-bc-bot.js
- fly.toml
- package.json
- Tout fichier non listé dans "Fichiers autorisés"

### Tests attendus
<Quels tests doivent passer après la modification.>
Exemple :
- npm test -- --runInBand scoring.engine → X/X verts
- npm test -- --runInBand → 394/394 verts

### Commandes de vérification
<Commandes à lancer pour confirmer que le livrable est correct.>
Exemple :
- node --check radar-bc-bot.js
- npx tsc --project tsconfig.core.json --noEmit
- git diff --cached

### Livrable final
<Ce que Claude doit produire à la fin.>
Exemple :
- Fichier modifié : core/scoring/engine.ts
- Afficher : git diff HEAD -- core/scoring/engine.ts
- Commit avec message : fix(scoring): ...
```

---

*Runbook prod : `docs/PROD_RUNBOOK.md`*
*Architecture : `docs/ARCHITECTURE_RADAR_BC.md`*
