/**
 * tests/unit/local-client-profiles.test.ts
 * Tests GD-043 -- Profils clients locaux shadow fallback.
 *
 * Groupes :
 *   LCP-A  Chargement et parsing du fichier profiles.json
 *   LCP-B  Fusion par nom client (mergeLocalProfile)
 *   LCP-C  Priorite Supabase si champ non vide
 *   LCP-D  Fallback local si champ Supabase absent ou vide
 *   LCP-E  Invariants de securite + correspondance accent-insensitive
 */

import * as fs   from "fs";
import * as path from "path";

// -- Miroir exact des fonctions GD-043 dans replay-shadow --

type LocalProfile  = Record<string, unknown>;
type LocalProfiles = Record<string, LocalProfile>;

/** Miroir de normalizeProfileKey() (GD-043). */
function normalizeProfileKey(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Miroir de buildIndex() IIFE (GD-043). */
function buildIndex(raw: LocalProfiles): LocalProfiles {
  const idx: LocalProfiles = {};
  Object.keys(raw).forEach((k) => {
    if (k === "_comment") return;
    idx[normalizeProfileKey(k)] = raw[k]!;
  });
  return idx;
}

/** Miroir de mergeLocalProfile() (GD-043). */
function mergeLocalProfile(
  c:   Record<string, unknown>,
  raw: LocalProfiles | null
): Record<string, unknown> {
  if (!raw) return c;
  const idx   = buildIndex(raw);
  const nom   = (c.nom as string) || (c.id as string) || "";
  const local = idx[normalizeProfileKey(nom)] ?? null;
  if (!local) return c;
  function arr(sv: unknown, lv: unknown): unknown[] {
    return Array.isArray(sv) && (sv as unknown[]).length > 0
      ? (sv as unknown[])
      : Array.isArray(lv) ? lv : [];
  }
  function str(sv: unknown, lv: unknown): string {
    return typeof sv === "string" && (sv as string).trim()
      ? (sv as string)
      : typeof lv === "string" ? lv : "";
  }
  return Object.assign({}, c, {
    business_profile:     str(c.business_profile,     local.business_profile),
    technical_profile:    str(c.technical_profile,    local.technical_profile),
    organization_profile: str(c.organization_profile, local.organization_profile),
    profile_label:        str(c.profile_label,        local.profile_label),
    secteurs:             arr(c.secteurs,             local.secteurs),
    types_prestation:     arr(c.types_prestation,     local.types_prestation),
    organismes_cibles:    arr(c.organismes_cibles,    local.organismes_cibles),
    exclusions_metier:    arr(c.exclusions_metier,    local.exclusions_metier),
    produits:             arr(c.produits,             local.produits),
    specifications:       arr(c.specifications,       local.specifications),
  });
}

// -- Fixtures --

const PROFILES_PATH = path.join(
  __dirname, "..", "..", "data", "client-profiles", "profiles.json"
);

function makeClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.assign({
    id:                   "c1",
    nom:                  "TEST PROD - Nettoyage Hygiene",
    pack:                 "starter",
    criteres:             [],
    business_profile:     "",
    technical_profile:    "",
    organization_profile: "",
    profile_label:        "",
    secteurs:             [],
    types_prestation:     [],
    organismes_cibles:    [],
    exclusions_metier:    [],
    produits:             [],
    specifications:       [],
  }, overrides);
}

const REF: LocalProfile = {
  business_profile:  "Nettoyage industriel",
  technical_profile: "Desinfectants",
  profile_label:     "Nettoyage",
  secteurs:          ["nettoyage", "hygiene"],
  types_prestation:  ["entretien locaux"],
  organismes_cibles: ["mairie"],
  exclusions_metier: ["informatique"],
  produits:          ["detergent"],
  specifications:    ["locaux"],
};

// -- LCP-A : Chargement profiles.json --

