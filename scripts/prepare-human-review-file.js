'use strict';

/**
 * scripts/prepare-human-review-file.js — P10
 *
 * Prépare un fichier JSON de saisie review humaine depuis le dernier export
 * review-candidates.json (produit par analyze-shadow-report.js --export-review).
 *
 * Usage :
 *   node scripts/prepare-human-review-file.js
 *       → prend le dernier data/shadow/review-candidates-*.json
 *   node scripts/prepare-human-review-file.js <review-candidates.json>
 *       → fichier précis
 *
 * Sortie : data/human-review/human-review-input-<ts>.json
 *
 * STRICT : aucun réseau, aucun process.env, aucun secret.
 * Ne modifie pas scoreBC(), poids, seuils, buckets prod.
 */

var fs   = require('fs');
var path = require('path');

// Raisons de review autorisées (pas de budget/prix/montant/estimation)
var ALLOWED_REVIEW_REASONS = [
  'hors_activite',
  'mauvais_contexte',
  'bon_signal_mauvais_contexte',
  'organisme_non_pertinent',
  'zone_non_pertinente',
  'doublon_deja_vu',
  'information_insuffisante',
  'faux_positif_evident',
  'autre',
];

var ALLOWED_DECISIONS = ['keep', 'reject', 'ignore'];

// ── Résolution du fichier source ──────────────────────────────────────────────
function resolveSourceFile(arg) {
  if (arg) {
    var p = path.resolve(arg);
    if (!fs.existsSync(p)) {
      console.error('[ERREUR] Fichier introuvable : ' + p);
      process.exit(1);
    }
    return p;
  }

  var dir = path.join(process.cwd(), 'data', 'shadow');
  if (!fs.existsSync(dir)) {
    console.error('[ERREUR] Dossier data/shadow/ introuvable.');
    process.exit(1);
  }

  var files = fs.readdirSync(dir)
    .filter(function(f) { return f.startsWith('review-candidates-') && f.endsWith('.json'); })
    .map(function(f) { return path.join(dir, f); })
    .sort().reverse();

  if (!files.length) {
    console.error('[ERREUR] Aucun review-candidates-*.json trouvé dans ' + dir);
    console.error('         Lancez : node scripts/analyze-shadow-report.js --last --export-review');
    process.exit(1);
  }
  return files[0];
}

// ── Résolution du fichier de sortie ──────────────────────────────────────────
function resolveOutputPath() {
  var dir = path.join(process.cwd(), 'data', 'human-review');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, 'human-review-input-' + ts + '.json');
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  var arg        = process.argv[2] || null;
  var sourceFile = resolveSourceFile(arg);
  console.log('[P10-prepare] Source : ' + sourceFile);

  var raw;
  try {
    raw = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch (e) {
    console.error('[ERREUR] JSON invalide : ' + e.message);
    process.exit(1);
  }

  var candidates = Array.isArray(raw) ? raw
    : Array.isArray(raw.candidates) ? raw.candidates
    : [];

  if (!candidates.length) {
    console.log('[P10-prepare] Aucun candidat dans le fichier source.');
  }

  // Construire les items (un par candidat, champs decision vides)
  var items = candidates.map(function(c) {
    var signals = c.matched_signals;
    if (Array.isArray(signals)) {
      signals = signals.filter(function(s) { return String(s).indexOf('bloque(') === -1; }).join(', ');
    }
    signals = String(signals || '');

    return {
      client:                   String(c.client || c.client_key || ''),
      bc_id:                    String(c.bc_id || ''),
      score:                    c.clean_score != null ? c.clean_score : (c.score != null ? c.score : ''),
      matched_signals:          signals,
      clean_text_excerpt:       String(c.clean_text_excerpt || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300),
      ai_explanation:           String(c.ai_review_explanation || c.ai_explanation || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300),
      ctx_profile_alignment:    String(c.ctx_profile_alignment || ''),
      ctx_context_ambiguity:    String(c.ctx_context_ambiguity || ''),
      ctx_negative_context_terms: Array.isArray(c.ctx_negative_context_terms)
        ? c.ctx_negative_context_terms : [],
      ctx_positive_context_terms: Array.isArray(c.ctx_positive_context_terms)
        ? c.ctx_positive_context_terms : [],
      ctx_learnable_context_hint: String(c.ctx_learnable_context_hint || ''),
      // Champs à remplir par l'humain :
      human_review_decision: '',
      human_review_reason:   '',
      human_review_comment:  '',
    };
  });

  var output = {
    generated_at:       new Date().toISOString(),
    source_review_file: path.basename(sourceFile),
    instructions: {
      allowed_decisions: ALLOWED_DECISIONS,
      allowed_reasons:   ALLOWED_REVIEW_REASONS,
      note: 'Remplir human_review_decision (keep/reject/ignore) et human_review_reason pour chaque item à valider. Laisser vide pour ignorer.',
    },
    items: items,
  };

  var outPath = resolveOutputPath();
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log('[P10-prepare] ' + items.length + ' item(s) préparé(s) → ' + path.basename(outPath));
  console.log('  Chemin : ' + outPath);
  console.log('');
  console.log('  Remplissez human_review_decision, human_review_reason, human_review_comment');
  console.log('  puis lancez : node scripts/import-human-review-file.js ' + outPath);
}

main();
