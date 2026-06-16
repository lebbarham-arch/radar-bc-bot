/**
 * context-guards.ts
 *
 * Guards de contexte pour le shadow scoring clean.
 * Shadow uniquement — aucun effet sur le matching legacy ni les notifications.
 *
 * Fonctions exportées :
 *   normSignal(s)                                      → normalise un signal (accents, casse)
 *   shadowContextGuardBlocked(normSig, cleanText)      → true si signal ignoré pour ce texte
 *   explainShadowContextGuard(normSig, cleanText)      → { blocked, reason, signal }
 *
 * Port TypeScript de _normSignal + _shadowContextGuardBlocked (radar-bc-bot.js).
 * La version CommonJS (context-guards.runtime.js) est utilisée par radar-bc-bot.js.
 * Maintenir les deux fichiers en sync lors de toute modification des guards.
 *
 * Règle fondamentale :
 *   shadowContextGuardBlocked(...) === true  → signal BLOQUÉ (pas de score shadow)
 *   shadowContextGuardBlocked(...) === false → signal ÉLIGIBLE au scoring shadow
 *   Aucun effet sur le matching legacy ni sur les notifications.
 */

// ─── Helpers internes ────────────────────────────────────────────────────────
// Copies fidèles de norm(), hasKw(), levenshtein(), hasKwFuzzy(), hasAnyKw()
// de radar-bc-bot.js. Pas d'import depuis @core/scoring/matchers pour éviter
// le couplage croisé et garantir un comportement identique au bot.

/** Normalise un texte : bas de casse, sans accents, sans ponctuation. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Teste si `kw` est présent dans `text` avec frontière de mot (\b). */
function hasKw(text: string, kw: string): boolean {
  const nk = norm(kw);
  if (!nk) return false;
  const esc = nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + esc).test(norm(text));
}

/** Distance de Levenshtein — deux rangées roulantes. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  if (a === b) return 0;
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  let curr: number[] = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const sub = (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      curr[j] = Math.min(sub, del, ins);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/**
 * Matching exact + fuzzy Levenshtein.
 * GD-021 : mots courts ≤ 5 chars = exact uniquement.
 * GD-022 : première lettre doit correspondre.
 */
function hasKwFuzzy(text: string, kw: string): boolean {
  if (hasKw(text, kw)) return true;
  const nk = norm(kw);
  if (nk.length <= 5) return false;
  const maxDist = nk.length >= 8 ? 2 : 1;
  return norm(text).split(/\s+/).some((w) => {
    const w0  = w[0];
    const nk0 = nk[0];
    return (
      Math.abs(w.length - nk.length) <= maxDist + 1 &&
      w0 !== undefined && nk0 !== undefined && w0 === nk0 &&
      levenshtein(w, nk) <= maxDist
    );
  });
}

/** Retourne true si au moins un terme de `terms` matche `text`. */
function hasAnyKw(text: string, terms: string[]): boolean {
  return terms.some((t) => t.length > 0 && hasKwFuzzy(text, t));
}

// ─── Type publique ────────────────────────────────────────────────────────────

/**
 * Résultat explicable d'un guard de contexte shadow.
 * blocked : même valeur que shadowContextGuardBlocked().
 * reason  : description courte du motif de blocage, null si non bloqué.
 * signal  : signal normalisé tel que passé à la fonction.
 */
export interface ShadowGuardExplanation {
  blocked: boolean;
  reason:  string | null;
  signal:  string;
}

// ─── Moteur interne ───────────────────────────────────────────────────────────

/**
 * Évalue un guard et retourne { blocked, reason }.
 * Source unique de vérité — shadowContextGuardBlocked et
 * explainShadowContextGuard délèguent toutes deux ici.
 */
