# Radar BC - Etat production verrouille

Date de validation : 2026-06-17

## Etat production valide

- Fly : une seule machine FRA active
- Machine FRA : d8d054dc2e6648
- Machine CDG : detruite / absente
- Health : ok
- Telegram : actif et message de test recu
- WhatsApp : non configure
- Email : non configure

## Mode applicatif

- Production : radar-bc-bot.js legacy
- Cron/startup : actif
- Server-only : desactive

## Flags production attendus

SHADOW_MODE_ENABLED=0
SHADOW_MODE_EMERGENCY_KILL=true
SHADOW_LLM_ENABLED=0
SHADOW_RERANK_ENABLED=0
RADAR_BC_MATCH_SHADOW=false
RADAR_BC_EXPORT_REVIEW_CANDIDATES=false
RADAR_BC_SERVER_ONLY=false
RADAR_BC_WRITE_INPUT_SNAPSHOT=1

## Interpretation code confirmee

- SHADOW_MODE_ENABLED actif seulement si valeur exactement true
- SHADOW_MODE_EMERGENCY_KILL actif seulement si valeur exactement true
- RADAR_BC_MATCH_SHADOW actif seulement si valeur exactement 1
- RADAR_BC_EXPORT_REVIEW_CANDIDATES actif seulement si valeur exactement 1
- RADAR_BC_SERVER_ONLY actif seulement si valeur exactement 1

## Resume

PROD = legacy radar-bc-bot.js
SCAN = cron horaire + startup scan + scan manuel
NOTIF = Telegram actif
SHADOW = desactive en prod
CLEAN MATCHING = desactive en prod
REVIEW EXPORT = desactive en prod
DIAG = snapshots input actifs
INFRA = Fly mono-machine FRA
