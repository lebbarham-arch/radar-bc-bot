/**
 * Tests — bc.schema.ts
 *
 * Couvre :
 *   - ParsedArticleSchema : validation, defaults, contraintes
 *   - ParsedBCSchema      : validation, defaults, URL, bodyText max
 *   - RadarTypeSchema     : enum strict
 *   - extractFullText()   : construction du texte de matching
 *   - isBCEnCours()       : détection de date limite dépassée
 *   - safeParseBC()       : échec propre sans exception
 */

import {
  ParsedArticleSchema,
  ParsedBCSchema,
  RadarTypeSchema,
  extractFullText,
  isBCEnCours,
  safeParseBC,
  type ParsedBC,
} from '@core/schemas/bc.schema';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_ARTICLE = {
  designation:    'Câble réseau RJ45 Cat6',
  specifications: 'Cat6, blindé, 500m',
  quantite:       '10',
  unite:          'rouleaux',
};

const VALID_BC_RAW = {
  id:          'BC-2024-001',
  objet:       'Fourniture de câbles réseau',
  organisme:   'DGSI',
  wilaya:      'Rabat-Salé-Kénitra',
  lieu:        'Rabat',
  date_limite: '31/12/2099',
  reference:   'REF-001',
  url:         'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/1',
  articles:    [VALID_ARTICLE],
  bodyText:    'Fourniture câbles réseau pour infrastructure DGSI.',
};

// ─── ParsedArticleSchema ──────────────────────────────────────────────────────

describe('ParsedArticleSchema', () => {
  it('valide un article complet', () => {
    const result = ParsedArticleSchema.safeParse(VALID_ARTICLE);
    expect(result.success).toBe(true);
  });

  it('rejette un article sans désignation', () => {
    const result = ParsedArticleSchema.safeParse({ designation: '' });
    expect(result.success).toBe(false);
  });

  it('applique les defaults pour champs optionnels', () => {
    const result = ParsedArticleSchema.safeParse({ designation: 'Moniteur 27"' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.specifications).toBe('');
      expect(result.data.quantite).toBe('');
      expect(result.data.unite).toBe('');
    }
  });

  it('rejette un objet vide', () => {
    const result = ParsedArticleSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── RadarTypeSchema ──────────────────────────────────────────────────────────

describe('RadarTypeSchema', () => {
  it('accepte "bc"', () => {
    expect(RadarTypeSchema.safeParse('bc').success).toBe(true);
  });

  it('accepte "mp"', () => {
    expect(RadarTypeSchema.safeParse('mp').success).toBe(true);
  });

  it('rejette une valeur inconnue', () => {
    expect(RadarTypeSchema.safeParse('ao').success).toBe(false);
  });

  it('rejette undefined', () => {
    expect(RadarTypeSchema.safeParse(undefined).success).toBe(false);
  });
});

// ─── ParsedBCSchema ───────────────────────────────────────────────────────────

describe('ParsedBCSchema', () => {
  it('valide un BC complet', () => {
    const result = ParsedBCSchema.safeParse(VALID_BC_RAW);
    expect(result.success).toBe(true);
  });

  it('rejette un BC sans id', () => {
    const result = ParsedBCSchema.safeParse({ ...VALID_BC_RAW, id: '' });
    expect(result.success).toBe(false);
  });

  it('rejette une URL invalide', () => {
    const result = ParsedBCSchema.safeParse({ ...VALID_BC_RAW, url: 'pas-une-url' });
    expect(result.success).toBe(false);
  });

  it('applique radar_type default "bc"', () => {
    const result = ParsedBCSchema.safeParse(VALID_BC_RAW);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.radar_type).toBe('bc');
    }
  });

  it('applique articles default []', () => {
    const { articles: _articles, ...withoutArticles } = VALID_BC_RAW;
    const result = ParsedBCSchema.safeParse(withoutArticles);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.articles).toEqual([]);
    }
  });

  it('applique montant default null', () => {
    const result = ParsedBCSchema.safeParse(VALID_BC_RAW);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.montant).toBeNull();
    }
  });

  it('accepte montant positif', () => {
    const result = ParsedBCSchema.safeParse({ ...VALID_BC_RAW, montant: 150000 });
    expect(result.success).toBe(true);
  });

  it('rejette montant négatif ou zéro', () => {
    expect(ParsedBCSchema.safeParse({ ...VALID_BC_RAW, montant: 0 }).success).toBe(false);
    expect(ParsedBCSchema.safeParse({ ...VALID_BC_RAW, montant: -1 }).success).toBe(false);
  });

  it('rejette bodyText > 10 000 caractères', () => {
    const longText = 'x'.repeat(10_001);
    const result = ParsedBCSchema.safeParse({ ...VALID_BC_RAW, bodyText: longText });
    expect(result.success).toBe(false);
  });

  it('accepte _keyword optionnel', () => {
    const result = ParsedBCSchema.safeParse({ ...VALID_BC_RAW, _keyword: 'câble réseau' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data._keyword).toBe('câble réseau');
    }
  });
});

