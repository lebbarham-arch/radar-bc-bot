/**
 * tests/unit/profile-review-guard.test.ts
 * GD-142 -- Tests unitaires du garde-fou profil (review_if_contains)
 *
 * Architecture :
 *   - review_if_contains       : blocage executoire  -> profile_review_blocked + profile_review_hits
 *   - _gd127_ambiguous_review  : consultatif seul    -> profile_ambiguous_hits (pas de blocage)
 *
 * Suite PRG-1..12 :
 *   PRG-1  : terme review_if_contains present => isAutoCandidate bloque
 *   PRG-2  : hint +5 ne peut pas annuler le blocage profil (priorite guard > hints)
 *   PRG-3  : profileReviewHits expose et non vide quand bloque
 *   PRG-4  : nettoyage locaux normal (sans terme de review) => non bloque, peut etre auto
 *   PRG-5  : BC 367824 -- prestation de blanchissage ('prestation de blanchissage')
 *   PRG-6  : BC 367059 -- desherbage espaces verts ('desherbage')
 *   PRG-7  : BC 366389 -- curage reseau assainissement ('curage')
 *   PRG-8  : BC 366775 -- gardiennage foire ('gardiennage')
 *   PRG-9  : _gd127_ambiguous_review seul ne bloque PAS (consultatif)
 *   PRG-10 : BC 367111 (keep) -- non bloque par review_if_contains
 *   PRG-11 : BC 367508 (keep) -- non bloque par review_if_contains
 *   PRG-12 : BC 367241 (keep) -- non bloque par review_if_contains
 */

// Fonctions de matching reproduites depuis replay-shadow-from-input-snapshot.js
// (copie exacte pour les tester en isolation)

function norm(str: string): string {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasKw(text: string, kw: string): boolean {
  const nk = norm(kw);
  if (!nk) return false;
  const esc = nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + esc).test(norm(text));
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = new Array<number>((m + 1) * (n + 1));
  const idx = (i: number, j: number) => i * (n + 1) + j;
  for (let i = 0; i <= m; i++) d[idx(i, 0)] = i;
  for (let j = 0; j <= n; j++) d[idx(0, j)] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[idx(i, j)] = a[i - 1] === b[j - 1]
        ? (d[idx(i - 1, j - 1)] as number)
        : 1 + Math.min(
            d[idx(i - 1, j)] as number,
            d[idx(i,     j - 1)] as number,
            d[idx(i - 1, j - 1)] as number
          );
    }
  }
  return d[idx(m, n)] as number;
}

function hasKwFuzzy(text: string, kw: string): boolean {
  if (hasKw(text, kw)) return true;
  const nk = norm(kw);
  if (nk.length <= 5) return false;
  const maxDist = nk.length >= 8 ? 2 : 1;
  return norm(text).split(/\s+/).some(function(w) {
    return Math.abs(w.length - nk.length) <= maxDist + 1 &&
      w[0] === nk[0] &&
      levenshtein(w, nk) <= maxDist;
  });
}

function hasAnyKw(text: string, terms: string[]): boolean {
  return (terms || []).some(function(t) { return hasKwFuzzy(text, t); });
}

// Logique garde-fou profil

interface Critere {
  valeur:                   string;
  review_if_contains?:      string[];
  _gd127_ambiguous_review?: string[];
}

/** Blocage executoire : UNIQUEMENT review_if_contains. */
function applyProfileReviewGuard(
  cleanText: string,
  criteres:  Critere[]
): { blocked: boolean; hits: string[] } {
  const blocking: string[] = [];
  criteres.forEach(function(cr) {
    (cr.review_if_contains || []).forEach(function(t) {
      if (t && blocking.indexOf(t) === -1) blocking.push(t);
    });
  });
  const hits = blocking.filter(function(t) { return hasAnyKw(cleanText, [t]); });
  return { blocked: hits.length > 0, hits };
}

/** Consultatif seul : UNIQUEMENT _gd127_ambiguous_review, ne bloque jamais. */
function collectAmbiguousHits(
  cleanText: string,
  criteres:  Critere[]
): string[] {
  const advisory: string[] = [];
  criteres.forEach(function(cr) {
    (cr._gd127_ambiguous_review || []).forEach(function(t) {
      if (t && advisory.indexOf(t) === -1) advisory.push(t);
    });
  });
  return advisory.filter(function(t) { return hasAnyKw(cleanText, [t]); });
}

