/**
 * Core Pipeline — Anaho
 *
 * Point d'entrée du pipeline de démonstration mocké.
 *
 * Usage :
 *   import { runPipeline, runBatchPipeline, isPipelineResult } from '@core/pipeline';
 *   import { mockParseBc } from '@core/pipeline';
 *   import { classifyArticles } from '@core/pipeline';
 */

// ─── Runner ───────────────────────────────────────────────────────────────────
export {
  runPipeline,
  runBatchPipeline,
} from './runner';

export type {
  PipelineInput,
  BatchInput,
  BatchResult,
} from './runner';

// ─── Parser ───────────────────────────────────────────────────────────────────
export { mockParseBc } from './mock-parser';

// ─── Classifier ───────────────────────────────────────────────────────────────
export {
  classifyArticles,
  formatClassificationSummary,
} from './mock-classifier';

// ─── Types ────────────────────────────────────────────────────────────────────
export {
  isPipelineResult,
} from './types';

export type {
  RawBC,
  ParseResult,
  ArticleCategory,
  Confidence,
  ClassifiedArticle,
  ClassificationSummary,
  PipelineResult,
  PipelineError,
  PipelineOutcome,
} from './types';
