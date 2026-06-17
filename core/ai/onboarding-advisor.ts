/**
 * Onboarding Advisor -- Anaho
 *
 * Genere des suggestions UX pendant l onboarding client.
 * Toutes les suggestions ont display_only: true.
 * Ce module ne modifie jamais le ClientProfile.
 *
 * Responsabilites UNIQUES :
 *   1. Valider l entree (client_id + description + domaine + reponses)
 *   2. Verifier le cache (cle sur description + activite + reponses triees)
 *   3. Construire un prompt demandant 5 sections distinctes
 *   4. Appeler ILLMClient.call() et parser la reponse JSON
 *   5. Filtrer les exclusions naives (< 3 mots)
 *   6. Tronquer chaque section a ses limites + warning output_truncated
 *   7. Valider via AdvisoryOutputSchema (display_only: z.literal(true))
 *
 * Ce module ne fait PAS :
 *   - Creer ou modifier des criteres
 *   - Modifier le profil client
 *   - Acces Supabase ou base de donnees
 *   - Branchement dans le pipeline existant
 *
 * Regle : jamais de `any`. Toute donnee manquante -> valeur par defaut explicite.
 */

import { createHash } from 'crypto';
import { z }          from 'zod';

import { AIOutputBaseSchema } from './schemas/shared.schema';
import { LLMRequestSchema }   from './schemas/llm-client.schema';
import { ILLMClient }         from './llm-client';
import { ICache }             from './cache';
import { MAX_LLM_PROMPT_CHARS } from './constants';

// --- Limites par section -----------------------------------------------------

export const MAX_BUSINESS_INTERESTS  = 8  as const;
export const MAX_TECHNICAL_INTERESTS = 8  as const;
export const MAX_EXCLUSIONS          = 5  as const;
export const MAX_ORGANIZATIONS       = 5  as const;
export const MAX_QUESTIONS           = 5  as const;

// --- Schema local : item de suggestion ---------------------------------------

/**
 * Un item de suggestion avec display_only: z.literal(true).
 * source_type 'llm_inference' distingue de la source_type de la sortie globale.
 */
export const AdvisoryItemSchema = z.object({
  label:            z.string().min(1),
  category:         z.string().default(''),
  confidence_score: z.number().min(0).max(1).default(0.5),
  evidence:         z.string().default(''),
  source_type:      z.literal('llm_inference'),
  /** Garantie structurelle : jamais d application automatique */
  display_only:     z.literal(true),
});
export type AdvisoryItem = z.infer<typeof AdvisoryItemSchema>;

// --- Schema local : entree --------------------------------------------------

export const AdvisoryInputSchema = z.object({
  client_id:             z.string().min(1),
  client_description:    z.string().default(''),
  activity_domain:       z.string().default(''),
  onboarding_answers:    z.record(z.string(), z.string()).default({}),
  existing_critere_ids:  z.array(z.string()).default([]),
});
export type AdvisoryInput = z.infer<typeof AdvisoryInputSchema>;

// --- Schema local : sortie --------------------------------------------------

export const AdvisoryOutputSchema = AIOutputBaseSchema.merge(
  z.object({
    client_id: z.string().min(1),

    suggested_business_interests:  z.array(AdvisoryItemSchema).max(MAX_BUSINESS_INTERESTS).default([]),
    suggested_technical_interests: z.array(AdvisoryItemSchema).max(MAX_TECHNICAL_INTERESTS).default([]),
    suggested_exclusions:          z.array(AdvisoryItemSchema).max(MAX_EXCLUSIONS).default([]),
    suggested_organizations:       z.array(AdvisoryItemSchema).max(MAX_ORGANIZATIONS).default([]),
    suggested_questions_to_ask:    z.array(z.string().min(1)).max(MAX_QUESTIONS).default([]),
  }),
).refine(
  (out) => out.task_type === 'onboarding_advice',
  { message: 'AdvisoryOutput.task_type doit etre "onboarding_advice"' },
).refine(
  (out) => [
    ...out.suggested_business_interests,
    ...out.suggested_technical_interests,
    ...out.suggested_exclusions,
    ...out.suggested_organizations,
  ].every((item) => item.display_only === true),
  { message: 'Tous les items doivent avoir display_only: true' },
);
export type OnboardingAdvisorOutput = z.infer<typeof AdvisoryOutputSchema>;

