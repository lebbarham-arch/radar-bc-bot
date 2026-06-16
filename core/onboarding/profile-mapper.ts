/**
 * ONB-1b — Mapper L1 → L2
 *
 * Transforme une OnboardingClientForm validée en StructuredBusinessProfile.
 *
 * Contraintes absolues :
 *   - Mapping 100% déterministe (pas de LLM, pas d'embeddings)
 *   - Pas de ai_inclusions / ai_exclusions générées
 *   - Pas de critères radar générés
 *   - Pas d'appel réseau / DB
 *   - Pas de mutation de l'entrée L1
 *   - source_trace documenté pour chaque champ L2
 */

import { type OnboardingClientForm } from './schema';
import {
  type StructuredBusinessProfile,
  StructuredBusinessProfileSchema,
} from './l2-profile.schema';

// ─── Extracteurs déterministes ────────────────────────────────────────────────

/**
 * Mots génériques à exclure de l'extraction de secteurs.
 * Conjonctions, prépositions, articles, verbes courants.
 */
const STOP_WORDS = new Set([
  'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et', 'ou', 'en',
  'au', 'aux', 'par', 'pour', 'sur', 'avec', 'dans', 'à', 'il', 'elle',
  'nous', 'vous', 'ils', 'est', 'sont', 'être', 'avoir', 'faire', 'tout',
  'tous', 'cette', 'ce', 'cet', 'ces', 'mon', 'ma', 'mes', 'son', 'sa',
  'ses', 'leur', 'leurs', 'qui', 'que', 'quoi', 'dont', 'où',
]);

/**
 * Extrait les secteurs/catégories depuis activite_principale.
 * Règle : conserver les mots de ≥ 4 chars qui ne sont pas des mots vides.
 * Pas de NLP, pas de LLM — tokenisation simple.
 */
function extractSectors(activite: string): string[] {
  return activite
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // supprime les diacritiques
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
    .filter((w, i, arr) => arr.indexOf(w) === i)  // déduplication
    .slice(0, 8);  // max 8 secteurs extraits
}

/**
 * Pattern de détection de marques et références techniques.
 * Détecte :
 *   - Mots tout-CAPS de 2 à 8 chars : HP, VRV, BTU, RAM, SSD, DELL
 *   - CamelCase technique : EliteBook, PowerEdge, ProDesk
 *   - Sigles avec chiffres : i7, i5, 2U, A4, A3
 */
const BRAND_PATTERNS = [
  /\b[A-Z]{2,8}\b/g,                          // ALL_CAPS : HP, VRV, BTU
  /\b[A-Z][a-z]+[A-Z][a-zA-Z]*\b/g,           // CamelCase : EliteBook
  /\b[A-Z][a-z]+\d+[A-Za-z]*\b/g,             // Nom+chiffre : LaserJet4
  /\b[a-z]\d+\b/gi,                            // lettre+chiffre : i7, i5
] as const;

/**
 * Faux positifs connus à ne pas traiter comme marques.
 * Abréviations françaises communes, unités, mois, etc.
 */
const BRAND_EXCLUSIONS = new Set([
  'BTU', 'KW', 'KWH', 'DB', 'DH', 'TTC', 'HT', 'TVA', 'RIB', 'ICE',
  'RC', 'NF', 'ISO', 'CE', 'EN', 'FR', 'MA', 'DZ', 'TN',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  'A4', 'A3', 'A5',  // formats papier — pas des marques
]);

/**
 * Extrait les marques et références depuis un ensemble de textes.
 * Déterministe — aucun LLM.
 */
function extractBrands(texts: readonly string[]): string[] {
  const found = new Set<string>();
  const combined = texts.join(' ');

  for (const pattern of BRAND_PATTERNS) {
    const matches = combined.matchAll(pattern);
    for (const m of matches) {
      const word = m[0].trim();
      if (word.length >= 2 && !BRAND_EXCLUSIONS.has(word)) {
        found.add(word);
      }
    }
  }

  return [...found].slice(0, 15);  // max 15 marques
}

