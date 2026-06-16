/**
 * ONB-1c — Générateur de Critères Proposés (L2 → L3)
 *
 * Transforme un StructuredBusinessProfile (L2) en GeneratedCriteriaSet (L3).
 *
 * Contraintes absolues :
 *   - 100% déterministe (pas de LLM, pas d'embeddings, pas d'appel réseau)
 *   - Aucune écriture Supabase
 *   - Aucun branchement au moteur de matching
 *   - Pas de mutation de l'entrée L2
 *   - Tous les critères générés ont active: false + requires_human_validation: true
 *   - ai_exclusions_initial = exclusions CONTEXTUELLES uniquement (jamais lexicales)
 *   - radar_type reste "bc" | "mp" — la catégorie métier va dans domain_category
 */

import { type StructuredBusinessProfile } from './l2-profile.schema';
import {
  type GeneratedCriteriaSet,
  type ProposedCritere,
  GeneratedCriteriaSetSchema,
} from './l3-criteria.schema';

// ─── Constantes ────────────────────────────────────────────────────────────────

const GENERATOR_VERSION = '1.0.0';

/**
 * Dictionnaire de catégories métier détectées depuis les secteurs et capacités.
 * Chaque clé = terme déclencheur (lowercase), valeur = domain_category normalisé.
 */
const DOMAIN_KEYWORDS: Record<string, string> = {
  // Informatique / IT
  informatique: 'informatique',
  ordinateur:   'informatique',
  serveur:      'informatique',
  réseau:       'informatique',
  switch:       'informatique',
  routeur:      'informatique',
  laptop:       'informatique',
  portable:     'informatique',
  desktop:      'informatique',
  bureautique:  'informatique',
  logiciel:     'informatique',
  télécommunication: 'informatique',

  // CVC / Climatisation
  cvc:          'cvc',
  climatisation: 'cvc',
  climatiseur:  'cvc',
  chauffage:    'cvc',
  ventilation:  'cvc',
  froid:        'cvc',
  thermique:    'cvc',
  vrv:          'cvc',
  vrf:          'cvc',
  pompe:        'cvc',

  // BTP / Génie civil
  btp:          'btp',
  bâtiment:     'btp',
  construction:  'btp',
  travaux:      'btp',
  génie:        'btp',
  maçonnerie:   'btp',
  étanchéité:   'btp',
  peinture:     'btp',
  électricité:  'btp',
  plomberie:    'btp',

  // Impression / Copie
  impression:   'impression',
  imprimante:   'impression',
  copieur:      'impression',
  reprographie: 'impression',
  toner:        'impression',
  cartouche:    'impression',

  // Mobilier / Fournitures bureau
  mobilier:     'mobilier',
  meuble:       'mobilier',
  chaise:       'mobilier',
  bureau:       'mobilier',
  papeterie:    'mobilier',
  fourniture:   'mobilier',

  // Médical / Para-médical
  médical:      'medical',
  médico:       'medical',
  dentaire:     'medical',
  pharmaceutique: 'medical',
  laborato:     'medical',
  clinique:     'medical',
  hôpital:      'medical',
};

/**
 * Mots vides à exclure lors de la génération de base_keywords.
 */
const KW_STOP_WORDS = new Set([
  'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'ou', 'en',
  'au', 'aux', 'par', 'pour', 'sur', 'avec', 'dans', 'à', 'the', 'of',
  'fourniture', 'installation', 'maintenance', 'acquisition', 'livraison',
]);

// ─── Utilitaires ──────────────────────────────────────────────────────────────

/**
 * Génère un identifiant slug déterministe depuis label + domain.
 */
function toSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Détecte la catégorie métier dominante depuis les secteurs et capacités L2.
 * Retourne "general" si aucune catégorie n'est identifiée.
 */
function detectDomainCategory(
  sectors: readonly string[],
  capabilities: readonly string[],
  mainActivity: string,
): string {
  const scores: Record<string, number> = {};

  const allTexts = [
    ...sectors,
    ...capabilities,
    mainActivity,
  ].join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  for (const [keyword, domain] of Object.entries(DOMAIN_KEYWORDS)) {
    if (allTexts.includes(keyword)) {
      scores[domain] = (scores[domain] ?? 0) + 1;
    }
  }

  if (Object.keys(scores).length === 0) return 'general';

  const top = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : 'general';
}

/**
 * Extrait les mots-clés de base depuis main_activity + capabilities.
 * Filtre les mots vides et les termes génériques non discriminants.
 */
