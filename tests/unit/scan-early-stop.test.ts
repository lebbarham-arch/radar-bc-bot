/**
 * Tests unitaires — Early stop listing BC + BC_DETAIL_CONCURRENT
 *
 * Couvre les deux patches de perf (feat/perf):
 *   A. scrapeAllItems early stop (BC_LISTING_EARLY_STOP_PAGES)
 *   B. loadDetails BATCH configurable (BC_DETAIL_CONCURRENT)
 *
 * Aucune dépendance Puppeteer : toute la logique est mirrorée ici.
 *
 * Nomenclature : ES-N (Early Stop) · DC-N (Detail Concurrent)
 */

// ─── Helpers de type ──────────────────────────────────────────────────────────

interface BcItem {
  id: string;
  objet?: string;
  reference?: string;
}

interface PageResult {
  items: BcItem[];
  hasNext: boolean;
  failed?: boolean;
  _failReason?: string;
}

interface ScrapeAllResult extends Array<BcItem> {
  _scanFailed: boolean;
  _scanFailReason: string;
}

// ─── Mirror de scrapeAllItems (logique pure, sans Puppeteer) ─────────────────
//
// Signature identique au patch :
//   scrapeAllItems(browser, baseUrl, label, knownIds?)
// Ici : browser/baseUrl/label sont ignorés — on passe directement les pages.

async function scrapeAllItemsMirror(
  pages: PageResult[],
  knownIds: Set<string> | undefined,
  earlyStopEnv: string | undefined,
  logs: string[],
): Promise<ScrapeAllResult> {
  const all: BcItem[] = [];
  let pageNum = 1;

  // Résoudre earlyStopN exactement comme le code prod
  const _earlyStopN = (() => {
    const raw = parseInt(earlyStopEnv || "", 10);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return raw;
  })();
  const _earlyStopActive = _earlyStopN > 0 && knownIds != null && knownIds.size > 0;

  if (_earlyStopN === 0) {
    logs.push("[EARLY_STOP] disabled (BC_LISTING_EARLY_STOP_PAGES not set or 0)");
  } else if (!_earlyStopActive) {
    logs.push("[EARLY_STOP] disabled (knownIds vide — bcs_vus probablement vide) seuil=" + _earlyStopN);
  } else {
    logs.push("[EARLY_STOP] active seuil=" + _earlyStopN + " pages known_ids=" + knownIds!.size);
  }

  let _pagesWithoutNew = 0;

  for (let idx = 0; idx < pages.length && pageNum <= 500; idx++, pageNum++) {
    const r = pages[idx]!;
    let stop = false;

    if (r.failed) {
      stop = true;
    } else if (r.items.length === 0) {
      stop = true;
    } else {
      for (const item of r.items) all.push(item);

      // Early stop guard
      if (_earlyStopActive && pageNum > 1 && r.items.length > 0) {
        const _newOnPage = r.items.filter((bc) => !knownIds!.has(bc.id)).length;
        if (_newOnPage === 0) {
          _pagesWithoutNew++;
          logs.push(
            "[EARLY_STOP] page=" + pageNum +
            " all_known pages_without_new=" + _pagesWithoutNew + "/" + _earlyStopN
          );
          if (_pagesWithoutNew >= _earlyStopN) {
            logs.push(
              "[EARLY_STOP] triggered pages_without_new=" + _pagesWithoutNew +
              " → arret listing anticipé"
            );
            stop = true;
          }
        } else {
          _pagesWithoutNew = 0;
        }
      }

      if (!r.hasNext) stop = true;
    }

    if (stop) break;
  }

  const result = all as ScrapeAllResult;
  result._scanFailed = false;
  result._scanFailReason = "";
  return result;
}

// ─── Mirror de la résolution BATCH de loadDetails ────────────────────────────

function resolveBatch(envValue: string | undefined): number {
  const raw = parseInt(envValue || "", 10);
  if (Number.isFinite(raw) && raw >= 1 && raw <= 6) return raw;
  return 3;
}

// ─── Helpers de test ─────────────────────────────────────────────────────────

function makeItem(id: string): BcItem {
  return { id, objet: "BC " + id, reference: "REF-" + id };
}

function makePage(ids: string[], hasNext = true): PageResult {
  return { items: ids.map(makeItem), hasNext };
}

function knownSet(...ids: string[]): Set<string> {
  return new Set(ids);
}