/**
 * Pattern de détection de termes techniques multi-mots.
 * Détecte :
 *   - Nombre + unité : "18000 BTU", "50 L", "30 ppm"
 *   - Spec composée : "Core i7", "split system", "rack 2U", "double flux"
 *   - Modèles alphanumériques : "Cat6", "RJ45", "PoE+", "802.11ac"
 */
const TECH_TERM_PATTERNS = [
  /\d{2,6}\s*[A-Za-z]{2,6}\b/g,               // "18000 BTU", "30 ppm", "256 Go"
  /\b(?:Core|Xeon|Ryzen|Celeron)\s+\w+/gi,     // processeurs Intel/AMD
  /\b\w+\s+(?:system|flux|split|rack|pack)\b/gi,// "split system", "double flux"
  /\b(?:Cat|RJ|PoE|USB|SFP|HDMI|VGA|DVI)\+?\d*/gi, // connectique
  /\b\d+[Uu]\b/g,                              // "2U", "4U" (rack)
  /\b\d{3,4}[dD][pP][iI]\b/g,                 // "300dpi", "1200dpi"
  /\b\d+[Gg][Oo]\b/gi,                         // "16Go", "256Go"
  /\b\d+[Tt][Oo]\b/gi,                         // "2To", "4To"
  /\b802\.\d+[a-z]{0,3}\b/gi,                  // "802.11ac", "802.3af"
] as const;

/**
 * Extrait les termes techniques depuis un ensemble de textes.
 * Déterministe — aucun LLM.
 */
function extractTechnicalTerms(texts: readonly string[]): string[] {
  const found = new Set<string>();
  const combined = texts.join(' ');

  for (const pattern of TECH_TERM_PATTERNS) {
    const matches = combined.matchAll(pattern);
    for (const m of matches) {
      const term = m[0].trim().replace(/\s+/g, ' ');
      if (term.length >= 2) found.add(term);
    }
  }

  // Termes multi-mots dans les capacités (expressions de 2-3 mots)
  for (const text of texts) {
    const words = text.trim().split(/\s+/);
    if (words.length >= 2 && words.length <= 4 && text.length >= 5) {
      // Expressions composées qui ne sont pas des phrases (pas de verbe courant)
      const hasStopWord = words.some(w => STOP_WORDS.has(w.toLowerCase()));
      if (!hasStopWord) {
        found.add(text.trim());
      }
    }
  }

  return [...found].slice(0, 20);  // max 20 termes techniques
}

// ─── Mapper principal ─────────────────────────────────────────────────────────

/**
 * Transforme une fiche client L1 validée en profil métier structuré L2.
 *
 * Garanti :
 *   - Pas de mutation de l'entrée
 *   - Pas de ai_inclusions / ai_exclusions
 *   - Pas de critères radar
 *   - source_trace complet
 *   - Résultat validé par StructuredBusinessProfileSchema (Zod)
 *
 * @throws ZodError si le résultat ne passe pas la validation L2 (ne devrait jamais arriver)
 */
