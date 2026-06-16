/**
 * dynamic-profile-ai.runtime.js
 *
 * Formulaire profil client guidé par IA pour l'onboarding Radar BC.
 *
 * CONTRAINTES :
 *  - Aucune écriture Supabase.
 *  - Aucune activation automatique de critère.
 *  - Aucune modification du scan / quality gate.
 *  - Optionnel : ONBOARDING_AI_PROVIDER=disabled → { ok:false, error:'AI_NOT_CONFIGURED' }
 *  - Timeout 15s + fallback propre.
 *  - Testabilité via options._caller / options._provider.
 *
 * Fonctions exportées :
 *  - generateProfileQuestions(input, options)   → questions dynamiques
 *  - finalizeProfileFromAnswers(input, options) → critères candidats
 */

'use strict';

const AI_TIMEOUT_MS = 15000;

// ─── Prompts ──────────────────────────────────────────────────────────────────

// Prompt commun (base)
const SYSTEM_PROMPT_QUESTIONS_BASE = `Tu es un expert en marchés publics marocains.
On te décrit l'activité d'un client qui souhaite surveiller les appels d'offres publics.
Ton rôle est de générer des questions ciblées pour préciser son profil métier.

RÈGLES ABSOLUES :
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après.
- Pas de markdown, pas de bloc code, pas d'explication.
- detected_business : nom court du métier détecté (max 5 mots).
- confidence : "low" | "medium" | "high" selon la clarté de la description.
- questions : tableau de 4 à 6 questions pertinentes et spécifiques au métier.
- Chaque question a : id (snake_case), label (français), type, required, options (si applicable), help (optionnel).
- Types valides : "multi_select", "single_select", "text", "textarea".
- options obligatoire pour multi_select et single_select (3 à 6 choix).

Structure JSON attendue :
{
  "detected_business": "...",
  "confidence": "medium",
  "questions": [
    {
      "id": "question_id",
      "label": "Libellé de la question ?",
      "type": "multi_select",
      "required": true,
      "options": ["option 1", "option 2", "option 3"],
      "help": "Explication facultative"
    }
  ]
}`;