function buildBaseKeywords(
  mainActivity: string,
  capabilities: readonly string[],
  precisionMode: 'large' | 'equilibre' | 'strict',
): string[] {
  // Tokenisation de l'activité principale
  const activityWords = mainActivity
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !KW_STOP_WORDS.has(w));

  // Capacités nettoyées
  const capWords = capabilities
    .map(c => c.toLowerCase().trim())
    .filter(c => c.length >= 3 && !KW_STOP_WORDS.has(c));

  const combined = [...activityWords, ...capWords];
  const unique = [...new Set(combined)];

  // Selon le mode de précision : plus ou moins de mots-clés
  const limit = precisionMode === 'large' ? 20
    : precisionMode === 'strict' ? 8
    : 14; // equilibre

  return unique.slice(0, limit);
}

/**
 * Génère les inclusions initiales déterministes.
 *
 * Règle : synonymes évidents + variantes formelles.
 * NE PAS confondre avec les ai_inclusions générées par LLM (L4).
 *
 * Largeur influencée par precision_mode :
 *   large    → inclusions étendues (marques, termes techniques, variantes)
 *   equilibre → inclusions modérées (termes techniques principaux)
 *   strict   → inclusions minimales (termes les plus qualifiants uniquement)
 */
function buildInitialInclusions(
  brands: readonly string[],
  technicalTerms: readonly string[],
  precisionMode: 'large' | 'equilibre' | 'strict',
): string[] {
  const inclusions: string[] = [];

  if (precisionMode === 'large') {
    // Tout : marques + termes techniques
    inclusions.push(...brands, ...technicalTerms);
  } else if (precisionMode === 'equilibre') {
    // Termes techniques principaux + quelques marques
    inclusions.push(...technicalTerms, ...brands.slice(0, 5));
  } else {
    // strict : termes techniques uniquement (les plus qualifiants)
    inclusions.push(...technicalTerms.slice(0, 5));
  }

  return [...new Set(inclusions)].slice(0, 15);
}

/**
 * Génère les exclusions initiales CONTEXTUELLES depuis les intentions exclues.
 *
 * Règle absolue :
 *   - Jamais d'exclusion lexicale brute ("maintenance", "formation", "achat"...)
 *   - Toujours des formulations contextuelles décrivant un périmètre précis
 *
 * Exemples corrects :
 *   ✓ "maintenance seule sans fourniture de matériel"
 *   ✓ "formation sans fourniture ni installation"
 *   ✓ "travaux de génie civil hors fourniture équipements"
 *
 * Exemples INTERDITS :
 *   ✗ "maintenance"
 *   ✗ "formation"
 *   ✗ "achat simple"
 */
const CONTEXTUAL_EXCLUSION_TEMPLATES: Record<string, string> = {
  maintenance: 'maintenance seule sans fourniture de matériel associée',
  formation:   'formation sans fourniture ni installation de matériel',
  travaux:     'travaux de génie civil ou bâtiment hors fourniture équipements',
  audit:       'audit ou conseil sans fourniture de matériel',
  support:     'support technique seul sans fourniture de matériel',
  autres:      'prestations hors périmètre métier du fournisseur',
};

function buildContextualExclusions(
  excludedIntentions: readonly string[],
  precisionMode: 'large' | 'equilibre' | 'strict',
): string[] {
  const exclusions: string[] = [];

  for (const intention of excludedIntentions) {
    const template = CONTEXTUAL_EXCLUSION_TEMPLATES[intention];
    if (template) {
      exclusions.push(template);
    }
  }

  // En mode strict, on ajoute une exclusion générale sur les consommables
  if (precisionMode === 'strict') {
    exclusions.push('consommables seuls hors périmètre sans équipement principal');
  }

  return [...new Set(exclusions)].slice(0, 10);
}

// ─── Générateur principal ─────────────────────────────────────────────────────

/**
 * Génère un ensemble de critères proposés depuis un profil L2 validé.
 *
 * Garanties :
 *   - Pas de mutation de l'entrée L2
 *   - Pas d'appel LLM / réseau / DB
 *   - active = false, requires_human_validation = true sur tous les critères
 *   - Résultat validé par GeneratedCriteriaSetSchema (Zod)
 *
 * @param profile   StructuredBusinessProfile validé (L2)
 * @param clientId  Identifiant client (optionnel, peut être vide pour preview)
 * @throws ZodError si le résultat ne passe pas la validation L3
 */