describe("LCP-A -- Chargement et parsing de profiles.json (GD-043)", () => {

  test("LCP-1: le fichier data/client-profiles/profiles.json existe", () => {
    expect(fs.existsSync(PROFILES_PATH)).toBe(true);
  });

  test("LCP-2: le fichier est du JSON valide", () => {
    expect(() => JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"))).not.toThrow();
  });

  test("LCP-3: le profil TEST PROD - Nettoyage Hygiene est present", () => {
    const p = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8")) as LocalProfiles;
    expect(p).toHaveProperty("TEST PROD - Nettoyage Hygiene");
  });

  test("LCP-4: le profil contient les 9 champs attendus", () => {
    const p     = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8")) as LocalProfiles;
    const entry = p["TEST PROD - Nettoyage Hygiene"]!;
    for (const k of ["business_profile","technical_profile","profile_label",
                     "secteurs","types_prestation","organismes_cibles",
                     "exclusions_metier","produits","specifications"]) {
      expect(entry).toHaveProperty(k);
    }
  });

  test("LCP-5: les tableaux du profil sont non vides", () => {
    const p     = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8")) as LocalProfiles;
    const entry = p["TEST PROD - Nettoyage Hygiene"]!;
    expect(Array.isArray(entry.secteurs) && (entry.secteurs as unknown[]).length).toBeTruthy();
    expect(Array.isArray(entry.produits) && (entry.produits as unknown[]).length).toBeTruthy();
  });
});

// -- LCP-B : Fusion par nom client --

describe("LCP-B -- mergeLocalProfile : fusion par nom client", () => {

  const profiles: LocalProfiles = { "TEST PROD - Nettoyage Hygiene": REF };

  test("LCP-6: client avec nom correspondant -> profil applique", () => {
    const m = mergeLocalProfile(makeClient(), profiles);
    expect(m.secteurs).toEqual(["nettoyage", "hygiene"]);
    expect(m.business_profile).toBe("Nettoyage industriel");
  });

  test("LCP-7: client sans correspondance -> objet inchange", () => {
    const m = mergeLocalProfile(makeClient({ nom: "Autre Client" }), profiles);
    expect(m.secteurs).toEqual([]);
    expect(m.business_profile).toBe("");
  });

  test("LCP-8: profiles null -> objet inchange sans crash", () => {
    const m = mergeLocalProfile(makeClient(), null);
    expect(m.secteurs).toEqual([]);
  });

  test("LCP-9: fusion par id si nom absent", () => {
    const byId: LocalProfiles = { c99: { secteurs: ["test"] } };
    const m = mergeLocalProfile({ id: "c99", nom: "" }, byId);
    expect(m.secteurs).toEqual(["test"]);
  });
});

// -- LCP-C : Priorite Supabase si champ non vide --

describe("LCP-C -- Priorite Supabase sur le fallback local", () => {

  const profiles: LocalProfiles = {
    "Client Test": {
      secteurs:          ["local_s"],
      business_profile:  "Local",
      exclusions_metier: ["local_e"],
      produits:          ["local_p"],
    },
  };

  test("LCP-10: secteurs Supabase non vides -> priorite Supabase", () => {
    const m = mergeLocalProfile(makeClient({ nom: "Client Test", secteurs: ["supa"] }), profiles);
    expect(m.secteurs).toEqual(["supa"]);
  });

  test("LCP-11: business_profile Supabase non vide -> priorite Supabase", () => {
    const m = mergeLocalProfile(makeClient({ nom: "Client Test", business_profile: "Supa" }), profiles);
    expect(m.business_profile).toBe("Supa");
  });

  test("LCP-12: exclusions_metier Supabase non vides -> priorite Supabase", () => {
    const m = mergeLocalProfile(makeClient({ nom: "Client Test", exclusions_metier: ["supa_e"] }), profiles);
    expect(m.exclusions_metier).toEqual(["supa_e"]);
  });

  test("LCP-13: mix -- fusion selective quand certains champs Supabase non vides", () => {
    const m = mergeLocalProfile(
      makeClient({ nom: "Client Test", secteurs: ["supa"], produits: [] }),
      profiles
    );
    expect(m.secteurs).toEqual(["supa"]);
    expect(m.produits).toEqual(["local_p"]);
  });
});

// -- LCP-D : Fallback local si Supabase vide --

describe("LCP-D -- Fallback local quand les champs Supabase sont vides", () => {

  const profiles: LocalProfiles = {
    "TEST PROD - Nettoyage Hygiene": {
      secteurs:          ["nettoyage", "hygiene"],
      types_prestation:  ["entretien"],
      organismes_cibles: ["mairie"],
      exclusions_metier: ["informatique"],
      produits:          ["detergent"],
      specifications:    ["locaux"],
      business_profile:  "Nettoyage",
      technical_profile: "Desinfectants",
    },
  };

  let merged: Record<string, unknown>;
  beforeAll(() => { merged = mergeLocalProfile(makeClient(), profiles); });

  test("LCP-14: secteurs vides -> fallback",         () => { expect(merged.secteurs).toEqual(["nettoyage", "hygiene"]); });
  test("LCP-15: types_prestation vides -> fallback", () => { expect(merged.types_prestation).toEqual(["entretien"]); });
  test("LCP-16: organismes_cibles vides -> fallback",() => { expect(merged.organismes_cibles).toEqual(["mairie"]); });
  test("LCP-17: exclusions_metier vides -> fallback",() => { expect(merged.exclusions_metier).toEqual(["informatique"]); });
  test("LCP-18: produits vides -> fallback",         () => { expect(merged.produits).toEqual(["detergent"]); });
  test("LCP-19: specifications vides -> fallback",   () => { expect(merged.specifications).toEqual(["locaux"]); });
  test("LCP-20: business_profile vide -> fallback",  () => { expect(merged.business_profile).toBe("Nettoyage"); });
});

// -- LCP-E : Invariants + normalisation accent --

describe("LCP-E -- Invariants de securite + normalisation accent", () => {

  const profiles: LocalProfiles = {
    "Client Test": { secteurs: ["nettoyage"], produits: ["detergent"] },
  };

  test("LCP-21: pack, id, nom, criteres non modifies", () => {
    const c = makeClient({ nom: "Client Test", id: "abc", pack: "business",
                           criteres: [{ id: "cr1" }] });
    const m = mergeLocalProfile(c, profiles);
    expect(m.pack).toBe("business");
    expect(m.id).toBe("abc");
    expect(m.nom).toBe("Client Test");
    expect(m.criteres).toEqual([{ id: "cr1" }]);
  });

  test("LCP-22: aucun champ score/threshold/auto_notify ajoute", () => {
    const m = mergeLocalProfile(makeClient({ nom: "Client Test" }), profiles);
    expect(m).not.toHaveProperty("score");
    expect(m).not.toHaveProperty("threshold");
    expect(m).not.toHaveProperty("auto_notify");
  });

  test("LCP-23: objet original non mute", () => {
    const c    = makeClient({ nom: "Client Test" });
    const snap = JSON.stringify(c);
    mergeLocalProfile(c, profiles);
    expect(JSON.stringify(c)).toBe(snap);
  });

  test("LCP-24: idempotent (deux appels successifs = meme resultat)", () => {
    const c     = makeClient({ nom: "Client Test" });
    const once  = mergeLocalProfile(c, profiles);
    const twice = mergeLocalProfile(once as Record<string, unknown>, profiles);
    expect(twice.secteurs).toEqual(once.secteurs);
    expect(twice.produits).toEqual(once.produits);
  });

  test("LCP-25: cle _comment ignoree (pas de crash)", () => {
    const withComment: LocalProfiles = {
      "_comment": { secteurs: ["NE PAS UTILISER"] },
      "Client Test": { secteurs: ["nettoyage"] },
    };
    const m = mergeLocalProfile(makeClient({ nom: "Client Test" }), withComment);
    expect(m.secteurs).toEqual(["nettoyage"]);
  });

  test("LCP-26: nom Supabase accentue matche cle JSON ASCII via normalizeProfileKey", () => {
    // Cle profiles.json ASCII, nom Supabase avec e accent grave (\u00e8 en JS)
    const byAscii: LocalProfiles = {
      "TEST PROD - Nettoyage Hygiene": {
        secteurs:         ["nettoyage", "hygiene"],
        business_profile: "Nettoyage industriel",
      },
    };
    const nom = "TEST PROD - Nettoyage Hygi\u00e8ne"; // e accent grave
    const m = mergeLocalProfile(makeClient({ nom }), byAscii);
    expect(m.secteurs).toEqual(["nettoyage", "hygiene"]);
    expect(m.business_profile).toBe("Nettoyage industriel");
  });

  test("LCP-27: normalizeProfileKey supprime les diacritiques", () => {
    expect(normalizeProfileKey("Hygi\u00e8ne")).toBe("hygiene");
    expect(normalizeProfileKey("D\u00e9sinfection")).toBe("desinfection");
    expect(normalizeProfileKey("  Nettoyage  ")).toBe("nettoyage");
    expect(normalizeProfileKey(42)).toBe("");
  });
});

// -- LCP-F : Multi-profils (GD-046) -- 3 profils dans profiles.json --

describe("LCP-F -- Multi-profils locaux GD-046 : Informatique + Fournitures Bureau", () => {

  test("LCP-28: le profil TEST PROD - Informatique est present dans profiles.json", () => {
    const p = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8")) as LocalProfiles;
    expect(p).toHaveProperty("TEST PROD - Informatique");
  });

  test("LCP-29: le profil TEST PROD - Informatique a les 9 champs obligatoires", () => {
    const p     = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8")) as LocalProfiles;
    const entry = p["TEST PROD - Informatique"]!;
    for (const k of ["business_profile","technical_profile","profile_label",
                     "secteurs","types_prestation","organismes_cibles",
                     "exclusions_metier","produits","specifications"]) {
      expect(entry).toHaveProperty(k);
    }
  });

  test("LCP-30: le profil TEST PROD - Fournitures Bureau est present dans profiles.json", () => {
    const p = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8")) as LocalProfiles;
    expect(p).toHaveProperty("TEST PROD - Fournitures Bureau");
  });

  test("LCP-31: le profil TEST PROD - Fournitures Bureau a les 9 champs obligatoires", () => {
    const p     = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8")) as LocalProfiles;
    const entry = p["TEST PROD - Fournitures Bureau"]!;
    for (const k of ["business_profile","technical_profile","profile_label",
                     "secteurs","types_prestation","organismes_cibles",
                     "exclusions_metier","produits","specifications"]) {
      expect(entry).toHaveProperty(k);
    }
  });

  test("LCP-32: mergeLocalProfile applique le profil Informatique", () => {
    const raw: LocalProfiles = JSON.parse(
      fs.readFileSync(PROFILES_PATH, "utf8")
    ) as LocalProfiles;
    const c = makeClient({ nom: "TEST PROD - Informatique" });
    const m = mergeLocalProfile(c, raw);
    expect(m.secteurs).toContain("informatique");
    expect(Array.isArray(m.secteurs) && (m.secteurs as unknown[]).length).toBeTruthy();
    expect(m.exclusions_metier).toContain("nettoyage");
  });

  test("LCP-33: mergeLocalProfile applique le profil Fournitures Bureau", () => {
    const raw: LocalProfiles = JSON.parse(
      fs.readFileSync(PROFILES_PATH, "utf8")
    ) as LocalProfiles;
    const c = makeClient({ nom: "TEST PROD - Fournitures Bureau" });
    const m = mergeLocalProfile(c, raw);
    expect(m.secteurs).toContain("papeterie");
    expect(Array.isArray(m.produits) && (m.produits as unknown[]).length).toBeTruthy();
    expect(m.exclusions_metier).toContain("nettoyage");
  });

  test("LCP-34: les 3 profils sont charges dans l'index (hors _comment)", () => {
    const raw: LocalProfiles = JSON.parse(
      fs.readFileSync(PROFILES_PATH, "utf8")
    ) as LocalProfiles;
    const idx = buildIndex(raw);
    expect(Object.keys(idx).length).toBe(3);
    expect(idx).toHaveProperty(normalizeProfileKey("TEST PROD - Nettoyage Hygiene"));
    expect(idx).toHaveProperty(normalizeProfileKey("TEST PROD - Informatique"));
    expect(idx).toHaveProperty(normalizeProfileKey("TEST PROD - Fournitures Bureau"));
  });
});


export {};
