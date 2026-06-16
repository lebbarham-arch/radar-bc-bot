/**
 * purchase-intent.ts — GD-027 / GD-028
 *
 * Couche générique de détection d'intention d'achat/prestation pour le scoring shadow clean.
 * Shadow uniquement — aucun effet sur le matching legacy ni les notifications.
 *
 * Exports :
 *   PURCHASE_INTENT_SCORE, OUT_OF_SCOPE_PENALTY
 *   SHORT_SIGNAL_MAX_LEN, SHORT_SIGNAL_WINDOW (GD-028)
 *   detectPurchaseIntentNear(cleanText, signal)
 *   detectOutOfScopeContext(cleanText)
 *
 * GD-028 : pour les signaux courts (≤ 2 chars normalisés), fenêtre stricte ±30 chars,
 *          Tier 2 désactivé — évite les faux positifs sur acronymes de référence (#38/2026/PC).
 */

// ─── Helpers internes ─────────────────────────────────────────────────────────

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function hasKw(text: string, kw: string): boolean {
  const nk = norm(kw); if (!nk) return false;
  return new RegExp('\\b' + nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(norm(text));
}
function hasAnyKw(text: string, terms: string[]): boolean {
  return terms.some(t => t && hasKw(text, t));
}

// ─── Constantes ───────────────────────────────────────────────────────────────

export const PURCHASE_INTENT_SCORE = 5;
export const OUT_OF_SCOPE_PENALTY  = 5;

/** GD-028 — signaux courts (ex. "PC") : longueur normalisée max pour mode strict. */
export const SHORT_SIGNAL_MAX_LEN = 2;

/** GD-028 — fenêtre ±chars autour du signal pour les signaux courts. */
export const SHORT_SIGNAL_WINDOW = 30;

const PURCHASE_INTENT_PATTERNS: string[] = [
  'achat de', 'achat des', 'achat du', 'achats de',
  'acquisition de', 'acquisition des', 'acquisition du',
  'fourniture de', 'fourniture des', 'fournitures de', 'fournitures des',
  'fourniture pour', 'fournitures pour',
  'entretien et reparation de', 'entretien et reparation des',
  'entretien et maintenance de', 'entretien et maintenance des',
  'maintenance de', 'maintenance des', 'maintenance du',
  'installation de', 'installation des', 'installation du',
  'prestation de', 'prestations de',
  'service de', 'services de',
  'livraison de', 'livraison des',
  'approvisionnement en', 'approvisionnement de', 'approvisionnement des',
  'mise a disposition de', 'mise a disposition des',
  'realisation de la prestation', 'realisation des prestations',
];

const CTX_EVENEMENTIEL_SUPPRESS: string[] = [
  'reception', 'ceremonie', 'manifestation', 'inauguration',
  'banquet', 'gala', 'convives', 'buffet', 'cocktail', 'soiree',
];

const OUT_OF_SCOPE_PATTERNS: string[] = [
  'etude topographique',
  'etude geologique', 'etude geotechnique', 'etude geophysique',
  'etude architecturale', 'etude d architecture',
  'maitrise d oeuvre', 'mission de maitrise d oeuvre',
  'travaux de construction',
  'travaux de rehabilitation',
  'travaux d amenagement',
  'travaux de renovation', 'travaux de refection',
  'rehabilitation du batiment', 'rehabilitation de batiment',
  'construction du batiment', 'construction de batiment',
  'amenagement du batiment', 'amenagement de batiment',
  'gardiennage et surveillance',
  'service de gardiennage', 'services de gardiennage',
  'surveillance des locaux', 'surveillance et gardiennage',
  'ceremonies officielles',
];

const OUT_OF_SCOPE_BYPASS: string[] = [
  'fourniture de', 'fournitures de', 'fourniture pour',
  'achat de', 'acquisition de',
  'prestation de', 'service de',
  'livraison de', 'approvisionnement de',
];

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PurchaseIntentResult { detected: boolean; pattern: string | null; }
export interface OutOfScopeResult     { blocked: boolean;  reason:  string | null; }

// ─── Fonctions ────────────────────────────────────────────────────────────────

/**
 * Détecte si un pattern PI est présent "près" du signal dans le texte.
 *
 * Signaux longs (> SHORT_SIGNAL_MAX_LEN) :
 *   Tier 1 — fenêtre ±100 chars autour du signal.
 *   Tier 2 — PI en tête de texte (≤60 chars) + signal n'importe où.
 *
 * Signaux courts (≤ SHORT_SIGNAL_MAX_LEN, GD-028) :
 *   Tier 1 seulement — fenêtre ±SHORT_SIGNAL_WINDOW (30) chars.
 *   Tier 2 DÉSACTIVÉ : évite les FP sur acronymes de référence (#38/2026/PC).
 */
export function detectPurchaseIntentNear(
  cleanText: string,
  signal:    string,
): PurchaseIntentResult {
  const nText = norm(cleanText);
  const nSig  = norm(signal);
  if (!nSig || !hasKw(nText, nSig)) return { detected: false, pattern: null };
  if (hasAnyKw(nText, CTX_EVENEMENTIEL_SUPPRESS)) return { detected: false, pattern: null };

  const esc      = nSig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sigMatch = new RegExp('\\b' + esc).exec(nText);
  if (!sigMatch) return { detected: false, pattern: null };
  const sigPos = sigMatch.index;

  const isShortSignal = nSig.length <= SHORT_SIGNAL_MAX_LEN;
  const halfWin       = isShortSignal ? SHORT_SIGNAL_WINDOW : 100;

  // Tier 1 : fenêtre autour du signal
  const win = nText.slice(Math.max(0, sigPos - halfWin),
                           Math.min(nText.length, sigPos + nSig.length + halfWin));
  for (const pat of PURCHASE_INTENT_PATTERNS) {
    if (hasKw(win, pat)) return { detected: true, pattern: pat };
  }

  // Tier 2 : désactivé pour les signaux courts (GD-028)
  if (!isShortSignal) {
    const textStart = nText.slice(0, 60);
    for (const pat of PURCHASE_INTENT_PATTERNS) {
      if (hasKw(textStart, pat)) return { detected: true, pattern: pat };
    }
  }

  return { detected: false, pattern: null };
}

/**
 * Détecte un contexte générique hors périmètre d'achat.
 * Neutralisé si un pattern d'achat explicite est présent.
 */
export function detectOutOfScopeContext(cleanText: string): OutOfScopeResult {
  const nText = norm(cleanText);
  if (hasAnyKw(nText, OUT_OF_SCOPE_BYPASS)) return { blocked: false, reason: null };
  for (const pat of OUT_OF_SCOPE_PATTERNS) {
    if (hasKw(nText, pat)) return { blocked: true, reason: 'contexte hors périmètre : ' + pat };
  }
  return { blocked: false, reason: null };
}