// --- Warning codes ----------------------------------------------------------

export type OnboardingAdvisorWarningCode =
  | 'output_truncated'
  | 'naive_exclusions_filtered'
  | 'cache_payload_invalid'
  | 'cache_store_failed'
  | 'no_suggestions';

export interface OnboardingAdvisorWarning {
  code:    OnboardingAdvisorWarningCode;
  message: string;
}

// --- Error codes ------------------------------------------------------------

export type OnboardingAdvisorErrorCode =
  | 'invalid_input'
  | 'prompt_too_long'
  | 'llm_error'
  | 'parse_error'
  | 'validation_error'
  | 'unknown';

export interface OnboardingAdvisorError {
  code:    OnboardingAdvisorErrorCode;
  message: string;
}

// --- Result discrimine ------------------------------------------------------

export type OnboardingAdvisorResult =
  | { ok: true;  output: OnboardingAdvisorOutput; warnings: OnboardingAdvisorWarning[] }
  | { ok: false; error:  OnboardingAdvisorError };

// --- Forme brute de la reponse LLM ------------------------------------------

interface RawAdvisoryItem {
  label:            string;
  category:         string;
  confidence_score: number;
  evidence:         string;
}

function isRawAdvisoryItem(raw: unknown): raw is RawAdvisoryItem {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r['label']            === 'string' &&
    typeof r['category']         === 'string' &&
    typeof r['confidence_score'] === 'number' &&
    typeof r['evidence']         === 'string'
  );
}

interface RawAdvisoryLLMResponse {
  business_interests:  unknown[];
  technical_interests: unknown[];
  exclusions:          unknown[];
  organizations:       unknown[];
  questions:           unknown[];
}

function isRawAdvisoryLLMResponse(raw: unknown): raw is RawAdvisoryLLMResponse {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return (
    Array.isArray(r['business_interests'])  &&
    Array.isArray(r['technical_interests']) &&
    Array.isArray(r['exclusions'])          &&
    Array.isArray(r['organizations'])       &&
    Array.isArray(r['questions'])
  );
}

// --- Log entry --------------------------------------------------------------

export interface AdvisorLogEntry {
  level:       'info' | 'warn' | 'error';
  event:       string;
  client_id:   string;
  model:       string;
  cache_hit?:  boolean;
  warnings?:   OnboardingAdvisorWarningCode[];
  error_code?: OnboardingAdvisorErrorCode;
}

// --- Options ----------------------------------------------------------------

export interface OnboardingAdvisorOptions {
  model:   string;
  logger?: (entry: AdvisorLogEntry) => void;
}

// --- OnboardingAdvisor ------------------------------------------------------

export class OnboardingAdvisor {
  private readonly model:  string;
  private readonly logger: (entry: AdvisorLogEntry) => void;

  constructor(
    private readonly llmClient: ILLMClient,
    private readonly cache:     ICache,
    options: OnboardingAdvisorOptions,
  ) {
    this.model  = options.model;
    this.logger = options.logger ?? defaultAdvisorLogger;
  }

  // --- advise ----------------------------------------------------------------

  async advise(rawInput: unknown): Promise<OnboardingAdvisorResult> {
    // 1. Valider l entree
    const parsed = AdvisoryInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { ok: false, error: { code: 'invalid_input', message: parsed.error.message } };
    }
    const input = parsed.data;

    // 2. Calculer la cle de cache
    const cacheContent = buildAdvisorCacheContent(input);
    const cacheKey = this.cache.computeKey({
      model:     this.model,
      task_type: 'onboarding_advice',
      content:   cacheContent,
    });

    // 3. Verifier le cache
    const preWarnings: OnboardingAdvisorWarning[] = [];
    const cacheHit = this.cache.get(cacheKey, 'onboarding_advice');
    if (cacheHit.hit) {
      const cached = this.tryParseCachedPayload(cacheHit.entry.payload);
      if (cached !== null) {
        this.log({
          level: 'info', event: 'advisor_cache_hit',
          client_id: input.client_id, model: this.model, cache_hit: true,
        });
        return { ok: true, output: cached, warnings: [] };
      }
      preWarnings.push({
        code:    'cache_payload_invalid',
        message: 'Payload cache invalide -- LLM appele en fallback',
      });
      this.log({
        level: 'warn', event: 'advisor_cache_payload_invalid',
        client_id: input.client_id, model: this.model, warnings: ['cache_payload_invalid'],
      });
    }

