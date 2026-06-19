/**
 * tests/unit/shadow-profile-transport.test.ts
 *
 * Tests GD-041 -- Transport du profil client enrichi dans le rapport shadow.
 *
 * replay-shadow-from-input-snapshot.js ne peut pas etre require()'d
 * (script executable sans module.exports). On teste donc :
 *
 *  SPT-A  Mapping client Supabase -> objet shadow (logique inline miroir)
 *  SPT-B  _computeShadowComparison : champs profil dans le return (logique inline)
 *  SPT-C  Integration : analyzeReviewContext avec profil depuis bloc shadow -> ctx_client_*
 *  SPT-D  Invariants de securite (profil ne modifie pas les champs stats)
 */

/* eslint-disable @typescript-eslint/no-var-requires */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ctx: {
  analyzeReviewContext: (
    entry: object,
    profile: object | null,
    decision: string,
    opts: object
  ) => Record<string, unknown>;
} = require("../../scripts/contextual-review-insights");

// ── Helpers -- miroir exact des transformations de replay-shadow ──────────────

/**
 * Simule la transformation appliquee dans loadClientsFromSupabase().map()
 * lors du chargement depuis Supabase.
 */
function mapSupabaseClient(raw: Record<string, unknown>): Record<string, unknown> {
  const pack = (raw.pack as string) || "starter";
  const criteres = Array.isArray(raw.criteres) ? raw.criteres : [];
  return {
    id:      raw.id,
    nom:     raw.nom || raw.id,
    pack,
    criteres,
    // Profil enrichi (GD-041) -- transport shadow uniquement, jamais dans le scoring
    business_profile:     (raw.business_profile as string)     || (raw.profile_label as string) || "",
    technical_profile:    (raw.technical_profile as string)    || "",
    organization_profile: (raw.organization_profile as string) || "",
    profile_label:        (raw.profile_label as string)        || "",
    secteurs:             Array.isArray(raw.secteurs)          ? raw.secteurs          : [],
    types_prestation:     Array.isArray(raw.types_prestation)  ? raw.types_prestation  : [],
    organismes_cibles:    Array.isArray(raw.organismes_cibles) ? raw.organismes_cibles : [],
    exclusions_metier:    Array.isArray(raw.exclusions_metier) ? raw.exclusions_metier : [],
    produits:             Array.isArray(raw.produits)          ? raw.produits          : [],
    specifications:       Array.isArray(raw.specifications)    ? raw.specifications    : [],
  };
}

/**
 * Simule les champs profil ajoutes dans le return de _computeShadowComparison().
 * Les champs stats sont simules a zero -- on ne teste que le profil.
 */
function makeShadowClientBlock(client: Record<string, unknown>): Record<string, unknown> {
  return {
    client_id:   client.id,
    client_name: client.nom || client.id,
    // Profil enrichi (GD-041) -- shadow reporting uniquement, jamais dans le scoring
    business_profile:     (client.business_profile as string)     || "",
    technical_profile:    (client.technical_profile as string)    || "",
    organization_profile: (client.organization_profile as string) || "",
    profile_label:        (client.profile_label as string)        || "",
    secteurs:             Array.isArray(client.secteurs)          ? client.secteurs          : [],
    types_prestation:     Array.isArray(client.types_prestation)  ? client.types_prestation  : [],
    organismes_cibles:    Array.isArray(client.organismes_cibles) ? client.organismes_cibles : [],
    exclusions_metier:    Array.isArray(client.exclusions_metier) ? client.exclusions_metier : [],
    produits:             Array.isArray(client.produits)          ? client.produits          : [],
    specifications:       Array.isArray(client.specifications)    ? client.specifications    : [],
    // Stats simulees
    legacy: 0, clean: 0, both_match: 0,
    legacy_only_count: 0, clean_only_count: 0, fp_rate_pct: 0,
    clean_auto_notify_candidates: 0, clean_review_candidates: 0,
    recommendation: "keep_legacy_production",
    clean_only: [], review_candidates_detail: [], guard_impact: [],
  };
}

function makeEntry(overrides: object = {}): object {
  return Object.assign({
    bc_id:              "BC-TEST",
    client:             "Client Test",
    clean_score:        7,
    matched_signals:    ["nettoyage"],
    clean_text_excerpt: "nettoyage des locaux",
    hint_block_auto:    false,
    weak_single_signal: false,
  }, overrides);
}

// ── SPT-A -- Mapping Supabase -> objet shadow ─────────────────────────────────

