# Rapport Learning Client

**Client :** `15a96b88-0c98-4de9-9f66-739e3a28dafa`  
**Genere le :** 2026-07-07T00:23:06.629Z
**Decisions dedupl.:** 146 / 221 (last-wins client::bc_id)

## Hint actif

Hint present dans `client-learning-hints.json` : **1 signal(s)** configure(s).

## Signaux et decisions

| Signal | K | R | I | Total | Cycles | Sources | Effet | Adj |
|--------|---|---|---|-------|--------|---------|-------|-----|
| nettoyage | 8 | 15 | 0 | 23 | 3 | client | demote_to_review | -3 |

_K=keep R=reject I=ignore_

## Recommandations

**nettoyage** : Signal penalise — maintenir en revue manuelle, ne pas notifier automatiquement, continuer a collecter des feedbacks.

## Prochaine action

- Verifier manuellement les appels d'offres passes en revue pour ce client.
- Ne pas activer la notification automatique sur les signaux penalises.
- Relancer un cycle feedback apres nouvelles decisions pour consolider le learning.
