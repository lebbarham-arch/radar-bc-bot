/**
 * Tests structurels -- scripts\run-local-snapshot-review-cycle.ps1
 *
 * Pourquoi des tests Jest sur un script PowerShell ?
 * --------------------------------------------------
 * Jest ne peut pas executer du PS1 directement (pas de runtime PowerShell
 * dans le sandbox Linux/Node). Ces tests lisent le script comme texte et
 * verifient ses INVARIANTS DE SECURITE et sa structure, de la meme facon
 * que les tests SO-* verifient radar-bc-bot.js comme texte.
 *
 * Ce qui est teste :
 *   RLC-A  Securite interdite : fly, git add, git commit, git push absents
 *   RLC-B  Variables interdites : RADAR_BC_MATCH_SHADOW, RADAR_BC_SHADOW_ACTIVE absentes
 *   RLC-C  Gardes de demarrage : check git status + check port 3000
 *   RLC-D  Variables obligatoires : RADAR_BC_SNAPSHOT_ONLY definie et nettoyee
 *   RLC-E  Structure du cycle : 6 etapes, noeuds cles presents
 *   RLC-F  Nettoyage post-scan et garanties de securite
 *   RLC-G  Encodage ASCII strict (pas de caracteres corrompus)
 *   RLC-H  Parsing PowerShell reel (si powershell.exe disponible)
 *
 * Nomenclature : RLC-N (Run Local Cycle)
 */

import * as fs       from "fs";
import * as path     from "path";
import { spawnSync } from "child_process";

const PS1_PATH = path.join(__dirname, "../../scripts/run-local-snapshot-review-cycle.ps1");

const PS1_SRC = fs.readFileSync(PS1_PATH, "utf8");

/**
 * Source PS1 sans les blocs commentaires <# ... #> (synopsis/description).
 * Les tests de securite sur les commandes interdites portent sur le CODE,
 * pas sur la documentation qui cite ces commandes pour les interdire.
 */
