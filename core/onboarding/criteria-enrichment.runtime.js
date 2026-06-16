/**
 * criteria-enrichment.runtime.js
 *
 * Implémentation CommonJS (runtime) de enrichCriterion + enrichCriteriaList.
 * Miroir fidèle de criteria-label-guard.ts + criteria-auto-enrichment.ts.
 *
 * Utilisé par radar-bc-bot.js via require() pour la route
 * POST /api/onboarding/enrich-criteria.
 *
 * CONTRAINTES :
 *   - Aucun appel IA, aucune écriture DB.
 *   - Aucune dépendance externe (pas de zod, pas de node_modules).
 *   - Ne modifie pas radar-bc-bot.js (route seulement en require()).
 */

'use strict';

// ─── Listes de labels ─────────────────────────────────────────────────────────

const BLOCK_LABELS = new Set([
  'eau', 'maintenance', 'materiel', 'matériel',
  'travaux', 'fourniture', 'fournitures',
  'produit', 'produits', 'service', 'services',
  'equipement', 'équipement',
]);

const WARN_LABELS = new Set([
  'informatique', 'cafe', 'café', 'nettoyage',
  'securite', 'sécurité', 'transport', 'formation',
  'consommable', 'consommables', 'cartouche',
  'support', 'filtre', 'cable', 'câble', 'poste',
]);

// ─── Banque de suggestions ────────────────────────────────────────────────────

// ─── Banque de suggestions ────────────────────────────────────────────────────
//
// Les exclusions sont CONTEXTUELLES : elles représentent les risques de confusion
// propres à chaque famille de critère, pas une liste anti-bruit globale.
//
// Les clés spécifiques (ex: 'maintenance informatique') sont recherchées
// en priorité sur les clés génériques (ex: 'maintenance') grâce au tri
// par longueur décroissante dans lookupSuggestions().

const SUGGESTION_BANK = {
  // ── Sous-types spécifiques maintenance (lookup prioritaire) ──────────────
  'maintenance informatique': {
    precise:    [],
    inclusions: ['helpdesk', 'infogérance', 'support technique', 'tierce maintenance applicative'],
    exclusions: ['maintenance bâtiments', 'maintenance véhicules', 'ascenseurs', 'climatisation', 'entretien ménager'],
  },
  'maintenance climatisation': {
    precise:    [],
    inclusions: ['CVC', 'climatisation réversible', 'contrat maintenance CVC', 'maintenance préventive CVC'],
    exclusions: ['maintenance informatique', 'maintenance ascenseurs', 'entretien ménager'],
  },
  'maintenance ascenseurs': {
    precise:    [],
    inclusions: ['ascenseur', 'monte-charge', 'levage', 'entretien ascenseur'],
    exclusions: ['maintenance informatique', 'maintenance climatisation', 'entretien ménager'],
  },
  'maintenance electrique': {
    precise:    [],
    inclusions: ['tableau électrique', 'habilitation électrique', 'vérification installations'],
    exclusions: ['maintenance informatique', 'maintenance climatisation', 'entretien ménager'],
  },
  // ── Familles génériques ───────────────────────────────────────────────────
  eau: {
    precise:    ['eau potable', 'eau industrielle', 'réseau AEP', 'traitement des eaux', 'assainissement'],
    inclusions: ['eau potable', 'adduction', 'forage', 'pompe hydraulique', 'distribution eau', 'citerne'],
    exclusions: ['eau minérale en bouteille', 'fontaine à eau de bureau', 'piscine', 'arrosage jardin', 'espaces verts', 'chauffe-eau domestique'],
  },
  maintenance: {
    precise:    ['maintenance informatique', 'maintenance climatisation', 'maintenance ascenseurs', 'maintenance électrique'],
    inclusions: ['maintenance préventive', 'maintenance corrective', 'contrat maintenance', 'entretien technique'],
    exclusions: ['entretien ménager', 'nettoyage locaux', 'gardiennage', 'maintenance véhicules', 'maintenance bâtiments'],
  },
  cafe: {
    precise:    ['café moulu', 'café en grains', 'capsules café', 'machine à café'],
    inclusions: ['café moulu', 'café en grains', 'capsule', 'dosette', 'boissons chaudes', 'distributeur boissons'],
    exclusions: ['pause café prestation traiteur', 'réception accueil', 'restauration entreprise', 'café touristique'],
  },
  informatique: {
    precise:    ['matériel informatique', 'fourniture informatique', 'infrastructure réseau', 'logiciels bureautique'],
    inclusions: ['serveur', 'ordinateur', 'imprimante', 'switch', 'firewall', 'logiciel', 'datacenter'],
    exclusions: ['mobilier de bureau', 'fournitures de bureau non informatique', 'documentation papier', 'formation non informatique'],
  },
  nettoyage: {
    precise:    ['nettoyage des locaux', 'nettoyage industriel', 'entretien des locaux', 'propreté bâtiments'],
    inclusions: ['nettoyage locaux', 'entretien hygiene', 'désinfection', 'produits entretien'],
    exclusions: ['maintenance technique', 'gardiennage', 'travaux de rénovation'],
  },
  travaux: {
    precise:    ['travaux électriques', 'travaux plomberie', 'travaux étanchéité', 'travaux maçonnerie', 'travaux VRD'],
    inclusions: ['travaux électriques', 'plomberie', 'étanchéité', 'maçonnerie', 'génie civil'],
    exclusions: ['maintenance préventive seule', 'entretien courant sans travaux', 'nettoyage', 'gardiennage'],
  },
  materiel: {
    precise:    ['matériel informatique', 'matériel médical', 'matériel de bureau', 'matériel électrique'],
    inclusions: ['ordinateur', 'imprimante', 'équipement bureau', 'outillage'],
    exclusions: ['service sans fourniture matériel', 'formation seule sans équipement', 'maintenance seule sans pièces'],
  },
  fourniture: {
    precise:    ['fournitures de bureau', 'fournitures informatiques', 'fournitures scolaires', 'fournitures médicales'],
    inclusions: ['papier', 'stylo', 'cartouche', 'toner', 'classeur'],
    exclusions: ['travaux et pose inclus', 'service sans fourniture', 'location sans achat'],
  },
  service: {
    precise:    ['service de gardiennage', 'service de nettoyage', 'service de transport', 'service informatique'],
    inclusions: ['gardiennage', 'surveillance', 'nettoyage locaux', 'transport personnes'],
    exclusions: ['fourniture seule sans prestation', 'achat matériel sans service associé'],
  },
};

