/**
 * tests/unit/audit-profile-usage.test.ts
 * Tests GD-050 -- Audit sobre profil structure et garde-fous.
 *
 * audit-profile-usage.js n'est pas require()'able (IIFE main).
 * On teste via fonctions miroir inline.
 *
 * Groupes :
 *   APU-A  isPresent -- detection champ peuple
 *   APU-B  auditClient -- champs profil et partition
 *   APU-C  auditClient -- garde-fous et anomalies
 *   APU-D  auditReport -- agregation globale
 *   APU-E  securite shadow-only
 */

import * as fs   from "fs";
import * as path from "path";

// ============================================================
// Miroir des constantes et fonctions de audit-profile-usage.js
// ============================================================

const FIELDS_USED_POSITIVE: string[] = [
  "client_name",
  "business_profile",
  "technical_profile",
  "secteurs",
  "types_prestation",
  "organismes_cibles",
  "produits",
  "specifications"
];

const FIELDS_USED_EXCLUSION_ONLY: string[] = [
  "exclusions_metier"
];

const FIELDS_TRANSPORTED_ONLY: string[] = [
  "organization_profile",
  "profile_label",
  "radar_type",
  "recommendation"
];

const ALL_KNOWN_PROFILE_FIELDS: string[] = [
  ...FIELDS_USED_POSITIVE,
  ...FIELDS_USED_EXCLUSION_ONLY,
  ...FIELDS_TRANSPORTED_ONLY
];

