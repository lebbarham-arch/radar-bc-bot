// scripts/apply-client-learning-hints.js
// GD-135 — Application generique des hints client-learning en shadow/local.
//
// Module pur, sans I/O, sans dependances externes, testable directement.
//
// SECURITE :
//   - Shadow-only : ce module ne modifie jamais le runtime production legacy.
//   - radar-bc-bot.js n'importe pas ce module.
//   - Logique generique : client -> signal -> hint -> effet shadow.
//   - Aucune regle metier specifique (pas de nom de domaine code en dur).

'use strict';

/**
 * Trouve l'entree hints pour un client donne dans le fichier client-learning-hints.json.
 * Cherche en priorite par nom (clientName), puis par client_id UUID (clientId).
 * Retro-compatible : les clients identifies par nom (TEST PROD - ...) continuent de fonctionner.
 * Le client reel identifie par UUID est maintenant supporte.
 *
 * @param {object|null}  hintsData   Contenu parse de client-learning-hints.json
 * @param {string}       clientName  Nom du client (client.nom) — peut etre vide
 * @param {string}       [clientId]  UUID du client (client.id) — optionnel
 * @returns {object|null}            Entree client ou null si absent
 */
function lookupClientHints(hintsData, clientName, clientId) {
  if (!hintsData || !Array.isArray(hintsData.clients)) return null;
  var found = null;
  hintsData.clients.forEach(function(c) {
    if (found) return;
    if (clientName && c.client === clientName) { found = c; return; }
    if (clientId  && c.client === String(clientId)) { found = c; return; }
  });
  return found || null;
}

/**
 * Applique les hints d'un client a une liste de signaux matches.
 * Retourne un objet agregat avec le total scoreAdj, blockAuto,
 * la liste des hints appliques et les explications lisibles.
 *
 * Aucun effet de bord. Peut etre appele depuis un test unitaire sans setup.
 *
 * @param {object|null}  clientHintEntry  Entree client depuis lookupClientHints()
 * @param {string[]}     signals          Signaux matches pour ce BC
 * @returns {{ scoreAdj: number, blockAuto: boolean, applied: string[], explanations: string[] }}
 */
function applySignalHints(clientHintEntry, signals) {
  var result = { scoreAdj: 0, blockAuto: false, applied: [], explanations: [] };
  if (!clientHintEntry || !Array.isArray(clientHintEntry.signals)) return result;
  if (!Array.isArray(signals) || signals.length === 0) return result;

  clientHintEntry.signals.forEach(function(h) {
    if (signals.indexOf(h.signal) === -1) return;
    var adj = typeof h.score_adjustment === 'number' ? h.score_adjustment : 0;
    result.scoreAdj += adj;
    if (h.block_auto_notify) result.blockAuto = true;
    result.applied.push(h.signal + ':' + (h.recommended_effect || 'unknown'));
    result.explanations.push(formatHintExplanation(h));
  });
  return result;
}

/**
 * Formate l'explication d'un hint individuel pour le rapport shadow.
 * Format : "learning_hint: <effect> adj=<n> source=<src> cycles=<n>"
 * Exemple : "learning_hint: demote_to_review adj=-3 source=client cycles=2"
 *
 * @param {object} hint  Entree signal du fichier hints
 * @returns {string}
 */
function formatHintExplanation(hint) {
  var effect = hint.recommended_effect || 'unknown';
  var adj    = typeof hint.score_adjustment === 'number' ? hint.score_adjustment : 0;
  var src    = Array.isArray(hint.sources) && hint.sources.length
    ? hint.sources.join('+')
    : 'unknown';
  var cycles = typeof hint.cycles_count === 'number' ? hint.cycles_count : 0;

  var parts = ['learning_hint:', effect];
  if (adj !== 0) parts.push('adj=' + adj);
  parts.push('source=' + src);
  if (cycles > 0) parts.push('cycles=' + cycles);
  return parts.join(' ');
}

module.exports = {
  lookupClientHints:     lookupClientHints,
  applySignalHints:      applySignalHints,
  formatHintExplanation: formatHintExplanation,
};
