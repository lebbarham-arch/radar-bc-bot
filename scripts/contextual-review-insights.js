'use strict';

/**
 * scripts/contextual-review-insights.js — GD-035
 *
 * Analyse contextuelle pour les candidats review (shadow/local uniquement).
 * Croise le texte du BC, les signaux, la décision humaine et le profil client.
 *
 * Principes :
 *  - Aucun appel réseau, aucun secret.
 *  - Rule-based déterministe.
 *  - Familles de contexte GÉNÉRIQUES — aucune règle spécifique à un signal ou client.
 *  - Produit une proposition d'apprentissage consultative uniquement.
 *  - Ne modifie jamais auto_notify_candidate, review_candidate, ni le scoring.
 *  - Jamais de règle globale ("toujours rejeter X", "toujours accepter X").
 *  - La décision finale reste humaine.
 *
 * Usage :
 *   var ctx = require('./contextual-review-insights');
 *   var result = ctx.analyzeReviewContext(entry, clientProfile, decision, opts);
 */

var CONTEXT_MODEL = 'rule-based-context-v1';

// ── Familles de contexte génériques ──────────────────────────────────────────
// Détectées par termes génériques dans le texte — aucune règle signal/client.
// Les termes sont normalisés (sans accents) pour le matching.
var CONTEXT_FAMILIES = [
  {
    key:   'food_or_beverage',
    label: 'food_or_beverage_context',
    terms: [
      'cafe', 'cafes', 'boisson', 'boissons', 'denree', 'denrees',
      'restauration', 'cantine', 'refectoire', 'alimentation', 'alimentaire',
      'epicerie', 'traiteur', 'boulangerie', 'patisserie', 'laitier', 'laitiere',
      'agro', 'agroalimentaire', 'froid alimentaire', 'produits alimentaires',
      'viande', 'poisson', 'volaille', 'boissons fraiches', 'jus de fruit',
    ],
  },
  {
    key:   'medical_admin',
    label: 'medical_admin_context',
    terms: [
      'medical', 'medicament', 'medicaments', 'chirurgie', 'hopital',
      'soins', 'clinique', 'pharmacie', 'laboratoire', 'radiologie',
      'urgence', 'urgences', 'chp', 'chu', 'chru', 'ehpad',
      'medico', 'sanitaire', 'paramedicaux', 'kinesitherapie',
      'materiel medical', 'materiel medico', 'medico technique',
      'unite medicale', 'unite de soins', 'bloc operatoire',
      'dms', 'dmsps',
    ],
  },
  {
    key:   'cleaning_disinfection',
    label: 'cleaning_disinfection_context',
    terms: [
      'nettoyage', 'desinfection', 'insecticide', 'insecticides',
      'detergent', 'detergents', 'produit entretien', 'savon', 'savons',
      'desinfectant', 'desinfectants', 'deratisation', 'desinsectisation',
      'nettoyant', 'nettoyants', 'menager', 'menagere', 'hygiene menagere',
      'proprete', 'lavage', 'decapage', 'biocide', 'biocides',
      'detartrant', 'detartrants', 'nettoiement', 'entretien locaux',
    ],
  },
  {
    key:   'office_supplies',
    label: 'office_supplies_context',
    terms: [
      'fourniture', 'fournitures', 'papier', 'stylo', 'stylos',
      'cartouche', 'cartouches', 'encre', 'imprimante', 'imprimantes',
      'ramette', 'classeur', 'classeurs', 'reliure', 'agenda', 'cahier',
      'toner', 'papeterie', 'consommable', 'consommables de bureau',
    ],
  },
  {
    key:   'it',
    label: 'it_context',
    terms: [
      'logiciel', 'logiciels', 'serveur', 'serveurs', 'informatique',
      'reseau', 'reseaux', 'cloud', 'saas', 'application', 'systeme',
      'ordinateur', 'ordinateurs', 'licence', 'licences', 'progiciel',
      'erp', 'crm', 'maintenance informatique', 'photocopieur',
      'photocopieurs', 'infrastructure informatique',
    ],
  },
  {
    key:   'event',
    label: 'event_context',
    terms: [
      'manifestation', 'ceremonie', 'seminaire', 'colloque',
      'gala', 'vernissage', 'cocktail', 'banquet', 'soiree evenementielle',
      'evenement', 'evenements', 'reception evenementielle',
    ],
  },
  {
    key:   'construction_or_works',
    label: 'construction_or_works_context',
    terms: [
      'travaux', 'construction', 'batiment', 'maconnerie', 'peinture',
      'renovation', 'revetement', 'genie civil', 'infrastructure',
      'amenagement', 'terrassement', 'plomberie', 'electricite',
      'charpente', 'toiture', 'facade', 'btp', 'vrd', 'voirie',
    ],
  },
];


