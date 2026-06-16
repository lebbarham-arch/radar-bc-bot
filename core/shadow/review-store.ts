'use strict';
/**
 * review-store.ts — GD-029
 *
 * Lecture des exports shadow + gestion des décisions admin.
 * Shadow/admin uniquement — aucun effet production, aucun Supabase, aucune notif.
 *
 * Exports :
 *   computePriority(row)
 *   loadLatestLvcReport(shadowDir, fsp)
 *   loadLatestAutoReport(shadowDir, fsp)
 *   loadExistingDecisions(decisionsDir, fsp)
 *   mergeReports(lvc, auto, decisions)
 *   getConsolidatedRows(opts)
 *   saveDecision(entry, decisionsDir, fsp)
 */

import * as nodePath from 'path';
import * as nodeFs  from 'fs';

// ─── Types publics ────────────────────────────────────────────────────────────

export type AdminDecision  = 'keep' | 'reject' | 'ignore';
export type PriorityLevel  = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
export type ComparisonBucket =
  | 'legacy_sent_only' | 'legacy_and_clean_auto' | 'legacy_and_clean_review'
  | 'clean_auto_only'  | 'clean_review_only'     | 'clean_weak_only'
  | 'both_match'       | string;

export interface ReviewRow {
  report_date:              string;
  client:                   string;
  bc_id:                    string;
  clean_text_excerpt:       string;
  comparison_bucket:        ComparisonBucket;
  legacy_sent:              boolean;
  clean_score:              number;
  clean_auto_candidate:     boolean;
  clean_review_candidate:   boolean;
  matched_signals:          string[];
  signal_risk_tier:         string;
  signal_risk_detail:       Record<string, string>;
  warning:                  string | null;
  signal_origin?:           string | undefined;
  strength_reason?:         string | undefined;
  auto_candidate_reason?:   string | undefined;
  suggested_admin_priority: PriorityLevel;
  admin_decision:           AdminDecision | null;
  admin_decided_at:         string | null;
}

export interface ConsolidatedReport {
  generated_at:          string;
  report_date:           string;
  source_lvc:            string;
  source_auto:           string | null;
  summary:               Record<string, number | string>;
  rows:                  ReviewRow[];
  total_rows:            number;
  available_lvc_reports: string[];
}

export interface SaveDecisionEntry {
  client:              string;
  bc_id:               string;
  decision:            AdminDecision;
  matched_signals:     string[];
  clean_score:         number;
  signal_origin?:      string;
  strength_reason?:    string;
  clean_text_excerpt?: string;
}

export interface SaveDecisionResult {
  ok:     boolean;
  file:   string;
  error?: string;
}

/** Interface injectable (real fs ou mock dans les tests). */
export interface IFileSystem {
  readdirSync(dir: string): string[];
  readFileSync(filePath: string, encoding: 'utf8'): string;
  writeFileSync(filePath: string, data: string, encoding: 'utf8'): void;
  existsSync(filePath: string): boolean;
  mkdirSync(dirPath: string, opts?: { recursive?: boolean }): void;
}

// ─── Helpers internes ─────────────────────────────────────────────────────────