// ─── ES — Early Stop listing ──────────────────────────────────────────────────

describe("ES — Early Stop listing BC", () => {

  // ── Comportement désactivé ────────────────────────────────────────────────

  test("ES-1: sans env, early stop désactivé — toutes les pages scrapées", async () => {
    const pages: PageResult[] = [
      makePage(["1", "2"]),
      makePage(["3", "4"]),
      makePage(["5"], false),  // dernière page
    ];
    const known = knownSet("1", "2");
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, known, undefined, logs);

    expect(result).toHaveLength(5);
    expect(logs[0]).toContain("[EARLY_STOP] disabled (BC_LISTING_EARLY_STOP_PAGES");
    expect(logs.some(l => l.includes("[EARLY_STOP] triggered"))).toBe(false);
  });

  test("ES-2: env=0, early stop désactivé explicitement", async () => {
    const pages: PageResult[] = [
      makePage(["1", "2"]),
      makePage(["1", "2"]),  // toutes connues — mais pas d'early stop
      makePage(["3"], false),
    ];
    const known = knownSet("1", "2");
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, known, "0", logs);

    expect(result).toHaveLength(5);  // all 3 pages scraped
    expect(logs[0]).toContain("[EARLY_STOP] disabled (BC_LISTING_EARLY_STOP_PAGES");
  });

  test("ES-3: env=5, knownIds vide → early stop désactivé (garde BDD vide)", async () => {
    const pages: PageResult[] = [
      makePage(["1", "2"]),
      makePage(["3", "4"]),
    ];
    const known = new Set<string>();  // BDD vide
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, known, "5", logs);

    expect(result).toHaveLength(4);
    expect(logs[0]).toContain("[EARLY_STOP] disabled (knownIds vide");
    expect(logs.some(l => l.includes("[EARLY_STOP] triggered"))).toBe(false);
  });

  test("ES-4: env=5, knownIds undefined → early stop désactivé", async () => {
    const pages: PageResult[] = [
      makePage(["1"]),
      makePage(["1"]),
    ];
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, undefined, "5", logs);

    expect(result).toHaveLength(2);
    expect(logs[0]).toContain("[EARLY_STOP] disabled");
  });

  // ── Garde page 1 ─────────────────────────────────────────────────────────

  test("ES-5: page 1 entièrement connue → pas d'early stop (garde page 1)", async () => {
    const pages: PageResult[] = [
      makePage(["1", "2"]),   // page 1 — toutes connues — mais garde : pageNum===1
      makePage(["3"], false), // page 2 — nouveaux
    ];
    const known = knownSet("1", "2");
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, known, "1", logs);

    // Page 1 toujours scrapée, page 2 aussi car garde empêche stop sur p1
    expect(result).toHaveLength(3);
    expect(logs.some(l => l.includes("[EARLY_STOP] triggered"))).toBe(false);
  });

  // ── Déclenchement normal ──────────────────────────────────────────────────

  test("ES-6: N=3 — stop après 3 pages consécutives all-known", async () => {
    const pages: PageResult[] = [
      makePage(["10", "11"]),      // p1 — nouveaux
      makePage(["1", "2"]),        // p2 — all known, pagesWithoutNew=1
      makePage(["3", "4"]),        // p3 — all known, pagesWithoutNew=2
      makePage(["5", "6"]),        // p4 — all known, pagesWithoutNew=3 → TRIGGERED
      makePage(["99"]),            // p5 — ne doit pas être atteinte
    ];
    const known = knownSet("1", "2", "3", "4", "5", "6");
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, known, "3", logs);

    // p1(2 items) + p2(2) + p3(2) + p4(2) = 8 — p5 non atteinte
    expect(result).toHaveLength(8);
    const triggered = logs.find(l => l.includes("[EARLY_STOP] triggered"));
    expect(triggered).toBeDefined();
    expect(triggered).toContain("pages_without_new=3");
    // p5 (id=99) absent
    expect(result.map(b => b.id)).not.toContain("99");
  });

  test("ES-7: N=1 — stop après 1 page all-known (agressif)", async () => {
    const pages: PageResult[] = [
      makePage(["10"]),       // p1 — nouveau — pas de check (pageNum===1)
      makePage(["1", "2"]),   // p2 — all known → triggered N=1
      makePage(["20"]),       // p3 — ne doit pas être atteinte
    ];
    const known = knownSet("1", "2");
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, known, "1", logs);

    expect(result).toHaveLength(3); // p1(1) + p2(2) = 3
    expect(logs.some(l => l.includes("[EARLY_STOP] triggered"))).toBe(true);
    expect(result.map(b => b.id)).not.toContain("20");
  });

  // ── Reset compteur ────────────────────────────────────────────────────────

  test("ES-8: reset compteur si nouveau BC trouvé sur page intermédiaire", async () => {
    const pages: PageResult[] = [
      makePage(["10"]),            // p1 — nouveau
      makePage(["1", "2"]),        // p2 — all known, pagesWithoutNew=1
      makePage(["NEW"]),           // p3 — nouveau ! → reset pagesWithoutNew=0
      makePage(["3", "4"]),        // p4 — all known, pagesWithoutNew=1
      makePage(["5", "6"]),        // p5 — all known, pagesWithoutNew=2
      makePage(["7", "8"], false), // p6 — all known, pagesWithoutNew=3 → triggered N=3
    ];
    const known = knownSet("1", "2", "3", "4", "5", "6", "7", "8");
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, known, "3", logs);

    // Toutes les pages atteintes car reset à p3
    expect(result.map(b => b.id)).toContain("NEW");
    const triggered = logs.find(l => l.includes("[EARLY_STOP] triggered"));
    expect(triggered).toBeDefined();
  });

  // ── Logs obligatoires ─────────────────────────────────────────────────────

  test("ES-9: logs [EARLY_STOP] page= bien émis avec compteur", async () => {
    const pages: PageResult[] = [
      makePage(["10"]),        // p1 — nouveau
      makePage(["1"]),         // p2 — all known → log page=2 1/3
      makePage(["2"]),         // p3 — all known → log page=3 2/3
      makePage(["3"], false),  // p4 — all known → log page=4 3/3 + triggered
    ];
    const known = knownSet("1", "2", "3");
    const logs: string[] = [];
    await scrapeAllItemsMirror(pages, known, "3", logs);

    const pageLogs = logs.filter(l => l.includes("[EARLY_STOP] page="));
    expect(pageLogs).toHaveLength(3);
    expect(pageLogs[0]).toContain("page=2");
    expect(pageLogs[0]).toContain("pages_without_new=1/3");
    expect(pageLogs[1]).toContain("page=3");
    expect(pageLogs[1]).toContain("pages_without_new=2/3");
    expect(pageLogs[2]).toContain("page=4");
    expect(pageLogs[2]).toContain("pages_without_new=3/3");

    const triggered = logs.find(l => l.includes("[EARLY_STOP] triggered"));
    expect(triggered).toContain("pages_without_new=3");
  });

  test("ES-10: log [EARLY_STOP] active contient seuil et known_ids count", async () => {
    const pages: PageResult[] = [makePage(["X"], false)];
    const known = knownSet("A", "B", "C");
    const logs: string[] = [];
    await scrapeAllItemsMirror(pages, known, "5", logs);

    expect(logs[0]).toContain("[EARLY_STOP] active seuil=5");
    expect(logs[0]).toContain("known_ids=3");
  });

  // ── Arrêt naturel (hasNext=false) non affecté ─────────────────────────────

  test("ES-11: arrêt naturel hasNext=false non affecté par early stop actif", async () => {
    const pages: PageResult[] = [
      makePage(["10"]),        // p1 — nouveau
      makePage(["20"], false), // p2 — nouveau, hasNext=false → arrêt normal
    ];
    const known = knownSet("1");
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, known, "5", logs);

    expect(result).toHaveLength(2);
    expect(logs.some(l => l.includes("[EARLY_STOP] triggered"))).toBe(false);
  });

  // ── Échec page ────────────────────────────────────────────────────────────

  test("ES-12: failed=true sur une page → arrêt immédiat, early stop non déclenché", async () => {
    const pages: PageResult[] = [
      makePage(["10"]),
      { items: [], hasNext: false, failed: true, _failReason: "NAV_TIMEOUT" },
      makePage(["99"]), // ne doit pas être atteinte
    ];
    const known = knownSet("1");
    const logs: string[] = [];
    const result = await scrapeAllItemsMirror(pages, known, "1", logs);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("10");
    expect(logs.some(l => l.includes("[EARLY_STOP] triggered"))).toBe(false);
  });
});