// Prompt structuré BC (Bons de Commande) — profil enrichi 13 champs
const SYSTEM_PROMPT_STRUCTURED_BC = `Tu es un expert en veille des bons de commande publics marocains (BC).
On te décrit l'activité d'un client. Analyse cette activité et retourne un profil structuré JSON.

RÈGLES ABSOLUES :
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après.
- Pas de markdown, pas de bloc code, pas d'explication.
- detected_business : nom court du métier détecté (max 5 mots).
- confidence : "low" | "medium" | "high".
- structured_profile : objet avec les champs ci-dessous. Chaque champ = tableau de chaînes.
- rationale : 1-2 phrases de stratégie.

RÈGLE FONDAMENTALE — CRITÈRES vs SIGNAUX :
- produits_services_a_capter = FAMILLES D'ACHATS (ex: "Matériel informatique", "Équipements réseau").
  NE PAS y mettre d'accessoires individuels comme "câble HDMI", "adaptateur USB-C", "câble RJ45".
  Ces accessoires vont dans optionnels_variantes.
- coeur_metier = grands axes métier (ex: "Fourniture de matériel informatique").
- optionnels_variantes = accessoires, consommables, variantes, normes opérationnelles.
  Ces éléments sont des SIGNAUX SECONDAIRES, pas des critères principaux.
  Ils vont dans les inclusions suggérées, pas dans les critères de veille.
- synonymes_metier, termes_ambigus, contextes_validants, contextes_bloquants, normes_marques_modeles
  sont des SIGNAUX D'AFFINEMENT. Ils ne deviennent PAS des critères principaux autonomes.

RÈGLE MARQUES ET RÉFÉRENCES (OBLIGATOIRE) :
- Toute marque, fabricant, modèle ou référence technique EXPLICITEMENT cité dans la description
  DOIT être extrait dans normes_marques_modeles. Ne JAMAIS les placer dans coeur_metier,
  produits_services_a_capter ou optionnels_variantes — uniquement dans normes_marques_modeles.
- Si le client cite "HP, Dell, Lenovo, Cisco" → tous doivent apparaître dans normes_marques_modeles.
- Ces marques servent de signaux secondaires / boost uniquement.

RÈGLES SUR LES EXCLUSIONS :
- exclusions_strictes_proches : REPRENDRE OBLIGATOIREMENT toutes les exclusions proches du métier
  explicitement mentionnées par le client dans sa description.
  Exemples proches : "câbles électriques bâtiment", "travaux électriques", "formation non informatique".
  Inclure aussi les confusions fréquentes déduites du métier.
- NE PAS générer automatiquement dans exclusions_strictes_proches :
  restauration, gardiennage, nettoyage, hébergement — sauf mention explicite.
- Si le client mentionne explicitement des exclusions génériques (restauration, gardiennage, etc.),
  les placer dans exclusions_generiques_utilisateur, PAS dans exclusions_strictes_proches.

RÈGLES SUR LES CHAMPS SECONDAIRES (ne pas laisser vides) :
- termes_ambigus : mots qui, seuls, peuvent correspondre à plusieurs métiers
  (ex pour informatique: "câble", "réseau", "maintenance", "installation", "accessoires").
- contextes_validants : mots ou contextes qui confirment la pertinence
  (ex pour informatique: "informatique", "ordinateur", "poste de travail", "réseau informatique").
- contextes_bloquants : contextes rendant un match hors périmètre
  (ex pour informatique: "électricité bâtiment", "câblage électrique", "travaux électriques").
- synonymes_metier : groupes de synonymes séparés par " / "
  (ex: "ordinateur / PC / poste de travail", "imprimante / multifonction").
- normes_marques_modeles : marques, fabricants, modèles et normes techniques cités dans la description.
  RÈGLE CRITIQUE : Toute marque ou fabricant EXPLICITEMENT cité DOIT apparaître ici.
  (ex: "HP", "Dell", "Lenovo", "Cisco" si cités ; "ISO 9001", "RJ45", "Cat6" si présents).

RÈGLES ANTI-HALLUCINATION :
- Ne pas inventer de marques, normes, modèles ou acheteurs publics précis sauf si clairement dans la description.
- Ne pas gonfler artificiellement les listes.
- Ne pas répéter le même item sous différentes formes dans le même tableau.

TAILLES RECOMMANDÉES :
- coeur_metier : 3-6 items
- produits_services_a_capter : 8-15 items (FAMILLES, pas accessoires)
- optionnels_variantes : 5-20 items (accessoires, variantes, consommables)
- exclusions_strictes_proches : 5-12 items (REPRENDRE celles citées + confusions fréquentes)
- exclusions_generiques_utilisateur : 0-6 items (uniquement si mention explicite)
- termes_ambigus : 3-8 items (OBLIGATOIRE si métier a des termes polysémiques)
- contextes_validants : 5-12 items (OBLIGATOIRE)
- contextes_bloquants : 5-12 items (OBLIGATOIRE)
- synonymes_metier : 5-15 items groupes (OBLIGATOIRE)
- normes_marques_modeles : 0-20 items (TOUTES les marques et normes explicitement citées)
- zones_detectees : uniquement régions citées explicitement, sinon []
- acheteurs_publics_preferes : 0-5 items
- acheteurs_publics_exclus : 0-3 items

STRUCTURE JSON ATTENDUE :
{
  "detected_business": "nom court du métier",
  "confidence": "high",
  "structured_profile": {
    "coeur_metier": ["grand axe métier 1", "grand axe métier 2"],
    "produits_services_a_capter": ["famille d'achat 1", "famille d'achat 2"],
    "optionnels_variantes": ["accessoire ou variante 1", "consommable 2"],
    "exclusions_strictes_proches": ["exclusion proche citée 1", "confusion fréquente 2"],
    "exclusions_generiques_utilisateur": [],
    "termes_ambigus": ["terme ambigu 1", "terme ambigu 2"],
    "contextes_validants": ["contexte qui confirme la pertinence 1"],
    "contextes_bloquants": ["contexte rendant le match hors périmètre 1"],
    "synonymes_metier": ["synonyme A / synonyme B", "synonyme C / synonyme D"],
    "normes_marques_modeles": ["norme ou format technique si présent"],
    "zones_detectees": ["région officielle marocaine si citée"],
    "acheteurs_publics_preferes": [],
    "acheteurs_publics_exclus": []
  },
  "rationale": "Explication courte."
}

RÉGIONS OFFICIELLES MAROCAINES : Tanger-Tétouan-Al Hoceïma, Oriental, Fès-Meknès,
Rabat-Salé-Kénitra, Béni Mellal-Khénifra, Casablanca-Settat, Marrakech-Safi,
Drâa-Tafilalet, Souss-Massa, Guelmim-Oued Noun, Laâyoune-Sakia El Hamra, Dakhla-Oued Ed-Dahab.

INTERDICTIONS ABSOLUES — ne jamais inclure dans aucun tableau :
- budget, prix, montant, coût, tarif, seuil financier
- taille de l'entreprise, PME, TPE, grande entreprise
- chiffre d'affaires, capacité financière`;

// Conserver l'ancien nom comme alias pour compatibilité exports
// Conserver l'ancien nom comme alias pour compatibilité exports
const SYSTEM_PROMPT_QUESTIONS_BC = SYSTEM_PROMPT_STRUCTURED_BC;

// Prompt spécifique MP (Marchés Publics)
const SYSTEM_PROMPT_QUESTIONS_MP = `Tu es un expert en marchés publics marocains (MP).
On te décrit l'activité d'un client qui souhaite surveiller les marchés publics.
Ton rôle est de générer des questions ciblées pour préciser son profil métier.

RÈGLES ABSOLUES :
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après.
- Pas de markdown, pas de bloc code, pas d'explication.
- detected_business : nom court du métier détecté (max 5 mots).
- confidence : "low" | "medium" | "high" selon la clarté de la description.
- questions : tableau de 4 à 6 questions pertinentes et spécifiques au métier.
- Chaque question a : id (snake_case), label (français), type, required, options (si applicable), help (optionnel).
- Types valides : "multi_select", "single_select", "text", "textarea".
- options obligatoire pour multi_select et single_select (3 à 6 choix).
- Les questions doivent couvrir : domaines d'activité, prestations, zones géographiques,
  segments de marché, et éventuellement taille des marchés ciblés.

Structure JSON attendue :
{
  "detected_business": "...",
  "confidence": "medium",
  "questions": [
    {
      "id": "question_id",
      "label": "Libellé de la question ?",
      "type": "multi_select",
      "required": true,
      "options": ["option 1", "option 2", "option 3"],
      "help": "Explication facultative"
    }
  ]
}`;

