'use strict';

/**
 * GD-130 — Utilitaires de troncature HTML sûre pour Telegram.
 * Module pur, sans dépendances externes, testable directement.
 *
 * Problème résolu : Telegram limite les messages à 4096 chars. Couper
 * du HTML brut à 4096 laisse des balises ouvertes (ex : <b>) et provoque :
 *   400 Bad Request: can't parse entities: Can't find end tag for <b>
 *
 * Stratégie safeTruncateHtml (séquentielle, s'arrête dès que ça tient) :
 *   1. Retirer le bloc articles  (💼 <b>Articles :</b> … )
 *   2. Retirer l'aiResume         (💡 <i>…</i>)
 *   3. Retirer la section feedback (après 🔗 lien BC)
 *   4. Dernier recours : stripHtmlTags + troncature brute (jamais de balise cassée)
 */

var TG_SAFE = 3900;

/**
 * Supprime toutes les balises HTML d'une chaîne.
 * Utilisé pour le fallback plain-text.
 *
 * @param {string} s
 * @returns {string}
 */
function stripHtmlTags(s) {
  return (s || '').replace(/<[^>]+>/g, '');
}

/**
 * Réduit un message HTML Telegram à maxLen caractères sans jamais laisser
 * de balise HTML ouverte dans le résultat.
 *
 * @param {string} html    Message HTML complet produit par buildHtmlMessage + fbHtml
 * @param {number} [maxLen=TG_SAFE]  Limite cible (défaut 3900)
 * @returns {string}       Message raccourci, HTML valide, longueur ≤ maxLen
 */
function safeTruncateHtml(html, maxLen) {
  if (!html || html.length <= maxLen) return html;
  maxLen = maxLen || TG_SAFE;

  var result = html;

  // ── Étape 1 : retirer le bloc articles ──────────────────────────────────
  // Format dans buildHtmlMessage (join "\n") :
  //   …\n\n💼 <b>Articles :</b>\n• art1\n• art2\n<i>+N autres articles</i>\n\n💡…
  //   ou …\n\n💼 <b>Articles :</b>\n• art1\n• art2\n\n🔗…
  var ART_MARKER = '\n💼 <b>Articles :</b>';
  var artStart = result.indexOf(ART_MARKER);
  if (artStart !== -1) {
    var searchFrom = artStart + ART_MARKER.length;
    var candidates = [
      result.indexOf('\n\n💡', searchFrom),
      result.indexOf('\n\n🔗', searchFrom),
    ].filter(function(i) { return i !== -1; });
    var artEnd = candidates.length > 0 ? Math.min.apply(null, candidates) : -1;
    if (artEnd !== -1) {
      result = result.slice(0, artStart) + result.slice(artEnd);
    } else {
      result = result.slice(0, artStart);
    }
  }
  // Retirer "+N autres articles" résiduel (au cas où)
  result = result.replace(/\n<i>\+\d+ autres articles<\/i>/g, '');

  if (result.length <= maxLen) return result;

  // ── Étape 2 : retirer aiResume ───────────────────────────────────────────
  // Format : \n\n💡 <i>TEXT</i>\n\n🔗…
  var aiStart = result.indexOf('\n\n💡');
  if (aiStart !== -1) {
    // Trouver la fin de la balise </i> qui ferme l'aiResume
    var iEnd = result.indexOf('</i>', aiStart + 4);
    var afterAi = iEnd !== -1 ? result.indexOf('\n\n', iEnd) : -1;
    if (afterAi !== -1) {
      result = result.slice(0, aiStart) + result.slice(afterAi);
    } else {
      result = result.slice(0, aiStart);
    }
  }

  if (result.length <= maxLen) return result;

  // ── Étape 3 : retirer la section feedback ────────────────────────────────
  // Le feedback commence après le lien BC et <i>Radar Marchés Maroc</i>
  // Format GD-078 : \n\nFeedback :\n<a href=...>...</a>\n...
  // Format GD-134 : \n\nFeedback pour BC #<id> :\n<a href=...>...</a>\n...
  // Le prefixe commun '\n\nFeedback ' couvre les deux formats.
  var fbStart = result.indexOf('\n\nFeedback ');
  if (fbStart !== -1) {
    result = result.slice(0, fbStart);
  }

  if (result.length <= maxLen) return result;

  // ── Étape 4 : dernier recours ────────────────────────────────────────────
  // Ni articles ni aiResume ni feedback n'ont suffi (objet / organisme très long).
  // On strip toutes les balises HTML → jamais de balise ouverte non fermée.
  return stripHtmlTags(html).slice(0, maxLen);
}

module.exports = {
  safeTruncateHtml: safeTruncateHtml,
  stripHtmlTags:    stripHtmlTags,
  TG_SAFE:          TG_SAFE,
};
