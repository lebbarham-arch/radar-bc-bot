'use strict';

/**
 * scripts/build-review-reason-hint-candidates.js — CLI P8
 *
 * Lit le dernier review-reason-learning-report-*.json et produit
 * data/review-learning/review-reason-hint-candidates-<ts>.json
 *
 * Modes :
 *   node scripts/build-review-reason-hint-candidates.js
 *       → cherche le dernier rapport dans data/review-learning/
 *   node scripts/build-review-reason-hint-candidates.js <fichier.json>
 *       → fichier précis
 *
 * STRICT : aucune API/réseau/IA externe, aucun process.env/secret/token.
 */

var fs   = require('fs');
var path = require('path');
var hintModule = require('./review-reason-hint-candidates');

// ── Résolution du rapport P7 source ──────────────────────────────────────────
function resolveSourceReport(arg) {
  if (arg) {
    var p = path.resolve(arg);
    if (!fs.existsSync(p)) {
      console.error('[ERREUR] Fichier introuvable : ' + p);
      process.exit(1);
    }
    return p;
  }

  // Auto : chercher le plus récent review-reason-learning-report-*.json
  var dir = path.join(process.cwd(), 'data', 'review-learning');
  if (!fs.existsSync(dir)) {
    console.error('[ERREUR] Dossier data/review-learning/ introuvable.');
    console.error('         Lancez d\'abord : node scripts/analyze-review-reason-learning.js');
    process.exit(1);
  }

  var files = fs.readdirSync(dir)
    .filter(function(f) { return f.startsWith('review-reason-learning-report-') && f.endsWith('.json'); })
    .map(function(f) { return path.join(dir, f); })
    .sort()
    .reverse(); // plus récent en premier

  if (files.length === 0) {
    console.error('[ERREUR] Aucun rapport review-reason-learning-report-*.json trouvé dans ' + dir);
    process.exit(1);
  }

  return files[0];
}

// ── Résolution du fichier de sortie ──────────────────────────────────────────
function resolveOutputPath() {
  var dir = path.join(process.cwd(), 'data', 'review-learning');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  var ts   = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, 'review-reason-hint-candidates-' + ts + '.json');
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  var arg        = process.argv[2] || null;
  var sourceFile = resolveSourceReport(arg);

  console.log('[P8] Source rapport P7 : ' + sourceFile);

  var raw;
  try {
    raw = fs.readFileSync(sourceFile, 'utf8');
  } catch (e) {
    console.error('[ERREUR] Impossible de lire : ' + sourceFile);
    console.error(e.message);
    process.exit(1);
  }

  var p7Report;
  try {
    p7Report = JSON.parse(raw);
  } catch (e) {
    console.error('[ERREUR] JSON invalide : ' + sourceFile);
    console.error(e.message);
    process.exit(1);
  }

  // ── Construction des hint candidates ──────────────────────────────────────
  var result = hintModule.buildReviewReasonHintCandidates(p7Report, {
    generatedAt:  new Date().toISOString(),
    sourceReport: path.basename(sourceFile),
  });

  // ── Affichage console ──────────────────────────────────────────────────────
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  REVIEW REASON HINT CANDIDATES — P8');
  console.log('  Modèle : ' + result.model);
  console.log('══════════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Suggestions en entrée : ' + result.totals.input_suggestions);
  console.log('  Candidats produits    : ' + result.totals.candidates);
  console.log('  Ignorés (skip)        : ' + result.totals.skipped);
  console.log('');

  var byType = result.totals.by_type;
  var typeKeys = Object.keys(byType);
  if (typeKeys.length > 0) {
    console.log('  Candidats par type :');
    typeKeys.forEach(function(t) {
      console.log('    ' + t + ' : ' + byType[t]);
    });
    console.log('');
  }

  if (result.candidates.length > 0) {
    console.log('  Détail des candidats :');
    result.candidates.forEach(function(c, i) {
      console.log('  [' + (i + 1) + '] ' + c.candidate_id);
      console.log('      client  : ' + c.client_key);
      console.log('      signal  : ' + c.signal_key);
      console.log('      type    : ' + c.hint_type);
      console.log('      action  : ' + (c.proposed_effect && c.proposed_effect.action));
      console.log('      confid. : ' + c.confidence);
      console.log('      safety  : ' + c.safety + ' | status : ' + c.status);
      console.log('      humain  : ' + c.human_validation_required);
      if (c.rationale) {
        console.log('      raison  : ' + c.rationale.slice(0, 100));
      }
      console.log('');
    });
  }

  if (result.skipped.length > 0) {
    console.log('  Ignorés :');
    result.skipped.forEach(function(s, i) {
      console.log('    [' + (i + 1) + '] ' + s.reason + ' — ' + String(s.source).slice(0, 60));
    });
    console.log('');
  }

  // ── Écriture JSON ──────────────────────────────────────────────────────────
  var outPath = resolveOutputPath();
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  console.log('  Fichier écrit : ' + outPath);
  console.log('');
  console.log('  IMPORTANT : ces candidats sont UNIQUEMENT consultatifs.');
  console.log('  safety=shadow_only | status=candidate_pending_human_validation');
  console.log('  Aucun hint n\'est appliqué au moteur dans cette étape P8.');
  console.log('');
  console.log('══════════════════════════════════════════════════════════════');
}

main();