// Clés triées par longueur décroissante pour que les sous-types spécifiques
// soient testés avant les familles génériques.
const _sortedBankKeys = Object.keys(SUGGESTION_BANK).sort(function(a, b) { return b.length - a.length; });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeLabel(label) {
  return label
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

function isBareMatch(normalized, term) {
  return (
    normalized === term ||
    normalized === term + 's' ||
    normalized === term + 'es' ||
    normalized === term + 'x'
  );
}

function isSingleToken(normalized) {
  return !normalized.includes(' ');
}

function validateCritereLabel(valeur) {
  if (!valeur || valeur.trim() === '') {
    return { level: 'block', reason: 'Le label est vide.' };
  }
  const normalized = normalizeLabel(valeur);
  if (!isSingleToken(normalized)) return { level: 'ok' };

  for (const term of BLOCK_LABELS) {
    if (isBareMatch(normalized, normalizeLabel(term))) {
      return {
        level: 'block',
        reason: `"${valeur}" est un terme trop générique seul — il matcherait trop de BCs non pertinents.`,
        suggestions: [
          `${valeur} [qualificatif métier]`,
          `Exemple : "${valeur} potable", "${valeur} industrielle"`,
        ],
      };
    }
  }

  for (const term of WARN_LABELS) {
    if (isBareMatch(normalized, normalizeLabel(term))) {
      return {
        level: 'warn',
        reason: `"${valeur}" seul est ambigu et peut générer du bruit — pensez à le qualifier.`,
        suggestions: [
          `${valeur} [qualificatif métier]`,
          `Exemple : "${valeur} moulu", "${valeur} réseau"`,
        ],
      };
    }
  }

  return { level: 'ok' };
}

function canActivateCriterion(input) {
  const guard = validateCritereLabel(input.valeur);

  if (guard.level === 'block') {
    return {
      allowed: false,
      level: 'block',
      reason: guard.reason || `"${input.valeur}" est trop générique.`,
      suggestions: guard.suggestions,
    };
  }

  if (guard.level === 'warn') {
    const allInclusions = [
      ...(input.ai_inclusions     || []),
      ...(input.manual_inclusions || []),
    ];
    const hasStrong = allInclusions.some(function(inc) {
      const n = normalizeLabel(inc);
      if (n.length < 5) return false;
      for (const t of BLOCK_LABELS) { if (isBareMatch(n, normalizeLabel(t))) return false; }
      for (const t of WARN_LABELS)  { if (isBareMatch(n, normalizeLabel(t))) return false; }
      return true;
    });
    if (hasStrong) {
      return { allowed: true, level: 'warn', reason: `"${input.valeur}" est ambigu mais des inclusions métier fortes sont présentes.` };
    }
    return {
      allowed: false,
      level: 'warn',
      reason: guard.reason || `"${input.valeur}" est ambigu — ajoutez des inclusions métier pour l'activer.`,
      suggestions: guard.suggestions,
    };
  }

  return { allowed: true, level: 'ok', reason: `"${input.valeur}" est un critère suffisamment précis.` };
}

function lookupSuggestions(normalized) {
  for (const key of _sortedBankKeys) {
    if (normalized === key || normalized.startsWith(key + ' ') || normalized.startsWith(key + 's')) {
      return SUGGESTION_BANK[key];
    }
  }
  return { precise: [], inclusions: [], exclusions: [] };
}

function statusFromActivation(activation) {
  if (activation.allowed)           return 'active';
  if (activation.level === 'block') return 'needs_clarification';
  return 'needs_review';
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Enrichit un critère brut.
 *
 * @param {object} rawCriterion  { valeur, ai_inclusions?, manual_inclusions? }
 * @returns {object}             EnrichedCriterion
 */
function enrichCriterion(rawCriterion) {
  const normalized  = normalizeLabel(rawCriterion.valeur);
  const activation  = canActivateCriterion(rawCriterion);
  const status      = statusFromActivation(activation);
  const bank        = lookupSuggestions(normalized);

  const known_suggestion_bank = (
    bank.precise.length > 0 ||
    bank.inclusions.length > 0 ||
    bank.exclusions.length > 0
  );

  const needs_ai_enrichment = (
    (status === 'needs_review' || status === 'needs_clarification') &&
    !known_suggestion_bank
  );

  const suggested_precise_criteria = status !== 'active' ? bank.precise : [];

  const existingInclusions = new Set(
    [...(rawCriterion.ai_inclusions     || []),
     ...(rawCriterion.manual_inclusions || [])].map(normalizeLabel)
  );
  const suggested_inclusions = bank.inclusions.filter(
    function(inc) { return !existingInclusions.has(normalizeLabel(inc)); }
  );
  const suggested_exclusions = bank.exclusions;

  return {
    raw_criterion:             rawCriterion,
    normalized_criterion:      normalized,
    activation,
    activation_status:         status,
    suggested_precise_criteria,
    suggested_inclusions,
    suggested_exclusions,
    reason:                    activation.reason,
    known_suggestion_bank,
    needs_ai_enrichment,
  };
}

/**
 * Enrichit une liste de valeurs textuelles et retourne le résultat + résumé.
 *
 * @param {object} opts
 * @param {string}   opts.client_name
 * @param {string}   opts.radar_type
 * @param {string[]} opts.criteria     Tableau de chaînes (libellés bruts)
 * @returns {object}  { client_name, radar_type, summary, criteria }
 */
function enrichCriteriaList(opts) {
  const { client_name = '', radar_type = 'bc', criteria = [] } = opts;

  const enriched = criteria.map(function(valeur) {
    const raw = { valeur: String(valeur).trim() };
    const ec  = enrichCriterion(raw);
    return {
      raw_criterion:             ec.raw_criterion.valeur,
      normalized_criterion:      ec.normalized_criterion,
      activation_status:         ec.activation_status,
      known_suggestion_bank:     ec.known_suggestion_bank,
      needs_ai_enrichment:       ec.needs_ai_enrichment,
      reason:                    ec.reason,
      suggested_precise_criteria: ec.suggested_precise_criteria,
      suggested_inclusions:      ec.suggested_inclusions,
      suggested_exclusions:      ec.suggested_exclusions,
    };
  });

  const summary = {
    active:              0,
    needs_review:        0,
    needs_clarification: 0,
    needs_ai_enrichment: 0,
  };
  for (const c of enriched) {
    if (c.activation_status === 'active')              summary.active++;
    if (c.activation_status === 'needs_review')        summary.needs_review++;
    if (c.activation_status === 'needs_clarification') summary.needs_clarification++;
    if (c.needs_ai_enrichment)                         summary.needs_ai_enrichment++;
  }

  return { client_name, radar_type, summary, criteria: enriched };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  enrichCriterion,
  enrichCriteriaList,
  validateCritereLabel,
  canActivateCriterion,
  normalizeLabel,
  BLOCK_LABELS,
  WARN_LABELS,
};