// Constantes
const CLEAN_STRONG_THRESHOLD = 15;

// Profil Nettoyage local (coherent avec data/client-profiles/local-shadow-clients.json)
const CRITERES_NETTOYAGE: Critere[] = [{
  valeur: 'nettoyage',
  review_if_contains:      ['prestation de blanchissage', 'desherbage', 'curage', 'gardiennage'],
  _gd127_ambiguous_review: ['hygiene', 'desinfection', 'produits d entretien', 'blanchisserie', 'gardiennage nettoyage', 'nettoiement'],
}];

// Textes BC (issus du snapshot bc-input-2026-07-21T14-15-33.jsonl)
// Faux positifs valides (doivent etre bloques par review_if_contains)
const BC_367824_TEXT = 'Prestation de blanchissage, nettoyage et degraissage du linge et couverture au profit de l Ecole Nationale de la Protection Civile';
const BC_367059_TEXT = 'Desherbage et nettoyage des espaces vertes au sein de la maison centrale moul bergui';
const BC_366389_TEXT = 'Travaux de reparation, de curage, de nettoyage et d evacuation des elements solides et liquides du reseau d assainissement';
const BC_366775_TEXT = 'Gardiennage et securite et nettoyage relative l organisation de la foire d artisanat a Leqliaa la province de Tiznit';
// BCs keep (ne doivent PAS etre bloques par profile_review_blocked)
const BC_367111_TEXT = 'achat de produit de nettoyage blanchissage et degraissage du linge pour l hopital psychiatrique ar-razi de Berrechid';
const BC_367508_TEXT = 'PRESTATIONS DE NETTOYAGE ET D HYGIENE AU NIVEAU DE L INSTITUT SUPERIEUR DES PROFESSIONS INFIRMIERES ET TECHNIQUES DE SANTE DE BENI MELLAL';
const BC_367241_TEXT = 'Achat de produits d entretien et d articles d hygiene destines au nettoyage et a l entretien de l UPTVPM Institut de Technologie des Peches Maritimes de Laayoune';
// BC nettoyage locaux standard
const BC_NORMAL_TEXT = 'Nettoyage des locaux administratifs du siege de la prefecture de police de Casablanca';

// ===========================================================================
// PRG-1 : terme review_if_contains present => isAutoCandidate bloque
// ===========================================================================
describe('PRG-1 -- terme review_if_contains bloque auto', () => {
  it('un BC fort avec gardiennage reste review, pas auto', () => {
    const cleanScore = 20;
    let isAutoCandidate = cleanScore >= CLEAN_STRONG_THRESHOLD;
    expect(isAutoCandidate).toBe(true);

    const { blocked } = applyProfileReviewGuard('Le nettoyage et le gardiennage des locaux', CRITERES_NETTOYAGE);
    if (blocked) isAutoCandidate = false;

    expect(isAutoCandidate).toBe(false);
    expect(blocked).toBe(true);
  });
});

// ===========================================================================
// PRG-2 : hint +5 ne peut pas annuler le blocage profil (guard prioritaire)
// ===========================================================================
describe('PRG-2 -- hint boost ne bypasse pas le blocage profil', () => {
  it('score 10 + hint +5 = 15 fort mais bloque par curage dans texte', () => {
    const cleanScore = 10;
    const hintAdj    = 5;
    const sigs       = ['nettoyage'];

    let isStrong        = cleanScore >= CLEAN_STRONG_THRESHOLD;
    let isWeakSingle    = sigs.length === 1 && cleanScore < CLEAN_STRONG_THRESHOLD;
    let isAutoCandidate = isStrong && !isWeakSingle;

    const adjScore = cleanScore + hintAdj;
    isStrong        = adjScore >= CLEAN_STRONG_THRESHOLD;
    isWeakSingle    = sigs.length === 1 && adjScore < CLEAN_STRONG_THRESHOLD;
    isAutoCandidate = isStrong && !isWeakSingle;
    expect(isAutoCandidate).toBe(true); // sans guard : serait auto

    const text = 'Prestation de curage et nettoyage du reseau hydraulique';
    const { blocked, hits } = applyProfileReviewGuard(text, CRITERES_NETTOYAGE);
    if (blocked) isAutoCandidate = false;

    expect(blocked).toBe(true);
    expect(hits).toContain('curage');
    expect(isAutoCandidate).toBe(false);
  });
});

