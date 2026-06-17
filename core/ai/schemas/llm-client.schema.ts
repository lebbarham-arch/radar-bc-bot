/**
 * LLM Client Schema — Anaho
 *
 * Contrats d'entrée/sortie du client Ollama local.
 *
 * Ce module définit UNIQUEMENT les types — aucun appel réseau ici.
 * L'implémentation concrète (fetch vers Ollama) sera dans core/ai/llm-client.ts.
 *
 * Contraintes :
 *   - temperature bornée à [0, 1]
 *   - max_tokens borné à MAX_LLM_TOKENS
 *   - response_format : 'json' force le mode structured output d'Ollama
 *   - la latence est toujours tracée (latency_ms obligatoire en sortie)
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';
import { AITaskTypeSchema } from './shared.schema';
import { MAX_LLM_TOKENS, LLM_TEMPERATURE_DEFAULT } from '../constants';

// ─── LLMResponseFormat ────────────────────────────────────────────────────────

/**
 * Format de réponse attendu du LLM.
 * - `json` : Ollama mode JSON structuré (plus fiable pour parsing)
 * - `text` : texte libre (pour advice, résumés)
 */
export const LLMResponseFormatSchema = z.enum(['json', 'text']);
export type LLMResponseFormat = z.infer<typeof LLMResponseFormatSchema>;

// ─── LLMRequest ───────────────────────────────────────────────────────────────

/**
 * Requête envoyée au client LLM local (Ollama).
 *
 * - `model`           : identifiant du modèle Ollama (ex: "qwen2.5:14b")
 * - `prompt`          : prompt complet, déjà formaté par le module appelant
 * - `temperature`     : 0 = déterministe, 1 = créatif. Défaut: 0.2
 * - `max_tokens`      : limite de tokens en sortie (borné à MAX_LLM_TOKENS)
 * - `response_format` : json recommandé pour les modules de scoring
 * - `task_type`       : discriminant pour cache et métriques
 */
export const LLMRequestSchema = z.object({
  model:           z.string().min(1),
  prompt:          z.string().min(1),
  temperature:     z.number().min(0).max(1).default(LLM_TEMPERATURE_DEFAULT),
  max_tokens:      z.number().int().min(1).max(MAX_LLM_TOKENS).default(512),
  response_format: LLMResponseFormatSchema.default('json'),
  task_type:       AITaskTypeSchema,
});

export type LLMRequest = z.infer<typeof LLMRequestSchema>;

// ─── LLMResponse ──────────────────────────────────────────────────────────────

/**
 * Réponse brute du client LLM local.
 *
 * - `content`       : texte brut retourné par Ollama (JSON string ou text)
 * - `tokens_input`  : tokens consommés en entrée (pour métriques)
 * - `tokens_output` : tokens produits en sortie (pour métriques)
 * - `latency_ms`    : durée totale de l'appel en millisecondes
 * - `model`         : modèle réellement utilisé (peut différer si fallback)
 * - `task_type`     : repris de la requête pour traçabilité
 * - `created_at`    : timestamp ISO de la réponse
 */
export const LLMResponseSchema = z.object({
  content:       z.string(),
  tokens_input:  z.number().int().min(0).default(0),
  tokens_output: z.number().int().min(0).default(0),
  latency_ms:    z.number().min(0),
  model:         z.string().min(1),
  task_type:     AITaskTypeSchema,
  created_at:    z.string().datetime(),
});

export type LLMResponse = z.infer<typeof LLMResponseSchema>;

// ─── LLMError ─────────────────────────────────────────────────────────────────

/**
 * Erreur structurée du client LLM.
 * Toujours préférer ce type à une exception non typée.
 *
 * - `code`    : code machine (pour branching)
 * - `message` : message lisible (pour logs)
 * - `model`   : modèle qui a échoué
 * - `task_type`
 */
export const LLMErrorCodeSchema = z.enum([
  'model_not_found',
  'timeout',
  'json_parse_error',
  'context_too_long',
  'ollama_unavailable',
  'unknown',
]);
export type LLMErrorCode = z.infer<typeof LLMErrorCodeSchema>;

export const LLMErrorSchema = z.object({
  code:      LLMErrorCodeSchema,
  message:   z.string().default(''),
  model:     z.string().default(''),
  task_type: AITaskTypeSchema,
});

export type LLMError = z.infer<typeof LLMErrorSchema>;

// ─── LLMResult ────────────────────────────────────────────────────────────────

/**
 * Résultat discriminé d'un appel LLM.
 * Pattern Result<T, E> sans exception non typée.
 */
export type LLMResult =
  | { ok: true;  value: LLMResponse }
  | { ok: false; error: LLMError };

// ─── Helpers ──────────────────────────────────────────────────────────────────

export const safeParseLLMRequest  = (raw: unknown) => LLMRequestSchema.safeParse(raw);
export const safeParseLLMResponse = (raw: unknown) => LLMResponseSchema.safeParse(raw);
export const safeParseLLMError    = (raw: unknown) => LLMErrorSchema.safeParse(raw);
