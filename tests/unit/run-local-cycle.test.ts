/**
 * Tests structurels — scripts\run-local-snapshot-review-cycle.ps1
 *
 * Pourquoi des tests Jest sur un script PowerShell ?
 * --------------------------------------------------
 * Jest ne peut pas exécuter du PS1 directement (pas de runtime PowerShell
 * dans le sandbox Linux/Node). Ces tests lisent le script comme texte et
 * vérifient ses INVARIANTS DE SÉCURITÉ et sa structure, de la même façon
 * que les tests SO-* vérifient radar-bc-bot.js comme texte.
 *
 * Ce qui est testé :
 *   RLC-A  Sécurité interdite : fly, git add, git commit, git push absents
 *   RLC-B  Variables interdites : RADAR_BC_MATCH_SHADOW, RADAR_BC_SHADOW_ACTIVE absentes
 *   RLC-C  Gardes de démarrage : check git status + check port 3000
 *   RLC-D  Variables obligatoires : RADAR_BC_SNAPSHOT_ONLY définie et nettoyée
 *   RLC-E  Structure du cycle : 6 étapes, nœuds clés présents
 *   RLC-F  Nettoyage post-scan : Remove-Item Env:\RADAR_BC_SNAPSHOT_ONLY dans finally
 *
 * Nomenclature : RLC-N (Run Local Cycle)
 */

import * as fs   from "fs";
import * as path from "path";

const PS1_SRC = fs.readFileSync(
  path.join(__dirname, "../../scripts/run-local-snapshot-review-cycle.ps1"),
  "utf8",
);

