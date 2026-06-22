#!/usr/bin/env node
// scripts/convert-feedback-events-to-review-csv.js
// GD-076 — Convertit data/feedback/feedback-events.jsonl en CSV
// compatible avec import-review-decisions.js --review-source client
//
// Usage :
//   node scripts/convert-feedback-events-to-review-csv.js
//   node scripts/convert-feedback-events-to-review-csv.js --dry-run
//   node scripts/convert-feedback-events-to-review-csv.js --input <path> --output <path>
//   node scripts/convert-feedback-events-to-review-csv.js --limit 50
//   node scripts/convert-feedback-events-to-review-csv.js --dedupe
//
// Options :
//   --input  <path>  Chemin du JSONL source (defaut : data/feedback/feedback-events.jsonl)
//   --output <path>  Chemin du CSV produit  (defaut : data/feedback/review-candidates-feedback-<ts>.csv)
//   --dry-run        Affiche les lignes sans ecrire le CSV
//   --limit  N       Traiter au maximum N evenements (apres dedupe eventuelle)
//   --dedupe         Deduplication par (client_id, item_id, type) -- garde le plus recent (created_at)
//
// SECURITE :
//   - Ne modifie pas radar-bc-bot.js
//   - Ne modifie pas les routes ni les notifications
//   - Ne modifie pas le scoring, guards, hints, seuils, poids
//   - Ne touche pas Supabase, Fly, secrets, prod
//   - Ne modifie pas les fichiers data existants (JSONL source toujours ouvert en lecture seule)
//   - N'ecrit que dans data/feedback/ (nouveau CSV)

'use strict';

var fs   = require('fs');
var path = require('path');

// ---------------------------------------------------------------------------
// Mapping feedback type -> (decision, human_review_reason)
// ---------------------------------------------------------------------------
var FEEDBACK_TYPE_MAP = {
  'relevant':      { decision: 'keep',   human_review_reason: 'bon_signal_bon_contexte' },
  'irrelevant':    { decision: 'reject', human_review_reason: 'hors_profil' },
  'watch':         { decision: 'ignore', human_review_reason: 'ambigu' },
  'duplicate':     { decision: 'ignore', human_review_reason: 'ignore_non_decidable' },
  'out_of_scope':  { decision: 'reject', human_review_reason: 'hors_profil' },
  'wrong_category':{ decision: 'reject', human_review_reason: 'bon_signal_mauvais_contexte' },
};

// ---------------------------------------------------------------------------
// Colonnes du CSV de sortie
// Le CSV doit satisfaire les colonnes REQUISES par import-review-decisions.js :
//   client, bc_id, score, signal_origin, matched_signals, strength_reason,
//   weak_single_signal, clean_text_excerpt, decision
// Plus les optionnelles utiles :
//   human_review_reason, human_review_comment
// ---------------------------------------------------------------------------
var CSV_HEADER = [
  'client',
  'bc_id',
  'score',
  'signal_origin',
  'matched_signals',
  'strength_reason',
  'weak_single_signal',
  'clean_text_excerpt',
  'human_review_reason',
  'human_review_comment',
  'decision',
];

// ---------------------------------------------------------------------------
// Helpers CSV
// ---------------------------------------------------------------------------

/**
 * Echappe une valeur pour CSV : entoure de guillemets si necessaire,
 * double les guillemets internes. Jamais de separateur non echappe.
 */