function normTier(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

// ─── Priorité déterministe (spec GD-029) ──────────────────────────────────────

/**
 * Calcule la priorité admin suggérée (P1–P5).
 *
 * P1 = auto_candidate + tier Très fiable + pas de warning
 * P2 = legacy_and_clean_auto (ou auto_candidate sans tier fiable)
 * P3 = clean_review_only / clean_review_candidate
 * P4 = legacy_sent_only / cas par défaut
 * P5 = warning présent OU tier Ambigu/Risqué/Insuffisant (override)
 */
export function computePriority(row: Pick<ReviewRow,
  'clean_auto_candidate' | 'clean_review_candidate' | 'comparison_bucket' |
  'signal_risk_tier'     | 'warning'>
): PriorityLevel {
  const hasWarning = !!(row.warning);
  const tier       = normTier(row.signal_risk_tier ?? '');
  const isRisky    = tier === 'ambigu' || tier === 'risque' || tier === 'insuffisant';

  if (hasWarning || isRisky) return 'P5';

  const isFiable = tier === 'tres fiable';
  if (row.clean_auto_candidate && isFiable) return 'P1';

  const bucket = (row.comparison_bucket ?? '') as string;
  if (bucket === 'legacy_and_clean_auto' || row.clean_auto_candidate) return 'P2';
  if (bucket === 'clean_review_only' || bucket === 'legacy_and_clean_review'
    || row.clean_review_candidate) return 'P3';

  return 'P4';
}

// ─── Types internes JSON ───────────────────────────────────────────────────────

export interface LvcReport {
  exported_at:   string;
  source_report: string;
  report_date:   string;
  summary:       Record<string, number | string>;
  rows:          Array<Record<string, unknown>>;
  _filename:     string;
}

export interface AutoReport {
  exported_at:      string;
  source_report:    string;
  report_date:      string;
  total_candidates: number;
  candidates:       Array<Record<string, unknown>>;
  _filename:        string;
}

// ─── Lecture fichiers shadow ───────────────────────────────────────────────────

export function listShadowFiles(
  pattern:   RegExp,
  shadowDir: string,
  fsp:       IFileSystem,
): string[] {
  try {
    return fsp.readdirSync(shadowDir).filter(f => pattern.test(f)).sort();
  } catch {
    return [];
  }
}

export function loadLatestLvcReport(shadowDir: string, fsp: IFileSystem): LvcReport | null {
  const files = listShadowFiles(/^legacy-vs-clean-admin-.*\.json$/, shadowDir, fsp);
  if (!files.length) return null;
  const fname = files[files.length - 1]!;
  try {
    const raw = fsp.readFileSync(nodePath.join(shadowDir, fname), 'utf8');
    const d   = JSON.parse(raw) as LvcReport;
    d._filename = fname;
    return d;
  } catch {
    return null;
  }
}

export function loadLatestAutoReport(shadowDir: string, fsp: IFileSystem): AutoReport | null {
  const files = listShadowFiles(/^auto-candidates-admin-.*\.json$/, shadowDir, fsp);
  if (!files.length) return null;
  const fname = files[files.length - 1]!;
  try {
    const raw = fsp.readFileSync(nodePath.join(shadowDir, fname), 'utf8');
    const d   = JSON.parse(raw) as AutoReport;
    d._filename = fname;
    return d;
  } catch {
    return null;
  }
}

export function loadExistingDecisions(
  decisionsDir: string,
  fsp:          IFileSystem,
): Map<string, { decision: AdminDecision; decided_at: string }> {
  const map = new Map<string, { decision: AdminDecision; decided_at: string }>();
  let files: string[] = [];
  try {
    files = fsp.readdirSync(decisionsDir)
      .filter(f => /^review-decisions-.*\.json$/.test(f))
      .sort();
  } catch {
    return map;
  }
  for (const fname of files) {
    try {
      const raw  = fsp.readFileSync(nodePath.join(decisionsDir, fname), 'utf8');
      const data = JSON.parse(raw) as {
        imported_at?: string;
        records?: Array<Record<string, unknown>>;
      };
      const importedAt = data.imported_at ?? fname;
      for (const rec of data.records ?? []) {
        const key = `${rec['client']}::${rec['bc_id']}`;
        const dec = rec['decision'] as string;
        if (dec === 'keep' || dec === 'reject' || dec === 'ignore') {
          map.set(key, { decision: dec as AdminDecision, decided_at: importedAt });
        }
      }
    } catch { /* skip bad file */ }
  }
  return map;
}

// ─── Fusion + enrichissement ──────────────────────────────────────────────────

export function mergeReports(
  lvc:       LvcReport,
  auto:      AutoReport | null,
  decisions: Map<string, { decision: AdminDecision; decided_at: string }>,
): ReviewRow[] {
  const autoIdx = new Map<string, Record<string, unknown>>();
  for (const c of auto?.candidates ?? []) {
    autoIdx.set(`${c['client']}::${c['bc_id']}`, c);
  }

  return (lvc.rows ?? []).map(raw => {
    const key  = `${raw['client']}::${raw['bc_id']}`;
    const enr  = autoIdx.get(key);
    const prev = decisions.get(key);

    const row: ReviewRow = {
      report_date:            String(raw['report_date'] ?? lvc.report_date ?? ''),
      client:                 String(raw['client'] ?? ''),
      bc_id:                  String(raw['bc_id'] ?? ''),
      clean_text_excerpt:     String(raw['clean_text_excerpt'] ?? '').slice(0, 200),
      comparison_bucket:      String(raw['comparison_bucket'] ?? ''),
      legacy_sent:            !!(raw['legacy_sent']),
      clean_score:            Number(raw['clean_score'] ?? enr?.['clean_score'] ?? 0),
      clean_auto_candidate:   !!(raw['clean_auto_candidate']),
      clean_review_candidate: !!(raw['clean_review_candidate']),
      matched_signals:        Array.isArray(raw['matched_signals'])
        ? (raw['matched_signals'] as string[]) : [],
      signal_risk_tier:       String(raw['signal_risk_tier'] ?? ''),
      signal_risk_detail:     (raw['signal_risk_detail'] as Record<string, string>) ?? {},
      warning:                raw['warning'] ? String(raw['warning']) : null,
      signal_origin:          enr ? String(enr['signal_origin'] ?? '') : undefined,
      strength_reason:        enr ? String(enr['strength_reason'] ?? '') : undefined,
      auto_candidate_reason:  enr ? String(enr['auto_candidate_reason'] ?? '') : undefined,
      suggested_admin_priority: 'P4',
      admin_decision:         prev?.decision ?? null,
      admin_decided_at:       prev?.decided_at ?? null,
    };
    row.suggested_admin_priority = computePriority(row);
    return row;
  });
}

// ─── Point d'entrée principal ──────────────────────────────────────────────────

export interface GetConsolidatedRowsOpts {
  shadowDir?:    string;
  decisionsDir?: string;
  fsp?:          IFileSystem;
}

const _defaultDataDir   = nodePath.join(__dirname, '..', '..', 'data');
const _defaultShadowDir = nodePath.join(_defaultDataDir, 'shadow');
const _defaultDecDir    = nodePath.join(_defaultDataDir, 'review-decisions');
const _realNodeFs: IFileSystem = {
  readdirSync:   (d)         => nodeFs.readdirSync(d) as string[],
  readFileSync:  (f, enc)    => nodeFs.readFileSync(f, enc),
  writeFileSync: (f, d, enc) => nodeFs.writeFileSync(f, d, enc),
  existsSync:    (f)         => nodeFs.existsSync(f),
  mkdirSync:     (d, o)      => { nodeFs.mkdirSync(d, o ?? {}); },
};

export function getConsolidatedRows(opts: GetConsolidatedRowsOpts = {}): ConsolidatedReport {
  const shadowDir    = opts.shadowDir    ?? _defaultShadowDir;
  const decisionsDir = opts.decisionsDir ?? _defaultDecDir;
  const fsp          = opts.fsp          ?? _realNodeFs;
  const lvc       = loadLatestLvcReport(shadowDir, fsp);
  const auto      = loadLatestAutoReport(shadowDir, fsp);
  const decisions = loadExistingDecisions(decisionsDir, fsp);

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

  const rows = mergeReports(lvc, auto ?? null, decisions);

  const pc: Record<string, number> = { P1: 0, P2: 0, P3: 0, P4: 0, P5: 0 };
  const dc: Record<string, number> = { keep: 0, reject: 0, ignore: 0, pending: 0 };
  for (const r of rows) {
    pc[r.suggested_admin_priority] = (pc[r.suggested_admin_priority] ?? 0) + 1;
    const d = r.admin_decision ?? 'pending';
    dc[d] = (dc[d] ?? 0) + 1;
  }

  return {
    generated_at:  new Date().toISOString(),
    report_date:   lvc.report_date ?? lvc.exported_at ?? '',
    source_lvc:    lvc._filename,
    source_auto:   auto ? auto._filename : null,
    summary: {
      ...lvc.summary,
      priority_P1: pc['P1'] ?? 0, priority_P2: pc['P2'] ?? 0,
      priority_P3: pc['P3'] ?? 0, priority_P4: pc['P4'] ?? 0, priority_P5: pc['P5'] ?? 0,
      decided_keep:      dc['keep']    ?? 0,
      decided_reject:    dc['reject']  ?? 0,
      decided_ignore:    dc['ignore']  ?? 0,
      pending_decisions: dc['pending'] ?? 0,
    },
    rows,
    total_rows:    rows.length,
    available_lvc_reports: listShadowFiles(/^legacy-vs-clean-admin-.*\.json$/, shadowDir, fsp),
  };
}

// ─── Écriture d'une décision ──────────────────────────────────────────────────

export function saveDecision(
  entry:        SaveDecisionEntry,
  decisionsDir: string,
  fsp:          IFileSystem,
): SaveDecisionResult {
  const valid: AdminDecision[] = ['keep', 'reject', 'ignore'];
  if (!valid.includes(entry.decision)) {
    return { ok: false, file: '', error: 'Décision invalide: ' + entry.decision };
  }
  if (!entry.client || !entry.bc_id) {
    return { ok: false, file: '', error: 'client et bc_id requis' };
  }

  const now    = new Date().toISOString();
  const record = {
    client:             entry.client,
    bc_id:              entry.bc_id,
    score:              entry.clean_score ?? 0,
    signal_origin:      entry.signal_origin ?? '',
    matched_signals:    entry.matched_signals ?? [],
    strength_reason:    entry.strength_reason ?? '',
    weak_single_signal: false,
    clean_text_excerpt: entry.clean_text_excerpt ?? '',
    decision:           entry.decision,
  };
  const payload = {
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

  const ts    = now.replace(/[:.]/g, '-');
  const fname = `review-decisions-admin-${ts}.json`;
  const fpath = nodePath.join(decisionsDir, fname);
  try {
    fsp.mkdirSync(decisionsDir, { recursive: true });
    fsp.writeFileSync(fpath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, file: fname };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, file: '', error: msg };
  }
}