// Alias pour compatibilité exports
const SYSTEM_PROMPT_QUESTIONS = SYSTEM_PROMPT_QUESTIONS_BASE;

const SYSTEM_PROMPT_FINALIZE = `Tu es un expert en marchés publics marocains (Bons de Commande et Marchés Publics).
Tu reçois le profil complet d'un client : sa description métier et ses réponses à un questionnaire de qualification.
Ton rôle est de produire des critères de veille d'appels d'offres précis et actionnables.

RÈGLES ABSOLUES :
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après.
- Pas de markdown, pas de bloc code, pas d'explication.
- business_summary : résumé du profil en 1-2 phrases.
- suggested_criteria : critères de veille précis, en français, max 5 mots chacun (5-12 items).
- suggested_inclusions : mots-clés qualifiants à inclure (5-10 items).
- suggested_exclusions : formulations à exclure pour éviter les faux positifs (3-6 items).
- clarification_questions : questions restantes pour affiner (0-3 items).
- rationale : explication courte de la stratégie de critères (1-2 phrases).

RÈGLE CRITIQUE — CRITÈRES vs INCLUSIONS :
- suggested_criteria : UNIQUEMENT des familles d'achats ou grands axes métier.
  Sources : coeur_metier et produits_services_a_capter.
  NE PAS y mettre des accessoires, normes techniques, synonymes ou variantes individuelles.
  Exemples corrects : "Matériel informatique", "Équipements réseau", "Maintenance informatique".
  Exemples INCORRECTS : "câble HDMI", "adaptateur USB-C", "RJ45", "câble réseau".
- suggested_inclusions : mots-clés qualifiants, accessoires, variantes, synonymes.
  Sources : optionnels_variantes, synonymes_metier, normes_marques_modeles.
  C'est ici que vont les items précis comme "câble HDMI", "RJ45", "USB-C".

Structure JSON attendue :
{
  "business_summary": "...",
  "suggested_criteria": ["...", "..."],
  "suggested_inclusions": ["...", "..."],
  "suggested_exclusions": ["...", "..."],
  "clarification_questions": ["...", "..."],
  "rationale": "..."
}`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildQuestionsPrompt(input) {
  const lines = [
    `Client : ${input.client_name || 'Non précisé'}`,
    `Type de radar : ${input.radar_type || 'bc'}`,
    `Description de l'activité : ${input.business_description}`,
  ];
  return lines.join('\n');
}

/**
 * Sélectionne le bon prompt système selon radar_type.
 */
function selectQuestionsSystemPrompt(radarType) {
  if (radarType === 'mp') return SYSTEM_PROMPT_QUESTIONS_MP;
  return SYSTEM_PROMPT_QUESTIONS_BC; // défaut = bc
}

function buildFinalizePrompt(input) {
  const lines = [
    `Client : ${input.client_name || 'Non précisé'}`,
    `Type de radar : ${input.radar_type || 'bc'}`,
    `Description de l'activité : ${input.business_description}`,
    ``,
    `Réponses au questionnaire :`,
  ];
  const answers = input.answers || {};
  for (const key of Object.keys(answers)) {
    const val = answers[key];
    const display = Array.isArray(val) ? val.join(', ') : String(val);
    lines.push(`  ${key} : ${display}`);
  }
  return lines.join('\n');
}

// ─── Validators ───────────────────────────────────────────────────────────────

const VALID_QUESTION_TYPES = new Set(['multi_select', 'single_select', 'text', 'textarea', 'number']);
const VALID_CONFIDENCE      = new Set(['low', 'medium', 'high']);
const FINALIZE_ARRAYS       = ['suggested_criteria', 'suggested_inclusions', 'suggested_exclusions', 'clarification_questions'];

// Champs du profil structuré BC — nouvelle structure enrichie 13 champs
const STRUCTURED_PROFILE_FIELDS = [
  'coeur_metier',
  'produits_services_a_capter',
  'optionnels_variantes',
  'exclusions_strictes_proches',
  'exclusions_generiques_utilisateur',
  'termes_ambigus',
  'contextes_validants',
  'contextes_bloquants',
  'synonymes_metier',
  'normes_marques_modeles',
  'zones_detectees',
  'acheteurs_publics_preferes',
  'acheteurs_publics_exclus',
];

// Champs de l'ancienne structure (pour compatibilité) — mappés vers la nouvelle
const STRUCTURED_PROFILE_FIELDS_LEGACY = [
  'domaines_activite', 'prestations_recherchees', 'exclusions_metier',
  'mots_cles_importants', 'mots_cles_a_eviter',
];

// Liste complète des régions marocaines (pour zones bloc frontend)
const MOROCCAN_ZONES_FULL = [
  'Tout Maroc', 'Tanger-Tétouan-Al Hoceïma', 'Oriental', 'Fès-Meknès',
  'Rabat-Salé-Kénitra', 'Béni Mellal-Khénifra', 'Casablanca-Settat',
  'Marrakech-Safi', 'Drâa-Tafilalet', 'Souss-Massa', 'Guelmim-Oued Noun',
  'Laâyoune-Sakia El Hamra', 'Dakhla-Oued Ed-Dahab', 'Autre',
];

