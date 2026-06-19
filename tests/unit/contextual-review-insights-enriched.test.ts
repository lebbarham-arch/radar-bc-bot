/**
 * tests/unit/contextual-review-insights-enriched.test.ts
 *
 * Tests GD-040 -- profil client structurel dans contextual-review-insights.
 *
 * Groupes :
 *   CRI-E-A  Champs structurés contribuent a detectClientProfileFamilies
 *   CRI-E-B  analyzeReviewContext retourne les 6 champs de diagnostic profil
 *   CRI-E-C  exclusions_metier exclues du profil positif
 *   CRI-E-D  profile_alignment ameliore par les champs structures
 *   CRI-E-E  Invariants de securite (pas d'effet sur le scoring)
 */

/* eslint-disable @typescript-eslint/no-var-requires */
// Les scripts JS n'ont pas de declarations de type -- require + any est le pattern etabli.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ctx: {
  detectClientProfileFamilies: (profile: object | null) => Record<string, string[]>;
  analyzeReviewContext: (
    entry: object,
    profile: object | null,
    decision: string,
    opts: object
  ) => Record<string, unknown>;
  CONTEXT_FAMILIES: Array<{ key: string; label: string; terms: string[] }>;
  CONTEXT_MODEL: string;
} = require("../../scripts/contextual-review-insights");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(overrides: object = {}): object {
  return Object.assign(
    {
      bc_id:               "BC-TEST",
      client:              "Client Test",
      clean_score:         8,
      matched_signals:     ["nettoyage"],
      clean_text_excerpt:  "nettoyage des locaux administratifs",
      hint_block_auto:     false,
      weak_single_signal:  false,
    },
    overrides
  );
}

function makeProfile(overrides: object = {}): object {
  return Object.assign(
    {
      client_name:       "Client Test",
      business_profile:  "",
      secteurs:          [],
      types_prestation:  [],
      organismes_cibles: [],
      exclusions_metier: [],
      produits:          [],
      specifications:    [],
    },
    overrides
  );
}

// ── CRI-E-A -- Champs structures dans detectClientProfileFamilies ─────────────

describe("CRI-E-A -- detectClientProfileFamilies exploite les champs structures (GD-040)", () => {

  test("CRI-E-1: secteurs=['nettoyage locaux'] -> cleaning_disinfection detecte", () => {
    const profile = makeProfile({ secteurs: ["nettoyage locaux"] });
    const families = ctx.detectClientProfileFamilies(profile);
    expect(Object.keys(families)).toContain("cleaning_disinfection");
  });

  test("CRI-E-2: types_prestation=['restauration collective'] -> food_or_beverage detecte", () => {
    const profile = makeProfile({ types_prestation: ["restauration collective"] });
    const families = ctx.detectClientProfileFamilies(profile);
    expect(Object.keys(families)).toContain("food_or_beverage");
  });

  test("CRI-E-3: produits=['logiciel ERP'] -> it detecte", () => {
    const profile = makeProfile({ produits: ["logiciel ERP"] });
    const families = ctx.detectClientProfileFamilies(profile);
    expect(Object.keys(families)).toContain("it");
  });

  test("CRI-E-4: specifications=['travaux de renovation'] -> construction_or_works detecte", () => {
    const profile = makeProfile({ specifications: ["travaux de renovation"] });
    const families = ctx.detectClientProfileFamilies(profile);
    expect(Object.keys(families)).toContain("construction_or_works");
  });

  test("CRI-E-5: organismes_cibles=['hopital CHU'] -> medical_admin detecte", () => {
    const profile = makeProfile({ organismes_cibles: ["hopital CHU"] });
    const families = ctx.detectClientProfileFamilies(profile);
    expect(Object.keys(families)).toContain("medical_admin");
  });
});

// ── CRI-E-B -- analyzeReviewContext retourne les 6 champs diagnostics ─────────