// ─── DC — BC_DETAIL_CONCURRENT ────────────────────────────────────────────────

describe("DC — BC_DETAIL_CONCURRENT résolution BATCH", () => {

  test("DC-1: sans env → défaut 3", () => {
    expect(resolveBatch(undefined)).toBe(3);
  });

  test("DC-2: env vide → défaut 3", () => {
    expect(resolveBatch("")).toBe(3);
  });

  test("DC-3: env=3 → 3", () => {
    expect(resolveBatch("3")).toBe(3);
  });

  test("DC-4: env=5 → 5 (valeur recommandée)", () => {
    expect(resolveBatch("5")).toBe(5);
  });

  test("DC-5: env=1 → 1 (minimum)", () => {
    expect(resolveBatch("1")).toBe(1);
  });

  test("DC-6: env=6 → 6 (maximum autorisé)", () => {
    expect(resolveBatch("6")).toBe(6);
  });

  test("DC-7: env=7 → défaut 3 (hors borne max 6)", () => {
    expect(resolveBatch("7")).toBe(3);
  });

  test("DC-8: env=0 → défaut 3 (hors borne min 1)", () => {
    expect(resolveBatch("0")).toBe(3);
  });

  test("DC-9: env=-1 → défaut 3 (négatif)", () => {
    expect(resolveBatch("-1")).toBe(3);
  });

  test("DC-10: env=abc → défaut 3 (non numérique)", () => {
    expect(resolveBatch("abc")).toBe(3);
  });

  test("DC-11: env=2.9 → défaut 3 (float → parseInt = 2, < 1? non → 2)", () => {
    // parseInt("2.9") = 2, qui est dans [1,6] → retourne 2
    expect(resolveBatch("2.9")).toBe(2);
  });

  test("DC-12: env=6.9 → 6 (parseInt 6.9 = 6, dans [1,6])", () => {
    expect(resolveBatch("6.9")).toBe(6);
  });
});
// ─── LD — loadDetails accumulation résultat + progress logs ──────────────────
//
// Régression couverte : `const result = []` manquant → ReferenceError result.length.
// La mirror reproduit exactement la structure du code prod corrigé.

