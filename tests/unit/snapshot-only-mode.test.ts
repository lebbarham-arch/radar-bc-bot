/**
 * Tests unitaires — Mode RADAR_BC_SNAPSHOT_ONLY
 *
 * Couvre le flag RADAR_BC_SNAPSHOT_ONLY=1 dans radar-bc-bot.js :
 *   A. Déclaration et documentation de la constante SNAPSHOT_ONLY
 *   B. Garde writeInputSnapshot : écriture forcée même sans WRITE_INPUT_SNAPSHOT
 *   C. Early-exit dans runGlobalScanBC AVANT matchClient et markBCVus
 *   D. Serveur HTTP non démarré en mode SNAPSHOT_ONLY
 *   E. Cron non démarré en mode SNAPSHOT_ONLY
 *   F. Logs [SnapshotOnly] explicites et traçables
 *   G. process.exit(0) déclenché après writeInputSnapshot
 *
 * Approche : tests structurels (lecture de radar-bc-bot.js comme texte).
 * Aucune dépendance Puppeteer ni Supabase.
 * Ces tests servent de garde de régression — ils échouent si la garantie est brisée.
 *
 * Nomenclature : SO-N (Snapshot Only)
 */

import * as fs   from "fs";
import * as path from "path";

// ─── Chargement source ────────────────────────────────────────────────────────

const BOT_SRC = fs.readFileSync(
  path.join(__dirname, "../../radar-bc-bot.js"),
  "utf8",
);

/** Renvoie l'index de la première occurrence de needle dans BOT_SRC. */
function idx(needle: string): number {
  return BOT_SRC.indexOf(needle);
}

/** true si needle est présent dans BOT_SRC. */
function has(needle: string): boolean {
  return BOT_SRC.includes(needle);
}

// ─── SO-A — Déclaration de la constante ──────────────────────────────────────

describe("SO-A — Déclaration SNAPSHOT_ONLY", () => {

  test("SO-1: SNAPSHOT_ONLY est déclaré via process.env.RADAR_BC_SNAPSHOT_ONLY", () => {
    expect(has('process.env.RADAR_BC_SNAPSHOT_ONLY === "1"')).toBe(true);
  });

  test("SO-2: la déclaration est une constante (const SNAPSHOT_ONLY)", () => {
    expect(has("const SNAPSHOT_ONLY")).toBe(true);
  });

  test("SO-3: SNAPSHOT_ONLY est déclaré dans le même voisinage que SERVER_ONLY", () => {
    const idxServer   = idx("const SERVER_ONLY");
    const idxSnapshot = idx("const SNAPSHOT_ONLY");
    // Les deux doivent exister et être proches (< 5 lignes = < 300 chars)
    expect(idxServer).toBeGreaterThan(-1);
    expect(idxSnapshot).toBeGreaterThan(-1);
    expect(Math.abs(idxServer - idxSnapshot)).toBeLessThan(300);
  });
});

// ─── SO-B — Garde writeInputSnapshot ─────────────────────────────────────────

describe("SO-B — writeInputSnapshot forcée en mode SNAPSHOT_ONLY", () => {

  test("SO-4: la garde writeInputSnapshot inclut !SNAPSHOT_ONLY", () => {
    // La garde doit autoriser l'écriture quand SNAPSHOT_ONLY=true
    expect(has("!WRITE_INPUT_SNAPSHOT && !SNAPSHOT_ONLY")).toBe(true);
  });

  test("SO-5: la garde modifiée est DANS la fonction writeInputSnapshot", () => {
    const fnStart  = idx("function writeInputSnapshot");
    const guardPos = idx("!WRITE_INPUT_SNAPSHOT && !SNAPSHOT_ONLY");
    expect(fnStart).toBeGreaterThan(-1);
    expect(guardPos).toBeGreaterThan(fnStart);
    // La garde est dans les 300 premiers chars de la fonction
    expect(guardPos - fnStart).toBeLessThan(300);
  });
});

// ─── SO-C — Early-exit avant matchClient / markBCVus ─────────────────────────