// ─── safeParseBC ──────────────────────────────────────────────────────────────

describe('safeParseBC', () => {
  it('retourne success: true pour un BC valide', () => {
    const result = safeParseBC(VALID_BC_RAW);
    expect(result.success).toBe(true);
  });

  it('retourne success: false sans lancer d\'exception', () => {
    expect(() => safeParseBC(null)).not.toThrow();
    const result = safeParseBC(null);
    expect(result.success).toBe(false);
  });

  it('retourne success: false pour un objet sans id ni url', () => {
    const result = safeParseBC({});
    expect(result.success).toBe(false);
  });
});

// ─── extractFullText ──────────────────────────────────────────────────────────

describe('extractFullText', () => {
  const bc = ParsedBCSchema.parse(VALID_BC_RAW) as ParsedBC;

  it('concatène objet + articles + bodyText', () => {
    const text = extractFullText(bc);
    expect(text).toContain('Fourniture de câbles réseau');
    expect(text).toContain('Câble réseau RJ45 Cat6');
    expect(text).toContain('Cat6, blindé, 500m');
    expect(text).toContain('infrastructure DGSI');
  });

  it('retourne le bodyText seul si pas d\'articles ni d\'objet', () => {
    const minimal = ParsedBCSchema.parse({
      id: 'BC-MIN',
      url: 'https://marchespublics.gov.ma/bdc/entreprise/consultation/show/99',
      bodyText: 'Texte brut uniquement',
    });
    expect(extractFullText(minimal)).toBe('Texte brut uniquement');
  });

  it('retourne une chaîne vide si tout est vide', () => {
    const empty = ParsedBCSchema.parse({
      id: 'BC-EMPTY',
      url: 'https://marchespublics.gov.ma/bdc/entreprise/consultation/show/0',
    });
    expect(extractFullText(empty)).toBe('');
  });
});

// ─── isBCEnCours ──────────────────────────────────────────────────────────────

describe('isBCEnCours', () => {
  const makeBC = (date_limite: string) =>
    ParsedBCSchema.parse({
      id: 'BC-TEST',
      url: 'https://marchespublics.gov.ma/bdc/entreprise/consultation/show/0',
      date_limite,
    }) as ParsedBC;

  it('retourne true si date limite dans le futur', () => {
    expect(isBCEnCours(makeBC('31/12/2099'))).toBe(true);
  });

  it('retourne false si date limite dans le passé', () => {
    expect(isBCEnCours(makeBC('01/01/2000'))).toBe(false);
  });

  it('retourne true si date_limite vide (on notifie par défaut)', () => {
    expect(isBCEnCours(makeBC(''))).toBe(true);
  });

  it('retourne true si format de date invalide', () => {
    expect(isBCEnCours(makeBC('pas-une-date'))).toBe(true);
  });
});