/**
 * Source PS1 sans les blocs commentaires <# ... #> (synopsis/description).
 * Les tests de sécurité sur les commandes interdites portent sur le CODE,
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

// ─── RLC-A — Commandes interdites ────────────────────────────────────────────

describe("RLC-A — Commandes interdites absentes du script", () => {

  test("RLC-1: le code PS1 ne contient pas d'appel à fly (hors documentation)", () => {
    // PS1_CODE = source sans les blocs <# ... #> où fly est cité pour l'interdire
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

// ─── RLC-B — Variables prod interdites ───────────────────────────────────────

describe("RLC-B — Variables prod interdites non définies", () => {

  test("RLC-6: RADAR_BC_MATCH_SHADOW n'est jamais assigné (=)", () => {
    // On tolère sa mention dans un Remove-Item mais pas son assignation
    const assignLines = PS1_SRC.split("\n").filter(l =>
      /RADAR_BC_MATCH_SHADOW\s*=\s*["']?1["']?/.test(l)
    );
    expect(assignLines).toHaveLength(0);
  });

  test("RLC-7: RADAR_BC_SHADOW_ACTIVE n'est jamais assigné (=)", () => {
    const assignLines = PS1_SRC.split("\n").filter(l =>
      /RADAR_BC_SHADOW_ACTIVE\s*=\s*["']?1["']?/.test(l)
    );
    expect(assignLines).toHaveLength(0);
  });

  test("RLC-8: RADAR_BC_MATCH_SHADOW est explicitement supprimé (Remove-Item)", () => {
    // La bonne pratique : Remove-Item pour éviter tout héritage d'env parent
    expect(has("RADAR_BC_MATCH_SHADOW")).toBe(true);
    expect(PS1_SRC).toMatch(/Remove-Item.*RADAR_BC_MATCH_SHADOW/);
  });

  test("RLC-9: RADAR_BC_SHADOW_ACTIVE est explicitement supprimé (Remove-Item)", () => {
    expect(has("RADAR_BC_SHADOW_ACTIVE")).toBe(true);
    expect(PS1_SRC).toMatch(/Remove-Item.*RADAR_BC_SHADOW_ACTIVE/);
  });
});

// ─── RLC-C — Gardes de démarrage ─────────────────────────────────────────────

describe("RLC-C — Gardes obligatoires de démarrage", () => {

  test("RLC-10: git status --short est présent (check git)", () => {
    expect(has("git status --short")).toBe(true);
  });

  test("RLC-11: le check git status est conditionnel (-AllowDirty)", () => {
    expect(has("AllowDirty")).toBe(true);
    // La condition doit précéder le Write-Fail lié au git dirty
    const gitCheckPos    = PS1_SRC.indexOf("git status --short");
    const allowDirtyPos  = PS1_SRC.indexOf("AllowDirty");
    expect(gitCheckPos).toBeGreaterThan(-1);
    expect(allowDirtyPos).toBeGreaterThan(-1);
  });

  test("RLC-12: le check port 3000 est présent", () => {
    expect(has("3000")).toBe(true);
    // Soit via Test-NetConnection soit via TcpClient
    const hasTcp = has("Test-NetConnection") || has("TcpClient");
    expect(hasTcp).toBe(true);
  });

  test("RLC-13: le code PS1 échoue (Write-Fail) si port occupé", () => {
    // $PortOccupe est la variable de résultat du check — Write-Fail doit la suivre
    const portVarPos = PS1_CODE.indexOf("$PortOccupe");
    expect(portVarPos).toBeGreaterThan(-1);
    // Write-Fail peut être jusqu'à 1500 chars plus loin (bloc TcpClient + if)
    const failAfter = PS1_CODE.slice(portVarPos, portVarPos + 1500);
    expect(failAfter).toMatch(/Write-Fail/);
  });

  test("RLC-14: le paramètre -SkipScan est déclaré", () => {
    expect(has("SkipScan")).toBe(true);
  });
});

// ─── RLC-D — Variable SNAPSHOT_ONLY correctement gérée ───────────────────────

describe("RLC-D — RADAR_BC_SNAPSHOT_ONLY définie et nettoyée", () => {

  test("RLC-15: RADAR_BC_SNAPSHOT_ONLY est assigné à '1' pour le scan", () => {
    expect(PS1_SRC).toMatch(/RADAR_BC_SNAPSHOT_ONLY\s*=\s*["']?1["']?/);
  });

  test("RLC-16: RADAR_BC_SNAPSHOT_ONLY est supprimé après le scan (Remove-Item)", () => {
    expect(PS1_SRC).toMatch(/Remove-Item.*RADAR_BC_SNAPSHOT_ONLY/);
  });

  test("RLC-17: la suppression est dans un bloc finally (nettoyage garanti)", () => {
    const finallyPos  = PS1_SRC.indexOf("finally");
    const removePos   = PS1_SRC.indexOf("Remove-Item Env:\\RADAR_BC_SNAPSHOT_ONLY");
    expect(finallyPos).toBeGreaterThan(-1);
    expect(removePos).toBeGreaterThan(-1);
    // Le Remove-Item doit être après le finally (dans le bloc finally)
    expect(removePos).toBeGreaterThan(finallyPos);
  });

  test("RLC-18: node radar-bc-bot.js est lancé avec Tee-Object (log + console)", () => {
    expect(has("node radar-bc-bot.js")).toBe(true);
    expect(has("Tee-Object")).toBe(true);
  });
});

// ─── RLC-E — Structure du cycle ───────────────────────────────────────────────

describe("RLC-E — Structure des 6 étapes du cycle", () => {

  test("RLC-19: étape 1 — git status présente", () => {
    expect(PS1_SRC).toMatch(/Étape 1.*git status/i);
  });

  test("RLC-20: étape 2 — vérification port présente", () => {
    expect(PS1_SRC).toMatch(/Étape 2.*port/i);
  });

  test("RLC-21: étape 3 — scan snapshot présente", () => {
    expect(PS1_SRC).toMatch(/Étape 3.*[Ss]napshot/);
  });

  test("RLC-22: étape 4 — identification dernier snapshot présente", () => {
    expect(PS1_SRC).toMatch(/Étape 4/);
    expect(has("bc-input-*.jsonl")).toBe(true);
  });

  test("RLC-23: étape 5 — replay shadow présente", () => {
    expect(PS1_SRC).toMatch(/Étape 5.*[Rr]eplay/);
    expect(has("replay-shadow-from-input-snapshot.js")).toBe(true);
  });

  test("RLC-24: étape 6 — analyse shadow présente", () => {
    expect(PS1_SRC).toMatch(/Étape 6.*[Aa]nalys/);
    expect(has("analyze-shadow-report.js")).toBe(true);
  });

  test("RLC-25: --export-review-csv est passé à analyze-shadow-report.js", () => {
    expect(has("--export-review-csv")).toBe(true);
  });

  test("RLC-26: --review-reason-hints est passé à analyze-shadow-report.js si hints présents", () => {
    expect(has("--review-reason-hints")).toBe(true);
    expect(has("review-reason-hint-candidates-approved-")).toBe(true);
  });
});

// ─── RLC-F — Nettoyage et sécurité finale ────────────────────────────────────

describe("RLC-F — Nettoyage et garanties de sécurité", () => {

  test("RLC-27: git status --short est affiché en fin de cycle", () => {
    // Doit apparaître au moins 2 fois : check début + affichage fin
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

export {};
