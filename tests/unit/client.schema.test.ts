/**
 * Tests — client.schema.ts
 *
 * Couvre :
 *   - PackSchema             : enum strict
 *   - PACK_LIMITS            : cohérence des seuils par pack
 *   - CritereSchema          : validation, defaults, types
 *   - ClientProfileSchema    : profil complet, defaults imbriqués
 *   - getEffectiveThreshold  : seuil effectif (pack vs override)
 *   - getActiveCriteres      : filtrage par actif + radar_type
 */

import {
  PackSchema,
  PACK_LIMITS,
  CritereSchema,
  ClientProfileSchema,
  safeParseClientProfile,
  getEffectiveThreshold,
  getActiveCriteres,
  type ClientProfile,
} from '@core/schemas/client.schema';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_CRITERE = {
  id:            'crit-001',
  type:          'contenu' as const,
  valeur:        'câble réseau',
  radar_type:    'bc' as const,
  ai_inclusions: ['câble RJ45', 'câble cat6'],
  ai_exclusions: ['câble électrique'],
  actif:         true,
};

const VALID_CLIENT_RAW = {
  id:   'client-001',
  nom:  'InfoTech Maroc',
  pack: 'pro',
  business_profile: {
    secteurs:          ['informatique', 'réseaux'],
    types_prestation:  ['fourniture'],
    organismes_cibles: ['DGSI'],
    exclusions_metier: ['travaux'],
  },
  technical_profile: {
    produits:       ['câble réseau', 'switch'],
    specifications: ['Cat6', 'RJ45'],
  },
  organization_profile: {
    ville:             'Casablanca',
    wilayas_couvertes: ['Casablanca-Settat', 'Rabat-Salé-Kénitra'],
    wilayas_exclues:   [],
  },
  criteres: [VALID_CRITERE],
};

// ─── PackSchema ───────────────────────────────────────────────────────────────

describe('PackSchema', () => {
  it('accepte "starter", "pro", "business"', () => {
    expect(PackSchema.safeParse('starter').success).toBe(true);
    expect(PackSchema.safeParse('pro').success).toBe(true);
    expect(PackSchema.safeParse('business').success).toBe(true);
  });

  it('rejette une valeur inconnue', () => {
    expect(PackSchema.safeParse('enterprise').success).toBe(false);
    expect(PackSchema.safeParse('').success).toBe(false);
  });
});

// ─── PACK_LIMITS ──────────────────────────────────────────────────────────────

describe('PACK_LIMITS', () => {
  it('starter a les contraintes les plus restrictives', () => {
    expect(PACK_LIMITS.starter.maxCriteres).toBeLessThan(PACK_LIMITS.pro.maxCriteres);
    expect(PACK_LIMITS.starter.scoreThreshold).toBeGreaterThan(PACK_LIMITS.pro.scoreThreshold);
    expect(PACK_LIMITS.starter.aiEnabled).toBe(false);
  });

  it('business a les contraintes les moins restrictives', () => {
    expect(PACK_LIMITS.business.maxCriteres).toBeGreaterThan(PACK_LIMITS.pro.maxCriteres);
    expect(PACK_LIMITS.business.scoreThreshold).toBeLessThanOrEqual(PACK_LIMITS.pro.scoreThreshold);
    expect(PACK_LIMITS.business.aiEnabled).toBe(true);
  });

  it('pro a l\'IA activée', () => {
    expect(PACK_LIMITS.pro.aiEnabled).toBe(true);
  });

  it('les seuils sont dans la plage 0–100', () => {
    for (const limits of Object.values(PACK_LIMITS)) {
      expect(limits.scoreThreshold).toBeGreaterThanOrEqual(0);
      expect(limits.scoreThreshold).toBeLessThanOrEqual(100);
    }
  });
});

// ─── CritereSchema ────────────────────────────────────────────────────────────

describe('CritereSchema', () => {
  it('valide un critère complet', () => {
    const result = CritereSchema.safeParse(VALID_CRITERE);
    expect(result.success).toBe(true);
  });

  it('rejette un critère sans valeur', () => {
    const result = CritereSchema.safeParse({ ...VALID_CRITERE, valeur: '' });
    expect(result.success).toBe(false);
  });

  it('rejette un critère sans id', () => {
    const result = CritereSchema.safeParse({ ...VALID_CRITERE, id: '' });
    expect(result.success).toBe(false);
  });

  it('applique actif default true', () => {
    const { actif: _actif, ...withoutActif } = VALID_CRITERE;
    const result = CritereSchema.safeParse(withoutActif);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.actif).toBe(true);
    }
  });

  it('applique radar_type default "bc"', () => {
    const { radar_type: _rt, ...withoutRt } = VALID_CRITERE;
    const result = CritereSchema.safeParse(withoutRt);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.radar_type).toBe('bc');
    }
  });

  it('accepte les types contenu, organisme, wilaya', () => {
    const types = ['contenu', 'organisme', 'wilaya'] as const;
    for (const type of types) {
      expect(CritereSchema.safeParse({ ...VALID_CRITERE, type }).success).toBe(true);
    }
  });

  it('rejette un type inconnu', () => {
    const result = CritereSchema.safeParse({ ...VALID_CRITERE, type: 'secteur' });
    expect(result.success).toBe(false);
  });

  it('applique ai_inclusions default []', () => {
    const result = CritereSchema.safeParse({
      id: 'c-1', type: 'contenu', valeur: 'switch'
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ai_inclusions).toEqual([]);
      expect(result.data.ai_exclusions).toEqual([]);
    }
  });
});

