/**
 * ONB — Generic Criteria Label Guard
 *
 * Valide le champ `valeur` (label principal) d'un critère avant activation.
 *
 * Règle : un label seul trop générique génère du bruit excessif.
 * Un label contextualisé par un deuxième terme métier est accepté.
 *
 * Exemples :
 *   "eau"        seul → block    | "eau potable"         → ok
 *   "maintenance" seul → block   | "maintenance informatique" → ok
 *   "café"       seul → warn     | "café moulu"           → ok
 *   "informatique" seul → warn   | "matériel informatique" → ok
 *   "toner"      seul → ok       (spécifique, pas dans les listes)
 *
 * Contraintes absolues :
 *   - Aucun appel IA
 *   - Aucune écriture DB
 *   - Aucune modification du scoring
 *   - Aucune modification de radar-bc-bot.js
 *   - Pas de règle spécifique à un client_id
 */

// ─── Listes de labels ─────────────────────────────────────────────────────────

/**
 * Labels bloquants si utilisés seuls.
 * Termes tellement génériques qu'ils matchent tout un secteur entier.
 */
export const BLOCK_LABELS: ReadonlySet<string> = new Set([
  'eau',
  'maintenance',
  'matériel',
  'materiel',
  'travaux',
  'fourniture',
  'fournitures',
  'produit',
  'produits',
  'service',
  'services',
  'équipement',
  'equipement',
]);

/**
 * Labels à warning fort si utilisés seuls.
 * Termes ambigus selon le contexte — acceptés mais signalés.
 */
export const WARN_LABELS: ReadonlySet<string> = new Set([
  'informatique',
  'café',
  'cafe',
  'nettoyage',
  'sécurité',
  'securite',
  'transport',
  'formation',
  'consommable',
  'consommables',
  'cartouche',
  'support',
  'filtre',
  'câble',
  'cable',
  'poste',
]);

// ─── Type résultat ────────────────────────────────────────────────────────────

export interface LabelGuardResult {
  level:        'ok' | 'warn' | 'block';
  reason?:      string;
  suggestions?: string[];
}

// ─── Normalisation interne ────────────────────────────────────────────────────

function normalizeLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // supprime les diacritiques
    .replace(/\s+/g, ' ');
}

/**
 * Retourne true si le label normalisé est exactement un mot de la liste
 * (ou son pluriel direct : +s, +es, +x).
 */
function isBareMatch(normalized: string, term: string): boolean {
  if (normalized === term) return true;
  if (normalized === term + 's')  return true;
  if (normalized === term + 'es') return true;
  if (normalized === term + 'x')  return true;
  return false;
}

/**
 * Vérifie si le label normalisé est "seul" — c'est-à-dire qu'il ne contient
 * qu'un seul token significatif (le terme générique).
 * Un label multi-mots est toujours contextualisé.
 */
