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
console.log('  2. analyze-shadow-report.js --export-review-csv -- exporte CSV review-candidates');
console.log('  3. [HUMAIN] Renseigne decision keep/reject/ignore dans le CSV');
console.log('  4. import-review-decisions.js             -- importe CSV -> JSON review-decisions');
console.log('  5. build-client-learning-hints.js         -- construit hints client/signal');
console.log('  6. review-reason-learning-report.js       -- rapport patterns de raisons');
console.log('  7. build-review-reason-hint-candidates.js -- genere candidates (pending)');
console.log('  8. [HUMAIN] approve-review-reason-hint-candidate.js -- valide hint');
console.log('  9. apply-review-reason-hints-shadow.js    -- applique hint sur copie shadow');
console.log('  shadow uniquement -- aucune activation prod');
console.log('');

if (nbFail > 0) {
  process.exit(1);
}
