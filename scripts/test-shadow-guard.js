'use strict';
/**
 * test-shadow-guard.js
 * Tests unitaires inline pour _shadowContextGuardBlocked (shadow BC matching).
 * Bases sur les 30 decisions humaines importees (review-decisions-2026-06-09).
 *
 * Usage :  node scripts/test-shadow-guard.js
 * Exit 0 = tous les tests passent.
 * Exit 1 = au moins un echec.
 */

// --- Stubs des helpers (copies fideles de radar-bc-bot.js) ---

function norm(s) {
  if (!s) return '';
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hasKw(text, kw) {
  var n = norm(text);
  var nk = norm(kw);
  if (!nk) return false;
  var esc = nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + esc).test(n);
}

/**
 * hasKwFuzzy - copie exacte de la vraie implementation dans radar-bc-bot.js
 * GD-021 : mots courts <= 5 chars = exact seulement (evite toner/tuner)
 * maxDist : 2 si len >= 8, sinon 1
 */
function levenshtein(a, b) {
  var m = a.length, n = b.length;
  var dp = [];
  for (var i = 0; i <= m; i++) {
    dp[i] = [];
    for (var j = 0; j <= n; j++)
      dp[i][j] = i === 0 ? j : j === 0 ? i : 0;
  }
  for (var i = 1; i <= m; i++)
    for (var j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}
function hasKwFuzzy(text, kw) {
  if (hasKw(text, kw)) return true;
  var nk = norm(kw);
  if (nk.length <= 5) return false;
  var maxDist = nk.length >= 8 ? 2 : 1;
  return norm(text).split(/\s+/).some(function(w) {
    return Math.abs(w.length - nk.length) <= maxDist + 1 &&
      w[0] === nk[0] && // GD-022 : premiere lettre doit correspondre (evite patisserie/tapisserie)
      levenshtein(w, nk) <= maxDist;
  });
}

function hasAnyKw(text, terms) {
  return (terms || []).some(function(t) { return t && hasKwFuzzy(text, t); });
}

// GD-023 : stub identique au bot (shadow only, pas de notif)
var CLEAN_TRUSTED_INCLUSION_SCORE = new Set([
  'photocopieur', 'insecticide', 'deratisation', 'desinsectisation',
  'desinfection', 'savon', 'eau minerale',
]);

// --- Copie de _shadowContextGuardBlocked (doit rester identique a radar-bc-bot.js) ---

function _shadowContextGuardBlocked(normSignal, cleanText) {
  if (normSignal === 'reseau') {
    var IT_CTX = [
      'systeme d information', 'systeme informatique', 'audit si',
      'informatique', 'reseau informatique',
      'securite informatique', 'lan', 'switch', 'routeur', 'serveur',
      'poste de travail', 'ordinateur',
    ];
    return !hasAnyKw(cleanText, IT_CTX);
  }
  if (normSignal === 'scanner') {
    var VERB_SCANNER = [
      'scanner et envoyer', 'a scanner et envoyer', 'scanner puis envoyer',
      'scanner le document',
    ];
    if (hasAnyKw(cleanText, VERB_SCANNER)) return true;
    var HARDWARE_SCANNER = [
      'achat de scanner', 'acquisition de scanner', 'fourniture de scanner',
      'scanners', 'acquisition scanner', 'achat scanner',
    ];
    return !hasAnyKw(cleanText, HARDWARE_SCANNER);
  }
  if (normSignal === 'pc') {
    var IT_CTX_PC = [
      'ordinateur', 'informatique', 'poste de travail', 'materiel informatique',
      'equipement informatique', 'serveur', 'logiciel', 'licence',
      'reseau informatique', 'imprimante', 'maintenance informatique',
      'bureautique', 'unite centrale',
    ];
    return !hasAnyKw(cleanText, IT_CTX_PC);
  }
  if (normSignal === 'produits alimentaires') {
    var FOOD_PURCHASE = [
      'achat de produits alimentaires', 'achat des produits alimentaires',
      'achat produits alimentaires',
      'acquisition de produits alimentaires',
      'fourniture de produits alimentaires',
      'fourniture de denrees alimentaires',
      'achat de denrees', 'achat des denrees',
      'denrees alimentaires',
      'alimentation humaine', 'usage humain',
    ];
    return !hasAnyKw(cleanText, FOOD_PURCHASE);
  }
  if (normSignal === 'alimentation') {
    var ANIMAL_CTX = [
      'betail', 'fourrage', 'alimentation animale', 'alimentation de betail',
      'aliment compose', 'bovin', 'ovin', 'caprin', 'elevage',
    ];
    if (hasAnyKw(cleanText, ANIMAL_CTX)) return true;
    var HUMAN_CTX = [
      'reception', 'evenement', 'ceremonie', 'invite', 'convives',
      'traiteur', 'repas', 'restauration', 'cantine',
      'usage humain', 'produits alimentaires', 'denrees',
    ];
    return !hasAnyKw(cleanText, HUMAN_CTX);
  }
  if (normSignal === 'hygiene') {
    var HYGIENE_PRODUCT_CTX = [
      'produits chimiques', 'produit chimique',
      'produits d hygiene', 'produit d hygiene',
      'nettoyage', 'desinfection', 'deratisation', 'desinsectisation',
      'insecticide', 'savon', 'detergent', 'desinfectant',
      'pesticide', 'produits menagers',
    ];
    return !hasAnyKw(cleanText, HYGIENE_PRODUCT_CTX);
  }
  return false;
}

// --- Harness de test ---

var passed = 0;
var failed = 0;
var errors = [];

function t(label, signal, cleanText, expectBlock) {
  var got = _shadowContextGuardBlocked(signal, cleanText);
  if (got === expectBlock) {
    passed++;
    process.stdout.write('  OK ' + label + '\n');
  } else {
    failed++;
    var msg = '  FAIL ' + label
      + ' -- attendu ' + (expectBlock ? 'BLOCK' : 'PASS')
      + ' got ' + (got ? 'BLOCK' : 'PASS');
    errors.push(msg);
    process.stdout.write(msg + '\n');
  }
}

// === PC ===
process.stdout.write('\n-- PC -----------------------------------------------\n');

t('PC-ref-340186 [REJECT ref #BC28/2026/PC/PT]',
  'pc',
  'Accueil liste des avis d achat #BC28/2026/PC/PT Articles',
  true
);
t('PC-ref-340755 [REJECT ref #13/2026/PC/PAZ]',
  'pc',
  'Marche de travaux #13/2026/PC/PAZ Commune Rurale de Tamazouzt',
  true
);
t('PC-ref-340716 [REJECT ref budgetaire PC]',
  'pc',
  'Consultation travaux chapitre PC 2026 direction provinciale',
  true
);
t('PC-ref-340707 [REJECT ref PCIF]',
  'pc',
  'Prestation de service Maintenance PCIF commune urbaine',
  true
);
t('PC-protection-civile-348532 [REJECT Protection Civile batiment]',
  'pc',
  'Travaux entretien reparation batiments administratifs Protection Civile ref PC/2026',
  true
);
t('PC-info-KEEP [achat poste de travail informatique]',
  'pc',
  'Acquisition de 10 PC de bureau poste de travail bureautique',
  false
);
t('PC-info-KEEP2 [maintenance informatique postes PC]',
  'pc',
  'Maintenance des postes PC et imprimantes equipements informatiques',
  false
);

// === PRODUITS ALIMENTAIRES ===
process.stdout.write('\n-- PRODUITS ALIMENTAIRES ----------------------------\n');

t('PA-ONSSA-348038 [REJECT organisme ONSSA]',
  'produits alimentaires',
  'Frais de conception edition impression diffusion. DETAILS Acheteur public OFFICE NATIONAL DE SECURITE SANITAIRE DES PRODUITS ALIMENTAIRES',
  true
);
t('PA-DPAE-ref [REJECT organisme DPAE]',
  'produits alimentaires',
  'Rehabilitation reseau irrigation. DETAILS Acheteur public DIRECTION PROVINCIALE DE L AGRICULTURE PRODUITS ALIMENTAIRES ET DE LA PECHE',
  true
);
t('PA-ensiasd-345109 [KEEP achat des produits alimentaires]',
  'produits alimentaires',
  'Achat des Produits Alimentaires au profit de l ENSIASD Taroudant',
  false
);
t('PA-reception-348283 [KEEP achat produits alimentaires reception]',
  'produits alimentaires',
  'Achat produits alimentaires pour reception',
  false
);
t('PA-invites-348006 [KEEP achat de produits alimentaires invites]',
  'produits alimentaires',
  'Achat de Produits Alimentaires destine a la reception des invites',
  false
);
t('PA-acquisition [KEEP acquisition de produits alimentaires]',
  'produits alimentaires',
  'Acquisition de produits alimentaires pour la restauration du personnel',
  false
);
t('PA-denrees [KEEP denrees alimentaires cantine]',
  'produits alimentaires',
  'Fourniture de denrees alimentaires pour la cantine scolaire',
  false
);

// === ALIMENTATION ===
process.stdout.write('\n-- ALIMENTATION -------------------------------------\n');

t('ALI-betail-347637 [REJECT alimentation betail]',
  'alimentation',
  'Achat d alimentation de betail pour le Domaine Experimental',
  true
);
t('ALI-fourrage [REJECT fourrage elevage]',
  'alimentation',
  'Fourniture de fourrage et alimentation pour le cheptel ovin',
  true
);
t('ALI-bovin [REJECT aliment compose bovin]',
  'alimentation',
  'Achat d aliment compose pour bovins alimentation elevage',
  true
);
t('ALI-reception-348455 [KEEP alimentation receptions evenements]',
  'alimentation',
  'Achat de produits alimentation pour l organisation des receptions et des evenements',
  false
);
t('ALI-restauration [KEEP alimentation restauration]',
  'alimentation',
  'Fourniture alimentation et denrees pour la restauration collective',
  false
);
t('ALI-traiteur [KEEP alimentation traiteur]',
  'alimentation',
  'Prestation traiteur et alimentation pour seminaire',
  false
);
t('ALI-cantine [KEEP alimentation cantine]',
  'alimentation',
  'Achat produits alimentation pour la cantine du personnel',
  false
);
t('ALI-ceremonie [KEEP alimentation ceremonie]',
  'alimentation',
  'Fourniture alimentation pour ceremonie officielle',
  false
);

// === HYGIENE ===
process.stdout.write('\n-- HYGIENE ------------------------------------------\n');

t('HYG-INH-organisme [REJECT nom organisme INH]',
  'hygiene',
  'Acquisition de materiel de laboratoire. DETAILS Acheteur public INSTITUT NATIONAL D HYGIENE',
  true
);
t('HYG-milieu-348637 [REJECT materiel medico programmes hygiene milieu]',
  'hygiene',
  'ACHAT DE MATERIEL MEDICO TECHNIQUE DESTINES AUX DIFFERENTS PROGRAMMES D HYGIENE DU MILIEU',
  true
);
t('HYG-pharmaceutiques-347005 [IGNORE produits pharmaceutiques service hygiene]',
  'hygiene',
  'Achat de petits materiel et produits pharmaceutiques destine au service d Ygiene',
  true
);
t('HYG-sante-publique [IGNORE programme sante hygiene alimentaire]',
  'hygiene',
  'Formation et sensibilisation sur l hygiene alimentaire et sanitaire',
  true
);
t('HYG-INH-equipement [REJECT equipement bureau INH]',
  'hygiene',
  'Achat de mobilier et equipements de bureau. DETAILS Acheteur public INSTITUT NATIONAL D HYGIENE DIRECTION REGIONALE',
  true
);
t('HYG-chimiques-347874 [KEEP produits chimiques hygiene de milieu]',
  'hygiene',
  'Achat de produits chimiques pour l hygiene de milieu',
  false
);
t('HYG-desinfection [KEEP desinfection nettoyage]',
  'hygiene',
  'Fourniture de produits de nettoyage desinfection et detergents pour les locaux',
  false
);
t('HYG-deratisation [KEEP deratisation desinsectisation]',
  'hygiene',
  'Prestation de deratisation desinsectisation et desinfection des locaux',
  false
);
t('HYG-savon-detergent [KEEP savon detergent desinfectant]',
  'hygiene',
  'Achat de savon liquide detergent et desinfectant pour les services',
  false
);
t('HYG-insecticide [KEEP insecticide pesticide]',
  'hygiene',
  'Acquisition d insecticides et pesticides pour l hygiene du milieu',
  false
);

// === SCANNER (regression) ===
process.stdout.write('\n-- SCANNER (regression) -----------------------------\n');

t('SCN-verbal [BLOCK scanner et envoyer]',
  'scanner',
  'Documents a scanner et envoyer par email au secretariat',
  true
);
t('SCN-achat [PASS achat de scanner]',
  'scanner',
  'Achat de scanner A3 pour le service courrier',
  false
);
t('SCN-scanners [PASS scanners pluriel]',
  'scanner',
  'Acquisition de scanners haute vitesse pour les archives',
  false
);

// === RESEAU (regression) ===
process.stdout.write('\n-- RESEAU (regression) ------------------------------\n');

t('RSX-routier [BLOCK reseau routier]',
  'reseau',
  'Travaux de rehabilitation du reseau routier provincial',
  true
);
t('RSX-eau [BLOCK reseau eau potable]',
  'reseau',
  'Renouvellement du reseau d eau potable',
  true
);
t('RSX-info [PASS reseau informatique]',
  'reseau',
  'Mise en place d un reseau informatique securise LAN',
  false
);
t('RSX-systeme [PASS systeme d information]',
  'reseau',
  'Deploiement reseau systeme d information',
  false
);
t('RSX-systeme-seul [PASS systeme d information sans reseau]',
  'reseau',
  'Deploiement du systeme d information de la prefecture',
  false
);
t('RSX-audit-si [PASS audit SI]',
  'reseau',
  'Audit du systeme informatique et du reseau',
  false
);

// === AUTRES SIGNAUX ===
process.stdout.write('\n-- AUTRES SIGNAUX (pas de garde) --------------------\n');

t('UNKNOWN-signal [toujours PASS]',
  'imprimante',
  'Achat d une imprimante laser',
  false
);


// === GD-022 : hasKwFuzzy — premiere lettre obligatoire (patisserie/tapisserie) ===
// Helper direct pour hasKwFuzzy (independant de _shadowContextGuardBlocked)
function tf(label, kw, text, expectMatch) {
  var got = hasKwFuzzy(text, kw);
  if (got === expectMatch) {
    passed++;
    process.stdout.write('  OK ' + label + '\n');
  } else {
    failed++;
    var msg = '  FAIL ' + label
      + ' -- attendu ' + (expectMatch ? 'MATCH' : 'NO-MATCH')
      + ' got ' + (got ? 'MATCH' : 'NO-MATCH');
    errors.push(msg);
    process.stdout.write(msg + '\n');
  }
}

process.stdout.write('\n-- GD-022 fuzzy premiere lettre -------------------\n');

tf('GD022-patisserie-match [MATCH patisserie dans texte avec accent]',
  'patisserie',
  'achat de patisserie',
  true
);
tf('GD022-patisserie-unicode-match [MATCH patisserie norm vs accent]',
  'patisserie',
  'achat de patisserie pour la CMC Casablanca',
  true
);
tf('GD022-tapisserie-no-match [NO-MATCH patisserie ne match pas tapisserie]',
  'patisserie',
  'fournisseur de tapisserie',
  false
);
tf('GD022-tapisserie-ofppt-no-match [NO-MATCH patisserie ne match pas tapisserie ofppt]',
  'patisserie',
  'filiere menuiserie et tapisserie ofppt diretion regionale',
  false
);


// === GD-023 : CLEAN_TRUSTED_INCLUSION_SCORE — score 10 vs 5 ===
// ts(label, normSignal, expectTrusted) — vérifie que le Set classe bien le signal
function ts(label, normSignal, expectTrusted) {
  var got = CLEAN_TRUSTED_INCLUSION_SCORE.has(normSignal);
  var expectedScore = expectTrusted ? 10 : 5;
  var gotScore      = got ? 10 : 5;
  if (got === expectTrusted) {
    passed++;
    process.stdout.write('  OK ' + label + ' => score ' + gotScore + '\n');
  } else {
    failed++;
    var msg = '  FAIL ' + label
      + ' -- attendu score ' + expectedScore
      + ' got score ' + gotScore;
    errors.push(msg);
    process.stdout.write(msg + '\n');
  }
}

process.stdout.write('\n-- GD-023 trusted inclusion scores ---------------\n');

ts('photocopieur => trusted score 10',       'photocopieur',      true);
ts('insecticide => trusted score 10',        'insecticide',       true);
ts('deratisation => trusted score 10',       'deratisation',      true);
ts('desinsectisation => trusted score 10',   'desinsectisation',  true);
ts('desinfection => trusted score 10',       'desinfection',      true);
ts('savon => trusted score 10',              'savon',             true);
ts('eau minerale => trusted score 10',       'eau minerale',      true);
ts('systeme d information => score 5',       'systeme d information', false);
ts('produits alimentaires => score 5',       'produits alimentaires', false);
ts('alimentation => score 5',               'alimentation',      false);

// --- Resume ---
process.stdout.write('\n' + '-'.repeat(55) + '\n');
process.stdout.write('Resultat : ' + passed + ' passes, ' + failed + ' echoues\n');

if (failed > 0) {
  process.stdout.write('\nECHECS :\n');
  errors.forEach(function(e) { process.stdout.write(e + '\n'); });
  process.exit(1);
} else {
  process.stdout.write('Tous les tests sont verts.\n');
  process.exit(0);
}
