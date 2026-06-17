/**
 * LLM Client — Anaho
 *
 * Client Ollama local typé, testable, sans aucune décision métier.
 *
 * Responsabilités UNIQUES de ce module :
 *   1. Envoyer un prompt vers Ollama (ou le mock en test)
 *   2. Gérer le timeout et les retries bornés
 *   3. Valider la réponse brute via Zod avant de la retourner
 *   4. Retourner un LLMResult discriminé (ok: true | ok: false) — jamais d'exception
 *
 * Ce module ne fait PAS :
 *   - Construire les prompts (responsabilité des modules métier)
 *   - Interpréter le contenu JSON (responsabilité des modules métier)
 *   - Prendre de décision sur les données (interdit par conception)
 *   - Mettre en cache (responsabilité de core/ai/cache.ts)
 *
 * Mode mock :
 *   Passer `{ mock: true, mockResponse }` dans les options pour bypasser Ollama.
 *   Utilisé exclusivement dans les tests unitaires.
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import {
  LLMRequest,
  LLMRequestSchema,
  LLMResponse,
  LLMResponseSchema,
  LLMError,
  LLMErrorCode,
  LLMResult,
} from './schemas/llm-client.schema';

import {
  LLM_TIMEOUT_MS,
  MAX_LLM_RETRY_ATTEMPTS,
  LLM_RETRY_DELAY_MS,
  OLLAMA_BASE_URL_DEFAULT,
} from './constants';

// ─── OllamaRawResponse ────────────────────────────────────────────────────────

/**
 * Forme brute de la réponse de l'API Ollama (POST /api/generate).
 * Seuls les champs utilisés sont modélisés.
 * `done: true` indique que la réponse est complète (non-streaming).
 */
interface OllamaRawResponse {
  model:              string;
  response:           string;
  done:               boolean;
  prompt_eval_count?: number;
  eval_count?:        number;
}

// ─── LLMClientOptions ─────────────────────────────────────────────────────────

/**
 * Options de configuration du client LLM.
 *
 * - `baseUrl`        : URL de base Ollama (défaut : OLLAMA_BASE_URL_DEFAULT)
 * - `timeoutMs`      : timeout par appel (défaut : LLM_TIMEOUT_MS)
 * - `maxRetries`     : nombre max de tentatives (défaut : MAX_LLM_RETRY_ATTEMPTS)
 * - `retryDelayMs`   : délai fixe entre tentatives (défaut : LLM_RETRY_DELAY_MS)
 * - `mock`           : si true, bypasse Ollama et utilise mockResponse
 * - `mockResponse`   : réponse simulée retournée en mode mock (obligatoire si mock: true)
 * - `logger`         : fonction de log structuré (défaut : console.error pour erreurs)
 */
export interface LLMClientOptions {
  baseUrl?:      string;
  timeoutMs?:    number;
  maxRetries?:   number;
  retryDelayMs?: number;
  mock?:         boolean;
  mockResponse?: Partial<LLMResponse>;
  logger?:       (entry: LLMLogEntry) => void;
}

// ─── LLMLogEntry ──────────────────────────────────────────────────────────────

/**
 * Entrée de log structuré produite par le client LLM.
 * Jamais de PII — uniquement des métriques et métadonnées.
 */
export interface LLMLogEntry {
  level:      'info' | 'warn' | 'error';
  event:      string;
  model:      string;
  task_type:  string;
  attempt:    number;
  latency_ms: number;
  error_code?: LLMErrorCode;
  tokens_in?:  number;
  tokens_out?: number;
}

// ─── LLMClient ────────────────────────────────────────────────────────────────

/**
 * Interface publique du client LLM.
 * Permet de substituer des mocks en test sans dépendance à l'implémentation.
 */
export interface ILLMClient {
  call(request: LLMRequest): Promise<LLMResult>;
}

// ─── Implémentation ───────────────────────────────────────────────────────────

export class LLMClient implements ILLMClient {
  private readonly baseUrl:      string;
  private readonly timeoutMs:    number;
  private readonly maxRetries:   number;
  private readonly retryDelayMs: number;
  private readonly mock:         boolean;
  private readonly mockResponse: Partial<LLMResponse> | undefined;
  private readonly logger:       (entry: LLMLogEntry) => void;

