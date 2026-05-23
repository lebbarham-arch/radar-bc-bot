# Golden Dataset — Anaho

## Rôle du golden dataset

Le golden dataset est la **source de vérité** pour valider le scoring.  
C'est un ensemble de cas annotés manuellement, représentant des situations réelles.

Chaque case est :
- Un BC réel (anonymisé si nécessaire)
- Un profil client avec ses critères
- Un verdict humain : `match` ou `no_match`
- Un score de référence attendu (±5 points acceptable)
- Une explication de la décision humaine

**Règle** : toute modification du moteur de scoring doit passer le golden dataset à 100% sur les verdicts avant merge.

---

## Format d'un cas

```json
{
  "id": "GD-001",
  "description": "Câble réseau RJ45 pour fournisseur informatique — vrai positif évident",
  "category": "true_positive",
  "bc": {
    "id": "BC-2024-DGSI-0042",
    "objet": "Fourniture de câbles réseau et accessoires",
    "organisme": "Direction Générale des Systèmes d'Information",
    "wilaya": "Rabat-Salé-Kénitra",
    "lieu": "Rabat",
    "date_limite": "15/06/2024",
    "url": "https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/42",
    "articles": [
      {
        "designation": "Câble réseau RJ45 Cat6 — 500ml",
        "specifications": "Cat6, blindé, 500 mètres, couleur gris",
        "quantite": "10",
        "unite": "rouleaux"
      },
      {
        "designation": "Connecteurs RJ45 Cat6",
        "specifications": "Lot de 100 connecteurs, compatible Cat6",
        "quantite": "20",
        "unite": "lots"
      },
      {
        "designation": "Switch réseau 24 ports",
        "specifications": "24 ports RJ45, Gigabit, géré",
        "quantite": "3",
        "unite": "unités"
      }
    ],
    "bodyText": "La présente consultation porte sur la fourniture de câbles réseau RJ45 Cat6 et accessoires pour les besoins en infrastructure réseau de la DGSI."
  },
  "client": {
    "id": "client-reseau-001",
    "nom": "InfoTech Maroc",
    "pack": "pro",
    "pack_threshold": 40,
    "business_profile": {
      "secteurs": ["informatique", "réseaux", "télécommunications"],
      "types_prestation": ["fourniture", "installation"],
      "organismes_cibles": ["DGSI", "Ministère", "Administration centrale"],
      "exclusions_metier": ["travaux", "bâtiment", "génie civil"]
    },
    "technical_profile": {
      "produits": ["câble réseau", "switch", "routeur", "équipement réseau"],
      "specifications": ["Cat6", "RJ45", "Gigabit", "PoE"]
    }
  },
  "criteres": [
    {
      "id": "crit-001",
      "type": "contenu",
      "valeur": "câble réseau",
      "radar_type": "bc",
      "ai_inclusions": ["câble RJ45", "câble cat6", "cable reseau", "cordon réseau", "patch cord"],
      "ai_exclusions": ["câble électrique", "câble HTA", "câble souterrain"]
    }
  ],
  "expected_verdict": "match",
  "expected_score_min": 70,
  "expected_score_max": 90,
  "expected_signals": ["article_exact_match", "secteur_match", "type_prestation", "match_density"],
  "human_annotation": {
    "annotateur": "Hamza",
    "date": "2026-01-15",
    "commentaire": "BC très pertinent : 3 articles réseau, organisme IT, critère câble réseau matché exactement dans article 1."
  }
}
```

---

## Cas de référence initiaux

### Catégorie A — Vrais positifs évidents (score attendu ≥ 70)

**GD-001** : Fourniture câbles RJ45 Cat6 — DGSI Rabat  
→ Critère : "câble réseau" / Client : fournisseur IT  
→ Articles : câble RJ45, connecteurs, switch  
→ Verdict : **match** | Score attendu : 70–90

**GD-002** : Fourniture matériel informatique — CHU Casablanca  
→ Critère : "ordinateur portable" / Client : fournisseur bureautique  
→ Articles : laptops Core i7, écrans, claviers  
→ Verdict : **match** | Score attendu : 65–85

**GD-003** : Fourniture consommables imprimerie — Université Mohammed V  
→ Critère : "cartouche imprimante" / Client : revendeur fournitures bureau  
→ Articles : cartouches HP, toners Canon, papier A4  
→ Verdict : **match** | Score attendu : 65–80

**GD-004** : Fourniture mobilier de bureau — Ministère de l'Éducation  
→ Critère : "mobilier bureau" / Client : fournisseur mobilier  
→ Articles : bureaux, chaises, armoires métalliques  
→ Verdict : **match** | Score attendu : 60–80

**GD-005** : Fourniture climatiseurs — Préfecture Marrakech  
→ Critère : "climatisation" / Client : installateur CVC  
→ Articles : split 18000 BTU, cassette 24000 BTU  
→ Verdict : **match** | Score attendu : 60–75

---

### Catégorie B — Vrais positifs avec enrichissement IA (score attendu 45–70)

