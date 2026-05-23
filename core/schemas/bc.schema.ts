/**
 * BC Schema — Anaho
 *
 * Source de vérité pour les données scrappées du portail marchespublics.gov.ma.
 * Tout item BC entrant dans le pipeline doit être validé par ces schemas.
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';

// ─── ParsedArticle ────────────────────────────────────────────────────────────

/**
 * Un article/ligne de produit extrait du tableau HTML d'un BC.
 * La désignation est obligatoire — sans elle, l'article n'est pas exploitable.
 */
export const ParsedArticleSchema = z.object({
  designation:    z.string().min(1, 'La désignation de l\'article est requise'),
  specifications: z.string().default(''),
  quantite:       z.string().default(''),
  unite:          z.string().default(''),
});

export type ParsedArticle = z.infer<typeof ParsedArticleSchema>;

// ─── RadarType ────────────────────────────────────────────────────────────────

export const RadarTypeSchema = z.enum(['bc', 'mp']);
export type RadarType = z.infer<typeof RadarTypeSchema>;

// ─── ParsedBC ─────────────────────────────────────────────────────────────────

/**
 * Un bon de commande tel que parsé depuis le portail.
 *
 * - `id` : identifiant unique extrait de l'URL (obligatoire)
 * - `url` : URL canonique de la fiche BC (doit être valide)
 * - `articles` : lignes de produits extraites des tableaux HTML
 * - `bodyText` : texte brut de la page (fallback si tableaux non parsés)
 * - `montant` : montant estimé si présent dans le BC, null sinon
 */
export const ParsedBCSchema = z.object({
  id:          z.string().min(1, 'L\'identifiant BC est requis'),
  objet:       z.string().default(''),
  organisme:   z.string().default(''),
  wilaya:      z.string().default(''),
  lieu:        z.string().default(''),
  date_limite: z.string().default(''),
  reference:   z.string().default(''),
  url:         z.string().url('L\'URL du BC doit être valide'),
  radar_type:  RadarTypeSchema.default('bc'),
  articles:    z.array(ParsedArticleSchema).default([]),
  bodyText:    z.string().max(10_000, 'bodyText tronqué à 10 000 caractères').default(''),
  montant:     z.number().positive().nullable().default(null),

  /**
   * Keyword de recherche utilisé pour trouver ce BC (interne au scraper).
   * Ne fait pas partie de la fiche officielle.
   */
  _keyword:    z.string().optional(),
});

export type ParsedBC = z.infer<typeof ParsedBCSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Valide et parse un item BC brut.
 * Retourne le résultat Zod (success/error) sans lancer d'exception.
 * Utiliser `.parse()` si une exception est préférable.
 */
export const safeParseBC = (raw: unknown) => ParsedBCSchema.safeParse(raw);

/**
 * Extrait le texte complet d'un BC pour le matching.
 * Concatène objet + articles + bodyText dans l'ordre de priorité.
 */
export function extractFullText(bc: ParsedBC): string {
  const articleText = bc.articles
    .map(a => [a.designation, a.specifications].filter(Boolean).join(' '))
    .join(' ');
  return [bc.objet, articleText, bc.bodyText].filter(Boolean).join(' ');
}

/**
 * Retourne true si la date limite n'est pas encore dépassée.
 * Retourne true si la date est absente (on ne sait pas → on notifie).
 */
export function isBCEnCours(bc: ParsedBC): boolean {
  if (!bc.date_limite) return true;
  const match = bc.date_limite.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return true;
  const [, day, month, year] = match;
  if (!day || !month || !year) return true;
  const deadline = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
  return deadline >= new Date();
}
