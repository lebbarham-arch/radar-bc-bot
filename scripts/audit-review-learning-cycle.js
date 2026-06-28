'use strict';
// scripts/audit-review-learning-cycle.js
// GD-051 -- Audit sobre du cycle d'apprentissage review -> decisions -> hints (shadow-only).
// Sortie console uniquement. Aucune ecriture fichier.
// Aucune modification du scoring, des seuils, des poids, de la prod.

var fs   = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');

// --- 1. Scripts du cycle ---
var CYCLE_SCRIPTS = [
  'scripts/replay-shadow-from-input-snapshot.js',
  'scripts/analyze-shadow-report.js',
  'scripts/import-review-decisions.js',
  'scripts/analyze-review-decisions.js',
  'scripts/build-client-learning-hints.js',
  'scripts/review-reason-learning-report.js',
  'scripts/build-review-reason-hint-candidates.js',
  'scripts/review-reason-hint-candidates.js',
  'scripts/approve-review-reason-hint-candidate.js',
  'scripts/apply-review-reason-hints-shadow.js',
  'scripts/review-reasons.js',
  'scripts/review-explainer.js',
];

// --- 2. Garde-fous attendus ---
var FORBIDDEN_ACTIONS_EXPECTED = [
  'auto_notify',
  'boost_score',
  'change_threshold',
  'change_weight',
  'apply_to_prod',
  'activate',
];

var FORBIDDEN_REASONS_EXPECTED = [
  'budget',
  'prix',
  'montant',
  'estimation',
];

var VALID_DECISIONS = ['keep', 'reject', 'ignore', ''];

// --- 3. Lecture source ---
function readSrc(relPath) {
  var fullPath = path.join(ROOT, relPath);
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch (e) {
    return null;
  }
}

// --- 4. Checks ---
var checks = [];

function ok(id, msg) {
  checks.push({ id: id, ok: true,  msg: msg });
}

function fail(id, msg) {
  checks.push({ id: id, ok: false, msg: msg });
}

// CHECK A : scripts du cycle presents
CYCLE_SCRIPTS.forEach(function(rel) {
  var src = readSrc(rel);
  if (src) {
    ok('A-present', rel);
  } else {
    fail('A-manquant', rel);
  }
});

// CHECK B : decisions valides dans import-review-decisions.js
(function() {
  var src = readSrc('scripts/import-review-decisions.js');
  if (!src) { fail('B1', 'import-review-decisions.js introuvable'); return; }
  var hasDecisions = VALID_DECISIONS.every(function(d) {
    var search = d === '' ? "''" : ("'" + d + "'");
    return src.indexOf(search) !== -1;
  });
  if (hasDecisions) {
    ok('B1', 'VALID_DECISIONS : keep/reject/ignore/vide presents');
  } else {
    fail('B1', 'VALID_DECISIONS : pattern inattendu dans import-review-decisions.js');
  }
  var hasPending = src.indexOf('counters.vide') !== -1;
  if (hasPending) {
    ok('B2', 'decisions vides comptabilisees separement (counters.vide)');
  } else {
    fail('B2', 'compteur vide absent de import-review-decisions.js');
  }
})();

// CHECK C : FORBIDDEN_ACTIONS dans candidates + apply
// Note : hint-candidates.js a 4 actions interdites (pas apply_to_prod/activate -- dans apply seulement).
var C_FORBIDDEN_CANDIDATES = ['auto_notify', 'boost_score', 'change_threshold', 'change_weight'];
var C_FORBIDDEN_APPLY      = FORBIDDEN_ACTIONS_EXPECTED; // 6 actions
(function() {
  var srcC = readSrc('scripts/review-reason-hint-candidates.js');
  if (!srcC) { fail('C-src', 'review-reason-hint-candidates.js introuvable'); return; }
  C_FORBIDDEN_CANDIDATES.forEach(function(action) {
    if (srcC.indexOf("'" + action + "'") !== -1) {
      ok('C-cand', 'hint-candidates : ' + action);
    } else {
      fail('C-cand', 'hint-candidates : action "' + action + '" absente de FORBIDDEN_ACTIONS');
    }
  });
})();
(function() {
  var srcA = readSrc('scripts/apply-review-reason-hints-shadow.js');
  if (!srcA) { fail('C-src', 'apply-review-reason-hints-shadow.js introuvable'); return; }
  C_FORBIDDEN_APPLY.forEach(function(action) {
    if (srcA.indexOf("'" + action + "'") !== -1) {
      ok('C-apply', 'apply : ' + action);
    } else {
      fail('C-apply', 'apply : action "' + action + '" absente de FORBIDDEN_ACTIONS');
    }
  });
})();

