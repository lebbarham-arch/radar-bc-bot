/**
 * Core Schemas — Anaho
 *
 * Point d'entrée central pour tous les schémas Zod et types TypeScript
 * de la couche core Anaho.
 *
 * Usage :
 *   import { ParsedBCSchema, ClientProfile, ScoreResult } from '@core/schemas';
 */

// ─── BC ───────────────────────────────────────────────────────────────────────
export {
  ParsedArticleSchema,
  ParsedBCSchema,
  RadarTypeSchema,
  safeParseBC,
  extractFullText,
  isBCEnCours,
} from './bc.schema';

export type {
  ParsedArticle,
  ParsedBC,
  RadarType,
} from './bc.schema';

// ─── Client ───────────────────────────────────────────────────────────────────
export {
  PackSchema,
  PackLimitsSchema,
  PACK_LIMITS,
  BusinessProfileSchema,
  TechnicalProfileSchema,
  OrganizationProfileSchema,
  CritereSchema,
  ClientProfileSchema,
  safeParseClientProfile,
  getEffectiveThreshold,
  getActiveCriteres,
} from './client.schema';

export type {
  Pack,
  PackLimits,
  BusinessProfile,
  TechnicalProfile,
  OrganizationProfile,
  Critere,
  ClientProfile,
} from './client.schema';

// ─── Scoring ──────────────────────────────────────────────────────────────────
export {
  SignalCategorySchema,
  MatchTriggerSchema,
  SignalSchema,
  MatchExplanationSchema,
  ScoreResultSchema,
  ScoreBreakdownSchema,
  safeParseScoreResult,
  computeBreakdown,
  getActiveSignals,
} from './scoring.schema';

export type {
  SignalCategory,
  MatchTrigger,
  Signal,
  MatchExplanation,
  ScoreResult,
  ScoreBreakdown,
} from './scoring.schema';

// ─── Feedback ─────────────────────────────────────────────────────────────────
export {
  FeedbackVerdictSchema,
  FeedbackEventSchema,
  ProfileSnapshotSchema,
  FeedbackSummarySchema,
  safeParseFeedbackEvent,
  computePrecision,
  serializeSnapshot,
} from './feedback.schema';

export type {
  FeedbackVerdict,
  FeedbackEvent,
  ProfileSnapshot,
  FeedbackSummary,
} from './feedback.schema';

// ─── Notification ─────────────────────────────────────────────────────────────
export {
  NotificationChannelSchema,
  NotificationStatusSchema,
  NotificationPayloadSchema,
  NotificationRecordSchema,
  NotificationStatsSchema,
  safeParseNotificationPayload,
  formatTelegramMessage,
} from './notification.schema';

export type {
  NotificationChannel,
  NotificationStatus,
  NotificationPayload,
  NotificationRecord,
  NotificationStats,
} from './notification.schema';
