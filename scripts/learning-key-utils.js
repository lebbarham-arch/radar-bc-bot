'use strict';

/**
 * scripts/learning-key-utils.js — GD-109
 *
 * Normalisation générique des clés learning (client_key, signal_key, context_key).
 * Utilisé par les scripts d'analyse learning/review pour agréger les décisions
 * indépendamment des variantes typographiques (accents, tirets, casse).
 *
 * Règles :
 *   1. Convertit en string
 *   2. Unicode NFD → décompose les caractères accentués
 *   3. Supprime les diacritiques [̀-ͯ]
 *   4. Lowercase
 *   5. Remplace toute séquence de caractères non-alphanumériques par un espace
 *   6. Collapse les espaces multiples + trim
 *   7. Retourne "" si vide
 *
 * Aucune règle métier, aucun synonyme, aucune fusion sémantique.
 * "produits d'entretien" et "produits de nettoyage" restent distincts.
 *
 * Exemples :
 *   "Hygiène"                          → "hygiene"
 *   "Hygiene"                          → "hygiene"
 *   "Dératisation"                     → "deratisation"
 *   "Désinsectisation"                 → "desinsectisation"
 *   "TEST PROD - Nettoyage Hygiène"    → "test prod nettoyage hygiene"
 *   "TEST PROD - Nettoyage Hygiene"    → "test prod nettoyage hygiene"
 *   ""                                 → ""
 *   null / undefined                   → ""
 */

/**
 * normalizeLearningKey(value)
 * @param {*} value — valeur brute (string, null, undefined)
 * @returns {string} clé normalisée
 */
function normalizeLearningKey(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // supprime diacritiques après NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')       // remplace ponctuation/tirets/espaces multiples
    .trim();
}

module.exports = { normalizeLearningKey: normalizeLearningKey };
