/**
 * tests/unit/analyze-learning-cli.test.ts
 *
 * Tests fonctionnels du CLI analyze-review-reason-learning.js (ALC-1..8).
 * Utilise spawnSync pour executer le script dans un dossier temporaire.
 *
 * Ce qui est teste :
 *   ALC-A  Acceptation des patterns de fichiers en mode dossier
 *   ALC-B  Non-regression sur review-candidates-*.json existant
 *   ALC-C  Deduplication et affichage du bilan d'ingestion
 *   ALC-D  Invariants structurels du script (sans execution)
 */

import * as fs   from "fs";
import * as path from "path";
import * as os   from "os";
import { spawnSync } from "child_process";

const SCRIPT_PATH = path.join(__dirname, "../../scripts/analyze-review-reason-learning.js");
const REPO_ROOT   = path.join(__dirname, "../..");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Cree un dossier temporaire pour la duree du test. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "alc-test-"));
}

/** Supprime recursivement un dossier temporaire. */
function rmTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** Fixture minimaliste human-review-decisions-for-learning. */
function makeHumanReviewDecisionsFixture(items: object[]): object {
  return {
    generated_at: "2026-01-01T00:00:00.000Z",
    source_file:  "test",
    model:        "test",
    totals:       { total: items.length, with_decision: items.length },
    records:      items,
  };
}

/** Fixture minimaliste review-candidates (format export shadow). */
function makeReviewCandidatesFixture(items: object[]): object {
  return {
    exported_at:      "2026-01-01T00:00:00.000Z",
    source_report:    "test",
    client_filter:    null,
    total_candidates: items.length,
    candidates:       items,
  };
}

/** Entree minimale avec decision. */
function makeEntry(bcId: string, client: string, decision = "reject"): object {
  return {
    bc_id:                "BC-" + bcId,
    client,
    decision,
    human_review_reason:  "bon_signal_mauvais_contexte",
    matched_signals:      ["hygiene"],
    ctx_context_key:      "medical_admin_context",
    ctx_learnable_context_hint: "medical_admin_context",
    ctx_profile_alignment:      "low",
    ctx_context_ambiguity:      "low",
    ctx_context_confidence:     "low",
    ctx_negative_context_terms: ["medico"],
    ctx_positive_context_terms: [],
    ctx_should_create_hint:     true,
    score:           5,
    signal_origin:   "inclusion",
    strength_reason: "signal_secondaire_unique",
  };
}

/** Execute le CLI avec un dossier et retourne { stdout, stderr, status }. */
function runCLI(dir: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    "node",
    [SCRIPT_PATH, dir],
    { encoding: "utf8", timeout: 15000, cwd: REPO_ROOT }
  );
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

// ── ALC-A -- Acceptation des patterns en mode dossier ────────────────────────

describe("ALC-A -- Acceptation human-review-decisions-for-learning-*.json en mode dossier", () => {

  let tmpDir = "";

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(()  => { rmTmpDir(tmpDir); });

  test("ALC-1: directory contenant uniquement human-review-decisions-for-learning-*.json -> exit 0", () => {
    const fixture = makeHumanReviewDecisionsFixture([
      makeEntry("001", "Client Test"),
      makeEntry("002", "Client Test"),
      makeEntry("003", "Client Test"),
    ]);
    const fname = path.join(tmpDir, "human-review-decisions-for-learning-2026-01-01T00-00-00.json");
    fs.writeFileSync(fname, JSON.stringify(fixture), "utf8");

    const { status, stdout } = runCLI(tmpDir);
    expect(status).toBe(0);
    expect(stdout).toContain("human-review-decisions-for-learning-2026-01-01T00-00-00.json");
  });

  test("ALC-2: stdout affiche '[lu]' pour le fichier human-review-decisions-for-learning-*.json", () => {
    const fixture = makeHumanReviewDecisionsFixture([makeEntry("001", "Client Test")]);
    const fname = path.join(tmpDir, "human-review-decisions-for-learning-2026-06-19T00-00-00.json");
    fs.writeFileSync(fname, JSON.stringify(fixture), "utf8");

    const { stdout } = runCLI(tmpDir);
    expect(stdout).toMatch(/\[lu\].*human-review-decisions-for-learning/);
  });

  test("ALC-3: directory ne contenant aucun fichier compatible -> exit non-zero", () => {
    // Fichier avec mauvais prefixe
    fs.writeFileSync(path.join(tmpDir, "autre-fichier.json"), "{}", "utf8");
    const { status } = runCLI(tmpDir);
    expect(status).not.toBe(0);
  });
});

// ── ALC-B -- Non-regression review-candidates-*.json ─────────────────────────