describe("SPT-A -- mapSupabaseClient transmet le profil enrichi (miroir GD-041)", () => {

  const rawClient = {
    id:                  "c1",
    nom:                 "Client Nettoyage",
    pack:                "pro",
    criteres:            [],
    business_profile:    "Entreprise de nettoyage industriel",
    technical_profile:   "Machines de lavage haute pression",
    organization_profile:"Collectivites territoriales",
    profile_label:       "nettoyage",
    secteurs:            ["nettoyage", "hygiene"],
    types_prestation:    ["entretien locaux"],
    organismes_cibles:   ["mairie", "CHU"],
    exclusions_metier:   ["informatique"],
    produits:            ["detergent", "desinfectant"],
    specifications:      ["certifie NF"],
  };

  let mapped: Record<string, unknown>;
  beforeAll(() => { mapped = mapSupabaseClient(rawClient); });

  test("SPT-1: business_profile transmis depuis Supabase", () => {
    expect(mapped.business_profile).toBe("Entreprise de nettoyage industriel");
  });

  test("SPT-2: technical_profile transmis depuis Supabase", () => {
    expect(mapped.technical_profile).toBe("Machines de lavage haute pression");
  });

  test("SPT-3: secteurs transmis (tableau)", () => {
    expect(Array.isArray(mapped.secteurs)).toBe(true);
    expect(mapped.secteurs).toEqual(["nettoyage", "hygiene"]);
  });

  test("SPT-4: exclusions_metier transmis (tableau)", () => {
    expect(Array.isArray(mapped.exclusions_metier)).toBe(true);
    expect(mapped.exclusions_metier).toEqual(["informatique"]);
  });

  test("SPT-5: champs absents dans Supabase -> valeurs par defaut (vide/chaine vide)", () => {
    const minimal = mapSupabaseClient({ id: "c2", nom: "Minimal", criteres: [] });
    expect(minimal.business_profile).toBe("");
    expect(Array.isArray(minimal.secteurs)).toBe(true);
    expect((minimal.secteurs as unknown[]).length).toBe(0);
    expect(Array.isArray(minimal.exclusions_metier)).toBe(true);
  });

  test("SPT-6: profile_label utilise comme fallback de business_profile si absent", () => {
    const withLabel = mapSupabaseClient({
      id: "c3", nom: "Test", criteres: [],
      profile_label: "restauration",
    });
    expect(withLabel.business_profile).toBe("restauration");
  });
});

// ── SPT-B -- _computeShadowComparison : champs profil dans le bloc client ─────

describe("SPT-B -- makeShadowClientBlock propage le profil dans le rapport shadow", () => {

  const client = mapSupabaseClient({
    id: "c1", nom: "Client Nettoyage", criteres: [],
    secteurs: ["nettoyage locaux"],
    types_prestation: ["entretien quotidien"],
    organismes_cibles: ["hopital"],
    exclusions_metier: ["informatique"],
    produits: ["detergent"],
    specifications: ["sans allergenes"],
    business_profile: "Nettoyage industriel",
  });

  let block: Record<string, unknown>;
  beforeAll(() => { block = makeShadowClientBlock(client); });

  test("SPT-7: client_name present dans le bloc shadow", () => {
    expect(block.client_name).toBe("Client Nettoyage");
  });

  test("SPT-8: secteurs presents dans le bloc shadow", () => {
    expect(block.secteurs).toEqual(["nettoyage locaux"]);
  });

  test("SPT-9: business_profile present dans le bloc shadow", () => {
    expect(block.business_profile).toBe("Nettoyage industriel");
  });

  test("SPT-10: tous les 6 champs structures sont dans le bloc shadow", () => {
    expect(block).toHaveProperty("secteurs");
    expect(block).toHaveProperty("types_prestation");
    expect(block).toHaveProperty("organismes_cibles");
    expect(block).toHaveProperty("exclusions_metier");
    expect(block).toHaveProperty("produits");
    expect(block).toHaveProperty("specifications");
  });
});

// ── SPT-C -- Integration : bloc shadow -> analyzeReviewContext -> ctx_client_* ─

