/**
 * Mock Parser — Anaho Pipeline
 *
 * Simule le travail du scraper Puppeteer :
 * transforme un RawBC (données brutes, champs optionnels) en ParsedBC validé.
 *
 * Ce parser est "mocké" dans le sens où il n'effectue aucune requête réseau.
 * La logique de parsing (détection d'en-têtes, mapping de colonnes, validation
 * Zod) est réelle et identique à celle du pipeline de production.
 *
 * Responsabilités :
 *   1. Détecter et mapper les colonnes des tableaux HTML
 *   2. Extraire les articles et les valider
 *   3. Tronquer le bodyText à 10 000 caractères (contrainte schema)
 *   4. Valider le tout avec ParsedBCSchema et retourner un ParseResult
 */

import { ParsedBCSchema } from '@core/schemas/bc.schema';
import { type RawBC, type ParseResult } from './types';

// ─── Détection de colonnes ────────────────────────────────────────────────────

/**
 * Variantes d'en-têtes connues pour chaque champ d'article.
 * La détection est insensible à la casse et aux accents.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  designation:    ['désignation', 'designation', 'libellé', 'libelle', 'article', 'description', 'nature'],
  specifications: ['spécifications', 'specifications', 'caractéristiques', 'caracteristiques', 'specs', 'détails', 'details'],
  quantite:       ['quantité', 'quantite', 'qté', 'qte', 'qt', 'nb', 'nombre'],
  unite:          ['unité', 'unite', 'um', 'pu'],
};

/** Normalise un en-tête de colonne pour la détection */
function normalizeHeader(h: string): string {
  return h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

/** Mappe les indices de colonnes aux noms de champs */
function detectColumns(headerRow: string[]): Map<string, number> {
  const map = new Map<string, number>();

  headerRow.forEach((cell, idx) => {
    const norm = normalizeHeader(cell);
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (aliases.some(a => norm.includes(a)) && !map.has(field)) {
        map.set(field, idx);
      }
    }
  });

  return map;
}

// ─── Extraction d'articles depuis les tableaux HTML ───────────────────────────

interface RawArticle {
  designation:    string;
  specifications: string;
  quantite:       string;
  unite:          string;
}

/**
 * Extrait les articles d'un tableau brut (lignes × colonnes).
 *
 * Stratégie :
 *   1. Si la première ligne ressemble à un en-tête → détecter les colonnes
 *   2. Sinon → supposer col 0 = designation, col 1 = qte, col 2 = unité
 *   3. Ignorer les lignes avec une désignation vide (séparateurs)
 */
function extractArticlesFromTable(table: string[][]): RawArticle[] {
  if (table.length === 0) return [];

  const firstRow = table[0];
  if (!firstRow || firstRow.length === 0) return [];

  // Détecter si la première ligne est un en-tête
  const colMap = detectColumns(firstRow);
  const hasHeader = colMap.size >= 2; // ≥ 2 : un seul alias accidentel (ex: 'unités'.includes('unite')) ne doit pas créer de fausse en-tête

  const dataRows = hasHeader ? table.slice(1) : table;
  const articles: RawArticle[] = [];

  for (const row of dataRows) {
    let designation    = '';
    let specifications = '';
    let quantite       = '';
    let unite          = '';

    if (hasHeader) {
      const dIdx = colMap.get('designation');
      const sIdx = colMap.get('specifications');
      const qIdx = colMap.get('quantite');
      const uIdx = colMap.get('unite');

      designation    = dIdx !== undefined ? (row[dIdx] ?? '') : '';
      specifications = sIdx !== undefined ? (row[sIdx] ?? '') : '';
      quantite       = qIdx !== undefined ? (row[qIdx] ?? '') : '';
      unite          = uIdx !== undefined ? (row[uIdx] ?? '') : '';
    } else {
      // Fallback sans en-tête : col 0 = désignation, col 1 = qte, col 2 = unité
      designation = row[0] ?? '';
      quantite    = row[1] ?? '';
      unite       = row[2] ?? '';
    }

    // Ignorer les lignes vides ou qui ressemblent à des séparateurs
    const cleaned = designation.trim();
    if (!cleaned || /^[-─═=\s]+$/.test(cleaned)) continue;

    articles.push({
      designation:    cleaned,
      specifications: specifications.trim(),
      quantite:       quantite.trim(),
      unite:          unite.trim(),
    });
  }

  return articles;
}

// ─── Génération d'URL fallback ────────────────────────────────────────────────

/**
 * Construit une URL canonique de fallback si l'URL brute est absente.
 * Format : https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/{id}
 */
function buildFallbackUrl(id: string): string {
  return `https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/${encodeURIComponent(id)}`;
}

// ─── Parser principal ─────────────────────────────────────────────────────────

/**
 * Parse un RawBC en ParsedBC validé.
 *
 * Étapes :
 *   1. Extraire les articles depuis raw_tables
 *   2. Tronquer raw_body à 10 000 caractères
 *   3. Construire l'objet intermédiaire
 *   4. Valider avec ParsedBCSchema.safeParse
 *   5. Retourner ParseResult (success ou failure)
 *
 * Ne lance jamais d'exception — toutes les erreurs sont encapsulées.
 */
export function mockParseBc(raw: RawBC): ParseResult {
  const warnings: string[] = [];

  // 1. Identifiant obligatoire
  const id = raw.id?.trim() ?? '';
  if (!id) {
    return { success: false, error: 'id manquant dans le RawBC', warnings };
  }

  // 2. URL (fallback si absente)
  const url = raw.url?.trim() || buildFallbackUrl(id);

  // 3. Extraction des articles depuis les tableaux HTML
  const articles: RawArticle[] = [];
  if (raw.raw_tables && raw.raw_tables.length > 0) {
    const extracted = extractArticlesFromTable(raw.raw_tables);
    articles.push(...extracted);
    if (extracted.length === 0) {
      warnings.push('raw_tables présent mais aucun article extrait (colonnes non détectées ?)');
    }
  }

  // 4. bodyText — tronqué à 10 000 chars (contrainte schema)
  let bodyText = (raw.raw_body ?? '').trim();
  if (bodyText.length > 10_000) {
    bodyText = bodyText.slice(0, 10_000);
    warnings.push('raw_body tronqué à 10 000 caractères');
  }

  // 5. Construction de l'objet à valider
  const candidate = {
    id,
    objet:       raw.objet?.trim()       ?? '',
    organisme:   raw.organisme?.trim()   ?? '',
    wilaya:      raw.wilaya?.trim()      ?? '',
    lieu:        raw.lieu?.trim()        ?? '',
    date_limite: raw.date_limite?.trim() ?? '',
    reference:   raw.reference?.trim()   ?? '',
    url,
    articles,
    bodyText,
    _keyword:    raw._keyword,
  };

  // 6. Validation Zod
  const result = ParsedBCSchema.safeParse(candidate);

  if (!result.success) {
    const first = result.error.errors[0];
    const errMsg = first
      ? `Validation échouée : ${first.path.join('.')} — ${first.message}`
      : 'Validation Zod échouée (erreur inconnue)';
    return { success: false, error: errMsg, warnings };
  }

  return { success: true, parsed: result.data, warnings };
}
