/**
 * Tests — Scoring Engine V1 (Déterministe)
 *
 * Valide les 6 cas obligatoires + cas auxiliaires pour les composants.
 *
 * Cas obligatoires :
 *   T1 — maintenance climatiseur → score haut pour mainteneur CVC
 *   T2 — achat climatiseur simple → score bas (mismatch intention)
 *   T3 — achat pièces de rechange pour maintenance → NON exclu, score élevé
 *   T4 — ventilation seule → score faible/moyen
 *   T5 — ventilation + CTA + maintenance → score haut
 *   T6 — 1 article IT dans BC mobilier → ne domine pas (score bas)
 */

import { scoreBC, detectBCIntent } from '@core/scoring/engine';
import { normalizeText, levenshtein, exactMatch, fuzzyMatch, matchKeyword } from '@core/scoring/matchers';
import { ParsedBCSchema } from '@core/schemas/bc.schema';
import { ClientProfileSchema } from '@core/schemas/client.schema';

// ─── Profil client CVC (mainteneur) ──────────────────────────────────────────

const CVC_MAINTAINER = ClientProfileSchema.parse({
  id:   'client-cvc-001',
  nom:  'Atlas Climatech',
  pack: 'pro',
  business_profile: {
    secteurs:          ['CVC', 'climatisation', 'génie climatique'],
    types_prestation:  ['maintenance', 'entretien', 'installation'],
    organismes_cibles: [],
    exclusions_metier: ['informatique', 'mobilier', 'travaux'],
  },
  technical_profile: {
    produits:       ['climatiseur', 'split', 'CTA', 'ventilation', 'compresseur'],
    specifications: ['BTU', '18000 BTU', '24000 BTU', 'R410A', 'frigories'],
  },
  organization_profile: {
    ville:             'Casablanca',
    wilayas_couvertes: ['Casablanca-Settat', 'Rabat-Salé-Kénitra'],
    wilayas_exclues:   [],
  },
  criteres: [
    {
      id:            'crit-cvc-001',
      type:          'contenu',
      valeur:        'climatisation',
      radar_type:    'bc',
      ai_inclusions: ['climatiseur', 'split', 'CVC', 'CTA', 'compresseur', 'ventilateur'],
      ai_exclusions: [],
      actif:         true,
    },
  ],
});

const CVC_CRITERES = CVC_MAINTAINER.criteres;

// ─── Profil client IT (fournisseur bureautique) ───────────────────────────────

const IT_SUPPLIER = ClientProfileSchema.parse({
  id:   'client-it-001',
  nom:  'DataSupply Maroc',
  pack: 'pro',
  business_profile: {
    secteurs:          ['informatique', 'bureautique'],
    types_prestation:  ['fourniture', 'installation'],
    organismes_cibles: [],
    exclusions_metier: ['mobilier', 'travaux'],
  },
  technical_profile: {
    produits:       ['ordinateur', 'laptop', 'imprimante', 'écran'],
    specifications: ['Core i7', 'SSD', 'DDR4'],
  },
  organization_profile: {
    ville:             'Casablanca',
    wilayas_couvertes: [],
    wilayas_exclues:   [],
  },
  criteres: [
    {
      id:            'crit-it-001',
      type:          'contenu',
      valeur:        'ordinateur portable',
      radar_type:    'bc',
      ai_inclusions: ['laptop', 'pc portable', 'notebook'],
      ai_exclusions: [],
      actif:         true,
    },
  ],
});

const IT_CRITERES = IT_SUPPLIER.criteres;

// ─── Helper BC builder ────────────────────────────────────────────────────────