    // 4. Construire le prompt
    const prompt = buildAdvisorPrompt(input);

    if (prompt.length > MAX_LLM_PROMPT_CHARS) {
      return {
        ok:    false,
        error: { code: 'prompt_too_long', message: `Prompt trop long (${prompt.length} chars > ${MAX_LLM_PROMPT_CHARS}). Reduire les criteres ou le contexte.` },
      };
    }

    const llmReqParsed = LLMRequestSchema.safeParse({
      model:     this.model,
      prompt,
      task_type: 'onboarding_advice',
    });
    if (!llmReqParsed.success) {
      return { ok: false, error: { code: 'unknown', message: `LLMRequest invalide: ${llmReqParsed.error.message}` } };
    }

    // 5. Appeler le LLM
    const llmResult = await this.llmClient.call(llmReqParsed.data);
    if (!llmResult.ok) {
      this.log({
        level: 'error', event: 'advisor_llm_error',
        client_id: input.client_id, model: this.model, error_code: 'llm_error',
      });
      return { ok: false, error: { code: 'llm_error', message: llmResult.error.message } };
    }

    // 6. Parser, filtrer, valider, stocker
    return this.processLLMResponse(
      llmResult.value.content,
      llmResult.value.model,
      input,
      cacheKey,
      preWarnings,
    );
  }

  // --- Helpers prives --------------------------------------------------------

  private tryParseCachedPayload(payload: string): OnboardingAdvisorOutput | null {
    try {
      const raw    = JSON.parse(payload) as unknown;
      const result = AdvisoryOutputSchema.safeParse(raw);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private processLLMResponse(
    content:     string,
    llmModel:    string,
    input:       AdvisoryInput,
    cacheKey:    string,
    preWarnings: OnboardingAdvisorWarning[] = [],
  ): OnboardingAdvisorResult {
    // Deserialiser
    let raw: unknown;
    try {
      raw = JSON.parse(content) as unknown;
    } catch {
      return {
        ok:    false,
        error: {
          code:    'parse_error',
          message: `Reponse LLM non parseable JSON: "${content.slice(0, 120)}"`,
        },
      };
    }

    if (!isRawAdvisoryLLMResponse(raw)) {
      return {
        ok:    false,
        error: {
          code:    'parse_error',
          message: 'Reponse LLM manque les champs attendus: business_interests, technical_interests, exclusions, organizations, questions',
        },
      };
    }

    const warnings: OnboardingAdvisorWarning[] = [...preWarnings];

    // Mapper un item brut vers AdvisoryItem
    const mapItem = (r: unknown): AdvisoryItem | null => {
      if (!isRawAdvisoryItem(r)) return null;
      const p = AdvisoryItemSchema.safeParse({
        label:            r.label.trim(),
        category:         r.category,
        confidence_score: r.confidence_score,
        evidence:         r.evidence,
        source_type:      'llm_inference' as const,
        display_only:     true            as const,
      });
      return p.success ? p.data : null;
    };

    // Parser chaque section
    const businessRaw  = raw.business_interests.map(mapItem).filter((x): x is AdvisoryItem => x !== null);
    const technicalRaw = raw.technical_interests.map(mapItem).filter((x): x is AdvisoryItem => x !== null);

    // Exclusions avec filtre naif
    const exclusionsAll = raw.exclusions.map(mapItem).filter((x): x is AdvisoryItem => x !== null);
    const { kept: exclusionsKept, filtered: exclusionsFiltered } = filterNaiveItems(exclusionsAll);
    if (exclusionsFiltered.length > 0) {
      warnings.push({
        code:    'naive_exclusions_filtered',
        message: `${exclusionsFiltered.length} exclusion(s) naive(s) filtree(s) (<3 mots): ` +
                 exclusionsFiltered.map((e) => `"${e.label}"`).join(', '),
      });
    }

    const orgsRaw = raw.organizations.map(mapItem).filter((x): x is AdvisoryItem => x !== null);
    const questionsRaw = raw.questions
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0);

    // Tronquer aux limites
    let business   = businessRaw;
    let technical  = technicalRaw;
    let exclusions = exclusionsKept;
    let orgs       = orgsRaw;
    let questions  = questionsRaw;
    let truncated  = false;

    if (business.length   > MAX_BUSINESS_INTERESTS)  { business   = business.slice(0, MAX_BUSINESS_INTERESTS);   truncated = true; }
    if (technical.length  > MAX_TECHNICAL_INTERESTS)  { technical  = technical.slice(0, MAX_TECHNICAL_INTERESTS);  truncated = true; }
    if (exclusions.length > MAX_EXCLUSIONS)            { exclusions = exclusions.slice(0, MAX_EXCLUSIONS);           truncated = true; }
    if (orgs.length       > MAX_ORGANIZATIONS)         { orgs       = orgs.slice(0, MAX_ORGANIZATIONS);             truncated = true; }
    if (questions.length  > MAX_QUESTIONS)             { questions  = questions.slice(0, MAX_QUESTIONS);             truncated = true; }

    if (truncated) {
      warnings.push({
        code:    'output_truncated',
        message: 'Un ou plusieurs champs ont ete tronques aux limites configurees ' +
                 `(business:${MAX_BUSINESS_INTERESTS} tech:${MAX_TECHNICAL_INTERESTS} ` +
                 `excl:${MAX_EXCLUSIONS} orgs:${MAX_ORGANIZATIONS} quest:${MAX_QUESTIONS})`,
      });
    }

    // Aucune suggestion
    const total = business.length + technical.length + exclusions.length + orgs.length + questions.length;
    if (total === 0) {
      warnings.push({ code: 'no_suggestions', message: 'Aucune suggestion generee par le LLM' });
    }

    // Construire le candidat
    const candidate = {
      client_id:                     input.client_id,
      suggested_business_interests:  business,
      suggested_technical_interests: technical,
      suggested_exclusions:          exclusions,
      suggested_organizations:       orgs,
      suggested_questions_to_ask:    questions,
      confidence_score:              computeOverallConfidence(business, technical, exclusions, orgs),
      evidence:                      buildEvidence(business.length, technical.length, exclusions.length, orgs.length, questions.length),
      source_type:                   'llm' as const,
      created_at:                    new Date().toISOString(),
      model:                         llmModel,
      task_type:                     'onboarding_advice' as const,
    };

    const validated = AdvisoryOutputSchema.safeParse(candidate);
    if (!validated.success) {
      return {
        ok:    false,
        error: {
          code:    'validation_error',
          message: `Validation AdvisoryOutput echouee: ${validated.error.message}`,
        },
      };
    }

    const output = validated.data;

    // Stocker en cache (non fatal)
    try {
      this.cache.set(cacheKey, JSON.stringify(output), {
        model:     this.model,
        task_type: 'onboarding_advice',
        tags:      [`client_id:${input.client_id}`],
      });
    } catch {
      warnings.push({ code: 'cache_store_failed', message: 'Impossible de stocker le resultat en cache (non fatal)' });
    }

    this.log({
      level:     warnings.length > 0 ? 'warn' : 'info',
      event:     'advisor_success',
      client_id: input.client_id,
      model:     this.model,
      cache_hit: false,
      warnings:  warnings.map((w) => w.code),
    });

    return { ok: true, output, warnings };
  }

  private log(entry: AdvisorLogEntry): void {
    this.logger(entry);
  }
}