// ===========================================================================
// PRG-3 : profileReviewHits expose et non vide quand bloque
// ===========================================================================
describe('PRG-3 -- profileReviewHits visible pour tracabilite', () => {
  it('hits contient le terme exact qui a declenche le blocage', () => {
    const { blocked, hits } = applyProfileReviewGuard(
      'Travaux de desherbage et nettoyage des espaces verts',
      CRITERES_NETTOYAGE
    );
    expect(blocked).toBe(true);
    expect(hits.length).toBeGreaterThan(0);
    expect(typeof hits[0]).toBe('string');
  });

  it('hits est vide quand le texte ne contient aucun terme de review', () => {
    const { blocked, hits } = applyProfileReviewGuard(BC_NORMAL_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(false);
    expect(hits).toHaveLength(0);
  });
});

// ===========================================================================
// PRG-4 : nettoyage locaux normal -- non bloque, peut etre auto
// ===========================================================================
describe('PRG-4 -- nettoyage normal de locaux ne doit pas etre bloque', () => {
  it('BC nettoyage locaux sans terme de review => blocked=false', () => {
    const { blocked, hits } = applyProfileReviewGuard(BC_NORMAL_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(false);
    expect(hits).toHaveLength(0);
  });

  it('score 20 sans terme review reste auto apres guard', () => {
    const cleanScore = 20;
    let isAutoCandidate = cleanScore >= CLEAN_STRONG_THRESHOLD;
    const { blocked } = applyProfileReviewGuard(BC_NORMAL_TEXT, CRITERES_NETTOYAGE);
    if (blocked) isAutoCandidate = false;
    expect(blocked).toBe(false);
    expect(isAutoCandidate).toBe(true);
  });
});

// ===========================================================================
// PRG-5 : BC 367824 -- prestation de blanchissage (terme prestation de blanchissage)
// ===========================================================================
describe('PRG-5 -- BC 367824 : prestation de blanchissage', () => {
  it('contient prestation de blanchissage => blocked=true', () => {
    const { blocked, hits } = applyProfileReviewGuard(BC_367824_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(true);
    expect(hits).toContain('prestation de blanchissage');
  });

  it('hasAnyKw detecte prestation de blanchissage dans le texte normalise', () => {
    expect(hasAnyKw(BC_367824_TEXT, ['prestation de blanchissage'])).toBe(true);
  });

  it('prestation de blanchissage absent de BC 367111 (keep) -- pas de blocage croise', () => {
    expect(hasAnyKw(BC_367111_TEXT, ['prestation de blanchissage'])).toBe(false);
  });
});

// ===========================================================================
// PRG-6 : BC 367059 -- desherbage espaces verts
// ===========================================================================
describe('PRG-6 -- BC 367059 : desherbage espaces verts', () => {
  it('contient desherbage => blocked=true', () => {
    const { blocked, hits } = applyProfileReviewGuard(BC_367059_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(true);
    expect(hits).toContain('desherbage');
  });

  it('hasAnyKw detecte desherbage apres normalisation NFD', () => {
    expect(hasAnyKw('Desherbage et nettoyage des espaces vertes', ['desherbage'])).toBe(true);
  });

});

// ===========================================================================
// PRG-7 : BC 366389 -- curage reseau assainissement
// ===========================================================================
describe('PRG-7 -- BC 366389 : curage reseau assainissement', () => {
  it('contient curage => blocked=true', () => {
    const { blocked, hits } = applyProfileReviewGuard(BC_366389_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(true);
    expect(hits).toContain('curage');
  });

  it('hasAnyKw detecte curage dans le texte', () => {
    expect(hasAnyKw(BC_366389_TEXT, ['curage'])).toBe(true);
  });
});

// ===========================================================================
// PRG-8 : BC 366775 -- gardiennage foire artisanat
// ===========================================================================
describe('PRG-8 -- BC 366775 : gardiennage foire artisanat', () => {
  it('contient gardiennage => blocked=true', () => {
    const { blocked, hits } = applyProfileReviewGuard(BC_366775_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(true);
    expect(hits).toContain('gardiennage');
  });

  it('hasAnyKw detecte gardiennage dans le texte', () => {
    expect(hasAnyKw(BC_366775_TEXT, ['gardiennage'])).toBe(true);
  });
});

// ===========================================================================
// PRG-9 : _gd127_ambiguous_review seul ne bloque PAS (consultatif uniquement)
// ===========================================================================
describe('PRG-9 -- _gd127_ambiguous_review : consultatif uniquement, pas de blocage', () => {
  const CRITERES_ADVISORY_ONLY: Critere[] = [{
    valeur: 'nettoyage',
    _gd127_ambiguous_review: ['hygiene', 'desinfection', 'blanchisserie'],
  }];

  it('terme _gd127_ambiguous_review present => blocked=false', () => {
    const { blocked } = applyProfileReviewGuard(
      'Prestations de nettoyage et d hygiene des locaux',
      CRITERES_ADVISORY_ONLY
    );
    expect(blocked).toBe(false);
  });

  it('collectAmbiguousHits detecte le terme mais ne bloque pas', () => {
    const text = 'Prestations de nettoyage et d hygiene des locaux';
    const { blocked } = applyProfileReviewGuard(text, CRITERES_ADVISORY_ONLY);
    const ambiguous   = collectAmbiguousHits(text, CRITERES_ADVISORY_ONLY);
    expect(blocked).toBe(false);
    expect(ambiguous).toContain('hygiene');
  });

  it('hint +5 peut rendre auto un BC avec terme advisory uniquement', () => {
    const adjScore      = 10 + 5;
    const isStrong      = adjScore >= CLEAN_STRONG_THRESHOLD;
    const isWeakSingle  = false; // 2 signaux
    let   isAutoCandidate = isStrong && !isWeakSingle;

    const text = 'Prestations de nettoyage et d hygiene des locaux';
    const { blocked } = applyProfileReviewGuard(text, CRITERES_ADVISORY_ONLY);
    if (blocked) isAutoCandidate = false;

    expect(blocked).toBe(false);
    expect(isAutoCandidate).toBe(true);
  });

  it('applyProfileReviewGuard ignore _gd127_ambiguous_review sans review_if_contains', () => {
    const { blocked, hits } = applyProfileReviewGuard(
      'nettoyage blanchisserie et desinfection',
      CRITERES_ADVISORY_ONLY
    );
    expect(blocked).toBe(false);
    expect(hits).toHaveLength(0);
  });
});

// ===========================================================================
// PRG-10 : BC 367111 (keep) -- non bloque par review_if_contains
// ===========================================================================
describe('PRG-10 -- BC 367111 (keep) : achat produits nettoyage blanchissage -- non bloque', () => {
  it('ne contient pas de terme review_if_contains => blocked=false', () => {
    const { blocked } = applyProfileReviewGuard(BC_367111_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(false);
  });

  it('hasAnyKw prestation de blanchissage => false sur ce texte (achat produits != prestation)', () => {
    expect(hasAnyKw(BC_367111_TEXT, ['prestation de blanchissage'])).toBe(false);
  });

  it('profile_ambiguous_hits peut etre non vide sans bloquer', () => {
    const ambiguous = collectAmbiguousHits(BC_367111_TEXT, CRITERES_NETTOYAGE);
    const { blocked } = applyProfileReviewGuard(BC_367111_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(false);
    expect(Array.isArray(ambiguous)).toBe(true);
  });
});

// ===========================================================================
// PRG-11 : BC 367508 (keep) -- hygiene seul ne bloque pas
// ===========================================================================
describe('PRG-11 -- BC 367508 (keep) : nettoyage + hygiene -- non bloque', () => {
  it('hygiene est advisory, pas bloquant => blocked=false', () => {
    const { blocked } = applyProfileReviewGuard(BC_367508_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(false);
  });

  it('collectAmbiguousHits detecte hygiene comme advisory', () => {
    const ambiguous = collectAmbiguousHits(BC_367508_TEXT, CRITERES_NETTOYAGE);
    expect(ambiguous).toContain('hygiene');
  });
});

// ===========================================================================
// PRG-12 : BC 367241 (keep) -- produits entretien + hygiene ne bloquent pas
// ===========================================================================
describe('PRG-12 -- BC 367241 (keep) : achat produits entretien hygiene -- non bloque', () => {
  it('hygiene et produits d entretien sont advisory => blocked=false', () => {
    const { blocked } = applyProfileReviewGuard(BC_367241_TEXT, CRITERES_NETTOYAGE);
    expect(blocked).toBe(false);
  });

  it('collectAmbiguousHits detecte les termes advisory', () => {
    const ambiguous = collectAmbiguousHits(BC_367241_TEXT, CRITERES_NETTOYAGE);
    expect(ambiguous.length).toBeGreaterThan(0);
  });
});