// CHECK D : safety=shadow_only inchangeable dans approve
(function() {
  var src = readSrc('scripts/approve-review-reason-hint-candidate.js');
  if (!src) { fail('D1', 'approve-review-reason-hint-candidate.js introuvable'); return; }
  var hasSafety = src.indexOf("'shadow_only'") !== -1 && src.indexOf('inchangeable') !== -1;
  if (hasSafety) {
    ok('D1', 'approve : safety=shadow_only marque inchangeable');
  } else {
    fail('D1', 'approve : marqueur safety/inchangeable absent');
  }
  var hasHVR = src.indexOf('human_validation_required') !== -1;
  if (hasHVR) {
    ok('D2', 'approve : human_validation_required maintenu');
  } else {
    fail('D2', 'approve : human_validation_required absent');
  }
  if (src.indexOf('human_approved_for_shadow') !== -1) {
    ok('D3', 'approve : status human_approved_for_shadow present');
  } else {
    fail('D3', 'approve : status human_approved_for_shadow absent');
  }
})();

// CHECK E : apply ne modifie pas copy.score (score brut non touche)
(function() {
  var src = readSrc('scripts/apply-review-reason-hints-shadow.js');
  if (!src) { fail('E1', 'apply-review-reason-hints-shadow.js introuvable'); return; }
  var hasCopyScoreAssign = /copy\.score\s*=/.test(src);
  if (!hasCopyScoreAssign) {
    ok('E1', 'apply : copy.score jamais assigne (score brut intact)');
  } else {
    fail('E1', 'apply : copy.score assigne -- score brut potentiellement modifie');
  }
  if (src.indexOf("'apply_to_prod'") !== -1) {
    ok('E2', 'apply : apply_to_prod dans FORBIDDEN_ACTIONS');
  } else {
    fail('E2', 'apply : apply_to_prod absent de FORBIDDEN_ACTIONS');
  }
  if (/copy\.auto_notify_candidate\s*=\s*false/.test(src)) {
    ok('E3', 'apply : auto_notify_candidate force a false sur copie shadow');
  } else {
    fail('E3', 'apply : auto_notify_candidate=false absent de apply');
  }
})();

// CHECK F : review-reasons.js : budget/prix/montant/estimation absents de REVIEW_REASON_CODES
(function() {
  var src = readSrc('scripts/review-reasons.js');
  if (!src) { fail('F1', 'review-reasons.js introuvable'); return; }
  var m = src.match(/var REVIEW_REASON_CODES\s*=\s*\[([\s\S]*?)\];/);
  if (!m) { fail('F1', 'REVIEW_REASON_CODES non trouve dans review-reasons.js'); return; }
  var block = m[1].toLowerCase();
  FORBIDDEN_REASONS_EXPECTED.forEach(function(word) {
    if (block.indexOf(word) === -1) {
      ok('F-reason', 'REVIEW_REASON_CODES : "' + word + '" absent (correct)');
    } else {
      fail('F-reason', 'REVIEW_REASON_CODES : "' + word + '" present -- interdit');
    }
  });
})();

