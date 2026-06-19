/**
 * tests/unit/review-csv-profile.test.ts
 * Tests GD-044 -- Colonnes profil enrichi dans le CSV review.
 *
 * analyze-shadow-report.js n'est pas require()'able.
 * On teste buildReviewCsv() et la propagation ctx_client_* via miroir inline.
 *
 * Groupes :
 *   RCP-A  En-tete CSV : les 6 colonnes profil sont presentes
 *   RCP-B  Serialisation : arrays -> cellule CSV jointe par ", "
 *   RCP-C  Colonnes vides si ctx_client_* absents ou vides
 *   RCP-D  Invariants : colonnes de base inchangees, decision toujours presente
 */

// -- Miroir de csvCell() et buildReviewCsv() -- analyze-shadow-report.js --

function csvCell(v: unknown): string {
  var s = v == null ? "" : String(v);
  if (s.includes(";") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '"') + '"';
  }
  return s;
}

/** Miroir partiel de buildReviewCsv() -- GD-044.
 *  On teste uniquement la logique des colonnes profil enrichi.
 */
function buildReviewCsv(candidates: Record<string, unknown>[]): string {
  var BOM = "\uFEFF";
  var SEP = ";";
  var COLS = [
    "client","bc_id","score","signal_origin","matched_signals",
    "strength_reason","weak_single_signal","clean_text_excerpt",
    "ai_explanation","ai_confidence","ai_suggested_decision",
    "ctx_profile_alignment","ctx_context_ambiguity","ctx_context_confidence",
    "ctx_positive_context_terms","ctx_negative_context_terms",
    "ctx_learnable_context_hint","ctx_should_create_hint",
    "human_review_reason","human_review_reason_label",
    "human_review_comment","allowed_review_reason_codes",
    "rrh_applied","rrh_action","rrh_ids","rrh_explanation",
    // Diagnostic profil structurel (GD-040)
    "client_sectors","client_service_types","client_target_orgs",
    "client_exclusions","client_products","client_specs",
    "decision",
  ];
  var lines: string[] = [BOM + COLS.join(SEP)];
  candidates.forEach(function(e) {
    var sigs = Array.isArray(e.matched_signals)
      ? (e.matched_signals as string[]).filter(function(s) { return s.indexOf("bloque(") === -1; }).join(", ")
      : (e.matched_signals || "");
    var row = [
      csvCell(e.client || ""),
      csvCell(e.bc_id  || ""),
      csvCell(e.clean_score != null ? e.clean_score : ""),
      csvCell(e.signal_origin || ""),
      csvCell(sigs),
      csvCell(e.strength_reason || ""),
      csvCell(e.weak_single_signal ? "oui" : ""),
      csvCell((e.clean_text_excerpt as string || "").replace(/[\r\n]+/g, " ").trim()),
      csvCell((e.ai_review_explanation as string || "").replace(/[\r\n]+/g, " ").trim()),
      csvCell(e.ai_confidence || ""),
      csvCell(e.ai_suggested_decision || "review"),
      csvCell(e.ctx_profile_alignment || ""),
      csvCell(e.ctx_context_ambiguity || ""),
      csvCell(e.ctx_context_confidence || ""),
      csvCell(Array.isArray(e.ctx_positive_context_terms) ? (e.ctx_positive_context_terms as string[]).join(", ") : ""),
      csvCell(Array.isArray(e.ctx_negative_context_terms) ? (e.ctx_negative_context_terms as string[]).join(", ") : ""),
      csvCell((e.ctx_learnable_context_hint as string || "").replace(/[\r\n]+/g, " ").trim()),
      csvCell(e.ctx_should_create_context_hint ? "oui" : ""),
      csvCell(e.human_review_reason || ""),
      csvCell(e.human_review_reason_label || ""),
      csvCell((e.human_review_comment as string || "").replace(/[\r\n]+/g, " ").trim()),
      csvCell(Array.isArray(e.allowed_review_reasons)
        ? (e.allowed_review_reasons as Array<{code: string}>).map(function(r) { return r.code; }).join("|")
        : ""),
      csvCell(e.review_reason_hint_applied ? "oui" : ""),
      csvCell(e.review_reason_hint_action || ""),
      csvCell(Array.isArray(e.review_reason_hint_ids) ? (e.review_reason_hint_ids as string[]).join("|") : (e.review_reason_hint_ids || "")),
      csvCell((e.review_reason_hint_explanation as string || "").replace(/[\r\n]+/g, " ").trim()),
      // Profil enrichi (GD-040)
      csvCell(Array.isArray(e.ctx_client_sectors)       ? (e.ctx_client_sectors as string[]).join(", ")       : ""),
      csvCell(Array.isArray(e.ctx_client_service_types) ? (e.ctx_client_service_types as string[]).join(", ") : ""),
      csvCell(Array.isArray(e.ctx_client_target_orgs)   ? (e.ctx_client_target_orgs as string[]).join(", ")   : ""),
      csvCell(Array.isArray(e.ctx_client_exclusions)    ? (e.ctx_client_exclusions as string[]).join(", ")    : ""),
      csvCell(Array.isArray(e.ctx_client_products)      ? (e.ctx_client_products as string[]).join(", ")      : ""),
      csvCell(Array.isArray(e.ctx_client_specs)         ? (e.ctx_client_specs as string[]).join(", ")         : ""),
      csvCell(""),   // decision : vide pour saisie humaine
    ];
    lines.push(row.join(SEP));
  });
  return lines.join("\r\n");
}

