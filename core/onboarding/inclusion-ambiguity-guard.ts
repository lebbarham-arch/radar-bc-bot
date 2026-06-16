/**
 * ONB-2d — Garde anti-ambiguïté des ai_inclusions
 *
 * Règle absolue :
 *   Les termes courts ambigus ne doivent JAMAIS être utilisés seuls.
 *   Ils doivent être contextualisés selon domain_category.
 *
 * Exemples :
 *   - "cartouche" seul en informatique → REJETÉ
 *   - "cartouche imprimante" en informatique → ACCEPTÉ
 *   - "cartouche fusible" en informatique → REJETÉ (contamination électricité)
 *   - "filtre" seul → REJETÉ
 *   - "câble" seul → REJETÉ
 *
 * Règles :
 *   - Jamais de règle spécifique au client_id
 *   - Jamais de modification du matching legacy
 *   - Jamais d'appel IA
 *   - Aucune écriture DB
 */

// ─── Termes ambigus à surveiller ─────────────────────────────────────────────

/**
 * Termes courts qui changent de sens selon le domaine métier.
 * Un terme de cette liste utilisé SEUL est systématiquement rejeté.
 */
export const AMBIGUOUS_TERMS: ReadonlySet<string> = new Set([
  'cartouche',
  'support',
  'filtre',
  'câble',
  'poste',
  'matériel',
  'accessoire',
  'consommable',
  'maintenance',
  'réseau',
]);

// ─── Composés autorisés par domaine ──────────────────────────────────────────

/**
 * Pour chaque terme ambigu, définit les composés (terme + qualificatif)
 * autorisés par domain_category.
 *
 * Structure : DOMAIN_COMPOUNDS[terme_ambigu][domaine] = string[]
 *
 * Un composé commençant par un terme ambigu est accepté UNIQUEMENT s'il figure
 * dans la liste du domaine courant.
 * S'il figure dans la liste d'un AUTRE domaine → contamination inter-domaine → REJETÉ.
 */
export const DOMAIN_COMPOUNDS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {

  cartouche: {
    informatique: [
      'cartouche imprimante',
      'cartouches imprimante',
      "cartouche d'encre",
      "cartouches d'encre",
      'cartouche encre',
      'cartouches encre',
      'cartouche toner',
      'cartouches toner',
    ],
    bureautique: [
      'cartouche imprimante',
      'cartouches imprimante',
      "cartouche d'encre",
      "cartouches d'encre",
      'cartouche toner',
      'cartouches toner',
    ],
    électricité: [
      'cartouche fusible',
      'cartouches fusibles',
    ],
    éclairage: [
      'cartouche fusible',
      'cartouches fusibles',
    ],
  },

  filtre: {
    cvc: [
      'filtre climatisation',
      'filtre air conditionné',
      'filtre ventilation',
      'filtre CTA',
      'filtre fan coil',
      'filtre à air',
    ],
    'traitement eau': [
      'filtre eau',
      "filtre à eau",
      'filtre osmose',
      'filtre décantation',
    ],
    hydraulique: [
      'filtre hydraulique',
      'filtre à huile',
    ],
  },

  câble: {
    informatique: [
      'câble réseau',
      'câble RJ45',
      'câble USB',
      'câble HDMI',
      'câble VGA',
      'câble fibre',
      'câbles réseau',
    ],
    'réseau informatique': [
      'câble réseau',
      'câble RJ45',
      'câble fibre optique',
      'câbles réseau',
      'câble Cat5',
      'câble Cat6',
    ],
    électricité: [
      'câble électrique',
      'câble HTA',
      'câble BT',
      'câble souterrain',
      'câbles électriques',
    ],
  },

  réseau: {
    informatique: [
      'réseau informatique',
      'réseau local',
      'réseau LAN',
      'réseau Wi-Fi',
      'réseau sans fil',
    ],
    'réseau informatique': [
      'réseau informatique',
      'réseau local',
      'réseau LAN',
    ],
    eau: [
      "réseau d'eau",
      'réseau eau potable',
      'réseau AEP',
    ],
    électricité: [
      'réseau électrique',
      'réseau HTA',
      'réseau BT',
    ],
  },
};

// ─── Résultat de validation ───────────────────────────────────────────────────