interface DetailItem {
  id: string;
  objet?: string;
}

interface LoadDetailsResult {
  items: DetailItem[];
  logs:  string[];
}

function loadDetailsMirror(
  inputItems: DetailItem[],
  batch: number,
  progressEvery: number,
  scrapeItem: (item: DetailItem) => DetailItem,
  failedIds: Set<string>,
  logs: string[],
): DetailItem[] {
  if (!inputItems.length) return [];

  // ← Bug original : cette ligne manquait → ReferenceError: result is not defined
  const result: DetailItem[] = [];
  const _fiches_start = Date.now();
  let _fiches_failed = 0;

  for (let i = 0; i < inputItems.length; i += batch) {
    const batchItems = inputItems.slice(i, i + batch);
    const prevLen = result.length;

    const detailed = batchItems.map((item) => {
      if (failedIds.has(item.id)) {
        _fiches_failed++;
        return item;
      }
      return scrapeItem(item);
    });

    result.push(...detailed);

    const prevMilestone = Math.floor(prevLen / progressEvery);
    const currMilestone = Math.floor(result.length / progressEvery);
    if (currMilestone > prevMilestone) {
      const elapsed = Date.now() - _fiches_start;
      logs.push("[FICHES] loaded=" + result.length + "/" + inputItems.length
        + " failed=" + _fiches_failed + " elapsed=" + elapsed + "ms");
    }
  }

  return result;
}

function makeDetailItem(id: string): DetailItem {
  return { id, objet: "BC " + id };
}

function makeDetailItems(n: number, offset = 0): DetailItem[] {
  return Array.from({ length: n }, (_, i) => makeDetailItem(String(i + 1 + offset)));
}

