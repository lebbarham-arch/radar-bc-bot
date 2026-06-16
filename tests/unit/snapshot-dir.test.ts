/**
 * Tests unitaires — Snapshot directory configurability + route /api/snapshot/latest
 *
 * Couvre le patch feat/snapshot-dir :
 *   A. Résolution de SNAPSHOT_DIR / INPUT_SNAPSHOT_DIR selon RADAR_BC_SNAPSHOT_DIR
 *   B. Logs writeScanSnapshot (dir=, saved path=, latest=, ERREUR)
 *   C. Logs writeInputSnapshot (dir=, saved path=, latest=, ERREUR)
 *   D. Route GET /api/snapshot/latest (type=scan|input, 200, 400, 401, 404, 500)
 *
 * Aucune dépendance Puppeteer ni Supabase : toute la logique est mirrorée ici.
 *
 * Nomenclature : SD-N (Snapshot Dir) · SL-N (Snapshot Latest route)
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as http from "http";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Résout SNAPSHOT_DIR exactement comme le code prod. */
function resolveSnapshotDir(envValue: string | undefined, __dirname: string): { scan: string; input: string } {
  const base = envValue ? envValue : path.join(__dirname, "data");
  return {
    scan:  path.join(base, "scan-snapshots"),
    input: path.join(base, "input-snapshots"),
  };
}

interface WriteScanResult {
  logs: string[];
  files: string[];  // chemins écrits
  threw: boolean;
}

/**
 * Mirror de writeScanSnapshot — opère dans un dir temporaire.
 * Retourne les logs produits et les fichiers créés.
 */
function writeScanSnapshotMirror(
  rows: object[],
  radarType: string,
  snapshotDir: string,
  logs: string[],
  failWrite = false,
): void {
  if (!rows || rows.length === 0) return;
  try {
    if (failWrite) throw new Error("EACCES: permission denied");
    fs.mkdirSync(snapshotDir, { recursive: true });
    const ts     = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fname  = radarType + "-scan-" + ts + ".jsonl";
    const fpath  = path.join(snapshotDir, fname);
    const latest = path.join(snapshotDir, "latest-" + radarType + "-scan.jsonl");
    const content = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
    logs.push("[Snapshot] dir=" + snapshotDir);
    fs.writeFileSync(fpath,   content, "utf8");
    fs.writeFileSync(latest,  content, "utf8");
    logs.push("[Snapshot] saved path=" + fpath + " (" + rows.length + " lignes)");
    logs.push("[Snapshot] latest=" + latest);
  } catch (e: any) {
    logs.push("[Snapshot] ERREUR ecriture : " + e.message);
  }
}

/**
 * Mirror de writeInputSnapshot — opère dans un dir temporaire.
 */
function writeInputSnapshotMirror(
  items: object[],
  inputSnapshotDir: string,
  logs: string[],
  failWrite = false,
): void {
  if (!items || !items.length) return;
  try {
    if (failWrite) throw new Error("ENOENT: no such file or directory");
    fs.mkdirSync(inputSnapshotDir, { recursive: true });
    const ts     = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fname  = "bc-input-" + ts + ".jsonl";
    const fpath  = path.join(inputSnapshotDir, fname);
    const latest = path.join(inputSnapshotDir, "latest-bc-input.jsonl");
    const content = items.map(r => JSON.stringify(r)).join("\n") + "\n";
    logs.push("[InputSnapshot] dir=" + inputSnapshotDir);
    fs.writeFileSync(fpath,   content, "utf8");
    fs.writeFileSync(latest,  content, "utf8");
    logs.push("[InputSnapshot] saved path=" + fpath + " (" + items.length + " BCs)");
    logs.push("[InputSnapshot] latest=" + latest);
  } catch (e: any) {
    logs.push("[InputSnapshot] ERREUR ecriture : " + e.message);
  }
}

/**
 * Simule la route GET /api/snapshot/latest
 * Retourne { status, headers, body }
 */
