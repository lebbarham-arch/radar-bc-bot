'use strict';

/**
 * scripts/import-human-review-file.js — P10
 *
 * Valide et importe un fichier review rempli humainement.
 * Produit :
 *  - data/human-review/human-review-decisions-<ts>.json
 *  - data/human-review/human-review-decisions-for-learning-<ts>.json (compatible P7)
 *
 * Usage :
 *   node scripts/import-human-review-file.js <human-review-input-filled.json>
 *
 * STRICT : aucun réseau, aucun process.env, aucun secret.
 * Ne modifie pas scoreBC(), poids, seuils, buckets prod.
 */

var fs   = require('fs');
var path = require('path');
var reviewReasons = require('./review-reasons');

var ALLOWED_DECISIONS = ['keep', 'reject', 'ignore'];

// ── Normalisation de la décision ──────────────────────────────────────────────
function normalizeDecision(raw) {
  if (!raw) return '';
  var s = String(raw).trim().toLowerCase();
  if (ALLOWED_DECISIONS.indexOf(s) !== -1) return s;
  return '';
}

// ── Résolution fichier de sortie ──────────────────────────────────────────────
function resolveOutputDir() {
  var dir = path.join(process.cwd(), 'data', 'human-review');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  var arg = process.argv[2];
  if (!arg) {
    console.error('[ERREUR] Argument requis : node scripts/import-human-review-file.js <fichier>');
    process.exit(1);
  }

  var sourceFile = path.resolve(arg);
  if (!fs.existsSync(sourceFile)) {
    console.error('[ERREUR] Fichier introuvable : ' + sourceFile);
    process.exit(1);
  }

  console.log('[P10-import] Source : ' + sourceFile);

  var raw;
  try {
    raw = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch (e) {
    console.error('[ERREUR] JSON invalide : ' + e.message);
    process.exit(1);
  }

  var items = Array.isArray(raw.items) ? raw.items : [];
  var ts    = new Date().toISOString();

  var decisions = [];
  var skipped   = [];
  var counts    = { keep: 0, reject: 0, ignore: 0 };

  items.forEach(function(item, idx) {
    var rawDecision = item.human_review_decision;
    var decision    = normalizeDecision(rawDecision);

    // Items sans décision → ignorés silencieusement
    if (!decision) {
      skipped.push({ index: idx, bc_id: item.bc_id || '', reason: 'decision vide ou absente' });
      return;
    }

    // Normaliser la raison via review-reasons.js
    var normalizedReason      = reviewReasons.normalizeReviewReason(item.human_review_reason || '');
    var normalizedReasonLabel = reviewReasons.explainReviewReason(normalizedReason);

    counts[decision] = (counts[decision] || 0) + 1;

    // Signaux nettoyés
    var signals = item.matched_signals;
    if (typeof signals === 'string') {
      signals = signals.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    }
    if (!Array.isArray(signals)) signals = [];

    decisions.push({
      client:                    String(item.client || ''),
      bc_id:                     String(item.bc_id  || ''),
      decision:                  decision,
      human_review_reason:       normalizedReason,
      human_review_reason_label: normalizedReasonLabel,
      human_review_comment:      String(item.human_review_comment || '').trim(),
      matched_signals:           signals,
      ctx_profile_alignment:     String(item.ctx_profile_alignment  || ''),
      ctx_context_ambiguity:     String(item.ctx_context_ambiguity  || ''),
      ctx_positive_context_terms: Array.isArray(item.ctx_positive_context_terms)
        ? item.ctx_positive_context_terms : [],
      ctx_negative_context_terms: Array.isArray(item.ctx_negative_context_terms)
        ? item.ctx_negative_context_terms : [],
      source_excerpt:            String(item.clean_text_excerpt || '').slice(0, 200),
    });
  });

  // ── Fichier decisions principal ────────────────────────────────────────────
  var outDir = resolveOutputDir();
  var tsFile = ts.replace(/[:.]/g, '-');

  var decisionsReport = {
    generated_at: ts,
    source_file:  path.basename(sourceFile),
    totals: {
      input_items:   items.length,
      reviewed_items: decisions.length,
      keep:   counts.keep   || 0,
      reject: counts.reject || 0,
      ignore: counts.ignore || 0,
      skipped: skipped.length,
    },
    decisions: decisions,
    skipped:   skipped,
  };

  var decPath = path.join(outDir, 'human-review-decisions-' + tsFile + '.json');
  fs.writeFileSync(decPath, JSON.stringify(decisionsReport, null, 2), 'utf8');
  console.log('[P10-import] ' + decisions.length + ' décision(s) importée(s) → ' + path.basename(decPath));

  // ── Fichier for-learning compatible P7 ────────────────────────────────────
  // P7 attend : client, bc_id, decision, matched_signals, human_review_reason,
  //             human_review_reason_label, ctx_context_key / ctx_learnable_context_hint,
  //             ctx_negative_context_terms, ctx_positive_context_terms,
  //             score, signal_origin, strength_reason
  var learningEntries = decisions.map(function(d) {
    var item = items.find(function(it) { return it.bc_id === d.bc_id && it.client === d.client; }) || {};
    return {
      client:                    d.client,
      bc_id:                     d.bc_id,
      decision:                  d.decision,
      human_review_reason:       d.human_review_reason,
      human_review_reason_label: d.human_review_reason_label,
      human_review_comment:      d.human_review_comment,
      matched_signals:           d.matched_signals,
      ctx_context_key:           String(item.ctx_learnable_context_hint || ''),
      ctx_learnable_context_hint: String(item.ctx_learnable_context_hint || ''),
      ctx_negative_context_terms: d.ctx_negative_context_terms,
      ctx_positive_context_terms: d.ctx_positive_context_terms,
      ctx_profile_alignment:     d.ctx_profile_alignment,
      ctx_context_ambiguity:     d.ctx_context_ambiguity,
      score:                     item.score != null ? item.score : '',
      signal_origin:             String(item.signal_origin || ''),
      strength_reason:           String(item.strength_reason || ''),
      reviewed_at:               ts,
    };
  });

  var learningReport = {
    generated_at: ts,
    source_file:  path.basename(sourceFile),
    model:        'human-review-decisions-for-p7-learning-v1',
    totals:       decisionsReport.totals,
    records:      learningEntries,
  };

  var learningPath = path.join(outDir, 'human-review-decisions-for-learning-' + tsFile + '.json');
  fs.writeFileSync(learningPath, JSON.stringify(learningReport, null, 2), 'utf8');
  console.log('[P10-import] Format P7 → ' + path.basename(learningPath));

  // ── Résumé ─────────────────────────────────────────────────────────────────
  console.log('');
  console.log('  keep=' + (counts.keep||0) + '  reject=' + (counts.reject||0) + '  ignore=' + (counts.ignore||0) + '  skipped=' + skipped.length);
  if (skipped.length) {
    console.log('  Items ignorés (sans décision) : ' + skipped.length);
  }
  console.log('');
  console.log('  Prochaine étape P7 :');
  console.log('  node scripts/analyze-review-reason-learning.js ' + learningPath);
}

main();