// --- Fonctions pures exportees -----------------------------------------------

/**
 * Construit le prompt pour l onboarding advisor.
 * Demande 5 sections structurees en JSON.
 */
export function buildAdvisorPrompt(input: AdvisoryInput): string {
  const answersStr = Object.entries(input.onboarding_answers)
    .map(([k, v]) => `  - ${k}: ${v}`)
    .join('\n');

  return (
    'Tu es un expert en marches publics algeriens.\n' +
    'Analyse ce profil client et genere des suggestions onboarding.\n\n' +
    'Profil client :\n' +
    `  description: "${input.client_description.slice(0, 300)}"\n` +
    `  domaine d activite: "${input.activity_domain}"\n` +
    (answersStr.length > 0 ? `  reponses connues:\n${answersStr}\n` : '') +
    '\n' +
    'Reponds en JSON uniquement :\n' +
    '{\n' +
    '  "business_interests":  [{ "label": "...", "category": "...", "confidence_score": 0.0, "evidence": "..." }],\n' +
    '  "technical_interests": [{ "label": "...", "category": "...", "confidence_score": 0.0, "evidence": "..." }],\n' +
    '  "exclusions":          [{ "label": "...", "category": "...", "confidence_score": 0.0, "evidence": "..." }],\n' +
    '  "organizations":       [{ "label": "...", "category": "...", "confidence_score": 0.0, "evidence": "..." }],\n' +
    '  "questions":           ["..."]\n' +
    '}\n\n' +
    'Regles STRICTES :\n' +
    '- business_interests : centres d interet metier (max ' + String(MAX_BUSINESS_INTERESTS) + ')\n' +
    '- technical_interests : angles techniques (max ' + String(MAX_TECHNICAL_INTERESTS) + ')\n' +
    '- exclusions : OBLIGATOIREMENT contextuelles, >= 3 mots\n' +
    '  INTERDIT : "achat" seul, "fourniture" seule, "materiel" seul\n' +
    '  AUTORISE : "achat simple sans maintenance", "fourniture seule sans pose"\n' +
    '- organizations : types ou noms d organismes pertinents (max ' + String(MAX_ORGANIZATIONS) + ')\n' +
    '- questions : courtes, utiles, orientees metier (max ' + String(MAX_QUESTIONS) + ')\n' +
    '  ex: "Faites-vous uniquement la maintenance ou aussi l installation ?"\n' +
    '  ex: "Souhaitez-vous recevoir les BC de fournitures seules ?"\n' +
    'Ne retourne rien en dehors du JSON.'
  );
}