describe("CRI-E-B -- analyzeReviewContext retourne client_sectors, service_types, etc. (GD-040)", () => {

  const profile = makeProfile({
    secteurs:          ["nettoyage"],
    types_prestation:  ["entretien locaux"],
    organismes_cibles: ["mairie"],
    exclusions_metier: ["informatique"],
    produits:          ["detergent"],
    specifications:    ["produits certifies"],
  });

  let result: Record<string, unknown>;

  beforeAll(() => {
    result = ctx.analyzeReviewContext(
      makeEntry(),
      profile,
      "",
      { generatedAt: "2026-01-01T00:00:00.000Z" }
    );
  });

  test("CRI-E-6: client_sectors retourne le contenu de secteurs", () => {
    expect(Array.isArray(result.client_sectors)).toBe(true);
    expect(result.client_sectors).toEqual(["nettoyage"]);
  });

  test("CRI-E-7: client_service_types retourne le contenu de types_prestation", () => {
    expect(Array.isArray(result.client_service_types)).toBe(true);
    expect(result.client_service_types).toEqual(["entretien locaux"]);
  });

  test("CRI-E-8: client_target_orgs retourne le contenu de organismes_cibles", () => {
    expect(Array.isArray(result.client_target_orgs)).toBe(true);
    expect(result.client_target_orgs).toEqual(["mairie"]);
  });

  test("CRI-E-9: client_exclusions retourne le contenu de exclusions_metier", () => {
    expect(Array.isArray(result.client_exclusions)).toBe(true);
    expect(result.client_exclusions).toEqual(["informatique"]);
  });

  test("CRI-E-10: client_products retourne le contenu de produits", () => {
    expect(Array.isArray(result.client_products)).toBe(true);
    expect(result.client_products).toEqual(["detergent"]);
  });

  test("CRI-E-11: client_specs retourne le contenu de specifications", () => {
    expect(Array.isArray(result.client_specs)).toBe(true);
    expect(result.client_specs).toEqual(["produits certifies"]);
  });

  test("CRI-E-12: profil vide -> les 6 champs sont des tableaux vides (pas de crash)", () => {
    const r = ctx.analyzeReviewContext(makeEntry(), makeProfile(), "", {});
    expect(Array.isArray(r.client_sectors)).toBe(true);
    expect(Array.isArray(r.client_service_types)).toBe(true);
    expect(Array.isArray(r.client_target_orgs)).toBe(true);
    expect(Array.isArray(r.client_exclusions)).toBe(true);
    expect(Array.isArray(r.client_products)).toBe(true);
    expect(Array.isArray(r.client_specs)).toBe(true);
    expect((r.client_sectors as unknown[]).length).toBe(0);
    expect((r.client_specs as unknown[]).length).toBe(0);
  });

  test("CRI-E-13: clientProfile null -> les 6 champs sont des tableaux vides (pas de crash)", () => {
    const r = ctx.analyzeReviewContext(makeEntry(), null, "", {});
    expect(Array.isArray(r.client_sectors)).toBe(true);
    expect((r.client_sectors as unknown[]).length).toBe(0);
    expect((r.client_exclusions as unknown[]).length).toBe(0);
  });
});

// ── CRI-E-C -- exclusions_metier exclues du profil positif ───────────────────

describe("CRI-E-C -- exclusions_metier ne contribuent pas au profil positif", () => {

  test("CRI-E-14: exclusions_metier=['nettoyage'] -> cleaning_disinfection absent des familles profil", () => {
    // Un client qui EXCLUT nettoyage ne doit pas avoir cleaning_disinfection dans son profil positif
    const profile = makeProfile({
      exclusions_metier: ["nettoyage"],
      secteurs:          [],
      types_prestation:  [],
    });
    const families = ctx.detectClientProfileFamilies(profile);
    // cleaning_disinfection ne doit PAS apparaitre dans les familles positives
    expect(Object.keys(families)).not.toContain("cleaning_disinfection");
  });

  test("CRI-E-15: exclusions_metier bien presentes dans client_exclusions du resultat", () => {
    const profile = makeProfile({ exclusions_metier: ["nettoyage", "desinfection"] });
    const r = ctx.analyzeReviewContext(makeEntry(), profile, "", {});
    expect(r.client_exclusions).toEqual(["nettoyage", "desinfection"]);
  });
});

