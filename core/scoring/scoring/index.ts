/**
 * Core Scoring — Anaho
 *
 * Point d'entrée de la couche de scoring déterministe.
 *
 * Usage :
 *   import { scoreBC, detectBCIntent, ScoreComponents } from '@core/scoring';
 *   import { matchKeyword, normalizeText } from '@core/scoring';
 */

// ─── Engine ───────────────────────────────────────────────────────────────────
export {
  scoreBC,
  detectBCIntent,
} from './engine';

export type {
  ScoreComponents,
  BCIntent,
} from './engine';

// ─── Matchers ─────────────────────────────────────────────────────────────────
export {
  normalizeText,
  levenshtein,
  exactMatch,
  inclusionMatch,
  fuzzyMatch,
  matchKeyword,
  tokenize,
} from './matchers';

export type {
  MatchResult,
  MatchTrigger,
} from './matchers';