/**
 * Construit le contenu normalise pour la cle de cache.
 * Basee sur client_id + description + activite + reponses triees.
 */
export function buildAdvisorCacheContent(input: AdvisoryInput): string {
  const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const answersStr = Object.entries(input.onboarding_answers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${normalize(v)}`)
    .join('|');
  const raw = [
    input.client_id,
    normalize(input.client_description),
    normalize(input.activity_domain),
    answersStr,
  ].join('||');
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Filtre les items dont le label est < 3 mots (trop lexicaux).
 * Identique au filtre naif des autres modules.
 */
export function filterNaiveItems(items: AdvisoryItem[]): {
  kept:     AdvisoryItem[];
  filtered: AdvisoryItem[];
} {
  const kept:     AdvisoryItem[] = [];
  const filtered: AdvisoryItem[] = [];
  for (const item of items) {
    if (item.label.trim().split(/\s+/).length >= 3) {
      kept.push(item);
    } else {
      filtered.push(item);
    }
  }
  return { kept, filtered };
}

// --- Helpers internes --------------------------------------------------------

function computeOverallConfidence(
  business:   AdvisoryItem[],
  technical:  AdvisoryItem[],
  exclusions: AdvisoryItem[],
  orgs:       AdvisoryItem[],
): number {
  const all = [...business, ...technical, ...exclusions, ...orgs];
  if (all.length === 0) return 0;
  const sum = all.reduce((acc, item) => acc + item.confidence_score, 0);
  return Math.round((sum / all.length) * 100) / 100;
}

function buildEvidence(
  bLen: number, tLen: number, eLen: number, oLen: number, qLen: number,
): string {
  return (
    `${bLen} interet(s) metier, ${tLen} interet(s) technique(s), ` +
    `${eLen} exclusion(s), ${oLen} organisme(s), ${qLen} question(s).`
  );
}

function defaultAdvisorLogger(entry: AdvisorLogEntry): void {
  if (entry.level === 'error') {
    console.error(`[OnboardingAdvisor] ${entry.event}`, entry);
  } else if (entry.level === 'warn') {
    console.warn(`[OnboardingAdvisor] ${entry.event}`, entry);
  }
}

// --- Factory -----------------------------------------------------------------

export function createOnboardingAdvisor(
  llmClient: ILLMClient,
  cache:     ICache,
  model:     string,
  logger?:   (entry: AdvisorLogEntry) => void,
): OnboardingAdvisor {
  const opts: OnboardingAdvisorOptions = logger !== undefined
    ? { model, logger }
    : { model };
  return new OnboardingAdvisor(llmClient, cache, opts);
}
