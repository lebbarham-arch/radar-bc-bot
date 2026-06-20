'use strict';

/**
 * scripts/audit-profile-usage.js -- GD-050
 *
 * Audit sobre de l'exploitation du profil structure et des garde-fous.
 * Shadow-only -- ne touche pas au scoring, matching, prod, Supabase, Fly.
 * Pas de notification, pas d'ecriture bcs_vus, pas de scan reel.
 * Diagnostic-only : observe sans recommander d'action.
 *
 * Usage :
 *   node scripts/audit-profile-usage.js
 *     -> dernier shadow-bc-input-replay-*.json dans data/shadow/
 *
 *   node scripts/audit-profile-usage.js --shadow data\shadow\shadow-bc-input-replay-xxx.json
 *     -> fichier shadow explicite
 *
 * ASCII strict -- pas de caracteres accentues dans le source.
 */

var fs   = require('fs');
var path = require('path');

// -- CLI ----------------------------------------------------------------------

function opt(name) {
  var idx = process.argv.indexOf(name);
  return (idx >= 0 && process.argv[idx + 1]) ? process.argv[idx + 1] : null;
}

var shadowArg = opt('--shadow') || opt('--input') || null;
var SHADOW_DIR = path.resolve(__dirname, '..', 'data', 'shadow');

// -- Classification des champs profil -----------------------------------------
// Basee sur inspection de contextual-review-insights.js (GD-035 / GD-040).
// Ces classifications sont statiques -- pas de logique metier/client/domaine.

// Champs passes dans detectClientProfileFamilies -> alignement positif BC/profil.
var FIELDS_USED_POSITIVE = [
  'client_name',
  'business_profile',
  'technical_profile',
  'secteurs',
  'types_prestation',
  'organismes_cibles',
  'produits',
  'specifications'
];

// Extrait dans analyzeReviewContext, transporte dans ctx_client_exclusions.
// Deliberement absent du matching positif (termes a eviter, pas domaines d'interet).
// La vraie garde est exclusion_hit sur les entries (via cleanResult.blocked dans replay).
var FIELDS_USED_EXCLUSION_ONLY = [
  'exclusions_metier'
];

// Transportes dans le rapport shadow mais non utilises dans l'analyse CRI.
var FIELDS_TRANSPORTED_ONLY = [
  'organization_profile',
  'profile_label',
  'radar_type',
  'recommendation'
];

var ALL_KNOWN_PROFILE_FIELDS = FIELDS_USED_POSITIVE
  .concat(FIELDS_USED_EXCLUSION_ONLY)
  .concat(FIELDS_TRANSPORTED_ONLY);

// -- Helpers ------------------------------------------------------------------

function findLatestShadowJson(dir) {
  if (!fs.existsSync(dir)) return null;
  var files = fs.readdirSync(dir)
    .filter(function(f) { return /^shadow-bc-input-replay-.*\.json$/.test(f); })
    .map(function(f) {
      return { name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs };
    })
    .sort(function(a, b) { return b.mtime - a.mtime; });
  return files.length ? path.join(dir, files[0].name) : null;
}

