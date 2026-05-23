/**
 * Fixtures Pipeline — Anaho
 *
 * 5 BCs de démonstration + 2 profils clients.
 * Chaque fixture est un cas réel annoté pour valider un comportement attendu.
 *
 * Fixtures BC :
 *   F1 — CVC pertinent            : maintenance climatiseurs → notify pour mainteneur CVC
 *   F2 — CVC non pertinent        : boissons et café → ignore pour mainteneur CVC
 *   F3 — IT réseau pertinent      : câblage réseau RJ45 → notify pour fournisseur IT réseau
 *   F4 — IT consommables non pert : cartouches + papier → ignore pour fournisseur IT réseau
 *   F5 — Opportunité cachée       : titre générique, articles câblage réseau → notify (articles dominent)
 *
 * Profils clients :
 *   CVC_CLIENT   — mainteneur CVC (maintenance, entretien, installation)
 *   IT_CLIENT    — fournisseur IT réseau (câbles, switches, équipements actifs)
 */

import { ClientProfileSchema } from '@core/schemas/client.schema';
import { type RawBC } from '@core/pipeline/types';

// ═════════════════════════════════════════════════════════════════════════════
// PROFILS CLIENTS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Client CVC — Société de maintenance d'équipements de climatisation.
 * Services : maintenance préventive/corrective, installation, entretien.
 * Exclusions : informatique, mobilier, travaux bâtiment.
 */
export const CVC_CLIENT = ClientProfileSchema.parse({
  id:   'demo-client-cvc',
  nom:  'Atlas Climatech SARL',
  pack: 'pro',

  business_profile: {
    secteurs:          ['CVC', 'climatisation', 'génie climatique', 'froid industriel'],
    types_prestation:  ['maintenance', 'entretien', 'installation', 'réparation'],
    organismes_cibles: ['Ministère', 'Université', 'CHU', 'Administration'],
    exclusions_metier: ['informatique', 'mobilier', 'travaux'],
  },

  technical_profile: {
    produits: [
      'climatiseur', 'split', 'CTA', 'ventilateur',
      'compresseur', 'CVC', 'groupe froid', 'pompe chaleur',
    ],
    specifications: [
      'BTU', '18000 BTU', '24000 BTU',
      'R410A', 'R32', 'frigories',
    ],
  },

  organization_profile: {
    ville:             'Casablanca',
    wilayas_couvertes: ['Casablanca-Settat', 'Rabat-Salé-Kénitra', 'Marrakech-Safi'],
    wilayas_exclues:   ['Laâyoune-Sakia El Hamra'],
  },

  criteres: [
    {
      id:            'crit-cvc-maintenance',
      type:          'contenu',
      valeur:        'climatisation',
      radar_type:    'bc',
      ai_inclusions: [
        'climatiseur', 'split', 'CVC', 'CTA',
        'compresseur', 'ventilateur', 'groupe froid',
        'pompe chaleur', 'entretien CVC',
      ],
      ai_exclusions: [],
      actif:         true,
    },
  ],
});

/**
 * Client IT réseau — Fournisseur de câblage réseau et équipements actifs.
 * Services : fourniture et installation de câblage réseau, switches, routeurs.
 * Exclusions : mobilier, travaux bâtiment, bureautique.
 */
export const IT_NETWORK_CLIENT = ClientProfileSchema.parse({
  id:   'demo-client-it-reseau',
  nom:  'NetCable Maroc SARL',
  pack: 'pro',

  business_profile: {
    secteurs:          ['informatique', 'réseaux', 'télécommunications'],
    types_prestation:  ['fourniture', 'installation', 'maintenance'],
    organismes_cibles: ['DGSI', 'Ministère', 'Administration', 'Université'],
    exclusions_metier: ['mobilier', 'travaux', 'bureautique'],
  },

  technical_profile: {
    produits: [
      'câble réseau', 'RJ45', 'switch', 'routeur',
      'patch panel', 'rack', 'fibre optique', 'connecteur',
    ],
    specifications: [
      'Cat6', 'Cat5e', 'Gigabit', 'PoE',
      'RJ45', '24 ports', '48 ports', 'SFP',
    ],
  },

  organization_profile: {
    ville:             'Casablanca',
    wilayas_couvertes: [],  // toutes les régions
    wilayas_exclues:   [],
  },

  criteres: [
    {
      id:            'crit-reseau-cable',
      type:          'contenu',
      valeur:        'câble réseau',
      radar_type:    'bc',
      ai_inclusions: [
        'câble RJ45', 'câble Cat6', 'câble Cat5', 'cordon réseau',
        'patch cord', 'câblage réseau', 'câble Ethernet',
      ],
      ai_exclusions: [],
      actif:         true,
    },
  ],
});

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURE F1 — CVC pertinent
// ═════════════════════════════════════════════════════════════════════════════