  constructor(options: LLMClientOptions = {}) {
    this.baseUrl      = options.baseUrl      ?? OLLAMA_BASE_URL_DEFAULT;
    this.timeoutMs    = options.timeoutMs    ?? LLM_TIMEOUT_MS;
    this.maxRetries   = Math.min(options.maxRetries ?? MAX_LLM_RETRY_ATTEMPTS, MAX_LLM_RETRY_ATTEMPTS);
    this.retryDelayMs = options.retryDelayMs ?? LLM_RETRY_DELAY_MS;
    this.mock         = options.mock         ?? false;
    this.mockResponse = options.mockResponse;
    this.logger       = options.logger       ?? defaultLogger;

    if (this.mock && this.mockResponse === undefined) {
      throw new Error('LLMClient: mock=true requiert mockResponse');
    }
  }

  // ─── call ─────────────────────────────────────────────────────────────────

  /**
   * Envoie un prompt vers Ollama et retourne un LLMResult discriminé.
   * En cas d'erreur (timeout, parse, unavailable), retourne { ok: false, error }.
   * Ne lance jamais d'exception non gérée.
   */
  async call(request: LLMRequest): Promise<LLMResult> {
    // Valider la requête avant tout
    const parsed = LLMRequestSchema.safeParse(request);
    if (!parsed.success) {
      return this.makeError('unknown', request.model, request.task_type, 0,
        `LLMRequest invalide : ${parsed.error.message}`);
    }

    const req = parsed.data;

    // Mode mock — bypass complet d'Ollama
    if (this.mock) {
      return this.callMock(req);
    }

    // Appels réels avec retry borné
    let lastError: LLMError | null = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const result = await this.callOnce(req, attempt);

      if (result.ok) return result;

      lastError = result.error;

      // Pas de retry sur les erreurs non récupérables
      if (!isRetryableError(result.error.code)) break;

      if (attempt < this.maxRetries) {
        await sleep(this.retryDelayMs);
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return { ok: false, error: lastError! };
  }

  // ─── callOnce ─────────────────────────────────────────────────────────────

  /**
   * Tente un appel unique vers Ollama avec timeout.
   * Retourne un LLMResult sans exception.
   */
  private async callOnce(req: LLMRequest, attempt: number): Promise<LLMResult> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const body = buildOllamaBody(req);
      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });

      clearTimeout(timeoutHandle);
      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const code: LLMErrorCode = response.status === 404
          ? 'model_not_found'
          : 'ollama_unavailable';

        this.log({ level: 'warn', event: 'llm_http_error', model: req.model,
          task_type: req.task_type, attempt, latency_ms: latencyMs, error_code: code });

        return this.makeError(code, req.model, req.task_type, latencyMs,
          `HTTP ${response.status}`);
      }

      const raw: unknown = await response.json();
      return this.parseOllamaResponse(raw, req, latencyMs, attempt);

    } catch (err: unknown) {
      clearTimeout(timeoutHandle);
      const latencyMs = Date.now() - startTime;

      const isAbort = err instanceof Error && err.name === 'AbortError';
      const code: LLMErrorCode = isAbort ? 'timeout' : 'ollama_unavailable';

      this.log({ level: 'error', event: 'llm_call_failed', model: req.model,
        task_type: req.task_type, attempt, latency_ms: latencyMs, error_code: code });

      return this.makeError(code, req.model, req.task_type, latencyMs,
        err instanceof Error ? err.message : String(err));
    }
  }

  // ─── callMock ─────────────────────────────────────────────────────────────

  /**
   * Retourne la réponse mockée, validée par le schema LLMResponse.
   * Simule une latence nulle — le test contrôle le contenu, pas le timing.
   */
  private callMock(req: LLMRequest): LLMResult {
    const now = new Date().toISOString();

    const candidate: LLMResponse = {
      content:       this.mockResponse?.content       ?? '{}',
      tokens_input:  this.mockResponse?.tokens_input  ?? 0,
      tokens_output: this.mockResponse?.tokens_output ?? 0,
      latency_ms:    this.mockResponse?.latency_ms    ?? 0,
      model:         this.mockResponse?.model         ?? req.model,
      task_type:     this.mockResponse?.task_type     ?? req.task_type,
      created_at:    this.mockResponse?.created_at    ?? now,
    };

    const parsed = LLMResponseSchema.safeParse(candidate);
    if (!parsed.success) {
      return this.makeError('unknown', req.model, req.task_type, 0,
        `mockResponse invalide : ${parsed.error.message}`);
    }

    this.log({ level: 'info', event: 'llm_mock_call', model: req.model,
      task_type: req.task_type, attempt: 1, latency_ms: 0 });

    return { ok: true, value: parsed.data };
  }

  // ─── parseOllamaResponse ──────────────────────────────────────────────────

  /**
   * Parse et valide la réponse brute d'Ollama.
   * Si la réponse n'est pas au format attendu → LLMError json_parse_error.
   */
  private parseOllamaResponse(
    raw:       unknown,
    req:       LLMRequest,
    latencyMs: number,
    attempt:   number,
  ): LLMResult {
    if (!isOllamaRawResponse(raw)) {
      this.log({ level: 'error', event: 'llm_parse_error', model: req.model,
        task_type: req.task_type, attempt, latency_ms: latencyMs,
        error_code: 'json_parse_error' });

      return this.makeError('json_parse_error', req.model, req.task_type, latencyMs,
        'Réponse Ollama inattendue : champs manquants');
    }

    const candidate: LLMResponse = {
      content:       raw.response,
      tokens_input:  raw.prompt_eval_count ?? 0,
      tokens_output: raw.eval_count        ?? 0,
      latency_ms:    latencyMs,
      model:         raw.model,
      task_type:     req.task_type,
      created_at:    new Date().toISOString(),
    };

    const parsed = LLMResponseSchema.safeParse(candidate);
    if (!parsed.success) {
      return this.makeError('json_parse_error', req.model, req.task_type, latencyMs,
        `Validation LLMResponse échouée : ${parsed.error.message}`);
    }

    this.log({
      level:      'info',
      event:      'llm_call_success',
      model:      req.model,
      task_type:  req.task_type,
      attempt,
      latency_ms: latencyMs,
      tokens_in:  parsed.data.tokens_input,
      tokens_out: parsed.data.tokens_output,
    });

    return { ok: true, value: parsed.data };
  }

  // ─── Helpers privés ───────────────────────────────────────────────────────

  private makeError(
    code:      LLMErrorCode,
    model:     string,
    task_type: string,
    _latency:  number,
    _message:  string,
  ): LLMResult {
    const error: LLMError = {
      code,
      message:   _message,
      model,
      // task_type validated at call site — cast safe here
      task_type: task_type as LLMRequest['task_type'],
    };
    return { ok: false, error };
  }

  private log(entry: LLMLogEntry): void {
    this.logger(entry);
  }
}