function isPresent(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

// -- Audit d'un client --------------------------------------------------------

function auditClient(c) {
  var allEntries = Array.isArray(c.clean_only) ? c.clean_only : [];

  // Champs profil presents / absents
  var fieldsPresent  = ALL_KNOWN_PROFILE_FIELDS.filter(function(f) { return isPresent(c[f]); });
  var fieldsMissing  = ALL_KNOWN_PROFILE_FIELDS.filter(function(f) { return !isPresent(c[f]); });

  // Partition par categorie parmi les champs presents
  var usedPositivePresent   = FIELDS_USED_POSITIVE.filter(function(f) { return isPresent(c[f]); });
  var usedExclusionPresent  = FIELDS_USED_EXCLUSION_ONLY.filter(function(f) { return isPresent(c[f]); });
  var transportedPresent    = FIELDS_TRANSPORTED_ONLY.filter(function(f) { return isPresent(c[f]); });

  // Comptages entries
  var autoEntries         = allEntries.filter(function(e) { return !!e.auto_notify_candidate; });
  var reviewEntries       = allEntries.filter(function(e) { return !!e.review_candidate && !e.auto_notify_candidate; });
  var weakEntries         = allEntries.filter(function(e) { return !!e.weak_single_signal; });
  var exclusionHitEntries = allEntries.filter(function(e) { return !!e.exclusion_hit; });

  // Anomalies
  var anomalies = [];

  // Anomalie 1 : auto-candidat avec weak_single_signal (garde-fou defaillant)
  var weakAutoEntries = autoEntries.filter(function(e) { return !!e.weak_single_signal; });
  if (weakAutoEntries.length > 0) {
    anomalies.push({
      type  : 'weak_single_auto_candidate',
      count : weakAutoEntries.length,
      detail: 'auto-candidats avec weak_single_signal -- garde-fou defaillant'
    });
  }

  // Anomalie 2 : review-candidat avec exclusion_hit (exclusion devrait bloquer)
  var reviewExclusionHit = reviewEntries.filter(function(e) { return !!e.exclusion_hit; });
  if (reviewExclusionHit.length > 0) {
    anomalies.push({
      type  : 'review_with_exclusion_hit',
      count : reviewExclusionHit.length,
      detail: 'review-candidats avec exclusion_hit -- a inspecter'
    });
  }

  // Anomalie 3 : aucun champ positif peuple (hors client_name) -> alignement CRI impossible
  var structuredPositive = FIELDS_USED_POSITIVE.filter(function(f) { return f !== 'client_name'; });
  var structuredPresent  = structuredPositive.filter(function(f) { return isPresent(c[f]); });
  if (structuredPresent.length === 0) {
    anomalies.push({
      type  : 'no_structured_profile_fields',
      count : 0,
      detail: 'aucun champ profil structure peuple -- alignement CRI non fiable'
    });
  }

  return {
    client_id              : c.client_id || '',
    client_name            : c.client_name || c.client_id || '',
    profile_label          : c.profile_label || '',
    fields_present         : fieldsPresent,
    fields_missing         : fieldsMissing,
    used_positive_present  : usedPositivePresent,
    used_exclusion_present : usedExclusionPresent,
    transported_present    : transportedPresent,
    total_clean            : allEntries.length,
    auto_count             : autoEntries.length,
    review_count           : reviewEntries.length,
    weak_count             : weakEntries.length,
    exclusion_hit_count    : exclusionHitEntries.length,
    weak_auto_count        : weakAutoEntries.length,
    anomalies              : anomalies
  };
}

// -- Audit global -------------------------------------------------------------

function auditReport(report) {
  var clients      = Array.isArray(report.clients) ? report.clients : [];
  var clientAudits = clients.map(auditClient);

  var totalAnomalies = clientAudits.reduce(function(acc, a) {
    return acc + a.anomalies.length;
  }, 0);
  var allWeakAuto = clientAudits.reduce(function(acc, a) {
    return acc + a.weak_auto_count;
  }, 0);

  return {
    scan_date      : report.scan_date || null,
    nb_clients     : clientAudits.length,
    total_anomalies: totalAnomalies,
    guard_checks   : {
      weak_single_signal_stays_review: allWeakAuto === 0,
      no_weak_single_auto_candidates : allWeakAuto === 0
    },
    clients        : clientAudits
  };
}

// -- Affichage ----------------------------------------------------------------

function printAudit(audit, shadowPath) {
  console.log('');
  console.log('=== AUDIT PROFIL & GARDE-FOUS (GD-050) ===');
  console.log('  Source    : ' + path.basename(shadowPath));
  console.log('  Scan      : ' + (audit.scan_date || '?'));
  console.log('  Clients   : ' + audit.nb_clients);
  console.log('  Anomalies : ' + audit.total_anomalies);
  console.log('');

  console.log('-- GARDE-FOUS GLOBAUX --');
  Object.keys(audit.guard_checks).forEach(function(k) {
    var ok = audit.guard_checks[k];
    console.log('  [' + (ok ? 'OK    ' : 'ANOMALIE') + '] ' + k + ' = ' + ok);
  });
  console.log('');

  console.log('-- CLASSIFICATION DES CHAMPS PROFIL (statique, basee sur code CRI) --');
  console.log('  Positif (detectClientProfileFamilies) : ' + FIELDS_USED_POSITIVE.join(', '));
  console.log('  Exclusion seule (ctx_client_exclusions, hors positif) : ' + FIELDS_USED_EXCLUSION_ONLY.join(', '));
  console.log('  Transportes uniquement (shadow, non utilises par CRI) : ' + FIELDS_TRANSPORTED_ONLY.join(', '));
  console.log('');

  audit.clients.forEach(function(a) {
    console.log('-- CLIENT : ' + a.client_name + ' [' + a.profile_label + '] --');
    console.log('  Champs presents  : ' + (a.fields_present.join(', ') || '(aucun)'));
    if (a.fields_missing.length > 0) {
      console.log('  Champs absents   : ' + a.fields_missing.join(', '));
    }
    console.log('  Positifs presents: ' + (a.used_positive_present.join(', ') || '(aucun)'));
    console.log('  Exclusion present: ' + (a.used_exclusion_present.join(', ') || '(aucun)'));
    console.log('  Transportes pres.: ' + (a.transported_present.join(', ') || '(aucun)'));
    console.log('  Comptages        : auto=' + a.auto_count +
      ' review=' + a.review_count +
      ' weak=' + a.weak_count +
      ' exclusion_hit=' + a.exclusion_hit_count +
      ' total=' + a.total_clean);
    if (a.anomalies.length > 0) {
      a.anomalies.forEach(function(an) {
        console.log('  [ANOMALIE] ' + an.type + ' (' + an.count + ') -- ' + an.detail);
      });
    } else {
      console.log('  [OK] aucune anomalie');
    }
    console.log('');
  });
}

// -- Main ---------------------------------------------------------------------

(function main() {
  var shadowPath;
  if (shadowArg && /\.json$/i.test(shadowArg)) {
    shadowPath = path.isAbsolute(shadowArg)
      ? shadowArg
      : path.resolve(process.cwd(), shadowArg);
  } else {
    shadowPath = findLatestShadowJson(SHADOW_DIR);
  }
  if (!shadowPath || !fs.existsSync(shadowPath)) {
    process.stderr.write('[ERREUR] Aucun shadow JSON trouve.' +
      (shadowPath ? ' Chemin : ' + shadowPath : '') + '\n');
    process.exit(1);
  }
  var report;
  try {
    report = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
  } catch (e) {
    process.stderr.write('[ERREUR] Lecture shadow JSON : ' + e.message + '\n');
    process.exit(1);
  }
  if (!report || !Array.isArray(report.clients) || report.clients.length === 0) {
    process.stderr.write('[ERREUR] Aucun client dans le rapport shadow.\n');
    process.exit(1);
  }
  var audit = auditReport(report);
  printAudit(audit, shadowPath);
})();
