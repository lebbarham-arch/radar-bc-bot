/**
 * Pipeline Types — Anaho
 *
 * Définit les types de données à chaque étape du pipeline de démonstration.
 *
 * Étapes :
 *   RawBC → ParseResult → ClassifiedArticles → ScoreComponents → PipelineResult
 *
 * Ce pipeline est mocké — il n'est pas branché à la production.
 * Les parsers et classifiers utilisent des données de fixtures.
 */

import { type ParsedBC } from '@core/schemas/bc.schema';
import { type ScoreComponents } from '@core/scoring/engine';

// ─── Entrée brute ─────────────────────────────────────────────────────────────

/**
 * BC tel que retourné par le scraper Puppeteer (avant parsing/validation).
 * Toutes les clés sont optionnelles — le parser gère les valeurs manquantes.
 *
 * raw_tables : lignes HTML extraites des tableaux d'articles.
 *   - La première ligne est supposée être un en-tête.
 *   - Colonnes typiques : N° | Désignation | Spécifications | Quantité | Unité
 */
export interface RawBC {
  id?:          string;
  objet?:       string;
  organisme?:   string;
  wilaya?:      string;
  lieu?:        string;
  date_limite?: string;
  reference?:   string;
  url?:         string;
  raw_tables?:  string[][];
  raw_body?:    string;
  _keyword?:    string;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Résultat du parsing d'un RawBC.
 * Distingue succès (parsed disponible) d'un échec (error disponible).
 */
export type ParseResult =
  | { success: true;  parsed: ParsedBC; warnings: string[] }
  | { success: false; error: string;   warnings: string[] };

// ─── Classification des articles ─────────────────────────────────────────────

/**
 * Secteur d'activité inféré pour un article.
 * Utilisé par le classifier mocké pour la traçabilité et le reporting.
 */
export type ArticleCategory =
  | 'cvc'
  | 'informatique'
  | 'bureautique'
  | 'mobilier'
  | 'alimentaire'
  | 'travaux'
  | 'autre';

/** Niveau de confiance de la classification */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * Article classifié : étend les données brutes avec la catégorie inférée.
 */
export interface ClassifiedArticle {
  designation:      string;
  specifications:   string;
  quantite:         string;
  unite:            string;
  category:         ArticleCategory;
  confidence:       Confidence;
  matched_keywords: string[];
}

/**
 * Résumé de la classification d'un BC :
 * répartition des articles par catégorie et catégorie dominante.
 */
export interface ClassificationSummary {
  dominant_category: ArticleCategory;
  category_counts:   Record<ArticleCategory, number>;
  classified:        ClassifiedArticle[];
}

// ─── Sortie du pipeline ───────────────────────────────────────────────────────

/**
 * Résultat complet d'un passage dans le pipeline de démonstration.
 *
 * Toutes les étapes intermédiaires sont conservées pour l'audit et le debug.
 * Ce type est le contrat de sortie du pipeline — stable et versionnable.
 */
export interface PipelineResult {
  /** Identifiant du BC traité */
  bc_id:       string;
  /** Identifiant du client pour lequel le score est calculé */
  client_id:   string;

  /** Étapes intermédiaires (pour audit) */
  stages: {
    raw_input:           RawBC;
    parse_result:        ParseResult;
    classification:      ClassificationSummary;
    score_components:    ScoreComponents;
  };

  /** Décision finale */
  final_decision:  'notify' | 'rerank' | 'ignore';
  final_score:     number;

  /** Explication lisible de bout en bout */
  explanation:     string;

  /** Temps d'exécution du pipeline (en ms) */
  duration_ms:     number;
}

// ─── Erreur pipeline ──────────────────────────────────────────────────────────

/**
 * Résultat d'un pipeline qui a échoué à l'étape de parsing.
 * Permet de distinguer un "ignore" métier d'un "fail" technique.
 */
export interface PipelineError {
  bc_id:       string;
  client_id:   string;
  stage:       'parse' | 'classify' | 'score';
  error:       string;
  raw_input:   RawBC;
}

export type PipelineOutcome = PipelineResult | PipelineError;

/** Type guard : distingue un résultat d'une erreur pipeline */
export function isPipelineResult(o: PipelineOutcome): o is PipelineResult {
  return 'final_score' in o;
}