// ─── ClientProfileSchema ──────────────────────────────────────────────────────

describe('ClientProfileSchema', () => {
  it('valide un profil client complet', () => {
    const result = ClientProfileSchema.safeParse(VALID_CLIENT_RAW);
    expect(result.success).toBe(true);
  });

  it('rejette un profil sans id', () => {
    const result = ClientProfileSchema.safeParse({ ...VALID_CLIENT_RAW, id: '' });
    expect(result.success).toBe(false);
  });

  it('rejette un profil sans pack', () => {
    const { pack: _pack, ...withoutPack } = VALID_CLIENT_RAW;
    const result = ClientProfileSchema.safeParse(withoutPack);
    expect(result.success).toBe(false);
  });

  it('rejette un pack invalide', () => {
    const result = ClientProfileSchema.safeParse({ ...VALID_CLIENT_RAW, pack: 'gold' });
    expect(result.success).toBe(false);
  });

  it('applique les defaults imbriqués pour business_profile', () => {
    const result = ClientProfileSchema.safeParse({ id: 'c-1', pack: 'starter' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.business_profile.secteurs).toEqual([]);
      expect(result.data.business_profile.exclusions_metier).toEqual([]);
    }
  });

  it('applique criteres default []', () => {
    const result = ClientProfileSchema.safeParse({ id: 'c-1', pack: 'starter' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.criteres).toEqual([]);
    }
  });

  it('accepte un email valide optionnel', () => {
    const result = ClientProfileSchema.safeParse({
      ...VALID_CLIENT_RAW, email: 'contact@infotech.ma'
    });
    expect(result.success).toBe(true);
  });

  it('rejette un email invalide', () => {
    const result = ClientProfileSchema.safeParse({
      ...VALID_CLIENT_RAW, email: 'pas-un-email'
    });
    expect(result.success).toBe(false);
  });
});

// ─── safeParseClientProfile ───────────────────────────────────────────────────

describe('safeParseClientProfile', () => {
  it('retourne success: true pour un profil valide', () => {
    expect(safeParseClientProfile(VALID_CLIENT_RAW).success).toBe(true);
  });

  it('ne lance pas d\'exception sur entrée invalide', () => {
    expect(() => safeParseClientProfile(null)).not.toThrow();
    expect(safeParseClientProfile(null).success).toBe(false);
  });
});

// ─── getEffectiveThreshold ────────────────────────────────────────────────────

describe('getEffectiveThreshold', () => {
  const parseClient = (raw: object) =>
    ClientProfileSchema.parse(raw) as ClientProfile;

  it('retourne le seuil du pack si pas d\'override', () => {
    const client = parseClient({ id: 'c-1', pack: 'pro' });
    expect(getEffectiveThreshold(client)).toBe(PACK_LIMITS.pro.scoreThreshold);
  });

  it('retourne le pack_threshold si défini', () => {
    const client = parseClient({ id: 'c-1', pack: 'pro', pack_threshold: 55 });
    expect(getEffectiveThreshold(client)).toBe(55);
  });

  it('retourne 35 pour business sans override', () => {
    const client = parseClient({ id: 'c-1', pack: 'business' });
    expect(getEffectiveThreshold(client)).toBe(35);
  });
});

// ─── getActiveCriteres ────────────────────────────────────────────────────────

describe('getActiveCriteres', () => {
  const client = ClientProfileSchema.parse({
    id: 'c-1',
    pack: 'pro',
    criteres: [
      { id: 'c1', type: 'contenu', valeur: 'câble', radar_type: 'bc', actif: true },
      { id: 'c2', type: 'contenu', valeur: 'switch', radar_type: 'bc', actif: false },
      { id: 'c3', type: 'contenu', valeur: 'AO informatique', radar_type: 'mp', actif: true },
      { id: 'c4', type: 'contenu', valeur: 'mobilier', radar_type: 'bc', actif: true },
    ],
  }) as ClientProfile;

  it('retourne uniquement les critères actifs pour "bc"', () => {
    const actifs = getActiveCriteres(client, 'bc');
    expect(actifs).toHaveLength(2);
    expect(actifs.map(c => c.id)).toEqual(expect.arrayContaining(['c1', 'c4']));
  });

  it('exclut les critères inactifs', () => {
    const actifs = getActiveCriteres(client, 'bc');
    expect(actifs.map(c => c.id)).not.toContain('c2');
  });

  it('retourne uniquement les critères mp pour radar_type "mp"', () => {
    const actifs = getActiveCriteres(client, 'mp');
    expect(actifs).toHaveLength(1);
    expect(actifs[0]?.id).toBe('c3');
  });

  it('retourne "bc" par défaut si radar_type non précisé', () => {
    const actifs = getActiveCriteres(client);
    expect(actifs).toHaveLength(2);
  });
});
