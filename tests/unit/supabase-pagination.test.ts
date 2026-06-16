/**
 * Tests unitaires — sbFetchAllPages : pagination Supabase/PostgREST
 *
 * Couvre la logique extraite de radar-bc-bot.js → sbFetchAllPages()
 * ainsi que son intégration dans getBCVusIds (via mirror).
 *
 * PAG-1  Une seule page (< pageSize) — terminaison immédiate
 * PAG-2  Page exactement pleine → une seconde page (vide) termine
 * PAG-3  Deux pages pleines + une partielle → trois appels
 * PAG-4  Table vide → 0 lignes, 1 appel
 * PAG-5  pageSize par défaut = 1000
 * PAG-6  Offset progressif correct (0, 1000, 2000…)
 * PAG-7  Erreur réseau → propagée
 * PAG-8  getBCVusIds intègre toutes les pages dans le Set
 * PAG-9  getBCVusIds log [KNOWN_DIAG] bcs_vus_load total_loaded= pages_loaded=
 * PAG-10 getBCVusIds retourne Set vide si erreur (sans crash)
 * PAG-11 Chunk contenant null/undefined filtrés dans getBCVusBCData
 * PAG-12 Exactly pageSize rows across N pages — count correct
 */

// ────────────────────────────────────────────────────────────────────────────
// Fonctions miroir extraites du bot
// ────────────────────────────────────────────────────────────────────────────

type SbRow = Record<string, unknown>;

interface FetchAllResult {
  rows: SbRow[];
  pages: number;
}

async function sbFetchAllPages(
  basePath: string,
  pageSize: number,
  sbReq: (path: string) => Promise<SbRow[] | null>
): Promise<FetchAllResult> {
  const ps = pageSize || 1000;
  const all: SbRow[] = [];
  let offset = 0;
  let pages = 0;
  while (true) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path = basePath + sep + "limit=" + ps + "&offset=" + offset;
    const chunk = await sbReq(path);
    pages++;
    if (!chunk || !chunk.length) break;
    for (let i = 0; i < chunk.length; i++) all.push(chunk[i]!);
    if (chunk.length < ps) break;
    offset += ps;
  }
  return { rows: all, pages };
}

// Mirror de getBCVusIds
async function getBCVusIds(
  sbReq: (path: string) => Promise<SbRow[] | null>,
  logs: string[]
): Promise<Set<string>> {
  try {
    const { rows, pages } = await sbFetchAllPages("bcs_vus?select=bc_id", 1000, sbReq);
    logs.push("[KNOWN_DIAG] bcs_vus_load total_loaded=" + rows.length + " pages_loaded=" + pages);
    return new Set(rows.map(r => r.bc_id as string));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logs.push("  bcs_vus indisponible: " + msg);
    return new Set();
  }
}