function _explainGuard(ns: string, cleanText: string): { blocked: boolean; reason: string | null } {
  // ── 1. "reseau" — exige contexte informatique ───────────────────────────
  if (ns === 'reseau') {
    const IT_CTX = [
      'systeme d information', 'systeme informatique', 'audit si',
      'informatique', 'reseau informatique',
      'securite informatique', 'lan', 'switch', 'routeur', 'serveur',
      'poste de travail', 'ordinateur',
    ];
    return hasAnyKw(cleanText, IT_CTX)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte informatique absent' };
  }
  // ── 2. "scanner" — usage verbal admin ou hors achat scanner matériel ────
  if (ns === 'scanner') {
    const VERB_SCANNER = [
      'scanner et envoyer', 'a scanner et envoyer', 'scanner puis envoyer',
      'scanner le document',
    ];
    if (hasAnyKw(cleanText, VERB_SCANNER)) {
      return { blocked: true, reason: 'usage verbal scanner détecté' };
    }
    const HARDWARE_SCANNER = [
      'achat de scanner', 'acquisition de scanner', 'fourniture de scanner',
      'scanners', 'acquisition scanner', 'achat scanner',
    ];
    return hasAnyKw(cleanText, HARDWARE_SCANNER)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte achat scanner absent' };
  }
  // ── 3. "pc" — exige un contexte matériel PC explicite (GD-032) ─────────
  // Historique : `informatique`, `bureautique`, `logiciel`, `licence`, `serveur`,
  // `imprimante`, `reseau informatique`, `maintenance informatique` retirés car
  // trop génériques — apparaissent dans noms d'organisme, catégories client et
  // navigation de page même sans relation avec un achat de PC.
  // Ne pas revenir en arrière sans données admin review justifiant le cas.
  if (ns === 'pc') {
    const IT_CTX_PC = [
      'ordinateur',              // hardware sans ambiguïté
      'poste de travail',        // hardware sans ambiguïté (singulier)
      'postes de travail',       // idem pluriel
      'poste pc',                // auto-référentiel explicite
      'postes pc',               // idem pluriel
      'materiel informatique',   // achat matériel — multi-token, peu de bruit
      'equipement informatique', // idem
      'unite centrale',          // composant PC explicite
      'pc portable',             // self-referential + type explicite
      'pc fixe',                 // idem
      'achat de pc',             // contexte achat explicite
      'acquisition de pc',       // idem
      'fourniture de pc',        // idem
    ];
    return hasAnyKw(cleanText, IT_CTX_PC)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte matériel PC absent' };
  }
  // ── 4. "produits alimentaires" — exige contexte d'achat alimentaire ─────
  if (ns === 'produits alimentaires') {
    const FOOD_PURCHASE = [
      'achat de produits alimentaires', 'achat des produits alimentaires',
      'achat produits alimentaires',
      'acquisition de produits alimentaires',
      'fourniture de produits alimentaires',
      'fourniture de denrees alimentaires',
      'achat de denrees', 'achat des denrees',
      'denrees alimentaires',
      'alimentation humaine', 'usage humain',
    ];
    return hasAnyKw(cleanText, FOOD_PURCHASE)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte achat alimentaire absent' };
  }
  // ── 5. "alimentation" — bloquer animale, exiger contexte humain ─────────
  if (ns === 'alimentation') {
    const ANIMAL_CTX = [
      'betail', 'fourrage', 'alimentation animale', 'alimentation de betail',
      'aliment compose', 'bovin', 'ovin', 'caprin', 'elevage',
    ];
    if (hasAnyKw(cleanText, ANIMAL_CTX)) {
      return { blocked: true, reason: 'contexte animal détecté' };
    }
    const HUMAN_CTX = [
      'reception', 'evenement', 'ceremonie', 'invite', 'convives',
      'traiteur', 'repas', 'restauration', 'cantine',
      'usage humain', 'produits alimentaires', 'denrees',
    ];
    return hasAnyKw(cleanText, HUMAN_CTX)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte humain absent' };
  }
  // ── 6. "hygiene" — exige produits/services d'hygiène concrets ───────────
  if (ns === 'hygiene') {
    const HYGIENE_PRODUCT_CTX = [
      'produits chimiques', 'produit chimique',
      'produits d hygiene', 'produit d hygiene',
      'nettoyage', 'desinfection', 'deratisation', 'desinsectisation',
      'insecticide', 'savon', 'detergent', 'desinfectant',
      'pesticide', 'produits menagers',
    ];
    return hasAnyKw(cleanText, HYGIENE_PRODUCT_CTX)
      ? { blocked: false, reason: null }
      : { blocked: true,  reason: 'contexte produits hygiène absent' };
  }
  // Signal inconnu — aucun guard actif
  return { blocked: false, reason: null };
}

// ─── API publique ─────────────────────────────────────────────────────────────

/**
 * Normalise un signal pour la déduplication.
 * Bas de casse + sans accents + espaces normalisés (sans supprimer la ponctuation).
 * Miroir de _normSignal (radar-bc-bot.js).
 */
export function normSignal(s: string): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Guard de contexte shadow clean.
 * Retourne true si le signal doit être IGNORÉ pour ce texte (guard actif).
 * Shadow uniquement — aucun effet sur le matching legacy ni les notifications.
 *
 * Miroir de _shadowContextGuardBlocked (radar-bc-bot.js).
 *
 * @param ns        Signal normalisé (sortie de normSignal).
 * @param cleanText Texte du BC nettoyé (sortie de buildCleanMatchText).
 */
export function shadowContextGuardBlocked(ns: string, cleanText: string): boolean {
  return _explainGuard(ns, cleanText).blocked;
}

/**
 * Version explicable du guard de contexte shadow.
 * Retourne les mêmes décisions que shadowContextGuardBlocked, plus un motif lisible.
 * Shadow uniquement — aucun effet sur le matching legacy ni les notifications.
 *
 * @param ns        Signal normalisé (sortie de normSignal).
 * @param cleanText Texte du BC nettoyé.
 * @returns { blocked, reason, signal }
 *   blocked : true → signal ignoré, false → signal éligible au scoring
 *   reason  : motif de blocage (non nul ssi blocked=true)
 *   signal  : ns tel que reçu
 */
export function explainShadowContextGuard(ns: string, cleanText: string): ShadowGuardExplanation {
  const { blocked, reason } = _explainGuard(ns, cleanText);
  return { blocked, reason, signal: ns };
}

