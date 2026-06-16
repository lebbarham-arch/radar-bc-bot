/**
 * ONB-2 — Enrichissement IA contrôlé des critères L3
 *
 * Ce module enrichit les critères L3 proposés avec des suggestions IA.
 * Il respecte les règles absolues suivantes :
 *
 * INTERDIT à l'IA :
 *   - Modifier L1, L2, base_keywords, radar_type, domain_category
 *   - Rendre un critère active=true
 *   - Persister quoi que ce soit en base
 *   - Générer des exclusions lexicales brutes
 *
 * AUTORISÉ à l'IA :
 *   - Enrichir ai_inclusions_initial (suggestions uniquement)
 *   - Enrichir ai_exclusions_initial (contextuelles uniquement)
 *   - Proposer suggested_variants, suggested_positive_terms, suggested_negative_contexts
 *   - Générer review_notes pour l'admin
 *
 * Toute suggestion IA reste dans ai_suggestions (couche séparée).
 * Les champs originaux du critère sont JAMAIS mutés.
 */

import { type ILLMClient }            from '../ai/llm-client';
import { type LLMRequest }            from '../ai/schemas/llm-client.schema';
import { MAX_LLM_PROMPT_CHARS }       from '../ai/constants';

import {
  type GeneratedCriteriaSet,
} from './l3-criteria.schema';

import { type ReviewableCriteriaSet } from './l3-review.schema';

import {
  type AIEnrichedCriteriaSet,
  type AIEnrichedCritere,
  type AISuggestionForCritere,
  type LLMEnrichmentResponse,
  safeParseLLMEnrichResponse,
  AISuggestionForCritereSchema,
} from './criteria-ai-enricher.schema';

// ─── Mots exclusions brutes interdits ────────────────────────────────────────

/**
 * Mots isolés interdits comme exclusion IA.
 * Une exclusion IA valide DOIT être contextuelle (≥ 3 mots ou formulation qualifiée).
 */
const FORBIDDEN_BARE_EXCLUSION_WORDS = new Set([
  'maintenance', 'achat', 'acquisition', 'fourniture', 'installation',
  'formation', 'travaux', 'réparation', 'nettoyage', 'gardiennage',
  'audit', 'conseil', 'études', 'informatique', 'réseau', 'matériel',
]);

const MIN_CONTEXTUAL_EXCLUSION_WORDS = 3;

/**
 * Valide qu'une exclusion est contextuelle (jamais lexicale brute).
 * Retourne true si l'exclusion est acceptable.
 */
export function validateExclusionSafe(exclusion: string): boolean {
  const trimmed = exclusion.trim().toLowerCase();
  const words   = trimmed.split(/\s+/);

  // Trop courte → lexicale brute
  if (words.length < MIN_CONTEXTUAL_EXCLUSION_WORDS) return false;

  // Mot seul interdit
  if (words.length === 1 && FORBIDDEN_BARE_EXCLUSION_WORDS.has(words[0] ?? '')) return false;

  return true;
}

// ─── Construction du prompt ───────────────────────────────────────────────────

export function buildEnrichmentPrompt(
  critere: { label: string; domain_category: string; base_keywords: string[]; ai_inclusions_initial: string[]; ai_exclusions_initial: string[]; prestations_recherchees: string[]; prestations_exclues: string[]; precision_mode: string },
): string {
  const context = [
    `Critère : ${critere.label}`,
    `Domaine métier : ${critere.domain_category}`,
    `Mots-clés de base : ${critere.base_keywords.slice(0, 8).join(', ')}`,
    `Inclusions actuelles : ${critere.ai_inclusions_initial.slice(0, 6).join(', ') || 'aucune'}`,
    `Exclusions actuelles : ${critere.ai_exclusions_initial.slice(0, 4).join(', ') || 'aucune'}`,
    `Prestations cherchées : ${critere.prestations_recherchees.join(', ') || 'non précisées'}`,
    `Prestations exclues : ${critere.prestations_exclues.join(', ') || 'aucune'}`,
    `Mode précision : ${critere.precision_mode}`,
  ].join('\n');

  const instruction = `Tu es un expert en marchés publics marocains (bons de commande BC).
Enrichis ce critère de surveillance des marchés avec des suggestions pertinentes.

Contexte du critère :
${context}

Réponds UNIQUEMENT avec un objet JSON valide (pas de markdown, pas d'explication) :
{
  "suggested_inclusions": ["terme1", "terme2", ...],
  "suggested_exclusions": ["exclusion contextuelle longue 1", ...],
  "suggested_variants": ["variante1", ...],
  "suggested_positive_terms": ["terme positif1", ...],
  "suggested_negative_contexts": ["contexte négatif1", ...],
  "review_notes": "Note pour l'admin...",
  "confidence": 0.8
}

RÈGLES ABSOLUES :
- suggested_exclusions : TOUJOURS contextuelles, JAMAIS un seul mot (ex: "maintenance" seul est INTERDIT)
- Chaque exclusion doit avoir au moins 4 mots et expliquer le contexte (ex: "maintenance seule sans fourniture de matériel")
- suggested_inclusions : variantes, synonymes, spécifications techniques du domaine
- suggested_variants : autres formulations du même besoin
- confidence : entre 0.0 et 1.0
- review_notes : observation utile pour l'admin humain qui va valider`;

  return instruction.slice(0, MAX_LLM_PROMPT_CHARS);
}

