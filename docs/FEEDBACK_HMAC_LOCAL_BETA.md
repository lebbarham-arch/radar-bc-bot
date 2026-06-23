# FEEDBACK_HMAC_LOCAL_BETA.md

Procédure d'activation HMAC des liens feedback en bêta locale.
Référence : GD-085 (implémentation), GD-086 (validation locale), commit `94e40ae`.

> **Périmètre strict** : bêta locale uniquement.
> Ne pas activer en prod. Ne pas modifier Fly, Supabase, secrets prod, cron, scoring, guards, seuils, poids, hints, matching.

---

## 1. État actuel

La signature HMAC est **disponible mais désactivée par défaut**.

- Si aucun flag n'est défini → comportement historique inchangé, aucun `sig=`, aucun `exp=` dans les liens.
- `FEEDBACK_REQUIRE_SIGNATURE` absent/false → liens non signés acceptés par `/feedback` (rétrocompatibilité totale).
- `FEEDBACK_SIGNING_SECRET` absent → impossible de générer ou vérifier une signature (garde interne).
- Prod actuelle : aucun flag défini → aucune rupture.

Modules concernés :

- `scripts/feedback-signature.js` — module pur (crypto Node, pas d'I/O, testable sans bot)
- `scripts/feedback-links-builder.js` — injecte la signature via le 9e paramètre `signatureOpts`
- `radar-bc-bot.js` — lit les flags CFG et appelle les modules ci-dessus

---

## 2. Variables d'environnement

### `FEEDBACK_SIGNED_LINKS_ENABLED`

Contrôle la **génération** de liens signés.

| Valeur | Effet |
|--------|-------|
| absente / `"false"` | Pas de `sig=`, pas de `exp=` dans les URLs générées (défaut sûr) |
| `"true"` | Ajoute `&exp=<unix_ts>&sig=<hmac-sha256-hex>` à chaque URL feedback |

Seule la valeur exacte `"true"` active la génération. Toute autre valeur (`"1"`, `"TRUE"`, `""`) → désactivé.

### `FEEDBACK_REQUIRE_SIGNATURE`

Contrôle la **vérification** côté serveur dans la route `/feedback`.

| Valeur | Effet |
|--------|-------|
| absente / `"false"` | Liens non signés acceptés (rétrocompatibilité anciens liens) |
| `"true"` | Rejette les liens sans `sig=`, avec `sig=` invalide, ou expirés |

À n'activer qu'après une phase de transition où tous les liens en circulation sont signés.

### `FEEDBACK_SIGNING_SECRET`

Secret HMAC utilisé pour signer et vérifier les liens.

- Absent → la garde interne dans `radar-bc-bot.js` coupe la signature même si `FEEDBACK_SIGNED_LINKS_ENABLED=true`.
- En bêta locale : utiliser une valeur fictive (ex : `"test-secret-local-only"`).
- **Ne jamais committer**. Ne jamais mettre dans `.env` versionné.

### `FEEDBACK_LINK_TTL_SECONDS`

Durée de validité d'un lien signé, en secondes.

| Valeur | Effet |
|--------|-------|
| absente / `"0"` / invalide | Défaut : `604800` secondes (7 jours) |
| `"3600"` | 1 heure (utile pour tester l'expiration en bêta locale) |

---

## 3. Modes recommandés

### Mode A — Défaut sûr (prod actuelle)

Aucun flag défini. Comportement historique garanti. Recommandé en prod.

```
# Aucune variable à définir
# Comportement : 3 ou 8 liens sans sig= ni exp=
# Anciens liens feedback acceptés sans condition
```

### Mode B — Génération signée, vérification souple (bêta locale recommandée)

Les nouveaux liens générés contiennent `sig=` et `exp=`, mais les anciens liens sans signature restent acceptés. Permet une migration progressive sans rupture.

```powershell
$env:FEEDBACK_SIGNED_LINKS_ENABLED = "true"
$env:FEEDBACK_SIGNING_SECRET       = "test-secret-local-only"
# FEEDBACK_REQUIRE_SIGNATURE non défini (= false)
# FEEDBACK_LINK_TTL_SECONDS non défini (= 604800 = 7 jours)
```

### Mode C — Vérification stricte (test local uniquement)

Rejette tout lien non signé, invalide ou expiré. À tester localement avant toute activation prod.

```powershell
$env:FEEDBACK_SIGNED_LINKS_ENABLED  = "true"
$env:FEEDBACK_REQUIRE_SIGNATURE     = "true"
$env:FEEDBACK_SIGNING_SECRET        = "test-secret-local-only"
$env:FEEDBACK_LINK_TTL_SECONDS      = "3600"
```

> **Attention** : avec `FEEDBACK_REQUIRE_SIGNATURE=true`, tous les anciens liens en circulation sont rejetés. Ne jamais activer en prod sans phase de transition complète.

---

## 4. Commandes PowerShell locales

### Définir les variables (Mode C complet)

```powershell
$env:FEEDBACK_SIGNED_LINKS_ENABLED  = "true"
$env:FEEDBACK_REQUIRE_SIGNATURE     = "true"
$env:FEEDBACK_SIGNING_SECRET        = "test-secret-local-only"
$env:FEEDBACK_LINK_TTL_SECONDS      = "3600"
```

### Vérifier qu'elles sont définies

```powershell
Get-Item Env:\FEEDBACK_SIGNED_LINKS_ENABLED
Get-Item Env:\FEEDBACK_REQUIRE_SIGNATURE
Get-Item Env:\FEEDBACK_SIGNING_SECRET
Get-Item Env:\FEEDBACK_LINK_TTL_SECONDS
```

### Supprimer après test (nettoyage obligatoire)

```powershell
Remove-Item Env:\FEEDBACK_SIGNED_LINKS_ENABLED
Remove-Item Env:\FEEDBACK_REQUIRE_SIGNATURE
Remove-Item Env:\FEEDBACK_SIGNING_SECRET
Remove-Item Env:\FEEDBACK_LINK_TTL_SECONDS
```

### Vérifier que les variables sont supprimées

```powershell
[System.Environment]::GetEnvironmentVariable("FEEDBACK_SIGNING_SECRET")
# Doit retourner $null
```

---

## 5. Tests locaux sans serveur (méthode validée GD-086)

Les modules `feedback-signature.js` et `feedback-links-builder.js` sont purs (pas d'I/O, pas de CFG). Ils peuvent être testés directement avec `node` sans lancer le bot.

### Méthode : script temporaire dans le répertoire du projet

```powershell
# Écrire le script de test dans le répertoire du projet (les require('./scripts/...') se résolvent correctement)
# Node résout les chemins relatifs depuis le répertoire du fichier .js, pas depuis le cwd.

# Exemple minimal (Mode B) :
node -e "
const fbs = require('./scripts/feedback-signature');
console.log('Enabled (undefined):', fbs.isFeedbackSignedLinksEnabled(undefined));  // false
console.log('Enabled (true):',     fbs.isFeedbackSignedLinksEnabled('true'));      // true
console.log('TTL defaut:',         fbs.DEFAULT_TTL_SECONDS);                       // 604800
"
```

### Suite de tests Jest (1132/1132)

```powershell
cd C:\PROJETS_AI\projet_claude\radar-bc-bot-clean-2
npm test
# Expected : 1132 passed, 40 suites
```

### Tests ciblés feedback-signature uniquement

```powershell
npm test -- --testPathPattern="feedback-signature"
# FBS-1..23 : flags, expiry, payload canonique, signature, vérification, intégration
```

### Ce qu'il ne faut PAS faire pour ces tests

- Ne pas lancer `node radar-bc-bot.js`
- Ne pas lancer Puppeteer
- Ne pas se connecter à Supabase
- Ne pas lancer de scan
- Ne pas déclencher de notification

---

## 6. Critères GO — test HMAC local

Avant d'activer les flags localement :

- [ ] `git status` propre (rien de stagé, rien de non commité de critique)
- [ ] `npm test` → 1132/1132 OK
- [ ] `npx tsc --noEmit` → 0 erreur
- [ ] `FEEDBACK_SIGNING_SECRET` = valeur fictive locale uniquement (jamais un secret réel)
- [ ] Aucun secret dans Git ni dans `.env` versionné
- [ ] `data/feedback/` présent dans `.gitignore`
- [ ] Aucun import automatique vers Supabase planifié
- [ ] Lecture manuelle du CSV avant tout import

---

## 7. Critères NO-GO — activation prod

Ne pas activer en prod tant que :

- [ ] `FEEDBACK_SIGNING_SECRET` non défini ou géré en dehors de Fly Secrets
- [ ] Pas de protocole de rotation de secret documenté
- [ ] Pas de client pilote ayant validé les liens signés end-to-end
- [ ] Pas de validation Supabase/RLS/migration pour la colonne `sig` si nécessaire
- [ ] `FEEDBACK_REQUIRE_SIGNATURE=true` envisagé sans phase de transition (risque de rupture des anciens liens en circulation)
- [ ] Pas de monitoring des erreurs de signature (`/feedback` → 400, logs, alertes)
- [ ] Pas de mécanisme de fallback en cas de secret manquant côté Fly

---

## 8. Règles de sécurité

Ces règles s'appliquent en permanence, bêta ou prod :

1. **Ne jamais committer `FEEDBACK_SIGNING_SECRET`** — ni dans `.env`, ni dans un fichier de config versionné, ni dans un script de test durable.
2. **Ne jamais mettre de secret réel dans `.env` versionné** — `.env` est dans `.gitignore` mais `.env.example` ne doit contenir que des valeurs fictives.
3. **Ne jamais activer `FEEDBACK_REQUIRE_SIGNATURE=true` en prod sans phase de transition** — commencer par Mode B (génération signée, vérification souple) jusqu'à ce que tous les liens anciens aient expiré ou soient renouvelés.
4. **Garder `FEEDBACK_REQUIRE_SIGNATURE=false` pendant la phase hybride** — les anciens liens sans `sig=` restent valides, les nouveaux sont signés. Basculer en stricte uniquement quand le parc de liens est entièrement renouvelé.
5. **Ne jamais importer automatiquement les feedbacks signés vers Supabase** — relecture manuelle du CSV obligatoire avant tout import, bêta ou prod.
6. **TTL court en bêta locale** — utiliser `FEEDBACK_LINK_TTL_SECONDS=3600` (1 heure) pour valider l'expiration rapidement sans attendre 7 jours.
7. **Nettoyage des variables après test** — supprimer `Env:\FEEDBACK_SIGNING_SECRET` dès la fin du test local pour éviter qu'une valeur de test ne reste dans l'environnement de la session.

---

## 9. Verdict

| Périmètre | Verdict |
|-----------|---------|
| HMAC local (modules purs, `node -e`) | ✅ GO — validé GD-086, 1132/1132 |
| Bêta locale signée (Mode B — génération signée, vérification souple) | ✅ GO sous contrôle |
| Bêta locale stricte (Mode C — rejet liens non signés) | ✅ GO pour test local uniquement |
| Prod signature activée (Mode B ou C) | ❌ NO-GO — critères section 7 non satisfaits |

---

*Créé GD-087 — documentation uniquement. Aucun code modifié. Rien stagé. Rien commité.*
