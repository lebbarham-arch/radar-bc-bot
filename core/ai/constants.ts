/**
 * AI Constants — Anaho
 *
 * Constantes de sécurité et de configuration de la couche IA locale.
 *
 * Ces valeurs sont les seules sources de vérité pour les bornes et seuils IA.
 * Aucune valeur magique ne doit apparaître dans les schemas ou modules IA.
 *
 * Modification de ces constantes = changement d'architecture → justification requise.
 */

// ─── Limites Enrichissement ───────────────────────────────────────────────────

/**
 * Nombre maximum d'inclusions IA par critère.
 * Au-delà, les surplus sont ignorés silencieusement par le moteur.
 */
export const MAX_AI_INCLUSIONS = 10 as const;

/**
 * Nombre maximum d'exclusions IA par critère.
 */
export const MAX_AI_EXCLUSIONS = 5 as const;

// ─── Bornes Reranking ─────────────────────────────────────────────────────────

/**
 * Delta minimum applicable par le reranker (pénalité max).
 * Garantit qu'aucun reranking ne peut faire chuter un score de plus de 5 points.
 */
export const RERANK_DELTA_MIN = -5 as const;

/**
 * Delta maximum applicable par le reranker (bonus max).
 * Garantit qu'aucun reranking ne peut faire monter un score de plus de 5 points.
 */
export const RERANK_DELTA_MAX = 5 as const;

/**
 * Fenêtre d'ambiguïté en dessous du seuil client.
 * Le reranker n'intervient que si : score >= (seuil - RERANK_WINDOW_BELOW).
 */
export const RERANK_WINDOW_BELOW = 5 as const;

/**
 * Fenêtre d'ambiguïté au-dessus du seuil client.
 * Le reranker n'intervient que si : score <= (seuil + RERANK_WINDOW_ABOVE).
 */
export const RERANK_WINDOW_ABOVE = 10 as const;

// ─── Seuils Opportunity Detector ─────────────────────────────────────────────

/**
 * Score déterministe maximum pour qu'un BC soit candidat aux opportunités cachées.
 * Un BC qui score déjà haut n'est pas "caché".
 */
export const OPPORTUNITY_DETERMINISTIC_MAX = 30 as const;

/**
 * Seuil de similarité cosinus minimum pour qu'un BC soit remonté comme opportunité.
 * En dessous = bruit sémantique, ignoré.
 */
export const OPPORTUNITY_EMBEDDING_MIN = 0.72 as const;

// ─── Seuils Soft Exclusion Suggester ─────────────────────────────────────────

/**
 * Nombre minimum de feedbacks `not_relevant` nécessaires pour suggérer
 * une soft exclusion. En dessous = signal insuffisant.
 */
export const SOFT_EXCLUSION_MIN_FEEDBACKS = 3 as const;

/**
 * Nombre maximum de candidats soft exclusion proposés par analyse.
 * Évite la surcharge de l'interface de revue.
 */
export const SOFT_EXCLUSION_MAX_CANDIDATES = 5 as const;

// ─── LLM ──────────────────────────────────────────────────────────────────────

/**
 * Température par défaut pour tous les appels LLM de la couche IA.
 * Faible = plus déterministe, adapté aux tâches structurées.
 */
export const LLM_TEMPERATURE_DEFAULT = 0.2 as const;

/**
 * Nombre maximum de tokens en sortie LLM.
 * Protège contre les réponses infinies et les dépassements de contexte.
 */
export const MAX_LLM_TOKENS = 1024 as const;

/**
 * Timeout d'un appel LLM en millisecondes.
 * Au-delà, l'appel est annulé et LLMError code='timeout' est retourné.
 */
export const LLM_TIMEOUT_MS = 30_000 as const;

/**
 * Nombre maximum de tentatives pour un appel LLM.
 * 1 = pas de retry. 2 = 1 retry après échec. Maximum autorisé : 3.
 * Au-delà, on retourne immédiatement l'erreur sans relancer.
 */
export const MAX_LLM_RETRY_ATTEMPTS = 2 as const;

/**
 * Délai entre deux tentatives LLM en millisecondes.
 * Fixe — pas de backoff exponentiel pour rester prévisible.
 */
export const LLM_RETRY_DELAY_MS = 1_000 as const;

/**
 * URL de base Ollama locale.
 * Peut être surchargée par la variable d'environnement OLLAMA_BASE_URL.
 */
export const OLLAMA_BASE_URL_DEFAULT = 'http://localhost:11434' as const;

// ─── Cache ────────────────────────────────────────────────────────────────────

/**
 * TTL du cache d'embeddings en jours.
 * Un embedding pour un texte et un modèle donnés est stable 90 jours.
 */
export const EMBEDDING_CACHE_TTL_DAYS = 90 as const;

/**
 * TTL du cache d'enrichissement en jours.
 * Re-enrichissement déclenché si le critère a changé depuis ai_enriched_at.
 */
export const ENRICHMENT_CACHE_TTL_DAYS = 30 as const;

/**
 * TTL du cache de classification articles en jours.
 * Pratiquement permanent — même désignation → même intent.
 */
export const CLASSIFICATION_CACHE_TTL_DAYS = 365 as const;

// ─── Confiance ────────────────────────────────────────────────────────────────

/**
 * Seuil de confiance minimum en dessous duquel une sortie IA est ignoree.
 * Source de verite unique -- importe par shared.schema.ts et tous les modules IA.
 */
export const MIN_CONFIDENCE_THRESHOLD = 0.4 as const;

/**
 * Seuil de confiance "haute" -- la sortie peut etre appliquee sans revue.
 */
export const HIGH_CONFIDENCE_THRESHOLD = 0.8 as const;

// --- Onboarding Advisor ---

/**
 * Nombre maximum de suggestions affichees a l'onboarding.
 */
export const MAX_ONBOARDING_SUGGESTIONS = 5 as const;

/**
 * Seuil de similarite cosinus pour detecter des criteres redondants.
 */
export const CRITERE_REDUNDANCY_THRESHOLD = 0.88 as const;

// --- Borne globale sur la taille des prompts ---

/**
 * Taille maximale autorisee pour un prompt envoye au LLM (en caracteres).
 * Protege contre les prompts pathologiques qui depassent la fenetre de contexte.
 * Si le prompt depasse cette limite, le module retourne prompt_too_long sans appeler le LLM.
 * Valeur : 10 000 chars ~ 2 500 tokens (marge de securite pour modeles 4k context).
 */
export const MAX_LLM_PROMPT_CHARS = 10_000 as const;