describe("ALC-B -- Non-regression review-candidates-*.json", () => {

  let tmpDir = "";

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(()  => { rmTmpDir(tmpDir); });

  test("ALC-4: directory contenant review-candidates-*.json -> exit 0", () => {
    const fixture = makeReviewCandidatesFixture([
      makeEntry("001", "Client Test"),
      makeEntry("002", "Client Test"),
      makeEntry("003", "Client Test"),
    ]);
    const fname = path.join(tmpDir, "review-candidates-2026-01-01T00-00-00.json");
    fs.writeFileSync(fname, JSON.stringify(fixture), "utf8");

    const { status } = runCLI(tmpDir);
    expect(status).toBe(0);
  });

  test("ALC-5: stdout affiche '[lu]' pour review-candidates-*.json", () => {
    const fixture = makeReviewCandidatesFixture([makeEntry("001", "Client Test")]);
    const fname = path.join(tmpDir, "review-candidates-2026-06-19T00-00-00.json");
    fs.writeFileSync(fname, JSON.stringify(fixture), "utf8");

    const { stdout } = runCLI(tmpDir);
    expect(stdout).toMatch(/\[lu\].*review-candidates/);
  });
});

// ── ALC-C -- Deduplication et bilan d'ingestion ───────────────────────────────

describe("ALC-C -- Deduplication et affichage bilan", () => {

  let tmpDir = "";

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(()  => { rmTmpDir(tmpDir); });

  test("ALC-6: deux fichiers avec le meme bc_id -> doublons elimines > 0 dans stdout", () => {
    // Fichier 1 : review-candidates avec BC-001, BC-002
    const f1 = makeReviewCandidatesFixture([
      makeEntry("001", "Client Test"),
      makeEntry("002", "Client Test"),
    ]);
    // Fichier 2 : human-review avec BC-001 (doublon) + BC-003 (nouveau)
    const f2 = makeHumanReviewDecisionsFixture([
      makeEntry("001", "Client Test"),
      makeEntry("003", "Client Test"),
    ]);
    fs.writeFileSync(
      path.join(tmpDir, "review-candidates-2026-01-01T00-00-00.json"),
      JSON.stringify(f1), "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "human-review-decisions-for-learning-2026-01-02T00-00-00.json"),
      JSON.stringify(f2), "utf8"
    );

    const { status, stdout } = runCLI(tmpDir);
    expect(status).toBe(0);
    // Le bilan [dedup] doit indiquer 1 doublon
    expect(stdout).toMatch(/\[dedup\].*doublons elimines=1/);
  });

  test("ALC-7: stdout affiche entrees brutes et utilisees dans [dedup]", () => {
    const f1 = makeReviewCandidatesFixture([makeEntry("001", "Client Test")]);
    const f2 = makeHumanReviewDecisionsFixture([makeEntry("002", "Client Test")]);
    fs.writeFileSync(
      path.join(tmpDir, "review-candidates-2026-01-01T00-00-00.json"),
      JSON.stringify(f1), "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "human-review-decisions-for-learning-2026-01-02T00-00-00.json"),
      JSON.stringify(f2), "utf8"
    );

    const { stdout } = runCLI(tmpDir);
    // Doit afficher : entrees brutes=2  utilisees=2  doublons elimines=0
    expect(stdout).toMatch(/\[dedup\].*entrees brutes=2.*utilisees=2.*doublons elimines=0/);
  });

  test("ALC-8: aucun doublon si BC differents dans chaque fichier -> doublons=0", () => {
    const f1 = makeReviewCandidatesFixture([makeEntry("AAA", "Client Test")]);
    const f2 = makeHumanReviewDecisionsFixture([makeEntry("BBB", "Client Test")]);
    fs.writeFileSync(
      path.join(tmpDir, "review-candidates-2026-01-01T00-00-00.json"),
      JSON.stringify(f1), "utf8"
    );
    fs.writeFileSync(
      path.join(tmpDir, "human-review-decisions-for-learning-2026-01-02T00-00-00.json"),
      JSON.stringify(f2), "utf8"
    );

    const { stdout } = runCLI(tmpDir);
    expect(stdout).toMatch(/doublons elimines=0/);
  });
});

// ── ALC-D -- Invariants structurels du script ────────────────────────────────

describe("ALC-D -- Invariants structurels de analyze-review-reason-learning.js", () => {

  const src = fs.readFileSync(SCRIPT_PATH, "utf8");

  test("ALC-9: le script reference le pattern human-review-decisions-for-learning", () => {
    expect(src).toContain("human-review-decisions-for-learning");
  });

  test("ALC-10: le script appelle deduplicateEntries", () => {
    expect(src).toContain("deduplicateEntries");
  });

  test("ALC-11: le script affiche [dedup] dans stdout", () => {
    expect(src).toContain("[dedup]");
  });

  test("ALC-12: le script expose doublons elimines dans [dedup]", () => {
    expect(src).toContain("doublons elimines=");
  });

  test("ALC-13: le script ne modifie pas buildReviewReasonLearningReport (logique metier intacte)", () => {
    // Le require doit rester identique
    expect(src).toMatch(/require\(['"]\.\/review-reason-learning-report['"]\)/);
  });
});

export {};