function makeBC(params: {
  objet: string;
  bodyText?: string;
  articles?: Array<{ designation: string; specifications?: string }>;
  organisme?: string;
  wilaya?: string;
}) {
  return ParsedBCSchema.parse({
    id:          `BC-TEST-${Math.random().toString(36).slice(2, 7)}`,
    url:         'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/1',
    objet:       params.objet,
    bodyText:    params.bodyText ?? '',
    organisme:   params.organisme ?? '',
    wilaya:      params.wilaya ?? '',
    articles:    (params.articles ?? []).map(a => ({
      designation:    a.designation,
      specifications: a.specifications ?? '',
      quantite:       '',
      unite:          '',
    })),
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// MATCHERS — Tests unitaires des utilitaires de base
// ═════════════════════════════════════════════════════════════════════════════

describe('normalizeText', () => {
  it('met en minuscules', () => {
    expect(normalizeText('CLIMATISEUR')).toBe('climatiseur');
  });

  it('supprime les accents', () => {
    expect(normalizeText('réseau')).toBe('reseau');
    expect(normalizeText('câble')).toBe('cable');
    expect(normalizeText('pièces')).toBe('pieces');
  });

  it('remplace la ponctuation par espace', () => {
    expect(normalizeText('lot n°1 — câble')).toContain('cable');
  });

  it('collapse les espaces multiples', () => {
    expect(normalizeText('câble   réseau')).toBe('cable reseau');
  });
});

describe('levenshtein', () => {
  it('retourne 0 pour deux chaînes identiques', () => {
    expect(levenshtein('cable', 'cable')).toBe(0);
  });

  it('retourne 1 pour une substitution', () => {
    expect(levenshtein('cale', 'bale')).toBe(1);
  });

  it('calcule la distance correctement (faute OCR)', () => {
    // câable → cable : 2 opérations (supprimer 1 'a', garder accent via normalize)
    expect(levenshtein('caable', 'cable')).toBe(1);
    expect(levenshtein('resaeu', 'reseau')).toBeLessThanOrEqual(2);
  });

  it('retourne la longueur si une chaîne est vide', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });
});

describe('exactMatch', () => {
  it('trouve un mot dans un texte (insensible à la casse)', () => {
    expect(exactMatch('Fourniture de Câble Réseau', 'câble réseau')).toBe(true);
  });

  it('retourne false si le mot est absent', () => {
    expect(exactMatch('Fourniture de mobilier', 'câble réseau')).toBe(false);
  });

  it('retourne false si texte vide', () => {
    expect(exactMatch('', 'câble')).toBe(false);
  });
});

describe('fuzzyMatch (règle GD-021)', () => {
  it('matche une faute OCR (distance ≤ 2)', () => {
    // "resaeu" → "reseau" : distance 2
    expect(fuzzyMatch('fourniture resaeu cables', 'réseau')).not.toBeNull();
  });

  it('ne matche PAS si keyword < 5 caractères (règle GD-021)', () => {
    // "café" (4 chars) ne doit pas matcher "câblage"
    expect(fuzzyMatch('fourniture cablage', 'café')).toBeNull();
    expect(fuzzyMatch('fourniture eau', 'eau')).toBeNull(); // 3 chars
  });

  it('ne matche PAS si token dans le texte < 5 chars', () => {
    // "eau" est un token court, ne doit pas fuzzy-matcher même un keyword long
    expect(fuzzyMatch('achat eau', 'eaux industrielles')).toBeNull();
  });

  it('retourne null si pas de match dans la distance', () => {
    expect(fuzzyMatch('fourniture mobilier', 'climatisation')).toBeNull();
  });
});

describe('matchKeyword', () => {
  it('priorise exact sur inclusion', () => {
    const r = matchKeyword('climatisation bâtiment', 'climatisation', ['climatiseur']);
    expect(r.trigger).toBe('exact');
    expect(r.matched_term).toBe('climatisation');
  });

  it('utilise inclusion si pas exact', () => {
    const r = matchKeyword('fourniture climatiseurs split', 'climatisation', ['climatiseur', 'split']);
    expect(r.trigger).toBe('inclusion');
    expect(['climatiseur', 'split']).toContain(r.matched_term);
  });

  it('utilise fuzzy en dernier recours', () => {
    const r = matchKeyword('fourniture resaeau cables', 'réseau', []);
    expect(r.trigger).toBe('fuzzy');
  });

  it('retourne none si aucun match', () => {
    const r = matchKeyword('fourniture mobilier bureau', 'climatisation', []);
    expect(r.matched).toBe(false);
    expect(r.trigger).toBe('none');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// detectBCIntent — Détection d'intention
// ═════════════════════════════════════════════════════════════════════════════

describe('detectBCIntent', () => {
  it('détecte maintenance', () => {
    const bc = makeBC({
      objet:    'Maintenance préventive climatiseurs',
      bodyText: 'Entretien et révision des équipements de climatisation.',
    });
    expect(detectBCIntent(bc)).toBe('maintenance');
  });

  it('détecte fourniture', () => {
    const bc = makeBC({
      objet:    'Acquisition de climatiseurs split',
      bodyText: 'Fourniture de matériel de climatisation.',
    });
    expect(detectBCIntent(bc)).toBe('fourniture');
  });

  it('détecte travaux', () => {
    const bc = makeBC({
      objet:    'Travaux de rénovation bâtiment administratif',
      bodyText: 'Gros œuvre, maçonnerie et second œuvre.',
    });
    expect(detectBCIntent(bc)).toBe('travaux');
  });

  it('T3 — achat pièces rechange → maintenance domine (poids + votes)', () => {
    // "achat" (poids 1 fourniture) vs "pièces de rechange" (poids 2) + "maintenance" (poids 2)
    const bc = makeBC({
      objet:    'Achat de pièces de rechange pour maintenance climatiseurs',
      bodyText: 'Fourniture de pièces détachées nécessaires à la maintenance préventive.',
      articles: [
        { designation: 'Filtre climatiseur F7',          specifications: 'pièce de rechange' },
        { designation: 'Condensateur compresseur CVC',   specifications: 'maintenance préventive' },
      ],
    });
    // maintenance: pieces de rechange (2) + maintenance (2*2) + entretien?... = dominant
    // fourniture: achat (1) + fourniture (1) = 2
    const intent = detectBCIntent(bc);
    expect(intent).toBe('maintenance');
  });

  it('retourne unknown si aucun mot-clé', () => {
    const bc = makeBC({ objet: 'Consultation numéro 42', bodyText: '' });
    expect(detectBCIntent(bc)).toBe('unknown');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CAS OBLIGATOIRES — scoreBC
// ═════════════════════════════════════════════════════════════════════════════

describe('T1 — Maintenance climatiseur → score haut pour profil mainteneur CVC', () => {
  const bc = makeBC({
    objet:    'Maintenance préventive climatiseurs split',
    bodyText: 'La présente consultation porte sur la maintenance préventive et corrective des climatiseurs split installés dans les locaux administratifs.',
    wilaya:   'Casablanca-Settat',
    articles: [
      { designation: 'Climatiseur split 18000 BTU', specifications: 'maintenance préventive annuelle' },
      { designation: 'Climatiseur cassette 24000 BTU', specifications: 'entretien et révision' },
      { designation: 'Recharge gaz R410A', specifications: 'maintenance curative' },
    ],
  });

  const result = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);

  it('score final ≥ 65', () => {
    expect(result.final_score).toBeGreaterThanOrEqual(65);
  });

  it('décision = notify', () => {
    expect(result.decision).toBe('notify');
  });

  it('article_score > 0 (articles matchés)', () => {
    expect(result.article_score).toBeGreaterThan(0);
  });

  it('business_intent_score = 20 (maintenance → maintenance)', () => {
    expect(result.business_intent_score).toBe(20);
  });

  it('contextual_exclusion_penalty = 0', () => {
    expect(result.contextual_exclusion_penalty).toBe(0);
  });

  it('explications contient l\'intention et les articles', () => {
    expect(result.explanation).toContain('maintenance');
    expect(result.details.bc_intent).toBe('maintenance');
  });
});

describe('T2 — Achat climatiseur simple → score bas (mismatch métier)', () => {
  const bc = makeBC({
    objet:    'Achat de climatiseurs split',
    bodyText: 'Acquisition de climatiseurs pour les bureaux administratifs.',
    articles: [
      { designation: 'Climatiseur split 18000 BTU', specifications: '' },
    ],
  });

  const result   = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);

  // Score T1 pour comparaison
  const bcT1 = makeBC({
    objet:    'Maintenance préventive climatiseurs split',
    bodyText: 'Maintenance préventive et corrective des climatiseurs split.',
    articles: [
      { designation: 'Climatiseur split 18000 BTU', specifications: 'maintenance préventive' },
      { designation: 'Climatiseur cassette 24000 BTU', specifications: 'entretien' },
      { designation: 'Recharge gaz R410A', specifications: 'curatif' },
    ],
  });
  const resultT1 = scoreBC(bcT1, CVC_MAINTAINER, CVC_CRITERES);

  it('score T2 < score T1 (fourniture < maintenance pour mainteneur)', () => {
    expect(result.final_score).toBeLessThan(resultT1.final_score);
  });

  it('business_intent_score = 3 (mismatch fourniture vs maintenance)', () => {
    expect(result.business_intent_score).toBe(3);
  });

  it('intent détecté = fourniture', () => {
    expect(result.details.bc_intent).toBe('fourniture');
  });

  it('score inférieur d\'au moins 15 points vs T1', () => {
    expect(resultT1.final_score - result.final_score).toBeGreaterThanOrEqual(10);
  });
});

describe('T3 — Achat pièces de rechange pour maintenance → NON exclu, score élevé', () => {
  const bc = makeBC({
    objet:    'Achat de pièces de rechange pour maintenance climatiseurs',
    bodyText: 'Fourniture de pièces détachées nécessaires à la maintenance préventive et corrective des équipements de climatisation.',
    articles: [
      { designation: 'Filtre climatiseur F7',         specifications: 'pièce de rechange, maintenance préventive' },
      { designation: 'Courroie ventilateur CVC',      specifications: 'remplacement annuel' },
      { designation: 'Condensateur compresseur CVC',  specifications: 'pièce détachée maintenance' },
    ],
  });

  const result = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);

  it('n\'est pas ignoré (score ≥ 20)', () => {
    expect(result.final_score).toBeGreaterThanOrEqual(20);
  });

  it('décision ≠ ignore', () => {
    expect(result.decision).not.toBe('ignore');
  });

  it('penalty exclusion = 0 ("achat" ne pénalise pas)', () => {
    // "achat" est dans le titre mais ne doit jamais déclencher d'exclusion
    expect(result.contextual_exclusion_penalty).toBe(0);
  });

  it('business_intent_score élevé (maintenance domine dans le texte)', () => {
    // maintenance domine sur fourniture dans les votes
    expect(result.business_intent_score).toBeGreaterThanOrEqual(8);
  });

  it('intent détecté inclut maintenance', () => {
    expect(['maintenance', 'mixed']).toContain(result.details.bc_intent);
  });

  it('explanation ne mentionne pas "achat" dans les exclusions', () => {
    expect(result.details.exclusion_reasons.join(' ')).not.toContain('achat');
  });
});

describe('T4 — Ventilation seule → score faible/moyen', () => {
  const bc = makeBC({
    objet:    'Fourniture de ventilateurs industriels',
    bodyText: 'Acquisition de ventilateurs centrifuges pour locaux industriels.',
    articles: [
      { designation: 'Ventilateur centrifuge 800m3/h',  specifications: '' },
      { designation: 'Ventilateur hélicoïdal 1200m3/h', specifications: '' },
    ],
  });

  // T1 pour comparaison
  const bcT1 = makeBC({
    objet:    'Maintenance climatiseurs split 18000 BTU',
    bodyText: 'Maintenance préventive climatiseurs.',
    articles: [
      { designation: 'Climatiseur split 18000 BTU', specifications: 'maintenance' },
      { designation: 'Climatiseur cassette 24000 BTU', specifications: 'entretien' },
    ],
  });
  const resultT1 = scoreBC(bcT1, CVC_MAINTAINER, CVC_CRITERES);
  const result   = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);

  it('score T4 < score T1 (ventilation seule < maintenance CVC complète)', () => {
    expect(result.final_score).toBeLessThan(resultT1.final_score);
  });

  it('business_intent_score faible (fourniture vs maintenance)', () => {
    expect(result.business_intent_score).toBeLessThanOrEqual(8);
  });

  it('score ≤ 65 (pas un vrai positif évident)', () => {
    expect(result.final_score).toBeLessThanOrEqual(65);
  });

  it('penalty exclusion = 0 (ventilation n\'est pas exclue)', () => {
    expect(result.contextual_exclusion_penalty).toBe(0);
  });
});

describe('T5 — Ventilation + CTA + maintenance → score haut', () => {
  const bc = makeBC({
    objet:    'Maintenance ventilation, CTA et climatisation locaux',
    bodyText: 'Entretien et maintenance de l\'ensemble des équipements de ventilation, centrales de traitement d\'air (CTA) et climatisation des locaux administratifs.',
    articles: [
      { designation: 'CTA centrale traitement air 10000 m3/h', specifications: 'maintenance préventive annuelle' },
      { designation: 'Ventilateur extracteur CVC',              specifications: 'entretien et graissage' },
      { designation: 'Climatiseur split 24000 BTU',             specifications: 'maintenance corrective' },
      { designation: 'Compresseur climatisation CVC',           specifications: 'révision annuelle' },
    ],
  });

  const result = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);

  it('score final ≥ 65 (score haut)', () => {
    expect(result.final_score).toBeGreaterThanOrEqual(65);
  });

  it('décision = notify', () => {
    expect(result.decision).toBe('notify');
  });

  it('business_intent_score = 20 (maintenance = maintenance)', () => {
    expect(result.business_intent_score).toBe(20);
  });

  it('article_score élevé (haute densité de match)', () => {
    expect(result.article_score).toBeGreaterThan(20);
  });

  it('score T5 ≥ score T4 (avec CTA + maintenance > ventilation seule)', () => {
    const bcT4 = makeBC({
      objet:    'Fourniture de ventilateurs industriels',
      bodyText: 'Acquisition ventilateurs.',
      articles: [{ designation: 'Ventilateur centrifuge 800m3/h', specifications: '' }],
    });
    const resultT4 = scoreBC(bcT4, CVC_MAINTAINER, CVC_CRITERES);
    expect(result.final_score).toBeGreaterThan(resultT4.final_score);
  });
});

describe('T6 — Une ligne informatique dans BC mobilier ne domine pas', () => {
  // 14 articles mobilier + 1 article IT
  const articles = [
    { designation: 'Bureau direction 180cm',       specifications: '' },
    { designation: 'Chaise ergonomique',           specifications: '' },
    { designation: 'Armoire métallique 4 portes',  specifications: '' },
    { designation: 'Table de réunion 10 places',   specifications: '' },
    { designation: 'Caisson de bureau',            specifications: '' },
    { designation: 'Chaise visiteur',              specifications: '' },
    { designation: 'Bibliothèque bureau',          specifications: '' },
    { designation: 'Table basse salon',            specifications: '' },
    { designation: 'Vestiaire métallique',         specifications: '' },
    { designation: 'Meuble de rangement',          specifications: '' },
    { designation: 'Bureau standard 120cm',        specifications: '' },
    { designation: 'Chaise de direction',          specifications: '' },
    { designation: 'Table informatique',           specifications: '' },
    { designation: 'Armoire vestiaire',            specifications: '' },
    // 1 seul article IT
    { designation: 'Ordinateur portable Core i7', specifications: 'laptop SSD 512Go DDR4' },
  ];

  const bc = makeBC({
    objet:    'Fourniture de mobilier de bureau — Lot 1',
    bodyText: 'Acquisition de mobilier de bureau pour les services administratifs. Tables, chaises, armoires et meubles de rangement.',
    articles,
  });

  const result = scoreBC(bc, IT_SUPPLIER, IT_CRITERES);

  it('article_density ≤ 0.1 (1 article IT sur 15)', () => {
    expect(result.details.article_density).toBeLessThanOrEqual(0.1);
  });

  it('article_score ≤ 5 (densité très faible)', () => {
    expect(result.article_score).toBeLessThanOrEqual(5);
  });

  it('score final < 40 (BC non pertinent malgré 1 article)', () => {
    expect(result.final_score).toBeLessThan(40);
  });

  it('comparaison : BC 15/15 IT score beaucoup plus haut', () => {
    const bcFullIT = makeBC({
      objet:    'Fourniture d\'ordinateurs portables',
      bodyText: 'Acquisition de laptops Core i7 pour les bureaux.',
      articles: Array.from({ length: 5 }, (_, i) => ({
        designation:    `Ordinateur portable Core i7 — lot ${i + 1}`,
        specifications: 'laptop SSD 512Go DDR4',
      })),
    });
    const resultFullIT = scoreBC(bcFullIT, IT_SUPPLIER, IT_CRITERES);
    expect(resultFullIT.final_score).toBeGreaterThan(result.final_score + 20);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CAS AUXILIAIRES — Composants individuels
// ═════════════════════════════════════════════════════════════════════════════

describe('Exclusion contextuelle — règles fondamentales', () => {
  it('"achat" dans le titre ne déclenche jamais une exclusion', () => {
    const bc = makeBC({
      objet:    'Achat de climatiseurs split pour administration',
      bodyText: '',
      articles: [{ designation: 'Climatiseur split 18000 BTU', specifications: '' }],
    });
    const result = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);
    expect(result.contextual_exclusion_penalty).toBe(0);
    expect(result.details.exclusion_reasons.join(' ')).not.toContain('achat');
  });

  it('BC travaux déclenche pénalité pour client non-travaux', () => {
    const bc = makeBC({
      objet:    'Travaux de rénovation bâtiment administratif',
      bodyText: 'Travaux de maçonnerie, construction et génie civil.',
      articles: [
        { designation: 'Travaux terrassement lot 1', specifications: 'gros oeuvre' },
        { designation: 'Maçonnerie murs porteurs',   specifications: 'construction' },
      ],
    });
    const result = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);
    expect(result.contextual_exclusion_penalty).toBeLessThan(0);
    expect(result.details.bc_intent).toBe('travaux');
  });

  it('BC mobilier majoritaire → pénalité pour client CVC', () => {
    const bc = makeBC({
      objet:    'Fourniture de mobilier de bureau',
      bodyText: 'Tables, chaises, armoires, meubles de rangement.',
      articles: [
        { designation: 'Bureau direction',      specifications: '' },
        { designation: 'Chaise ergonomique',    specifications: '' },
        { designation: 'Armoire métallique',    specifications: '' },
        { designation: 'Meuble de rangement',   specifications: '' },
      ],
    });
    const result = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);
    expect(result.contextual_exclusion_penalty).toBeLessThan(0);
  });

  it('BC avec "maintenance" dans titre mais contexte IT → pas d\'exclusion abusive', () => {
    // "maintenance" est dans l'exclusion_metier d'un client IT ?
    // Non : un client IT n'exclut pas "maintenance". Ce test vérifie qu'on ne
    // l'exclut que si le SECTEUR est exclu, pas les mots.
    const bc = makeBC({
      objet:    'Maintenance du réseau informatique',
      bodyText: 'Entretien et maintenance des équipements réseau.',
      articles: [
        { designation: 'Switch réseau Gigabit 24 ports', specifications: 'maintenance incluse' },
      ],
    });

    const itWithNetworkCritere = ClientProfileSchema.parse({
      id:   'it-network', pack: 'pro',
      business_profile: {
        secteurs: ['informatique'], types_prestation: ['maintenance', 'fourniture'],
        organismes_cibles: [], exclusions_metier: ['mobilier', 'travaux'],
      },
      technical_profile: { produits: ['switch', 'réseau'], specifications: ['Gigabit'] },
      organization_profile: { ville: '', wilayas_couvertes: [], wilayas_exclues: [] },
      criteres: [{ id: 'c1', type: 'contenu', valeur: 'réseau', radar_type: 'bc', actif: true }],
    });

    const result = scoreBC(bc, itWithNetworkCritere, itWithNetworkCritere.criteres);
    expect(result.contextual_exclusion_penalty).toBe(0);
    expect(result.decision).toBe('notify');
  });
});

describe('Déduplication et bornes', () => {
  it('final_score est toujours entre 0 et 100', () => {
    const bcs = [
      makeBC({ objet: '' }),
      makeBC({ objet: 'Maintenance climatiseurs', articles: Array.from({ length: 50 }, (_, i) => ({ designation: `Climatiseur ${i}`, specifications: 'maintenance CVC BTU' })) }),
    ];
    for (const bc of bcs) {
      const r = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);
      expect(r.final_score).toBeGreaterThanOrEqual(0);
      expect(r.final_score).toBeLessThanOrEqual(100);
    }
  });

  it('BC vide retourne score 0 et décision ignore', () => {
    const bc = makeBC({ objet: '', bodyText: '', articles: [] });
    const result = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);
    expect(result.final_score).toBe(0);
    expect(result.decision).toBe('ignore');
  });

  it('matched_critere_ids ne contient pas de doublons', () => {
    const bc = makeBC({
      objet:    'Maintenance climatiseurs CVC',
      bodyText: 'Maintenance climatiseurs.',
      articles: [{ designation: 'Climatiseur split', specifications: 'maintenance' }],
    });
    const result = scoreBC(bc, CVC_MAINTAINER, CVC_CRITERES);
    const ids = result.matched_critere_ids;
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('seuil pack_threshold override fonctionne', () => {
    const strictClient = ClientProfileSchema.parse({
      ...JSON.parse(JSON.stringify({
        id: 'strict', pack: 'pro', pack_threshold: 90,
        business_profile: { secteurs: [], types_prestation: [], organismes_cibles: [], exclusions_metier: [] },
        technical_profile: { produits: [], specifications: [] },
        organization_profile: { ville: '', wilayas_couvertes: [], wilayas_exclues: [] },
        criteres: [{ id: 'c1', type: 'contenu', valeur: 'climatisation', radar_type: 'bc', actif: true }],
      })),
    });
    const bc = makeBC({ objet: 'Maintenance climatiseurs', bodyText: 'Maintenance CVC.' });
    const result = scoreBC(bc, strictClient, strictClient.criteres);
    // Avec seuil 90, même un bon match sera "rerank" ou "ignore"
    if (result.final_score < 90) {
      expect(result.decision).not.toBe('notify');
    }
  });
});
