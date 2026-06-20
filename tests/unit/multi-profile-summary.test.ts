/**
 * tests/unit/multi-profile-summary.test.ts
 * Tests GD-048 / GD-049 -- Rapport synthetique multi-profils shadow-only.
 *
 * analyze-local-multi-profile-report.js n'est pas require()'able (IIFE main).
 * On teste via fonctions miroir inline.
 *
 * Groupes :
 *   MPS-A  countSignals / topSignals
 *   MPS-B  detectBroadSignalWarning
 *   MPS-C  computeClientSummary -- totaux
 *   MPS-D  computeClientSummary -- exemples auto/review
 *   MPS-E  buildSummaryCsv -- format CSV (15 colonnes)
 *   MPS-F  securite -- pas de scoring/seuils/prod dans le script
 *   MPS-G  GD-049 -- diagnostic statistique des signaux
 */

import * as fs   from "fs";
import * as path from "path";

// ============================================================
// Types communs
// ============================================================

type ShadowEntry = {
  bc_id?: string;
  objet?: string;
  clean_score?: number;
  matched_signals?: string[];
  clean_decision?: string;
  strength?: string;
  strength_reason?: string;
  weak_single_signal?: boolean;
  review_candidate?: boolean;
  clean_text_excerpt?: string;
};

type ShadowClient = {
  client_id?: string;
  client_name?: string;
  profile_label?: string;
  total_checked?: number;
  clean?: number;
  clean_strong_count?: number;
  clean_weak_count?: number;
  clean_auto_notify_candidates?: number;
  clean_review_candidates?: number;
  weak_single_signal_count?: number;
  recommendation?: string;
  clean_only?: ShadowEntry[];
};

// ============================================================
// Miroir GD-049 -- diagnostic statistique des signaux
// (declare avant computeClientSummary qui l'utilise)
// ============================================================

const MIN_SIGNAL_TOTAL = 3;
const BROAD_REVIEW_MIN = 0.60;
const BROAD_WEAK_MIN   = 0.40;
const BROAD_AUTO_MAX   = 0.30;
const FIABLE_AUTO_MIN  = 0.50;
const FIABLE_WEAK_MAX  = 0.25;
const COMBO_AUTO_MIN   = 0.20;

type SignalStat = {
  signal: string;
  total_count: number;
  auto_count: number;
  review_count: number;
  weak_single_count: number;
};

type SignalDiag = {
  signal: string;
  total_count: number;
  auto_count: number;
  review_count: number;
  weak_single_count: number;
  auto_ratio: number;
  review_ratio: number;
  weak_single_ratio: number;
  diagnostic_classification: string;
  diagnostic_reason: string;
};

function computeSignalStats(entries: ShadowEntry[]): Record<string, SignalStat> {
  const stats: Record<string, SignalStat> = {};
  entries.forEach(function(e) {
    const isAuto   = !e.review_candidate;
    const isReview = !!e.review_candidate;
    const isWeak   = !!e.weak_single_signal;
    (e.matched_signals || []).forEach(function(s) {
      const k = String(s || "").trim();
      if (!k) return;
      if (!stats[k]) {
        stats[k] = { signal: k, total_count: 0, auto_count: 0, review_count: 0, weak_single_count: 0 };
      }
      stats[k]!.total_count++;
      if (isAuto)   { stats[k]!.auto_count++;       }
      if (isReview) { stats[k]!.review_count++;      }
      if (isWeak)   { stats[k]!.weak_single_count++; }
    });
  });
  return stats;
}

function classifySignal(stat: SignalStat): { diagnostic_classification: string; diagnostic_reason: string } {
  const total = stat.total_count;
  if (total < MIN_SIGNAL_TOTAL) {
    return {
      diagnostic_classification: "signal_insuffisant_donnees",
      diagnostic_reason: "observe: " + total + " occurrence(s) -- donnees insuffisantes."
    };
  }
  const autoRatio   = stat.auto_count        / total;
  const reviewRatio = stat.review_count      / total;
  const weakRatio   = stat.weak_single_count / total;
  if (reviewRatio >= BROAD_REVIEW_MIN && weakRatio >= BROAD_WEAK_MIN && autoRatio <= BROAD_AUTO_MAX) {
    return {
      diagnostic_classification: "signal_trop_large_observe",
      diagnostic_reason: "observe: " + stat.review_count + " review, " +
                         stat.auto_count + " auto, " +
                         Math.round(weakRatio * 100) + "% weak_single."
    };
  }
  if (autoRatio >= FIABLE_AUTO_MIN && weakRatio <= FIABLE_WEAK_MAX) {
    return {
      diagnostic_classification: "signal_fiable_en_combinaison_observe",
      diagnostic_reason: "observe: " + stat.auto_count + " auto (" +
                         Math.round(autoRatio * 100) + "%), " +
                         Math.round(weakRatio * 100) + "% weak_single."
    };
  }
  if (stat.auto_count >= 1 && autoRatio >= COMBO_AUTO_MIN) {
    return {
      diagnostic_classification: "signal_fiable_en_combinaison_observe",
      diagnostic_reason: "observe: " + stat.auto_count + " auto sur " + total +
                         " (" + Math.round(autoRatio * 100) + "%), " +
                         stat.review_count + " review."
    };
  }
  if (stat.auto_count === 0) {
    return {
      diagnostic_classification: "signal_faible_seul_observe",
      diagnostic_reason: "observe: " + stat.review_count + " review, 0 auto, " +
                         Math.round(weakRatio * 100) + "% weak_single."
    };
  }
  return {
    diagnostic_classification: "signal_a_surveiller",
    diagnostic_reason: "observe: " + stat.auto_count + " auto, " +
                       stat.review_count + " review sur " + total + "."
  };
}