// ─── Fonctions pures (testables indépendamment) ───────────────────────────────

/**
 * Construit le body JSON pour l'API Ollama /api/generate.
 * Séparée du client pour être testable sans réseau.
 */
export function buildOllamaBody(req: LLMRequest): Record<string, unknown> {
  return {
    model:  req.model,
    prompt: req.prompt,
    stream: false,
    options: {
      temperature: req.temperature,
      num_predict: req.max_tokens,
    },
    // format: 'json' active le mode structured output d'Ollama
    ...(req.response_format === 'json' ? { format: 'json' } : {}),
  };
}

/**
 * Type guard pour OllamaRawResponse.
 * Vérifie la présence et le type des champs obligatoires.
 */
export function isOllamaRawResponse(raw: unknown): raw is OllamaRawResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['model']    === 'string' &&
    typeof r['response'] === 'string' &&
    typeof r['done']     === 'boolean'
  );
}

/**
 * Détermine si un code d'erreur LLM justifie un retry.
 * Les erreurs de parsing et model_not_found ne sont pas retryables.
 */
export function isRetryableError(code: LLMErrorCode): boolean {
  return code === 'timeout' || code === 'ollama_unavailable';
}

/**
 * Logger par défaut : n'émet que les erreurs et warnings sur stderr.
 * Les infos sont silencieuses par défaut pour ne pas polluer les tests.
 */
function defaultLogger(entry: LLMLogEntry): void {
  if (entry.level === 'error') {
    console.error(`[LLMClient] ${entry.event}`, entry);
  } else if (entry.level === 'warn') {
    console.warn(`[LLMClient] ${entry.event}`, entry);
  }
}

/**
 * Pause asynchrone bornée.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Crée un client LLM réel pointant vers Ollama local.
 * Utilise OLLAMA_BASE_URL si définie dans l'environnement.
 */
export function createLLMClient(options: LLMClientOptions = {}): LLMClient {
  const baseUrl = process.env['OLLAMA_BASE_URL'] ?? OLLAMA_BASE_URL_DEFAULT;
  return new LLMClient({ baseUrl, ...options });
}

/**
 * Crée un client LLM mocké pour les tests.
 * `content` est le JSON string retourné comme contenu de la réponse.
 */
export function createMockLLMClient(
  content: string,
  overrides: Partial<LLMResponse> = {},
): LLMClient {
  return new LLMClient({
    mock:         true,
    mockResponse: { content, ...overrides },
  });
}