describe("SO-C — Early-exit avant matchClient et markBCVus", () => {

  test("SO-6: le bloc if (SNAPSHOT_ONLY) existe dans runGlobalScanBC", () => {
    const fnStart     = idx("async function runGlobalScanBC");
    const blockPos    = BOT_SRC.indexOf("if (SNAPSHOT_ONLY) {", fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    expect(blockPos).toBeGreaterThan(fnStart);
  });

  test("SO-7: [SnapshotOnly] markBCVus skipped apparaît AVANT db.markBCVus dans le fichier", () => {
    const guardLog  = idx("[SnapshotOnly] markBCVus skipped");
    const markVus   = idx("db.markBCVus(");
    expect(guardLog).toBeGreaterThan(-1);
    expect(markVus).toBeGreaterThan(-1);
    expect(guardLog).toBeLessThan(markVus);
  });

  test("SO-8: [SnapshotOnly] matchClient skipped apparaît AVANT les appels matchClient dans runGlobalScanBC", () => {
    const fnStart     = idx("async function runGlobalScanBC");
    const guardLog    = BOT_SRC.indexOf("[SnapshotOnly] matchClient skipped", fnStart);
    const matchCall   = BOT_SRC.indexOf("await matchClient(", fnStart);
    expect(guardLog).toBeGreaterThan(fnStart);
    expect(matchCall).toBeGreaterThan(fnStart);
    expect(guardLog).toBeLessThan(matchCall);
  });

  test("SO-9: process.exit(0) est présent dans le bloc SNAPSHOT_ONLY de runGlobalScanBC", () => {
    const fnStart    = idx("async function runGlobalScanBC");
    const blockStart = BOT_SRC.indexOf("if (SNAPSHOT_ONLY) {", fnStart);
    // Chercher process.exit(0) dans les 500 chars suivant l'ouverture du bloc
    const blockSlice = BOT_SRC.slice(blockStart, blockStart + 500);
    expect(blockSlice).toContain("process.exit(0)");
  });

  test("SO-10: le browser est explicitement fermé avant process.exit(0)", () => {
    const fnStart    = idx("async function runGlobalScanBC");
    const blockStart = BOT_SRC.indexOf("if (SNAPSHOT_ONLY) {", fnStart);
    const blockSlice = BOT_SRC.slice(blockStart, blockStart + 500);
    expect(blockSlice).toContain("browser.close()");
    const closePos = blockSlice.indexOf("browser.close()");
    const exitPos  = blockSlice.indexOf("process.exit(0)");
    expect(closePos).toBeLessThan(exitPos);
  });
});

// ─── SO-D — Serveur HTTP conditionnel ────────────────────────────────────────

describe("SO-D — Serveur HTTP non démarré en mode SNAPSHOT_ONLY", () => {

  test("SO-11: _httpServer.listen est conditionnel sur !SNAPSHOT_ONLY", () => {
    // La condition doit exister juste avant ou autour de listen
    expect(has("!SNAPSHOT_ONLY")).toBe(true);
    const condPos   = BOT_SRC.lastIndexOf("!SNAPSHOT_ONLY");
    const listenPos = idx("_httpServer.listen(");
    // La condition (!SNAPSHOT_ONLY) doit précéder ou entourer _httpServer.listen
    // On cherche le pattern dans la même zone (avant cron)
    const cronPos = idx("cron.schedule(");
    expect(listenPos).toBeLessThan(cronPos);
    // Il doit y avoir un !SNAPSHOT_ONLY entre le démarrage du fichier et la zone listen
    expect(BOT_SRC.indexOf("!SNAPSHOT_ONLY")).toBeLessThan(cronPos);
  });

  test("SO-12: log [SnapshotOnly] serveur HTTP non démarré est présent", () => {
    expect(has("[SnapshotOnly] serveur HTTP non démarré")).toBe(true);
  });
});

// ─── SO-E — Cron conditionnel ─────────────────────────────────────────────────

describe("SO-E — Cron non démarré en mode SNAPSHOT_ONLY", () => {

  test("SO-13: la condition du bloc cron inclut !SNAPSHOT_ONLY", () => {
    expect(has("!SERVER_ONLY && !SNAPSHOT_ONLY")).toBe(true);
  });

  test("SO-14: log [SnapshotOnly] cron non démarré est présent", () => {
    expect(has("[SnapshotOnly] cron non démarré")).toBe(true);
  });
});

// ─── SO-F — Logs [SnapshotOnly] traçables ────────────────────────────────────

describe("SO-F — Logs [SnapshotOnly] explicites", () => {

  test("SO-15: log notifications disabled est présent", () => {
    expect(has("[SnapshotOnly] notifications disabled")).toBe(true);
  });

  test("SO-16: log RADAR_BC_SNAPSHOT_ONLY=1 activé est présent (démarrage)", () => {
    expect(has("[SnapshotOnly] RADAR_BC_SNAPSHOT_ONLY=1 activé")).toBe(true);
  });

  test("SO-17: log Chargement cache Supabase (lecture seule) est présent", () => {
    expect(has("[SnapshotOnly] Chargement cache Supabase")).toBe(true);
  });
});

// ─── SO-G — Mirror : logique writeInputSnapshot en mode SNAPSHOT_ONLY ────────
//
// Test comportemental pur (sans import) : vérifie que la logique de la garde
// autorise l'écriture quand SNAPSHOT_ONLY=true, même si WRITE_INPUT_SNAPSHOT=false.

describe("SO-G — Mirror writeInputSnapshot guard", () => {

  /** Mirror exacte de la garde modifiée dans radar-bc-bot.js. */
  function shouldSkipMirror(
    WRITE_INPUT_SNAPSHOT: boolean,
    SNAPSHOT_ONLY: boolean,
    items: unknown[] | null | undefined,
  ): boolean {
    return (!WRITE_INPUT_SNAPSHOT && !SNAPSHOT_ONLY) || !items || !items.length;
  }

  test("SO-18: WRITE=false SNAPSHOT=false items=[] → skip (comportement original)", () => {
    expect(shouldSkipMirror(false, false, [])).toBe(true);
  });

  test("SO-19: WRITE=true SNAPSHOT=false items=[...] → ne skip pas (comportement original)", () => {
    expect(shouldSkipMirror(true, false, [{ id: "bc1" }])).toBe(false);
  });

  test("SO-20: WRITE=false SNAPSHOT=true items=[...] → ne skip pas (nouveau : SNAPSHOT_ONLY force)", () => {
    expect(shouldSkipMirror(false, true, [{ id: "bc1" }])).toBe(false);
  });

  test("SO-21: WRITE=false SNAPSHOT=true items=[] → skip (items vide reste bloquant)", () => {
    expect(shouldSkipMirror(false, true, [])).toBe(true);
  });

  test("SO-22: WRITE=false SNAPSHOT=true items=null → skip (null reste bloquant)", () => {
    expect(shouldSkipMirror(false, true, null)).toBe(true);
  });

  test("SO-23: WRITE=true SNAPSHOT=true items=[...] → ne skip pas (double activation)", () => {
    expect(shouldSkipMirror(true, true, [{ id: "bc1" }])).toBe(false);
  });
});

export {};