export function mapL1ToL2(form: OnboardingClientForm): StructuredBusinessProfile {
  // Sources textuelles pour l'extraction
  const allTexts: readonly string[] = [
    ...form.capacites,
    ...form.exemples_bc_recherches,
  ];

  // ── Extraction déterministe ──────────────────────────────────────────────
  const sectors           = extractSectors(form.activite_principale);
  const brands            = extractBrands(allTexts);
  const technicalTerms    = extractTechnicalTerms([
    ...form.capacites,
    ...form.exemples_bc_recherches,
  ]);

  // ── Construction du profil L2 ────────────────────────────────────────────
  const raw = {
    business_profile: {
      main_activity:          form.activite_principale,
      sectors,
      prestations_recherchees: [...form.prestations_realisees],
      prestations_refusees:    [...form.prestations_refusees],
      precision_mode:          form.niveau_precision,
    },

    technical_profile: {
      capabilities:       [...form.capacites],
      products_or_services: [...form.capacites],  // identique à capabilities en L2 — précisé en L3
      brands_or_references: brands,
      technical_terms:    technicalTerms,
    },

    organization_profile: {
      zones_geographiques:    [...form.zones_geographiques],
      favorite_organizations: [...form.organismes_favoris],
    },

    intent_profile: {
      searched_intentions: [...form.prestations_realisees],
      excluded_intentions: [...form.prestations_refusees],
    },

    // ── source_trace : traçabilité complète ──────────────────────────────
    source_trace: {
      'business_profile.main_activity': {
        source_fields: ['activite_principale'],
        derivation:    'direct' as const,
        note:          'Copie directe de activite_principale',
      },
      'business_profile.sectors': {
        source_fields: ['activite_principale'],
        derivation:    'extracted' as const,
        note:          'Mots significatifs ≥ 4 chars, hors mots vides, depuis activite_principale',
      },
      'business_profile.prestations_recherchees': {
        source_fields: ['prestations_realisees'],
        derivation:    'direct' as const,
        note:          'Copie directe de prestations_realisees',
      },
      'business_profile.prestations_refusees': {
        source_fields: ['prestations_refusees'],
        derivation:    'direct' as const,
        note:          'Copie directe de prestations_refusees',
      },
      'business_profile.precision_mode': {
        source_fields: ['niveau_precision'],
        derivation:    'direct' as const,
        note:          'Copie directe de niveau_precision',
      },
      'technical_profile.capabilities': {
        source_fields: ['capacites'],
        derivation:    'direct' as const,
        note:          'Copie directe de capacites',
      },
      'technical_profile.products_or_services': {
        source_fields: ['capacites'],
        derivation:    'direct' as const,
        note:          'Identique à capabilities en L2 — différenciation prévue en L3',
      },
      'technical_profile.brands_or_references': {
        source_fields: ['capacites', 'exemples_bc_recherches'],
        derivation:    'extracted' as const,
        note:          'Extraction déterministe : mots ALL_CAPS ≥ 2 chars, CamelCase technique, sigles',
      },
      'technical_profile.technical_terms': {
        source_fields: ['capacites', 'exemples_bc_recherches'],
        derivation:    'extracted' as const,
        note:          'Extraction déterministe : patterns nombre+unité, specs composées, acronymes connectique',
      },
      'organization_profile.zones_geographiques': {
        source_fields: ['zones_geographiques'],
        derivation:    'direct' as const,
        note:          'Copie directe de zones_geographiques — ne migre pas dans les critères radar',
      },
      'organization_profile.favorite_organizations': {
        source_fields: ['organismes_favoris'],
        derivation:    'direct' as const,
        note:          'Copie directe de organismes_favoris — ne migre pas dans les critères radar',
      },
      'intent_profile.searched_intentions': {
        source_fields: ['prestations_realisees'],
        derivation:    'mapped' as const,
        note:          'prestations_realisees → intentions recherchées (mapping BCIntent en L3)',
      },
      'intent_profile.excluded_intentions': {
        source_fields: ['prestations_refusees'],
        derivation:    'mapped' as const,
        note:          'prestations_refusees → exclusions contextuelles (alimentera exclusions_metier en L3)',
      },
    },
  };

  // Validation Zod — garantit la cohérence du L2 produit
  return StructuredBusinessProfileSchema.parse(raw);
}

// ─── Exports utilitaires ──────────────────────────────────────────────────────

/**
 * Version safe de mapL1ToL2 — ne lève pas d'exception.
 * Retourne null si le mapping échoue (ne devrait pas arriver sur une L1 valide).
 */
export function safeMapL1ToL2(form: OnboardingClientForm): StructuredBusinessProfile | null {
  try {
    return mapL1ToL2(form);
  } catch {
    return null;
  }
}

// Ré-export des extracteurs pour les tests unitaires isolés
export { extractSectors, extractBrands, extractTechnicalTerms };