**GD-010** : Fourniture "équipements audiovisuels"  
→ Critère : "vidéoprojecteur" / ai_inclusions : ["projecteur", "beamer", "rétroprojecteur", "VP"]  
→ Articles contiennent "projecteur full HD" (match sur inclusion IA)  
→ Verdict : **match** | Score attendu : 45–65

**GD-011** : Fourniture "groupe électrogène"  
→ Critère : "groupe électrogène" / ai_inclusions : ["GE diesel", "generateur", "groupe motopompe"]  
→ Articles : "groupe électrogène 20 KVA diesel"  
→ Verdict : **match** | Score attendu : 50–70

**GD-012** : BC avec faute OCR "câable résaeu"  
→ Critère : "câble réseau" / fuzzy matching actif  
→ Levenshtein("câable résaeu", "câble réseau") = 2  
→ Verdict : **match** | Score attendu : 40–60

---

### Catégorie C — Faux positifs historiques (score attendu ≤ 35)

Ces cas ont été envoyés en notification dans le passé par erreur.  
Le nouveau scoring doit les filtrer.

**GD-020** : BC "Travaux de peinture bâtiment" — Lycée Technique Fès  
→ Critère : "peinture" / Client : fournisseur peinture industrielle  
→ Raison du faux positif : le mot "peinture" matchait lexicalement  
→ Contexte : travaux bâtiment, pas fourniture industrielle  
→ Verdict : **no_match** | Score attendu : ≤ 25  
→ Règle d'exclusion attendue : `type_prestation = travaux` + `secteur = bâtiment`

**GD-021** : BC "Fourniture café et boissons" — Ministère des Finances  
→ Critère : "câble" / ai_inclusions : ["câblage", "câble coaxial"]  
→ Raison du faux positif : "café" matchait sur "câblage" (faute fuzzy trop laxiste)  
→ Verdict : **no_match** | Score attendu : 0  
→ Règle : fuzzy matching ne doit pas croiser des mots de longueur < 5

**GD-022** : BC "Maintenance bâtiments administratifs" — Commune Urbaine  
→ Critère : "maintenance" / Client : prestataire maintenance informatique  
→ Raison : le mot "maintenance" matchait sans contexte technique  
→ Verdict : **no_match** | Score attendu : ≤ 20  
→ `type_prestation = travaux bâtiment` exclu pour client IT

**GD-023** : BC "Fourniture eau minérale" — CHU  
→ Critère : "eau" / Client : traitement de l'eau industriel  
→ Raison : "eau" trop générique, contexte hôpital ≠ traitement industriel  
→ Verdict : **no_match** | Score attendu : ≤ 15

**GD-024** : BC "Acquisition de terrain" — Commune Tanger  
→ Critère : "terrain" / Client : fourniture équipements sportifs  
→ Raison : "terrain" matchait dans un contexte immobilier  
→ Verdict : **no_match** | Score attendu : 0  
→ Secteur immobilier hors périmètre

---

### Catégorie D — Cas limites (score entre 35 et 55)

Ces cas testent le comportement aux seuils. Le verdict dépend du pack.

**GD-030** : BC partiellement pertinent (1 article sur 15 match)  
→ Articles : 14 articles bureautique + 1 "câble réseau 10m"  
→ Critère : "câble réseau" / Client réseau  
→ Verdict : **no_match** (Starter/Pro) / **match** (Business si seuil 35)  
→ Score attendu : 38–48

**GD-031** : BC avec organisme inconnu, articles pertinents  
→ Organisme : "Fondation privée XYZ" (non dans whitelist)  
→ Articles : câbles réseau pertinents  
→ Score attendu : 42–55 | Verdict dépend du pack

**GD-032** : BC région exclue, contenu très pertinent  
→ Région : Laâyoune (exclue par client basé à Casablanca)  
→ Articles : 5 articles câblage réseau exactement matchés  
→ Score attendu : 45–58 (pénalité région mais contenu fort)

---

## Processus d'ajout au golden dataset

1. Identifier un cas intéressant (faux positif, cas limite, nouveau type de BC)
2. Récupérer les données brutes (scraping ou copie manuelle)
3. Annoter manuellement : verdict + score attendu + explication
4. Ajouter dans `tests/fixtures/golden_dataset.json`
5. Vérifier que le test `regression.test.js` passe avec le nouveau cas
6. Commit : `test: add GD-XXX to golden dataset — [description]`

---

## Métriques du golden dataset

| Métrique | Objectif Phase 2 | Objectif Phase 4 |
|----------|-----------------|-----------------|
| Nombre total de cas | ≥ 20 | ≥ 50 |
| Vrais positifs (catégorie A+B) | ≥ 10 | ≥ 25 |
| Faux positifs corrigés (catégorie C) | ≥ 5 | ≥ 15 |
| Cas limites (catégorie D) | ≥ 5 | ≥ 10 |
| Accord verdict sur dataset | 100% | 100% |
| Accord score (±5 pts) | ≥ 90% | ≥ 95% |

---

## Format fichier JSON

```
tests/fixtures/golden_dataset.json
[
  { GD-001 },
  { GD-002 },
  ...
]
```

Les fixtures détaillées (bc_samples/, clients/) sont des fichiers JSON séparés référencés par le dataset.
