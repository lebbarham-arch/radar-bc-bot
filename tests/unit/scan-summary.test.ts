/**
 * Tests unitaires — [SCAN_SUMMARY] ligne de fin de scan BC
 *
 * Couvre le patch P2-3 : ajout d'une ligne [SCAN_SUMMARY] dans le finally
 * de runGlobalScanBC, avant "Scan BC termine."
 *
 * Aucune dépendance Puppeteer : la logique de formatage est mirrorée ici.
 * Les compteurs sont des valeurs scalaires simples — la totalité du test
 * est synchrone et déterministe.
 *
 * Nomenclature : SS-N (Scan Summary)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScanSummaryParams {
  runId: string;
  source: string;
  startMs: number;
  nowMs: number;
  portalTotal: number;
  knownCount: number;
  newCount: number;
  loaded: number;
  failed: number;
  vusAdded: number;
  noDeliveryRetry: number;
  skippedForNext: number;
  status: string;
}

// ─── Mirror de la ligne [SCAN_SUMMARY] (logique pure, sans radar-bc-bot.js) ──
//
// Reproduit EXACTEMENT la concaténation du finally dans runGlobalScanBC.
// Si le format change dans le bot, ce mirror doit être mis à jour en même temps.

function buildScanSummaryLine(p: ScanSummaryParams): string {
  const durS = Math.round((p.nowMs - p.startMs) / 1000);
  return "[SCAN_SUMMARY] runId=" + p.runId
    + " source=" + p.source
    + " duration=" + durS + "s"
    + " portal_total=" + p.portalTotal
    + " known_count=" + p.knownCount
    + " new=" + p.newCount
    + " loaded=" + p.loaded
    + " failed=" + p.failed
    + " vus_added=" + p.vusAdded
    + " no_delivery_retry=" + p.noDeliveryRetry
    + " skipped_for_next=" + p.skippedForNext
    + " status=" + p.status;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extrait la valeur d'un champ key=value depuis une ligne. */
function extractField(line: string, key: string): string | null {
  const re = new RegExp("(?:^| )" + key + "=([^ ]+)");
  const m = line.match(re);
  return m ? (m[1] ?? null) : null;
}

/** Vérifie que tous les champs obligatoires sont présents dans la ligne. */
const REQUIRED_FIELDS = [
  "runId", "source", "duration",
  "portal_total", "known_count", "new",
  "loaded", "failed", "vus_added",
  "no_delivery_retry", "skipped_for_next", "status",
];

function missingFields(line: string): string[] {
  return REQUIRED_FIELDS.filter(f => extractField(line, f) === null);
}

// ─── Jeu de données standard ─────────────────────────────────────────────────