// ─── Couche générique de contextualisation des signaux faibles ───────────────

/**
 * Familles de contexte parasite — détectées pour bloquer les signaux faibles
 * qui ne correspondent pas à un vrai marché d’achat.
 * Ne jamais appliquer aux signaux principaux (critère.valeur) : réservé aux
 * inclusions (signaux faibles, ai_inclusions).
 */

/** Contextes événementiels : réceptions, cérémonies, inaugurations. */
const CTX_EVENEMENTIEL: string[] = [
  'reception', 'ceremonie', 'manifestation', 'inauguration',
  'banquet', 'gala', 'convives', 'buffet', 'cocktail', 'soiree',
];

/** Contextes impression / communication / diffusion. */
const CTX_COMMUNICATION: string[] = [
  'impression diffusion', 'impression et diffusion', 'edition diffusion',
  'conception graphique', 'plaquette', 'brochure',
  'communication institutionnelle', 'diffusion au profit',
];

/** Contextes étude technique / travaux bâtiment. */
const CTX_ETUDE_TRAVAUX: string[] = [
  'etude technique', 'diagnostic technique', 'audit energetique',
  'maitrise d oeuvre', 'travaux d amenagement', 'rehabilitation batiment',
  'renovation batiment', 'construction batiment',
];

/** Contextes bruit portail / développement web. */
const CTX_PORTAIL: string[] = [
  'portail internet', 'site internet', 'site web', 'application mobile',
  'developpement web', 'portail electronique', 'developpement informatique',
];

/**
 * Bypass cœur métier — actif UNIQUEMENT quand CTX_EVENEMENTIEL est détecté.
 * “achat” seul ne suffit PAS : “Achat produits alimentaires pour réception” doit rester
 * bloqué. Seul un contexte d’usage quotidien/collectif lève le blocage.
 */
const CORE_BUSINESS_BYPASS: string[] = [
  'usage humain', 'alimentation humaine',
  'cantine', 'restaurant scolaire', 'restauration collective', 'restauration scolaire',
  'internat', 'pensionnat',
  'cuisine', 'repas', 'dejeuner', 'diner',
  'approvisionnement regulier', 'stock alimentaire',
];

/**
 * Bypass achat simple — utilisé uniquement hors contexte événementiel.
 * Protège les achats cœur métier pour les familles communication, étude/travaux et portail.
 */
const SIMPLE_PURCHASE_BYPASS: string[] = [
  'achat', 'acquisition', 'fourniture', 'approvisionnement',
];

/**
 * Guard de contexte faible — couche générique applicable UNIQUEMENT aux
 * signaux d’inclusion (faibles), pas aux valeurs principales (critère.valeur).
 *
 * Règle :
 *   CTX_EVENEMENTIEL détecté — “achat” NE débloque PAS (faux positif courant).
 *   Seul CORE_BUSINESS_BYPASS (cantine, usage humain, internat…) lève le blocage.
 *   Pour les autres familles (communication, étude, portail),
 *   SIMPLE_PURCHASE_BYPASS (achat, fourniture…) suffit.
 *
 * Familles de contexte parasite détectées :
 *   • CTX_EVENEMENTIEL  : réception, cérémonie, manifestation, …
 *   • CTX_COMMUNICATION : impression/diffusion, plaquette, brochure, …
 *   • CTX_ETUDE_TRAVAUX : étude technique, diagnostic, audit énergétique, …
 *   • CTX_PORTAIL       : portail internet, site web, application mobile, …
 *
 * Shadow uniquement — aucun effet sur le matching legacy ni les notifications.
 */
export function shadowWeakContextBlocked(ns: string, cleanText: string): ShadowGuardExplanation {
  // —— 1. Contexte événementiel : “achat” seul NE débloque PAS ——————————————————————
  // “Achat produits alimentaires pour réception” = faux positif — doit être bloqué.
  // Seul un contexte cœur métier (cantine, internat, usage humain…) lève le blocage.
  if (hasAnyKw(cleanText, CTX_EVENEMENTIEL)) {
    return hasAnyKw(cleanText, CORE_BUSINESS_BYPASS)
      ? { blocked: false, reason: null, signal: ns }
      : { blocked: true, reason: 'signal faible + contexte événementiel', signal: ns };
  }
  // —— 2–4. Familles sans événementiel : bypass achat simple suffit ————————————
  if (hasAnyKw(cleanText, SIMPLE_PURCHASE_BYPASS)) {
    return { blocked: false, reason: null, signal: ns };
  }
  if (hasAnyKw(cleanText, CTX_COMMUNICATION)) {
    return { blocked: true, reason: 'signal faible + contexte impression/communication', signal: ns };
  }
  if (hasAnyKw(cleanText, CTX_ETUDE_TRAVAUX)) {
    return { blocked: true, reason: 'signal faible + contexte étude/travaux', signal: ns };
  }
  if (hasAnyKw(cleanText, CTX_PORTAIL)) {
    return { blocked: true, reason: 'signal faible + bruit portail', signal: ns };
  }
  return { blocked: false, reason: null, signal: ns };
}
