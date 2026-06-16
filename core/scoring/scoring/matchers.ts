/**
 * Matchers — Anaho Scoring Engine
 *
 * Utilitaires de correspondance textuelle purs, sans effet de bord.
 * Ordre de priorite : exact -> inclusion -> fuzzy -> none
 * Regle GD-021 : fuzzy matching jamais sur termes < 5 caracteres.
 */

// Types publics

// MatchTrigger est défini canoniquement dans @core/schemas/scoring.schema (Zod).
// Importé localement et re-exporté pour que les consommateurs de matchers.ts
// n'aient pas à importer depuis deux sources distinctes.
import { type MatchTrigger } from '@core/schemas/scoring.schema';
export type { MatchTrigger };

export interface MatchResult {
  matched:      boolean;
  trigger:      MatchTrigger;
  matched_term: string;
}

// Normalisation

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Distance de Levenshtein (O(m*n), deux tableaux roulants)

export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
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
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

// Match exact
//
// Strategie en deux temps :
//   1. Sous-chaine directe
//   2. Prefixe de mot pour keywords multi-mots (gere les pluriels)
//      Ex: "cable reseau" matche "cables reseau"
//          car "cables".startsWith("cable") = true.
// Garantie : "cable" ne matche PAS "cablage" car caractere different a l'index 4.
// Le prefixe de mot n'est active que pour tokens >= 4 chars et keywords >= 2 tokens.

export function exactMatch(text: string, keyword: string): boolean {
  if (!text || !keyword) return false;
  const normText = normalizeText(text);
  const normKw   = normalizeText(keyword);

  // 1. Sous-chaine directe
  if (normText.includes(normKw)) return true;

  // 2. Prefixe de mot pour keywords multi-mots (pluriels francais)
  const kwTokens   = normKw.split(/\s+/).filter(t => t.length >= 4);
  const textTokens = normText.split(/\s+/);
  if (kwTokens.length >= 2) {
    return kwTokens.every(kwTok =>
      textTokens.some(textTok => textTok.startsWith(kwTok)),
    );
  }

  return false;
}

// Match via inclusions

export function inclusionMatch(text: string, inclusions: readonly string[]): string | null {
  for (const inc of inclusions) {
    if (exactMatch(text, inc)) return inc;
  }
  return null;
}

// Match fuzzy (Levenshtein)

export function fuzzyMatch(text: string, keyword: string, maxDistance = 2): string | null {
  const normKw = normalizeText(keyword);
  if (normKw.length <= 5) return null; // regle GD-021 : mots courts (<= 5 chars) = exact seulement

  const normText = normalizeText(text);
  const tokens = normText.split(/\s+/);

  for (const token of tokens) {
    if (token.length <= 5) continue; // regle GD-021
    if (levenshtein(token, normKw) <= maxDistance) return token;
  }
  return null;
}

// Match combine

export function matchKeyword(
  text: string,
  keyword: string,
  inclusions: readonly string[] = [],
  maxFuzzyDist = 2,
): MatchResult {
  if (exactMatch(text, keyword)) {
    return { matched: true, trigger: 'exact', matched_term: keyword };
  }

  const inc = inclusionMatch(text, inclusions);
  if (inc !== null) {
    return { matched: true, trigger: 'inclusion', matched_term: inc };
  }

  const fuzzy = fuzzyMatch(text, keyword, maxFuzzyDist);
  if (fuzzy !== null) {
    return { matched: true, trigger: 'fuzzy', matched_term: fuzzy };
  }

  return { matched: false, trigger: 'none', matched_term: '' };
}

// Utilitaires

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
