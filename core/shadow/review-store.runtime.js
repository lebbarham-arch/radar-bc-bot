'use strict';
/**
 * review-store.runtime.js — GD-029
 *
 * Port CommonJS de core/shadow/review-store.ts.
 * Utilisé directement par radar-bc-bot.js (sans build TypeScript).
 * Maintenir en sync avec la version TS.
 *
 * Shadow/admin uniquement — aucun effet production, aucun Supabase, aucune notif.
 */

var fs   = require('fs');
var path = require('path');

// ─── IFileSystem réel ────────────────────────────────────────────────────────

var realFs = {
  readdirSync:  function(dir) { return fs.readdirSync(dir); },
  readFileSync: function(p, enc) { return fs.readFileSync(p, enc); },
  writeFileSync:function(p, data, enc) { return fs.writeFileSync(p, data, enc); },
  existsSync:   function(p) { return fs.existsSync(p); },
  mkdirSync:    function(p, opts) { return fs.mkdirSync(p, opts || {}); },
};

// ─── Helpers internes ────────────────────────────────────────────────────────

function normTier(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// ─── computePriority ─────────────────────────────────────────────────────────

function computePriority(row) {
  var hasWarning = !!(row.warning);
  var tier       = normTier(row.signal_risk_tier || '');
  var isRisky    = tier === 'ambigu' || tier === 'risque' || tier === 'insuffisant';

  if (hasWarning || isRisky) return 'P5';

  var isFiable = tier === 'tres fiable';
  if (row.clean_auto_candidate && isFiable) return 'P1';

  var bucket = row.comparison_bucket || '';
  if (bucket === 'legacy_and_clean_auto' || row.clean_auto_candidate) return 'P2';
  if (bucket === 'clean_review_only' || bucket === 'legacy_and_clean_review'
      || row.clean_review_candidate) return 'P3';

  return 'P4';
}

// ─── listShadowFiles ─────────────────────────────────────────────────────────

function listShadowFiles(pattern, shadowDir, fsp) {
  var fspUsed = fsp || realFs;
  try {
    return fspUsed.readdirSync(shadowDir).filter(function(f) {
      return pattern.test(f);
    }).sort();
  } catch (e) {
    return [];
  }
}

// ─── loadLatestLvcReport ─────────────────────────────────────────────────────

function loadLatestLvcReport(shadowDir, fsp) {
  var fspUsed = fsp || realFs;
  var files = listShadowFiles(/^legacy-vs-clean-admin-.*\.json$/, shadowDir, fspUsed);
  if (!files.length) return null;
  var fname = files[files.length - 1];
  try {
    var raw = fspUsed.readFileSync(path.join(shadowDir, fname), 'utf8');
    var d   = JSON.parse(raw);
    d._filename = fname;
    return d;
  } catch (e) {
    return null;
  }
}

// ─── loadLatestAutoReport ────────────────────────────────────────────────────

function loadLatestAutoReport(shadowDir, fsp) {
  var fspUsed = fsp || realFs;
  var files = listShadowFiles(/^auto-candidates-admin-.*\.json$/, shadowDir, fspUsed);
  if (!files.length) return null;
  var fname = files[files.length - 1];
  try {
    var raw = fspUsed.readFileSync(path.join(shadowDir, fname), 'utf8');
    var d   = JSON.parse(raw);
    d._filename = fname;
    return d;
  } catch (e) {
    return null;
  }
}

// ─── loadExistingDecisions ───────────────────────────────────────────────────

function loadExistingDecisions(decisionsDir, fsp) {
  var fspUsed = fsp || realFs;
  var map = {};
  var files = [];
  try {
    files = fspUsed.readdirSync(decisionsDir)
      .filter(function(f) { return /^review-decisions-.*\.json$/.test(f); })
      .sort();
  } catch (e) {
    return map;
  }
  for (var i = 0; i < files.length; i++) {
    try {
      var raw  = fspUsed.readFileSync(path.join(decisionsDir, files[i]), 'utf8');
      var data = JSON.parse(raw);
      var importedAt = data.imported_at || files[i];
      var records    = data.records || [];
      for (var j = 0; j < records.length; j++) {
        var rec = records[j];
        var key = rec.client + '::' + rec.bc_id;
        var dec = rec.decision;
        if (dec === 'keep' || dec === 'reject' || dec === 'ignore') {
          map[key] = { decision: dec, decided_at: importedAt };
        }
      }
    } catch (e) { /* skip */ }
  }
  return map;
}

// ─── mergeReports ────────────────────────────────────────────────────────────

function mergeReports(lvc, auto, decisions) {
  var autoIdx = {};
  if (auto && auto.candidates) {
    auto.candidates.forEach(function(c) {
      autoIdx[c.client + '::' + c.bc_id] = c;
    });
  }

  return (lvc.rows || []).map(function(raw) {
    var key  = raw.client + '::' + raw.bc_id;
    var enr  = autoIdx[key];
    var prev = decisions[key];

    var row = {
      report_date:            String(raw.report_date  || lvc.report_date || ''),
      client:                 String(raw.client       || ''),
      bc_id:                  String(raw.bc_id        || ''),
      clean_text_excerpt:     String(raw.clean_text_excerpt || '').slice(0, 200),
      comparison_bucket:      String(raw.comparison_bucket || ''),
      legacy_sent:            !!(raw.legacy_sent),
      clean_score:            Number(raw.clean_score  || (enr && enr.clean_score) || 0),
      clean_auto_candidate:   !!(raw.clean_auto_candidate),
      clean_review_candidate: !!(raw.clean_review_candidate),
      matched_signals:        Array.isArray(raw.matched_signals) ? raw.matched_signals : [],
      signal_risk_tier:       String(raw.signal_risk_tier   || ''),
      signal_risk_detail:     raw.signal_risk_detail         || {},
      warning:                raw.warning ? String(raw.warning) : null,
      signal_origin:          enr ? String(enr.signal_origin    || '') : undefined,
      strength_reason:        enr ? String(enr.strength_reason   || '') : undefined,
      auto_candidate_reason:  enr ? String(enr.auto_candidate_reason || '') : undefined,
      suggested_admin_priority: 'P4',
      admin_decision:         prev ? prev.decision   : null,
      admin_decided_at:       prev ? prev.decided_at : null,
    };
    row.suggested_admin_priority = computePriority(row);
    return row;
  });
}

// ─── getConsolidatedRows ─────────────────────────────────────────────────────

var PROJECT_ROOT      = path.resolve(__dirname, '..', '..');
var _defaultDataDir   = path.join(PROJECT_ROOT, 'data');
var _defaultShadowDir = path.join(_defaultDataDir, 'shadow');
var _defaultDecDir    = path.join(_defaultDataDir, 'review-decisions');

function getConsolidatedRows(opts) {
  opts = opts || {};
  var shadowDir    = opts.shadowDir    || _defaultShadowDir;
  var decisionsDir = opts.decisionsDir || _defaultDecDir;
  var fsp          = opts.fsp          || realFs;

  var lvc       = loadLatestLvcReport(shadowDir, fsp);
  var auto      = loadLatestAutoReport(shadowDir, fsp);
  var decisions = loadExistingDecisions(decisionsDir, fsp);

  if (!lvc) {
    return {
      generated_at:  new Date().toISOString(),
      report_date:   '',
      source_lvc:    '',
      source_auto:   null,
      summary:       { error: 'Aucun export legacy-vs-clean-admin trouvé dans data/shadow/' },
      rows:          [],
      total_rows:    0,
      available_lvc_reports: listShadowFiles(/^legacy-vs-clean-admin-.*\.json$/, shadowDir, fsp),
    };
  }

  var rows = mergeReports(lvc, auto || null, decisions);

  var pc = { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 };
  var dc = { keep: 0, reject: 0, ignore: 0, pending: 0 };
  for (var i = 0; i < rows.length; i++) {
    var p = rows[i].suggested_admin_priority;
    pc[p] = (pc[p] || 0) + 1;
    var d = rows[i].admin_decision || 'pending';
    dc[d] = (dc[d] || 0) + 1;
  }

  var summary = Object.assign({}, lvc.summary, {
    priority_P1: pc.P1, priority_P2: pc.P2, priority_P3: pc.P3,
    priority_P4: pc.P4, priority_P5: pc.P5,
    decided_keep:      dc.keep,
    decided_reject:    dc.reject,
    decided_ignore:    dc.ignore,
    pending_decisions: dc.pending,
  });

  return {
    generated_at:  new Date().toISOString(),
    report_date:   lvc.report_date || lvc.exported_at || '',
    source_lvc:    lvc._filename,
    source_auto:   auto ? auto._filename : null,
    summary:       summary,
    rows:          rows,
    total_rows:    rows.length,
    available_lvc_reports: listShadowFiles(/^legacy-vs-clean-admin-.*\.json$/, shadowDir, fsp),
  };
}

// ─── saveDecision ────────────────────────────────────────────────────────────

function saveDecision(entry, decisionsDir, fsp) {
  var fspUsed = fsp || realFs;
  var valid = ['keep', 'reject', 'ignore'];
  if (valid.indexOf(entry.decision) === -1) {
    return { ok: false, file: '', error: 'Décision invalide: ' + entry.decision };
  }
  if (!entry.client || !entry.bc_id) {
    return { ok: false, file: '', error: 'client et bc_id requis' };
  }

  var now    = new Date().toISOString();
  var record = {
    client:             entry.client,
    bc_id:              entry.bc_id,
    score:              entry.clean_score || 0,
    signal_origin:      entry.signal_origin    || '',
    matched_signals:    entry.matched_signals  || [],
    strength_reason:    entry.strength_reason  || '',
    weak_single_signal: false,
    clean_text_excerpt: entry.clean_text_excerpt || '',
    decision:           entry.decision,
  };
  var payload = {
    imported_at: now,
    source_csv:  'admin-dashboard-gd029',
    counters: {
      total:  1,
      keep:   entry.decision === 'keep'   ? 1 : 0,
      reject: entry.decision === 'reject' ? 1 : 0,
      ignore: entry.decision === 'ignore' ? 1 : 0,
      vide:   0, invalid: 0,
    },
    records: [record],
  };

  var ts    = now.replace(/[:.]/g, '-');
  var fname = 'review-decisions-admin-' + ts + '.json';
  var fpath = path.join(decisionsDir, fname);
  try {
    fspUsed.mkdirSync(decisionsDir, { recursive: true });
    fspUsed.writeFileSync(fpath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, file: fname };
  } catch (e) {
    return { ok: false, file: '', error: e.message || String(e) };
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  computePriority:         computePriority,
  listShadowFiles:         listShadowFiles,
  loadLatestLvcReport:     loadLatestLvcReport,
  loadLatestAutoReport:    loadLatestAutoReport,
  loadExistingDecisions:   loadExistingDecisions,
  mergeReports:            mergeReports,
  getConsolidatedRows:     getConsolidatedRows,
  saveDecision:            saveDecision,
};