// -- Helpers --

function parseHeader(csv: string): string[] {
  // Premiere ligne (sans BOM)
  var firstLine = csv.split("\r\n")[0]!.replace(/^\uFEFF/, "");
  return firstLine.split(";");
}

function parseRow(csv: string, rowIdx: number): string[] {
  // rowIdx=1 = premiere ligne de donnees
  return csv.split("\r\n")[rowIdx]!.split(";");
}

/** Candidat minimal pour les tests. */
function makeCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.assign({
    client:              "Client Test",
    bc_id:               "BC-001",
    clean_score:         7,
    matched_signals:     ["nettoyage"],
    ctx_client_sectors:       [],
    ctx_client_service_types: [],
    ctx_client_target_orgs:   [],
    ctx_client_exclusions:    [],
    ctx_client_products:      [],
    ctx_client_specs:         [],
  }, overrides);
}

const PROFILE_COLS = [
  "client_sectors",
  "client_service_types",
  "client_target_orgs",
  "client_exclusions",
  "client_products",
  "client_specs",
];

// -- RCP-A : En-tete CSV contient les 6 colonnes profil --

describe("RCP-A -- En-tete CSV : les 6 colonnes profil enrichi (GD-044)", () => {

  let header: string[];
  beforeAll(() => {
    const csv = buildReviewCsv([makeCandidate()]);
    header = parseHeader(csv);
  });

  test("RCP-1: l'en-tete contient client_sectors", () => {
    expect(header).toContain("client_sectors");
  });

  test("RCP-2: l'en-tete contient client_service_types", () => {
    expect(header).toContain("client_service_types");
  });

  test("RCP-3: l'en-tete contient client_target_orgs", () => {
    expect(header).toContain("client_target_orgs");
  });

  test("RCP-4: l'en-tete contient client_exclusions", () => {
    expect(header).toContain("client_exclusions");
  });

  test("RCP-5: l'en-tete contient client_products", () => {
    expect(header).toContain("client_products");
  });

  test("RCP-6: l'en-tete contient client_specs", () => {
    expect(header).toContain("client_specs");
  });

  test("RCP-7: les 6 colonnes profil precedent la colonne decision", () => {
    const iDecision = header.indexOf("decision");
    for (const col of PROFILE_COLS) {
      expect(header.indexOf(col)).toBeGreaterThan(-1);
      expect(header.indexOf(col)).toBeLessThan(iDecision);
    }
  });

  test("RCP-8: le nombre de colonnes est stable (33)", () => {
    expect(header.length).toBe(33);
  });
});

// -- RCP-B : Serialisation arrays -> cellule CSV --

describe("RCP-B -- Serialisation : arrays profil -> cellule CSV jointe", () => {

  function colIdx(col: string): number {
    const csv = buildReviewCsv([makeCandidate()]);
    return parseHeader(csv).indexOf(col);
  }

  test("RCP-9: ctx_client_sectors -> client_sectors serialise (join ', ')", () => {
    const csv = buildReviewCsv([makeCandidate({
      ctx_client_sectors: ["nettoyage", "hygiene"],
    })]);
    const row = parseRow(csv, 1);
    expect(row[colIdx("client_sectors")]).toBe("nettoyage, hygiene");
  });

  test("RCP-10: ctx_client_service_types -> client_service_types serialise", () => {
    const csv = buildReviewCsv([makeCandidate({
      ctx_client_service_types: ["entretien", "desinfection"],
    })]);
    const row = parseRow(csv, 1);
    expect(row[colIdx("client_service_types")]).toBe("entretien, desinfection");
  });

  test("RCP-11: ctx_client_target_orgs -> client_target_orgs serialise", () => {
    const csv = buildReviewCsv([makeCandidate({
      ctx_client_target_orgs: ["mairie", "CHU"],
    })]);
    const row = parseRow(csv, 1);
    expect(row[colIdx("client_target_orgs")]).toBe("mairie, CHU");
  });

  test("RCP-12: ctx_client_exclusions -> client_exclusions serialise", () => {
    const csv = buildReviewCsv([makeCandidate({
      ctx_client_exclusions: ["informatique", "telephonie"],
    })]);
    const row = parseRow(csv, 1);
    expect(row[colIdx("client_exclusions")]).toBe("informatique, telephonie");
  });

  test("RCP-13: ctx_client_products -> client_products serialise", () => {
    const csv = buildReviewCsv([makeCandidate({
      ctx_client_products: ["detergent HPC"],
    })]);
    const row = parseRow(csv, 1);
    expect(row[colIdx("client_products")]).toBe("detergent HPC");
  });

  test("RCP-14: ctx_client_specs -> client_specs serialise", () => {
    const csv = buildReviewCsv([makeCandidate({
      ctx_client_specs: ["ISO 9001", "NF"],
    })]);
    const row = parseRow(csv, 1);
    expect(row[colIdx("client_specs")]).toBe("ISO 9001, NF");
  });

  test("RCP-15: plusieurs candidats -> toutes les lignes ont les colonnes profil", () => {
    const csv = buildReviewCsv([
      makeCandidate({ ctx_client_sectors: ["nettoyage"] }),
      makeCandidate({ ctx_client_sectors: ["restauration"] }),
    ]);
    const rows = csv.split("\r\n");
    expect(rows.length).toBe(3); // BOM+header + 2 data
    const idxSectors = parseHeader(csv).indexOf("client_sectors");
    expect(rows[1]!.split(";")[idxSectors]).toBe("nettoyage");
    expect(rows[2]!.split(";")[idxSectors]).toBe("restauration");
  });
});

