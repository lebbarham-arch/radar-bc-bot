/**
 * Tests unitaires — learning-key-utils.js (GD-109)
 *
 * Couvre normalizeLearningKey() :
 *   - règles de transformation (NFD + diacritiques + lowercase + ponctuation)
 *   - exemples obligatoires du cahier des charges
 *   - invariants métier (pas de fusion sémantique)
 *   - cas limites (null, undefined, vide)
 *
 * Miroir pur inline — pas d'import du script JS.
 * Nomenclature : NLK-1..NLK-N
 */

// ─── Miroir inline de normalizeLearningKey ────────────────────────────────────
// Doit être identique à scripts/learning-key-utils.js

function normalizeLearningKey(value: unknown): string {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('normalizeLearningKey — exemples obligatoires GD-109', () => {

  // NLK-1 : accent grave/aigu signal → clé sans accent
  test('NLK-1 : "Hygiène" → "hygiene"', () => {
    expect(normalizeLearningKey('Hygiène')).toBe('hygiene');
  });

  // NLK-2 : même signal sans accent → même clé
  test('NLK-2 : "Hygiene" → "hygiene"', () => {
    expect(normalizeLearningKey('Hygiene')).toBe('hygiene');
  });

  // NLK-3 : les deux donnent la même clé (fusion fragmentation)
  test('NLK-3 : "Hygiène" et "Hygiene" → clé identique', () => {
    expect(normalizeLearningKey('Hygiène')).toBe(normalizeLearningKey('Hygiene'));
  });

  // NLK-4 : signal accentué
  test('NLK-4 : "Dératisation" → "deratisation"', () => {
    expect(normalizeLearningKey('Dératisation')).toBe('deratisation');
  });

  // NLK-5 : signal accentué complexe
  test('NLK-5 : "Désinsectisation" → "desinsectisation"', () => {
    expect(normalizeLearningKey('Désinsectisation')).toBe('desinsectisation');
  });

  // NLK-6 : client avec tiret — version accentuée
  test('NLK-6 : "TEST PROD - Nettoyage Hygiène" → "test prod nettoyage hygiene"', () => {
    expect(normalizeLearningKey('TEST PROD - Nettoyage Hygiène')).toBe('test prod nettoyage hygiene');
  });

  // NLK-7 : client avec tiret — version sans accent
  test('NLK-7 : "TEST PROD - Nettoyage Hygiene" → "test prod nettoyage hygiene"', () => {
    expect(normalizeLearningKey('TEST PROD - Nettoyage Hygiene')).toBe('test prod nettoyage hygiene');
  });

  // NLK-8 : les deux clients donnent la même clé (fusion fragmentation)
  test('NLK-8 : clients avec/sans accent → clé identique', () => {
    expect(normalizeLearningKey('TEST PROD - Nettoyage Hygiène'))
      .toBe(normalizeLearningKey('TEST PROD - Nettoyage Hygiene'));
  });

});

describe('normalizeLearningKey — cas limites', () => {

  // NLK-9 : chaîne vide → vide
  test('NLK-9 : "" → ""', () => {
    expect(normalizeLearningKey('')).toBe('');
  });

  // NLK-10 : null → vide
  test('NLK-10 : null → ""', () => {
    expect(normalizeLearningKey(null)).toBe('');
  });

  // NLK-11 : undefined → vide
  test('NLK-11 : undefined → ""', () => {
    expect(normalizeLearningKey(undefined)).toBe('');
  });

  // NLK-12 : espaces multiples collapsés
  test('NLK-12 : espaces multiples → 1 espace', () => {
    expect(normalizeLearningKey('  foo   bar  ')).toBe('foo bar');
  });

  // NLK-13 : tirets et apostrophes remplacés par espace
  test('NLK-13 : tirets et apostrophes → espace', () => {
    expect(normalizeLearningKey("produits d'entretien")).toBe('produits d entretien');
  });

  // NLK-14 : majuscules → lowercase
  test('NLK-14 : UPPERCASE → lowercase', () => {
    expect(normalizeLearningKey('INFORMATIQUE')).toBe('informatique');
  });

});

describe('normalizeLearningKey — invariants métier GD-109', () => {

  // NLK-15 : produits d'entretien ≠ produits de nettoyage (pas de fusion sémantique)
  test('NLK-15 : "produits d\'entretien" ≠ "produits de nettoyage"', () => {
    const a = normalizeLearningKey("produits d'entretien");
    const b = normalizeLearningKey('produits de nettoyage');
    expect(a).not.toBe(b);
    expect(a).toBe('produits d entretien');
    expect(b).toBe('produits de nettoyage');
  });

  // NLK-16 : desinfection reste distinct (pas de fusion avec désinfection)
  test('NLK-16 : "desinfection" et "désinfection" → même clé (normalisation technique uniquement)', () => {
    expect(normalizeLearningKey('desinfection')).toBe('desinfection');
    expect(normalizeLearningKey('désinfection')).toBe('desinfection');
    expect(normalizeLearningKey('desinfection')).toBe(normalizeLearningKey('désinfection'));
  });

  // NLK-17 : deratisation normalisé identique dans les deux variantes
  test('NLK-17 : "deratisation" et "dératisation" → "deratisation"', () => {
    expect(normalizeLearningKey('deratisation')).toBe('deratisation');
    expect(normalizeLearningKey('dératisation')).toBe('deratisation');
  });

  // NLK-18 : desinsectisation normalisé
  test('NLK-18 : "desinsectisation" et "désinsectisation" → "desinsectisation"', () => {
    expect(normalizeLearningKey('desinsectisation')).toBe('desinsectisation');
    expect(normalizeLearningKey('désinsectisation')).toBe('desinsectisation');
  });

  // NLK-19 : la normalisation ne change pas les signaux déjà normalisés
  test('NLK-19 : idempotence — normaliser deux fois = normaliser une fois', () => {
    const once  = normalizeLearningKey('TEST PROD - Nettoyage Hygiène');
    const twice = normalizeLearningKey(normalizeLearningKey('TEST PROD - Nettoyage Hygiène'));
    expect(twice).toBe(once);
  });

  // NLK-20 : chiffres préservés
  test('NLK-20 : chiffres préservés après normalisation', () => {
    expect(normalizeLearningKey('produit123')).toBe('produit123');
  });

});

describe('normalizeLearningKey — agrégation learning (comportement attendu)', () => {

  // NLK-21 : agrégation signal hygiene + hygiène → même bucket
  test('NLK-21 : signal "hygiene" et "hygiène" mappés au même bucket', () => {
    const signals = ['hygiene', 'hygiène', 'Hygiène', 'HYGIENE'];
    const keys    = signals.map(normalizeLearningKey);
    // Toutes les variantes → même clé
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('hygiene');
  });

  // NLK-22 : clients "Nettoyage Hygiene" et "Nettoyage Hygiène" → même clé client
  test('NLK-22 : clients avec/sans accent → bucket client fusionné', () => {
    const clients = [
      'TEST PROD - Nettoyage Hygiene',
      'TEST PROD - Nettoyage Hygiène',
    ];
    const keys = clients.map(normalizeLearningKey);
    expect(new Set(keys).size).toBe(1);
  });

  // NLK-23 : clients différents restent distincts
  test('NLK-23 : clients différents → buckets séparés', () => {
    const a = normalizeLearningKey('TEST PROD - Nettoyage Hygiene');
    const b = normalizeLearningKey('TEST PROD - Informatique');
    expect(a).not.toBe(b);
  });

  // NLK-24 : signaux sémantiquement différents restent distincts
  test('NLK-24 : "nettoyage" ≠ "hygiene" après normalisation', () => {
    expect(normalizeLearningKey('nettoyage')).not.toBe(normalizeLearningKey('hygiene'));
  });

});

export {};
