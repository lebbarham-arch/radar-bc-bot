'use strict';

/**
 * scripts/approve-review-reason-hint-candidate.js — P10
 *
 * Valide (ou rejette) humainement un hint candidate P8.
 * Produit un NOUVEAU fichier — ne modifie jamais le fichier source.
 *
 * Usage :
 *   node scripts/approve-review-reason-hint-candidate.js <candidates.json> <candidate_id>
 *   node scripts/approve-review-reason-hint-candidate.js <candidates.json> <candidate_id> --note "..."
 *   node scripts/approve-review-reason-hint-candidate.js <candidates.json> <candidate_id> --reject
 *   node scripts/approve-review-reason-hint-candidate.js <candidates.json> <candidate_id> --reject --note "..."
 *
 * Sortie :
 *   data/review-learning/review-reason-hint-candidates-approved-<ts>.json
 *
 * STRICT :
 *  - Ne jamais mettre status=active, status=applied
 *  - Ne jamais modifier safety (reste shadow_only)
 *  - Ne jamais modifier human_validation_required (reste true)
 *  - Ne jamais modifier le fichier source en place
 *  - Aucun réseau, aucun process.env, aucun secret
 *  - Approve → status="human_approved_for_shadow"
 *  - Reject  → status="human_rejected"
 */

var fs   = require('fs');
var path = require('path');

var FORBIDDEN_OUTPUT_STATUSES = ['active', 'applied'];

// ── Parsing des args ──────────────────────────────────────────────────────────
function parseArgs() {
  var args        = process.argv.slice(2);
  var sourceFile  = null;
  var candidateId = null;
  var note        = '';
  var doReject    = false;

  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--reject')                    { doReject = true; continue; }
    if (args[i] === '--note' && args[i + 1])       { note = args[++i]; continue; }
    if (!sourceFile  && !args[i].startsWith('--')) { sourceFile = args[i]; continue; }
    if (!candidateId && !args[i].startsWith('--')) { candidateId = args[i]; continue; }
  }
  return { sourceFile, candidateId, note, doReject };
}

// ── Résolution du fichier de sortie ──────────────────────────────────────────
function resolveOutputPath() {
  var dir = path.join(process.cwd(), 'data', 'review-learning');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  var ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, 'review-reason-hint-candidates-approved-' + ts + '.json');
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  var parsed = parseArgs();

  if (!parsed.sourceFile || !parsed.candidateId) {
    console.error('[ERREUR] Usage : node scripts/approve-review-reason-hint-candidate.js <candidates.json> <candidate_id> [--reject] [--note "..."]');
    process.exit(1);
  }

  var sourceFile = path.resolve(parsed.sourceFile);
  if (!fs.existsSync(sourceFile)) {
    console.error('[ERREUR] Fichier introuvable : ' + sourceFile);
    process.exit(1);
  }

  var raw;
  try {
    raw = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  } catch (e) {
    console.error('[ERREUR] JSON invalide : ' + e.message);
    process.exit(1);
  }

  var candidates = Array.isArray(raw.candidates) ? raw.candidates : [];
  var found = false;
  var now   = new Date().toISOString();

  // Nouveau statut selon approve/reject
  var newStatus = parsed.doReject ? 'human_rejected' : 'human_approved_for_shadow';

  // Vérification de sécurité
  if (FORBIDDEN_OUTPUT_STATUSES.indexOf(newStatus) !== -1) {
    console.error('[ERREUR SÉCURITÉ] Status interdit : ' + newStatus);
    process.exit(1);
  }

  // Copie profonde + modification du candidate cible
  var updatedCandidates = candidates.map(function(c) {
    if (c.candidate_id !== parsed.candidateId) return JSON.parse(JSON.stringify(c));

    found = true;
    var updated = JSON.parse(JSON.stringify(c));

    // Appliquer le nouveau statut
    updated.status = newStatus;

    // Garanties de sécurité : ne jamais modifier ces champs
    updated.safety                    = 'shadow_only';        // inchangeable
    updated.human_validation_required = true;                 // inchangeable

    // Ajouter les métadonnées d'approbation/rejet
    if (parsed.doReject) {
      updated.human_rejected_at = now;
      if (parsed.note) updated.human_rejection_note = parsed.note;
    } else {
      updated.human_approved_at = now;
      if (parsed.note) updated.human_approval_note = parsed.note;
    }

    return updated;
  });

  if (!found) {
    console.error('[ERREUR] candidate_id introuvable : ' + parsed.candidateId);
    console.error('  Candidates disponibles :');
    candidates.slice(0, 10).forEach(function(c) {
      console.error('    ' + c.candidate_id);
    });
    process.exit(1);
  }

  // Construire le rapport de sortie (nouveau fichier uniquement)
  var outputReport = JSON.parse(JSON.stringify(raw));
  outputReport.candidates = updatedCandidates;
  outputReport.p10_processed_at = now;
  outputReport.p10_action       = parsed.doReject ? 'reject' : 'approve';
  outputReport.p10_candidate_id = parsed.candidateId;
  outputReport.p10_note         = parsed.note || '';

  // Recalculer les totaux
  var approvedCount = updatedCandidates.filter(function(c) { return c.status === 'human_approved_for_shadow'; }).length;
  var rejectedCount = updatedCandidates.filter(function(c) { return c.status === 'human_rejected'; }).length;
  var pendingCount  = updatedCandidates.filter(function(c) { return c.status === 'candidate_pending_human_validation'; }).length;

  outputReport.p10_totals = {
    total:    updatedCandidates.length,
    approved: approvedCount,
    rejected: rejectedCount,
    pending:  pendingCount,
  };

  var outPath = resolveOutputPath();
  fs.writeFileSync(outPath, JSON.stringify(outputReport, null, 2), 'utf8');

  var action = parsed.doReject ? 'REJETÉ' : 'APPROUVÉ (shadow_only)';
  console.log('[P10-approve] Candidate ' + parsed.candidateId + ' → ' + action);
  console.log('  status : ' + newStatus);
  console.log('  safety : shadow_only (inchangé)');
  console.log('  human_validation_required : true (inchangé)');
  if (parsed.note) console.log('  note   : ' + parsed.note);
  console.log('');
  console.log('  Nouveau fichier : ' + path.basename(outPath));
  console.log('  Source INCHANGÉE : ' + path.basename(sourceFile));
  console.log('');

  if (!parsed.doReject) {
    console.log('  approved=' + approvedCount + '  rejected=' + rejectedCount + '  pending=' + pendingCount);
    console.log('');
    console.log('  Prochaine étape P9 :');
    console.log('  node scripts/analyze-shadow-report.js --last --review-reason-hints ' + outPath);
  } else {
    console.log('  Aucun effet sur le moteur shadow (status=human_rejected → ignoré par P9)');
  }
}

main();
