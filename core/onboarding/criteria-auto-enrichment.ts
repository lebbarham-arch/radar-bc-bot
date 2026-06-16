/**
 * criteria-auto-enrichment.ts
 *
 * Enrichit automatiquement un critère brut en :
 *  - normalisant son label,
 *  - évaluant son activabilité (canActivateCriterion),
 *  - proposant des variantes précises, des inclusions et des exclusions métier.
 *
 * CONTRAINTES :
 *  - Aucun appel IA, aucune écriture DB.
 *  - Aucune règle spécifique à un client_id.
 *  - Ne modifie pas radar-bc-bot.js.
 */

import {
  validateCritereLabel,
  canActivateCriterion,
  type ActivationResult,
} from './criteria-label-guard';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActivationStatus = 'active' | 'needs_review' | 'needs_clarification';

export interface RawCriterion {
  valeur:             string;
  ai_inclusions?:     string[];
  manual_inclusions?: string[];
}

export interface EnrichedCriterion {
  /** Critère tel que fourni par l'opérateur */
  raw_criterion:             RawCriterion;
  /** Label normalisé (lowercase, sans diacritiques superflus) */
  normalized_criterion:      string;
  /** Résultat complet de canActivateCriterion */
  activation:                ActivationResult;
  /** Statut simplifié pour le workflow */
  activation_status:         ActivationStatus;
  /** Variantes précises suggérées à la place du label générique */
  suggested_precise_criteria: string[];
  /** Termes d'inclusion suggérés pour affiner le matching */
  suggested_inclusions:       string[];
  /** Termes d'exclusion suggérés pour éviter les faux positifs */
  suggested_exclusions:       string[];
  /** Raison courte résumant la décision */
  reason:                    string;
  /** true si le terme est dans la banque locale de suggestions */
  known_suggestion_bank:     boolean;
  /**
   * true si le critère est vague ET n'a pas de banque locale —
   * doit passer par enrichissement IA ou revue humaine.
   */
  needs_ai_enrichment:       boolean;
}

// ─── Base de suggestions par terme générique ─────────────────────────────────
//
// Chaque entrée couvre le terme normalisé (sans accent).
// La clé est cherchée par startsWith sur le label normalisé.

interface SuggestionBank {
  precise:    string[];
  inclusions: string[];
  exclusions: string[];
}

// Les clés spécifiques (ex: 'maintenance informatique') sont recherchées
// en priorité sur les familles génériques grâce au tri par longueur décroissante.
const SUGGESTION_BANK: Record<string, SuggestionBank> = {
  // ── Sous-types spécifiques maintenance (lookup prioritaire) ─────────────
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
  // ── Familles génériques ──────────────────────────────────────────────────
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
const _sortedBankKeys = Object.keys(SUGGESTION_BANK).sort((a, b) => b.length - a.length);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeCriterion(valeur: string): string {
  return valeur
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
}

function lookupSuggestions(normalized: string): SuggestionBank {
  // Clés longues en premier : les sous-types spécifiques prennent la priorité
  // sur les familles génériques (ex: 'maintenance informatique' > 'maintenance').
  for (const key of _sortedBankKeys) {
    if (normalized === key || normalized.startsWith(key + ' ') || normalized.startsWith(key + 's')) {
      return SUGGESTION_BANK[key]!;
    }
  }
  return { precise: [], inclusions: [], exclusions: [] };
}

function statusFromActivation(activation: ActivationResult): ActivationStatus {
  if (activation.allowed) return 'active';
  if (activation.level === 'block') return 'needs_clarification';
  return 'needs_review';
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Enrichit un critère brut avec suggestions de précision, d'inclusions et
 * d'exclusions, et détermine son statut d'activation.
 *
 * @param rawCriterion  Critère tel que soumis par l'opérateur / l'IA d'onboarding
 * @returns             EnrichedCriterion complet
 */
export function enrichCriterion(rawCriterion: RawCriterion): EnrichedCriterion {
  const normalized = normalizeCriterion(rawCriterion.valeur);
  const activation = canActivateCriterion(rawCriterion);
  const status     = statusFromActivation(activation);
  const bank              = lookupSuggestions(normalized);
  const known_suggestion_bank = (
    bank.precise.length > 0 ||
    bank.inclusions.length > 0 ||
    bank.exclusions.length > 0
  );
  const needs_ai_enrichment = (
    (status === 'needs_review' || status === 'needs_clarification') &&
    !known_suggestion_bank
  );

  // Suggestions de précision : pertinentes surtout pour block/warn
  const suggested_precise_criteria =
    status !== 'active' ? bank.precise : [];

  // Suggestions d'inclusions : toujours utiles (complément des inclusions existantes)
  const existingInclusions = new Set([
    ...(rawCriterion.ai_inclusions     ?? []).map(normalizeCriterion),
    ...(rawCriterion.manual_inclusions ?? []).map(normalizeCriterion),
  ]);
  const suggested_inclusions = bank.inclusions.filter(
    inc => !existingInclusions.has(normalizeCriterion(inc))
  );

  // Exclusions suggérées systématiquement
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