describe("LD — loadDetails accumulation + progress", () => {

  test("LD-1: items vide → retourne [] sans erreur", () => {
    const logs: string[] = [];
    const res = loadDetailsMirror([], 3, 25, x => x, new Set(), logs);
    expect(res).toHaveLength(0);
    expect(logs).toHaveLength(0);
  });

  test("LD-2: 1 item, BATCH=3 → retourne 1 item enrichi", () => {
    const items = [makeDetailItem("bc1")];
    const logs: string[] = [];
    const scrape = (item: DetailItem): DetailItem => ({ ...item, objet: "enrichi-" + item.id });
    const res = loadDetailsMirror(items, 3, 25, scrape, new Set(), logs);
    expect(res).toHaveLength(1);
    expect(res[0]!.objet).toBe("enrichi-bc1");
  });

  test("LD-3: 9 items, BATCH=3 → exactement 9 résultats (3 batches x 3)", () => {
    const items = makeDetailItems(9);
    const logs: string[] = [];
    const res = loadDetailsMirror(items, 3, 25, x => x, new Set(), logs);
    expect(res).toHaveLength(9);
  });

  test("LD-4: 10 items, BATCH=3 → exactement 10 résultats (dernier batch = 1)", () => {
    const items = makeDetailItems(10);
    const logs: string[] = [];
    const res = loadDetailsMirror(items, 3, 25, x => x, new Set(), logs);
    expect(res).toHaveLength(10);
  });

  test("LD-5: ordre préservé — items sortent dans le même ordre que l'entrée", () => {
    const items = makeDetailItems(7);
    const logs: string[] = [];
    const res = loadDetailsMirror(items, 3, 25, x => x, new Set(), logs);
    expect(res.map(r => r.id)).toEqual(items.map(i => i.id));
  });

  test("LD-6: item en échec → retourne l'item brut (fallback), pas undefined", () => {
    const items = [makeDetailItem("good"), makeDetailItem("fail"), makeDetailItem("good2")];
    const logs: string[] = [];
    const failedIds = new Set(["fail"]);
    const scrape = (item: DetailItem): DetailItem => ({ ...item, objet: "enrichi" });
    const res = loadDetailsMirror(items, 3, 25, scrape, failedIds, logs);
    expect(res).toHaveLength(3);
    const failItem = res.find(r => r.id === "fail");
    expect(failItem).toBeDefined();
    expect(failItem!.objet).toBe("BC fail");
  });

  test("LD-7: 25 items, PROGRESS_EVERY=25, BATCH=5 → 1 log [FICHES] a loaded=25", () => {
    const items = makeDetailItems(25);
    const logs: string[] = [];
    loadDetailsMirror(items, 5, 25, x => x, new Set(), logs);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[FICHES] loaded=25/25");
  });

  test("LD-8: 50 items, PROGRESS_EVERY=25, BATCH=5 → 2 logs [FICHES] (jalons 25 et 50)", () => {
    const items = makeDetailItems(50);
    const logs: string[] = [];
    loadDetailsMirror(items, 5, 25, x => x, new Set(), logs);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("loaded=25/50");
    expect(logs[1]).toContain("loaded=50/50");
  });

  test("LD-9: 10 items, PROGRESS_EVERY=25 → 0 logs (seuil jamais atteint)", () => {
    const items = makeDetailItems(10);
    const logs: string[] = [];
    loadDetailsMirror(items, 3, 25, x => x, new Set(), logs);
    expect(logs).toHaveLength(0);
  });

  test("LD-10: log [FICHES] contient failed= avec le bon compteur", () => {
    const items = makeDetailItems(25);
    const failedIds = new Set(["3", "7", "12"]);
    const logs: string[] = [];
    loadDetailsMirror(items, 5, 25, x => x, failedIds, logs);
    expect(logs[0]).toContain("failed=3");
  });

  test("LD-11: log [FICHES] contient elapsed= (entier >= 0)", () => {
    const items = makeDetailItems(25);
    const logs: string[] = [];
    loadDetailsMirror(items, 5, 25, x => x, new Set(), logs);
    const match = logs[0]!.match(/elapsed=(\d+)ms/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1]!, 10)).toBeGreaterThanOrEqual(0);
  });

  test("LD-12: BATCH=1 → même résultat final que BATCH=5", () => {
    const items = makeDetailItems(25);
    const logs1: string[] = [];
    const logs5: string[] = [];
    const res1 = loadDetailsMirror(items, 1, 9999, x => x, new Set(), logs1);
    const res5 = loadDetailsMirror(items, 5, 9999, x => x, new Set(), logs5);
    expect(res1.map(r => r.id)).toEqual(res5.map(r => r.id));
  });
});