function csvEscape(val) {
  var s = (val === null || val === undefined) ? '' : String(val);
  if (s.indexOf(';') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** Serialise un tableau de valeurs en ligne CSV avec separateur ';'. */
function csvRow(values) {
  return values.map(csvEscape).join(';');
}

// ---------------------------------------------------------------------------
// Conversion d'un evenement feedback brut -> objet review
// ---------------------------------------------------------------------------

/**
 * Convertit un evenement feedback brut (objet JSON parse depuis le JSONL)
 * en objet review pret pour le CSV.
 *
 * Retourne null si l'evenement est invalide (type inconnu ou item_id absent).
 */
function convertFeedbackEvent(event) {
  if (!event || typeof event !== 'object') return null;

  var type      = (event.type     || '').trim();
  var item_id   = (event.item_id  || '').trim();
  var client_id = (event.client_id || '').trim();

  if (!item_id)   return null;
  if (!client_id) return null;

  var mapping = FEEDBACK_TYPE_MAP[type];
  if (!mapping) return null; // type inconnu -> ignore

  var critere       = (event.critere       || '').trim();
  var matched_terms = (event.matched_terms || '').trim();
  var bc_title      = (event.bc_title      || '').trim();
  var notif_id      = (event.notif_id      || '').trim();
  var created_at    = (event.created_at    || '').trim();

  // matched_signals : preferer matched_terms si disponible, sinon critere
  var matched_signals = matched_terms || critere;

  // human_review_comment : trace complete du feedback brut
  var comment_parts = ['Feedback client brut: type=' + type];
  if (critere)    comment_parts.push('critere=' + critere);
  if (notif_id)   comment_parts.push('notif_id=' + notif_id);

  // Ajouter reason depuis raw_payload si present (preparation future)
  var raw_payload = event.raw_payload;
  if (raw_payload && typeof raw_payload === 'object' && raw_payload.reason) {
    comment_parts.push('reason=' + String(raw_payload.reason).trim());
  }

  var human_review_comment = comment_parts.join('; ');

  return {
    client:              client_id,
    bc_id:               item_id,
    score:               '',               // inconnu depuis feedback brut
    signal_origin:       'inclusion',      // valeur neutre par defaut
    matched_signals:     matched_signals,
    strength_reason:     'feedback_client',
    weak_single_signal:  '',
    clean_text_excerpt:  bc_title,
    human_review_reason: mapping.human_review_reason,
    human_review_comment: human_review_comment,
    decision:            mapping.decision,
    // Metadonnees internes (non dans CSV mais utiles pour --dry-run)
    _created_at:         created_at,
    _type:               type,
  };
}

/**
 * Deduplique une liste de reviews par (client, bc_id, decision).
 * En cas de doublon, garde le plus recent selon _created_at.
 */
function dedupeReviews(reviews) {
  var map = {};
  reviews.forEach(function(r) {
    var key = r.client + '|' + r.bc_id + '|' + r._type;
    var existing = map[key];
    if (!existing) {
      map[key] = r;
    } else {
      // Garder le plus recent
      if (r._created_at && (!existing._created_at || r._created_at > existing._created_at)) {
        map[key] = r;
      }
    }
  });
  return Object.values(map);
}

/**
 * Serialise une liste de reviews en contenu CSV (avec BOM UTF-8 et header).
 */
function buildCsvContent(reviews) {
  var BOM  = '﻿';
  var lines = [csvRow(CSV_HEADER)];
  reviews.forEach(function(r) {
    lines.push(csvRow(CSV_HEADER.map(function(col) {
      return r[col] !== undefined ? r[col] : '';
    })));
  });
  return BOM + lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Logique principale -- exportee pour les tests
// ---------------------------------------------------------------------------

/**
 * Lit un JSONL de feedbacks (string) et retourne la liste des reviews converties.
 * @param {string} jsonlContent  Contenu du fichier JSONL
 * @param {object} opts          { dedupe: bool }
 * @returns {{ reviews: object[], skipped: number, unknown_types: string[] }}
 */
function parseFeedbackJsonl(jsonlContent, opts) {
  opts = opts || {};
  var lines    = jsonlContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var reviews  = [];
  var skipped  = 0;
  var unknown_types = [];

  lines.forEach(function(line) {
    line = line.trim();
    if (!line) return;
    var event;
    try {
      event = JSON.parse(line);
    } catch (_e) {
      skipped++;
      return;
    }
    var r = convertFeedbackEvent(event);
    if (!r) {
      if (event.type && !FEEDBACK_TYPE_MAP[event.type]) {
        unknown_types.push(event.type);
      }
      skipped++;
      return;
    }
    reviews.push(r);
  });

  if (opts.dedupe) {
    reviews = dedupeReviews(reviews);
  }

  return { reviews: reviews, skipped: skipped, unknown_types: unknown_types };
}

// ---------------------------------------------------------------------------
// Exports (pour tests)
// ---------------------------------------------------------------------------
module.exports = {
  convertFeedbackEvent:  convertFeedbackEvent,
  dedupeReviews:         dedupeReviews,
  parseFeedbackJsonl:    parseFeedbackJsonl,
  buildCsvContent:       buildCsvContent,
  FEEDBACK_TYPE_MAP:     FEEDBACK_TYPE_MAP,
  CSV_HEADER:            CSV_HEADER,
};

// ---------------------------------------------------------------------------
// CLI -- exécution directe uniquement
// ---------------------------------------------------------------------------
if (require.main !== module) return;

// -- Parsing des arguments CLI
var args    = process.argv.slice(2);
var inputPath  = null;
var outputPath = null;
var dryRun     = false;
var limit      = null;
var dedupe     = false;

for (var i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run')  { dryRun = true; continue; }
  if (args[i] === '--dedupe')   { dedupe = true; continue; }
  if (args[i] === '--input'  && args[i + 1]) { inputPath  = args[++i]; continue; }
  if (args[i] === '--output' && args[i + 1]) { outputPath = args[++i]; continue; }
  if (args[i] === '--limit'  && args[i + 1]) {
    limit = parseInt(args[++i], 10);
    if (isNaN(limit) || limit < 1) { console.error('ERROR: --limit doit etre un entier >= 1'); process.exit(1); }
    continue;
  }
}

// -- Chemins par defaut
var repoRoot    = path.resolve(__dirname, '..');
var feedbackDir = path.join(repoRoot, 'data', 'feedback');
if (!inputPath) inputPath = path.join(feedbackDir, 'feedback-events.jsonl');

if (!fs.existsSync(inputPath)) {
  console.error('ERROR: Fichier source introuvable : ' + inputPath);
  console.error('  Verifier que la route /feedback a ete appelee au moins une fois.');
  process.exit(1);
}

// -- Lecture + conversion
var rawContent = fs.readFileSync(inputPath, 'utf8');
var result     = parseFeedbackJsonl(rawContent, { dedupe: dedupe });
var reviews    = result.reviews;

if (limit !== null) reviews = reviews.slice(0, limit);

// -- Timestamp pour le nom du fichier de sortie
var ts = new Date().toISOString()
  .replace(/:/g, '-')
  .replace(/\..+$/, '')
  .replace('T', 'T');

if (!outputPath) {
  outputPath = path.join(feedbackDir, 'review-candidates-feedback-' + ts + '.csv');
}

// -- Resume
console.log('');
console.log('=== convert-feedback-events-to-review-csv (GD-076) ===');
console.log('Input         :', inputPath);
console.log('Output        :', outputPath);
console.log('Dry-run       :', dryRun);
console.log('Dedupe        :', dedupe);
console.log('Limite        :', limit !== null ? limit : 'aucune');
console.log('Evenements OK :', reviews.length);
console.log('Sautes        :', result.skipped);
if (result.unknown_types.length) {
  console.log('Types inconnus:', result.unknown_types.join(', '));
}

// -- Statistiques par decision
var stats = { keep: 0, reject: 0, ignore: 0 };
reviews.forEach(function(r) {
  if (stats[r.decision] !== undefined) stats[r.decision]++;
});
console.log('keep=' + stats.keep + '  reject=' + stats.reject + '  ignore=' + stats.ignore);

if (reviews.length === 0) {
  console.log('\nAucun evenement a convertir.');
  process.exit(0);
}

// -- Dry-run : afficher les lignes
if (dryRun) {
  console.log('\n--- Preview CSV (header + ' + reviews.length + ' ligne(s)) ---');
  console.log(CSV_HEADER.join(';'));
  reviews.forEach(function(r) {
    var line = CSV_HEADER.map(function(col) { return r[col] !== undefined ? r[col] : ''; }).join(';');
    console.log(line);
  });
  console.log('\n[dry-run] Aucun fichier ecrit.');
  process.exit(0);
}

// -- Ecriture CSV
var csvContent = buildCsvContent(reviews);
var outDir     = path.dirname(outputPath);
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outputPath, csvContent, 'utf8');

console.log('\n[OK] CSV ecrit : ' + outputPath);
console.log('\nCommande import :');
console.log('  node scripts/import-review-decisions.js "' + outputPath + '" --review-source client');
console.log('');