// ── Conversion générique d'une valeur profil en texte cherchable ─────────────
// Évite que String({...}) donne "[object Object]".
// - string/number/boolean → String(value)
// - array → éléments récursifs concaténés
// - object → valeurs récursives concaténées (pas les clés — éviter le bruit)
// - null/undefined → ""
// - Limite de profondeur pour se prémunir de structures cycliques
function valueToSearchText(value, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 6) return '';                          // sécurité profondeur
  if (value === null || value === undefined) return '';
  var t = typeof value;
  if (t === 'string')  return value;
  if (t === 'number' || t === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map(function(v) { return valueToSearchText(v, depth + 1); }).join(' ');
  }
  if (t === 'object') {
    return Object.keys(value).map(function(k) {
      return valueToSearchText(value[k], depth + 1);
    }).join(' ');
  }
  return '';
}

// ── Normalisation ─────────────────────────────────────────────────────────────
function normText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/['’‘]/g, ' ') // apostrophes → espace
    .replace(/[-_]/g, ' ')            // tirets → espace
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Détection de familles dans un texte ──────────────────────────────────────
// Retourne { familyKey: [termes trouvés], ... }
function detectFamiliesInText(text) {
  var norm   = normText(text);
  var result = {};
  CONTEXT_FAMILIES.forEach(function(fam) {
    var found = [];
    fam.terms.forEach(function(term) {
      var normTerm = normText(term);
      if (!normTerm) return;
      if (normTerm.length >= 5) {
        // Sous-chaîne (terme ≥ 5 chars)
        if (norm.indexOf(normTerm) !== -1) found.push(term);
      } else {
        // Terme court : vérifier les limites de mot
        var escaped = normTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var re = new RegExp('(^|\\s)' + escaped + '(\\s|$)');
        if (re.test(norm)) found.push(term);
      }
    });
    if (found.length > 0) result[fam.key] = found;
  });
  return result;
}

// ── Détection du profil client ────────────────────────────────────────────────
function detectClientProfileFamilies(clientProfile) {
  if (!clientProfile) return {};
  // Utiliser valueToSearchText pour gérer string, array, objet imbriqué
  var profileText = [
    valueToSearchText(clientProfile.client_name),
    valueToSearchText(clientProfile.business_profile),
    valueToSearchText(clientProfile.technical_profile),
    valueToSearchText(clientProfile.criteres),
    valueToSearchText(clientProfile.ai_inclusions),
    valueToSearchText(clientProfile.exclusions),
  ].join(' ');
  return detectFamiliesInText(profileText);
}

// ── Calcul de l'alignement profil/contexte ────────────────────────────────────
// "high"   : la majorité des familles BC est couverte par le profil
// "medium" : au moins une famille en commun, mais pas la majorité
// "low"    : aucune famille en commun (contexte hors profil)
// "unclear": profil ou contexte BC non identifiable
function computeProfileAlignment(bcFamilies, profileFamilies) {
  var bcKeys   = Object.keys(bcFamilies   || {});
  var profKeys = Object.keys(profileFamilies || {});
  if (profKeys.length === 0 || bcKeys.length === 0) return 'unclear';
  var overlap = bcKeys.filter(function(k) { return profKeys.indexOf(k) !== -1; });
  if (overlap.length === 0) return 'low';
  if (overlap.length >= Math.ceil(bcKeys.length * 0.5)) return 'high';
  return 'medium';
}

// ── Calcul de l'ambiguïté contextuelle ───────────────────────────────────────
// "low"    : 1 famille — contexte clair
// "medium" : 2 familles — contexte partagé
// "high"   : 0 ou 3+ familles — contexte absent ou très mixte
function computeContextAmbiguity(bcFamilies) {
  var n = Object.keys(bcFamilies || {}).length;
  if (n === 1) return 'low';
  if (n === 2) return 'medium';
  return 'high'; // 0 ou 3+
}

// ── Calcul de la confiance contextuelle ──────────────────────────────────────
// "high" jamais émis (trop risqué en mode rule-based sans LLM)
// "medium" : contexte clair + décision connue + profil connu
// "low"    : sinon
function computeContextConfidence(decision, profileAlignment, ambiguity) {
  if (ambiguity === 'high')           return 'low';
  if (profileAlignment === 'unclear') return 'low';
  if (!decision || !decision.trim())  return 'low';
  // Avec décision + profil connu + contexte clair → medium
  return 'medium';
}

// ── should_create_context_hint ────────────────────────────────────────────────
function computeShouldCreateHint(decision, profileAlignment, ambiguity, hintBlock, posTerms, negTerms) {
  var dec = (decision || '').toLowerCase().trim();
  if (!dec)                   return false; // pas de décision → jamais
  if (hintBlock && !dec)     return false; // hint_block_auto + vide → jamais
  if (dec === 'ignore')       return false; // ignore → par défaut non
  if (ambiguity === 'high')   return false; // contexte trop ambigu
  if (profileAlignment === 'unclear') return false; // profil inconnu

  if (dec === 'reject') {
    // Reject valide seulement si contexte en désaccord clairement identifié
    return negTerms.length >= 1 &&
           (profileAlignment === 'low' || profileAlignment === 'medium');
  }
  if (dec === 'keep') {
    // Keep valide seulement si contexte aligné clairement identifié
    return posTerms.length >= 1 &&
           (profileAlignment === 'high' || profileAlignment === 'medium');
  }
  return false;
}

// ── Génération du hint contextuel ────────────────────────────────────────────
// Le hint est toujours contextuel et prudent.
// Jamais : "toujours rejeter X" ou "toujours accepter X".
function buildLearnableHint(decision, bcFamilies, profileFamilies, posTerms, negTerms) {
  var dec = (decision || '').toLowerCase().trim();

  var bcFamLabels = CONTEXT_FAMILIES
    .filter(function(f) { return bcFamilies[f.key]; })
    .map(function(f) { return f.label; });
  var profFamLabels = CONTEXT_FAMILIES
    .filter(function(f) { return profileFamilies[f.key]; })
    .map(function(f) { return f.label; });

  if (!dec) {
    if (bcFamLabels.length > 0) {
      return 'Contexte détecté : ' + bcFamLabels.join(', ') + '. ' +
             'Vérifier si ce contexte correspond au profil attendu avant de décider. ' +
             'Un historique de décisions permettra de formuler un hint contextuel plus précis.';
    }
    return 'Aucun contexte métier clairement identifié. Revue manuelle recommandée.';
  }

  if (dec === 'reject') {
    var negDisp = negTerms.length > 0
      ? ' (ex : ' + negTerms.slice(0, 3).join(', ') + ')'
      : '';
    var profLabel = profFamLabels.length > 0
      ? ' — profil principal : ' + profFamLabels.join(', ')
      : '';
    return 'Dégrader ce signal quand le contexte contient des termes hors profil' + negDisp +
           profLabel + '. ' +
           'Vérifier la nature du BC avant toute généralisation : ' +
           'ce signal peut rester pertinent dans un contexte différent.';
  }

  if (dec === 'keep') {
    var posDisp = posTerms.length > 0
      ? ' (ex : ' + posTerms.slice(0, 3).join(', ') + ')'
      : '';
    var profLabelK = profFamLabels.length > 0
      ? ' correspondant au profil ' + profFamLabels.join(', ')
      : '';
    return 'Renforcer ce signal quand il apparaît avec des termes contextuels pertinents' + posDisp +
           profLabelK + '. ' +
           'Ce contexte confirme l\'adéquation avec le profil client.';
  }

  if (dec === 'ignore') {
    return 'BC ignoré : contexte hors scope ou signal trop faible dans ce contexte. ' +
           'Ne pas généraliser : ce signal peut être pertinent dans un contexte différent.';
  }

  return 'Décision "' + decision + '" non reconnue. Revue manuelle recommandée.';
}

// ── Fonction principale ───────────────────────────────────────────────────────
/**
 * Analyse contextuelle d'un candidat review.
 *
 * @param {object} entry          — candidat enrichi (champs shadow JSON clean_only[])
 * @param {object} clientProfile  — profil client { client_name, business_profile, technical_profile }
 *                                  ou null si indisponible
 * @param {string} decision       — keep | reject | ignore | "" | undefined
 * @param {object} opts           — { generatedAt: string ISO }
 * @returns {object}              — champs ctx_* (voir en-tête)
 */
function analyzeReviewContext(entry, clientProfile, decision, opts) {
  opts       = opts || {};
  var genAt  = opts.generatedAt || new Date().toISOString();
  var dec    = (decision || '').toLowerCase().trim();

  // Texte du BC : excerpt + signaux actifs (sans les bloqués)
  var excerpt = entry.clean_text_excerpt || '';
  var sigs    = (entry.matched_signals || []).filter(function(s) {
    return s.indexOf('bloque(') === -1;
  });
  var bcText  = excerpt + ' ' + sigs.join(' ');

  var hintBlock = !!entry.hint_block_auto;

  // Détection des familles de contexte
  var bcFamilies      = detectFamiliesInText(bcText);
  var profileFamilies = detectClientProfileFamilies(clientProfile);

  // Termes positifs (familles BC ∩ profil) / négatifs (familles BC ∖ profil)
  var posTerms = [];
  var negTerms = [];
  if (Object.keys(profileFamilies).length > 0) {
    Object.keys(bcFamilies).forEach(function(fk) {
      var terms = bcFamilies[fk];
      if (profileFamilies[fk]) {
        posTerms = posTerms.concat(terms);
      } else {
        negTerms = negTerms.concat(terms);
      }
    });
  }

  // Métriques
  var profileAlignment  = computeProfileAlignment(bcFamilies, profileFamilies);
  var contextAmbiguity  = computeContextAmbiguity(bcFamilies);
  var contextConfidence = computeContextConfidence(dec, profileAlignment, contextAmbiguity);

  // Interprétation de la décision
  var decisionInterp;
  if (!dec || dec === '')     decisionInterp = 'needs_review';
  else if (dec === 'keep')    decisionInterp = 'accepted_context';
  else if (dec === 'reject')  decisionInterp = 'rejected_context';
  else if (dec === 'ignore')  decisionInterp = 'ignored_context';
  else                        decisionInterp = 'needs_review';

  // Familles détectées
  var detectedLabels = CONTEXT_FAMILIES
    .filter(function(f) { return bcFamilies[f.key]; })
    .map(function(f) { return f.label; });

  // why_it_matched
  var whyMatched;
  if (sigs.length > 0 && posTerms.length > 0) {
    whyMatched = 'Signal(s) (' + sigs.join(', ') + ') dans un contexte aligné avec le profil ' +
                 '(' + posTerms.slice(0, 3).join(', ') + ').';
  } else if (sigs.length > 0 && detectedLabels.length > 0) {
    whyMatched = 'Signal(s) détecté(s) : ' + sigs.join(', ') +
                 '. Contexte identifié : ' + detectedLabels.join(', ') + '.';
  } else if (sigs.length > 0) {
    whyMatched = 'Signal(s) détecté(s) : ' + sigs.join(', ') + '. Contexte métier non clairement identifié.';
  } else {
    whyMatched = 'Correspondance sans signal thématique identifiable — probablement hors-contexte.';
  }

  // why_it_may_be_wrong
  var whyWrong;
  if (negTerms.length > 0) {
    whyWrong = 'Contexte potentiellement hors profil : termes détectés (' +
               negTerms.slice(0, 3).join(', ') + ') appartenant à des familles ' +
               'non couvertes par le profil client.';
  } else if (hintBlock) {
    whyWrong = 'Hint client actif bloquant l\'auto-notification : ' +
               'l\'historique de décisions suggère la prudence sur ce signal.';
  } else if (contextAmbiguity === 'high') {
    whyWrong = 'Contexte ambigu ou non identifiable — risque de correspondance générique.';
  } else if (entry.weak_single_signal) {
    whyWrong = 'Signal unique de niveau secondaire — insuffisant seul pour confirmer la pertinence.';
  } else {
    whyWrong = 'Aucun indicateur fort de faux positif détecté dans le contexte.';
  }

  // Raisons de rejet/acceptation contextuelles
  var rejectionReason  = '';
  var acceptanceReason = '';
  if (negTerms.length > 0 && profileAlignment === 'low') {
    rejectionReason = 'Contexte à dominante ' + detectedLabels.join('/') +
                      ' — en dehors du profil principal du client.';
  }
  if (posTerms.length > 0 && (profileAlignment === 'high' || profileAlignment === 'medium')) {
    acceptanceReason = 'Contexte aligné avec le profil client (' +
                       posTerms.slice(0, 3).join(', ') + ').';
  }

  // Hint et should_create
  var learnableHint    = buildLearnableHint(decision, bcFamilies, profileFamilies, posTerms, negTerms);
  var shouldCreateHint = computeShouldCreateHint(
    decision, profileAlignment, contextAmbiguity, hintBlock, posTerms, negTerms
  );

  return {
    context_model:             CONTEXT_MODEL,
    context_generated_at:      genAt,
    profile_alignment:         profileAlignment,
    decision_interpretation:   decisionInterp,
    why_it_matched:            whyMatched,
    why_it_may_be_wrong:       whyWrong,
    rejection_context_reason:  rejectionReason,
    acceptance_context_reason: acceptanceReason,
    positive_context_terms:    posTerms,
    negative_context_terms:    negTerms,
    context_ambiguity:         contextAmbiguity,
    context_confidence:        contextConfidence,
    learnable_context_hint:    learnableHint,
    should_create_context_hint: shouldCreateHint,
  };
}

module.exports = {
  analyzeReviewContext:        analyzeReviewContext,
  // Exposé pour les tests et la réutilisation
  detectFamiliesInText:        detectFamiliesInText,
  detectClientProfileFamilies: detectClientProfileFamilies,
  computeProfileAlignment:     computeProfileAlignment,
  computeContextAmbiguity:     computeContextAmbiguity,
  valueToSearchText:           valueToSearchText,
  CONTEXT_FAMILIES:            CONTEXT_FAMILIES,
  CONTEXT_MODEL:               CONTEXT_MODEL,
};