const PS1_CODE = PS1_SRC.replace(/<#[\s\S]*?#>/g, "");

function has(needle: string): boolean {
  return PS1_SRC.includes(needle);
}

function hasI(needle: string): boolean {
  return PS1_SRC.toLowerCase().includes(needle.toLowerCase());
}

/** Cherche needle dans le CODE uniquement (hors blocs <# ... #>). */
function hasCode(needle: string): boolean {
  return PS1_CODE.includes(needle);
}

function hasCodeI(needle: string): boolean {
  return PS1_CODE.toLowerCase().includes(needle.toLowerCase());
}

// ─── RLC-A -- Commandes interdites ───────────────────────────────────────────

describe("RLC-A -- Commandes interdites absentes du script", () => {

  test("RLC-1: le code PS1 ne contient pas d'appel a fly (hors documentation)", () => {
    const lines = PS1_CODE.split("\n").filter(l => !l.trim().startsWith("#"));
    const flyLines = lines.filter(l => /\bfly\b/.test(l));
    expect(flyLines).toHaveLength(0);
  });

  test("RLC-2: le code PS1 ne contient pas 'git add'", () => {
    expect(hasCodeI("git add")).toBe(false);
  });

  test("RLC-3: le code PS1 ne contient pas 'git commit'", () => {
    expect(hasCodeI("git commit")).toBe(false);
  });

  test("RLC-4: le code PS1 ne contient pas 'git push'", () => {
    expect(hasCodeI("git push")).toBe(false);
  });

  test("RLC-5: le code PS1 ne contient pas 'git reset'", () => {
    expect(hasCodeI("git reset")).toBe(false);
  });
});

// ─── RLC-B -- Variables prod interdites ──────────────────────────────────────

describe("RLC-B -- Variables prod interdites non definies", () => {

  test("RLC-6: RADAR_BC_MATCH_SHADOW n'est jamais assigne (=)", () => {
    const assignLines = PS1_SRC.split("\n").filter(l =>
      /RADAR_BC_MATCH_SHADOW\s*=\s*["']?1["']?/.test(l)
    );
    expect(assignLines).toHaveLength(0);
  });

  test("RLC-7: RADAR_BC_SHADOW_ACTIVE n'est jamais assigne (=)", () => {
    const assignLines = PS1_SRC.split("\n").filter(l =>
      /RADAR_BC_SHADOW_ACTIVE\s*=\s*["']?1["']?/.test(l)
    );
    expect(assignLines).toHaveLength(0);
  });

  test("RLC-8: RADAR_BC_MATCH_SHADOW est explicitement supprime (Remove-Item)", () => {
    expect(has("RADAR_BC_MATCH_SHADOW")).toBe(true);
    expect(PS1_SRC).toMatch(/Remove-Item.*RADAR_BC_MATCH_SHADOW/);
  });

  test("RLC-9: RADAR_BC_SHADOW_ACTIVE est explicitement supprime (Remove-Item)", () => {
    expect(has("RADAR_BC_SHADOW_ACTIVE")).toBe(true);
    expect(PS1_SRC).toMatch(/Remove-Item.*RADAR_BC_SHADOW_ACTIVE/);
  });
});

// ─── RLC-C -- Gardes de demarrage ────────────────────────────────────────────

describe("RLC-C -- Gardes obligatoires de demarrage", () => {

  test("RLC-10: git status --short est present (check git)", () => {
    expect(has("git status --short")).toBe(true);
  });

  test("RLC-11: le check git status est conditionnel (-AllowDirty)", () => {
    expect(has("AllowDirty")).toBe(true);
    const gitCheckPos   = PS1_SRC.indexOf("git status --short");
    const allowDirtyPos = PS1_SRC.indexOf("AllowDirty");
    expect(gitCheckPos).toBeGreaterThan(-1);
    expect(allowDirtyPos).toBeGreaterThan(-1);
  });

  test("RLC-12: le check port 3000 est present", () => {
    expect(has("3000")).toBe(true);
    const hasTcp = has("Test-NetConnection") || has("TcpClient");
    expect(hasTcp).toBe(true);
  });

  test("RLC-13: le code PS1 echoue (Write-Fail) si port occupe", () => {
    const portVarPos = PS1_CODE.indexOf("$PortOccupe");
    expect(portVarPos).toBeGreaterThan(-1);
    const failAfter = PS1_CODE.slice(portVarPos, portVarPos + 1500);
    expect(failAfter).toMatch(/Write-Fail/);
  });

  test("RLC-14: le parametre -SkipScan est declare", () => {
    expect(has("SkipScan")).toBe(true);
  });
});

// ─── RLC-D -- Variable SNAPSHOT_ONLY correctement geree ──────────────────────

describe("RLC-D -- RADAR_BC_SNAPSHOT_ONLY definie et nettoyee", () => {

  test("RLC-15: RADAR_BC_SNAPSHOT_ONLY est assigne a '1' pour le scan", () => {
    expect(PS1_SRC).toMatch(/RADAR_BC_SNAPSHOT_ONLY\s*=\s*["']?1["']?/);
  });

  test("RLC-16: RADAR_BC_SNAPSHOT_ONLY est supprime apres le scan (Remove-Item)", () => {
    expect(PS1_SRC).toMatch(/Remove-Item.*RADAR_BC_SNAPSHOT_ONLY/);
  });

  test("RLC-17: la suppression est dans un bloc finally (nettoyage garanti)", () => {
    const finallyPos = PS1_SRC.indexOf("finally");
    const removePos  = PS1_SRC.indexOf("Remove-Item Env:\\RADAR_BC_SNAPSHOT_ONLY");
    expect(finallyPos).toBeGreaterThan(-1);
    expect(removePos).toBeGreaterThan(-1);
    expect(removePos).toBeGreaterThan(finallyPos);
  });

  test("RLC-18: node radar-bc-bot.js est lance avec Tee-Object (log + console)", () => {
    expect(has("node radar-bc-bot.js")).toBe(true);
    expect(has("Tee-Object")).toBe(true);
  });
});

// ─── RLC-E -- Structure du cycle ─────────────────────────────────────────────

describe("RLC-E -- Structure des 6 etapes du cycle", () => {

  test("RLC-19: etape 1 -- git status presente (ASCII sans accent)", () => {
    // Script en ASCII strict : Etape sans accent
    expect(PS1_SRC).toMatch(/Etape 1.*git status/i);
  });

  test("RLC-20: etape 2 -- verification port presente", () => {
    expect(PS1_SRC).toMatch(/Etape 2.*port/i);
  });

  test("RLC-21: etape 3 -- scan snapshot presente", () => {
    expect(PS1_SRC).toMatch(/Etape 3.*[Ss]napshot/);
  });

  test("RLC-22: etape 4 -- identification dernier snapshot presente", () => {
    expect(PS1_SRC).toMatch(/Etape 4/);
    expect(has("bc-input-*.jsonl")).toBe(true);
  });

  test("RLC-23: etape 5 -- replay shadow presente", () => {
    expect(PS1_SRC).toMatch(/Etape 5.*[Rr]eplay/);
    expect(has("replay-shadow-from-input-snapshot.js")).toBe(true);
  });

  test("RLC-24: etape 6 -- analyse shadow presente", () => {
    expect(PS1_SRC).toMatch(/Etape 6.*[Aa]nalys/);
    expect(has("analyze-shadow-report.js")).toBe(true);
  });

  test("RLC-25: --export-review-csv est passe a analyze-shadow-report.js", () => {
    expect(has("--export-review-csv")).toBe(true);
  });

  test("RLC-26: --review-reason-hints est passe a analyze-shadow-report.js si hints presents", () => {
    expect(has("--review-reason-hints")).toBe(true);
    expect(has("review-reason-hint-candidates-approved-")).toBe(true);
  });
});

// ─── RLC-F -- Nettoyage et securite finale ───────────────────────────────────

describe("RLC-F -- Nettoyage et garanties de securite", () => {

  test("RLC-27: git status --short est affiche en fin de cycle", () => {
    const occurrences = (PS1_SRC.match(/git status --short/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  test("RLC-28: le script affiche aucun commit et aucun push en conclusion", () => {
    expect(hasCodeI("aucun commit")).toBe(true);
    expect(hasCodeI("aucun push")).toBe(true);
  });

  test("RLC-29: le log file est nomme snapshot-only-full-<timestamp>", () => {
    expect(has("snapshot-only-full-")).toBe(true);
    expect(has("logs")).toBe(true);
  });

  test("RLC-30: -AllowDirty est un [switch] PS1 (pas un booleen libre)", () => {
    expect(PS1_SRC).toMatch(/\[switch\]\$AllowDirty/);
  });

  test("RLC-31: -SkipScan est un [switch] PS1", () => {
    expect(PS1_SRC).toMatch(/\[switch\]\$SkipScan/);
  });

  test("RLC-32: -ClientFilter est declare avec type string dans param()", () => {
    expect(has("[string]$ClientFilter")).toBe(true);
  });
});

// ─── RLC-G -- Encodage ASCII strict ──────────────────────────────────────────

describe("RLC-G -- Encodage ASCII strict (pas de caracteres non-ASCII)", () => {

  test("RLC-33: le fichier PS1 ne contient aucun octet non-ASCII (> 0x7F)", () => {
    const rawBytes = fs.readFileSync(PS1_PATH);
    const nonAsciiOffsets: number[] = [];
    for (let i = 0; i < rawBytes.length; i++) {
      if ((rawBytes[i] ?? 0) > 0x7f) { nonAsciiOffsets.push(i); }
    }
    if (nonAsciiOffsets.length > 0) {
      const samples = nonAsciiOffsets.slice(0, 5).map(idx => {
        const byte = rawBytes[idx] ?? 0;
        const ctx  = rawBytes.slice(Math.max(0, idx - 10), idx + 10).toString("latin1");
        return `offset ${idx} (0x${byte.toString(16)}): ...${ctx}...`;
      });
      throw new Error(
        `${nonAsciiOffsets.length} octet(s) non-ASCII detectes :\n${samples.join("\n")}`
      );
    }
    expect(nonAsciiOffsets).toHaveLength(0);
  });

  test("RLC-34: pas de sequences de corruption UTF-8 visibles (a-tilde, A-tilde)", () => {
    const rawLatin = fs.readFileSync(PS1_PATH).toString("latin1");
    expect(rawLatin.includes("\xE2")).toBe(false);
    expect(rawLatin.includes("\xC3")).toBe(false);
  });

  test("RLC-35: pas de fleche Unicode (U+2192) -- seulement la fleche ASCII ->", () => {
    const arrowU = "\u2192";
    expect(PS1_SRC.includes(arrowU)).toBe(false);
    expect(has("->")).toBe(true);
  });

  test("RLC-36: les helpers Write-Ok/Write-Warn/Write-Fail utilisent [OK]/[WARN]/[FAIL] ASCII", () => {
    expect(has("[OK]")).toBe(true);
    expect(has("[WARN]")).toBe(true);
    expect(has("[FAIL]")).toBe(true);
  });
});

// --- RLC-I -- Metriques depuis JSON (ConvertFrom-Json) ---

describe("RLC-I -- Metriques du resume extraites depuis le rapport JSON", () => {

  test("RLC-38: le script utilise ConvertFrom-Json pour lire le rapport shadow", () => {
    expect(has("ConvertFrom-Json")).toBe(true);
  });

  test("RLC-39: les cles JSON attendues sont referencees (summary + clients)", () => {
    expect(has("summary")).toBe(true);
    expect(has("total_legacy_matches")).toBe(true);
    expect(has("total_clean_matches")).toBe(true);
    expect(has("total_legacy_only")).toBe(true);
    expect(has("total_clean_only")).toBe(true);
    expect(has("fp_rate_pct")).toBe(true);
    expect(has("clean_auto_notify_candidates")).toBe(true);
    expect(has("clean_review_candidates")).toBe(true);
  });

  test("RLC-40: fallback n/a si cle absente (pas de '?')", () => {
    // Le script ne doit plus utiliser "?" comme valeur par defaut
    // Les fallbacks doivent etre "n/a"
    const metricBlock = PS1_CODE.slice(
      PS1_CODE.indexOf("Metriques extraites directement"),
      PS1_CODE.indexOf("git status --short (fin de cycle)")
    );
    expect(metricBlock.includes('"n/a"')).toBe(true);
    // L'ancienne valeur "?" ne doit plus etre utilisee comme fallback
    expect(metricBlock.includes('else { "?" }')).toBe(false);
  });

  test("RLC-41: la lecture est dans un bloc try/catch (pas de plantage si JSON invalide)", () => {
    const tryPos   = PS1_SRC.lastIndexOf("try {");
    const catchPos = PS1_SRC.lastIndexOf("} catch {");
    expect(tryPos).toBeGreaterThan(-1);
    expect(catchPos).toBeGreaterThan(tryPos);
    // Le catch doit appeler Write-Warn
    const catchBlock = PS1_SRC.slice(catchPos, catchPos + 200);
    expect(catchBlock).toMatch(/Write-Warn/);
  });
});

// --- RLC-H -- Parsing PowerShell reel ---

describe("RLC-H -- Parsing PowerShell reel (si powershell disponible)", () => {

  test("RLC-37: le script parse sans erreur via powershell.exe ou pwsh", () => {
    const candidates = ["powershell.exe", "pwsh", "powershell"];
    let ps: string | null = null;
    for (const bin of candidates) {
      const probe = spawnSync(bin, ["-NoProfile", "-Command", "exit 0"], {
        timeout: 5000,
        stdio: "pipe",
      });
      if (probe.status === 0) { ps = bin; break; }
    }
    if (!ps) {
      console.log("  [SKIP RLC-37] powershell/pwsh non disponible -- test de parsing ignore");
      return;
    }
    const ps1PathFwd = PS1_PATH.replace(/\\/g, "/");
    const parseCmd = [
      "=;=;",
      "[System.Management.Automation.Language.Parser]::ParseFile('" + ps1PathFwd + "',[ref],[ref]) | Out-Null;",
      "if (.Count -gt 0) {  | ForEach-Object { Write-Host /sessions/dazzling-relaxed-wozniak/mnt/projet_claude/radar-bc-bot-clean-2.Message }; exit 1 }",
      "else { Write-Host 'PS1 parse OK' }",
    ].join(" ");
    const result = spawnSync(ps, [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", parseCmd,
    ], { timeout: 15000, encoding: "utf8" });
    const stdout = (result.stdout || "").trim();
    const stderr = (result.stderr || "").trim();
    if (result.status !== 0) {
      throw new Error(
        "Parsing PowerShell echoue (exit " + result.status + "):\nSTDOUT: " + stdout + "\nSTDERR: " + stderr
      );
    }
    expect(stdout).toMatch(/PS1 parse OK/);
  });
});

export {};