function buildSignalDiagnostics(entries: ShadowEntry[]): SignalDiag[] {
  const statsMap = computeSignalStats(entries);
  return Object.keys(statsMap)
    .sort(function(a, b) { return statsMap[b]!.total_count - statsMap[a]!.total_count; })
    .map(function(s) {
      const st    = statsMap[s]!;
      const total = st.total_count;
      const diag  = classifySignal(st);
      return {
        signal                   : s,
        total_count              : total,
        auto_count               : st.auto_count,
        review_count             : st.review_count,
        weak_single_count        : st.weak_single_count,
        auto_ratio               : total > 0 ? Math.round(st.auto_count        / total * 100) / 100 : 0,
        review_ratio             : total > 0 ? Math.round(st.review_count      / total * 100) / 100 : 0,
        weak_single_ratio        : total > 0 ? Math.round(st.weak_single_count / total * 100) / 100 : 0,
        diagnostic_classification: diag.diagnostic_classification,
        diagnostic_reason        : diag.diagnostic_reason
      };
    });
}

// ============================================================
// Miroir GD-048
// ============================================================

function countSignals(entries: ShadowEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  entries.forEach(function(e) {
    (e.matched_signals || []).forEach(function(s) {
      const k = String(s || "").trim();
      if (k) { counts[k] = (counts[k] || 0) + 1; }
    });
  });
  return counts;
}

function topSignals(counts: Record<string, number>, n: number): Array<{ signal: string; count: number }> {
  return Object.keys(counts)
    .sort(function(a, b) { return counts[b]! - counts[a]!; })
    .slice(0, n)
    .map(function(s) { return { signal: s, count: counts[s]! }; });
}

function detectBroadSignalWarning(c: ShadowClient): string[] {
  const autoCount   = typeof c.clean_auto_notify_candidates === "number"
                       ? c.clean_auto_notify_candidates : 0;
  const reviewCount = typeof c.clean_review_candidates === "number"
                       ? c.clean_review_candidates : 0;
  const weakSingle  = typeof c.weak_single_signal_count === "number"
                       ? c.weak_single_signal_count : 0;
  const totalClean  = typeof c.clean === "number" ? c.clean : (autoCount + reviewCount);
  if (totalClean === 0) return [];
  const warnings: string[] = [];
  const ratioHigh = reviewCount >= 3 * (autoCount + 1);
  const weakHigh  = weakSingle >= Math.ceil(totalClean * 0.5);
  if (ratioHigh && weakHigh) {
    warnings.push(
      "signal_trop_large: " + reviewCount + " review / " + autoCount + " auto" +
      " / " + weakSingle + " weak_single (" +
      Math.round(weakSingle / totalClean * 100) + "% du total)"
    );
  }
  return warnings;
}