// Termes interdits dans les questions BC (label + options)
const BC_BANNED_TERMS = [
  'budget', 'prix', 'montant', 'coût', 'cout', 'tarif', 'seuil financier',
  'taille', 'petit', 'moyen', 'grand', 'grande entreprise',
  'pme', 'tpe', 'startup', 'start-up',
  "chiffre d\'affaires", "chiffre d'affaires", 'capacité financière',
  'marché cible', 'seuil minimum', 'prêts à répondre', 'prets a repondre',
];

/**
 * Sanitisation déterministe des questions pour radar_type="bc".
 * - Supprime les questions dont le label ou options contiennent un terme interdit
 * - Convertit les questions zones single_select → multi_select avec options standard
 * - Garantit une question zones multi_select
 * - Limite à 6 questions
 */
function sanitizeBCQuestions(questions) {
  const bannedRe = new RegExp(BC_BANNED_TERMS.map(function(t) {
    return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|'), 'i');

  const ZONES_OPTIONS = [
    'Tout Maroc', 'Rabat-Salé-Kénitra', 'Casablanca-Settat',
    'Tanger-Tétouan-Al Hoceima', 'Fès-Meknès', 'Marrakech-Safi',
    'Souss-Massa', 'Autre',
  ];

  // Filter banned
  let filtered = questions.filter(function(q) {
    const labelBanned = bannedRe.test(q.label || '');
    const optsBanned  = (q.options || []).some(function(o) { return bannedRe.test(o); });
    return !labelBanned && !optsBanned;
  });

  // Convert zones single_select → multi_select with standard options
  filtered = filtered.map(function(q) {
    if (q.id === 'zones' && q.type === 'single_select') {
      return Object.assign({}, q, { type: 'multi_select', options: ZONES_OPTIONS });
    }
    return q;
  });

  // Ensure a zones multi_select question exists
  const hasZones = filtered.some(function(q) { return q.id === 'zones'; });
  if (!hasZones) {
    filtered.push({
      id:       'zones',
      label:    'Quelles zones géographiques vous intéressent ?',
      type:     'multi_select',
      required: true,
      options:  ZONES_OPTIONS,
    });
  }

  // Limit to 6 questions
  return filtered.slice(0, 6);
}

/**
 * Sanitisation des clarification_questions pour radar_type="bc".
 * Supprime toute question mentionnant budget/taille/PME/financier.
 */
function sanitizeBCClarifications(clarifications) {
  if (!Array.isArray(clarifications)) return [];
  const bannedRe = new RegExp([
    'budget', 'taille', 'pme', 'tpe', 'financi', 'montant', 'prix', 'petit', 'moyen', 'grand',
  ].join('|'), 'i');
  return clarifications.filter(function(q) { return !bannedRe.test(q); });
}

function parseQuestionsResponse(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Réponse IA non-objet');

  const detected_business = (typeof raw.detected_business === 'string' && raw.detected_business.trim())
    ? raw.detected_business.trim()
    : 'Activité non identifiée';

  const confidence = VALID_CONFIDENCE.has(raw.confidence) ? raw.confidence : 'low';

  const questions = [];
  if (Array.isArray(raw.questions)) {
    for (const q of raw.questions) {
      if (!q || typeof q !== 'object') continue;
      if (!q.id || !q.label || !VALID_QUESTION_TYPES.has(q.type)) continue;
      const question = {
        id:       String(q.id).replace(/[^a-z0-9_]/gi, '_').slice(0, 50),
        label:    String(q.label).trim().slice(0, 200),
        type:     q.type,
        required: q.required !== false,
      };
      if (q.type === 'multi_select' || q.type === 'single_select') {
        question.options = Array.isArray(q.options)
          ? q.options.filter(function(o) { return typeof o === 'string' && o.trim(); }).map(function(o) { return o.trim(); }).slice(0, 8)
          : [];
        if (question.options.length === 0) continue; // skip malformed selects
      }
      if (typeof q.help === 'string' && q.help.trim()) {
        question.help = q.help.trim().slice(0, 300);
      }
      questions.push(question);
    }
  }

  return { detected_business, confidence, questions };
}

function parseFinalizeResponse(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Réponse IA non-objet');

  const result = {};

  result.business_summary = (typeof raw.business_summary === 'string' && raw.business_summary.trim())
    ? raw.business_summary.trim()
    : 'Profil client à préciser.';

  for (const key of FINALIZE_ARRAYS) {
    const val = raw[key];
    if (!Array.isArray(val)) {
      result[key] = [];
    } else {
      result[key] = val
        .filter(function(v) { return typeof v === 'string' && v.trim().length > 0; })
        .map(function(v) { return v.trim(); })
        .slice(0, 15);
    }
  }

  result.rationale = (typeof raw.rationale === 'string' && raw.rationale.trim())
    ? raw.rationale.trim()
    : 'Critères générés à partir du profil fourni.';

  return result;
}

// ─── Parser profil structuré BC ─────────────────────────────────────────────

/**
 * Normalise un item qui peut être une chaîne ou un objet enrichi { label, importance, ... }.
 */
function normalizeProfileItem(v) {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && typeof v.label === 'string') return v.label.trim();
  return '';
}

/**
 * Parse et valide la réponse IA pour le mode profil structuré BC.
 * Retourne { detected_business, confidence, structured_profile, rationale }
 *
 * Résilience :
 *  - structured_profile imbriqué (canonique) ou flat (Ollama)
 *  - champs nouveaux (coeur_metier, ...) et anciens (domaines_activite, ...)
 *  - items sous forme string ou objet { label, importance, source, reason }
 *  - ancienne structure questions[] (très ancien format)
 */
function parseStructuredProfileResponse(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Réponse IA non-objet');

  const detected_business = (typeof raw.detected_business === 'string' && raw.detected_business.trim())
    ? raw.detected_business.trim()
    : 'Activité non identifiée';

  const confidence = VALID_CONFIDENCE.has(raw.confidence) ? raw.confidence : 'low';

  const rationale = (typeof raw.rationale === 'string' && raw.rationale.trim())
    ? raw.rationale.trim().slice(0, 400)
    : '';

  // Résolution de la source : structured_profile imbriqué (canonique) ou flat (Ollama)
  const sp = (raw.structured_profile && typeof raw.structured_profile === 'object' && !Array.isArray(raw.structured_profile))
    ? raw.structured_profile
    : raw;

  // Aliases nouveaux champs → anciens et variantes LLM
  const FIELD_ALIASES = {
    coeur_metier:                    ['coeur_metier', 'core_business', 'main_activity', 'domaines_activite', 'domaines', 'domains', 'activities', 'secteurs', 'sectors'],
    produits_services_a_capter:      ['produits_services_a_capter', 'products', 'target_products', 'prestations_recherchees', 'prestations', 'services', 'missions', 'offres'],
    optionnels_variantes:            ['optionnels_variantes', 'optional_keywords', 'variants', 'accessories', 'mots_cles_importants', 'mots_cles', 'keywords', 'tags', 'key_terms'],
    exclusions_strictes_proches:     ['exclusions_strictes_proches', 'near_miss_exclusions', 'close_exclusions', 'exclusions_metier', 'exclusions', 'avoid', 'hors_perimetre'],
    exclusions_generiques_utilisateur: ['exclusions_generiques_utilisateur', 'generic_user_exclusions', 'generic_exclusions', 'mots_cles_a_eviter', 'exclusions_mots', 'avoid_keywords', 'negative_keywords'],
    termes_ambigus:                  ['termes_ambigus', 'ambiguous_terms', 'ambiguous'],
    contextes_validants:             ['contextes_validants', 'validating_contexts', 'validation_contexts', 'positive_contexts'],
    contextes_bloquants:             ['contextes_bloquants', 'blocking_contexts', 'negative_contexts'],
    synonymes_metier:                ['synonymes_metier', 'business_synonyms', 'synonyms'],
    normes_marques_modeles:          ['normes_marques_modeles', 'standards_brands_models', 'normes', 'standards', 'brands',
                                      'marques', 'fabricants', 'modeles', 'references', 'manufacturers', 'models', 'brand', 'brand_names'],
    zones_detectees:                 ['zones_detectees', 'zones', 'regions', 'geographie', 'geography'],
    acheteurs_publics_preferes:      ['acheteurs_publics_preferes', 'acheteurs_preferes', 'acheteurs', 'buyers', 'clients_preferes'],
    acheteurs_publics_exclus:        ['acheteurs_publics_exclus', 'acheteurs_exclus', 'excluded_buyers', 'clients_exclus'],
  };

  const structured_profile = {};

  for (const field of STRUCTURED_PROFILE_FIELDS) {
    let rawItems = null;
    // 1. Aliases dans sp (flat ou imbriqué)
    for (const alias of (FIELD_ALIASES[field] || [field])) {
      if (Array.isArray(sp[alias]) && sp[alias].length > 0) { rawItems = sp[alias]; break; }
    }
    // 2. Aliases dans raw si sp ≠ raw (format nested canonique)
    if (!rawItems && sp !== raw) {
      for (const alias of (FIELD_ALIASES[field] || [field])) {
        if (Array.isArray(raw[alias]) && raw[alias].length > 0) { rawItems = raw[alias]; break; }
      }
    }
    // 3. Fallback très ancien format questions[]
    if (!rawItems && Array.isArray(raw.questions)) {
      const targetId = field === 'zones_detectees' ? 'zones' : field;
      const q = raw.questions.find(function(q) { return q.id === targetId || q.id === field; });
      if (q && Array.isArray(q.options)) rawItems = q.options;
    }
    structured_profile[field] = rawItems
      ? rawItems
          .map(normalizeProfileItem)
          .filter(function(v) { return v.length > 0; })
          .map(function(v) { return v.slice(0, 100); })
          .slice(0, 25)
      : [];
  }

  // Nettoyage bannedTerms sur champs sensibles uniquement
  const bannedRe = new RegExp(BC_BANNED_TERMS.map(function(t) {
    return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|'), 'i');

  const BANNED_FILTER_FIELDS = ['coeur_metier', 'produits_services_a_capter', 'optionnels_variantes',
    'exclusions_strictes_proches', 'exclusions_generiques_utilisateur'];
  for (const field of BANNED_FILTER_FIELDS) {
    structured_profile[field] = structured_profile[field].filter(function(v) {
      return !bannedRe.test(v);
    });
  }

  // Rétrocompatibilité : exposer aussi les anciennes clés pointant vers les nouvelles valeurs
  structured_profile.domaines_activite        = structured_profile.coeur_metier;
  structured_profile.prestations_recherchees  = structured_profile.produits_services_a_capter;
  structured_profile.mots_cles_importants     = structured_profile.optionnels_variantes;
  structured_profile.exclusions_metier        = structured_profile.exclusions_strictes_proches;
  structured_profile.mots_cles_a_eviter       = structured_profile.exclusions_generiques_utilisateur;

  return { detected_business, confidence, structured_profile, rationale };
}

// ─── Fallback déterministe marques ───────────────────────────────────────────

/**
 * Extrait les marques, fabricants, modèles et normes explicitement cités dans
 * la description utilisateur via détection de motifs linguistiques, et les
 * injecte dans structured_profile.normes_marques_modeles si absents.
 *
 * Générique — ne présuppose aucun secteur d'activité particulier.
 * Ne touche pas aux autres champs (coeur_metier, produits_services_a_capter, etc.).
 *
 * @param {object} structured_profile  — profil à enrichir en place
 * @param {string} businessDescription — description libre saisie par le client
 */
function applyBrandFallback(structured_profile, businessDescription) {
  if (!businessDescription || typeof businessDescription !== 'string') return;
  if (!structured_profile || typeof structured_profile !== 'object') return;

  var existing = new Set(
    (structured_profile.normes_marques_modeles || []).map(function(v) {
      return (typeof v === 'string' ? v : '').toLowerCase();
    })
  );

  // Mots courants français à ne pas confondre avec des marques
  var STOP_WORDS = new Set([
    'nous', 'vous', 'ils', 'elle', 'notre', 'votre', 'leur', 'leurs',
    'avec', 'dans', 'pour', 'par', 'sur', 'sous', 'entre', 'vers',
    'aussi', 'mais', 'donc', 'ainsi', 'tout', 'toute', 'tous', 'toutes',
    'autres', 'autre', 'plusieurs', 'certain', 'certains', 'certaines',
    'des', 'les', 'une', 'son', 'ses', 'mon', 'mes', 'ces', 'cet', 'cette',
    'qui', 'que', 'quoi', 'dont', 'comme', 'notamment', 'tel', 'tels',
    'telle', 'telles', 'type', 'types', 'marque', 'marques', 'reference',
    'references', 'fabricant', 'fabricants', 'modele', 'modeles',
    'norme', 'normes', 'standard', 'standards', 'produit', 'produits',
    'equipement', 'equipements', 'incluant', 'dont', 'ainsi', 'notamment',
  ]);

  // Retourne true si le token ressemble à une marque / norme / modèle
  function isBrandLike(token) {
    if (!token || token.length < 2 || token.length > 50) return false;
    var words = token.split(/\s+/);
    if (words.length > 3) return false;
    var first = words[0];
    if (!first) return false;
    if (STOP_WORDS.has(token.toLowerCase())) return false;
    if (STOP_WORDS.has(first.toLowerCase())) return false;
    // Doit commencer par une majuscule ou être un code technique (RJ45, Cat6, TP-Link)
    var startsUpper = /^[A-Z]/.test(first);
    var isCode      = /^[A-Z0-9][-A-Z0-9]*$/.test(first);   // HP, APC, RJ45
    var hasTechForm = /[A-Za-z][0-9]|[A-Z][a-z]+-[A-Z]/.test(first); // Cat6, TP-Link
    return startsUpper || isCode || hasTechForm;
  }

  // Extrait les tokens de marques depuis un segment de texte post-trigger.
  // Pour chaque token (après split virgule/et/ou), ne garde que les mots initiaux
  // en majuscule, s'arrêtant dès qu'un mot commence par une minuscule.
  // Ex: "ABB dans nos installations" → "ABB" ; "TP-Link" → "TP-Link".
  function extractBrandsFromSegment(text) {
    var limit   = text.search(/[.;]/);
    var segment = limit >= 0 ? text.slice(0, limit) : text.slice(0, 300);
    return segment
      .split(/,|\s+et\s+|\s+ou\s+/)
      .map(function(tok) {
        var words = tok.trim().replace(/[.!?;:()\[\]]+$/g, '').trim().split(/\s+/);
        var keep = [];
        for (var i = 0; i < Math.min(words.length, 3); i++) {
          var w = words[i].replace(/[.!?;:]+$/g, '');
          if (!w) break;
          // Stopper dès qu'un mot (autre que le 1er) commence par une minuscule
          if (i > 0 && /^[a-z]/.test(w)) break;
          keep.push(w);
        }
        return keep.join(' ');
      })
      .filter(isBrandLike);
  }

  // Regex: "[catégorie] [et autre-cat] comme/tels que/: [liste]"
  // Ex: "marques et références comme HP, Dell"
  // Ex: "fabricants tels que Bosch, Schneider"
  var CATEGORY = 'marques?|r\\u00e9f\\u00e9rences?|references?|fabricants?|mod\\u00e8les?|modeles?|normes?|standards?|produits?|\\u00e9quipements?|equipements?';
  var TRIGGER  = 'comme|tels?\\s+que|incluant|dont|:';
  var PATTERN  = new RegExp(
    '(?:' + CATEGORY + ')\\s+(?:et\\s+[^\\s,]+\\s+)?' +
    '(?:' + TRIGGER + ')\\s*',
    'gi'
  );

  var desc = businessDescription;
  PATTERN.lastIndex = 0;
  var m;
  var candidates = new Set();
  while ((m = PATTERN.exec(desc)) !== null) {
    var rest  = desc.slice(m.index + m[0].length);
    var found = extractBrandsFromSegment(rest);
    found.forEach(function(b) { candidates.add(b); });
    PATTERN.lastIndex = m.index + m[0].length;
  }

  var toAdd = [];
  candidates.forEach(function(c) {
    if (!existing.has(c.toLowerCase())) toAdd.push(c);
  });

  if (toAdd.length > 0) {
    structured_profile.normes_marques_modeles =
      (structured_profile.normes_marques_modeles || []).concat(toAdd).slice(0, 25);
  }
}

// ─── JSON extraction helper ──────────────────────────────────────────────────

/**
 * Extrait et parse le premier objet JSON d'une chaîne de texte.
 * Lève une erreur AI_INVALID_JSON si aucun JSON valide trouvé.
 */
function extractJSON(text) {
  if (!text || typeof text !== 'string') throw Object.assign(new Error('Réponse vide'), { code: 'AI_INVALID_JSON' });
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw Object.assign(new Error('Aucun JSON dans la réponse: ' + text.slice(0, 80)), { code: 'AI_INVALID_JSON' });
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    throw Object.assign(new Error('JSON invalide: ' + e.message), { code: 'AI_INVALID_JSON' });
  }
}

// ─── Caller Anthropic ─────────────────────────────────────────────────────────

async function anthropicCaller(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY absent');

  let fetchFn;
  try { fetchFn = fetch; } catch (_) { fetchFn = require('node-fetch'); }

  const timeoutMs  = AI_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, timeoutMs);

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
        max_tokens:  900,
        temperature: 0.2,
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
    return extractJSON(text);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Caller Local (Ollama / OpenAI-compatible) ────────────────────────────────

/**
 * Caller pour provider local.
 *
 * Supporte deux modes selon LOCAL_AI_API_STYLE :
 *   "ollama"  (défaut) → POST /api/chat  (format Ollama)
 *   "openai"           → POST /v1/chat/completions (format OpenAI-compatible)
 *
 * Variables d'environnement :
 *   LOCAL_AI_BASE_URL    (défaut: http://localhost:11434)
 *   LOCAL_AI_MODEL       (défaut: llama3)
 *   LOCAL_AI_TIMEOUT_MS  (défaut: 20000)
 *   LOCAL_AI_API_STYLE   (défaut: ollama)
 */
async function localCaller(systemPrompt, userPrompt) {
  const baseUrl    = (process.env.LOCAL_AI_BASE_URL    || 'http://localhost:11434').replace(/\/$/, '');
  const model      = process.env.LOCAL_AI_MODEL        || 'llama3';
  const timeoutMs  = parseInt(process.env.LOCAL_AI_TIMEOUT_MS || '20000', 10);
  const apiStyle   = (process.env.LOCAL_AI_API_STYLE   || 'ollama').toLowerCase();

  let fetchFn;
  try { fetchFn = fetch; } catch (_) { fetchFn = require('node-fetch'); }

  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, timeoutMs);

  // Combine system prompt + user prompt in the messages array
  // Both Ollama /api/chat and OpenAI /v1/chat/completions accept the same messages format
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: userPrompt   },
  ];

  try {
    let url, bodyObj;

    if (apiStyle === 'openai') {
      // OpenAI-compatible endpoint (LM Studio, llama.cpp server, etc.)
      url     = baseUrl + '/v1/chat/completions';
      bodyObj = {
        model:       model,
        messages:    messages,
        temperature: 0.2,
        max_tokens:  900,
      };
    } else {
      // Ollama /api/chat (stream:false for single response)
      url     = baseUrl + '/api/chat';
      bodyObj = {
        model:    model,
        messages: messages,
        stream:   false,
        options:  { temperature: 0.2, num_predict: 900 },
      };
    }

    const res = await fetchFn(url, {
      method:  'POST',
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(bodyObj),
    });

    if (!res.ok) {
      const txt = await res.text().catch(function() { return String(res.status); });
      throw new Error('HTTP ' + res.status + ' (' + url + '): ' + txt.slice(0, 120));
    }

    const data = await res.json();

    // Extract text from response
    let text = '';
    if (apiStyle === 'openai') {
      // OpenAI format: data.choices[0].message.content
      text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    } else {
      // Ollama format: data.message.content
      text = (data.message && data.message.content) || '';
    }

    if (!text) throw new Error('Réponse locale vide (modèle: ' + model + ')');
    return extractJSON(text);

  } finally {
    clearTimeout(timer);
  }
}

// ─── Provider / error helpers ─────────────────────────────────────────────────

const PROVIDERS = new Set(['anthropic', 'local', 'ollama']);

function resolveProvider(options) {
  return (options && options._provider) || process.env.ONBOARDING_AI_PROVIDER || 'disabled';
}

function resolveCaller(provider, options) {
  // Explicit test-injected caller always wins
  if (options && options._caller) return options._caller;
  if (provider === 'anthropic')           return anthropicCaller;
  if (provider === 'local' || provider === 'ollama') return localCaller;
  return anthropicCaller; // unreachable after provider guard, but safe
}

function handleCallError(e) {
  const msg = String(e.message || e);
  if (e.code === 'AI_INVALID_JSON')                    return { ok: false, error: 'AI_INVALID_JSON', detail: msg.slice(0, 200) };
  if (msg.includes('ANTHROPIC_API_KEY'))               return { ok: false, error: 'AI_NOT_CONFIGURED' };
  if (e.name === 'AbortError' || msg.includes('abort')) return { ok: false, error: 'AI_TIMEOUT' };
  return { ok: false, error: 'AI_ERROR', detail: msg.slice(0, 200) };
}

// ─── Fonctions principales ────────────────────────────────────────────────────

/**
 * Étape 1 — génère des questions ciblées à partir de la description métier.
 *
 * @param {object} input
 * @param {string}  input.client_name
 * @param {string}  [input.radar_type]  "bc" | "mp"
 * @param {string}  input.business_description
 * @param {object}  [options]
 * @param {string}  [options._provider]
 * @param {Function}[options._caller]
 */
async function generateProfileQuestions(input, options) {
  if (!input || !input.business_description || !input.business_description.trim()) {
    return { ok: false, error: 'INVALID_INPUT' };
  }

  const provider = resolveProvider(options);
  if (provider === 'disabled') return { ok: false, error: 'AI_NOT_CONFIGURED' };
  if (!PROVIDERS.has(provider)) return { ok: false, error: 'UNKNOWN_PROVIDER:' + provider };

  const radarType = (input.radar_type || 'bc').toLowerCase();
  const caller    = resolveCaller(provider, options);

  // BC → mode profil structuré (8 blocs fixes)
  if (radarType === 'bc') {
    try {
      const raw  = await caller(SYSTEM_PROMPT_STRUCTURED_BC, buildQuestionsPrompt(input));
      const data = parseStructuredProfileResponse(raw);
      // Fallback déterministe : complète normes_marques_modeles avec les marques
      // explicitement citées dans la description si le LLM les a oubliées.
      applyBrandFallback(data.structured_profile, input.business_description);
      return { ok: true, data: Object.assign({ is_structured: true }, data) };
    } catch (e) {
      return handleCallError(e);
    }
  }

  // MP → mode questions libres (inchangé)
  const systemPrompt = selectQuestionsSystemPrompt(radarType);
  try {
    const raw  = await caller(systemPrompt, buildQuestionsPrompt(input));
    const data = parseQuestionsResponse(raw);
    return { ok: true, data };
  } catch (e) {
    return handleCallError(e);
  }
}

/**
 * Étape 2 — produit les critères candidats à partir des réponses au questionnaire.
 *
 * @param {object} input
 * @param {string}  input.client_name
 * @param {string}  [input.radar_type]
 * @param {string}  input.business_description
 * @param {object}  input.answers  clé=question_id, valeur=réponse
 * @param {object}  [options]
 */
async function finalizeProfileFromAnswers(input, options) {
  if (!input || !input.business_description || !input.business_description.trim()) {
    return { ok: false, error: 'INVALID_INPUT' };
  }
  if (!input.answers || typeof input.answers !== 'object') {
    return { ok: false, error: 'INVALID_INPUT' };
  }

  const provider = resolveProvider(options);
  if (provider === 'disabled') return { ok: false, error: 'AI_NOT_CONFIGURED' };
  if (!PROVIDERS.has(provider)) return { ok: false, error: 'UNKNOWN_PROVIDER:' + provider };

  const radarType = (input.radar_type || 'bc').toLowerCase();
  const caller = resolveCaller(provider, options);

  try {
    const raw  = await caller(SYSTEM_PROMPT_FINALIZE, buildFinalizePrompt(input));
    const data = parseFinalizeResponse(raw);
    // Apply BC-specific sanitization on clarification_questions
    if (radarType === 'bc') {
      data.clarification_questions = sanitizeBCClarifications(data.clarification_questions);
    }
    return { ok: true, data };
  } catch (e) {
    return handleCallError(e);
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  generateProfileQuestions,
  finalizeProfileFromAnswers,
  // Exposés pour tests
  _buildQuestionsPrompt:              buildQuestionsPrompt,
  _buildFinalizePrompt:               buildFinalizePrompt,
  _parseQuestionsResponse:            parseQuestionsResponse,
  _parseStructuredProfileResponse:    parseStructuredProfileResponse,
  _parseFinalizeResponse:             parseFinalizeResponse,
  _SYSTEM_PROMPT_QUESTIONS:           SYSTEM_PROMPT_QUESTIONS,
  _SYSTEM_PROMPT_QUESTIONS_BC:        SYSTEM_PROMPT_QUESTIONS_BC,
  _SYSTEM_PROMPT_STRUCTURED_BC:       SYSTEM_PROMPT_STRUCTURED_BC,
  _SYSTEM_PROMPT_QUESTIONS_MP:        SYSTEM_PROMPT_QUESTIONS_MP,
  _SYSTEM_PROMPT_FINALIZE:            SYSTEM_PROMPT_FINALIZE,
  _FINALIZE_ARRAYS:                   FINALIZE_ARRAYS,
  _STRUCTURED_PROFILE_FIELDS:         STRUCTURED_PROFILE_FIELDS,
  _MOROCCAN_ZONES_FULL:               MOROCCAN_ZONES_FULL,
  _extractJSON:                       extractJSON,
  _sanitizeBCQuestions:               sanitizeBCQuestions,
  _sanitizeBCClarifications:          sanitizeBCClarifications,
  _BC_BANNED_TERMS:                   BC_BANNED_TERMS,
  _applyBrandFallback:                applyBrandFallback,
};