export function generateCriteriaFromL2(
  profile: StructuredBusinessProfile,
  clientId = '',
): GeneratedCriteriaSet {
  const { business_profile, technical_profile, organization_profile, intent_profile } = profile;
  const precisionMode = business_profile.precision_mode;

  // ── Détection de la catégorie métier ────────────────────────────────────────
  const domainCategory = detectDomainCategory(
    business_profile.sectors,
    technical_profile.capabilities,
    business_profile.main_activity,
  );

  // ── Construction des mots-clés de base ──────────────────────────────────────
  const baseKeywords = buildBaseKeywords(
    business_profile.main_activity,
    technical_profile.capabilities,
    precisionMode,
  );

  // ── Inclusions et exclusions initiales ──────────────────────────────────────
  const inclusionsInitial = buildInitialInclusions(
    technical_profile.brands_or_references,
    technical_profile.technical_terms,
    precisionMode,
  );

  const exclusionsInitial = buildContextualExclusions(
    intent_profile.excluded_intentions,
    precisionMode,
  );

  // ── Critère principal ────────────────────────────────────────────────────────
  // En L3, on génère un critère principal par profil.
  // ONB-1d (interface validation) permettra au client de le diviser en sous-critères.
  const mainLabel = `${business_profile.main_activity.slice(0, 80)} — ${domainCategory}`;
  const mainId = toSlug(`${domainCategory}-${baseKeywords[0] ?? 'general'}`);

  const mainCritere: ProposedCritere = {
    id:    mainId,
    label: mainLabel,

    // Compatible bot — catégorie métier dans domain_category, pas ici
    radar_type:      'bc',
    domain_category: domainCategory,

    base_keywords:         baseKeywords,
    ai_inclusions_initial: inclusionsInitial,
    ai_exclusions_initial: exclusionsInitial,

    prestations_recherchees: [...intent_profile.searched_intentions],
    prestations_exclues:     [...intent_profile.excluded_intentions],

    zones_geographiques:    [...organization_profile.zones_geographiques],
    favorite_organizations: [...organization_profile.favorite_organizations],

    precision_mode: precisionMode,

    // ── source_trace ───────────────────────────────────────────────────────────
    source_trace: {
      'base_keywords': {
        source_l2_fields: ['business_profile.main_activity', 'technical_profile.capabilities'],
        derivation:       'extracted',
        note:             'Tokenisation main_activity + capabilities, filtre mots vides, max selon precision_mode',
      },
      'ai_inclusions_initial': {
        source_l2_fields: ['technical_profile.brands_or_references', 'technical_profile.technical_terms'],
        derivation:       'extracted',
        note:             'Marques + termes techniques, largeur selon precision_mode (large→20, equilibre→15, strict→5)',
      },
      'ai_exclusions_initial': {
        source_l2_fields: ['intent_profile.excluded_intentions'],
        derivation:       'composed',
        note:             'Formulations contextuelles depuis prestations_refusees — jamais de termes lexicaux bruts',
      },
      'prestations_recherchees': {
        source_l2_fields: ['intent_profile.searched_intentions'],
        derivation:       'direct',
        note:             'Copie directe de searched_intentions (L2)',
      },
      'prestations_exclues': {
        source_l2_fields: ['intent_profile.excluded_intentions'],
        derivation:       'direct',
        note:             'Copie directe de excluded_intentions (L2)',
      },
      'zones_geographiques': {
        source_l2_fields: ['organization_profile.zones_geographiques'],
        derivation:       'direct',
        note:             'Copie directe de zones_geographiques (L2)',
      },
      'favorite_organizations': {
        source_l2_fields: ['organization_profile.favorite_organizations'],
        derivation:       'direct',
        note:             'Copie directe de favorite_organizations (L2)',
      },
      'domain_category': {
        source_l2_fields: ['business_profile.sectors', 'technical_profile.capabilities', 'business_profile.main_activity'],
        derivation:       'inferred',
        note:             'Détection déterministe depuis DOMAIN_KEYWORDS (scoring des occurrences)',
      },
      'precision_mode': {
        source_l2_fields: ['business_profile.precision_mode'],
        derivation:       'direct',
        note:             'Hérité directement du profil L2',
      },
    },

    requires_human_validation: true,
    active:                    false,
  };

  // ── Construction du set ──────────────────────────────────────────────────────
  const raw = {
    client_id:    clientId,
    generated_at: new Date().toISOString(),
    status:       'pending_validation' as const,
    criteria:     [mainCritere],
    generation_meta: {
      generator_version:       GENERATOR_VERSION,
      precision_mode:          precisionMode,
      source_profile_sectors:  [...business_profile.sectors],
    },
  };

  return GeneratedCriteriaSetSchema.parse(raw);
}

/**
 * Version null-safe de generateCriteriaFromL2.
 * Retourne null en cas d'erreur inattendue.
 */
export function safeGenerateCriteriaFromL2(
  profile: StructuredBusinessProfile,
  clientId = '',
): GeneratedCriteriaSet | null {
  try {
    return generateCriteriaFromL2(profile, clientId);
  } catch {
    return null;
  }
}

// ─── Exports utilitaires ──────────────────────────────────────────────────────

export { detectDomainCategory, buildBaseKeywords, buildContextualExclusions };