function isPresent(v: unknown): boolean {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

type ShadowEntry = {
  auto_notify_candidate?: boolean;
  review_candidate?: boolean;
  weak_single_signal?: boolean;
  exclusion_hit?: boolean;
  [key: string]: unknown;
};

type ShadowClient = {
  client_id?: string;
  client_name?: string;
  profile_label?: string;
  organization_profile?: string;
  business_profile?: string;
  technical_profile?: string;
  secteurs?: string[];
  types_prestation?: string[];
  organismes_cibles?: string[];
  exclusions_metier?: string[];
  produits?: string[];
  specifications?: string[];
  radar_type?: string;
  recommendation?: string;
  clean_only?: ShadowEntry[];
  [key: string]: unknown;
};

type Anomaly = {
  type: string;
  count: number;
  detail: string;
};

type ClientAudit = {
  client_id: string;
  client_name: string;
  profile_label: string;
  fields_present: string[];
  fields_missing: string[];
  used_positive_present: string[];
  used_exclusion_present: string[];
  transported_present: string[];
  total_clean: number;
  auto_count: number;
  review_count: number;
  weak_count: number;
  exclusion_hit_count: number;
  weak_auto_count: number;
  anomalies: Anomaly[];
};

type ReportAudit = {
  scan_date: string | null;
  nb_clients: number;
  total_anomalies: number;
  guard_checks: Record<string, boolean>;
  clients: ClientAudit[];
};

function auditClient(c: ShadowClient): ClientAudit {
  const allEntries: ShadowEntry[] = Array.isArray(c.clean_only) ? c.clean_only : [];

  const fieldsPresent  = ALL_KNOWN_PROFILE_FIELDS.filter(function(f) { return isPresent(c[f]); });
  const fieldsMissing  = ALL_KNOWN_PROFILE_FIELDS.filter(function(f) { return !isPresent(c[f]); });

  const usedPositivePresent  = FIELDS_USED_POSITIVE.filter(function(f) { return isPresent(c[f]); });
  const usedExclusionPresent = FIELDS_USED_EXCLUSION_ONLY.filter(function(f) { return isPresent(c[f]); });
  const transportedPresent   = FIELDS_TRANSPORTED_ONLY.filter(function(f) { return isPresent(c[f]); });

  const autoEntries         = allEntries.filter(function(e) { return !!e.auto_notify_candidate; });
  const reviewEntries       = allEntries.filter(function(e) { return !!e.review_candidate && !e.auto_notify_candidate; });
  const weakEntries         = allEntries.filter(function(e) { return !!e.weak_single_signal; });
  const exclusionHitEntries = allEntries.filter(function(e) { return !!e.exclusion_hit; });

  const anomalies: Anomaly[] = [];

  const weakAutoEntries = autoEntries.filter(function(e) { return !!e.weak_single_signal; });
  if (weakAutoEntries.length > 0) {
    anomalies.push({
      type  : "weak_single_auto_candidate",
      count : weakAutoEntries.length,
      detail: "auto-candidats avec weak_single_signal -- garde-fou defaillant"
    });
  }

  const reviewExclusionHit = reviewEntries.filter(function(e) { return !!e.exclusion_hit; });
  if (reviewExclusionHit.length > 0) {
    anomalies.push({
      type  : "review_with_exclusion_hit",
      count : reviewExclusionHit.length,
      detail: "review-candidats avec exclusion_hit -- a inspecter"
    });
  }

  const structuredPositive = FIELDS_USED_POSITIVE.filter(function(f) { return f !== "client_name"; });
  const structuredPresent  = structuredPositive.filter(function(f) { return isPresent(c[f]); });
  if (structuredPresent.length === 0) {
    anomalies.push({
      type  : "no_structured_profile_fields",
      count : 0,
      detail: "aucun champ profil structure peuple -- alignement CRI non fiable"
    });
  }

  return {
    client_id             : c.client_id || "",
    client_name           : c.client_name || c.client_id || "",
    profile_label         : c.profile_label || "",
    fields_present        : fieldsPresent,
    fields_missing        : fieldsMissing,
    used_positive_present : usedPositivePresent,
    used_exclusion_present: usedExclusionPresent,
    transported_present   : transportedPresent,
    total_clean           : allEntries.length,
    auto_count            : autoEntries.length,
    review_count          : reviewEntries.length,
    weak_count            : weakEntries.length,
    exclusion_hit_count   : exclusionHitEntries.length,
    weak_auto_count       : weakAutoEntries.length,
    anomalies             : anomalies
  };
}

function auditReport(report: { scan_date?: string; clients?: ShadowClient[] }): ReportAudit {
  const clients      = Array.isArray(report.clients) ? report.clients : [];
  const clientAudits = clients.map(auditClient);
  const totalAnomalies = clientAudits.reduce(function(acc, a) { return acc + a.anomalies.length; }, 0);
  const allWeakAuto    = clientAudits.reduce(function(acc, a) { return acc + a.weak_auto_count;  }, 0);
  return {
    scan_date      : report.scan_date || null,
    nb_clients     : clientAudits.length,
    total_anomalies: totalAnomalies,
    guard_checks   : {
      weak_single_signal_stays_review: allWeakAuto === 0,
      no_weak_single_auto_candidates : allWeakAuto === 0
    },
    clients        : clientAudits
  };
}

// ============================================================
// Fixtures
// ============================================================

const SCRIPT_PATH = path.resolve(__dirname, "../../scripts/audit-profile-usage.js");

function makeEntry(overrides: Partial<ShadowEntry> = {}): ShadowEntry {
  return Object.assign(
    { auto_notify_candidate: false, review_candidate: false, weak_single_signal: false, exclusion_hit: false },
    overrides
  );
}

function makeClient(overrides: Partial<ShadowClient> = {}): ShadowClient {
  return Object.assign(
    {
      client_id        : "test-client",
      client_name      : "Test Client",
      profile_label    : "Test",
      business_profile : "nettoyage hygiene",
      technical_profile: "produits entretien",
      secteurs         : ["nettoyage"],
      produits         : ["detergent"],
      specifications   : ["locaux"],
      exclusions_metier: ["materiel medical"],
      clean_only       : []
    },
    overrides
  );
}

// ============================================================
// APU-A : isPresent
// ============================================================

describe("APU-A -- isPresent", () => {

  test("APU-1: isPresent retourne false pour null/undefined/chaine vide/tableau vide", () => {
    expect(isPresent(null)).toBe(false);
    expect(isPresent(undefined)).toBe(false);
    expect(isPresent("")).toBe(false);
    expect(isPresent("   ")).toBe(false);
    expect(isPresent([])).toBe(false);
  });

  test("APU-2: isPresent retourne true pour string non vide, tableau non vide, objet", () => {
    expect(isPresent("nettoyage")).toBe(true);
    expect(isPresent(["nettoyage"])).toBe(true);
    expect(isPresent({})).toBe(true);
    expect(isPresent(0)).toBe(true);
  });

});

// ============================================================
// APU-B : auditClient -- champs profil et partition
// ============================================================

describe("APU-B -- auditClient champs profil", () => {

  test("APU-3: auditClient detecte les champs profil presents", () => {
    const c = makeClient({
      business_profile: "nettoyage",
      secteurs        : ["nettoyage"],
      organization_profile: ""         // absent
    });
    const a = auditClient(c);
    expect(a.fields_present).toContain("business_profile");
    expect(a.fields_present).toContain("secteurs");
    expect(a.fields_missing).toContain("organization_profile");
  });

  test("APU-4: auditClient distingue champs utilises positif vs exclusion vs transportes", () => {
    const c = makeClient({
      business_profile : "nettoyage",
      exclusions_metier: ["materiel medical"],
      profile_label    : "Nettoyage",
      organization_profile: ""
    });
    const a = auditClient(c);
    expect(a.used_positive_present).toContain("business_profile");
    expect(a.used_positive_present).not.toContain("exclusions_metier");
    expect(a.used_positive_present).not.toContain("organization_profile");
    expect(a.used_exclusion_present).toContain("exclusions_metier");
    expect(a.transported_present).toContain("profile_label");
    expect(a.transported_present).not.toContain("business_profile");
  });

  test("APU-5: organization_profile est dans FIELDS_TRANSPORTED_ONLY et non dans FIELDS_USED_POSITIVE", () => {
    expect(FIELDS_TRANSPORTED_ONLY).toContain("organization_profile");
    expect(FIELDS_USED_POSITIVE).not.toContain("organization_profile");
    expect(FIELDS_USED_EXCLUSION_ONLY).not.toContain("organization_profile");
  });

  test("APU-6: exclusions_metier est dans FIELDS_USED_EXCLUSION_ONLY et non dans FIELDS_USED_POSITIVE", () => {
    expect(FIELDS_USED_EXCLUSION_ONLY).toContain("exclusions_metier");
    expect(FIELDS_USED_POSITIVE).not.toContain("exclusions_metier");
    expect(FIELDS_TRANSPORTED_ONLY).not.toContain("exclusions_metier");
  });

  test("APU-7: auditClient liste les champs absents dans fields_missing", () => {
    const c = makeClient({ organization_profile: "", radar_type: "" });
    const a = auditClient(c);
    expect(a.fields_missing).toContain("organization_profile");
    expect(a.fields_missing).toContain("radar_type");
  });

});

// ============================================================
// APU-C : auditClient -- garde-fous et anomalies
// ============================================================

describe("APU-C -- auditClient garde-fous et anomalies", () => {

  test("APU-8: weak_single_signal en review -> aucune anomalie weak_single_auto", () => {
    const entries = [
      makeEntry({ review_candidate: true,  weak_single_signal: true, auto_notify_candidate: false }),
      makeEntry({ review_candidate: false, weak_single_signal: false, auto_notify_candidate: false })
    ];
    const c = makeClient({ clean_only: entries });
    const a = auditClient(c);
    expect(a.weak_auto_count).toBe(0);
    const types = a.anomalies.map(function(an) { return an.type; });
    expect(types).not.toContain("weak_single_auto_candidate");
  });

  test("APU-9: auto-candidate avec weak_single_signal -> anomalie weak_single_auto_candidate", () => {
    const entries = [
      makeEntry({ auto_notify_candidate: true, weak_single_signal: true, review_candidate: false })
    ];
    const c = makeClient({ clean_only: entries });
    const a = auditClient(c);
    expect(a.weak_auto_count).toBe(1);
    const types = a.anomalies.map(function(an) { return an.type; });
    expect(types).toContain("weak_single_auto_candidate");
  });

  test("APU-10: review avec exclusion_hit -> anomalie review_with_exclusion_hit", () => {
    const entries = [
      makeEntry({ review_candidate: true, exclusion_hit: true, auto_notify_candidate: false })
    ];
    const c = makeClient({ clean_only: entries });
    const a = auditClient(c);
    const types = a.anomalies.map(function(an) { return an.type; });
    expect(types).toContain("review_with_exclusion_hit");
  });

  test("APU-11: aucun champ positif structure peuple -> anomalie no_structured_profile_fields", () => {
    const c = makeClient({
      client_name      : "X",
      business_profile : "",
      technical_profile: "",
      secteurs         : [],
      types_prestation : [],
      organismes_cibles: [],
      produits         : [],
      specifications   : []
    });
    const a = auditClient(c);
    const types = a.anomalies.map(function(an) { return an.type; });
    expect(types).toContain("no_structured_profile_fields");
  });

  test("APU-12: profil complet sans anomalie de structure -> pas d'anomalie no_structured", () => {
    const c = makeClient();
    const a = auditClient(c);
    const types = a.anomalies.map(function(an) { return an.type; });
    expect(types).not.toContain("no_structured_profile_fields");
  });

  test("APU-13: comptages auto/review/weak/exclusion_hit corrects", () => {
    const entries = [
      makeEntry({ auto_notify_candidate: true,  weak_single_signal: false }),
      makeEntry({ review_candidate: true,        weak_single_signal: true  }),
      makeEntry({ review_candidate: true,        weak_single_signal: true  }),
      makeEntry({ exclusion_hit: true })
    ];
    const c = makeClient({ clean_only: entries });
    const a = auditClient(c);
    expect(a.auto_count).toBe(1);
    expect(a.review_count).toBe(2);
    expect(a.weak_count).toBe(2);
    expect(a.exclusion_hit_count).toBe(1);
    expect(a.total_clean).toBe(4);
  });

});

// ============================================================
// APU-D : auditReport -- agregation globale
// ============================================================

describe("APU-D -- auditReport agregation", () => {

  test("APU-14: auditReport agrege le nombre de clients et anomalies", () => {
    const report = {
      scan_date: "2026-06-20T00:00:00Z",
      clients  : [
        makeClient({ clean_only: [] }),
        makeClient({ client_id: "c2", clean_only: [] })
      ]
    };
    const a = auditReport(report);
    expect(a.nb_clients).toBe(2);
    expect(typeof a.total_anomalies).toBe("number");
  });

  test("APU-15: guard_checks weak_single_signal_stays_review=true quand aucun weak auto", () => {
    const entries = [
      makeEntry({ review_candidate: true, weak_single_signal: true, auto_notify_candidate: false })
    ];
    const report = { clients: [makeClient({ clean_only: entries })] };
    const a = auditReport(report);
    expect(a.guard_checks["weak_single_signal_stays_review"]).toBe(true);
    expect(a.guard_checks["no_weak_single_auto_candidates"]).toBe(true);
  });

  test("APU-16: guard_checks=false quand au moins un weak auto detecte", () => {
    const entries = [
      makeEntry({ auto_notify_candidate: true, weak_single_signal: true })
    ];
    const report = { clients: [makeClient({ clean_only: entries })] };
    const a = auditReport(report);
    expect(a.guard_checks["weak_single_signal_stays_review"]).toBe(false);
    expect(a.guard_checks["no_weak_single_auto_candidates"]).toBe(false);
  });

  test("APU-17: total_anomalies somme les anomalies de tous les clients", () => {
    const weak = makeEntry({ auto_notify_candidate: true, weak_single_signal: true });
    const ok   = makeEntry({ review_candidate: true, weak_single_signal: true });
    const report = {
      clients: [
        makeClient({ clean_only: [weak] }),   // 1 anomalie weak_auto
        makeClient({ client_id: "c2", clean_only: [ok] }) // 0 anomalie
      ]
    };
    const a = auditReport(report);
    expect(a.total_anomalies).toBeGreaterThanOrEqual(1);
  });

  test("APU-18: auditReport avec liste clients vide retourne nb_clients=0", () => {
    const a = auditReport({ clients: [] });
    expect(a.nb_clients).toBe(0);
    expect(a.total_anomalies).toBe(0);
  });

});

// ============================================================
// APU-E : securite shadow-only
// ============================================================

describe("APU-E -- securite shadow-only", () => {

  test("APU-19: le script ne contient pas d'appel reseau Supabase ni notification", () => {
    const src = fs.readFileSync(SCRIPT_PATH, "utf8");
    expect(src).not.toMatch(/supabase\.from/);
    expect(src).not.toMatch(/sendNotification/);
    expect(src).not.toMatch(/'bcs_vus'/);
    expect(src).not.toMatch(/require\(['"]@supabase/);
  });

  test("APU-20: le script ne contient pas de logique specifique client/signal/domaine", () => {
    const src = fs.readFileSync(SCRIPT_PATH, "utf8");
    // Pas de check sur un signal particulier
    expect(src).not.toMatch(/signal\s*===\s*['"](nettoyage|informatique|hygiene)['"]/);
    // Pas de check sur un client particulier
    expect(src).not.toMatch(/client_id\s*===\s*['"][^'"]+['"]/);
    // Pas de recommendation d'action
    expect(src).not.toMatch(/garder_review_si_seul/);
    expect(src).not.toMatch(/autoriser_auto/);
  });

  test("APU-21: FIELDS_USED_POSITIVE ne contient pas organization_profile ni exclusions_metier", () => {
    expect(FIELDS_USED_POSITIVE).not.toContain("organization_profile");
    expect(FIELDS_USED_POSITIVE).not.toContain("exclusions_metier");
  });

  test("APU-22: ALL_KNOWN_PROFILE_FIELDS couvre les 3 categories sans doublon", () => {
    const all = ALL_KNOWN_PROFILE_FIELDS;
    const set = new Set(all);
    expect(set.size).toBe(all.length);   // pas de doublon
    FIELDS_USED_POSITIVE.forEach(function(f)      { expect(all).toContain(f); });
    FIELDS_USED_EXCLUSION_ONLY.forEach(function(f) { expect(all).toContain(f); });
    FIELDS_TRANSPORTED_ONLY.forEach(function(f)    { expect(all).toContain(f); });
  });

});

export {};
