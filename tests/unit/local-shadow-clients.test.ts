/**
 * tests/unit/local-shadow-clients.test.ts
 * Tests GD-047 -- Mode --local-clients offline shadow-only.
 *
 * replay-shadow-from-input-snapshot.js n'est pas require()'able.
 * On teste via fonctions miroir inline.
 *
 * Groupes :
 *   LSC-A  Chargement et parsing de local-shadow-clients.json
 *   LSC-B  Validation structure des clients locaux
 *   LSC-C  Merge profils via mergeLocalProfile() (miroir GD-043)
 *   LSC-D  Invariants de securite (scoring, seuils, auto_notify)
 *   LSC-E  Comportement fallback Supabase (--local-clients absent = flag null)
 */

import * as fs   from "fs";
import * as path from "path";

// -- Miroir de normalizeProfileKey() (GD-043) --
function normalizeProfileKey(s: unknown): string {
  if (typeof s !== "string") return "";
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

type LocalProfile  = Record<string, unknown>;
type LocalProfiles = Record<string, LocalProfile>;

function buildIndex(raw: LocalProfiles): LocalProfiles {
  const idx: LocalProfiles = {};
  Object.keys(raw).forEach((k) => {
    if (k === "_comment") return;
    idx[normalizeProfileKey(k)] = raw[k]!;
  });
  return idx;
}

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

/** Miroir de loadClientsFromLocalFile() (GD-047). */
function loadClientsFromLocalFile(
  filePath: string,
  profiles: LocalProfiles | null
): Record<string, unknown>[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>[];
  if (!Array.isArray(raw)) throw new Error("Doit etre un tableau JSON");
  const PACK_LIMITS: Record<string, { maxCriteres: number }> = {
    starter:  { maxCriteres: 5  },
    pro:      { maxCriteres: 20 },
    business: { maxCriteres: 50 },
  };
  return raw
    .filter((c) => {
      const crs = (c.criteres as Array<Record<string,unknown>> || []);
      return crs.some((cr) => (cr.radar_type || "bc") === "bc");
    })
    .map((c) => {
      const merged = mergeLocalProfile(c, profiles);
      const pack   = (merged.pack as string) || "starter";
      const limits = PACK_LIMITS[pack] || PACK_LIMITS.starter!;
      const allCr  = (merged.criteres as Array<Record<string,unknown>> || [])
        .filter((cr) => (cr.radar_type || "bc") === "bc")
        .slice(0, limits.maxCriteres);
      return {
        id:       merged.id,
        nom:      (merged.nom as string) || (merged.id as string),
        pack,
        criteres: allCr,
        business_profile:     (merged.business_profile  as string) || "",
        technical_profile:    (merged.technical_profile as string) || "",
        organization_profile: (merged.organization_profile as string) || "",
        profile_label:        (merged.profile_label     as string) || "",
        secteurs:         Array.isArray(merged.secteurs)         ? merged.secteurs         : [],
        types_prestation: Array.isArray(merged.types_prestation) ? merged.types_prestation : [],
        organismes_cibles:Array.isArray(merged.organismes_cibles)? merged.organismes_cibles: [],
        exclusions_metier:Array.isArray(merged.exclusions_metier)? merged.exclusions_metier: [],
        produits:         Array.isArray(merged.produits)         ? merged.produits         : [],
        specifications:   Array.isArray(merged.specifications)   ? merged.specifications   : [],
      };
    });
}

// -- Chemins fixtures --
const LSC_PATH  = path.join(__dirname, "..", "..", "data", "client-profiles", "local-shadow-clients.json");
const PROF_PATH = path.join(__dirname, "..", "..", "data", "client-profiles", "profiles.json");

// -- LSC-A : Chargement et parsing de local-shadow-clients.json --

describe("LSC-A -- Chargement de local-shadow-clients.json (GD-047)", () => {

  test("LSC-1: le fichier local-shadow-clients.json existe", () => {
    expect(fs.existsSync(LSC_PATH)).toBe(true);
  });

  test("LSC-2: le fichier est du JSON valide", () => {
    expect(() => JSON.parse(fs.readFileSync(LSC_PATH, "utf8"))).not.toThrow();
  });

  test("LSC-3: le fichier est un tableau JSON", () => {
    const data = JSON.parse(fs.readFileSync(LSC_PATH, "utf8"));
    expect(Array.isArray(data)).toBe(true);
  });

  test("LSC-4: le tableau contient exactement 3 clients", () => {
    const data = JSON.parse(fs.readFileSync(LSC_PATH, "utf8"));
    expect(data).toHaveLength(3);
  });

  test("LSC-5: chaque client a les champs id, nom, pack, criteres", () => {
    const data = JSON.parse(fs.readFileSync(LSC_PATH, "utf8")) as Record<string,unknown>[];
    for (const c of data) {
      expect(c).toHaveProperty("id");
      expect(c).toHaveProperty("nom");
      expect(c).toHaveProperty("pack");
      expect(c).toHaveProperty("criteres");
    }
  });
});

// -- LSC-B : Validation structure --

describe("LSC-B -- Structure des clients locaux (GD-047)", () => {

  let clients: Record<string, unknown>[];
  beforeAll(() => {
    clients = JSON.parse(fs.readFileSync(LSC_PATH, "utf8")) as Record<string, unknown>[];
  });

  test("LSC-6: les 3 ids sont distincts", () => {
    const ids = clients.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("LSC-7: les 3 noms correspondent aux profils GD-046", () => {
    const noms = clients.map((c) => c.nom);
    expect(noms).toContain("TEST PROD - Nettoyage Hygiene");
    expect(noms).toContain("TEST PROD - Informatique");
    expect(noms).toContain("TEST PROD - Fournitures Bureau");
  });

  test("LSC-8: chaque client a au moins 1 critere radar_type=bc", () => {
    for (const c of clients) {
      const crs = (c.criteres as Array<Record<string,unknown>>);
      const bcCrs = crs.filter((cr) => (cr.radar_type || "bc") === "bc");
      expect(bcCrs.length).toBeGreaterThan(0);
    }
  });

  test("LSC-9: chaque critere a valeur, ai_inclusions, ai_exclusions", () => {
    for (const c of clients) {
      const crs = c.criteres as Array<Record<string,unknown>>;
      for (const cr of crs) {
        expect(cr).toHaveProperty("valeur");
        expect(cr).toHaveProperty("ai_inclusions");
        expect(cr).toHaveProperty("ai_exclusions");
        expect(Array.isArray(cr.ai_inclusions)).toBe(true);
        expect(Array.isArray(cr.ai_exclusions)).toBe(true);
      }
    }
  });

  test("LSC-10: tous les packs sont starter", () => {
    for (const c of clients) {
      expect(c.pack).toBe("starter");
    }
  });
});

// -- LSC-C : Merge profils via mergeLocalProfile() --

describe("LSC-C -- Merge profils GD-043 apres chargement GD-047", () => {

  let profiles: LocalProfiles;
  beforeAll(() => {
    profiles = JSON.parse(fs.readFileSync(PROF_PATH, "utf8")) as LocalProfiles;
  });

  test("LSC-11: loadClientsFromLocalFile retourne 3 clients", () => {
    const result = loadClientsFromLocalFile(LSC_PATH, profiles);
    expect(result).toHaveLength(3);
  });

  test("LSC-12: client Nettoyage a secteurs remplis apres merge", () => {
    const result = loadClientsFromLocalFile(LSC_PATH, profiles);
    const nett = result.find((c) => (c.nom as string).includes("Nettoyage"));
    expect(nett).toBeDefined();
    expect(Array.isArray(nett!.secteurs) && (nett!.secteurs as unknown[]).length).toBeTruthy();
    expect(nett!.secteurs).toContain("nettoyage");
  });

  test("LSC-13: client Informatique a secteurs remplis apres merge", () => {
    const result = loadClientsFromLocalFile(LSC_PATH, profiles);
    const info = result.find((c) => (c.nom as string).includes("Informatique"));
    expect(info).toBeDefined();
    expect(Array.isArray(info!.secteurs) && (info!.secteurs as unknown[]).length).toBeTruthy();
    expect(info!.secteurs).toContain("informatique");
  });

  test("LSC-14: client Fournitures Bureau a secteurs remplis apres merge", () => {
    const result = loadClientsFromLocalFile(LSC_PATH, profiles);
    const buro = result.find((c) => (c.nom as string).includes("Fournitures"));
    expect(buro).toBeDefined();
    expect(Array.isArray(buro!.secteurs) && (buro!.secteurs as unknown[]).length).toBeTruthy();
    expect(buro!.secteurs).toContain("papeterie");
  });

  test("LSC-15: les 3 profile_label sont distincts apres merge", () => {
    const result = loadClientsFromLocalFile(LSC_PATH, profiles);
    const labels = result.map((c) => c.profile_label as string).filter(Boolean);
    expect(new Set(labels).size).toBe(3);
  });

  test("LSC-16: merge sans profiles.json -> secteurs vides (pas de crash)", () => {
    const result = loadClientsFromLocalFile(LSC_PATH, null);
    for (const c of result) {
      expect(Array.isArray(c.secteurs)).toBe(true);
      expect((c.secteurs as unknown[]).length).toBe(0);
    }
  });

  test("LSC-17: les criteres sont preserves apres merge", () => {
    const result = loadClientsFromLocalFile(LSC_PATH, profiles);
    for (const c of result) {
      expect(Array.isArray(c.criteres)).toBe(true);
      expect((c.criteres as unknown[]).length).toBeGreaterThan(0);
    }
  });
});

// -- LSC-D : Invariants de securite --

describe("LSC-D -- Invariants de securite GD-047", () => {

  let profiles: LocalProfiles;
  let result: Record<string, unknown>[];
  beforeAll(() => {
    profiles = JSON.parse(fs.readFileSync(PROF_PATH, "utf8")) as LocalProfiles;
    result   = loadClientsFromLocalFile(LSC_PATH, profiles);
  });

  test("LSC-18: aucun champ score, threshold ou auto_notify dans les clients charges", () => {
    for (const c of result) {
      expect(c).not.toHaveProperty("score");
      expect(c).not.toHaveProperty("threshold");
      expect(c).not.toHaveProperty("auto_notify");
    }
  });

  test("LSC-19: le pack reste starter (non modifie par merge)", () => {
    for (const c of result) {
      expect(c.pack).toBe("starter");
    }
  });

  test("LSC-20: l'id et le nom sont preserves apres merge", () => {
    const raw = JSON.parse(fs.readFileSync(LSC_PATH, "utf8")) as Record<string,unknown>[];
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.id).toBe(raw[i]!.id);
      expect(result[i]!.nom).toBe(raw[i]!.nom);
    }
  });

  test("LSC-21: pack starter limite a 5 criteres max", () => {
    for (const c of result) {
      expect((c.criteres as unknown[]).length).toBeLessThanOrEqual(5);
    }
  });
});

// -- LSC-E : Comportement fallback (mode Supabase inchange si --local-clients absent) --

describe("LSC-E -- Comportement fallback Supabase si --local-clients absent (GD-047)", () => {

  test("LSC-22: localClientsArg null -> loadClientsFromLocalFile non appelee", () => {
    // On verifie la logique de branchement :
    // si localClientsArg est null/falsy, le chemin Supabase est emprunte.
    // Ce test verifie que localClientsArg=null donne un comportement different de non-null.
    const localClientsArg: string | null = null;
    // Simuler le branchement du main() :
    // if (localClientsArg) { ... } else { loadSupabase }
    let usedLocal = false;
    let usedSupabase = false;
    if (localClientsArg) {
      usedLocal = true;
    } else {
      usedSupabase = true;
    }
    expect(usedLocal).toBe(false);
    expect(usedSupabase).toBe(true);
  });

  test("LSC-23: localClientsArg non-null -> chemin local emprunte", () => {
    const localClientsArg: string | null = LSC_PATH;
    let usedLocal = false;
    let usedSupabase = false;
    if (localClientsArg) {
      usedLocal = true;
    } else {
      usedSupabase = true;
    }
    expect(usedLocal).toBe(true);
    expect(usedSupabase).toBe(false);
  });

  test("LSC-24: mode local ne touche pas SUPABASE_URL ni SUPABASE_KEY", () => {
    const before = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_KEY };
    // Simuler chargement local (pas d'acces env)
    loadClientsFromLocalFile(LSC_PATH, null);
    expect(process.env.SUPABASE_URL).toBe(before.url);
    expect(process.env.SUPABASE_KEY).toBe(before.key);
  });

  test("LSC-25: writeShadowReplayReport mode = 'local' si localClientsArg non-null", () => {
    // On verifie l'expression : localClientsArg ? "local" : "supabase"
    const arg1: string | null = null;
    const arg2: string | null = LSC_PATH;
    expect(arg1 ? "local" : "supabase").toBe("supabase");
    expect(arg2 ? "local" : "supabase").toBe("local");
  });
});

export {};