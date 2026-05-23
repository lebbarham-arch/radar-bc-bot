/**
 * Matchers — Anaho Scoring Engine
 *
 * Utilitaires de correspondance textuelle purs, sans effet de bord.
 * Tous les algorithmes sont déterministes et entièrement traçables.
 *
 * Ordre de priorité pour un match :
 *   exact → inclusion → fuzzy → none
 *
 * Règle GD-021 : le fuzzy matching n'opère jamais sur des termes < 5 caractères
 * pour éviter les faux positifs type "café" → "câblage".
 */

// ─── Types publics ────────────────────────────────────────────────────────────

export type MatchTrigger = 'exact' | 'inclusion' | 'fuzzy' | 'none';

export interface MatchResult {
  matched:      boolean;
  trigger:      MatchTrigger;
  matched_term: string;
}

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * Normalise un texte pour la comparaison :
 * - minuscules
 * - décomposition NFD + suppression des combinaisons (diacritiques)
 * - remplacement ponctuation → espace
 * - collapse espaces multiples
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // strip diacritics
    .replace(/[^\w\s]/g, ' ')          // ponctuation → espace
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Distance de Levenshtein ──────────────────────────────────────────────────

/**
 * Distance de Levenshtein entre deux chaînes.
 * Implémentation O(m·n) avec deux tableaux roulants (pas de matrice 2D).
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Optimisations rapides
  if (m === 0) return n;
  if (n === 0) return m;
  if (a === b) return 0;

  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const costSub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const costDel = (prev[j] ?? 0) + 1;
      const costIns = (curr[j - 1] ?? 0) + 1;
      curr[j] = Math.min(costSub, costDel, costIns);
    }
    // swap
    [prev, curr] = [curr, prev];
  }

  return prev[n] ?? 0;
}

// ─── Match exact ──────────────────────────────────────────────────────────────

/**
 * Teste si `text` contient `keyword` comme sous-chaîne (après normalisation).
 * Sensible aux mots entiers : "câble" matche "câble réseau" mais pas "câblage".
 *
 * Note : on teste la sous-chaîne exacte normalisée, pas les frontières de mots.
 * Pour une correspondance précise, voir matchKeyword.
 */
export function exactMatch(text: string, keyword: string): boolean {
  if (!text || !keyword) return false;
  return normalizeText(text).includes(normalizeText(keyword));
}

// ─── Match via inclusions ─────────────────────────────────────────────────────

/**
 * Teste si `text` contient l'une des `inclusions` (variantes enrichies par IA).
 * Retourne le premier terme d'inclusion trouvé, ou null.
 */
export function inclusionMatch(text: string, inclusions: readonly string[]): string | null {
  for (const inc of inclusions) {
    if (exactMatch(text, inc)) return inc;
  }
  return null;
}

// ─── Match fuzzy (Levenshtein) ────────────────────────────────────────────────

/**
 * Cherche dans le `text` un token similaire au `keyword` (distance ≤ maxDistance).
 *
 * Règle GD-021 : n'opère que si keyword.length ≥ 5 ET token.length ≥ 5.
 * Cela évite "cafe" (4c) → "cable" (5c) ou "eau" → "eau minerale".
 *
 * Retourne le token correspondant, ou null si aucun match.
 */
export function fuzzyMatch(text: string, keyword: string, maxDistance = 2): string | null {
  const normKw = normalizeText(keyword);
  if (normKw.length < 5) return null;    // règle GD-021

  const normText = normalizeText(text);
  const tokens = normText.split(/\s+/);

  for (const token of tokens) {
    if (token.length < 5) continue;      // règle GD-021
    if (levenshtein(token, normKw) <= maxDistance) return token;
  }
  return null;
}

// ─── Match combiné ────────────────────────────────────────────────────────────

/**
 * Tente de matcher `keyword` contre `text` dans l'ordre de priorité :
 *   1. exact (sous-chaîne normalisée)
 *   2. inclusion (liste de variantes)
 *   3. fuzzy (Levenshtein ≤ maxFuzzyDist, si keyword ≥ 5 chars)
 *   4. none
 *
 * @param text          Texte brut à analyser
 * @param keyword       Mot-clé principal du critère
 * @param inclusions    Variantes acceptées (enrichissement IA)
 * @param maxFuzzyDist  Distance max pour le fuzzy (défaut 2)
 */
export function matchKeyword(
  text: string,
  keyword: string,
  inclusions: readonly string[] = [],
  maxFuzzyDist = 2,
): MatchResult {
  // 1. Exact
  if (exactMatch(text, keyword)) {
    return { matched: true, trigger: 'exact', matched_term: keyword };
  }

  // 2. Inclusion
  const inc = inclusionMatch(text, inclusions);
  if (inc !== null) {
    return { matched: true, trigger: 'inclusion', matched_term: inc };
  }

  // 3. Fuzzy
  const fuzzy = fuzzyMatch(text, keyword, maxFuzzyDist);
  if (fuzzy !== null) {
    return { matched: true, trigger: 'fuzzy', matched_term: fuzzy };
  }

  return { matched: false, trigger: 'none', matched_term: '' };
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/**
 * Tokenise un texte normalisé en mots (sans stop words courants).
 * Utilisé pour l'analyse de densité et la détection d'intention.
 */
const FR_STOP_WORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une',
  'et', 'ou', 'en', 'au', 'aux', 'par', 'pour', 'sur',
  'dans', 'avec', 'sans', 'a', 'est', 'son', 'sa', 'ses',
  'ce', 'se', 'si', 'il', 'elle', 'ils', 'elles', 'on',
  'que', 'qui', 'ne', 'pas', 'plus', 'tout', 'tous',
]);

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .filter(t => t.length >= 2 && !FR_STOP_WORDS.has(t));
}