// CHECK G : aucune regle client/domaine hardcodee dans apply et candidates
(function() {
  var targets = [
    'scripts/apply-review-reason-hints-shadow.js',
    'scripts/review-reason-hint-candidates.js',
    'scripts/build-client-learning-hints.js',
  ];
  // Note : 'nettoyage' est un terme de contexte generique dans CONTEXT_TERMS (apply),
  // pas une regle specifique a un client. On cherche des assignations hardcodees.
  var SUSPICIOUS = [
    "client_name.*=.*'[A-Z]",
    "clientKey.*===.*'",
    "if.*client.*===.*",
  ];
  var anyFail = false;
  targets.forEach(function(rel) {
    var src = readSrc(rel);
    if (!src) { return; }
    var srcLow = src.toLowerCase();
    SUSPICIOUS.forEach(function(pat) {
      if (srcLow.indexOf(pat) !== -1) {
        fail('G-hardcode', rel.split('/').pop() + ' : domaine hardcode detecte : ' + pat);
        anyFail = true;
      }
    });
  });
  if (!anyFail) {
    ok('G1', 'aucune regle client/domaine hardcodee dans les scripts de hints');
  }
})();

// CHECK H : replay shadow-only, pas d'appel Supabase
(function() {
  var src = readSrc('scripts/replay-shadow-from-input-snapshot.js');
  if (!src) { fail('H1', 'replay-shadow-from-input-snapshot.js introuvable'); return; }
  // replay lit Supabase en lecture seule pour charger profils clients -- attendu.
  // On verifie qu'il ne NOTIFIE pas et n'ecrit pas dans bcs_vus.
  // bcs_vus peut apparaitre dans les commentaires (ex: 'Ne touche pas bcs_vus') -- on cherche un acces reel.
  var hasWrite  = /\.from\s*\(\s*['"]bcs_vus/.test(src)
    || /INSERT\s+INTO\s+bcs_vus/i.test(src);
  var hasNotify = /auto_notify_candidate\s*=\s*true/.test(src)
    && src.indexOf('Ne notifie pas') === -1;
  if (!hasWrite) {
    ok('H1', 'replay : aucune ecriture dans bcs_vus');
  } else {
    fail('H1', 'replay : ecriture dans bcs_vus detectee -- verifier isolation');
  }
  if (!hasNotify) {
    ok('H2', 'replay : pas de notification prod');
  } else {
    fail('H2', 'replay : auto_notify_candidate=true sans garde-fou detecte');
  }
})();

// CHECK I : conventions review GD-105 -- rapport non-bloquant sur les decisions existantes.
// Detecte les violations les plus frequentes. N'ecrit rien. N'exit pas en echec.
// Fonctionne uniquement si data/review-decisions/ existe et contient des JSON.
//
// Convention A : BC annule ne doit pas etre IGNORE (doit etre REJECT).
// Convention B1: desinfection medicale hospitaliere ne doit pas etre IGNORE
//                (si produit pour usage medical interne, doit etre REJECT).

/**
 * detectConventionViolations(records)
 * records : tableau de decisions review (chaque objet a bc_id, decision, matched_signals, clean_text_excerpt).
 * Retourne un tableau de violations { convention, bc_id, decision, reason }.
 * Fonction pure -- aucune ecriture, aucun effet de bord.
 */
function detectConventionViolations(records) {
  var violations = [];
  (records || []).forEach(function(r) {
    var decision = (r.decision || '').toLowerCase().trim();
    var ex       = (r.clean_text_excerpt || '').toLowerCase();
    var sigs     = JSON.stringify(r.matched_signals || []).toLowerCase();

    // Convention A : BC annule classe IGNORE
    if (decision === 'ignore') {
      var isAnnule = ex.indexOf('annul') !== -1;
      if (isAnnule) {
        violations.push({
          convention : 'A',
          bc_id      : r.bc_id || r.id || '?',
          decision   : decision,
          reason     : 'BC annule classe IGNORE -- convention A : un BC annule doit etre REJECT'
        });
      }
    }

    // Convention B1 : desinfection medicale hospitaliere classe IGNORE
    if (decision === 'ignore') {
      var hasDesin = ex.indexOf('desinfect') !== -1 || ex.indexOf('désinfect') !== -1
        || sigs.indexOf('desinfect') !== -1 || sigs.indexOf('désinfect') !== -1;
      var hasHosp  = ex.indexOf('hopital') !== -1 || ex.indexOf('hôpital') !== -1
        || ex.indexOf('chp') !== -1 || ex.indexOf('chr') !== -1
        || ex.indexOf('centre hospitalier') !== -1
        || sigs.indexOf('hopital') !== -1 || sigs.indexOf('hôpital') !== -1;
      if (hasDesin && hasHosp) {
        violations.push({
          convention : 'B1',
          bc_id      : r.bc_id || r.id || '?',
          decision   : decision,
          reason     : 'desinfection medicale hospitaliere classe IGNORE -- convention B1 : si produit medical interne, doit etre REJECT'
        });
      }
    }
  });
  return violations;
}

// Lecture des decisions existantes (non-bloquant si data/ absent)
(function() {
  var decisionsDir = path.join(ROOT, 'data', 'review-decisions');
  var allRecords   = [];
  try {
    var files = fs.readdirSync(decisionsDir).filter(function(f) {
      return f.startsWith('review-decisions-') && f.endsWith('.json');
    });
    // Deduplication last-wins par bc_id+client
    var seen = {};
    files.forEach(function(f) {
      try {
        var raw     = JSON.parse(fs.readFileSync(path.join(decisionsDir, f), 'utf8'));
        var records = Array.isArray(raw) ? raw : (raw.records || raw.decisions || []);
        records.forEach(function(r) {
          var k = (r.bc_id || r.id || '') + '|' + (r.client || r.client_id || '');
          seen[k] = r;
        });
      } catch (_) {}
    });
    allRecords = Object.values(seen);
  } catch (_) {}

  if (allRecords.length === 0) { return; } // pas de donnees -- skip silencieux

  var violations = detectConventionViolations(allRecords);
  if (violations.length > 0) {
    console.log('');
    console.log('-- RAPPORT CONVENTIONS REVIEW GD-105 (non-bloquant) --');
    console.log('  ' + violations.length + ' violation(s) detectee(s) :');
    violations.forEach(function(v) {
      console.log('  [CONVENTION-' + v.convention + '] bc_id=' + v.bc_id + ' : ' + v.reason);
    });
    console.log('  -> Corriger via un CSV de re-classification (voir docs/REVIEW_CONVENTIONS.md)');
    console.log("  -> Ce rapport n'exit pas en echec et ne modifie aucune decision.");
  }
})();

// --- 5. Rapport ---
var nbOk   = checks.filter(function(c) { return c.ok;  }).length;
var nbFail = checks.filter(function(c) { return !c.ok; }).length;

console.log('\n=== AUDIT CYCLE LEARNING REVIEW (GD-051) ===');
console.log('  Checks OK   : ' + nbOk);
console.log('  Checks FAIL : ' + nbFail);
console.log('');

var verbose = process.argv.indexOf('--verbose') !== -1;
if (verbose) {
  checks.forEach(function(c) {
    console.log('  [' + (c.ok ? 'OK  ' : 'FAIL') + '] ' + c.id + ' : ' + c.msg);
  });
} else {
  var fails = checks.filter(function(c) { return !c.ok; });
  if (fails.length === 0) {
    console.log('  [OK] Aucune anomalie detectee.');
  } else {
    fails.forEach(function(c) {
      console.log('  [FAIL] ' + c.id + ' : ' + c.msg);
    });
  }
}

console.log('');
console.log('-- GARDE-FOUS SHADOW --');
console.log('  safety=shadow_only    : inchangeable dans approve');
console.log('  human_validation_required : toujours true');
console.log('  FORBIDDEN_ACTIONS     : ' + FORBIDDEN_ACTIONS_EXPECTED.join(', '));
console.log('  score brut            : jamais modifie par apply');
console.log('  budget/prix/montant/estimation : absents de REVIEW_REASON_CODES');
console.log('');
console.log('-- CYCLE (ordre operationnel) --');
console.log('  1. replay-shadow-from-input-snapshot.js   -- genere review_candidate/auto_notify_candidate');
console.lo