// ── CRI-E-D -- profile_alignment ameliore par champs structures ──────────────

describe("CRI-E-D -- profile_alignment beneficie des champs structures", () => {

  test("CRI-E-16: secteurs=['nettoyage locaux'] + BC nettoyage -> alignment >= medium", () => {
    const profile = makeProfile({ secteurs: ["nettoyage locaux"] });
    const entry = makeEntry({
      clean_text_excerpt: "nettoyage des bureaux administratifs",
      matched_signals:    ["nettoyage"],
    });
    const r = ctx.analyzeReviewContext(entry, profile, "keep", {});
    expect(["medium", "high"]).toContain(r.profile_alignment);
  });

  test("CRI-E-17: profil purement IT (produits=['logiciel']) + BC nettoyage -> alignment low ou unclear", () => {
    const profile = makeProfile({ produits: ["logiciel ERP"] });
    const entry = makeEntry({
      clean_text_excerpt: "nettoyage des locaux clinique",
      matched_signals:    ["nettoyage"],
    });
    const r = ctx.analyzeReviewContext(entry, profile, "reject", {});
    expect(["low", "unclear"]).toContain(r.profile_alignment);
  });
});

// ── CRI-E-E -- Invariants de securite ────────────────────────────────────────

describe("CRI-E-E -- Invariants : profil enrichi ne modifie pas le scoring", () => {

  test("CRI-E-18: analyzeReviewContext ne modifie pas l'entree passee", () => {
    const entry: Record<string, unknown> = Object.assign(makeEntry({ clean_score: 8 }));
    const profile = makeProfile({ secteurs: ["nettoyage"] });
    ctx.analyzeReviewContext(entry, profile, "", {});
    // L'entree ne doit pas etre mutee
    expect(entry["clean_score"]).toBe(8);
    expect(entry["ctx_profile_alignment"]).toBeUndefined();
    expect(entry["client_sectors"]).toBeUndefined();
  });

  test("CRI-E-19: les 6 champs ctx_client_* sont bien dans le resultat de analyzeReviewContext", () => {
    const r = ctx.analyzeReviewContext(
      makeEntry(),
      makeProfile({ secteurs: ["nettoyage"], produits: ["savon"] }),
      "",
      {}
    );
    expect(r).toHaveProperty("client_sectors");
    expect(r).toHaveProperty("client_service_types");
    expect(r).toHaveProperty("client_target_orgs");
    expect(r).toHaveProperty("client_exclusions");
    expect(r).toHaveProperty("client_products");
    expect(r).toHaveProperty("client_specs");
  });

  test("CRI-E-20: le resultat conserve tous les champs ctx_ existants (non-regression GD-035)", () => {
    const r = ctx.analyzeReviewContext(makeEntry(), makeProfile(), "", {});
    // Champs existants (GD-035) doivent toujours etre presents
    expect(r).toHaveProperty("profile_alignment");
    expect(r).toHaveProperty("positive_context_terms");
    expect(r).toHaveProperty("negative_context_terms");
    expect(r).toHaveProperty("context_ambiguity");
    expect(r).toHaveProperty("context_confidence");
    expect(r).toHaveProperty("learnable_context_hint");
    expect(r).toHaveProperty("should_create_context_hint");
    expect(r).toHaveProperty("why_it_matched");
    expect(r).toHaveProperty("why_it_may_be_wrong");
    expect(r).toHaveProperty("context_model");
    expect(r).toHaveProperty("context_generated_at");
  });

  test("CRI-E-21: les champs structures sont copies (slices) -- mutation du profil sans effet", () => {
    const secteurs: string[] = ["nettoyage"];
    const profile = makeProfile({ secteurs });
    const r = ctx.analyzeReviewContext(makeEntry(), profile, '', {});
    // Muter le tableau original ne doit pas affecter le resultat deja rendu
    secteurs.push('informatique');
    expect(Array.isArray(r.client_sectors)).toBe(true);
    expect((r.client_sectors as string[]).join(',')).toBe('nettoyage');
    expect((r.client_sectors as string[])).not.toContain('informatique');
  });
});

export {};
