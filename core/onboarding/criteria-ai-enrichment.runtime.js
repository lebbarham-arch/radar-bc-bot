/**
 * criteria-ai-enrichment.runtime.js
 *
 * Enrichissement IA optionnel pour les critères ambigus ou inconnus
 * de la banque locale (needs_ai_enrichment = true).
 *
 * CONTRAINTES :
 *  - Aucune écriture Supabase.
 *  - Aucune activation automatique de critère.
 *  - Aucune modification du scan / quality gate.
 *  - Optionnel : si ONBOARDING_AI_PROVIDER=disabled ou clé absente,
 *    retourne { ok: false, error: 'AI_NOT_CONFIGURED' }.
 *  - Timeout 15 s + fallback propre sur erreur JSON.
 *
 * Providers supportés :
 *   ONBOARDING_AI_PROVIDER=anthropic  → Claude via API Anthropic
 *   ONBOARDING_AI_PROVIDER=disabled   → mode local uniquement (défaut)
 *
 * Testabilité :
 *   enrichCriterionWithAI(input, { _caller }) permet d'injecter un mock
 *   du caller HTTP sans modifier process.env.
 */

'use strict';

const AI_TIMEOUT_MS = 15000;

// ─── Prompt ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es un expert en marchés publics marocains (Bons de Commande et Marchés Publics).
On te soumet un critère de veille d'appels d'offres qui est trop vague pour être activé tel quel.
Ton rôle est de proposer des affinements concrets et contextuels.

RÈGLES ABSOLUES :
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après.
- Pas de markdown, pas de bloc code, pas d'explication.
- Les suggestions doivent être en français, courtes (max 5 mots par item).
- suggested_precise_criteria : variantes précises du critère (2-5 items).
- suggested_inclusions : mots-clés métier qui qualifient le besoin (3-6 items).
- suggested_exclusions : formulations contextuelles à exclure, liées au risque de confusion propre à ce critère (2-4 items).
- clarification_questions : questions à poser au client pour préciser (1-3 items).
- rationale : explication courte (1 phrase) de pourquoi ce critère est vague.

Structure JSON attendue (respecter exactement) :
{
  "suggested_precise_criteria": ["...", "..."],
  "suggested_inclusions": ["...", "..."],
  "suggested_exclusions": ["...", "..."],
  "clarification_questions": ["...", "..."],
  "rationale": "..."
}`;

function buildUserPrompt(input) {
  const lines = [
    `Critère à analyser : "${input.criterion}"`,
    `Type de radar : ${input.radar_type || 'bc'}`,
  ];
  if (input.client_context) {
    lines.push(`Contexte client : ${input.client_context}`);
  }
  return lines.join('\n');
}

// ─── Validation de la sortie ──────────────────────────────────────────────────

const EXPECTED_ARRAYS = [
  'suggested_precise_criteria',
  'suggested_inclusions',
  'suggested_exclusions',
  'clarification_questions',
];

/**
 * Valide et normalise la sortie JSON de l'IA.
 * Retourne un objet propre ou lève une erreur.
 */
function parseAndValidateAIResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Réponse IA non-objet');
  }

  const result = {};

  for (const key of EXPECTED_ARRAYS) {
    const val = raw[key];
    if (!Array.isArray(val)) {
      result[key] = [];
    } else {
      result[key] = val
        .filter(function(v) { return typeof v === 'string' && v.trim().length > 0; })
        .map(function(v) { return v.trim(); })
        .slice(0, 8); // borne max
    }
  }

  result.rationale = (typeof raw.rationale === 'string' && raw.rationale.trim())
    ? raw.rationale.trim()
    : 'Critère trop générique — précision requise.';

  return result;
}

// ─── Callers ──────────────────────────────────────────────────────────────────

/**
 * Caller Anthropic (Claude Haiku).
 * Injecté par défaut ; remplaçable dans les tests via options._caller.
 */
async function anthropicCaller(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY absent');

  // Support des environnements sans fetch global (Node < 18 → node-fetch)
  let fetchFn;
  try { fetchFn = fetch; } catch (_) { fetchFn = require('node-fetch'); }

  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, AI_TIMEOUT_MS);

  try {
    const res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:       'claude-haiku-4-5-20251001',
        max_tokens:  600,
        temperature: 0.1,
        system:      systemPrompt,
        messages:    [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(function() { return String(res.status); });
      throw new Error('HTTP ' + res.status + ': ' + txt.slice(0, 120));
    }

    const data = await res.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';

    // Extraire le JSON de la réponse (l'IA peut ajouter du texte parasite)
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Aucun JSON dans la réponse: ' + text.slice(0, 80));

    return JSON.parse(match[0]);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Enrichit un critère via IA.
 *
 * @param {object} input
 * @param {string}  input.criterion      Libellé brut du critère
 * @param {string}  [input.radar_type]   "bc" | "mp" (défaut "bc")
 * @param {string}  [input.client_context] Contexte libre optionnel
 *
 * @param {object} [options]
 * @param {string}  [options._provider]  Surcharge du provider (tests)
 * @param {Function}[options._caller]    Surcharge du caller HTTP (tests)
 *
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>}
 */
async function enrichCriterionWithAI(input, options) {
  options = options || {};

  if (!input || !input.criterion || !input.criterion.trim()) {
    return { ok: false, error: 'INVALID_INPUT' };
  }

  const provider = options._provider
    || process.env.ONBOARDING_AI_PROVIDER
    || 'disabled';

  if (provider === 'disabled') {
    return { ok: false, error: 'AI_NOT_CONFIGURED' };
  }

  if (provider !== 'anthropic') {
    return { ok: false, error: 'UNKNOWN_PROVIDER:' + provider };
  }

  const caller = options._caller || anthropicCaller;

  const userPrompt = buildUserPrompt(input);

  try {
    const raw = await caller(SYSTEM_PROMPT, userPrompt);
    const data = parseAndValidateAIResponse(raw);
    return { ok: true, data };
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes('ANTHROPIC_API_KEY')) {
      return { ok: false, error: 'AI_NOT_CONFIGURED' };
    }
    if (e.name === 'AbortError' || msg.includes('abort')) {
      return { ok: false, error: 'AI_TIMEOUT' };
    }
    return { ok: false, error: 'AI_ERROR', detail: msg.slice(0, 200) };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  enrichCriterionWithAI,
  // Exposés pour tests unitaires
  _buildUserPrompt:          buildUserPrompt,
  _parseAndValidateAIResponse: parseAndValidateAIResponse,
  _SYSTEM_PROMPT:            SYSTEM_PROMPT,
  _EXPECTED_ARRAYS:          EXPECTED_ARRAYS,
};