// -- RCP-C : Colonnes vides si ctx_client_* absents ou vides --

describe("RCP-C -- Colonnes profil vides si donnees absentes", () => {

  let header: string[];
  let row: string[];

  beforeAll(() => {
    // Candidat sans aucun ctx_client_*
    const csv = buildReviewCsv([makeCandidate()]);
    header = parseHeader(csv);
    row    = parseRow(csv, 1);
  });

  test("RCP-16: client_sectors vide si ctx_client_sectors = []", () => {
    expect(row[header.indexOf("client_sectors")]).toBe("");
  });

  test("RCP-17: client_service_types vide si ctx_client_service_types = []", () => {
    expect(row[header.indexOf("client_service_types")]).toBe("");
  });

  test("RCP-18: client_target_orgs vide si ctx_client_target_orgs = []", () => {
    expect(row[header.indexOf("client_target_orgs")]).toBe("");
  });

  test("RCP-19: client_exclusions vide si ctx_client_exclusions = []", () => {
    expect(row[header.indexOf("client_exclusions")]).toBe("");
  });

  test("RCP-20: client_products vide si ctx_client_products = []", () => {
    expect(row[header.indexOf("client_products")]).toBe("");
  });

  test("RCP-21: client_specs vide si ctx_client_specs = []", () => {
    expect(row[header.indexOf("client_specs")]).toBe("");
  });

  test("RCP-22: colonnes profil vides si ctx_client_* undefined (champ absent)", () => {
    const cand: Record<string, unknown> = {
      client: "X", bc_id: "BC-X", clean_score: 7, matched_signals: ["sig"],
      // pas de ctx_client_* du tout
    };
    const csv = buildReviewCsv([cand]);
    const h   = parseHeader(csv);
    const r   = parseRow(csv, 1);
    for (const col of PROFILE_COLS) {
      expect(r[h.indexOf(col)]).toBe("");
    }
  });
});

// -- RCP-D : Invariants colonnes de base --

describe("RCP-D -- Invariants : colonnes de base inchangees (GD-044)", () => {

  let header: string[];
  beforeAll(() => {
    const csv = buildReviewCsv([makeCandidate()]);
    header = parseHeader(csv);
  });

  test("RCP-23: colonne client presente en position 0", () => {
    expect(header[0]).toBe("client");
  });

  test("RCP-24: colonne bc_id presente en position 1", () => {
    expect(header[1]).toBe("bc_id");
  });

  test("RCP-25: colonne score presente en position 2", () => {
    expect(header[2]).toBe("score");
  });

  test("RCP-26: colonne decision presente en derniere position", () => {
    expect(header[header.length - 1]).toBe("decision");
  });

  test("RCP-27: decision toujours vide dans le CSV (saisie humaine)", () => {
    const csv = buildReviewCsv([makeCandidate()]);
    const row = parseRow(csv, 1);
    expect(row[header.indexOf("decision")]).toBe("");
  });

  test("RCP-28: colonnes profil n'affectent pas client, bc_id, score", () => {
    const csv = buildReviewCsv([makeCandidate({
      ctx_client_sectors: ["nettoyage"],
      ctx_client_exclusions: ["informatique"],
    })]);
    const row = parseRow(csv, 1);
    expect(row[0]).toBe("Client Test");
    expect(row[1]).toBe("BC-001");
    expect(row[2]).toBe("7");
  });
});

export {};
