/**
 * Core AI — barrel d'export
 *
 * Point d'entrée unique pour la couche IA locale d'Anaho.
 *
 * Ce module expose :
 *   - Tous les schemas Zod et types TypeScript inférés
 *   - Toutes les constantes de sécurité
 *   - Les helpers purs (applyRerankDelta, isInAmbiguityWindow, etc.)
 *
 * Ce module n'expose PAS :
 *   - D'appels réseau vers Ollama
 *   - De logique d'inférence ou d'embeddings
 *   - De connexion base de données
 *
 * Les implémentations concrètes seront dans core/ai/llm-client.ts,
 * core/ai/enricher.ts, etc. — créés lors de la phase d'implémentation.
 */

export * from './schemas';
export * from './constants';