function isSingleToken(normalized: string): boolean {
  return !normalized.includes(' ');
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Valide le label principal (`valeur`) d'un critère ONB.
 *
 * @param valeur           Label à valider (champ `valeur` du critère)
 * @param options.domain_category  Domaine métier optionnel (non utilisé actuellement,
 *                                 réservé pour extension future)
 * @returns                LabelGuardResult { level, reason?, suggestions? }
 */
export function validateCritereLabel(
  valeur: string,
  options?: { domain_category?: string },
): LabelGuardResult {
  if (!valeur || valeur.trim() === '') {
    return {
      level:  'block',
      reason: 'Le label est vide — un critère doit avoir un valeur non vide.',
    };
  }

  const normalized = normalizeLabel(valeur);

  // Label multi-mots → toujours contextualisé → ok
  if (!isSingleToken(normalized)) {
    return { level: 'ok' };
  }

  // Vérifier dans BLOCK_LABELS (insensible aux diacritiques)
  for (const term of BLOCK_LABELS) {
    const termNorm = normalizeLabel(term);
    if (isBareMatch(normalized, termNorm)) {
      return {
        level:  'block',
        reason: `"${valeur}" est un terme trop générique seul — il matcherait trop de BCs non pertinents.`,
        suggestions: [
          `${valeur} [qualificatif métier]`,
          `Exemple : "${valeur} potable", "${valeur} industrielle", "${valeur} de bureau"`,
        ],
      };
    }
  }

  // Vérifier dans WARN_LABELS
  for (const term of WARN_LABELS) {
    const termNorm = normalizeLabel(term);
    if (isBareMatch(normalized, termNorm)) {
      return {
        level:  'warn',
        reason: `"${valeur}" seul est ambigu et peut générer du bruit — pensez à le qualifier.`,
        suggestions: [
          `${valeur} [qualificatif métier]`,
          `Exemple : "${valeur} moulu", "${valeur} en grains", "${valeur} réseau"`,
        ],
      };
    }
  }

  return { level: 'ok' };
}

// ─── Activation guard ─────────────────────────────────────────────────────────

export interface ActivationInput {
  /** Label principal du critère (champ `valeur`) */
  valeur: string;
  /**
   * Inclusions métier déjà définies sur ce critère.
   * Si le label est warn, au moins une inclusion forte débloque l'activation.
   */
  ai_inclusions?: string[];
  /** Inclusions manuelles définies par l'opérateur */
  manual_inclusions?: string[];
}

export interface ActivationResult {
  /** true = critère autorisé à être activé */
  allowed:      boolean;
  /** Niveau de la décision */
  level:        'ok' | 'warn' | 'block';
  /** Raison lisible par humain / interface */
  reason:       string;
  /** Suggestions affichables dans le workflow d'onboarding (absent si pas de suggestion) */
  suggestions?: string[] | undefined;
}

/**
 * Détermine si un critère peut être activé (envoyé en production).
 *
 * Règles :
 *  - Si le label est `block` → jamais activable, quelle que soit la liste d'inclusions.
 *  - Si le label est `warn` :
 *      - Au moins une inclusion métier (ai ou manuelle, ≥ 5 chars, non générique) → allowed.
 *      - Sinon → refusé avec suggestion d'ajouter des inclusions.
 *  - Si le label est `ok` → toujours allowed.
 *
 * Contraintes absolues :
 *  - Aucun appel IA, aucune écriture DB.
 *  - Pas de règle spécifique à un client_id.
 */
export function canActivateCriterion(input: ActivationInput): ActivationResult {
  const guard = validateCritereLabel(input.valeur);

  if (guard.level === 'block') {
    const blockResult: ActivationResult = {
      allowed: false,
      level:   'block',
      reason:  guard.reason
        ?? `"${input.valeur}" est un critère trop générique et ne peut pas être activé tel quel.`,
    };
    if (guard.suggestions) blockResult.suggestions = guard.suggestions;
    return blockResult;
  }

  if (guard.level === 'warn') {
    const allInclusions = [
      ...(input.ai_inclusions     ?? []),
      ...(input.manual_inclusions ?? []),
    ];

    // Une inclusion est considérée "forte" si elle a ≥ 5 chars
    // et n'est pas elle-même un terme générique de la liste BLOCK/WARN
    const hasStrongInclusion = allInclusions.some(inc => {
      const incNorm = normalizeLabel(inc);
      if (incNorm.length < 5) return false;
      for (const t of BLOCK_LABELS) {
        if (isBareMatch(incNorm, normalizeLabel(t))) return false;
      }
      for (const t of WARN_LABELS) {
        if (isBareMatch(incNorm, normalizeLabel(t))) return false;
      }
      return true;
    });

    if (hasStrongInclusion) {
      return {
        allowed: true,
        level:   'warn',
        reason:  `"${input.valeur}" est ambigu mais des inclusions métier fortes sont présentes.`,
      };
    }

    const warnResult: ActivationResult = {
      allowed: false,
      level:   'warn',
      reason:  guard.reason
        ?? `"${input.valeur}" est ambigu — ajoutez des inclusions métier pour l'activer.`,
    };
    if (guard.suggestions) warnResult.suggestions = guard.suggestions;
    return warnResult;
  }

  // level === 'ok'
  return {
    allowed: true,
    level:   'ok',
    reason:  `"${input.valeur}" est un critère suffisamment précis.`,
  };
}
