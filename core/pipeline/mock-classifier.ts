/**
 * Mock Classifier — Anaho Pipeline
 *
 * Classifie chaque article d'un BC dans un secteur d'activité.
 * Utilisé pour la traçabilité et la génération d'explications.
 *
 * Le classifier est INDÉPENDANT du scoring engine :
 *   - Il ne modifie pas les scores.
 *   - Il enrichit le rapport de sortie du pipeline.
 *   - Il permet de détecter la "catégorie dominante" d'un BC
 *     pour l'explication textuelle.
 *
 * Algorithme :
 *   Pour chaque article :
 *     1. Normaliser le texte (designation + specifications)
 *     2. Compter les mots-clés matchés par catégorie
 *     3. Assigner la catégorie avec le plus de votes
 *     4. Déduire la confiance (high = 3+ votes, medium = 1-2, low = 0)
 */

import { type ParsedBC } from '@core/schemas/bc.schema';
import { normalizeText } from '@core/scoring/matchers';
import {
  type ArticleCategory,
  type ClassifiedArticle,
  type ClassificationSummary,
  type Confidence,
} from './types';

// ─── Base de connaissances ────────────────────────────────────────────────────

/**
 * Mots-clés représentatifs de chaque catégorie.
 * Un article accumule des votes pour chaque mot-clé trouvé dans son texte.
 */
const CATEGORY_KEYWORDS: Record<ArticleCategory, string[]> = {
  cvc: [
    'climatiseur', 'split', 'cta', 'centrale traitement air',
    'ventilateur', 'compresseur', 'frigorie', 'btu',
    'r410a', 'r32', 'chaudiere', 'radiateur', 'pompe chaleur',
    'climatisation', 'cvc', 'refroidisseur', 'ventiloconvecteur',
    'groupe froid', 'extracteur air', 'gaz refrigerant',
  ],
  informatique: [
    'ordinateur', 'laptop', 'pc portable', 'notebook',
    'serveur', 'switch', 'routeur', 'pare-feu', 'firewall',
    'cable reseau', 'rj45', 'cat6', 'cat5', 'fibre optique',
    'patch panel', 'rack', 'onduleur', 'ups',
    'ecran', 'moniteur', 'clavier', 'souris',
    'ram', 'ssd', 'disque dur', 'processeur', 'memoire',
    'reseau informatique', 'gigabit', 'ethernet',
  ],
  bureautique: [
    'imprimante', 'cartouche', 'toner', 'encre',
    'papier a4', 'papier bureau', 'ramette',
    'stylo', 'crayon', 'marqueur', 'surligneur',
    'agrafeuse', 'perforeuse', 'classeur', 'chemise',
    'enveloppe', 'bloc-notes', 'post-it', 'scotch',
    'calculatrice', 'photocopieur',
  ],
  mobilier: [
    'bureau', 'chaise', 'armoire', 'meuble', 'mobilier',
    'table de reunion', 'caisson', 'bibliotheque',
    'vestiaire', 'etagere', 'pediluve', 'locker',
    'fauteuil', 'canape', 'banquette', 'table basse',
    'tableau blanc', 'presentoir',
  ],
  alimentaire: [
    'cafe', 'the', 'sucre', 'eau minerale', 'jus',
    'biscuit', 'collation', 'boisson', 'lait',
    'gouter', 'confiserie', 'fruit', 'yaourt',
  ],
  travaux: [
    'beton', 'ciment', 'fer', 'brique', 'parpaing',
    'carrelage', 'peinture batiment', 'enduit',
    'plomberie', 'electricite batiment', 'charpente',
    'toiture', 'menuiserie', 'gros oeuvre', 'second oeuvre',
    'maconnerie', 'terrassement', 'fondation',
  ],
  autre: [],
};

// ─── Logique de classification ────────────────────────────────────────────────

interface VoteResult {
  category:          ArticleCategory;
  votes:             number;
  matched_keywords:  string[];
}

function voteForArticle(text: string): VoteResult {
  const norm = normalizeText(text);
  let bestCategory: ArticleCategory = 'autre';
  let bestVotes = 0;
  const bestKeywords: string[] = [];

  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS) as [ArticleCategory, string[]][]) {
    if (cat === 'autre') continue;

    const matched: string[] = [];
    for (const kw of keywords) {
      if (norm.includes(kw)) matched.push(kw);
    }

    if (matched.length > bestVotes) {
      bestVotes    = matched.length;
      bestCategory = cat;
      bestKeywords.splice(0, bestKeywords.length, ...matched);
    }
  }

  return { category: bestCategory, votes: bestVotes, matched_keywords: bestKeywords };
}

function voteToConfidence(votes: number): Confidence {
  if (votes >= 3) return 'high';
  if (votes >= 1) return 'medium';
  return 'low';
}

// ─── Classifier principal ─────────────────────────────────────────────────────

/**
 * Classifie tous les articles d'un BC.
 *
 * Retourne :
 *   - La liste d'articles classifiés (avec catégorie + confiance + mots-clés matchés)
 *   - La catégorie dominante (celle qui représente le plus d'articles)
 *   - Le décompte par catégorie
 */
export function classifyArticles(bc: ParsedBC): ClassificationSummary {
  // Compteurs par catégorie
  const counts: Record<ArticleCategory, number> = {
    cvc: 0, informatique: 0, bureautique: 0,
    mobilier: 0, alimentaire: 0, travaux: 0, autre: 0,
  };

  const classified: ClassifiedArticle[] = bc.articles.map(article => {
    const text  = `${article.designation} ${article.specifications}`;
    const voted = voteForArticle(text);

    counts[voted.category] = (counts[voted.category] ?? 0) + 1;

    return {
      designation:      article.designation,
      specifications:   article.specifications,
      quantite:         article.quantite,
      unite:            article.unite,
      category:         voted.category,
      confidence:       voteToConfidence(voted.votes),
      matched_keywords: voted.matched_keywords,
    };
  });

  // Si aucun article : catégorie dominante depuis objet + bodyText
  let dominant_category: ArticleCategory = 'autre';

  if (bc.articles.length === 0) {
    const textFull = `${bc.objet} ${bc.bodyText}`;
    const voted    = voteForArticle(textFull);
    dominant_category = voted.category;
  } else {
    // La catégorie avec le plus d'articles l'emporte
    const sorted = (Object.entries(counts) as [ArticleCategory, number][])
      .sort((a, b) => b[1] - a[1]);
    dominant_category = sorted[0]?.[0] ?? 'autre';
  }

  return { dominant_category, category_counts: counts, classified };
}

/**
 * Formate un résumé textuel de la classification.
 * Ex: "CVC (3 articles, 75%) — informatique (1, 25%)"
 */
export function formatClassificationSummary(summary: ClassificationSummary): string {
  const total = Object.values(summary.category_counts).reduce((a, b) => a + b, 0);
  if (total === 0) return `Dominant: ${summary.dominant_category} (texte BC)`;

  const parts = (Object.entries(summary.category_counts) as [ArticleCategory, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${cat} (${n}/${total} = ${Math.round((n / total) * 100)}%)`);

  return parts.join(' — ');
}
