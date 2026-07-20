'use strict';
/**
 * scripts/shadow-hint-impact.js
 * GD-141 — Calcul de l'impact des learning hints sur les decisions shadow.
 *
 * Module pur : sans I/O, sans effet de bord, sans dependances externes.
 * Utilise par analyze-shadow-report.js (section IMPACT DES LEARNING HINTS).
 *
 * Seuils identiques au replay shadow :
 *   CLEAN_STRONG_THRESHOLD = 15  (auto-notify)
 *   CLEAN_WEAK_THRESHOLD   = 5   (review)
 *
 * Formule :
 *   baseline_score   = clean_score          (score AVANT hints)
 *   hint_adjustment  = hint_score_adj || 0
 *   effective_score  = baseline_score + hint_adjustment
 *
 * Decision post-hints (priorite decroissante) :
 *   1. Champs stockes par le replay dans le JSON shadow
 *      (auto_notify_candidate / review_candidate) -- source authoritative.
 *   2. Fallback pour anciens shadows sans ces champs : recalcul depuis effective_score.
 *      hint_block_auto=true => jamais auto, jamais de promotion.
 *
 * SECURITE :
 *   - Shadow/local uniquement. Aucun effet sur le runtime production.
 *   - Aucune regle metier, aucun nom de client ou signal code en dur.
 *   - Aucune modification des champs originaux (les entrees ne sont pas mutees).
 */

var CLEAN_STRONG_THRESHOLD = 15;
var CLEAN_WEAK_THRESHOLD   = 5;

/**
 * Determine la decision baseline (score brut uniquement, hints ignores).
 *
 * Seuils :
 *   clean_score >= 15 et non weak/exclu => 'auto'
 *   clean_score >= 5                    => 'review'
 *   sinon                               => 'none'
 *
 * @param {object} entry  BC entry depuis clean_only[]
 * @returns {'auto'|'review'|'none'}
 */
function baselineDecision(entry) {
  var cs      = entry.clean_score || 0;
  var exclHit = !!entry.exclusion_hit;
  var sigs    = (entry.matched_signals || []).filter(function(s) {
    return s.indexOf('bloque(') === -1;
  });
  // weak = signal unique ET score < 15 (meme logique que enrichEntry)
  var isWeak  = sigs.length === 1 && cs < CLEAN_STRONG_THRESHOLD;
  if (!exclHit && cs >= CLEAN_STRONG_THRESHOLD && !isWeak) return 'auto';
  if (cs >= CLEAN_WEAK_THRESHOLD) return 'review';
  return 'none';
}

/**
 * Determine la decision post-hints.
 *
 * Priorite 1 : champs stockes par le replay (source authoritative).
 *   auto_notify_candidate === true => 'auto'
 *   review_candidate      === true => 'review' (si pas auto)
 *
 * Priorite 2 : fallback recalcul depuis effective_score (anciens shadows).
 *   hint_block_auto=true interdit l'auto meme si effective_score >= 15.
 *
 * @param {object} entry  BC entry depuis clean_only[]
 * @returns {'auto'|'review'|'none'}
 */
function postHintDecision(entry) {
  // Priorite 1 : champs explicitement stockes par le replay (source authoritative).
  //
  // Distinction imperative entre champ absent et champ present a false :
  //   - absent (undefined)   : ancien shadow, fallback autorise (cf. priorite 2)
  //   - present a false      : decision stockee "non", aucun fallback autorise
  //   - present a true       : decision stockee "oui"
  //
  // Le replay utilise `value || undefined` donc il ne stocke jamais false.
  // La verification de presence defensive protege contre d'eventuels shadows
  // produits par d'autres outils ou construits manuellement.
  var autoVal   = entry.auto_notify_candidate;
  var reviewVal = entry.review_candidate;
  // !== undefined distingue "absent" (undefined) de "present a false"
  var hasAutoField   = autoVal   !== undefined;
  var hasReviewField = reviewVal !== undefined;

  if (hasAutoField || hasReviewField) {
    // Au moins un champ de decision est present — ne pas recalculer
    if (autoVal   === true) return 'auto';
    if (reviewVal === true) return 'review';
    return 'none'; // les deux presents mais aucun a true => none explicite
  }

  // Priorite 2 : fallback pour anciens shadows sans champs de decision stockes.
  //
  // Reproduit exactement la logique replay-shadow-from-input-snapshot.js
  // lignes 665-682 (calcul isAutoCandidate2) + ligne 714 (review threshold baseline).
  //
  // Points cles :
  //   - isWeakSingle recalcule sur adjustedScore quand adj != 0  (ligne 679 replay)
  //   - review_candidate threshold sur clean_score BASELINE       (ligne 714 replay)
  //   - hint_block_auto interdit auto apres toute recomputation   (ligne 682 replay)
  var cs        = entry.clean_score || 0;
  var adj       = (typeof entry.hint_score_adj === 'number') ? entry.hint_score_adj : 0;
  var blockAuto = !!entry.hint_block_auto;
  var exclHit   = !!entry.exclusion_hit;
  var sigs      = (entry.matched_signals || []).filter(function(s) {
    return s.indexOf('bloque(') === -1;
  });

  // Etape 1 : calcul initial depuis clean_score (replay lignes 665-668)
  var isWeakSingle = sigs.length === 1 && cs < CLEAN_STRONG_THRESHOLD;
  var isStrong     = cs >= CLEAN_STRONG_THRESHOLD;
  var isAuto       = isStrong && !isWeakSingle && !exclHit;

  // Etape 2 : recalcul si adj != 0 -- isWeakSingle sur adjustedScore (replay lignes 676-680)
  if (adj !== 0) {
    var adjScore = cs + adj;
    isStrong     = adjScore >= CLEAN_STRONG_THRESHOLD;
    isWeakSingle = sigs.length === 1 && adjScore < CLEAN_STRONG_THRESHOLD;
    isAuto       = isStrong && !isWeakSingle && !exclHit;
  }

  // Etape 3 : hint_block_auto interdit l'auto (replay ligne 682)
  if (blockAuto) isAuto = false;

  // Etape 4 : decision finale -- review threshold sur clean_score BASELINE (replay ligne 714)
  if (isAuto) return 'auto';
  if (cs >= CLEAN_WEAK_THRESHOLD) return 'review';
  return 'none';
}

