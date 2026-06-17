#!/usr/bin/env node
/**
 * analyze-review-decisions.js
 * GD-031 — Script d'analyse réutilisable des décisions admin review.
 *
 * Usage:
 *   node scripts/analyze-review-decisions.js
 *   node scripts/analyze-review-decisions.js --json          # output JSON brut
 *   node scripts/analyze-review-decisions.js --shadow        # inclut croisement shadow export
 *   node scripts/analyze-review-decisions.js --save-summary  # écrit data/review-decisions/summary-*.json
 *
 * Lit:   data/review-decisions/review-decisions-*.json
 *        data/shadow/legacy-vs-clean-admin-*.json  (optionnel avec --shadow)
 * Écrit: data/review-decisions/summary-{ts}.json  (avec --save-summary)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT     = path.resolve(__dirname, '..');
const DEC_DIR  = path.join(ROOT, 'data', 'review-decisions');
const SHAD_DIR = path.join(ROOT, 'data', 'shadow');
const JSON_OUT     = process.argv.includes('--json');
const WITH_SHADOW  = process.argv.includes('--shadow');
const SAVE_SUMMARY = process.argv.includes('--save-summary');

// ─── 1. Lecture et déduplication des décisions ──────────────────────────────

function loadDecisions() {
  const files = fs.readdirSync(DEC_DIR)
    .filter(f => f.startsWith('review-decisions') && f.endsWith('.json') && !f.includes('summary'))
    .map(f => path.join(DEC_DIR, f));

  const all = [];
  for (const fp of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const imported_at = raw.imported_at || raw.saved_at || path.basename(fp);
      for (const r of (raw.records || [])) {
        all.push({ ...r, imported_at, bc_id: String(r.bc_id || '') });
      }
    } catch (_) {}
  }

  // last-wins par client::bc_id (tri par imported_at)
  all.sort((a, b) => a.imported_at < b.imported_at ? -1 : 1);
  const map = new Map();
  for (const r of all) map.set(r.client + '::' + r.bc_id, r);
  return Array.from(map.values());
}

// ─── 2. Agrégation ──────────────────────────────────────────────────────────

function aggregate(rows) {
  const dec = { keep: 0, reject: 0, ignore: 0 };
  const byClient  = {};
  const bySignal  = {};
  const byScore   = {};

  for (const r of rows) {
    const d = r.decision;
    if (!dec[d] && dec[d] !== 0) continue;
    dec[d]++;

    // par client
    if (!byClient[r.client]) byClient[r.client] = { keep: 0, reject: 0, ignore: 0 };
    byClient[r.client][d]++;

    // par signal
    for (const s of (r.matched_signals || [])) {
      if (!bySignal[s]) bySignal[s] = { keep: 0, reject: 0, ignore: 0, total: 0 };
      bySignal[s][d]++;
      bySignal[s].total++;
    }

    // par score
    const sc = String(r.score || 0);
    if (!byScore[sc]) byScore[sc] = { keep: 0, reject: 0, ignore: 0 };
    byScore[sc][d]++;
  }

  // Classification des signaux
  const classify = (v) => {
    const kr = v.total ? v.keep   / v.total : 0;
    const rr = v.total ? v.reject / v.total : 0;
    if (kr >= 0.8)  return 'FORT_KEEP';
    if (rr >= 0.8)  return 'FORT_REJECT';
    if (v.total === 1) return 'UNIQUE';
    return 'AMBIGU';
  };

  const signalReport = Object.entries(bySignal)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([sig, v]) => ({
      signal: sig,
      total: v.total,
      keep: v.keep,
      reject: v.reject,
      ignore: v.ignore,
      keep_rate: v.total ? Math.round(v.keep / v.total * 100) : 0,
      reject_rate: v.total ? Math.round(v.reject / v.total * 100) : 0,
      category: classify(v),
    }));

  return { global: dec, byClient, signalReport, byScore };
}

// ─── 2b. Verdict générique par signal ────────────────────────────────────────
// Calcule un verdict lisible depuis les données agrégées.
// Aucune règle spécifique à un signal — uniquement des ratios et seuils.
// Retourne une valeur compatible avec loadSignalRiskTable() dans analyze-shadow-report.js.
function classifyVerdict(v) {
  if (!v.total) return 'Insuffisant';
  const kr = v.keep   / v.total;
  const rr = v.reject / v.total;
  if (kr >= 0.8 && v.total >= 2) return 'Très fiable';
  if (kr >= 0.6 && v.total >= 2) return 'Fiable';
  if (rr >= 0.8 && v.total >= 2) return 'Risqué';
  if (v.total === 1)              return 'Insuffisant';
  return 'Ambigu';
}

// ─── 5. Sauvegarde du summary review-decisions ───────────────────────────────
// Produit data/review-decisions/summary-{ts}.json.
// Ce fichier est lu par loadSignalRiskTable() dans analyze-shadow-report.js
// pour enrichir les exports shadow avec le tier de risque réel des signaux.
function saveSummary(rows, signalReport) {
  const ts    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fname = `summary-${ts}.json`;
  const fpath = path.join(DEC_DIR, fname);
  const summary = {
    generated_at:    new Date().toISOString(),
    total_decisions: rows.length,
    by_signal:       signalReport.map(s => ({
      signal:      s.signal,
      verdict:     classifyVerdict({ total: s.total, keep: s.keep, reject: s.reject }),
      keep:        s.keep,
      reject:      s.reject,
      ignore:      s.ignore,
      total:       s.total,
      keep_rate:   s.keep_rate,
      reject_rate: s.reject_rate,
    })),
  };
  fs.writeFileSync(fpath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`[--save-summary] Summary écrit : ${fname}`);
  console.log(`  ${summary.by_signal.length} signal(s) — total_decisions=${rows.length}`);
  return summary;
}

// ─── 3. Croisement shadow export (optionnel) ────────────────────────────────

function loadLatestShadow() {
  const files = fs.readdirSync(SHAD_DIR)
    .filter(f => f.startsWith('legacy-vs-clean-admin-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) return null;
  return JSON.parse(fs.readFileSync(path.join(SHAD_DIR, files[0]), 'utf8'));
}

// ─── 4. Affichage texte ─────────────────────────────────────────────────────

function printReport(agg, rows, shadow) {
  const { global: g, byClient, signalReport, byScore } = agg;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║        GD-031 — Rapport d\'analyse décisions admin        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  console.log(`Total décisions (déduplicatées) : ${rows.length}`);
  console.log(`  KEEP=${g.keep}  REJECT=${g.reject}  IGNORE=${g.ignore}\n`);

  console.log('── Par client ──────────────────────────────────────────────');
  for (const [c, v] of Object.entries(byClient)) {
    const total = v.keep + v.reject + v.ignore;
    console.log(`  ${c.replace('TEST PROD - ', '').padEnd(30)} K=${v.keep} R=${v.reject} I=${v.ignore}  (total=${total})`);
  }

  console.log('\n── Par score ───────────────────────────────────────────────');
  for (const [sc, v] of Object.entries(byScore).sort((a,b)=>Number(a[0])-Number(b[0]))) {
    const t = v.keep+v.reject+v.ignore;
    const kr = Math.round(v.keep/t*100);
    console.log(`  score=${sc.padEnd(4)}  total=${t}  K=${v.keep}(${kr}%)  R=${v.reject}  I=${v.ignore}`);
  }

  console.log('\n── Par signal ──────────────────────────────────────────────');
  const cats = { FORT_KEEP: [], FORT_REJECT: [], AMBIGU: [], UNIQUE: [] };
  for (const s of signalReport) {
    const line = `  ${JSON.stringify(s.signal).padEnd(30)} total=${s.total}  K=${s.keep}(${s.keep_rate}%)  R=${s.reject}(${s.reject_rate}%)  I=${s.ignore}`;
    console.log(line);
    (cats[s.category] || cats.AMBIGU).push(s.signal);
  }

  console.log('\n── Signaux FORT KEEP (≥80% keep) ──────────────────────────');
  console.log(' ', cats.FORT_KEEP.join(', ') || '—');

  console.log('\n── Signaux FORT REJECT (≥80% reject) ──────────────────────');
  console.log(' ', cats.FORT_REJECT.join(', ') || '—');

  console.log('\n── Signaux AMBIGUS (à garder en review) ───────────────────');
  console.log(' ', cats.AMBIGU.join(', ') || '—');

  if (shadow) {
    console.log('\n── Shadow export (dernière snapshot) ──────────────────────');
    const s = shadow.summary || {};
    console.log(`  Snapshot : ${shadow.exported_at || '?'}`);
    console.log(`  legacy_sent_only=${s.legacy_sent_only}  clean_auto_only=${s.clean_auto_only}  clean_review_only=${s.clean_review_only}`);
    console.log(`  with_risk_warning=${s.with_risk_warning}`);
  }

  console.log('\n── Hypothèses de règles futures (à valider, non implémentées) ─');
  const hypotheses = [
    'H1 [GUARD]  `PC` seul → exclure si score ≤ 5 : 0% KEEP sur 5 occurrences multi-cycles.',
    'H2 [AUTO+]  `dératisation`,`désinsectisation`,`insecticide` → auto-promote si score ≥ 10 + no warning : 100% KEEP.',
    'H3 [AUTO+]  `photocopieur`,`logiciel`,`materiel informatique`,`serveur` → auto-promote IT si score ≥ 10 : 100% KEEP.',
    'H4 [AUTO+]  `désinfectant`,`désinfection`,`savon`,`nettoyage` → auto-promote NH si score ≥ 10 + no warning.',
    'H5 [REVIEW] `hygiène` seul (score=5) → maintenir en review : 17% KEEP seulement.',
    'H6 [REVIEW] `produits alimentaires` (score=5) → maintenir en review : 58% KEEP, contexte décisif.',
    'H7 [REVIEW] `alimentation` seul → maintenir en review : 40% KEEP, trop ambigu.',
    'H8 [IGNORE] `café`,`thé` → candidat IGNORE auto si pas de signal complémentaire fort.',
    'H9 [SCORE]  score ≥ 10 + no warning → taux KEEP 87% (13/15) : fort prédicteur positif.',
    'H10[SCORE]  score = 5 → taux KEEP 37% (12/32) : revue manuelle systématique.',
  ];
  for (const h of hypotheses) console.log(' ', h);

  console.log('\n════════════════════════════════════════════════════════════\n');
}

// ─── main ────────────────────────────────────────────────────────────────────

const rows   = loadDecisions();
const agg    = aggregate(rows);
const shadow = WITH_SHADOW ? loadLatestShadow() : null;

if (JSON_OUT) {
  console.log(JSON.stringify({ rows: rows.length, ...agg, shadow_summary: shadow && shadow.summary }, null, 2));
} else {
  printReport(agg, rows, shadow);
}

if (SAVE_SUMMARY) {
  saveSummary(rows, agg.signalReport);
}