// ─── DD-* : Déduplication newBCs par bc_id (GD-132) ─────────────────────────
//
// Mirror exacte de l'IIFE dans radar-bc-bot.js (bloc GD-132).
// Entrée  : items = tableau brut (potentiellement avec doublons bc_id)
//           vusIds = Set des ids déjà connus
// Sortie  : { deduped: BcItem[], removed: number, logs: string[] }

interface BcRaw { id: string; objet?: string; }

function dedupNewBCsMirror(
  allBCs:  BcRaw[],
  vusIds:  Set<string>,
): { deduped: BcRaw[]; removed: number; logs: string[] } {
  const logs: string[] = [];
  const logFn = (msg: string) => logs.push(msg);

  const newBCs: BcRaw[] = (() => {
    const _raw = allBCs.filter(bc => !vusIds.has(bc.id));
    const _seen = new Set<string>();
    const _out: BcRaw[] = [];
    for (const bc of _raw) {
      const key = String(bc.id || "");
      if (!key || !_seen.has(key)) { _seen.add(key); _out.push(bc); }
    }
    const _removed = _raw.length - _out.length;
    if (_removed > 0) {
      logFn("[DEDUP] nouveaux BC dedup before=" + _raw.length + " after=" + _out.length + " removed=" + _removed);
    }
    return _out;
  })();

  return { deduped: newBCs, removed: allBCs.filter(bc => !vusIds.has(bc.id)).length - newBCs.length, logs };
}

describe("DD — Déduplication newBCs par bc_id (GD-132)", () => {

  test("DD-1 : liste sans doublon — inchangée, pas de log", () => {
    const items: BcRaw[] = [{ id: "1" }, { id: "2" }, { id: "3" }];
    const { deduped, removed, logs } = dedupNewBCsMirror(items, new Set());
    expect(deduped).toHaveLength(3);
    expect(removed).toBe(0);
    expect(logs).toHaveLength(0);
  });

  test("DD-2 : 2 doublons bc_id=360273 → 1 conservé, 1 supprimé, log émis", () => {
    const items: BcRaw[] = [{ id: "360273", objet: "A" }, { id: "360273", objet: "B" }];
    const { deduped, removed, logs } = dedupNewBCsMirror(items, new Set());
    expect(deduped).toHaveLength(1);
    expect(deduped[0]!.objet).toBe("A"); // premier conservé
    expect(removed).toBe(1);
    expect(logs[0]).toContain("[DEDUP] nouveaux BC dedup before=2 after=1 removed=1");
  });

  test("DD-3 : 3 doublons mêlés à d'autres ids uniques", () => {
    const items: BcRaw[] = [
      { id: "1" }, { id: "2" }, { id: "2" }, { id: "3" }, { id: "2" },
    ];
    const { deduped, removed, logs } = dedupNewBCsMirror(items, new Set());
    expect(deduped.map(b => b.id)).toEqual(["1", "2", "3"]);
    expect(removed).toBe(2);
    expect(logs[0]).toContain("before=5 after=3 removed=2");
  });

  test("DD-4 : items déjà dans vusIds filtrés avant dédup", () => {
    const items: BcRaw[] = [{ id: "100" }, { id: "200" }, { id: "200" }];
    const vus = new Set(["100"]);
    const { deduped, removed } = dedupNewBCsMirror(items, vus);
    // "100" est vus → ignoré ; "200" x2 → garde 1
    expect(deduped.map(b => b.id)).toEqual(["200"]);
    expect(removed).toBe(1);
  });

  test("DD-5 : items avec id vide ou null — conservés sans dédup entre eux", () => {
    const items: BcRaw[] = [{ id: "" }, { id: "" }, { id: "5" }];
    const { deduped, removed, logs } = dedupNewBCsMirror(items, new Set());
    // Les items sans id valide sont tous conservés (sécurité)
    expect(deduped).toHaveLength(3);
    expect(removed).toBe(0);
    expect(logs).toHaveLength(0);
  });

  test("DD-6 : liste vide — retourne vide sans log", () => {
    const { deduped, removed, logs } = dedupNewBCsMirror([], new Set());
    expect(deduped).toHaveLength(0);
    expect(removed).toBe(0);
    expect(logs).toHaveLength(0);
  });

  test("DD-7 : source radar-bc-bot.js contient le bloc GD-132", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../radar-bc-bot.js"), "utf8"
    );
    expect(src).toContain("GD-132");
    expect(src).toContain("[DEDUP] nouveaux BC dedup before=");
  });

});

export {}