// ─── Enrichissement d'un critère ─────────────────────────────────────────────

async function enrichOneCritere(
  critere: {
    id: string;
    label: string;
    domain_category: string;
    base_keywords: string[];
    ai_inclusions_initial: string[];
    ai_exclusions_initial: string[];
    prestations_recherchees: string[];
    prestations_exclues: string[];
    precision_mode: string;
  },
  llmClient: ILLMClient,
  model: string,
): Promise<AISuggestionForCritere> {
  const prompt = buildEnrichmentPrompt(critere);

  const req: LLMRequest = {
    prompt,
    model,
    task_type:   'onboarding_advice',
    response_format: 'json',
    temperature: 0.3,
    max_tokens:  800,
  };

  const llmResult = await llmClient.call(req);

  // Fallback propre si LLM indisponible
  if (!llmResult.ok) {
    return AISuggestionForCritereSchema.parse({
      critere_id:                critere.id,
      enrichment_status:         'fallback',
      warnings:                  [`LLM indisponible : ${llmResult.error.message}`],
    });
  }

  // Parser le JSON brut de la réponse LLM
  const rawText = llmResult.value.content.trim();
  let parsedJson: unknown;
  try {
    // Extraire le JSON si encapsulé dans du markdown
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    parsedJson = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(rawText);
  } catch {
    return AISuggestionForCritereSchema.parse({
      critere_id:        critere.id,
      enrichment_status: 'error',
      warnings:          ['Réponse LLM invalide — JSON non parsable.'],
    });
  }

  // Valider avec Zod
  const validated = safeParseLLMEnrichResponse(parsedJson);
  if (!validated.success) {
    return AISuggestionForCritereSchema.parse({
      critere_id:        critere.id,
      enrichment_status: 'error',
      warnings:          [`Réponse LLM invalide — schéma Zod : ${validated.error.message}`],
    });
  }

  const raw: LLMEnrichmentResponse = validated.data;
  const warnings: string[] = [];

  // Filtrer les exclusions lexicales brutes
  const safeExclusions = raw.suggested_exclusions.filter(ex => {
    const safe = validateExclusionSafe(ex);
    if (!safe) warnings.push(`Exclusion IA rejetée (lexicale brute) : "${ex}"`);
    return safe;
  });

  return AISuggestionForCritereSchema.parse({
    critere_id:                  critere.id,
    suggested_inclusions:        raw.suggested_inclusions,
    suggested_exclusions:        safeExclusions,
    suggested_variants:          raw.suggested_variants,
    suggested_positive_terms:    raw.suggested_positive_terms,
    suggested_negative_contexts: raw.suggested_negative_contexts,
    review_notes:                raw.review_notes,
    confidence:                  raw.confidence,
    enrichment_status:           'enriched',
    warnings,
  });
}

// ─── Options de l'enrichisseur ────────────────────────────────────────────────

export interface CriteriaAIEnricherOptions {
  /** Client LLM injectable (mock en tests, LLMClient en prod) */
  llmClient: ILLMClient;
  /** Modèle à utiliser */
  model?: string;
}

// ─── Input union ─────────────────────────────────────────────────────────────

type EnrichableInput = GeneratedCriteriaSet | ReviewableCriteriaSet;

function extractCriteria(input: EnrichableInput) {
  return input.criteria;
}

function extractClientId(input: EnrichableInput): string {
  return (input as ReviewableCriteriaSet).client_id ?? '';
}