function computeClientSummary(c: ShadowClient, n: number): Record<string, unknown> {
  const allEntries    = Array.isArray(c.clean_only) ? c.clean_only : [];
  const autoEntries   = allEntries.filter(function(e) { return !e.review_candidate; });
  const reviewEntries = allEntries.filter(function(e) { return !!e.review_candidate; });

  const sigAll    = countSignals(allEntries);
  const sigAuto   = countSignals(autoEntries);
  const sigReview = countSignals(reviewEntries);

  const autoCount   = typeof c.clean_auto_notify_candidates === "number"
                       ? c.clean_auto_notify_candidates : autoEntries.length;
  const reviewCount = typeof c.clean_review_candidates === "number"
                       ? c.clean_review_candidates : reviewEntries.length;
  const totalClean  = typeof c.clean === "number" ? c.clean : allEntries.length;

  const bestAuto = autoEntries
    .slice()
    .sort(function(a, b) { return (b.clean_score || 0) - (a.clean_score || 0); })
    .slice(0, 3)
    .map(function(e) {
      return {
        bc_id          : e.bc_id,
        score          : e.clean_score,
        matched_signals: e.matched_signals || [],
        strength       : e.strength,
        objet          : ((e.objet || "").trim() || (e.clean_text_excerpt || "")).slice(0, 80)
      };
    });

  const reviewExamples = reviewEntries.slice(0, 3).map(function(e) {
    return {
      bc_id             : e.bc_id,
      score             : e.clean_score,
      matched_signals   : e.matched_signals || [],
      strength_reason   : e.strength_reason,
      weak_single_signal: !!e.weak_single_signal,
      objet             : ((e.objet || "").trim() || (e.clean_text_excerpt || "")).slice(0, 80)
    };
  });

  return {
    client_id          : c.client_id,
    client_name        : c.client_name || c.client_id,
    profile_label      : c.profile_label || "",
    total_checked      : c.total_checked || 0,
    total_clean        : totalClean,
    auto_candidates    : autoCount,
    review_candidates  : reviewCount,
    clean_strong       : c.clean_strong_count || 0,
    clean_weak         : c.clean_weak_count   || 0,
    weak_single_signal : c.weak_single_signal_count || 0,
    top_signals_all    : topSignals(sigAll,    n),
    top_signals_auto   : topSignals(sigAuto,   n),
    top_signals_review : topSignals(sigReview, n),
    best_auto_examples : bestAuto,
    review_examples    : reviewExamples,
    warnings           : detectBroadSignalWarning(c),
    recommendation     : c.recommendation || "",
    signal_diagnostics : buildSignalDiagnostics(allEntries)
  };
}

// ============================================================
// CSV helpers
// ============================================================