/**
 * Calcule l'impact complet des learning hints pour un client.
 * Aucun effet de bord. Les entrees du tableau clean_only ne sont pas modifiees.
 *
 * @param {object} rawClient  Entree client depuis report.clients[]
 * @returns {object}          Statistiques d'impact + entrees modifiees (changed_entries)
 */
function computeHintImpact(rawClient) {
  var cleanOnly  = rawClient.clean_only || [];
  var clientName = rawClient.client_name || '';

  var total      = cleanOnly.length;
  var withHint   = 0;
  var withoutHint = 0;
  var adjPositive = 0;
  var adjNegative = 0;
  var adjZeroApplied = 0;
  var blockAutoCount = 0;

  var baselineAuto   = 0;
  var baselineReview = 0;
  var baselineNone   = 0;
  var postAuto   = 0;
  var postReview = 0;
  var postNone   = 0;

  var reviewToAuto = 0;
  var autoToReview = 0;
  var noneToReview = 0;
  var noneToAuto   = 0;
  var unchanged    = 0;
  var changedEntries = [];

  cleanOnly.forEach(function(entry) {
    var adj     = (typeof entry.hint_score_adj === 'number') ? entry.hint_score_adj : 0;
    var applied = !!(entry.hint_applied);

    // Compteurs hints appliques
    if (applied || adj !== 0) {
      withHint++;
      if (adj > 0)      adjPositive++;
      else if (adj < 0) adjNegative++;
      else              adjZeroApplied++;
    } else {
      withoutHint++;
    }
    if (entry.hint_block_auto) blockAutoCount++;

    // Decisions baseline et post-hints
    var baseDec = baselineDecision(entry);
    var postDec = postHintDecision(entry);

    // Compteurs baseline
    if (baseDec === 'auto')        baselineAuto++;
    else if (baseDec === 'review') baselineReview++;
    else                           baselineNone++;

    // Compteurs post-hints
    if (postDec === 'auto')        postAuto++;
    else if (postDec === 'review') postReview++;
    else                           postNone++;

    // Changements
    if (baseDec === postDec) {
      unchanged++;
    } else {
      if      (baseDec === 'review' && postDec === 'auto')   reviewToAuto++;
      else if (baseDec === 'auto'   && postDec === 'review') autoToReview++;
      else if (baseDec === 'none'   && postDec === 'review') noneToReview++;
      else if (baseDec === 'none'   && postDec === 'auto')   noneToAuto++;

      // Enregistrer l'entree modifiee (lecture seule, pas de mutation)
      changedEntries.push({
        client:             clientName,
        bc_id:              entry.bc_id   || '',
        objet:              entry.objet   || '',
        baseline_score:     entry.clean_score || 0,
        hint_score_adj:     adj,
        effective_score:    (entry.clean_score || 0) + adj,
        baseline_decision:  baseDec,
        post_hint_decision: postDec,
        hint_block_auto:    !!entry.hint_block_auto,
        hint_applied:       entry.hint_applied || '',
      });
    }
  });

  return {
    client_name:          clientName,
    total:                total,
    without_hint:         withoutHint,
    with_hint:            withHint,
    adj_positive:         adjPositive,
    adj_negative:         adjNegative,
    adj_zero_applied:     adjZeroApplied,
    hint_block_auto_count: blockAutoCount,
    baseline_auto:        baselineAuto,
    baseline_review:      baselineReview,
    baseline_none:        baselineNone,
    post_auto:            postAuto,
    post_review:          postReview,
    post_none:            postNone,
    review_to_auto:       reviewToAuto,
    auto_to_review:       autoToReview,
    none_to_review:       noneToReview,
    none_to_auto:         noneToAuto,
    unchanged:            unchanged,
    changed_entries:      changedEntries,
  };
}

module.exports = {
  baselineDecision:       baselineDecision,
  postHintDecision:       postHintDecision,
  computeHintImpact:      computeHintImpact,
  CLEAN_STRONG_THRESHOLD: CLEAN_STRONG_THRESHOLD,
  CLEAN_WEAK_THRESHOLD:   CLEAN_WEAK_THRESHOLD,
};