/**
 * F1 : BC de maintenance préventive de climatiseurs.
 *
 * Cas de référence : true positive évident pour un mainteneur CVC.
 * Tous les articles sont des équipements CVC, le titre et le contexte
 * indiquent explicitement une mission de maintenance.
 *
 * Comportement attendu :
 *   - article_score  : haut (tous les articles matchent)
 *   - business_intent: 20 (maintenance → maintenance)
 *   - decision       : notify
 *   - score          : ≥ 65
 */
export const F1_CVC_PERTINENT: RawBC = {
  id:          'BC-CVC-2026-001',
  objet:       'Maintenance préventive et corrective des climatiseurs split',
  organisme:   'Direction Régionale de l\'Éducation Nationale — Casablanca',
  wilaya:      'Casablanca-Settat',
  lieu:        'Casablanca',
  date_limite: '30/06/2026',
  reference:   'REF/DREN/CVC/2026/001',
  url:         'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/1001',
  _keyword:    'maintenance climatiseur',

  raw_body: `
    La présente consultation porte sur la maintenance préventive et corrective
    des équipements de climatisation (split et cassettes) installés dans les
    établissements scolaires relevant de la Direction Régionale de l'Éducation
    Nationale de Casablanca-Settat. Les prestations comprennent le nettoyage
    des filtres, la vérification du niveau de gaz R410A, l'entretien des
    compresseurs et la révision annuelle des unités intérieures et extérieures.
  `.trim(),

  raw_tables: [
    ['N°', 'Désignation', 'Spécifications', 'Quantité', 'Unité'],
    ['1',  'Climatiseur split 18000 BTU — Unité intérieure', 'Maintenance préventive annuelle, nettoyage filtre, contrôle gaz R410A', '24', 'unités'],
    ['2',  'Climatiseur cassette 24000 BTU', 'Entretien et révision, vérification compresseur', '8', 'unités'],
    ['3',  'Compresseur climatiseur CVC', 'Révision annuelle, vérification pression', '12', 'unités'],
    ['4',  'Recharge gaz réfrigérant R410A', 'Recharge curative si nécessaire', '10', 'kg'],
    ['5',  'Main d\'œuvre entretien CVC', 'Intervention technicien agréé', '1', 'forfait'],
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURE F2 — CVC non pertinent
// ═════════════════════════════════════════════════════════════════════════════

/**
 * F2 : BC de fourniture de boissons et café pour une administration.
 *
 * Cas de référence : false positive potentiel si le matching était lexical.
 * Le mot "refroidisseur" n'apparaît pas. Aucun article CVC.
 * Le BC est totalement hors périmètre pour un mainteneur CVC.
 *
 * Comportement attendu :
 *   - article_score  : 0 (aucun article CVC)
 *   - decision       : ignore
 *   - score          : < 20
 */
export const F2_CVC_NON_PERTINENT: RawBC = {
  id:          'BC-ALIM-2026-042',
  objet:       'Fourniture de café, thé et eau minérale pour les services administratifs',
  organisme:   'Préfecture de Casablanca',
  wilaya:      'Casablanca-Settat',
  lieu:        'Casablanca',
  date_limite: '15/04/2026',
  reference:   'REF/PREF/ALIM/2026/042',
  url:         'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/1002',
  _keyword:    'fourniture',

  raw_body: `
    Acquisition de produits alimentaires pour les besoins en restauration légère
    des services administratifs de la Préfecture de Casablanca. Les produits
    doivent être de première qualité et livrés dans des conditions hygiéniques.
  `.trim(),

  raw_tables: [
    ['N°', 'Désignation', 'Quantité', 'Unité'],
    ['1',  'Café arabica moulu',           '50',  'kg'],
    ['2',  'Thé en sachets',               '200', 'boîtes'],
    ['3',  'Sucre en poudre',              '100', 'kg'],
    ['4',  'Eau minérale 1,5L',            '500', 'bouteilles'],
    ['5',  'Jus de fruits en briques',     '300', 'briques'],
    ['6',  'Biscuits assortis',            '150', 'boîtes'],
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURE F3 — IT réseau pertinent
// ═════════════════════════════════════════════════════════════════════════════

/**
 * F3 : BC de fourniture câbles réseau RJ45 et équipements actifs.
 *
 * Cas de référence : true positive clair pour un fournisseur IT réseau.
 * Titre explicite, articles entièrement réseau, spécifications techniques matchées.
 *
 * Comportement attendu :
 *   - title_score    : haut (câble réseau dans le titre)
 *   - article_score  : haut (tous les articles matchent)
 *   - technical_score: haut (Cat6, Gigabit, RJ45 tous présents)
 *   - decision       : notify
 *   - score          : ≥ 70
 */
export const F3_IT_RESEAU_PERTINENT: RawBC = {
  id:          'BC-IT-2026-088',
  objet:       'Fourniture de câbles réseau RJ45 Cat6 et équipements actifs',
  organisme:   'Direction Générale des Systèmes d\'Information — DGSI',
  wilaya:      'Rabat-Salé-Kénitra',
  lieu:        'Rabat',
  date_limite: '20/05/2026',
  reference:   'REF/DGSI/IT/2026/088',
  url:         'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/1003',
  _keyword:    'câble réseau',

  raw_body: `
    La présente consultation porte sur la fourniture et la mise en place
    d'une infrastructure réseau complète pour les nouveaux locaux de la DGSI.
    Les équipements devront respecter les normes TIA/EIA 568-B et ISO 11801.
    Le câblage réseau Cat6 doit être certifié et testé par un organisme agréé.
  `.trim(),

  raw_tables: [
    ['N°', 'Désignation', 'Spécifications', 'Quantité', 'Unité'],
    ['1',  'Câble réseau RJ45 Cat6 — bobine 305m', 'Cat6 F/UTP, LSZH, certifié, couleur gris', '20',  'bobines'],
    ['2',  'Connecteur RJ45 Cat6',                  'Pack 100 pcs, blindé, compatible Cat6',    '50',  'packs'],
    ['3',  'Switch Gigabit 24 ports',                'Gigabit Ethernet, administrable, PoE+',   '5',   'unités'],
    ['4',  'Patch panel 24 ports Cat6',              '1U rack, Cat6, terminaison 110',           '5',   'unités'],
    ['5',  'Câble de brassage RJ45 Cat6 — 0,5m',    'Patch cord Cat6, couleur bleu, 0,5m',      '100', 'unités'],
    ['6',  'Rack 19" 12U mural',                     'Châssis acier, verrouillable, ventilé',    '2',   'unités'],
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURE F4 — IT consommables non pertinent
// ═════════════════════════════════════════════════════════════════════════════

/**
 * F4 : BC de fourniture consommables d'impression et papier bureau.
 *
 * Cas de référence : faux positif potentiel (même secteur "fourniture IT")
 * mais contenu totalement hors périmètre pour un fournisseur réseau.
 * Le mot "imprimante" pourrait tromper un matching lexical naïf.
 *
 * La pénalité d'exclusion contextuelle (secteur bureautique dominant > 50%)
 * doit ramener le score sous le seuil.
 *
 * Comportement attendu :
 *   - article_score              : 0 (aucun câble réseau)
 *   - contextual_exclusion_penalty : négatif (bureautique dominant)
 *   - decision                   : ignore ou rerank
 *   - score                      : < 35
 */
export const F4_IT_CONSOMMABLES_NON_PERTINENT: RawBC = {
  id:          'BC-BUREAU-2026-017',
  objet:       'Fourniture de consommables d\'imprimerie et papier bureau',
  organisme:   'Commune Urbaine d\'Agadir',
  wilaya:      'Souss-Massa',
  lieu:        'Agadir',
  date_limite: '10/03/2026',
  reference:   'REF/CUA/CONS/2026/017',
  url:         'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/1004',
  _keyword:    'informatique consommables',

  raw_body: `
    Acquisition de consommables pour les imprimantes et photocopieurs des
    services communaux. Les cartouches doivent être d'origine constructeur
    ou de marque compatible certifiée. Le papier A4 doit être de grammage
    80g/m² minimum, certifié FSC.
  `.trim(),

  raw_tables: [
    ['N°', 'Désignation',                         'Quantité', 'Unité'],
    ['1',  'Cartouche encre HP 305XL Noire',       '200', 'unités'],
    ['2',  'Cartouche encre HP 305XL Couleur',     '100', 'unités'],
    ['3',  'Toner Canon 052H Noir',                '50',  'unités'],
    ['4',  'Papier A4 80g/m² — ramette 500F',      '500', 'ramettes'],
    ['5',  'Papier A4 90g/m² blanc brillant',      '100', 'ramettes'],
    ['6',  'Enveloppes C4 blanches — boîte 250',   '50',  'boîtes'],
    ['7',  'Chemises cartonnées couleur',           '200', 'unités'],
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// FIXTURE F5 — Opportunité cachée (titre générique, articles pertinents)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * F5 : BC avec titre totalement générique mais articles 100% réseau.
 *
 * Ce cas illustre la valeur fondamentale du scoring par articles :
 * un opérateur humain scannant rapidement les titres passerait à côté.
 * Le moteur détecte l'opportunité en analysant le contenu des articles.
 *
 * Comportement attendu :
 *   - title_score    : 0 (titre générique sans mot-clé réseau)
 *   - content_score  : 0 (bodyText générique)
 *   - article_score  : haut (100% des articles = câblage réseau)
 *   - decision       : notify
 *   - score          : ≥ 55
 *   - explication    : doit souligner que les articles ont révélé l'opportunité
 *
 * C'est le test clé de la règle "articles > titre".
 */
export const F5_HIDDEN_OPPORTUNITY: RawBC = {
  id:          'BC-LOT3-2026-199',
  objet:       'Fourniture de matériels — Lot 3',             // ← titre générique
  organisme:   'Office National des Chemins de Fer — ONCF',
  wilaya:      'Casablanca-Settat',
  lieu:        'Casablanca',
  date_limite: '25/05/2026',
  reference:   'REF/ONCF/LOT3/2026/199',
  url:         'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/1005',
  _keyword:    'fourniture matériels',

  raw_body: `
    Fourniture de divers matériels pour les services techniques de l'ONCF.
    Les articles sont détaillés dans le bordereau quantitatif ci-joint.
    Livraison franco de port dans les délais contractuels.
  `.trim(),

  // ← Articles 100% câblage réseau malgré le titre "fourniture matériels"
  raw_tables: [
    ['N°', 'Désignation', 'Spécifications', 'Quantité', 'Unité'],
    ['1',  'Câble réseau RJ45 Cat6 — bobine 305m',   'Cat6 F/UTP, gaine LSZH, gris',          '30',  'bobines'],
    ['2',  'Switch Gigabit 48 ports administrable',   'Gigabit, PoE+, 48 ports RJ45 + 4 SFP', '3',   'unités'],
    ['3',  'Câble de brassage RJ45 Cat6 — 1m',        'Patch cord Cat6, rouge, 1m',            '200', 'unités'],
    ['4',  'Connecteur RJ45 Cat6 blindé',              'Pack 100, compatible Cat6 F/UTP',       '40',  'packs'],
    ['5',  'Patch panel 48 ports Cat6 — 2U',           '2U rack 19", Cat6, terminaison 110',    '3',   'unités'],
  ],
};

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS GROUPÉS
// ═════════════════════════════════════════════════════════════════════════════

export const ALL_FIXTURES = {
  F1_CVC_PERTINENT,
  F2_CVC_NON_PERTINENT,
  F3_IT_RESEAU_PERTINENT,
  F4_IT_CONSOMMABLES_NON_PERTINENT,
  F5_HIDDEN_OPPORTUNITY,
} as const;

export const ALL_CLIENTS = {
  CVC_CLIENT,
  IT_NETWORK_CLIENT,
} as const;
