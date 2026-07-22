# ops/radar.ps1 - Controle Radar BC

Outil d'administration local pour Radar BC.
Ne modifie ni le code applicatif, ni .env, ni Supabase, ni les profils clients.

## Compatibilite

Concu pour Windows PowerShell 5.1 et superieur.
Le fichier radar.ps1 est volontairement ASCII-only :
aucun accent, aucun tiret long, aucun caractere Unicode dans les commentaires
ou les chaines. Cela garantit un parsing sans erreur par PowerShell 5.1
independamment des parametres regionaux ou du codepage de la console.

## Prerequis

- Windows PowerShell 5.1+
- Le script doit etre execute depuis :
  C:\PROJETS_AI\projet_claude\radar-bc-bot-clean-2
- Tache planifiee Windows RadarBC configuree et pointant vers start-bot.bat

## Commandes

### status - etat complet

    .\ops\radar.ps1 status

Affiche : depot, branche, HEAD, etat Git, tache planifiee, PID, commande process,
health /health, uptime, presence des secrets, derniers evenements log.

Secrets : affichage "set" ou "empty" uniquement. Aucune valeur n'est jamais
imprimee. Le contenu de .env n'est pas affiche ni relu en clair.

### test - tests + typecheck

    .\ops\radar.ps1 test

Lance npm test (jest) puis npm run typecheck.
Arret immediat au premier echec.

### logs - consultation des logs

    .\ops\radar.ps1 logs
    .\ops\radar.ps1 logs -Filter SCAN
    .\ops\radar.ps1 logs -Filter SEND
    .\ops\radar.ps1 logs -Filter Telegram
    .\ops\radar.ps1 logs -Filter ERROR
    .\ops\radar.ps1 logs -Filter heartbeat
    .\ops\radar.ps1 logs -Follow
    .\ops\radar.ps1 logs -Filter ERROR -Follow

### restart - redemarrage propre

    .\ops\radar.ps1 restart

Arrete la tache planifiee, libere le port 3000, redemarre, attend le health
check (max 30s). Ne tue un processus Node que si son identite est confirmee
comme etant radar-bc-bot.

### deploy - mise a jour depuis GitHub

    .\ops\radar.ps1 deploy

1. Refuse si le depot contient des modifications non validees
2. Sauvegarde le HEAD actuel dans :
   C:\PROJETS_AI\backups\RadarBC\last-good-commit.txt
3. git pull --ff-only uniquement
4. Tests + typecheck - si echec, pas de redemarrage
5. Redemarrage + health check
6. Si health KO : rollback automatique

Ne pousse jamais vers GitHub. Ne cree jamais de commit.

### rollback - retour au dernier commit valide

    .\ops\radar.ps1 rollback

Lit le commit dans last-good-commit.txt, demande confirmation (saisir "oui"),
git reset --hard, tests, redemarrage, health check.

## start-bot.bat

Script de lancement utilise par la tache planifiee RadarBC.
Il est versionne dans le depot pour qu'un clone soit autonome.

Le cd utilise %~dp0 (repertoire du script lui-meme) au lieu d'un chemin
absolu. Le depot peut donc etre deplace sans modifier ce fichier.
Le chemin Node ("C:\Program Files\nodejs\node.exe") est en dur -- a adapter
si Node est installe ailleurs.

## Securite sauvegardes .env

Les fichiers .env.*.bak produits par les scripts de rotation Telegram sont
ignores par .gitignore (regle .env.*.bak). Ils ne sont jamais commites.