interface RouteResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function snapshotLatestRoute(
  queryType: string | undefined,
  secret: string | undefined,
  adminSecret: string,
  scanDir: string,
  inputDir: string,
): RouteResult {
  // checkSecret
  if (secret !== adminSecret) {
    return { status: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Unauthorized" }) };
  }
  const type_ = queryType || "scan";
  let latestPath: string;
  if (type_ === "input") {
    latestPath = path.join(inputDir, "latest-bc-input.jsonl");
  } else if (type_ === "scan") {
    latestPath = path.join(scanDir, "latest-bc-scan.jsonl");
  } else {
    return { status: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Paramètre type invalide. Valeurs acceptées : scan | input" }) };
  }
  if (!fs.existsSync(latestPath)) {
    return {
      status: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Fichier introuvable",
        type: type_,
        path: latestPath,
        hint: type_ === "scan"
          ? "Aucun scan enregistré. Lancez un scan (POST /api/scan-now) ou vérifiez RADAR_BC_SNAPSHOT_DIR."
          : "WRITE_INPUT_SNAPSHOT non activé ou aucun scan effectué. Activez RADAR_BC_WRITE_INPUT_SNAPSHOT=1.",
      }),
    };
  }
  try {
    const stat    = fs.statSync(latestPath);
    const content = fs.readFileSync(latestPath, "utf8");
    return {
      status: 200,
      headers: {
        "Content-Type":        "application/x-ndjson; charset=utf-8",
        "Content-Disposition": 'attachment; filename="' + path.basename(latestPath) + '"',
        "X-Snapshot-Path":     latestPath,
        "X-Snapshot-Size":     String(stat.size),
        "X-Snapshot-Mtime":    stat.mtime.toISOString(),
      },
      body: content,
    };
  } catch (e: any) {
    return { status: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "Erreur lecture snapshot : " + e.message, path: latestPath }) };
  }
}

// ─── SD — Résolution du répertoire snapshot ──────────────────────────────────

describe("SD — Résolution SNAPSHOT_DIR / INPUT_SNAPSHOT_DIR", () => {

  test("SD-1: sans env → utilise __dirname/data comme base", () => {
    const dirs = resolveSnapshotDir(undefined, "/app");
    expect(dirs.scan).toBe(path.join("/app", "data", "scan-snapshots"));
    expect(dirs.input).toBe(path.join("/app", "data", "input-snapshots"));
  });

  test("SD-2: avec env=/tmp/radar-bc-snapshots → utilise env comme base", () => {
    const dirs = resolveSnapshotDir("/tmp/radar-bc-snapshots", "/app");
    expect(dirs.scan).toBe(path.join("/tmp/radar-bc-snapshots", "scan-snapshots"));
    expect(dirs.input).toBe(path.join("/tmp/radar-bc-snapshots", "input-snapshots"));
  });

  test("SD-3: env chaîne vide → traité comme absent → défaut __dirname/data", () => {
    // chaîne vide est falsy en JS — passer directement avec cast pour éviter TS2873
    const dirs = resolveSnapshotDir("" as string | undefined, "/app");
    expect(dirs.scan).toBe(path.join("/app", "data", "scan-snapshots"));
    expect(dirs.input).toBe(path.join("/app", "data", "input-snapshots"));
  });

  test("SD-4: env=/data/snapshots → sous-dossiers distincts scan vs input", () => {
    const dirs = resolveSnapshotDir("/data/snapshots", "/app");
    expect(dirs.scan).not.toBe(dirs.input);
    expect(dirs.scan).toContain("scan-snapshots");
    expect(dirs.input).toContain("input-snapshots");
  });

  test("SD-5: env change → SNAPSHOT_DIR ≠ chemin par défaut", () => {
    const defaultDirs = resolveSnapshotDir(undefined, "/app");
    const envDirs     = resolveSnapshotDir("/tmp/snapshots", "/app");
    expect(envDirs.scan).not.toBe(defaultDirs.scan);
    expect(envDirs.input).not.toBe(defaultDirs.input);
  });
});

// ─── SW — writeScanSnapshot logs ─────────────────────────────────────────────