describe("SPT-C -- Integration : profil depuis bloc shadow alimente analyzeReviewContext", () => {

  /**
   * Simule ce que fait analyze-shadow-report.js::analyzeClient()
   * avec un bloc client shadow contenant les champs profil GD-041.
   */
  function buildClientProfileFromBlock(c: Record<string, unknown>): object {
    return {
      client_name:       c.client_name       || "",
      business_profile:  c.business_profile  || c.profile_label || "",
      secteurs:          Array.isArray(c.secteurs)          ? c.secteurs          : [],
      types_prestation:  Array.isArray(c.types_prestation)  ? c.types_prestation  : [],
      organismes_cibles: Array.isArray(c.organismes_cibles) ? c.organismes_cibles : [],
      exclusions_metier: Array.isArray(c.exclusions_metier) ? c.exclusions_metier : [],
      produits:          Array.isArray(c.produits)          ? c.produits          : [],
      specifications:    Array.isArray(c.specifications)    ? c.specifications    : [],
    };
  }

  test("SPT-11: secteurs dans bloc shadow -> client_sectors non vide dans ctx", () => {
    const block = makeShadowClientBlock(mapSupabaseClient({
      id: "c1", nom: "Test", criteres: [],
      secteurs: ["nettoyage"],
    }));
    const profile = buildClientProfileFromBlock(block);
    const r = ctx.analyzeReviewContext(makeEntry(), profile, "", {});
    expect(Array.isArray(r.client_sectors)).toBe(true);
    expect((r.client_sectors as string[])).toContain("nettoyage");
  });

  test("SPT-12: exclusions_metier dans bloc shadow -> client_exclusions non vide dans ctx", () => {
    const block = makeShadowClientBlock(mapSupabaseClient({
      id: "c1", nom: "Test", criteres: [],
      exclusions_metier: ["informatique", "telephonie"],
    }));
    const profile = buildClientProfileFromBlock(block);
    const r = ctx.analyzeReviewContext(makeEntry(), profile, "", {});
    expect(r.client_exclusions).toEqual(["informatique", "telephonie"]);
  });

  test("SPT-13: produits dans bloc shadow -> client_products non vide dans ctx", () => {
    const block = makeShadowClientBlock(mapSupabaseClient({
      id: "c1", nom: "Test", criteres: [],
      produits: ["detergent HPC"],
    }));
    const profile = buildClientProfileFromBlock(block);
    const r = ctx.analyzeReviewContext(makeEntry(), profile, "", {});
    expect((r.client_products as string[])).toContain("detergent HPC");
  });

  test("SPT-14: bloc shadow sans profil -> ctx_client_* tous vides (pas de crash)", () => {
    const block = makeShadowClientBlock(mapSupabaseClient({
      id: "c2", nom: "Minimal", criteres: [],
    }));
    const profile = buildClientProfileFromBlock(block);
    const r = ctx.analyzeReviewContext(makeEntry(), profile, "", {});
    expect((r.client_sectors as unknown[]).length).toBe(0);
    expect((r.client_exclusions as unknown[]).length).toBe(0);
    expect((r.client_products as unknown[]).length).toBe(0);
  });

  test("SPT-15: specifications dans bloc shadow -> client_specs non vide dans ctx", () => {
    const block = makeShadowClientBlock(mapSupabaseClient({
      id: "c1", nom: "Test", criteres: [],
      specifications: ["ISO 9001"],
    }));
    const profile = buildClientProfileFromBlock(block);
    const r = ctx.analyzeReviewContext(makeEntry(), profile, "", {});
    expect((r.client_specs as string[])).toContain("ISO 9001");
  });
});

// ── SPT-D -- Invariants de securite ──────────────────────────────────────────

describe("SPT-D -- Invariants : champs profil ne modifient pas les champs stats du bloc shadow", () => {

  test("SPT-16: les champs stats (legacy, clean, fp_rate_pct) sont independants du profil", () => {
    const clientAvecProfil = mapSupabaseClient({
      id: "c1", nom: "Riche", criteres: [],
      secteurs: ["nettoyage"], produits: ["detergent"],
    });
    const clientSansProfil = mapSupabaseClient({
      id: "c2", nom: "Pauvre", criteres: [],
    });
    const blockAvec  = makeShadowClientBlock(clientAvecProfil);
    const blockSans  = makeShadowClientBlock(clientSansProfil);
    // Les stats sont les memes (simulees a 0) -- le profil ne les influence pas
    expect(blockAvec.legacy).toBe(blockSans.legacy);
    expect(blockAvec.clean).toBe(blockSans.clean);
    expect(blockAvec.fp_rate_pct).toBe(blockSans.fp_rate_pct);
  });

  test("SPT-17: les champs profil ne contiennent aucune reference a score ou threshold", () => {
    const block = makeShadowClientBlock(mapSupabaseClient({
      id: "c1", nom: "Test", criteres: [],
      secteurs: ["nettoyage"], business_profile: "Nettoyage",
    }));
    // Aucun champ score/seuil cree par le transport profil
    expect(block).not.toHaveProperty("score");
    expect(block).not.toHaveProperty("threshold");
    expect(block).not.toHaveProperty("min_score");
    expect(block).not.toHaveProperty("auto_notify");
  });

  test("SPT-18: non-regression -- client_name et client_id toujours presents apres GD-041", () => {
    const block = makeShadowClientBlock(mapSupabaseClient({
      id: "abc123", nom: "Ma Societe", criteres: [],
    }));
    expect(block.client_name).toBe("Ma Societe");
    expect(block.client_id).toBe("abc123");
  });
});

export {};