export interface InclusionValidationResult {
  valid:   boolean;
  reason?: string;
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Valide qu'une inclusion n'est pas ambiguë dans le contexte du domaine.
 *
 * Trois cas de rejet :
 *   1. Terme ambigu seul (exact match normalisé)
 *   2. Composé commençant par un terme ambigu mais absent de la liste du domaine
 *   3. Composé présent dans la liste d'un AUTRE domaine (contamination inter-domaine)
 *
 * @param term            L'inclusion à valider
 * @param domain_category Le domaine du critère (ex: "informatique", "cvc")
 */
export function validateInclusionContextualized(
  term:            string,
  domain_category: string,
): InclusionValidationResult {
  const normalized       = normalizeTerm(term);
  const normalizedDomain = domain_category.trim().toLowerCase();

  for (const ambigWord of AMBIGUOUS_TERMS) {
    // ── Cas 1 : terme ambigu seul (ou pluriel direct) ─────────────────────────
    if (isBareAmbiguous(normalized, ambigWord)) {
      return {
        valid:  false,
        reason: `"${term}" est un terme ambigu seul — contextualisez selon le domaine "${domain_category}" ` +
                `(ex: "${ambigWord} [qualificatif]")`,
      };
    }

    // ── Composé commençant par le terme ambigu ────────────────────────────────
    if (!normalizedStartsWith(normalized, ambigWord)) continue;

    const domainCompounds = DOMAIN_COMPOUNDS[ambigWord];
    if (!domainCompounds) continue; // pas de règle → laisser passer

    // ── Cas 3 : contamination inter-domaine ───────────────────────────────────
    const isInCurrentDomain = isAllowedForDomain(normalized, ambigWord, normalizedDomain, domainCompounds);
    if (isInCurrentDomain) {
      return { valid: true };
    }

    // Présent dans un autre domaine ?
    const otherDomain = findOtherDomain(normalized, ambigWord, normalizedDomain, domainCompounds);
    if (otherDomain !== null) {
      return {
        valid:  false,
        reason: `"${term}" est un composé du terme ambigu "${ambigWord}" ` +
                `associé au domaine "${otherDomain}", pas à "${domain_category}" — ` +
                `risque de faux positifs inter-domaine`,
      };
    }

    // ── Cas 2 : composé inconnu pour ce domaine ───────────────────────────────
    return {
      valid:  false,
      reason: `"${term}" commence par le terme ambigu "${ambigWord}" ` +
              `mais n'est pas dans la liste des composés autorisés pour le domaine "${domain_category}"`,
    };
  }

  return { valid: true };
}

// ─── Helpers internes ─────────────────────────────────────────────────────────

function normalizeTerm(term: string): string {
  return term.trim().toLowerCase()
    .normalize('NFC')
    .replace(/\s+/g, ' ');
}

/**
 * Vérifie si le terme normalisé EST exactement le mot ambigu (ou son pluriel direct).
 * Ex: "cartouche" → true, "cartouches" → true, "cartouche imprimante" → false
 */
function isBareAmbiguous(normalized: string, ambigWord: string): boolean {
  if (normalized === ambigWord) return true;
  // Pluriel simple (+ s ou + es ou + x)
  if (normalized === ambigWord + 's')  return true;
  if (normalized === ambigWord + 'es') return true;
  if (normalized === ambigWord + 'x')  return true;
  return false;
}

/**
 * Vérifie si le terme normalisé commence par le mot ambigu suivi d'un espace.
 */
function normalizedStartsWith(normalized: string, ambigWord: string): boolean {
  return normalized.startsWith(ambigWord + ' ') ||
         normalized.startsWith(ambigWord + 's ') ||
         normalized.startsWith(ambigWord + 'es ');
}

/**
 * Vérifie si le terme est dans la liste des composés autorisés pour le domaine courant.
 * Matching partiel : un composé autorisé peut être un préfixe du terme.
 */
function isAllowedForDomain(
  normalized:      string,
  ambigWord:       string,
  normalizedDomain: string,
  domainCompounds:  Readonly<Record<string, readonly string[]>>,
): boolean {
  for (const [dom, compounds] of Object.entries(domainCompounds)) {
    const domNorm = dom.toLowerCase();
    if (!normalizedDomain.includes(domNorm) && !domNorm.includes(normalizedDomain)) continue;
    if (compounds.some(c => normalized === c.toLowerCase() || normalized.startsWith(c.toLowerCase() + ' '))) {
      return true;
    }
  }
  return false;
}

/**
 * Cherche un domaine dans lequel le composé est autorisé (autre que le domaine courant).
 * Retourne le nom du domaine trouvé, ou null.
 */
function findOtherDomain(
  normalized:       string,
  ambigWord:        string,
  normalizedDomain: string,
  domainCompounds:  Readonly<Record<string, readonly string[]>>,
): string | null {
  for (const [dom, compounds] of Object.entries(domainCompounds)) {
    const domNorm = dom.toLowerCase();
    // Ignorer le domaine courant
    if (normalizedDomain.includes(domNorm) || domNorm.includes(normalizedDomain)) continue;
    if (compounds.some(c => normalized === c.toLowerCase() || normalized.startsWith(c.toLowerCase() + ' '))) {
      return dom;
    }
  }
  return null;
}
