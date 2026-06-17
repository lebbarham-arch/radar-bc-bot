/**
 * AI Schemas — barrel d'export
 *
 * Point d'entrée unique pour tous les contrats typés de la couche IA locale.
 *
 * Usage :
 *   import { EnricherInput, RerankerOutput, ... } from '@core/ai/schemas';
 *
 * Ordre : shared → llm-client → modules métier → cache
 */

export * from './shared.schema';
export * from './llm-client.schema';
export * from './enricher.schema';
export * from './classifier.schema';
export * from './reranker.schema';
export * from './opportunity-detector.schema';
export * from './soft-exclusion-suggester.schema';
export * from './onboarding-advisor.schema';
export * from './cache.schema';