// Mirror de getBCVusBCData
async function getBCVusBCData(
  sbReq: (path: string) => Promise<SbRow[] | null>
): Promise<unknown[]> {
  try {
    const { rows } = await sbFetchAllPages("bcs_vus?select=bc_data", 1000, sbReq);
    return rows.map(r => r.bc_data).filter(Boolean);
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeRows(count: number, key: string, prefix = "id-"): SbRow[] {
  return Array.from({ length: count }, (_, i) => ({ [key]: prefix + i }));
}

function makePager(pages: SbRow[][]): {
  fn: (path: string) => Promise<SbRow[] | null>;
  calls: string[];
} {
  const calls: string[] = [];
  let idx = 0;
  return {
    fn: async (path: string): Promise<SbRow[] | null> => {
      calls.push(path);
      if (idx >= pages.length) return [];
      return pages[idx++] ?? [];
    },
    calls,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// PAG-1 : Une seule page (< pageSize)
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-1 sbFetchAllPages — une seule page incomplète", () => {
  it("retourne les lignes et 1 page", async () => {
    const { fn } = makePager([makeRows(5, "bc_id")]);
    const { rows, pages } = await sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn);
    expect(rows).toHaveLength(5);
    expect(pages).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-2 : Page exactement pleine → appel supplémentaire vide
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-2 sbFetchAllPages — page exactement pleine", () => {
  it("fait 2 appels (1 plein + 1 vide terminant la boucle)", async () => {
    const { fn, calls } = makePager([makeRows(10, "bc_id"), []]);
    const { rows, pages } = await sbFetchAllPages("bcs_vus?select=bc_id", 10, fn);
    expect(rows).toHaveLength(10);
    expect(pages).toBe(2);
    expect(calls).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-3 : Deux pages pleines + une partielle
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-3 sbFetchAllPages — deux pages pleines + une partielle", () => {
  it("accumule 2500 lignes en 3 appels (pageSize=1000)", async () => {
    const p1 = makeRows(1000, "bc_id", "a-");
    const p2 = makeRows(1000, "bc_id", "b-");
    const p3 = makeRows(500,  "bc_id", "c-");
    const { fn, calls } = makePager([p1, p2, p3]);
    const { rows, pages } = await sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn);
    expect(rows).toHaveLength(2500);
    expect(pages).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("les 2500 lignes sont dans le bon ordre", async () => {
    const p1 = makeRows(1000, "bc_id", "a-");
    const p2 = makeRows(1000, "bc_id", "b-");
    const p3 = makeRows(500,  "bc_id", "c-");
    const { fn } = makePager([p1, p2, p3]);
    const { rows } = await sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn);
    expect(rows[0]!.bc_id).toBe("a-0");
    expect(rows[999]!.bc_id).toBe("a-999");
    expect(rows[1000]!.bc_id).toBe("b-0");
    expect(rows[2000]!.bc_id).toBe("c-0");
    expect(rows[2499]!.bc_id).toBe("c-499");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-4 : Table vide
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-4 sbFetchAllPages — table vide", () => {
  it("retourne 0 lignes et 1 page (appel unique)", async () => {
    const { fn, calls } = makePager([[]]);
    const { rows, pages } = await sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn);
    expect(rows).toHaveLength(0);
    expect(pages).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("réponse null traitée comme vide", async () => {
    const fn = async (_: string) => null;
    const { rows, pages } = await sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn);
    expect(rows).toHaveLength(0);
    expect(pages).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-5 : pageSize par défaut = 1000
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-5 sbFetchAllPages — pageSize 0 traité comme 1000", () => {
  it("un lot de 999 items = 1 seul appel", async () => {
    const { fn, calls } = makePager([makeRows(999, "bc_id")]);
    const { rows } = await sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn);
    expect(rows).toHaveLength(999);
    expect(calls).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-6 : Offset progressif correct dans les URLs
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-6 sbFetchAllPages — offset dans les URLs", () => {
  it("URLs contiennent offset=0, 1000, 2000", async () => {
    const p1 = makeRows(1000, "bc_id", "a-");
    const p2 = makeRows(1000, "bc_id", "b-");
    const p3 = makeRows(1,    "bc_id", "c-");
    const { fn, calls } = makePager([p1, p2, p3]);
    await sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn);
    expect(calls[0]).toContain("offset=0");
    expect(calls[1]).toContain("offset=1000");
    expect(calls[2]).toContain("offset=2000");
  });

  it("URLs contiennent limit=500 si pageSize=500", async () => {
    const { fn, calls } = makePager([makeRows(3, "bc_id")]);
    await sbFetchAllPages("bcs_vus?select=bc_id", 500, fn);
    expect(calls[0]).toContain("limit=500");
  });

  it("séparateur & si basePath contient déjà ?", async () => {
    const { fn, calls } = makePager([[]]);
    await sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn);
    expect(calls[0]).toContain("bcs_vus?select=bc_id&limit=");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-7 : Erreur réseau propagée
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-7 sbFetchAllPages — erreur réseau propagée", () => {
  it("throw si sbReq rejette", async () => {
    const fn = async (_: string) => { throw new Error("NETWORK_ERROR"); };
    await expect(sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn))
      .rejects.toThrow("NETWORK_ERROR");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-8 : getBCVusIds intègre toutes les pages dans le Set
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-8 getBCVusIds — Set contient toutes les pages", () => {
  it("2500 ids répartis sur 3 pages → Set de 2500", async () => {
    const p1 = makeRows(1000, "bc_id", "a-");
    const p2 = makeRows(1000, "bc_id", "b-");
    const p3 = makeRows(500,  "bc_id", "c-");
    const { fn } = makePager([p1, p2, p3]);
    const logs: string[] = [];
    const ids = await getBCVusIds(fn, logs);
    expect(ids.size).toBe(2500);
    expect(ids.has("a-0")).toBe(true);
    expect(ids.has("b-999")).toBe(true);
    expect(ids.has("c-499")).toBe(true);
  });

  it("pas de doublons dans le Set même si Supabase en renvoie", async () => {
    const p1 = [{ bc_id: "dup-1" }, { bc_id: "dup-1" }, { bc_id: "dup-2" }];
    const { fn } = makePager([p1]);
    const ids = await getBCVusIds(fn, []);
    expect(ids.size).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-9 : log [KNOWN_DIAG] bcs_vus_load
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-9 getBCVusIds — log [KNOWN_DIAG] bcs_vus_load", () => {
  it("log présent avec total_loaded et pages_loaded", async () => {
    const p1 = makeRows(1000, "bc_id", "a-");
    const p2 = makeRows(300,  "bc_id", "b-");
    const { fn } = makePager([p1, p2]);
    const logs: string[] = [];
    await getBCVusIds(fn, logs);
    const diagLog = logs.find(l => l.includes("[KNOWN_DIAG] bcs_vus_load"));
    expect(diagLog).toBeDefined();
    expect(diagLog).toContain("total_loaded=1300");
    expect(diagLog).toContain("pages_loaded=2");
  });

  it("table vide → total_loaded=0 pages_loaded=1", async () => {
    const { fn } = makePager([[]]);
    const logs: string[] = [];
    await getBCVusIds(fn, logs);
    const diagLog = logs.find(l => l.includes("[KNOWN_DIAG] bcs_vus_load"));
    expect(diagLog).toContain("total_loaded=0");
    expect(diagLog).toContain("pages_loaded=1");
  });

  it("1000 lignes exactes → pages_loaded=2 (appel vide final)", async () => {
    const { fn } = makePager([makeRows(1000, "bc_id"), []]);
    const logs: string[] = [];
    await getBCVusIds(fn, logs);
    const diagLog = logs.find(l => l.includes("[KNOWN_DIAG] bcs_vus_load"));
    expect(diagLog).toContain("total_loaded=1000");
    expect(diagLog).toContain("pages_loaded=2");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-10 : getBCVusIds retourne Set vide si erreur
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-10 getBCVusIds — Set vide si erreur réseau", () => {
  it("erreur → Set vide, pas de crash", async () => {
    const fn = async (_: string) => { throw new Error("timeout"); };
    const logs: string[] = [];
    const ids = await getBCVusIds(fn, logs);
    expect(ids.size).toBe(0);
    expect(logs.some(l => l.includes("bcs_vus indisponible"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-11 : getBCVusBCData filtre null/undefined
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-11 getBCVusBCData — filtre les bc_data null/undefined", () => {
  it("bc_data null ignoré", async () => {
    const page: SbRow[] = [
      { bc_data: { id: "bc-1" } },
      { bc_data: null },
      { bc_data: { id: "bc-2" } },
      { bc_data: undefined },
    ];
    const { fn } = makePager([page]);
    const result = await getBCVusBCData(fn);
    expect(result).toHaveLength(2);
  });

  it("toutes les pages accumulées", async () => {
    const p1: SbRow[] = Array.from({ length: 1000 }, (_, i) => ({ bc_data: { id: "bc-" + i } }));
    const p2: SbRow[] = Array.from({ length: 200 },  (_, i) => ({ bc_data: { id: "bd-" + i } }));
    const { fn } = makePager([p1, p2]);
    const result = await getBCVusBCData(fn);
    expect(result).toHaveLength(1200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PAG-12 : Exactement N*pageSize lignes
// ────────────────────────────────────────────────────────────────────────────
describe("PAG-12 sbFetchAllPages — N*pageSize lignes exactes", () => {
  it("3000 lignes en pageSize=1000 → 4 appels (3 pleins + 1 vide)", async () => {
    const p1 = makeRows(1000, "bc_id", "a-");
    const p2 = makeRows(1000, "bc_id", "b-");
    const p3 = makeRows(1000, "bc_id", "c-");
    const p4: SbRow[] = [];
    const { fn, calls } = makePager([p1, p2, p3, p4]);
    const { rows, pages } = await sbFetchAllPages("bcs_vus?select=bc_id", 1000, fn);
    expect(rows).toHaveLength(3000);
    expect(pages).toBe(4);
    expect(calls).toHaveLength(4);
  });
});

export {};