function csvEsc(v: unknown): string {
  const s = String(v == null ? "" : v);
  if (s.indexOf(";") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function signalsToStr(arr: unknown[]): string {
  return (arr || []).map(function(x) {
    return typeof x === "object" && x !== null
      ? (x as { signal: string; count: number }).signal + "(" + (x as { signal: string; count: number }).count + ")"
      : String(x);
  }).join(", ");
}

function signalDiagsToStr(diags: SignalDiag[], maxN: number): string {
  return (diags || []).slice(0, maxN).map(function(d) {
    return d.signal + ":" + d.diagnostic_classification;
  }).join(", ");
}

function signalsByClass(diags: SignalDiag[], cls: string): string {
  return (diags || [])
    .filter(function(d) { return d.diagnostic_classification === cls; })
    .map(function(d) { return d.signal; })
    .join(", ");
}

// 15-column CSV (GD-048) -- inchange
function buildSummaryCsv(summaries: Record<string, unknown>[]): string {
  const COLS = [
    "client_id", "client_name", "profile_label",
    "total_checked", "total_clean",
    "auto_candidates", "review_candidates",
    "clean_strong", "clean_weak", "weak_single_signal",
    "top_signals_all", "top_signals_auto", "top_signals_review",
    "warnings", "recommendation"
  ];
  const rows = ["\uFEFF" + COLS.join(";")];
  summaries.forEach(function(s) {
    const row = [
      csvEsc(s["client_id"]),
      csvEsc(s["client_name"]),
      csvEsc(s["profile_label"]),
      csvEsc(s["total_checked"]),
      csvEsc(s["total_clean"]),
      csvEsc(s["auto_candidates"]),
      csvEsc(s["review_candidates"]),
      csvEsc(s["clean_strong"]),
      csvEsc(s["clean_weak"]),
      csvEsc(s["weak_single_signal"]),
      csvEsc(signalsToStr(s["top_signals_all"] as unknown[])),
      csvEsc(signalsToStr(s["top_signals_auto"] as unknown[])),
      csvEsc(signalsToStr(s["top_signals_review"] as unknown[])),
      csvEsc(((s["warnings"] as string[]) || []).join(" | ")),
      csvEsc(s["recommendation"])
    ];
    rows.push(row.join(";"));
  });
  return rows.join("\r\n");
}

// 19-column CSV (GD-049)
function buildSummaryCsv49(summaries: Record<string, unknown>[]): string {
  const COLS = [
    "client_id", "client_name", "profile_label",
    "total_checked", "total_clean",
    "auto_candidates", "review_candidates",
    "clean_strong", "clean_weak", "weak_single_signal",
    "top_signals_all", "top_signals_auto", "top_signals_review",
    "warnings", "recommendation",
    "nb_signal_diagnostics", "top_signal_diagnostics",
    "broad_observed_signals", "weak_single_observed_signals"
  ];
  const rows = ["\uFEFF" + COLS.join(";")];
  summaries.forEach(function(s) {
    const diags    = (s["signal_diagnostics"] as SignalDiag[]) || [];
    const weakOnly = diags
      .filter(function(d) { return d.auto_count === 0; })
      .map(function(d) { return d.signal; })
      .join(", ");
    const row = [
      csvEsc(s["client_id"]),
      csvEsc(s["client_name"]),
      csvEsc(s["profile_label"]),
      csvEsc(s["total_checked"]),
      csvEsc(s["total_clean"]),
      csvEsc(s["auto_candidates"]),
      csvEsc(s["review_candidates"]),
      csvEsc(s["clean_strong"]),
      csvEsc(s["clean_weak"]),
      csvEsc(s["weak_single_signal"]),
      csvEsc(signalsToStr(s["top_signals_all"] as unknown[])),
      csvEsc(signalsToStr(s["top_signals_auto"] as unknown[])),
      csvEsc(signalsToStr(s["top_signals_review"] as unknown[])),
      csvEsc(((s["warnings"] as string[]) || []).join(" | ")),
      csvEsc(s["recommendation"]),
      csvEsc(diags.length),
      csvEsc(signalDiagsToStr(diags, 3)),
      csvEsc(signalsByClass(diags, "signal_trop_large_observe")),
      csvEsc(weakOnly)
    ];
    rows.push(row.join(";"));
  });
  return rows.join("\r\n");
}

// ============================================================
// Fixtures
// ============================================================

function makeEntry(overrides: Partial<ShadowEntry> = {}): ShadowEntry {
  return Object.assign(
    {
      bc_id: "100",
      clean_score: 10,
      matched_signals: ["nettoyage"],
      strength: "weak",
      review_candidate: false
    },
    overrides
  );
}

function makeClient(overrides: Partial<ShadowClient> = {}): ShadowClient {
  return Object.assign(
    {
      client_id: "local-test",
      client_name: "TEST Client",
      profile_label: "Test Label",
      total_checked: 100,
      clean: 5,
      clean_strong_count: 2,
      clean_weak_count: 3,
      clean_auto_notify_candidates: 2,
      clean_review_candidates: 3,
      weak_single_signal_count: 1,
      recommendation: "keep_legacy_production",
      clean_only: []
    },
    overrides
  );
}

const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/analyze-local-multi-profile-report.js");

// ============================================================
// MPS-A : countSignals / topSignals
// ============================================================

describe("MPS-A -- countSignals / topSignals", () => {

  test("MPS-1: countSignals retourne un objet vide pour une liste vide", () => {
    expect(countSignals([])).toEqual({});
  });

  test("MPS-2: countSignals compte les signaux d'une entry unique", () => {
    const e = makeEntry({ matched_signals: ["nettoyage", "hygiene"] });
    const r = countSignals([e]);
    expect(r["nettoyage"]).toBe(1);
    expect(r["hygiene"]).toBe(1);
  });

  test("MPS-3: countSignals agrege les signaux sur plusieurs entries", () => {
    const entries = [
      makeEntry({ matched_signals: ["nettoyage", "hygiene"] }),
      makeEntry({ matched_signals: ["nettoyage"] }),
      makeEntry({ matched_signals: ["hygiene"] })
    ];
    const r = countSignals(entries);
    expect(r["nettoyage"]).toBe(2);
    expect(r["hygiene"]).toBe(2);
  });

  test("MPS-4: topSignals retourne les N signaux les plus frequents en ordre decroissant", () => {
    const counts = { nettoyage: 10, hygiene: 5, desinfection: 1 };
    const top = topSignals(counts, 2);
    expect(top).toHaveLength(2);
    expect(top[0]!.signal).toBe("nettoyage");
    expect(top[0]!.count).toBe(10);
    expect(top[1]!.signal).toBe("hygiene");
    expect(top[1]!.count).toBe(5);
  });

  test("MPS-5: topSignals avec N superieur au nombre de signaux retourne tous les signaux", () => {
    const counts = { a: 3, b: 1 };
    const top = topSignals(counts, 10);
    expect(top).toHaveLength(2);
  });

});

// ============================================================
// MPS-B : detectBroadSignalWarning
// ============================================================

describe("MPS-B -- detectBroadSignalWarning", () => {

  test("MPS-6: pas de warning quand review < 3 * (auto + 1)", () => {
    const c = makeClient({
      clean: 10,
      clean_auto_notify_candidates: 5,
      clean_review_candidates: 5,
      weak_single_signal_count: 9
    });
    expect(detectBroadSignalWarning(c)).toHaveLength(0);
  });

  test("MPS-7: pas de warning quand weak_single < 50% total_clean (meme si ratio review/auto eleve)", () => {
    const c = makeClient({
      clean: 20,
      clean_auto_notify_candidates: 1,
      clean_review_candidates: 19,
      weak_single_signal_count: 5
    });
    expect(detectBroadSignalWarning(c)).toHaveLength(0);
  });

  test("MPS-8: warning quand les deux criteres sont remplis (ratio eleve + weak_single > 50%)", () => {
    const c = makeClient({
      clean: 20,
      clean_auto_notify_candidates: 1,
      clean_review_candidates: 19,
      weak_single_signal_count: 15
    });
    const warns = detectBroadSignalWarning(c);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("signal_trop_large");
  });

  test("MPS-9: le warning contient les compteurs auto/review/weak_single", () => {
    const c = makeClient({
      clean: 14,
      clean_auto_notify_candidates: 0,
      clean_review_candidates: 14,
      weak_single_signal_count: 13
    });
    const warns = detectBroadSignalWarning(c);
    expect(warns[0]).toContain("14 review");
    expect(warns[0]).toContain("0 auto");
    expect(warns[0]).toContain("13 weak_single");
  });

  test("MPS-10: pas de warning si total_clean est 0", () => {
    const c = makeClient({
      clean: 0,
      clean_auto_notify_candidates: 0,
      clean_review_candidates: 0,
      weak_single_signal_count: 0
    });
    expect(detectBroadSignalWarning(c)).toHaveLength(0);
  });

});

// ============================================================
// MPS-C : computeClientSummary -- totaux
// ============================================================

describe("MPS-C -- computeClientSummary totaux", () => {

  test("MPS-11: total_clean issu de c.clean quand disponible", () => {
    const c = makeClient({ clean: 42, clean_only: [] });
    const s = computeClientSummary(c, 5);
    expect(s["total_clean"]).toBe(42);
  });

  test("MPS-12: auto_candidates depuis c.clean_auto_notify_candidates", () => {
    const c = makeClient({ clean_auto_notify_candidates: 7 });
    const s = computeClientSummary(c, 5);
    expect(s["auto_candidates"]).toBe(7);
  });

  test("MPS-13: review_candidates depuis c.clean_review_candidates", () => {
    const c = makeClient({ clean_review_candidates: 12 });
    const s = computeClientSummary(c, 5);
    expect(s["review_candidates"]).toBe(12);
  });

  test("MPS-14: clean_strong depuis c.clean_strong_count", () => {
    const c = makeClient({ clean_strong_count: 3 });
    const s = computeClientSummary(c, 5);
    expect(s["clean_strong"]).toBe(3);
  });

  test("MPS-15: weak_single_signal depuis c.weak_single_signal_count", () => {
    const c = makeClient({ weak_single_signal_count: 8 });
    const s = computeClientSummary(c, 5);
    expect(s["weak_single_signal"]).toBe(8);
  });

  test("MPS-16: top_signals_all calcule depuis clean_only entries", () => {
    const entries: ShadowEntry[] = [
      makeEntry({ matched_signals: ["nettoyage"], review_candidate: false }),
      makeEntry({ matched_signals: ["nettoyage", "hygiene"], review_candidate: true }),
      makeEntry({ matched_signals: ["hygiene"], review_candidate: true })
    ];
    const c = makeClient({ clean_only: entries });
    const s = computeClientSummary(c, 5);
    const all = s["top_signals_all"] as Array<{ signal: string; count: number }>;
    const netMap = all.find(function(x) { return x.signal === "nettoyage"; });
    const hygMap = all.find(function(x) { return x.signal === "hygiene"; });
    expect(netMap?.count).toBe(2);
    expect(hygMap?.count).toBe(2);
  });

  test("MPS-17: top_signals_auto concerne uniquement les entries sans review_candidate", () => {
    const entries: ShadowEntry[] = [
      makeEntry({ matched_signals: ["nettoyage"], review_candidate: false }),
      makeEntry({ matched_signals: ["hygiene"], review_candidate: true })
    ];
    const c = makeClient({ clean_only: entries });
    const s = computeClientSummary(c, 5);
    const auto = s["top_signals_auto"] as Array<{ signal: string; count: number }>;
    const sigNames = auto.map(function(x) { return x.signal; });
    expect(sigNames).toContain("nettoyage");
    expect(sigNames).not.toContain("hygiene");
  });

});

// ============================================================
// MPS-D : computeClientSummary -- exemples
// ============================================================

describe("MPS-D -- computeClientSummary exemples", () => {

  test("MPS-18: best_auto_examples trie par score decroissant", () => {
    const entries: ShadowEntry[] = [
      makeEntry({ bc_id: "A", clean_score: 10, review_candidate: false }),
      makeEntry({ bc_id: "B", clean_score: 25, review_candidate: false }),
      makeEntry({ bc_id: "C", clean_score: 5,  review_candidate: false })
    ];
    const c = makeClient({ clean_only: entries });
    const s = computeClientSummary(c, 5);
    const ex = s["best_auto_examples"] as Array<{ bc_id: string; score: number }>;
    expect(ex[0]!.bc_id).toBe("B");
    expect(ex[0]!.score).toBe(25);
  });

  test("MPS-19: best_auto_examples limite a 3 entrees", () => {
    const entries: ShadowEntry[] = Array.from({ length: 10 }, function(_, i) {
      return makeEntry({ bc_id: String(i), clean_score: i * 10, review_candidate: false });
    });
    const c = makeClient({ clean_only: entries });
    const s = computeClientSummary(c, 5);
    const ex = s["best_auto_examples"] as unknown[];
    expect(ex).toHaveLength(3);
  });

  test("MPS-20: review_examples contient les entries avec review_candidate=true", () => {
    const entries: ShadowEntry[] = [
      makeEntry({ bc_id: "R1", review_candidate: true, weak_single_signal: true }),
      makeEntry({ bc_id: "A1", review_candidate: false })
    ];
    const c = makeClient({ clean_only: entries });
    const s = computeClientSummary(c, 5);
    const rev = s["review_examples"] as Array<{ bc_id: string }>;
    expect(rev[0]!.bc_id).toBe("R1");
    expect(rev).toHaveLength(1);
  });

  test("MPS-21: review_examples.weak_single_signal est un booleen", () => {
    const entries: ShadowEntry[] = [
      makeEntry({ bc_id: "R1", review_candidate: true, weak_single_signal: true }),
      makeEntry({ bc_id: "R2", review_candidate: true })
    ];
    const c = makeClient({ clean_only: entries });
    const s = computeClientSummary(c, 5);
    const rev = s["review_examples"] as Array<{ bc_id: string; weak_single_signal: boolean }>;
    expect(rev[0]!.weak_single_signal).toBe(true);
    expect(rev[1]!.weak_single_signal).toBe(false);
  });

  test("MPS-22: objet tronque a 80 chars depuis clean_text_excerpt si objet vide", () => {
    const longText = "A".repeat(200);
    const entries: ShadowEntry[] = [
      makeEntry({ bc_id: "E1", review_candidate: false, objet: "", clean_text_excerpt: longText })
    ];
    const c = makeClient({ clean_only: entries });
    const s = computeClientSummary(c, 5);
    const ex = s["best_auto_examples"] as Array<{ objet: string }>;
    expect(ex[0]!.objet).toHaveLength(80);
  });

});

// ============================================================
// MPS-E : buildSummaryCsv (15 colonnes)
// ============================================================

describe("MPS-E -- buildSummaryCsv format CSV", () => {

  function makeSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return Object.assign({
      client_id         : "local-test",
      client_name       : "TEST Client",
      profile_label     : "Label",
      total_checked     : 100,
      total_clean       : 10,
      auto_candidates   : 3,
      review_candidates : 7,
      clean_strong      : 2,
      clean_weak        : 8,
      weak_single_signal: 5,
      top_signals_all   : [{ signal: "nettoyage", count: 5 }],
      top_signals_auto  : [{ signal: "nettoyage", count: 2 }],
      top_signals_review: [{ signal: "nettoyage", count: 3 }],
      warnings          : [],
      recommendation    : "keep_legacy_production",
      signal_diagnostics: []
    }, overrides);
  }

  test("MPS-23: buildSummaryCsv commence par le BOM UTF-8", () => {
    const csv = buildSummaryCsv([makeSummary()]);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
  });

  test("MPS-24: la premiere ligne contient les 15 colonnes attendues", () => {
    const csv = buildSummaryCsv([makeSummary()]);
    const header = csv.split("\r\n")[0]!.replace(/^\uFEFF/, "");
    const cols = header.split(";");
    expect(cols).toHaveLength(15);
    expect(cols).toContain("client_id");
    expect(cols).toContain("auto_candidates");
    expect(cols).toContain("warnings");
    expect(cols).toContain("top_signals_all");
  });

  test("MPS-25: une ligne de donnees par summary", () => {
    const csv = buildSummaryCsv([makeSummary(), makeSummary()]);
    const rows = csv.split("\r\n");
    expect(rows).toHaveLength(3);
  });

  test("MPS-26: les warnings sont joints par ' | ' dans la colonne CSV", () => {
    const s = makeSummary({ warnings: ["warn_a", "warn_b"] });
    const csv = buildSummaryCsv([s]);
    expect(csv).toContain("warn_a | warn_b");
  });

  test("MPS-27: les signaux sont serialises sous forme signal(count) dans la colonne CSV", () => {
    const s = makeSummary({
      top_signals_all: [{ signal: "nettoyage", count: 7 }, { signal: "hygiene", count: 3 }]
    });
    const csv = buildSummaryCsv([s]);
    expect(csv).toContain("nettoyage(7)");
    expect(csv).toContain("hygiene(3)");
  });

});

// ============================================================
// MPS-F : securite shadow-only + structure JSON
// ============================================================

describe("MPS-F -- securite shadow-only + structure JSON", () => {

  test("MPS-28: le script ne contient pas d'appel reseau Supabase ni de notification", () => {
    const src = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(src).not.toMatch(/sendNotification/);
    expect(src).not.toMatch(/supabase\.from/);
    expect(src).not.toMatch(/'bcs_vus'/);
    expect(src).not.toMatch(/require\(['"]@supabase/);
  });

  test("MPS-29: computeClientSummary retourne les 18 champs attendus", () => {
    const c = makeClient();
    const s = computeClientSummary(c, 5);
    const expected = [
      "client_id", "client_name", "profile_label",
      "total_checked", "total_clean",
      "auto_candidates", "review_candidates",
      "clean_strong", "clean_weak", "weak_single_signal",
      "top_signals_all", "top_signals_auto", "top_signals_review",
      "best_auto_examples", "review_examples",
      "warnings", "recommendation",
      "signal_diagnostics"
    ];
    expected.forEach(function(k) {
      expect(s).toHaveProperty(k);
    });
  });

  test("MPS-30: computeClientSummary ne modifie pas le scoring ni les seuils de l'entree", () => {
    const entries: ShadowEntry[] = [
      makeEntry({ clean_score: 25, review_candidate: false })
    ];
    const c = makeClient({ clean_only: entries });
    computeClientSummary(c, 5);
    expect(entries[0]!.clean_score).toBe(25);
    expect(entries[0]!.review_candidate).toBe(false);
  });

});

// ============================================================
// MPS-G : GD-049 -- diagnostic statistique des signaux
// ============================================================

describe("MPS-G -- GD-049 diagnostic statistique des signaux", () => {

  test("MPS-31: computeSignalStats calcule total/auto/review/weak par signal", () => {
    const entries: ShadowEntry[] = [
      makeEntry({ matched_signals: ["nettoyage"], review_candidate: false, weak_single_signal: false }),
      makeEntry({ matched_signals: ["nettoyage"], review_candidate: true,  weak_single_signal: true  }),
      makeEntry({ matched_signals: ["hygiene"],   review_candidate: true,  weak_single_signal: true  })
    ];
    const stats = computeSignalStats(entries);
    expect(stats["nettoyage"]!.total_count).toBe(2);
    expect(stats["nettoyage"]!.auto_count).toBe(1);
    expect(stats["nettoyage"]!.review_count).toBe(1);
    expect(stats["nettoyage"]!.weak_single_count).toBe(1);
    expect(stats["hygiene"]!.total_count).toBe(1);
    expect(stats["hygiene"]!.weak_single_count).toBe(1);
  });

  test("MPS-32: classifySignal -> signal_trop_large_observe (review dominant, weak_single eleve)", () => {
    const stat: SignalStat = {
      signal: "sig_x", total_count: 30,
      auto_count: 2, review_count: 28, weak_single_count: 25
    };
    const r = classifySignal(stat);
    expect(r.diagnostic_classification).toBe("signal_trop_large_observe");
    expect(r.diagnostic_reason).toContain("review");
    expect(r).not.toHaveProperty("recommandation");
  });

  test("MPS-33: classifySignal -> signal_fiable_en_combinaison_observe (auto existe, minoritaire)", () => {
    const stat: SignalStat = {
      signal: "sig_y", total_count: 13,
      auto_count: 4, review_count: 9, weak_single_count: 5
    };
    const r = classifySignal(stat);
    expect(r.diagnostic_classification).toBe("signal_fiable_en_combinaison_observe");
    expect(r).not.toHaveProperty("recommandation");
  });

  test("MPS-34: classifySignal -> signal_faible_seul_observe (auto_count=0, total >= 3)", () => {
    const stat: SignalStat = {
      signal: "sig_z", total_count: 4,
      auto_count: 0, review_count: 4, weak_single_count: 1
    };
    const r = classifySignal(stat);
    expect(r.diagnostic_classification).toBe("signal_faible_seul_observe");
    expect(r).not.toHaveProperty("recommandation");
  });

  test("MPS-35: classifySignal -> signal_insuffisant_donnees (total < MIN_SIGNAL_TOTAL)", () => {
    const stat: SignalStat = {
      signal: "sig_rare", total_count: 2,
      auto_count: 2, review_count: 0, weak_single_count: 0
    };
    const r = classifySignal(stat);
    expect(r.diagnostic_classification).toBe("signal_insuffisant_donnees");
    expect(r.diagnostic_reason).toContain("2");
    expect(r).not.toHaveProperty("recommandation");
  });

  test("MPS-36: classifySignal -> signal_fiable_en_combinaison_observe (auto eleve, weak faible)", () => {
    const stat: SignalStat = {
      signal: "sig_w", total_count: 6,
      auto_count: 4, review_count: 2, weak_single_count: 1
    };
    // auto_ratio=0.67 >= FIABLE_AUTO_MIN, weak_ratio=0.17 <= FIABLE_WEAK_MAX
    const r = classifySignal(stat);
    expect(r.diagnostic_classification).toBe("signal_fiable_en_combinaison_observe");
    expect(r).not.toHaveProperty("recommandation");
  });

  test("MPS-37: toutes les classifications produites sont des valeurs generiques connues", () => {
    const VALID_CLASSIFICATIONS = [
      "signal_trop_large_observe",
      "signal_fiable_en_combinaison_observe",
      "signal_faible_seul_observe",
      "signal_insuffisant_donnees",
      "signal_a_surveiller"
    ];
    const entries: ShadowEntry[] = [
      makeEntry({ matched_signals: ["a", "b"], review_candidate: false }),
      makeEntry({ matched_signals: ["a"],      review_candidate: true, weak_single_signal: true }),
      makeEntry({ matched_signals: ["a"],      review_candidate: true, weak_single_signal: true }),
      makeEntry({ matched_signals: ["a"],      review_candidate: true, weak_single_signal: true })
    ];
    const diags = buildSignalDiagnostics(entries);
    diags.forEach(function(d) {
      expect(VALID_CLASSIFICATIONS).toContain(d.diagnostic_classification);
      expect(d).not.toHaveProperty("recommandation");
    });
  });

  test("MPS-38: computeClientSummary retourne signal_diagnostics sans champ recommandation", () => {
    const entries: ShadowEntry[] = [
      makeEntry({ matched_signals: ["nettoyage"], review_candidate: false }),
      makeEntry({ matched_signals: ["nettoyage"], review_candidate: true, weak_single_signal: true })
    ];
    const c = makeClient({ clean_only: entries });
    const s = computeClientSummary(c, 5);
    expect(s).toHaveProperty("signal_diagnostics");
    expect(s).not.toHaveProperty("signal_recommendations");
    const diags = s["signal_diagnostics"] as SignalDiag[];
    expect(Array.isArray(diags)).toBe(true);
    expect(diags[0]!.signal).toBe("nettoyage");
    expect(diags[0]).toHaveProperty("diagnostic_classification");
    expect(diags[0]).toHaveProperty("diagnostic_reason");
    expect(diags[0]).not.toHaveProperty("recommandation");
  });

  test("MPS-39: buildSummaryCsv49 contient les 4 nouvelles colonnes GD-049 (19 total)", () => {
    const entries: ShadowEntry[] = [
      makeEntry({ matched_signals: ["sig1"], review_candidate: false }),
      makeEntry({ matched_signals: ["sig1"], review_candidate: true, weak_single_signal: true }),
      makeEntry({ matched_signals: ["sig1"], review_candidate: true, weak_single_signal: true }),
      makeEntry({ matched_signals: ["sig1"], review_candidate: true, weak_single_signal: true }),
      makeEntry({ matched_signals: ["sig2"], review_candidate: false })
    ];
    const c = makeClient({ clean_only: entries });
    const s = computeClientSummary(c, 5);
    const csv = buildSummaryCsv49([s]);
    const header = csv.split("\r\n")[0]!.replace(/^\uFEFF/, "");
    const cols = header.split(";");
    expect(cols).toContain("nb_signal_diagnostics");
    expect(cols).toContain("top_signal_diagnostics");
    expect(cols).toContain("broad_observed_signals");
    expect(cols).toContain("weak_single_observed_signals");
    expect(cols).not.toContain("nb_signal_recommendations");
    expect(cols).not.toContain("top_signal_recommendations");
    expect(cols).not.toContain("review_only_signals");
    expect(cols).toHaveLength(19);
  });

  test("MPS-40: le script reste shadow-only -- pas de Supabase, notification, scoring ni action auto/review", () => {
    const src = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(src).not.toMatch(/supabase\.from/);
    expect(src).not.toMatch(/sendNotification/);
    expect(src).not.toMatch(/'bcs_vus'/);
    expect(src).not.toMatch(/require\(['"]@supabase/);
    // Pas de champ recommandation (action-oriented -- double-n)
    expect(src).not.toMatch(/recommandation:/);
    // Pas de valeurs d'action codees en dur
    expect(src).not.toMatch(/garder_review_si_seul/);
    expect(src).not.toMatch(/autoriser_auto_seulement_si_combine/);
    expect(src).not.toMatch(/renforcer_par_contexte_positif/);
    // Pas de metier code en dur
    expect(src).not.toMatch(/signal\s*===\s*['"]nettoyage['"]/);
    expect(src).not.toMatch(/signal\s*===\s*['"]informatique['"]/);
  });

});

export {};