// ─── Enrichisseur principal ───────────────────────────────────────────────────

/**
 * Enrichit un jeu de critères L3 avec des suggestions IA.
 *
 * - Ne modifie jamais les champs originaux des critères
 * - Toutes les suggestions sont dans ai_suggestions (pending_validation)
 * - Fallback propre si LLM indisponible
 * - Jamais de throw non contrôlé
 *
 * @param input    GeneratedCriteriaSet ou ReviewableCriteriaSet
 * @param options  Client LLM + modèle
 * @returns        AIEnrichedCriteriaSet
 */
export async function enrichCriteriaWithAI(
  input: EnrichableInput,
  options: CriteriaAIEnricherOptions,
): Promise<AIEnrichedCriteriaSet> {
  const model    = options.model ?? 'unknown';
  const criteria = extractCriteria(input);
  const clientId = extractClientId(input);

  const globalWarnings: string[] = [];
  const enrichedCriteria: AIEnrichedCritere[] = [];

  for (const critere of criteria) {
    // Extraire les champs nécessaires — compatible ProposedCritere et ReviewableCritere
    const base = {
      id:                      critere.id,
      label:                   critere.label,
      domain_category:         critere.domain_category,
      base_keywords:           critere.base_keywords,
      ai_inclusions_initial:   critere.ai_inclusions_initial,
      ai_exclusions_initial:   critere.ai_exclusions_initial,
      prestations_recherchees: critere.prestations_recherchees,
      prestations_exclues:     critere.prestations_exclues,
      precision_mode:          critere.precision_mode,
    };

    let suggestions: AISuggestionForCritere;
    try {
      suggestions = await enrichOneCritere(base, options.llmClient, model);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      suggestions = {
        critere_id:                base.id,
        suggested_inclusions:      [],
        suggested_exclusions:      [],
        suggested_variants:        [],
        suggested_positive_terms:  [],
        suggested_negative_contexts: [],
        review_notes:              '',
        confidence:                0,
        enrichment_status:         'error',
        warnings:                  [`Erreur inattendue : ${msg}`],
      };
      globalWarnings.push(`Erreur enrichissement critère ${base.id} : ${msg}`);
    }

    // Construire le critère enrichi — champs originaux INCHANGÉS
    const enriched: AIEnrichedCritere = {
      // Champs originaux préservés
      id:                        critere.id,
      label:                     critere.label,
      radar_type:                critere.radar_type,
      domain_category:           critere.domain_category,
      base_keywords:             [...critere.base_keywords],
      ai_inclusions_initial:     [...critere.ai_inclusions_initial],
      ai_exclusions_initial:     [...critere.ai_exclusions_initial],
      prestations_recherchees:   [...critere.prestations_recherchees],
      prestations_exclues:       [...critere.prestations_exclues],
      zones_geographiques:       [...(critere.zones_geographiques ?? [])],
      favorite_organizations:    [...(critere.favorite_organizations ?? [])],
      precision_mode:            critere.precision_mode,
      source_trace:              critere.source_trace ?? {},
      requires_human_validation: true  as const,
      active:                    false as const,
      // Suggestions IA — couche séparée
      ai_suggestions:            suggestions,
    };

    enrichedCriteria.push(enriched);
  }

  return {
    client_id:                 clientId,
    source:                    'ai_enrichment',
    enriched_at:               new Date().toISOString(),
    criteria:                  enrichedCriteria,
    warnings:                  globalWarnings,
    enrichment_model:          model,
    requires_human_validation: true  as const,
    active:                    false as const,
  };
}

// ─── Helpers de lecture ───────────────────────────────────────────────────────

/**
 * Retourne les critères pour lesquels l'enrichissement a réussi.
 */
export function getEnrichedCriteria(set: AIEnrichedCriteriaSet) {
  return set.criteria.filter(c => c.ai_suggestions.enrichment_status === 'enriched');
}

/**
 * Retourne les critères en fallback (LLM indisponible).
 */
export function getFallbackCriteria(set: AIEnrichedCriteriaSet) {
  return set.criteria.filter(c => c.ai_suggestions.enrichment_status === 'fallback');
}

/**
 * Retourne les critères en erreur (JSON invalide, etc.).
 */
export function getErrorCriteria(set: AIEnrichedCriteriaSet) {
  return set.criteria.filter(c => c.ai_suggestions.enrichment_status === 'error');
}