const BASE: ScanSummaryParams = {
  runId: "bc-20260617-0000-abc1",
  source: "cron",
  startMs: 1_000_000,
  nowMs:   1_045_000,  // 45 secondes plus tard
  portalTotal: 320,
  knownCount: 11203,
  newCount: 138,
  loaded: 138,
  failed: 0,
  vusAdded: 138,
  noDeliveryRetry: 0,
  skippedForNext: 0,
  status: "ok",
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SCAN_SUMMARY — format et contenu", () => {

  // SS-1 : la ligne commence par [SCAN_SUMMARY]
  test("SS-1 — la ligne commence exactement par [SCAN_SUMMARY]", () => {
    const line = buildScanSummaryLine(BASE);
    expect(line).toMatch(/^\[SCAN_SUMMARY\] /);
  });

  // SS-2 : tous les champs obligatoires sont présents
  test("SS-2 — tous les champs obligatoires sont présents", () => {
    const line = buildScanSummaryLine(BASE);
    const missing = missingFields(line);
    expect(missing).toEqual([]);
  });

  // SS-3 : duration est un entier ≥ 0 (sans décimales)
  test("SS-3 — duration est un entier >= 0 (format Xs sans décimales)", () => {
    const line = buildScanSummaryLine(BASE);
    const dur = extractField(line, "duration");
    expect(dur).not.toBeNull();
    expect(dur).toMatch(/^\d+s$/);           // format entierS
    const n = parseInt(dur!.replace("s", ""), 10);
    expect(n).toBeGreaterThanOrEqual(0);
  });

  // SS-4 : duration = round((nowMs - startMs) / 1000)
  test("SS-4 — duration reflète correctement (nowMs - startMs) arrondi à la seconde", () => {
    const line = buildScanSummaryLine({ ...BASE, startMs: 0, nowMs: 45_400 });
    expect(extractField(line, "duration")).toBe("45s");

    const line2 = buildScanSummaryLine({ ...BASE, startMs: 0, nowMs: 45_600 });
    expect(extractField(line2, "duration")).toBe("46s"); // arrondi supérieur

    const line3 = buildScanSummaryLine({ ...BASE, startMs: 1_000, nowMs: 1_000 });
    expect(extractField(line3, "duration")).toBe("0s");
  });

  // SS-5 : valeurs correctes dans le cas nominal
  test("SS-5 — valeurs correctes dans le cas nominal (scan complet cron)", () => {
    const line = buildScanSummaryLine(BASE);
    expect(extractField(line, "source")).toBe("cron");
    expect(extractField(line, "portal_total")).toBe("320");
    expect(extractField(line, "known_count")).toBe("11203");
    expect(extractField(line, "new")).toBe("138");
    expect(extractField(line, "loaded")).toBe("138");
    expect(extractField(line, "failed")).toBe("0");
    expect(extractField(line, "vus_added")).toBe("138");
    expect(extractField(line, "no_delivery_retry")).toBe("0");
    expect(extractField(line, "skipped_for_next")).toBe("0");
    expect(extractField(line, "status")).toBe("ok");
  });

  // SS-6 : source=manual
  test("SS-6 — source=manual est propagé", () => {
    const line = buildScanSummaryLine({ ...BASE, source: "manual" });
    expect(extractField(line, "source")).toBe("manual");
  });

  // SS-7 : status=error quand scan échoue
  test("SS-7 — status=error quand scan échoue (valeur par défaut pessimiste)", () => {
    const line = buildScanSummaryLine({ ...BASE, status: "error" });
    expect(extractField(line, "status")).toBe("error");
  });

  // SS-8 : compteurs à -1 quand étape non atteinte (early exit _scanFailed)
  test("SS-8 — compteurs à -1 quand étape non atteinte (scan échoué avant listing)", () => {
    const line = buildScanSummaryLine({
      ...BASE,
      portalTotal: -1,
      knownCount: -1,
      newCount: -1,
      loaded: -1,
      failed: -1,
      vusAdded: -1,
      noDeliveryRetry: -1,
      skippedForNext: -1,
      status: "error",
    });
    expect(extractField(line, "portal_total")).toBe("-1");
    expect(extractField(line, "known_count")).toBe("-1");
    expect(extractField(line, "new")).toBe("-1");
    expect(extractField(line, "loaded")).toBe("-1");
    expect(extractField(line, "failed")).toBe("-1");
    expect(extractField(line, "vus_added")).toBe("-1");
    expect(extractField(line, "no_delivery_retry")).toBe("-1");
    expect(extractField(line, "skipped_for_next")).toBe("-1");
    expect(extractField(line, "status")).toBe("error");
  });

  // SS-9 : failed = bcToLoad.length - newDetailed.length
  test("SS-9 — failed = bcToLoad.length - newDetailed.length", () => {
    // Simuler 10 fiches à charger, 7 réussies, 3 échecs
    const bcToLoadLen = 10;
    const newDetailedLen = 7;
    const line = buildScanSummaryLine({
      ...BASE,
      loaded: newDetailedLen,
      failed: bcToLoadLen - newDetailedLen,
    });
    expect(extractField(line, "loaded")).toBe("7");
    expect(extractField(line, "failed")).toBe("3");
  });

  // SS-10 : skipped_for_next > 0 quand cap MAX_NEW_BC_DETAILS_PER_SCAN atteint
  test("SS-10 — skipped_for_next > 0 quand cap MAX_NEW_BC_DETAILS_PER_SCAN actif", () => {
    const line = buildScanSummaryLine({
      ...BASE,
      newCount: 300,
      loaded: 250,
      skippedForNext: 50,
      status: "ok",
    });
    expect(extractField(line, "new")).toBe("300");
    expect(extractField(line, "skipped_for_next")).toBe("50");
    expect(extractField(line, "status")).toBe("ok");
  });

  // SS-11 : no_delivery_retry > 0 quand envoi Telegram échoué
  test("SS-11 — no_delivery_retry > 0 quand envoi Telegram échoué", () => {
    const line = buildScanSummaryLine({
      ...BASE,
      vusAdded: 130,
      noDeliveryRetry: 8,
    });
    expect(extractField(line, "vus_added")).toBe("130");
    expect(extractField(line, "no_delivery_retry")).toBe("8");
  });

  // SS-12 : runId est présent et non vide
  test("SS-12 — runId est présent et non vide", () => {
    const line = buildScanSummaryLine(BASE);
    const runId = extractField(line, "runId");
    expect(runId).not.toBeNull();
    expect(runId!.length).toBeGreaterThan(0);
  });

});