describe("SW — writeScanSnapshot logs", () => {

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("SW-1: log [Snapshot] dir= avant écriture", () => {
    const logs: string[] = [];
    writeScanSnapshotMirror([{ id: "bc1" }], "bc", tmpDir, logs);
    expect(logs[0]).toBe("[Snapshot] dir=" + tmpDir);
  });

  test("SW-2: log [Snapshot] saved path= avec chemin absolu et nombre de lignes", () => {
    const logs: string[] = [];
    writeScanSnapshotMirror([{ id: "bc1" }, { id: "bc2" }], "bc", tmpDir, logs);
    const savedLog = logs.find(l => l.startsWith("[Snapshot] saved path="));
    expect(savedLog).toBeDefined();
    expect(savedLog).toContain("(2 lignes)");
    expect(savedLog).toContain(tmpDir);
    expect(savedLog).toContain("bc-scan-");
  });

  test("SW-3: log [Snapshot] latest= avec chemin absolu", () => {
    const logs: string[] = [];
    writeScanSnapshotMirror([{ id: "bc1" }], "bc", tmpDir, logs);
    const latestLog = logs.find(l => l.startsWith("[Snapshot] latest="));
    expect(latestLog).toBeDefined();
    expect(latestLog).toContain("latest-bc-scan.jsonl");
    expect(latestLog).toContain(tmpDir);
  });

  test("SW-4: ordre logs : dir= → saved path= → latest=", () => {
    const logs: string[] = [];
    writeScanSnapshotMirror([{ id: "bc1" }], "bc", tmpDir, logs);
    expect(logs).toHaveLength(3);
    expect(logs[0]).toContain("[Snapshot] dir=");
    expect(logs[1]).toContain("[Snapshot] saved path=");
    expect(logs[2]).toContain("[Snapshot] latest=");
  });

  test("SW-5: log [Snapshot] ERREUR si écriture impossible", () => {
    const logs: string[] = [];
    writeScanSnapshotMirror([{ id: "bc1" }], "bc", tmpDir, logs, /* failWrite= */ true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[Snapshot] ERREUR ecriture :");
    expect(logs[0]).toContain("permission denied");
  });

  test("SW-6: rows vide → aucun log, aucun fichier", () => {
    const logs: string[] = [];
    writeScanSnapshotMirror([], "bc", tmpDir, logs);
    expect(logs).toHaveLength(0);
    expect(fs.readdirSync(tmpDir)).toHaveLength(0);
  });

  test("SW-7: fichier latest-bc-scan.jsonl créé dans snapshotDir", () => {
    const logs: string[] = [];
    writeScanSnapshotMirror([{ id: "bc1" }], "bc", tmpDir, logs);
    const latest = path.join(tmpDir, "latest-bc-scan.jsonl");
    expect(fs.existsSync(latest)).toBe(true);
  });
});

// ─── IW — writeInputSnapshot logs ────────────────────────────────────────────

describe("IW — writeInputSnapshot logs", () => {

  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inputsnap-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("IW-1: log [InputSnapshot] dir= avant écriture", () => {
    const logs: string[] = [];
    writeInputSnapshotMirror([{ id: "bc1" }], tmpDir, logs);
    expect(logs[0]).toBe("[InputSnapshot] dir=" + tmpDir);
  });

  test("IW-2: log [InputSnapshot] saved path= avec chemin absolu et nombre de BCs", () => {
    const logs: string[] = [];
    writeInputSnapshotMirror([{ id: "bc1" }, { id: "bc2" }, { id: "bc3" }], tmpDir, logs);
    const savedLog = logs.find(l => l.startsWith("[InputSnapshot] saved path="));
    expect(savedLog).toBeDefined();
    expect(savedLog).toContain("(3 BCs)");
    expect(savedLog).toContain(tmpDir);
    expect(savedLog).toContain("bc-input-");
  });

  test("IW-3: log [InputSnapshot] latest= avec chemin absolu", () => {
    const logs: string[] = [];
    writeInputSnapshotMirror([{ id: "bc1" }], tmpDir, logs);
    const latestLog = logs.find(l => l.startsWith("[InputSnapshot] latest="));
    expect(latestLog).toBeDefined();
    expect(latestLog).toContain("latest-bc-input.jsonl");
  });

  test("IW-4: log [InputSnapshot] ERREUR si écriture impossible", () => {
    const logs: string[] = [];
    writeInputSnapshotMirror([{ id: "bc1" }], tmpDir, logs, /* failWrite= */ true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("[InputSnapshot] ERREUR ecriture :");
  });

  test("IW-5: items vide → aucun log", () => {
    const logs: string[] = [];
    writeInputSnapshotMirror([], tmpDir, logs);
    expect(logs).toHaveLength(0);
  });
});

// ─── SL — Route GET /api/snapshot/latest ────────────────────────────────────

describe("SL — Route GET /api/snapshot/latest", () => {

  const SECRET = "test-admin-secret";
  let scanDir: string;
  let inputDir: string;

  beforeEach(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "route-test-"));
    scanDir  = path.join(base, "scan-snapshots");
    inputDir = path.join(base, "input-snapshots");
    fs.mkdirSync(scanDir,  { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(scanDir), { recursive: true, force: true });
  });

  // ── Authentification ─────────────────────────────────────────────────────

  test("SL-1: secret manquant → 401", () => {
    const res = snapshotLatestRoute(undefined, undefined, SECRET, scanDir, inputDir);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error).toBe("Unauthorized");
  });

  test("SL-2: secret incorrect → 401", () => {
    const res = snapshotLatestRoute(undefined, "wrong-secret", SECRET, scanDir, inputDir);
    expect(res.status).toBe(401);
  });

  // ── Validation type ───────────────────────────────────────────────────────

  test("SL-3: type=invalid → 400", () => {
    const res = snapshotLatestRoute("foobar", SECRET, SECRET, scanDir, inputDir);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain("type invalide");
  });

  // ── Fichier absent ────────────────────────────────────────────────────────

  test("SL-4: type=scan, fichier absent → 404 avec hint scan", () => {
    const res = snapshotLatestRoute("scan", SECRET, SECRET, scanDir, inputDir);
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("introuvable");
    expect(body.hint).toContain("scan-now");
  });

  test("SL-5: type=input, fichier absent → 404 avec hint input", () => {
    const res = snapshotLatestRoute("input", SECRET, SECRET, scanDir, inputDir);
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.hint).toContain("RADAR_BC_WRITE_INPUT_SNAPSHOT");
  });

  test("SL-6: type absent (défaut scan), fichier absent → 404", () => {
    const res = snapshotLatestRoute(undefined, SECRET, SECRET, scanDir, inputDir);
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).type).toBe("scan");
  });

  // ── Fichier présent ───────────────────────────────────────────────────────

  test("SL-7: type=scan, fichier présent → 200 texte NDJSON", () => {
    const content = '{"id":"bc1","objet":"Test"}\n{"id":"bc2","objet":"Test 2"}\n';
    fs.writeFileSync(path.join(scanDir, "latest-bc-scan.jsonl"), content, "utf8");

    const res = snapshotLatestRoute("scan", SECRET, SECRET, scanDir, inputDir);
    expect(res.status).toBe(200);
    expect(res.headers["Content-Type"]).toContain("application/x-ndjson");
    expect(res.body).toBe(content);
  });

  test("SL-8: type=input, fichier présent → 200 texte NDJSON", () => {
    const content = '{"bc_id":"bc1","objet":"Input BC"}\n';
    fs.writeFileSync(path.join(inputDir, "latest-bc-input.jsonl"), content, "utf8");

    const res = snapshotLatestRoute("input", SECRET, SECRET, scanDir, inputDir);
    expect(res.status).toBe(200);
    expect(res.body).toBe(content);
  });

  test("SL-9: header Content-Disposition contient le nom de fichier", () => {
    fs.writeFileSync(path.join(scanDir, "latest-bc-scan.jsonl"), '{"id":"bc1"}\n', "utf8");
    const res = snapshotLatestRoute("scan", SECRET, SECRET, scanDir, inputDir);
    expect(res.headers["Content-Disposition"]).toContain("latest-bc-scan.jsonl");
  });

  test("SL-10: header X-Snapshot-Path contient le chemin absolu", () => {
    fs.writeFileSync(path.join(scanDir, "latest-bc-scan.jsonl"), '{"id":"bc1"}\n', "utf8");
    const res = snapshotLatestRoute("scan", SECRET, SECRET, scanDir, inputDir);
    const snapPath = res.headers["X-Snapshot-Path"]!;
    expect(snapPath).toContain("latest-bc-scan.jsonl");
    expect(path.isAbsolute(snapPath)).toBe(true);
  });

  test("SL-11: header X-Snapshot-Size est un entier positif", () => {
    const content = '{"id":"bc1"}\n';
    fs.writeFileSync(path.join(scanDir, "latest-bc-scan.jsonl"), content, "utf8");
    const res = snapshotLatestRoute("scan", SECRET, SECRET, scanDir, inputDir);
    const size = parseInt(res.headers["X-Snapshot-Size"]!, 10);
    expect(size).toBeGreaterThan(0);
    expect(size).toBe(Buffer.byteLength(content, "utf8"));
  });

  test("SL-12: contenu NDJSON parseable ligne par ligne", () => {
    const rows = [{ id: "bc1", objet: "Nettoyage" }, { id: "bc2", objet: "Entretien" }];
    const content = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
    fs.writeFileSync(path.join(scanDir, "latest-bc-scan.jsonl"), content, "utf8");

    const res = snapshotLatestRoute("scan", SECRET, SECRET, scanDir, inputDir);
    const parsed = res.body.trim().split("\n").map(l => JSON.parse(l));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].id).toBe("bc1");
    expect(parsed[1].id).toBe("bc2");
  });
});

export {};
