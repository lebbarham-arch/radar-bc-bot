"use strict";

require("dotenv").config();
const fs        = require("fs");
const path      = require("path");
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
const cron      = require("node-cron");
const fetch     = require("node-fetch");
let pdfParse;
try { pdfParse = require("pdf-parse"); } catch(e) { pdfParse = null; }
let AdmZip;
try { AdmZip = require("adm-zip"); } catch(e) { AdmZip = null; }

// GD-078 : helpers purs pour liens feedback avec raison client (flag desactive par defaut)
const _fbl = require("./scripts/feedback-links-builder");
// GD-080 : fonctions pures feedback extraites pour tests isoles
const _fbh = require("./scripts/feedback-handler");
const _fbs = require("./scripts/feedback-signature");  // GD-085 : signature HMAC optionnelle

puppeteer.use(Stealth());

const CFG = {
  sbUrl:        process.env.SUPABASE_URL          || "",
  sbKey:        process.env.SUPABASE_KEY          || "",
  login:        process.env.PORTAL_LOGIN          || "",
  password:     process.env.PORTAL_PASSWORD       || "",
  tgToken:      (process.env.TELEGRAM_BOT_TOKEN || "").trim(),
  anthropicKey: process.env.ANTHROPIC_API_KEY     || "",
  ollamaUrl:    process.env.OLLAMA_URL            || "",
  ollamaModel:  process.env.OLLAMA_MODEL          || "qwen2.5:32b",
  resendKey:    process.env.RESEND_API_KEY        || "",
  fromEmail:    process.env.FROM_EMAIL            || "radar@radarmarchesmaroc.ma",
  feedbackUrl:     process.env.FEEDBACK_BASE_URL        || "",
  feedbackAllowed: (process.env.FEEDBACK_ALLOWED_CLIENTS || "")
    .split(",").map(function(s) { return s.trim(); }).filter(Boolean),
  feedbackSigningSecret: process.env.FEEDBACK_SIGNING_SECRET || "",  // GD-085
  // BC - Bons de Commande
  bcListUrl:  "https://www.marchespublics.gov.ma/bdc/entreprise/consultation/",
  bcLoginUrl: "https://www.marchespublics.gov.ma/index.php?page=entreprise.EntrepriseHome",
  // MP - Marches Publics (Appels d'Offres)
  mpListUrl:  "https://www.marchespublics.gov.ma/index.php?page=entreprise.EntrepriseAdvancedSearch&AllCons&EnCours&searchAnnCons",
  mpLoginUrl: "https://www.marchespublics.gov.ma/index.php?page=entreprise.EntrepriseHome",
};

// ============================================================
// LIMITES PAR PACK
// ============================================================
// ============================================================
// FEATURE FLAGS
// ============================================================
const FEATURES = {
  enableMP: false,  // Radar MP desactive en v1 — BC uniquement
};

const PACK_LIMITS = {
  starter:  { maxCriteres: 5,  hasWhatsApp: false, hasAIValidation: false },
  pro:      { maxCriteres: 20, hasWhatsApp: true,  hasAIValidation: true  },
  business: { maxCriteres: 50, hasWhatsApp: true,  hasAIValidation: true  },
};

function getPackLimits(client) {
  const pack = client.pack || "starter";
  return PACK_LIMITS[pack] || PACK_LIMITS.starter;
}

function getCriteresCapped(client, radarType) {
  // MP desactive globalement en v1
  if (radarType === "mp" && !FEATURES.enableMP) return [];
  const limits = getPackLimits(client);
  const all = (client.criteres || []).filter(c => (c.radar_type || "bc") === radarType);
  return all.slice(0, limits.maxCriteres);
}

const delay     = ms     => new Promise(r => setTimeout(r, ms));
const randDelay = (a, b) => delay(Math.floor(Math.random() * (b - a)) + a);
const log       = msg    => console.log("[" + new Date().toLocaleTimeString("fr-MA") + "] " + msg);

// ============================================================
// CACHE LLM — Supabase (persistant) + JSON local (fallback)
// La table ai_cache persiste entre les redémarrages Fly.io.
// Le fichier JSON sert de fallback si Supabase est KO.
// ============================================================
const AI_CACHE_FILE = path.join(__dirname, "ai_cache.json");
const AI_CACHE = {};   // cache mémoire (clé=norm(valeur))

function _loadCacheFromFile() {
  try {
    if (fs.existsSync(AI_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(AI_CACHE_FILE, "utf8"));
      Object.assign(AI_CACHE, data);
      log("[Cache] " + Object.keys(data).length + " entrées chargées depuis ai_cache.json (fallback)");
    }
  } catch (e) { log("[Cache] Erreur lecture JSON: " + e.message); }
}

function _saveCacheToFile() {
  try { fs.writeFileSync(AI_CACHE_FILE, JSON.stringify(AI_CACHE, null, 2), "utf8"); }
  catch (e) { log("[Cache] Erreur écriture JSON: " + e.message); }
}

async function loadCacheFromSupabase() {
  try {
    const r = await fetch(CFG.sbUrl + "/rest/v1/ai_cache?select=cache_key,valeur,inclusions,exclusions", {
      headers: { "apikey": CFG.sbKey, "Authorization": "Bearer " + CFG.sbKey },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const rows = await r.json();
    for (const row of rows) {
      AI_CACHE[row.cache_key] = { valeur: row.valeur, inclusions: row.inclusions, exclusions: row.exclusions };
    }
    log("[Cache] " + rows.length + " entrées chargées depuis Supabase ai_cache");
    _saveCacheToFile(); // sync fichier local
  } catch (e) {
    log("[Cache] Supabase KO (" + e.message + "), utilisation fallback JSON");
    _loadCacheFromFile();
  }
}

async function saveCacheEntry(key, entry) {
  // 1. Toujours sauvegarder en mémoire + fichier
  AI_CACHE[key] = entry;
  _saveCacheToFile();
  // 2. Upsert dans Supabase
  try {
    await fetch(CFG.sbUrl + "/rest/v1/ai_cache", {
      method: "POST",
      headers: {
        "apikey": CFG.sbKey, "Authorization": "Bearer " + CFG.sbKey,
        "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        cache_key:  key,
        valeur:     entry.valeur,
        inclusions: entry.inclusions,
        exclusions: entry.exclusions || [],
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) { log("[Cache] Erreur upsert Supabase: " + e.message); }
}

// Chargement initial (appelé au démarrage après init CFG)
_loadCacheFromFile(); // synchrone, immédiat

// ============================================================
// NORMALISATION & MATCHING
// ============================================================
function norm(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Frontiere de mot : "eau" matche "eau","eaux" mais PAS "carreaux","bureau"
function hasKw(text, kw) {
  const nk = norm(kw);
  if (!nk) return false;
  const esc = nk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("\\b" + esc).test(norm(text));
}


// Fuzzy matching (Levenshtein) pour corriger erreurs OCR
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}
function hasKwFuzzy(text, kw) {
  if (hasKw(text, kw)) return true;
  const nk = norm(kw);
  if (nk.length <= 5) return false; // GD-021 : mots courts <= 5 chars = exact seulement (evite toner/tuner)
  const maxDist = nk.length >= 8 ? 2 : 1;
  return norm(text).split(/\s+/).some(w =>
    Math.abs(w.length - nk.length) <= maxDist + 1 &&
    w[0] === nk[0] && // GD-022 : premiere lettre doit correspondre (evite patisserie/tapisserie)
    levenshtein(w, nk) <= maxDist
  );
}
function hasAnyKw(text, terms) {
  return (terms || []).some(t => hasKwFuzzy(text, t));
}

/**
 * Détecte si un texte signale l'annulation de l'avis lui-même.
 * Patterns : "décision d'annulation", "annulation de l'avis d'achat", etc.
 * Guard : "non annulable" ou "condition d'annulation" ne déclenchent PAS.
 * @param {string} text — texte brut ou normalisé à tester
 * @returns {boolean} true si l'avis est annulé
 */
function isCancelledNotice(text) {
  if (!text) return false;
  const n = norm(text);
  const CANCEL_PATTERNS = [
    "decision d annulation",
    "annulation de l avis d achat",
    "annulation de l avis",
    "avis d achat annule",
    "avis d achat est annule",
    "avis annule",
    "l avis est annule",
  ];
  for (const pat of CANCEL_PATTERNS) {
    const idx = n.indexOf(pat);
    if (idx === -1) continue;
    // Guard : "non <pattern>" ne doit pas déclencher
    const before = n.slice(Math.max(0, idx - 5), idx);
    if (before.trimEnd().endsWith("non")) continue;
    return true;
  }
  return false;
}

function isEnCours(item) {
  if (norm(item.objet || "").includes("annul")) return false;
  // Verifier aussi le bodyText pour les avis annules publis en page de detail (ex: BC 346623)
  if (isCancelledNotice((item.bodyText || "") + " " + (item.objet || ""))) return false;
  if (item.date_limite) {
    // Format attendu : DD/MM/YYYY ou DD/MM/YYYY HH:mm (heure locale marocaine)
    // NE PAS utiliser new Date(string) : les formats DD/MM/YYYY ne sont pas ISO et seraient mal parsed.
    const m = item.date_limite.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[T\s]+(\d{1,2}):(\d{2}))?/);
    if (m) {
      const day = parseInt(m[1], 10);
      const mon = parseInt(m[2], 10) - 1; // 0-based
      const yr  = parseInt(m[3], 10);
      // Si heure absente : fin de journee (23:59) pour ne pas expirer un BC le jour meme sans heure
      const hh  = m[4] !== undefined ? parseInt(m[4], 10) : 23;
      const mn  = m[5] !== undefined ? parseInt(m[5], 10) : 59;
      const deadline = new Date(yr, mon, day, hh, mn, 0, 0);
      if (deadline < new Date()) return false;
    }
  }
  return true;
}

// ============================================================
// MATCHING CRITERES
// v8.1 : utilise ai_inclusions/ai_exclusions + fuzzy matching
// ============================================================
function matchCritere(item, c) {
  const incl = LEGACY_USE_AI_INCLUSIONS
    ? [c.valeur, ...(c.ai_inclusions || [])]
    : [c.valeur];
  const excl = c.ai_exclusions || [];
  switch (c.type) {
    case "region":
      return hasKw(item.wilaya, c.valeur) || hasKw(item.lieu, c.valeur);
    case "organisme":
      return hasKw(item.organisme, c.valeur);
    case "titre": {
      const text = (item.objet || "") + " " + (item._keyword || "");
      if (excl.length && excl.some(t => hasKw(text, t))) return false;
      return hasAnyKw(text, incl);
    }
    case "contenu": {
      const text = (item.articles || [])
          .map(a => (a.designation || "") + " " + (a.specifications || "")).join(" ")
        + " " + (item.bodyText || "")
        + " " + (item.objet || "")
        + " " + (item._keyword || "");
      if (excl.length && excl.some(t => hasKw(text, t))) return false;
      return hasAnyKw(text, incl);
    }
    default: return false;
  }
}

function itemMatchesCriteres(item, criteres) { return criteres.some(c => matchCritere(item, c)); }
function getMatchedCriteres(item, criteres)  { return criteres.filter(c => matchCritere(item, c)); }

// Retourne quel terme précis a déclenché le match (keyword ou enrichissement IA)
function getMatchTrigger(item, c) {
  if (!c) return null;
  if (c.type === "region")    return { keyword: c.valeur, trigger: c.valeur, isEnrichissement: false };
  if (c.type === "organisme") return { keyword: c.valeur, trigger: c.valeur, isEnrichissement: false };
  const incl = LEGACY_USE_AI_INCLUSIONS
    ? [c.valeur, ...(c.ai_inclusions || [])]
    : [c.valeur];
  const excl = c.ai_exclusions || [];
  let text = "";
  if (c.type === "titre") {
    text = (item.objet || "") + " " + (item._keyword || "");
  } else {
    text = (item.articles || []).map(a => (a.designation||"") + " " + (a.specifications||"")).join(" ")
         + " " + (item.bodyText || "") + " " + (item.objet || "") + " " + (item._keyword || "");
  }
  if (excl.length && excl.some(t => hasKw(text, t))) return { keyword: c.valeur, trigger: c.valeur, isEnrichissement: false };
  for (let i = 0; i < incl.length; i++) {
    if (hasKw(text, incl[i])) return { keyword: c.valeur, trigger: incl[i], isEnrichissement: i > 0 };
  }
  return { keyword: c.valeur, trigger: c.valeur, isEnrichissement: false };
}

function escHtml(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ============================================================
// SUPABASE
// ============================================================
async function sbReq(path, opts) {
  opts = opts || {};
  const r = await fetch(CFG.sbUrl + "/rest/v1/" + path, {
    headers: {
      "Content-Type":  "application/json",
      "apikey":        CFG.sbKey,
      "Authorization": "Bearer " + CFG.sbKey,
      "Prefer":        opts.prefer || "return=representation",
    },
    method: opts.method || "GET",
    body:   opts.body,
  });
  if (r.status === 204) return null;
  const text = await r.text();
  if (!text) return null;
  let d;
  try { d = JSON.parse(text); }
  catch (e) { throw new Error("Supabase non-JSON response (" + r.status + "): " + text.slice(0, 200)); }
  if (!r.ok) throw new Error(JSON.stringify(d));
  return d;
}

// ── sbFetchAllPages : pagination Supabase/PostgREST par lots (défaut 1000) ──
// PostgREST plafonne à 1000 lignes par réponse par défaut.
// On itère avec offset jusqu'à recevoir un lot incomplet.
async function sbFetchAllPages(basePath, pageSize) {
  pageSize = pageSize || 1000;
  const all = [];
  let offset = 0;
  let pages = 0;
  while (true) {
    const sep = basePath.includes("?") ? "&" : "?";
    const path = basePath + sep + "limit=" + pageSize + "&offset=" + offset;
    const chunk = await sbReq(path);
    pages++;
    if (!chunk || !chunk.length) break;
    for (let i = 0; i < chunk.length; i++) all.push(chunk[i]);
    if (chunk.length < pageSize) break;
    offset += pageSize;
  }
  return { rows: all, pages: pages };
}

const db = {
  // Tous les clients actifs avec leurs criteres
  getClients: () => sbReq("clients?actif=eq.true&select=*,criteres(*)"),

  // ---- BC (Bons de Commande) ----
  getBCVusIds: async () => {
    try {
      const { rows, pages } = await sbFetchAllPages("bcs_vus?select=bc_id", 1000);
      log("[KNOWN_DIAG] bcs_vus_load total_loaded=" + rows.length + " pages_loaded=" + pages);
      return new Set(rows.map(r => r.bc_id));
    } catch (e) { log("  bcs_vus indisponible: " + e.message); return new Set(); }
  },
  getBCVusBCData: async () => {
    try {
      const { rows } = await sbFetchAllPages("bcs_vus?select=bc_data", 1000);
      return rows.map(r => r.bc_data).filter(Boolean);
    } catch (e) { log("  bcs_vus bc_data: " + e.message); return []; }
  },
  markBCVus: async bcs => {
    if (!bcs.length) return;
    const rows = bcs.map(bc => ({ bc_id: bc.id, date_limite: bc.date_limite || null, bc_data: bc }));
    for (let i = 0; i < rows.length; i += 100) {
      await sbReq("bcs_vus", {
        method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
        body: JSON.stringify(rows.slice(i, i + 100)),
      }).catch(e => log("  markBCVus: " + e.message));
    }
  },
  getBCSentIds: id =>
    sbReq("bcs_envoyes?client_id=eq." + id + "&radar_type=eq.bc&select=bc_id")
      .then(r => new Set((r || []).map(x => x.bc_id))),
  markBCSent: (cid, bcId, ct, cv, data) =>
    sbReq("bcs_envoyes", {
      method: "POST", prefer: "return=minimal",
      body: JSON.stringify({ client_id: cid, bc_id: bcId, critere_type: ct, critere_valeur: cv, bc_data: data, radar_type: "bc" }),
    }).catch(() => {}),

  // ---- MP (Marches Publics / Appels d'Offres) ----
  getMPVusIds: async () => {
    try {
      const rows = await sbReq("mps_vus?select=mp_id&limit=20000");
      return new Set((rows || []).map(r => r.mp_id));
    } catch (e) { log("  mps_vus indisponible: " + e.message); return new Set(); }
  },
  getMPVusMPData: async () => {
    try {
      const rows = await sbReq("mps_vus?select=mp_data&limit=20000");
      return (rows || []).map(r => r.mp_data).filter(Boolean);
    } catch (e) { log("  mps_vus mp_data: " + e.message); return []; }
  },
  markMPVus: async mps => {
    if (!mps.length) return;
    const rows = mps.map(mp => ({ mp_id: mp.id, date_limite: mp.date_limite || null, mp_data: mp }));
    for (let i = 0; i < rows.length; i += 100) {
      await sbReq("mps_vus", {
        method: "POST", prefer: "resolution=ignore-duplicates,return=minimal",
        body: JSON.stringify(rows.slice(i, i + 100)),
      }).catch(e => log("  markMPVus: " + e.message));
    }
  },
  getMPSentIds: id =>
    sbReq("bcs_envoyes?client_id=eq." + id + "&radar_type=eq.mp&select=bc_id")
      .then(r => new Set((r || []).map(x => x.bc_id))),
  markMPSent: (cid, mpId, ct, cv, data) =>
    sbReq("bcs_envoyes", {
      method: "POST", prefer: "return=minimal",
      body: JSON.stringify({ client_id: cid, bc_id: mpId, critere_type: ct, critere_valeur: cv, bc_data: data, radar_type: "mp" }),
    }).catch(() => {}),

  // Shared
  writeLog: (cid, ana, found, sent, radarType) =>
    sbReq("scan_logs", {
      method: "POST", prefer: "return=minimal",
      body: JSON.stringify({ client_id: cid, nb_analyses: ana, nb_trouves: found, nb_nouveaux: sent, radar_type: radarType || "bc" }),
    }).catch(() => {}),

  // IA: persister l'enrichissement d'un critere
  saveCritereAI: (critereId, inclusions, exclusions) =>
    sbReq("criteres?id=eq." + critereId, {
      method: "PATCH", prefer: "return=minimal",
      body: JSON.stringify({
        ai_inclusions: inclusions || [],
        ai_exclusions: exclusions || [],
      }),
    }).catch(e => log("  saveCritereAI: " + e.message)),
};


// ============================================================
// COUCHE IA UNIFIEE (Ollama local + Claude Haiku fallback)
// ============================================================

async function callOllama(systemPrompt, userPrompt, maxTokens) {
  if (!CFG.ollamaUrl) return null;
  maxTokens = maxTokens || 400;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch(CFG.ollamaUrl + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: CFG.ollamaModel, temperature: 0.1, stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt },
        ],
      }),
    });
    clearTimeout(timer);
    if (!r.ok) { log("  [IA][Ollama] Erreur " + r.status); return null; }
    const d = await r.json();
    const text = (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { log("  [IA][Ollama] Non-JSON: " + text.slice(0, 80)); return null; }
    return JSON.parse(m[0]);
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") log("  [IA][Ollama] Timeout");
    else log("  [IA][Ollama] " + e.message);
    return null;
  }
}

async function callClaudeHaiku(systemPrompt, userPrompt, maxTokens) {
  if (!CFG.anthropicKey) return null;
  maxTokens = maxTokens || 400;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         CFG.anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:       "claude-haiku-4-5-20251001",
        max_tokens:  maxTokens,
        temperature: 0.1,
        system:      systemPrompt,
        messages:    [{ role: "user", content: userPrompt }],
      }),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => r.status);
      log("  [IA][Haiku] Erreur " + r.status + ": " + String(err).slice(0, 100));
      return null;
    }
    const d = await r.json();
    const text = (d.content && d.content[0] && d.content[0].text) || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { log("  [IA][Haiku] Non-JSON: " + text.slice(0, 80)); return null; }
    return JSON.parse(m[0]);
  } catch (e) { log("  [IA][Haiku] " + e.message); return null; }
}

async function callLLM(systemPrompt, userPrompt, maxTokens) {
  if (CFG.ollamaUrl) {
    const result = await callOllama(systemPrompt, userPrompt, maxTokens);
    if (result !== null) return result;
    if (CFG.anthropicKey) log("  [IA] Ollama KO -> fallback Claude Haiku");
  }
  if (CFG.anthropicKey) return await callClaudeHaiku(systemPrompt, userPrompt, maxTokens);
  return null;
}

// Prompt 1 : Generateur de famille semantique (avec cache local)
async function enrichCritereWithAI(critere) {
  const cacheKey = norm(critere.valeur);

  // 1. Vérifier le cache local d'abord
  if (AI_CACHE[cacheKey]) {
    log('  [Cache] Hit: "' + critere.valeur + '" (' + AI_CACHE[cacheKey].inclusions.length + ' inclusions)');
    return { inclusions: AI_CACHE[cacheKey].inclusions, exclusions: AI_CACHE[cacheKey].exclusions };
  }

  log('  [IA] Enrichissement: "' + critere.valeur + '"');
  const sys =
    "Tu es un expert en marches publics et achats administratifs au Maroc. " +
    "Tu generes des familles de termes pour un systeme de veille sur les Bons de Commande (BC) " +
    "et Marches Publics marocains. Tes reponses sont en JSON strict, sans markdown, sans commentaire.";
  const usr =
    'Le client surveille : "' + critere.valeur + '"\n\n' +
    "Genere un JSON avec :\n" +
    '1. "inclusions" : variantes techniques, synonymes, abreviations, erreurs OCR frequentes, ' +
    "termes de l'administration marocaine. Maximum 20 termes.\n" +
    '2. "exclusions" : termes proches mais differents a exclure. Maximum 10 termes.\n\n' +
    'Format strict : {"inclusions":["terme1"],"exclusions":["terme2"]}';
  const result = await callLLM(sys, usr, 600);
  if (!result || !Array.isArray(result.inclusions)) {
    log("  [IA] Echec enrichissement: " + critere.valeur); return null;
  }

  // Limites strictes : 10 inclusions, 5 exclusions max
  const MAX_INCL = 10, MAX_EXCL = 5;
  const inclusions = result.inclusions.slice(0, MAX_INCL);
  const exclusions = (result.exclusions || []).slice(0, MAX_EXCL);

  log('  [IA] "' + critere.valeur + '" -> ' +
    inclusions.length + " inclusions, " + exclusions.length + " exclusions (cap " + MAX_INCL + "/" + MAX_EXCL + ")");

  // 2. Sauvegarder en cache mémoire + Supabase
  const entry = {
    valeur:     critere.valeur,
    inclusions,
    exclusions,
  };
  await saveCacheEntry(cacheKey, entry);

  return { inclusions, exclusions };
}

// Cache validation par item (clé = item.id + "|" + critere normalisé)
// Evite N appels LLM si le même item matche N clients
const VALIDATION_CACHE = new Map();

// Prompt 2 : Validation + résumé avant envoi notification
// IMPORTANT : on n'annule JAMAIS une notif sur refus IA seul (trop risqué de rater un vrai marché)
// Le résultat IA sert à :
//   - enrichir le message avec un résumé clair
//   - signaler les matches douteux avec ⚠️ (mais on envoie quand même)
async function validateMatchWithAI(item, critere, radarType) {
  if (!CFG.ollamaUrl && !CFG.anthropicKey) return null;

  // Cache : même item + même critère → réutiliser
  const cacheKey = (item.id || "") + "|" + norm(critere.valeur);
  if (VALIDATION_CACHE.has(cacheKey)) {
    log("  [IA] Cache hit validation: " + item.id);
    return VALIDATION_CACHE.get(cacheKey);
  }

  // Extrait court : objet + désignations articles (max 500 chars)
  const extrait = [
    item.objet || "",
    (item.articles || []).slice(0, 4)
      .map(a => a.designation || "").filter(Boolean).join(", "),
    (item.bodyText || "").slice(0, 200),
  ].filter(Boolean).join(" | ").slice(0, 500);

  const label = radarType === "mp" ? "AO" : "BC";
  const sys = "Expert marchés publics Maroc. Analyse pertinence. JSON strict uniquement.";
  const usr =
    'Critere: "' + critere.valeur + '" | ' + label + ': "' + extrait + '"\n' +
    'JSON: {"pertinent":true/false,"confiance":"haute/moyenne/faible","resume":"1 phrase"}';

  const r = await callLLM(sys, usr, 120);
  if (!r || typeof r.pertinent !== "boolean") {
    VALIDATION_CACHE.set(cacheKey, null);
    return null;
  }

  VALIDATION_CACHE.set(cacheKey, r);
  return r;
}

// Enrichissement automatique des criteres non encore traites
async function autoEnrichCriteres(clients, radarType) {
  if (!CFG.ollamaUrl && !CFG.anthropicKey) return;
  const toEnrich = [];
  for (const client of clients)
    for (const c of (client.criteres || []))
      if ((c.radar_type || "bc") === radarType && !(c.ai_inclusions && c.ai_inclusions.length))
        toEnrich.push(c);
  if (!toEnrich.length) { log("  [IA] Criteres deja enrichis."); return; }
  log("  [IA] " + toEnrich.length + " critere(s) a enrichir...");
  for (const c of toEnrich) {
    const result = await enrichCritereWithAI(c);
    if (result) {
      c.ai_inclusions = result.inclusions;
      c.ai_exclusions = result.exclusions;
      await db.saveCritereAI(c.id, result.inclusions, result.exclusions);
    }
    await delay(300);
  }
}

/**
 * Vérifie qu'une valeur brute de token Telegram est utilisable.
 * Rejette : null / undefined / string vide / whitespace seul / "null" / "undefined".
 * Ne jamais afficher la valeur dans les logs.
 */
function _isValidToken(raw) {
  if (!raw || typeof raw !== "string") return false;
  const t = raw.trim();
  return !!t && t !== "null" && t !== "undefined";
}

/**
 * Résout le token Telegram effectif pour un appel.
 * Ordre de priorité :
 *   1. process.env.TELEGRAM_BOT_TOKEN (valeur runtime live)
 *   2. CFG.tgToken (valeur capturée au boot, stable si Fly.io vide process.env après startup)
 *   3. client.tg_token (override par-client)
 * Retourne "" si aucun token valide trouvé.
 */
function _resolveTgToken(client) {
  if (_isValidToken(process.env.TELEGRAM_BOT_TOKEN)) {
    return process.env.TELEGRAM_BOT_TOKEN.trim();
  }
  // CFG.tgToken est capturé une fois au boot — résiste aux modifications de process.env en cours de vie
  if (_isValidToken(CFG.tgToken)) {
    return CFG.tgToken;
  }
  if (client && _isValidToken(client.tg_token)) {
    return String(client.tg_token).trim();
  }
  return "";
}

/**
 * Source unique de vérité pour la décision de livraison Telegram.
 * Utilisée par sendTelegram ET TG_DECISION — ordre canonique garanti identique :
 *   1. empty_message  (message HTML vide)
 *   2. no_token       (aucun token valide résolu)
 *   3. no_chat_id     (client sans tg_chat_id)
 *   4. will_attempt   (tous les prérequis réunis)
 * Ne retourne jamais la valeur du token — masqué en set/empty.
 */
function getTelegramDeliveryDecision(client, htmlMsg) {
  const hasCfgToken         = _isValidToken(process.env.TELEGRAM_BOT_TOKEN);  // process.env live
  const hasCfgTokenCached   = _isValidToken(CFG.tgToken);                     // valeur boot immuable
  const hasClientToken      = _isValidToken(client.tg_token);
  const resolvedTokenPresent = !!_resolveTgToken(client);   // process.env → CFG → client
  const hasChatId           = !!(client.tg_chat_id);

  let reason;
  if (!htmlMsg)                reason = "empty_message";
  else if (!resolvedTokenPresent) reason = "no_token";
  else if (!hasChatId)         reason = "no_chat_id";
  else                         reason = "will_attempt";

  return {
    has_chat_id:              hasChatId,
    has_cfg_token:            hasCfgToken,         // process.env live
    has_cfg_token_cached:     hasCfgTokenCached,   // CFG.tgToken (boot)
    has_client_token:         hasClientToken,
    resolved_token_present:   resolvedTokenPresent,
    reason,
  };
}

async function sendTelegram(client, htmlMsg) {
  const _tgDec = getTelegramDeliveryDecision(client, htmlMsg);
  if (_tgDec.reason !== "will_attempt") {
    log("[Telegram] SKIP client=" + (client.nom || client.id)
      + " reason=" + _tgDec.reason
      + " cfg_token_env=" + (_tgDec.has_cfg_token ? "set" : "empty")
      + " cfg_token_cached=" + (_tgDec.has_cfg_token_cached ? "set" : "empty")
      + " resolved=" + (_tgDec.resolved_token_present ? "set" : "empty")
      + " client_token=" + (_tgDec.has_client_token ? "set" : "empty"));
    return false;
  }
  // will_attempt : token et chat_id garantis présents par getTelegramDeliveryDecision
  const token = _resolveTgToken(client);
  // Telegram limite les messages à 4096 caractères. On tronque proprement en HTML valide.
  const TG_MAX = 4096;
  const TG_SUFFIX = "\n\n<i>[message tronqué — voir la fiche en ligne]</i>";
  const payload = htmlMsg.length > TG_MAX
    ? htmlMsg.slice(0, TG_MAX - TG_SUFFIX.length) + TG_SUFFIX
    : htmlMsg;
  if (htmlMsg.length > TG_MAX) {
    log("[Telegram] TRUNCATED chat=" + client.tg_chat_id + " len=" + htmlMsg.length + " -> " + TG_MAX);
  }
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:                  client.tg_chat_id,
        text:                     payload,
        parse_mode:               "HTML",
        disable_web_page_preview: false,
      }),
    });
    const d = await r.json().catch(() => null);
    // Telegram retourne toujours HTTP 200 — il faut vérifier d.ok (champ JSON) pour
    // détecter les erreurs applicatives (chat introuvable, bot bloqué, token invalide…)
    if (!r.ok || !d || d.ok !== true) {
      const desc = d ? (d.description || JSON.stringify(d)) : "réponse JSON invalide";
      log("[Telegram] FAILED chat=" + client.tg_chat_id + " status=" + r.status + " description=" + desc);
      return false;
    }
    log("[Telegram] OK chat=" + client.tg_chat_id + " message_id=" + (d.result && d.result.message_id ? d.result.message_id : "?"));
    return true;
  } catch (e) { log("[Telegram] erreur réseau: " + e.message); return false; }
}

async function sendWhatsApp(client, msg) {
  const limits = getPackLimits(client);
  if (!limits.hasWhatsApp) return false; // starter ne peut pas WhatsApp
  const num = (client.phone || "").replace(/\D/g, "");
  if (!num) return false;
  try {
    if (client.wa_provider === "callmebot") {
      const r = await fetch("https://api.callmebot.com/whatsapp.php?phone=" + num +
        "&text=" + encodeURIComponent(msg) + "&apikey=" + client.wa_apikey);
      if (!r.ok) { log("  WhatsApp erreur HTTP " + r.status); return false; }
      log("  WhatsApp -> +" + num);
      return true;
    }
    return false; // provider inconnu
  } catch (e) { log("  WhatsApp erreur: " + e.message); return false; }
}

async function sendEmail(client, item, matchedCriteres, radarType, aiResume) {
  if (!CFG.resendKey) return false;
  const emailTo = client.email_notif || client.email;
  if (!emailTo) return false;

  const label  = radarType === "mp" ? "Marche Public" : "Bon de Commande";
  const emoji  = radarType === "mp" ? "🏛️" : "📦";
  const critStr = matchedCriteres.map(c => c.valeur).join(", ");
  const titre  = item.objet || item.reference || "Nouveau " + label;
  const budget = item.estimation_totale ? item.estimation_totale + " DH TTC" : null;
  const url    = item.url || null;

  const htmlBody = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:system-ui,sans-serif;background:#f0f4f8;margin:0;padding:0">
<div style="max-width:600px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#1a365d,#2b6cb0);padding:24px 28px;color:#fff">
    <div style="font-size:13px;opacity:.8;margin-bottom:4px">Radar Marchés Maroc ${emoji}</div>
    <div style="font-size:20px;font-weight:700">${titre}</div>
  </div>
  <div style="padding:24px 28px">
    ${aiResume ? `<div style="background:${aiResume.startsWith('⚠️') ? '#fff3cd' : '#d1fae5'};border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:14px;color:#1a202c">
      <strong>Analyse IA :</strong> ${escHtml(aiResume)}</div>` : ""}
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:8px 0;color:#718096;width:140px">Type</td><td style="font-weight:600">${label}</td></tr>
      <tr><td style="padding:8px 0;color:#718096">Critère(s)</td><td style="font-weight:600;color:#2563eb">${critStr}</td></tr>
      ${item.organisme ? `<tr><td style="padding:8px 0;color:#718096">Organisme</td><td>${item.organisme}</td></tr>` : ""}
      ${item.wilaya ? `<tr><td style="padding:8px 0;color:#718096">Wilaya</td><td>${item.wilaya}</td></tr>` : ""}
      ${budget ? `<tr><td style="padding:8px 0;color:#718096">Budget</td><td style="font-weight:600;color:#059669">${budget}</td></tr>` : ""}
      ${item.date_limite ? `<tr><td style="padding:8px 0;color:#718096">Date limite</td><td style="color:#dc2626;font-weight:600">${item.date_limite}</td></tr>` : ""}
      ${item.reference ? `<tr><td style="padding:8px 0;color:#718096">Référence</td><td>${item.reference}</td></tr>` : ""}
    </table>
    ${(item.articles || []).length > 0 ? `
    <div style="margin-top:16px">
      <div style="font-weight:600;margin-bottom:8px;font-size:14px">Articles :</div>
      <ul style="margin:0;padding-left:20px;font-size:13px;color:#374151">
        ${(item.articles || []).slice(0, 8).map(a => `<li style="margin-bottom:4px">${a.designation || ""}${a.estimation ? " — " + a.estimation : ""}</li>`).join("")}
      </ul>
    </div>` : ""}
    ${url ? `<div style="margin-top:20px"><a href="${escHtml(url)}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Voir le ${label} →</a></div>` : ""}
  </div>
  <div style="background:#f8fafc;padding:16px 28px;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0">
    Radar Marchés Maroc · Scan automatique toutes les 2h · <a href="#" style="color:#94a3b8">Se désabonner</a>
  </div>
</div>
</body></html>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + CFG.resendKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from:    "Radar Marchés Maroc <" + CFG.fromEmail + ">",
        to:      [emailTo],
        subject: emoji + " " + label + " : " + titre.slice(0, 80),
        html:    htmlBody,
      }),
    });
    if (!r.ok) { log("  Email erreur " + r.status + ": " + await r.text()); return false; }
    log("  Email -> " + emailTo);
    return true;
  } catch (e) { log("  Email erreur: " + e.message); return false; }
}

// ── Message TEXTE BRUT (WhatsApp, fallback) ──────────────────────────────────

// ── Liens de feedback ─────────────────────────────────────────────────────────
/**
 * Construit la section feedback à ajouter aux notifications.
 * Retourne null si feedbackUrl n'est pas configuré.
 * @param {string} mode  "html" | "plain"
 *
 * GD-078 : deleguee a _fbl.buildFeedbackReasonLinks (helper pur testable).
 * FEEDBACK_REASON_LINKS_ENABLED=true  => 8 liens avec r= par raison client.
 * FEEDBACK_REASON_LINKS_ENABLED=false (defaut) => 3 liens originaux sans r= (prod inchange).
 */
function _buildFeedbackSection(clientId, itemId, critereValeur, radarType, mode, opts) {
  const enabled = _fbl.isFeedbackReasonLinksEnabled(process.env.FEEDBACK_REASON_LINKS_ENABLED);
  // GD-085 : signature optionnelle des liens, inchangee si flags absents
  const signatureOpts = {
    enabled:    _fbs.isFeedbackSignedLinksEnabled(process.env.FEEDBACK_SIGNED_LINKS_ENABLED),
    secret:     CFG.feedbackSigningSecret,
    ttlSeconds: parseInt(process.env.FEEDBACK_LINK_TTL_SECONDS || "604800", 10) || 604800,
  };
  return _fbl.buildFeedbackReasonLinks(
    (CFG.feedbackUrl || "").trim(),
    clientId, itemId, critereValeur, radarType, opts, mode, enabled, signatureOpts
  );
}

/**
 * Retourne true si les liens feedback doivent être inclus pour ce client.
 * Si FEEDBACK_ALLOWED_CLIENTS est absent ou vide : tous les clients sont autorisés
 *   (comportement actuel conservé — rétrocompatibilité totale).
 * Si FEEDBACK_ALLOWED_CLIENTS contient une liste CSV : seuls les client.id listés
 *   reçoivent les liens feedback.
 * Indépendant de feedbackUrl — la garde FEEDBACK_BASE_URL vide reste dans _buildFeedbackSection.
 */
function isFeedbackEnabledForClient(clientId) {
  if (!CFG.feedbackAllowed.length) return true;
  return CFG.feedbackAllowed.includes(String(clientId));
}

// ─── Feedback capture helpers ─────────────────────────────────────────────────
// GD-080 : logique extraite dans scripts/feedback-handler.js pour tests isoles.
// Aliases identiques -- comportement de la route /feedback inchange.

const _VALID_FEEDBACK_TYPES   = _fbh.VALID_FEEDBACK_TYPES;
const _VALID_RADAR_TYPES      = _fbh.VALID_RADAR_TYPES;
// GD-077 : raisons client optionnelles (passives, ?r=)
const _VALID_FEEDBACK_REASONS = _fbh.VALID_FEEDBACK_REASONS;

/** Valide les parametres GET de /feedback. Retourne { valid, error?, data? } */
const validateFeedbackQuery = _fbh.validateFeedbackQuery;

/** Ajoute un evenement feedback en JSONL (path injectable). */
const appendFeedbackEvent = _fbh.appendFeedbackEventToJsonl;

/**
 * Persiste un événement feedback dans Supabase (table client_feedback_events).
 * Fire-and-forget : ne bloque jamais la réponse HTTP.
 * Idempotence : index unique partiel (notif_id, type) WHERE notif_id IS NOT NULL.
 * Si Supabase n'est pas configuré (CFG.sbUrl / CFG.sbKey absents), skip silencieux.
 */
function appendFeedbackToSupabase(event) {
  if (!CFG.sbUrl || !CFG.sbKey) return;
  const row = {
    client_id:   event.client_id,
    radar_type:  event.radar_type,
    item_id:     event.item_id,
    critere:     event.critere,
    type:        event.type,
    source:      "web_click",
    raw_payload: event,
    created_at:  event.created_at,
  };
  if (event.bc_title      !== undefined) row.bc_title      = event.bc_title;
  if (event.matched_terms !== undefined) row.matched_terms = event.matched_terms;
  if (event.notif_id      !== undefined) row.notif_id      = event.notif_id;
  fetch(CFG.sbUrl + "/rest/v1/client_feedback_events", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        CFG.sbKey,
      "Authorization": "Bearer " + CFG.sbKey,
      "Prefer":        "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  }).then(function(r) {
    if (r.ok || r.status === 204) return; // 200/201/204 → OK
    // Lire le body pour distinguer doublon idempotent (23505) d'une vraie erreur
    return r.text().then(function(body) {
      if (r.status === 409 && (body.includes("23505") || body.includes("duplicate key"))) {
        return; // doublon idempotent — index unique partiel (notif_id, type) — silencieux
      }
      log("Erreur Supabase feedback (" + r.status + "): " + body.slice(0, 200));
    }).catch(function() {
      log("Erreur Supabase feedback: status " + r.status + " (body illisible)");
    });
  }).catch(function(e) { log("Erreur Supabase feedback: " + e.message); });
}


// ─── Quality gate runtime helpers ────────────────────────────────────────────

let _qgInstance = undefined;  // undefined = pas encore chargé, null = introuvable

function _getQualityGate() {
  if (_qgInstance !== undefined) return _qgInstance;
  try {
    _qgInstance = require("./core/scoring/notification-quality-gate.runtime.js");
    log("[GATE] quality gate actif");
    return _qgInstance;
  } catch (e) {
    try {
      _qgInstance = require("./dist/core/scoring/notification-quality-gate");
      log("[GATE] quality gate actif (dist)");
      return _qgInstance;
    } catch (_) {
      _qgInstance = null;
      log("[GATE] quality gate inactif (module introuvable)");
      return null;
    }
  }
}

function _runQualityGate(input) {
  const gate = _getQualityGate();
  if (!gate || typeof gate.checkNotificationQuality !== "function") {
    return { decision: "allow", reason: "quality gate unavailable", signals: [] };
  }
  try {
    return gate.checkNotificationQuality(input);
  } catch (e) {
    log("[GATE] erreur: " + e.message);
    return { decision: "allow", reason: "quality gate error: " + e.message, signals: [] };
  }
}


function buildMessage(item, matchedCriteres, radarType, aiResume) {
  const header = radarType === "mp" ? "🏛️ NOUVEAU MARCHÉ PUBLIC" : "📦 NOUVEAU BC EN COURS";
  const trigger = getMatchTrigger(item, matchedCriteres[0]);
  const critereStr = trigger
    ? (trigger.isEnrichissement
        ? `"${trigger.keyword}" → via "${trigger.trigger}"`
        : `"${trigger.keyword}"`)
    : "";
  const plusStr = matchedCriteres.length > 1 ? ` (+${matchedCriteres.length - 1} critère${matchedCriteres.length > 2 ? "s" : ""})` : "";

  const arts = (item.articles || []).slice(0, 5).map(a => {
    let l = "  • " + a.designation;
    if (a.estimation && a.estimation !== "-") l += " — " + a.estimation;
    else if (a.quantite) l += " — " + a.quantite + " " + (a.unite || "");
    return l;
  }).join("\n");
  const moreArts = (item.articles || []).length > 5
    ? "  (+ " + ((item.articles || []).length - 5) + " autres articles)" : "";

  return [
    header, "",
    "📋 " + (item.objet || item.reference || "N/A"),
    "🏢 " + (item.organisme || "N/A") + (item.wilaya ? " — " + item.wilaya : ""),
    item.date_limite ? "📅 Date limite : " + item.date_limite + " ⚠️" : null,
    critereStr ? "🔍 Critère : " + critereStr + plusStr : null,
    "",
    arts ? "💼 Articles :" : null,
    arts || "  (voir la fiche)",
    moreArts || null,
    aiResume ? "\n💡 " + aiResume : null,
    "",
    "🔗 " + (item.url || "Lien non disponible"),
    "",
    "Radar Marchés Maroc",
  ].filter(l => l !== null && l !== undefined).join("\n");
}

// ── Message HTML (Telegram — liens cliquables, gras, italique) ───────────────
function buildHtmlMessage(item, matchedCriteres, radarType, aiResume) {
  const header = radarType === "mp" ? "🏛️ NOUVEAU MARCHÉ PUBLIC" : "📦 NOUVEAU BC EN COURS";
  const trigger = getMatchTrigger(item, matchedCriteres[0]);
  const critereHtml = trigger
    ? (trigger.isEnrichissement
        ? `<code>${escHtml(trigger.keyword)}</code> → <i>${escHtml(trigger.trigger)}</i>`
        : `<code>${escHtml(trigger.keyword)}</code>`)
    : "";
  const plusHtml = matchedCriteres.length > 1
    ? ` <i>(+${matchedCriteres.length - 1} critère${matchedCriteres.length > 2 ? "s" : ""})</i>` : "";

  const arts = (item.articles || []).slice(0, 5).map(a => {
    let l = "• " + escHtml(a.designation);
    if (a.estimation && a.estimation !== "-") l += " — <b>" + escHtml(a.estimation) + "</b>";
    else if (a.quantite) l += " — " + escHtml(a.quantite + " " + (a.unite || ""));
    return l;
  }).join("\n");
  const moreArts = (item.articles || []).length > 5
    ? `<i>+${(item.articles||[]).length - 5} autres articles</i>` : "";

  const url = item.url;
  return [
    `🔔 <b>${header}</b>`, "",
    `📋 <b>${escHtml(item.objet || item.reference || "N/A")}</b>`,
    `🏢 ${escHtml(item.organisme || "N/A")}${item.wilaya ? " — " + escHtml(item.wilaya) : ""}`,
    item.date_limite ? `📅 Date limite : <b>${escHtml(item.date_limite)}</b> ⚠️` : null,
    critereHtml ? `🔍 Critère : ${critereHtml}${plusHtml}` : null,
    "",
    arts ? "💼 <b>Articles :</b>" : null,
    arts || "<i>(voir la fiche)</i>",
    moreArts || null,
    aiResume ? `\n💡 <i>${escHtml(aiResume)}</i>` : null,
    "",
    url ? `🔗 <a href="${escHtml(url)}">Voir la fiche →</a>` : "🔗 Lien non disponible",
    "",
    "<i>Radar Marchés Maroc</i>",
  ].filter(l => l !== null && l !== undefined).join("\n");
}

// ============================================================
// PUPPETEER
// ============================================================
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--window-size=1440,900",
      "--disable-blink-features=AutomationControlled",
    ],
  });
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,ar;q=0.8" });
  // Masquer navigator.webdriver pour éviter la détection bot
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  return page;
}

async function loginPortal(page, loginUrl) {
  log("Connexion au portail...");
  try {
    // Timeout genereux : le portail marocain est parfois lent depuis l'Europe
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await randDelay(800, 1500);

    // DEBUG: lister tous les inputs de la page pour trouver les bons selecteurs
    const allInputs = await page.evaluate(() =>
      [...document.querySelectorAll("input,button[type='submit']")].map(el => ({
        tag: el.tagName, type: el.type, name: el.name, id: el.id,
        placeholder: el.placeholder, value: el.value ? "(value)" : ""
      }))
    );
    log("  Inputs sur la page login: " + JSON.stringify(allInputs));

    // Portail PRADO marchespublics.gov.ma - IDs exacts detectes
    const lf = await page.$("#ctl0_CONTENU_PAGE_login");
    const pf = await page.$("#ctl0_CONTENU_PAGE_password");
    if (!lf || !pf) { log("Formulaire login non trouve - scan sans auth"); return false; }
    log("  Champs login/password trouves");
    await lf.click({ clickCount: 3 }); await lf.type(CFG.login, { delay: 70 });
    await randDelay(300, 600);
    await pf.click({ clickCount: 3 }); await pf.type(CFG.password, { delay: 70 });
    await randDelay(300, 600);
    // Bouton submit = image input specifique au portail PRADO
    const btn = await page.$("input[name='ctl0\$CONTENU_PAGE\$authentificationButton']") ||
                await page.$("input[type='image'][name*='authentification']") ||
                await page.$("input[type='submit']");
    if (btn) await btn.click(); else await pf.press("Enter");
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 90000 });
    await randDelay(800, 1500);
    await randDelay(800, 1500);
    const pageInfo = await page.evaluate(() => ({
      url: window.location.href,
      hasLoginForm: !!document.querySelector("#ctl0_CONTENU_PAGE_login"),
      hasUserMenu:  !!(document.querySelector("[id*='deconnexion'],[id*='logout'],[href*='deconnexion'],[href*='logout']") ||
                       document.body.innerText.toLowerCase().includes("se deconnecter") ||
                       document.body.innerText.toLowerCase().includes("mon compte") ||
                       document.body.innerText.toLowerCase().includes("bienvenue")),
      hasError:     document.body.innerText.toLowerCase().includes("incorrect") ||
                    document.body.innerText.toLowerCase().includes("invalide"),
    }));
    const ok = !pageInfo.hasLoginForm && !pageInfo.hasError;
    log(ok
      ? "Connecte ! (menu user: " + pageInfo.hasUserMenu + ") URL: " + pageInfo.url
      : "Echec connexion - form encore present, erreur: " + pageInfo.hasError);
    return ok;
  } catch (e) {
    // Pas de retry - on continue sans auth pour ne pas bloquer le scan
    log("Login timeout/erreur: " + e.message.split("\n")[0] + " -> scan sans auth");
    return false;
  }
}

// ============================================================
// SCRAPER GENERIQUE (BC + MP partagent la meme logique)
// ============================================================
async function scrapeOnePage(browser, baseUrl, pageNum) {
  const isBDC  = baseUrl.includes("/bdc/");
  const isSPIP = baseUrl.includes("/pmmp/");
  const isPMMP = isSPIP || baseUrl.includes("pmmp") || baseUrl.includes("EntrepriseAdvancedSearch") || baseUrl.includes("EntrepriseConsultation") || (baseUrl.includes("index.php") && !baseUrl.includes("/bdc/"));
  // SPIP: pagination via debut_articles=N (offset par 10), pas page=N
  // BDC:  pagination via ?page=N
  const SPIP_PER_PAGE = 10;
  const url = pageNum === 1 ? baseUrl :
    isSPIP ? baseUrl + (baseUrl.includes("?") ? "&" : "?") + "debut_articles=" + ((pageNum - 1) * SPIP_PER_PAGE) :
    baseUrl + (baseUrl.includes("?") ? "&" : "?") + "page=" + pageNum;
  const _maxAttempts = isBDC ? 3 : 2;  // BC : 3 tentatives (portail lent) ; autres : 2
  const _navTimeout  = isBDC ? BC_NAV_TIMEOUT_MS : 60000;  // BC : 120s ; autres : 60s
  const _retryDelay  = isBDC ? 6000 : 3000;                // BC : 6s ; autres : 3s
  for (let attempt = 0; attempt < _maxAttempts; attempt++) {
    if (attempt > 0) {
      log("  [SCRAPE] Page " + pageNum + " retry " + attempt + "/" + (_maxAttempts - 1)
        + " [source=" + _currentScanSource + "] delai " + (_retryDelay / 1000) + "s...");
      await delay(_retryDelay);
    }
    let pg;
    const _t0 = Date.now();
    try {
      pg = await newPage(browser);
      // Log contexte page avant navigation
      const _ua = await pg.evaluate(() => navigator.userAgent).catch(() => "unavailable");
      log("  [PAGE] created [source=" + _currentScanSource
        + " page=" + pageNum + " attempt=" + (attempt + 1) + "/" + _maxAttempts
        + " ua_short=" + _ua.slice(0, 40)
        + " viewport=1440x900 timeout=" + _navTimeout + "ms]");
      // Ecoute requestfailed document principal (net::ERR_TIMED_OUT, etc.)
      if (isBDC) {
        pg.once("requestfailed", req => {
          if (req.resourceType() === "document") {
            log("  [NET] requestfailed page=" + pageNum
              + " source=" + _currentScanSource
              + " url=" + req.url().slice(0, 120)
              + " err=" + (req.failure() ? req.failure().errorText : "unknown"));
          }
        });
        pg.once("response", resp => {
          if (resp.request().resourceType() === "document") {
            log("  [NET] response page=" + pageNum
              + " source=" + _currentScanSource
              + " status=" + resp.status()
              + " url=" + resp.url().slice(0, 120));
          }
        });
      }
      log("  [SCRAPE] Page " + pageNum + " goto " + url
        + " (attempt " + (attempt + 1) + "/" + _maxAttempts + " timeout=" + _navTimeout + "ms)");
      await pg.goto(url, { waitUntil: "domcontentloaded", timeout: _navTimeout });
      // Attendre que la vraie page charge (challenge Cloudflare → redirect vers contenu réel)
      if (isBDC) {
        try {
          await pg.waitForSelector("a[href*='/show/'], .entreprise__card, #content", { timeout: 30000 });
        } catch (_e) {
          log("  [DEBUG] waitForSelector timeout page " + pageNum + " — lecture directe quand meme");
        }
      } else {
        await delay(2000);
      }
      // DEBUG BC : voir ce que Puppeteer trouve sur la page (login/session/cloudflare/liens)
      if (isBDC) {
        const dbg = await pg.evaluate(() => {
          const bodyTxt  = document.body ? document.body.innerText.toLowerCase() : "";
          const show_count = document.querySelectorAll("a[href*='/show/']").length;
          return {
            title:           document.title,
            url:             window.location.href,
            show_count,
            has_login_form:  !!(document.querySelector("#ctl0_CONTENU_PAGE_login, input[type='password']") ||
                               bodyTxt.includes("mot de passe")),
            session_expired: bodyTxt.includes("session") && (bodyTxt.includes("expir") || bodyTxt.includes("connectez")),
            cloudflare:      bodyTxt.includes("cloudflare") || /just a moment/i.test(document.title),
            body_head:       document.body ? document.body.innerText.slice(0, 400) : "BODY NULL",
          };
        }).catch(e => ({ title: "EVAL_ERROR:" + (e && e.message ? e.message.slice(0,80) : "?"), url: "", show_count: -1, has_login_form: false, session_expired: false, cloudflare: false, body_head: "" }));
        log("  [DEBUG BC] title=" + dbg.title + " | show_links=" + dbg.show_count + " | url=" + dbg.url
          + " | login=" + dbg.has_login_form + " | session_exp=" + dbg.session_expired + " | cloudflare=" + dbg.cloudflare);
        if (dbg.show_count === 0) {
          const _bcReason = dbg.cloudflare       ? "0 BC car cloudflare/challenge"
                          : dbg.has_login_form   ? "0 BC car login/session expiree"
                          : dbg.session_expired  ? "0 BC car session expiree"
                          :                        "0 BC car selecteur /show/ absent";
          log("  [DEBUG BC] " + _bcReason);
          log("  [DEBUG BC] body_head: " + dbg.body_head.replace(/\n/g, " ").slice(0, 250));
        }
      }
      const result = await pg.evaluate((baseUrl, isBDC, isPMMP) => {
        const items = [], seen = new Set();
        const base  = new URL(baseUrl).origin;
        // DEBUG pour pages non-BC
        const _debug = !isBDC ? {
          title:   document.title,
          url:     window.location.href,
          hrefs:   [...document.querySelectorAll("a[href]")]
                     .map(a => a.getAttribute("href"))
                     .filter(h => h && !h.startsWith("#") && h.length > 3)
                     .slice(0, 50),
          html:    document.body.innerHTML.replace(/\s+/g," ").slice(0, 5000),
        } : null;

        if (isPMMP) {
          // Portail PMMP/SPIP : liens vers fiches AO
          // Patterns possibles: refConsultation=XXX, EntrepriseDownloadAvisJAL, /show/XXX
          const sel = "a[href*='refConsultation'],a[href*='EntrepriseDownloadAvisJAL'],a[href*='EntrepriseConsultation'],a[href*='/show/'],a[href*='spip.php?article'],a[href*='-ao-'],a[href*='appel-offres'],a[href*='consultation']";
          document.querySelectorAll(sel).forEach(link => {
            const href = link.getAttribute("href") || "";
            let id = "";
            const refM  = href.match(/refConsultation[=]([^&\s]+)/);
            const avisM = href.match(/idAvis[=]([^&\s]+)/);
            const showM = href.match(/\/show\/(\d+)/);
            if (refM)       id = refM[1];
            else if (avisM) id = avisM[1];
            else if (showM) id = showM[1];
            if (!id || seen.has(id)) return;
            seen.add(id);
            const row   = link.closest("tr,.avis-item,li,article,div.row,.consultation-row,.ao-item,.marche-item");
            const txt   = row ? row.innerText : link.innerText;
            const lines = txt.split("\n").map(l => l.trim()).filter(Boolean);
            const dates = [...txt.matchAll(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/g)].map(m => m[1]);
            const fullUrl = href.startsWith("http") ? href : base + (href.startsWith("/") ? href : "/" + href);
            items.push({
              id,
              reference:   lines[0] || "",
              objet:       lines[1] || lines[0] || link.textContent.trim(),
              organisme:   lines[2] || "",
              date_limite: dates.length ? dates[dates.length - 1] : "",
              lieu:        lines.find(l => l.length > 5 && !l.match(/^\d{2}\//)) || "",
              wilaya:      "",
              url:         fullUrl,
            });
          });
        } else {
          // BC (et ancien AO) : liens /show/XXXXX
          document.querySelectorAll("a[href*='/show/']").forEach(link => {
            const href = link.getAttribute("href") || "";
            const idM  = href.match(/\/show\/(\d+)/);
            if (!idM) return;
            const id = idM[1];
            if (seen.has(id)) return; seen.add(id);
            const row   = link.closest("tr,.avis-item,li,article,div.row,.consultation-row");
            const txt   = row ? row.innerText : link.innerText;
            const lines = txt.split("\n").map(l => l.trim()).filter(Boolean);
            const dates = [...txt.matchAll(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/g)].map(m => m[1]);
            items.push({
              id,
              reference:   lines[0] || "",
              objet:       lines[1] || lines[0] || link.textContent.trim(),
              organisme:   lines[2] || "",
              date_limite: dates.length ? dates[dates.length - 1] : "",
              lieu:        lines.find(l => l.length > 5 && !l.match(/^\d{2}\//)) || "",
              wilaya:      "",
              url: href.startsWith("http") ? href : base + (href.startsWith("/") ? href : "/bdc/entreprise/consultation/show/" + id),
            });
          });
        }
        const nextEl = document.querySelector("a.next,a[rel='next'],.pagination li:last-child:not(.disabled) a,li.next:not(.disabled) a,a.suivant,li.suivant:not(.disabled) a");
        return { items, hasNext: !!nextEl && items.length > 0, _debug };
      }, baseUrl, isBDC, isPMMP);

      if (result._debug) {
        log("  DEBUG MP page title: " + result._debug.title);
        log("  DEBUG MP page url:   " + result._debug.url);
        log("  DEBUG MP hrefs: " + JSON.stringify((result._debug.hrefs || []).slice(0, 20)));
        if (result.items.length === 0 && result._debug.html) {
          log("  DEBUG MP html: " + result._debug.html.slice(0, 600));
        }
      }
      await pg.close().catch(() => {});
      return result;
    } catch (e) {
      const _errRaw = e && e.message ? e.message.split("\n")[0].slice(0, 200) : String(e).slice(0, 200);
      const _elapsed = Date.now() - _t0;
      // Catégoriser l'erreur pour diagnostic comparatif startup vs cron
      const _isNavTimeout   = _errRaw.includes("Navigation timeout");
      const _isNetTimeout   = _errRaw.includes("ERR_TIMED_OUT");
      const _isNetReset     = _errRaw.includes("ERR_CONNECTION_RESET") || _errRaw.includes("ERR_EMPTY_RESPONSE");
      const _errCategory    = _isNavTimeout ? "NAV_TIMEOUT"
                            : _isNetTimeout ? "NET_ERR_TIMED_OUT"
                            : _isNetReset   ? "NET_CONNECTION_RESET"
                            : "OTHER";
      log("  [SCRAPE_ERR] page=" + pageNum
        + " attempt=" + (attempt + 1) + "/" + _maxAttempts
        + " source=" + _currentScanSource
        + " category=" + _errCategory
        + " elapsed=" + _elapsed + "ms"
        + " msg=" + _errRaw);
      if (pg) await pg.close().catch(() => {});
      if (attempt === _maxAttempts - 1) return { items: [], hasNext: false, failed: true, _failReason: _errCategory + ": " + _errRaw };
    }
  }
  return { items: [], hasNext: false, failed: true, _failReason: "two attempts failed" };
}


// ============================================================
// PACK STANDARD : recherche portail par mot-clé
// Le portail indexe les désignations de lots -> résultats ciblés
// Sans authentification requise
// ============================================================
async function searchPortalByKeyword(browser, keyword, opts) {
  // opts: { categorie: "1"|"2"|"3", procedureType: "1"|"2"|... }
  const all = [], seen = new Set();
  const catValue  = (opts && opts.categorie)     ? String(opts.categorie)     : "0";
  const procValue = (opts && opts.procedureType) ? String(opts.procedureType) : "0";
  let pg;
  try {
    pg = await newPage(browser);
    log("  [STD] Recherche portail: '" + keyword + "' cat=" + catValue + "...");
    await pg.goto(CFG.mpListUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await delay(1200);

    // Remplir les champs de recherche (confirmés par inspection du portail)
    const filled = await pg.evaluate((kw, cat, proc) => {
      // Mot-clé
      const input = document.getElementById("ctl0_CONTENU_PAGE_AdvancedSearch_keywordSearch") ||
                    document.querySelector("input[name*='keywordSearch'],input[id*='keywordSearch']");
      if (!input) return false;
      input.value = kw;
      input.dispatchEvent(new Event("input",  { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // Catégorie (Travaux/Fournitures/Services)
      const catEl = document.querySelector("select[name*='categorie']");
      if (catEl && cat !== "0") catEl.value = cat;
      // Mode de passation
      const procEl = document.querySelector("select[name*='procedureType']");
      if (procEl && proc !== "0") procEl.value = proc;
      return true;
    }, keyword, catValue, procValue);

    if (!filled) {
      log("  [STD] Champ keywordSearch introuvable pour: " + keyword);
      await pg.close().catch(() => {});
      return [];
    }
    await delay(400);

    // Soumettre via mécanisme PRADO (lancerRecherche) — nom confirmé par inspection
    await pg.evaluate(() => {
      const btnName = "ctl0$CONTENU_PAGE$AdvancedSearch$lancerRecherche";
      const target  = document.getElementById("PRADO_POSTBACK_TARGET");
      if (target) target.value = btnName;
      const btn = document.querySelector("input[name='" + btnName + "'],button[name='" + btnName + "']");
      if (btn) { btn.click(); return; }
      const form = document.forms[0] || document.querySelector("form");
      if (form) form.submit();
    });

    try {
      await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) { log("  [STD] nav: " + e.message.split("\n")[0]); }
    await delay(800);

    // Optimiser: passer à 500 résultats/page pour minimiser les requêtes
    // Le sélecteur listePageSizeTop accepte: 10, 20, 50, 100, 500
    const pageSized = await pg.evaluate(() => {
      const sel = document.querySelector("select[name*='listePageSizeTop'],select[id*='listePageSizeTop']");
      if (!sel || !sel.querySelector("option[value='500']")) return false;
      sel.value = "500";
      const target = document.getElementById("PRADO_POSTBACK_TARGET");
      if (target) target.value = sel.name;
      const form = document.forms[0] || document.querySelector("form");
      if (form) { form.submit(); return true; }
      return false;
    });
    if (pageSized) {
      try {
        await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
        log("  [STD] Page size -> 500 OK");
      } catch(e) { log("  [STD] Page size: " + e.message.split("\n")[0]); }
      await delay(600);
    }

    // Extraction AOs + pagination (500/page → typiquement 1-2 pages)
    let pageNum = 0;
    while (pageNum < 20) {
      pageNum++;
      const result = await pg.evaluate(() => {
        const items = [], seenIds = new Set();
        const base  = window.location.origin;
        document.querySelectorAll("a[href]").forEach(link => {
          const href = link.getAttribute("href") || "";
          const refM = href.match(/refConsultation[=]([^&\s'"]+)/);
          if (!refM) return;
          let id = refM[1];
          if (/^[A-Za-z0-9+/]{8,}={0,2}$/.test(id) && !/^\d+$/.test(id)) return;
          if (href.includes("popUpGestionPanier") || href.includes("panier")) return;
          if (seenIds.has(id)) return;
          seenIds.add(id);
          let fullUrl = href, orgAcronyme = "";
          const popM = href.match(/popUp\s*\(\s*['"]([^'"]+)/i);
          if (popM) {
            const inner = popM[1].replace(/&lang=\w*$/, "").replace(/&lang=$/, "");
            fullUrl = inner.startsWith("http") ? inner : base + "/" + inner.replace(/^\//, "");
            const oM = inner.match(/orgA(?:ccronyme|cronyme|cronymr)[=]([^&\s'"]+)/i);
            if (oM) orgAcronyme = oM[1];
          } else if (!href.startsWith("http")) {
            fullUrl = base + (href.startsWith("/") ? href : "/" + href);
          }
          if (!orgAcronyme) {
            const oM = href.match(/orgA(?:ccronyme|cronyme|cronymr)[=]([^&\s'"]+)/i);
            if (oM) orgAcronyme = oM[1];
          }
          const row   = link.closest("tr,.avis-item,li,article,div.row,.consultation-row,.ao-item");
          const txt   = row ? row.innerText : link.innerText;
          const lines = txt.split("\n").map(l => l.trim()).filter(Boolean);
          const dates = [...txt.matchAll(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/g)].map(m => m[1]);
          items.push({
            id, reference: lines[0] || "",
            objet:       lines[1] || lines[0] || link.textContent.trim(),
            organisme:   lines[2] || "",
            date_limite: dates.length ? dates[dates.length - 1] : "",
            lieu:        lines.find(l => l.length > 5 && !l.match(/^\d{2}\//)) || "",
            wilaya: "", url: fullUrl, orgAcronyme,
          });
        });
        const nextSel = "a.next,a[rel='next'],.suivant:not(.disabled) a,a[id*='suivant'],a[title*='uivant'],a[title*='Next']";
        const pgLinks = [...document.querySelectorAll("a[href*='javascript'],a[onclick*='Page']")]
          .filter(a => /^\d+$/.test((a.textContent || "").trim()) || /suivant|next|>/i.test((a.textContent || "").trim()));
        const nextEl = document.querySelector(nextSel) || (pgLinks.length > 1 ? pgLinks[pgLinks.length - 1] : null);
        return { items, hasNext: !!nextEl && items.length > 0 };
      });

      log("  [STD] '" + keyword + "' p" + pageNum + ": " + result.items.length + " AO(s)");
      for (const item of result.items) {
        if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
      }
      if (!result.hasNext || result.items.length === 0) break;

      try {
        const nextSel = "a.next,a[rel='next'],.suivant:not(.disabled) a,a[id*='suivant'],a[title*='uivant']";
        const pgElems = await pg.$$("a[href*='javascript'],a[onclick*='Page']");
        const pgBtns  = [];
        for (const a of pgElems) {
          const txt = (await a.evaluate(el => el.textContent || "")).trim();
          if (/^\d+$/.test(txt) || /suivant|next|>/i.test(txt)) pgBtns.push(a);
        }
        const nextBtn = await pg.$(nextSel) || (pgBtns.length > 1 ? pgBtns[pgBtns.length - 1] : null);
        if (!nextBtn) break;
        await nextBtn.click();
        await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 });
        await delay(500);
      } catch (e) { log("  [STD] pagination: " + e.message.split("\n")[0]); break; }
    }
  } catch (e) {
    log("  [STD] searchPortalByKeyword erreur: " + e.message);
  } finally {
    if (pg) await pg.close().catch(() => {});
  }
  log("  [STD] -> '" + keyword + "' : " + all.length + " AO(s) total");
  // Taguer chaque item avec le keyword portail → matchCritere peut s'y fier
  return all.map(item => ({ ...item, _keyword: keyword }));
}

// ============================================================
// SCRAPING LISTE MP (PRADO - soumettre formulaire + pagination clic)
// ============================================================
async function scrapeAllMPs(browser) {
  const all = [], seen = new Set();
  let pg;
  try {
    pg = await newPage(browser);

    // 1. Charger la page de recherche
    log("  Chargement formulaire AO...");
    await pg.goto(CFG.mpListUrl, { waitUntil: "domcontentloaded", timeout: 55000 });
    await delay(1500);

    // 2. Lister TOUS les boutons submit/image sans limite pour trouver le vrai Rechercher
    const formInfo = await pg.evaluate(() => {
      const skip = ["flagImg","quickSearch","imageOk","selectedGeo","displayDomaine","displayQualif","selectedAgrements","buttonRefresh","boutonClear"];
      const allBtns = [...document.querySelectorAll("input[type='submit'],input[type='image'],button")]
        .map(el => ({ name: el.name||"", id: el.id||"", val: (el.value||el.textContent||"").trim().slice(0,30) }))
        .filter(el => (el.name || el.id) && !skip.some(s => el.name.includes(s)));
      const allLinks = [...document.querySelectorAll("a[onclick]")]
        .map(a => ({ text: (a.textContent||"").trim().slice(0,30), onclick: (a.getAttribute("onclick")||"").slice(0,80) }))
        .slice(0, 15);
      return { url: window.location.href, buttons: allBtns, links: allLinks };
    });
    log("  Formulaire URL: " + formInfo.url);

    // 3. Soumettre via PRADO - bouton lancerRecherche (nom confirme)
    log("  Soumission recherche AO...");
    const submitted = await pg.evaluate(() => {
      const target = document.getElementById("PRADO_POSTBACK_TARGET");
      // Essayer lancerRecherche en premier (nom confirme), puis fallback
      const btnName = (() => {
        const names = ["ctl0$CONTENU_PAGE$AdvancedSearch$lancerRecherche","ctl0$CONTENU_PAGE$AdvancedSearch$boutonRechercher","ctl0$CONTENU_PAGE$AdvancedSearch$rechercherButton"];
        for (const n of names) { if (document.querySelector("input[name='" + n + "'],button[name='" + n + "']")) return n; }
        // Fallback: premier bouton non-skip
        const skip = ["flagImg","quickSearch","imageOk","selectedGeo","displayDomaine","displayQualif","selectedAgrements","buttonRefresh","boutonClear"];
        const all = [...document.querySelectorAll("input[type='submit'],input[type='image'],button")]
          .filter(el => el.name && !skip.some(s => el.name.includes(s)));
        return all.length ? all[all.length - 1].name : null; // dernier = souvent Rechercher
      })();
      if (!btnName) return null;
      if (target) target.value = btnName;
      const form = document.forms[0] || document.querySelector("form");
      if (form) { form.submit(); return btnName; }
      return null;
    });
    log("  Soumission: " + (submitted || "echec"));
    try {
      await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
    } catch(e) { log("  waitForNav: " + e.message.split("\n")[0]); }
    await delay(1000);

    // 3b. Optimiser: passer à 500 résultats/page (options confirmées: 10,20,50,100,500)
    // Champ: ctl0$CONTENU_PAGE$resultSearch$listePageSizeTop
    const pageSized = await pg.evaluate(() => {
      const sel = document.querySelector("select[name*='listePageSizeTop'],select[id*='listePageSizeTop']");
      if (!sel || !sel.querySelector("option[value='500']")) return false;
      sel.value = "500";
      const target = document.getElementById("PRADO_POSTBACK_TARGET");
      if (target) target.value = sel.name;
      const form = document.forms[0] || document.querySelector("form");
      if (form) { form.submit(); return true; }
      return false;
    });
    if (pageSized) {
      try {
        await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
        log("  Page size -> 500 OK");
      } catch(e) { log("  Page size: " + e.message.split("\n")[0]); }
      await delay(800);
    }

    // 4. Paginer et extraire les AOs (500/page → typiquement 1-5 pages au lieu de 100-200)
    let pageNum = 0;
    while (pageNum < 20) {
      pageNum++;
      const result = await pg.evaluate(() => {
        const items = [], seenIds = new Set();
        const base  = window.location.origin;
        const sel   = "a[href*='refConsultation'],a[href*='EntrepriseDownloadAvisJAL'],a[href*='/show/']";
        document.querySelectorAll(sel).forEach(link => {
          const href = link.getAttribute("href") || "";
          let id = "";
          const refM  = href.match(/refConsultation[=]([^&\s]+)/);
          const avisM = href.match(/idAvis[=]([^&\s]+)/);
          const showM = href.match(/\/show\/(\d+)/);
          if (refM)       id = refM[1];
          else if (avisM) id = avisM[1];
          else if (showM) id = showM[1];
          if (!id || seenIds.has(id)) return;
          // Ignorer les IDs Base64 (doublons) et les liens panier
          if (/^[A-Za-z0-9+/]{8,}={0,2}$/.test(id) && !/^\d+$/.test(id)) return;
          if (href.includes("popUpGestionPanier") || href.includes("panier")) return;
          seenIds.add(id);
          const row   = link.closest("tr,.avis-item,li,article,div.row,.consultation-row,.ao-item");
          const txt   = row ? row.innerText : link.innerText;
          const lines = txt.split("\n").map(l => l.trim()).filter(Boolean);
          const dates = [...txt.matchAll(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/g)].map(m => m[1]);
          // Extraire l'URL reelle depuis javascript:popUp('url','yes')
          let fullUrl = href, orgAcronyme = "";
          const popM = href.match(/popUp\s*\(\s*['"]([^'"]+)/i);
          if (popM) {
            const inner = popM[1].replace(/&lang=\w*$/, "").replace(/&lang=$/, "");
            fullUrl = inner.startsWith("http") ? inner : base + "/" + inner.replace(/^\//, "");
            const oM = inner.match(/orgA(?:ccronyme|cronyme|cronymr)[=]([^&\s'"]+)/i);
            if (oM) orgAcronyme = oM[1];
          } else if (!href.startsWith("http")) {
            fullUrl = base + (href.startsWith("/") ? href : "/" + href);
          }
          if (!orgAcronyme) {
            const oM = href.match(/orgA(?:ccronyme|cronyme|cronymr)[=]([^&\s'"]+)/i);
            if (oM) orgAcronyme = oM[1];
          }
          items.push({
            id, reference: lines[0] || "",
            objet:       lines[1] || lines[0] || link.textContent.trim(),
            organisme:   lines[2] || "",
            date_limite: dates.length ? dates[dates.length - 1] : "",
            lieu:        lines.find(l => l.length > 5 && !l.match(/^\d{2}\//)) || "",
            wilaya: "", url: fullUrl, orgAcronyme,
          });
        });
        const nextSel = "a.next,a[rel='next'],.pagination a:last-child:not(.disabled),.suivant:not(.disabled) a,a[id*='suivant'],a[id*='next'],li.next:not(.disabled) a,td.next a,a[title*='uivant'],a[title*='Next'],a[href*='javascript'][onclick*='Page'],.paginationControls a:last-child,table.pagination td:last-child a,tfoot a";
        // Aussi chercher liens de pagination PRADO (numeros de pages)
        const currentPage = document.querySelector(".currentPage,.pagination .active,span.selectedPage");
        const allPageLinks = [...document.querySelectorAll("a[href*='javascript'],a[onclick*='Page']")]
          .filter(a => /^\d+$/.test((a.textContent||"").trim()) || /suivant|next|>/i.test((a.textContent||"").trim()));
        const nextEl  = document.querySelector(nextSel) || (allPageLinks.length > 1 ? allPageLinks[allPageLinks.length-1] : null);
        return {
          items, hasNext: !!nextEl,
          nextText: nextEl ? (nextEl.textContent||"").trim().slice(0,20) : null,
          paginationLinks: allPageLinks.map(a => (a.textContent||"").trim()).slice(0,10),
          url:   window.location.href,
          title: document.title,
          html:  items.length === 0 ? document.body.innerHTML.replace(/\s+/g," ").slice(0, 1500) : "",
        };
      });

      log("  Page " + pageNum + ": " + result.items.length + " AO" +
        (result.nextText ? " | next: [" + result.nextText + "]" : " | fin") +
        (result.paginationLinks && result.paginationLinks.length ? " | pages: " + JSON.stringify(result.paginationLinks) : ""));
      if (pageNum <= 2 && result.items.length === 0) {
        log("  DEBUG url: " + result.url);
        log("  DEBUG html: " + (result.html||"").slice(0, 600));
      }
      if (pageNum === 1 && result.items.length > 0) {
        log("  Exemple AO url: " + (result.items[0]||{}).url);
        log("  Exemple AO objet: " + (result.items[0]||{}).objet);
      }

      for (const item of result.items) {
        if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
      }
      if (!result.hasNext || result.items.length === 0) break;

      try {
        const nextSel = "a.next,a[rel='next'],.pagination a:last-child:not(.disabled),.suivant:not(.disabled) a,a[id*='suivant'],a[id*='next'],li.next:not(.disabled) a,td.next a,a[title*='uivant'],a[title*='Next'],a[href*='javascript'][onclick*='Page'],.paginationControls a:last-child,tfoot a";
        const allPgLinks = await pg.$$("a[href*='javascript'],a[onclick*='Page']");
        const numericLinks = [];
        for (const a of allPgLinks) {
          const txt = (await a.evaluate(el => el.textContent||"")).trim();
          if (/^\d+$/.test(txt) || /suivant|next|>/i.test(txt)) numericLinks.push(a);
        }
        const nextBtn = await pg.$(nextSel) || (numericLinks.length > 1 ? numericLinks[numericLinks.length-1] : null);
        if (!nextBtn) { log("  Pagination: aucun bouton suivant"); break; }
        await nextBtn.click();
        await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 });
        await delay(500);
      } catch(e) { log("  Pagination: " + e.message.split("\n")[0]); break; }
    }
  } catch(e) {
    log("  scrapeAllMPs erreur: " + e.message.split("\n")[0]);
  } finally {
    if (pg) await pg.close().catch(() => {});
  }
  log("  " + all.length + " MP sur le portail");
  return all;
}

// ============================================================
// ============================================================
// DIAGNOSTIC HTTP PAGE BC — fonction pure testable
// Analyse un HTML + statusCode et retourne un objet diagnostic.
// Utilisée par debugFetchBcPage() et les tests unitaires.
// ============================================================
function analyseBcPageHtml(html, statusCode, urlFetched) {
  const bodyLow = (html || "").toLowerCase();
  // Détection login
  const has_login_form = /id="ctl0_CONTENU_PAGE_login"|input[^>]*type="password"/i.test(html)
                      || bodyLow.includes("mot de passe") || bodyLow.includes("veuillez vous connecter");
  // Détection session expirée
  const has_session_expired = bodyLow.includes("session") && (bodyLow.includes("expir") || bodyLow.includes("connectez-vous"));
  // Détection Cloudflare
  const has_cloudflare = bodyLow.includes("cloudflare") || /just a moment/i.test(html);
  // Présence tableau / cartes BC
  const has_bc_table = /entreprise__card|href="[^"]*\/show\/\d+"/i.test(html);
  // Liens /show/ (dom_rows_count = nombre de hrefs /show/ distincts)
  const showLinks  = html.match(/href="[^"]*\/show\/(\d+)"/g) || [];
  const dom_rows_count = showLinks.length;
  // Titre de page
  const titleM    = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const page_title = titleM ? titleM[1].trim().slice(0, 100) : "(no title)";
  // IDs parsés via regex entreprise__card (même logique que fetchBCListPage)
  const bc_ids = [];
  const seen   = new Set();
  const cardRe = /class="[^"]*entreprise__card[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const idM = m[1].match(/\/show\/(\d+)/);
    if (idM && !seen.has(idM[1])) { seen.add(idM[1]); bc_ids.push(idM[1]); }
  }
  const parsed_count = bc_ids.length;
  // Raison finale
  let reason;
  if (statusCode !== 200)    reason = "0 BC car status HTTP " + statusCode;
  else if (has_cloudflare)   reason = "0 BC car cloudflare/challenge";
  else if (has_login_form)   reason = "0 BC car login/session expiree";
  else if (has_session_expired) reason = "0 BC car session expiree (cookie perdu)";
  else if (!has_bc_table)    reason = "0 BC car selecteur tableau introuvable (structure HTML changee?)";
  else if (parsed_count === 0) reason = "0 BC car parsing a echoue (cards presentes mais regex ne matche pas)";
  else                         reason = parsed_count + " BC reel portail";
  // sample_text : HTML strippé, sans données sensibles, tronqué
  const sample_text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
  return {
    ok:                statusCode === 200 && parsed_count > 0,
    url_finale:        urlFetched || "",
    status:            statusCode,
    page_title,
    has_login_form,
    has_session_expired,
    has_cloudflare,
    has_bc_table,
    dom_rows_count,
    parsed_count,
    bc_id_sample:      bc_ids.slice(0, 5),
    reason,
    sample_text,
  };
}

// ── HTTP diagnostic sans Puppeteer — n'interfère pas avec le cron ────────────
async function debugFetchBcPage(pageNum) {
  pageNum = pageNum || 1;
  const base   = CFG.bcListUrl;
  const urlFetch = pageNum === 1 ? base : base + (base.includes("?") ? "&" : "?") + "page=" + pageNum;
  const https  = require("https");
  const t0     = Date.now();
  return new Promise((resolve) => {
    const req = https.get(urlFetch, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Cache-Control":   "no-cache",
      },
      timeout: 20000,
    }, (res) => {
      const redirect = res.headers["location"] || null;
      let html = "";
      res.setEncoding("utf8");
      res.on("data", d => { html += d; });
      res.on("end", () => {
        const diag = analyseBcPageHtml(html, res.statusCode, urlFetch);
        diag.redirect    = redirect;
        diag.elapsed_ms  = Date.now() - t0;
        diag.html_length = html.length;
        resolve(diag);
      });
    });
    req.on("error",   (e) => resolve({
      ok: false, url_finale: urlFetch, status: 0, redirect: null,
      page_title: "", has_login_form: false, has_session_expired: false,
      has_cloudflare: false, has_bc_table: false, dom_rows_count: 0,
      parsed_count: 0, bc_id_sample: [],
      reason: "0 BC car erreur reseau: " + e.message.slice(0, 100),
      sample_text: "", elapsed_ms: Date.now() - t0, html_length: 0,
    }));
    req.on("timeout", () => {
      req.destroy();
      resolve({
        ok: false, url_finale: urlFetch, status: 0, redirect: null,
        page_title: "", has_login_form: false, has_session_expired: false,
        has_cloudflare: false, has_bc_table: false, dom_rows_count: 0,
        parsed_count: 0, bc_id_sample: [],
        reason: "0 BC car timeout HTTP (>20s)",
        sample_text: "", elapsed_ms: Date.now() - t0, html_length: 0,
      });
    });
  });
}

// FETCH HTTP LISTE BC — remplace Puppeteer pour la liste
// Le portail est SSR : le HTML contient directement les données.
// Structure : div.entreprise__card > a[href*=/show/] + texte
// ============================================================
async function fetchBCListPage(pageNum) {
  const base = CFG.bcListUrl;
  const url  = pageNum === 1 ? base : base + "?page=" + pageNum;
  const https = require("https");
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9",
        "Cache-Control":   "no-cache",
      },
      timeout: 20000,
    }, (res) => {
      let html = "";
      res.setEncoding("utf8");
      res.on("data", d => { html += d; });
      res.on("end", () => {
        log("  [HTTP] status=" + res.statusCode + " location=" + (res.headers["location"] || "-") + " len=" + html.length);
        log("  [HTTP] html_head: " + html.slice(0, 300).replace(/\s+/g, " "));
        const items = [];
        const seen  = new Set();
        // Extraire chaque carte BC
        const cardRe = /class="[^"]*entreprise__card[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
        let cardMatch;
        while ((cardMatch = cardRe.exec(html)) !== null) {
          const block = cardMatch[1];
          // ID depuis href /show/XXXXX
          const idM = block.match(/\/show\/(\d+)/);
          if (!idM) continue;
          const id = idM[1];
          if (seen.has(id)) continue;
          seen.add(id);
          // Objet
          const objetM = block.match(/Objet\s*:\s*<\/span>\s*([\s\S]*?)<\/a>/);
          const objet  = objetM ? objetM[1].replace(/<[^>]+>/g, "").trim() : "";
          // Acheteur / organisme
          const acheteurM = block.match(/Acheteur\s*:\s*<\/span>\s*([\s\S]*?)<\/a>/);
          const organisme = acheteurM ? acheteurM[1].replace(/<[^>]+>/g, "").trim() : "";
          // Date limite
          const dateM     = block.match(/(\d{2}\/\d{2}\/\d{4})/);
          const date_limite = dateM ? dateM[1] : "";
          // Lieu
          const lieuM = block.match(/Lieu d.ex.cution[\s\S]*?<\/[^>]+>\s*([\w\s\-]+)/);
          const lieu  = lieuM ? lieuM[1].trim() : "";
          items.push({
            id,
            reference:   "",
            objet,
            organisme,
            date_limite,
            lieu,
            wilaya:      "",
            url: "https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/" + id,
          });
        }
        // Détecter si page suivante existe
        const hasNext = html.includes("?page=" + (pageNum + 1)) || /page suivante|next page/i.test(html);
        resolve({ items, hasNext: hasNext && items.length > 0 });
      });
    });
    req.on("error",   (e) => { log("  [HTTP] error: " + e.message); resolve({ items: [], hasNext: false, failed: true }); });
    req.on("timeout", ()  => { log("  [HTTP] timeout page " + pageNum); req.destroy(); resolve({ items: [], hasNext: false, failed: true }); });
  });
}

async function fetchAllBCsHttp() {
  const all = []; const seen = new Set();
  log("  Chargement liste BC via HTTP fetch...");
  for (let pageNum = 1; pageNum <= 500; pageNum++) {
    const r = await fetchBCListPage(pageNum);
    if (r.failed || r.items.length === 0) break;
    for (const item of r.items) {
      if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
    }
    log("  -> Page " + pageNum + ": " + r.items.length + " BC (total: " + all.length + ")");
    if (!r.hasNext) break;
    await delay(300);
  }
  log("  " + all.length + " BC sur le portail");
  return all;
}

async function scrapeAllItems(browser, baseUrl, label, knownIds) {
  const all = []; let pageNum = 1; const BATCH = 1;
  let _lastFailed = false; let _lastFailReason = "";
  // ── BC_LISTING_EARLY_STOP_PAGES : arrêt anticipé listing quand N pages consécutives
  //    sont entièrement connues (tous IDs dans knownIds). Désactivé par défaut (0).
  //    Garde : désactivé si knownIds absent/vide, ou sur page 1.
  //    Première activation recommandée : BC_LISTING_EARLY_STOP_PAGES=5.
  const _earlyStopN = (() => {
    const raw = parseInt(process.env.BC_LISTING_EARLY_STOP_PAGES || "", 10);
    if (!Number.isFinite(raw) || raw <= 0) return 0;  // 0 = désactivé (défaut)
    return raw;
  })();
  const _earlyStopActive = _earlyStopN > 0 && knownIds && knownIds.size > 0;
  if (_earlyStopN === 0) {
    log("[EARLY_STOP] disabled (BC_LISTING_EARLY_STOP_PAGES not set or 0)");
  } else if (!_earlyStopActive) {
    log("[EARLY_STOP] disabled (knownIds vide — bcs_vus probablement vide) seuil=" + _earlyStopN);
  } else {
    log("[EARLY_STOP] active seuil=" + _earlyStopN + " pages known_ids=" + knownIds.size);
  }
  let _pagesWithoutNew = 0;
  log("  Chargement liste " + label + " (sequentiel, 1 page a la fois)...");
  while (pageNum <= 500) {
    const results = await Promise.all(
      Array.from({ length: BATCH }, (_, i) => scrapeOnePage(browser, baseUrl, pageNum + i))
    );
    let stop = false;
    for (const r of results) {
      if (r.failed) {
        _lastFailed = true;
        _lastFailReason = r._failReason || "navigation/timeout";
        stop = true; break;
      }
      if (r.items.length === 0) { _lastFailed = false; stop = true; break; }
      all.push(...r.items);
      // ── Early stop : N pages consécutives entièrement connues ─────────────
      if (_earlyStopActive && pageNum > 1 && r.items.length > 0) {
        const _newOnPage = r.items.filter(function(bc) { return !knownIds.has(bc.id); }).length;
        if (_newOnPage === 0) {
          _pagesWithoutNew++;
          log("[EARLY_STOP] page=" + pageNum + " all_known pages_without_new=" + _pagesWithoutNew + "/" + _earlyStopN);
          if (_pagesWithoutNew >= _earlyStopN) {
            log("[EARLY_STOP] triggered pages_without_new=" + _pagesWithoutNew + " → arret listing anticipé");
            stop = true; break;
          }
        } else {
          _pagesWithoutNew = 0;  // reset : nouveaux BC trouvés sur cette page
        }
      }
      // ─────────────────────────────────────────────────────────────────────
      if (!r.hasNext) { stop = true; break; }
    }
    log("  -> Pages " + pageNum + "-" + (pageNum + BATCH - 1) + ": " + all.length + " " + label);
    if (stop) break;
    pageNum += BATCH;
    await delay(600);
  }
  if (all.length === 0) {
    const _finalReason = _lastFailed
      ? "0 " + label + " car navigation/parsing echoue (" + _lastFailReason + ")"
      : "0 " + label + " reel portail (page chargee, aucun lien /show/ trouve)";
    log("  " + _finalReason);
  } else {
    log("  " + all.length + " " + label + " sur le portail");
  }
  // Propager le statut d'échec technique au caller (les tableaux JS sont des objets)
  all._scanFailed    = _lastFailed;
  all._scanFailReason = _lastFailReason;
  return all;
}

// Scraping fiche detail (BC et MP partagent la meme structure)
// ============================================================
// EXTRACTION TEXTE DEPUIS PDF (Bordereau des Prix / CPS)
// ============================================================
async function extractPDFArticles(page, pdfUrl) {
  if (!pdfParse) return [];
  try {
    // Recuperer les cookies de session puppeteer pour le telechargement
    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => c.name + "=" + c.value).join("; ");
    const resp = await fetch(pdfUrl, {
      headers: {
        "Cookie": cookieStr,
        "Referer": page.url(),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      timeout: 20000,
    });
    if (!resp.ok) return [];
    const buffer = await resp.buffer();
    if (!buffer || buffer.length < 500) return [];
    const data = await pdfParse(buffer, { max: 0 });
    return parsePDFArticles(data.text);
  } catch (e) {
    log("  PDF erreur: " + e.message);
    return [];
  }
}

// Parse les designations d'articles depuis le texte brut d'un PDF
// Fonctionne sur les bordereaux de prix (tableau: N° / Designation / Qte / Unite / PU)
function parsePDFArticles(text) {
  if (!text) return [];
  const articles = [];
  const seen = new Set();
  const lines = text.split(/\n/).map(l => l.trim()).filter(l => l.length > 2);

  // Pattern 1: lignes avec numero en debut (1 Designation de l'article ...)
  const numLineRe = /^(\d{1,3}[\.\)]\s*|\d{1,3}\s+)([A-Za-zÀ-ÿ؀-ۿ].{3,120})/;
  // Pattern 2: lignes qui ressemblent a des designations (sans etre des headers/totaux)
  const skipRe = /^(n°|num[eé]ro|d[eé]signation|quantit[eé]|unit[eé]|prix|total|montant|lot\s+n|objet|chapitre|article\s+\d|page\s+\d|\d+[\s,\.]+\d)/i;
  const shortSkip = /^(oui|non|ht|ttc|dh|mad|\d+[\.,]\d+|\d{1,2}\/\d{2}\/\d{4})$/i;

  for (const line of lines) {
    if (line.length < 5 || line.length > 250) continue;
    if (shortSkip.test(line)) continue;
    if (skipRe.test(line)) continue;
    // Priorite aux lignes numerotees
    const m = numLineRe.exec(line);
    if (m) {
      const desig = m[2].trim();
      if (desig.length > 4 && !seen.has(desig)) {
        seen.add(desig);
        articles.push({ designation: desig, specifications: "", quantite: "", unite: "" });
      }
    }
  }

  // Si pas assez de lignes numerotees, prendre les lignes textuelles significatives
  if (articles.length < 3) {
    for (const line of lines) {
      if (line.length < 8 || line.length > 200) continue;
      if (shortSkip.test(line) || skipRe.test(line)) continue;
      if (/^\d/.test(line)) continue; // skip lignes qui commencent par un chiffre
      if (seen.has(line)) continue;
      seen.add(line);
      articles.push({ designation: line, specifications: "", quantite: "", unite: "" });
      if (articles.length >= 80) break;
    }
  }

  return articles.slice(0, 150); // max 150 articles par PDF
}

// ============================================================
// SCRAPING FICHE DETAIL BC (HTML uniquement)
// ============================================================
async function scrapeBCDetail(page, bc) {
  try {
    await page.goto(bc.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(250 + Math.floor(Math.random() * 300));
    await page.evaluate(async () => {
      document.querySelectorAll(".accordion-toggle,.collapse-toggle,[data-toggle='collapse'],[data-bs-toggle='collapse'],.panel-heading a,.card-header button,button.accordion-button,summary").forEach(el => {
        try { el.click(); } catch(e) {}
      });
      document.querySelectorAll("details").forEach(d => { d.open = true; });
      await new Promise(r => setTimeout(r, 300));
    });
    const d = await page.evaluate(() => {
      const get = s => { const el = document.querySelector(s); return el ? el.innerText.trim() : ""; };
      // bodyText = texte complet pour scan profond + extraction date
      const mainEl = document.querySelector("main,.main-content,#contenu,#main,.container,.content") || document.body;
      const bodyText = (mainEl.innerText || document.body.innerText).replace(/\s+/g, " ").slice(0, 8000);
      let date_limite = "";
      const cm = bodyText.match(/(?:date\s*(?:limite|clot[uo]re|fin|d[eé]p[oô]t)[^:]*:?\s*)(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/i);
      if (cm) date_limite = cm[1];
      else {
        const all = [...bodyText.matchAll(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/g)].map(m => m[1]);
        if (all.length) date_limite = all[all.length - 1];
      }
      // Articles depuis tableaux HTML
      const articles = [], seen = new Set();
      const NAV_SKIP = /^(accueil|articles|connexion|contact|home|menu|login|actualit|recherche|portail|retour|suivant|pr[eé]c[eé]dent|imprimer|haut de page|plan du site|#\d)/i;
      document.querySelectorAll("table").forEach(t => {
        if (t.closest("nav,header,footer,.navbar,.nav,.menu,.breadcrumb,.pagination,.sidebar")) return;
        t.querySelectorAll("tr").forEach((row, i) => {
          if (i === 0) return;
          const cells = row.querySelectorAll("td");
          if (cells.length < 2) return;
          const desig = (cells[0].innerText || "").trim();
          if (!desig || desig.length < 5 || seen.has(desig)) return;
          if (NAV_SKIP.test(desig)) return;
          seen.add(desig);
          articles.push({
            designation:    desig,
            quantite:       cells.length >= 3 ? (cells[cells.length-2].innerText||"").trim() : "",
            unite:          cells.length >= 3 ? (cells[cells.length-1].innerText||"").trim() : "",
            specifications: cells.length >= 2 ? (cells[1].innerText||"").trim().slice(0,500) : "",
          });
        });
      });
      document.querySelectorAll("h4,h5,.article-title").forEach(h => {
        const desig = (h.innerText||"").trim();
        if (!desig || desig.length < 3 || seen.has(desig)) return;
        if (/^(objet|acheteur|organisme|reference|date|lieu)/i.test(desig)) return;
        seen.add(desig);
        let specs = "", next = h.nextElementSibling, n = 0;
        while (next && !["H3","H4","H5"].includes(next.tagName) && n < 5) {
          specs += (next.innerText||"").trim() + " "; next = next.nextElementSibling; n++;
        }
        articles.push({ designation: desig, specifications: specs.trim().slice(0,600), quantite: "", unite: "" });
      });
      return {
        reference:   get(".reference,#reference,h2") || document.title.replace(/.*#/,"").trim(),
        objet:       get(".objet,#objet,h1,.panel-title"),
        organisme:   get(".acheteur,.organisme,#acheteur"),
        lieu:        get(".lieu,#lieu"),
        wilaya:      get("[class*='wilaya'],[class*='region']"),
        date_limite, articles, bodyText,
      };
    });
    return { ...bc, ...d };
  } catch (e) { log("  BC Detail " + bc.id + ": " + e.message); return bc; }
}

// ============================================================
// TELECHARGEMENT & ANALYSE DAO (ZIP avec BDP/CPS)
// Utilise page.evaluate(fetch) pour partager la session Puppeteer
// ============================================================
async function downloadDAO(page, daoUrl) {
  if (!pdfParse) return { articles: [], bodyText: "" };
  try {
    log("  DAO tentative: " + daoUrl.slice(0, 100));
    // Fetch dans le contexte navigateur = meme session PRADO, pas besoin de copier les cookies
    const result = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url, {
          credentials: "include",
          headers: { "Accept": "application/zip,application/pdf,application/octet-stream,*/*" },
        });
        if (!resp.ok) return { ok: false, status: resp.status, ct: "" };
        const ct = resp.headers.get("content-type") || "";
        const ab = await resp.arrayBuffer();
        return { ok: true, status: resp.status, ct, data: Array.from(new Uint8Array(ab)) };
      } catch (e) { return { ok: false, status: 0, ct: "", err: e.message }; }
    }, daoUrl);

    if (!result.ok) {
      log("  DAO " + result.status + (result.err ? " err:" + result.err : "") + " url: " + daoUrl.slice(0, 80));
      return { articles: [], bodyText: "" };
    }
    const buffer = Buffer.from(result.data);
    if (!buffer || buffer.length < 100) return { articles: [], bodyText: "" };
    log("  DAO recu " + Math.round(buffer.length / 1024) + " KB ct=" + (result.ct || "?").slice(0, 40));

    const ct     = (result.ct || "").toLowerCase();
    const isZip  = ct.includes("zip") || ct.includes("octet-stream") ||
                   (buffer[0] === 0x50 && buffer[1] === 0x4B); // PK magic
    const isPdf  = ct.includes("pdf") || (buffer[0] === 0x25 && buffer[1] === 0x50); // %P magic

    // --- ZIP ---
    if (isZip && AdmZip) {
      log("  DAO ZIP " + Math.round(buffer.length / 1024) + " KB -> extraction PDFs...");
      let zip;
      try { zip = new AdmZip(buffer); } catch (e) {
        log("  DAO ZIP parse erreur: " + e.message);
        return { articles: [], bodyText: "" };
      }
      const entries = zip.getEntries();
      log("  DAO ZIP " + entries.length + " fichiers: " + entries.map(e => e.entryName).join(", ").slice(0, 200));

      const isBDP = n => /bordereau|bdp|b\.d\.p|prix.unit|prix.glo|bpu/i.test(n);
      const isCPS = n => /\bcps\b|cahier.*pres|prescri|specification/i.test(n);
      const isPDFname = n => /\.pdf$/i.test(n);

      const pdfEntries = entries.filter(e => isPDFname(e.entryName));
      const bdpEntries = pdfEntries.filter(e => isBDP(e.entryName));
      const cpsEntries = pdfEntries.filter(e => isCPS(e.entryName));
      const otherPDFs  = pdfEntries.filter(e => !isBDP(e.entryName) && !isCPS(e.entryName));
      const toProcess  = [...bdpEntries, ...cpsEntries, ...otherPDFs].slice(0, 5);

      if (toProcess.length === 0) {
        log("  DAO ZIP aucun PDF trouve parmi " + entries.length + " fichiers");
        return { articles: [], bodyText: "" };
      }
      let allArticles = [], allText = "";
      for (const entry of toProcess) {
        try {
          const pdfBuf = entry.getData();
          if (!pdfBuf || pdfBuf.length < 200) continue;
          const data = await pdfParse(pdfBuf, { max: 0 });
          const txt  = data.text || "";
          log("  DAO PDF '" + entry.entryName + "' " + txt.length + " chars");
          allText += "\n" + txt.slice(0, 6000);
          if (allArticles.length === 0) {
            const arts = parsePDFArticles(txt);
            if (arts.length > 0) allArticles = arts;
          }
        } catch (e) {
          log("  DAO PDF '" + entry.entryName + "' erreur: " + e.message);
        }
      }
      return { articles: allArticles, bodyText: allText.slice(0, 15000) };
    }

    // --- PDF direct ---
    if (isPdf) {
      log("  DAO PDF direct " + Math.round(buffer.length / 1024) + " KB -> extraction...");
      const data = await pdfParse(buffer, { max: 0 });
      const arts = parsePDFArticles(data.text || "");
      return { articles: arts, bodyText: (data.text || "").slice(0, 15000) };
    }

    log("  DAO format inconnu: ct=" + ct.slice(0, 50) + " size=" + buffer.length);
    return { articles: [], bodyText: "" };
  } catch (e) {
    log("  DAO erreur: " + e.message);
    return { articles: [], bodyText: "" };
  }
}

// ============================================================
// SCRAPING FICHE DETAIL MP (HTML + DAO ZIP/PDF BDP/CPS)
// ============================================================
// opts.skipDAO = true  -> PACK MOYEN  : popup HTML seulement, pas de DAO
// opts.skipDAO = false -> PACK AVANCÉ : popup HTML + téléchargement DAO (ZIP/PDF)
// défaut (pas d'opts)  -> comportement avancé (rétrocompat)
async function scrapeMPDetail(page, mp, opts) {
  const skipDAO = !!(opts && opts.skipDAO === true);
  try {
    // networkidle2 = attend que PRADO finisse de charger le contenu dynamique
    await page.goto(mp.url, { waitUntil: "networkidle2", timeout: 45000 });
    await delay(800 + Math.floor(Math.random() * 400));
    await page.evaluate(async () => {
      document.querySelectorAll(".accordion-toggle,.collapse-toggle,[data-toggle='collapse'],[data-bs-toggle='collapse'],.panel-heading a,.card-header button,button.accordion-button,summary").forEach(el => {
        try { el.click(); } catch (e) {}
      });
      document.querySelectorAll("details").forEach(d => { d.open = true; });
      await new Promise(r => setTimeout(r, 800));
    });

    // Extraire infos HTML + liens ZIP/PDF
    const d = await page.evaluate(() => {
      const get = s => { const el = document.querySelector(s); return el ? el.innerText.trim() : ""; };
      const mainElMP = document.querySelector("main,.main-content,#contenu,#main,.container,.content") || document.body;
      const bodyText = (mainElMP.innerText || document.body.innerText).replace(/\s+/g, " ").slice(0, 8000);
      let date_limite = "";
      const cm = bodyText.match(/(?:date\s*(?:limite|clot[uo]re|fin|d[eé]p[oô]t|remise|soumission)[^:]*:?\s*)(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/i);
      if (cm) date_limite = cm[1];
      else {
        const all = [...bodyText.matchAll(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/g)].map(m => m[1]);
        if (all.length) date_limite = all[all.length - 1];
      }

      // ---- Extraction lots depuis popup PopUpDetailLots (PRADO) ----
      // Structure de la page : tableau avec lignes "Lot N : | designation"
      // puis "Estimation (en Dhs TTC) : | montant" et "Caution provisoire : | montant"
      const lots = [];
      let curLot = null;
      // Parser 1 : table <tr><td> (PRADO classique)
      document.querySelectorAll("table tr, dl, .lot-row, .row-lot").forEach(row => {
        const cells = [...row.querySelectorAll("td, dd, .value, .field-value")];
        const labels = [...row.querySelectorAll("td, dt, .label, .field-label")];
        if (!cells.length && !labels.length) return;
        const allCells = cells.length >= 2 ? cells : [...row.querySelectorAll("td, th, dt, dd, div, span")].filter(el => el.children.length === 0);
        if (!allCells.length) return;
        const firstTxt = (allCells[0].innerText || "").trim();
        const valueTxt = allCells.length >= 2 ? (allCells[allCells.length - 1].innerText || "").trim() : firstTxt;
        const lotM = firstTxt.match(/^Lot\s+(\d+)\s*:/i);
        if (lotM) {
          const desig = valueTxt.replace(/^Lot\s+\d+\s*:\s*/i, "").trim() || firstTxt.replace(/^Lot\s+\d+\s*:\s*/i, "").trim();
          curLot = { lotNum: parseInt(lotM[1]), designation: desig, estimation: "", caution: "", categorie: "" };
          lots.push(curLot);
          return;
        }
        if (!curLot) return;
        const lbl = firstTxt.toLowerCase();
        if (/estimation/i.test(lbl))   curLot.estimation = valueTxt;
        if (/caution/i.test(lbl))      curLot.caution    = valueTxt;
        if (/cat[eé]gorie/i.test(lbl)) curLot.categorie  = valueTxt;
      });

      // Parser 2 : fallback bodyText regex (si aucune table trouvée)
      // Format connu : "Lot 1 : Désignation Catégorie : X Estimation ... : Y,YY Caution ... : Z,ZZ"
      if (lots.length === 0 && bodyText.match(/Lot\s+\d+\s*:/i)) {
        const parts = bodyText.split(/(?=\bLot\s+\d+\s*:)/i).filter(p => /^Lot\s+\d+\s*:/i.test(p.trim()));
        parts.forEach(block => {
          const lm = block.match(/^Lot\s+(\d+)\s*:\s*(.*?)(?:\s+Cat[eé]gorie\s*:|$)/i);
          if (!lm) return;
          const lotNum = parseInt(lm[1]);
          const designation = lm[2].trim();
          const estM = block.match(/Estimation\s*(?:\([^)]+\))?\s*:\s*([\d\s]+[,.]\s*\d+(?:\s*DH)?)/i);
          const cauM = block.match(/Caution\s+provisoire\s*:\s*([\d\s]+[,.]\s*\d+(?:\s*DH)?)/i);
          const catM = block.match(/Cat[eé]gorie\s*:\s*([^\n]+?)(?:\s+Description\s*:|\s+Estimation\s*:|\s+Caution\s*:|$)/i);
          lots.push({
            lotNum,
            designation,
            estimation: estM ? estM[1].trim() : "",
            caution:    cauM ? cauM[1].trim() : "",
            categorie:  catM ? catM[1].trim() : "",
          });
        });
      }

      // Calcul budget total (somme estimations de tous les lots)
      let estimationTotale = 0;
      lots.forEach(l => {
        const n = parseFloat((l.estimation || "").replace(/\s/g, "").replace(",", ".").replace(/[^\d.]/g, ""));
        if (!isNaN(n)) estimationTotale += n;
      });
      const estimation_totale = estimationTotale > 0
        ? estimationTotale.toLocaleString("fr-MA", { maximumFractionDigits: 2 }) : "";

      // Convertir lots en articles (format unifié)
      const htmlArticles = lots.length > 0
        ? lots.map(l => ({
            designation:    "Lot " + l.lotNum + " : " + l.designation,
            specifications: l.categorie && l.categorie !== "-" ? "Cat.: " + l.categorie : "",
            quantite:       "",
            unite:          "",
            estimation:     l.estimation !== "-" ? l.estimation : "",
            caution:        l.caution    !== "-" ? l.caution    : "",
          }))
        : [];

      // Fallback: extraction generique si pas de lots trouves (autres types de pages)
      if (htmlArticles.length === 0) {
        const seen = new Set();
        document.querySelectorAll("table tr").forEach((row, i) => {
          if (i === 0) return;
          const cells = row.querySelectorAll("td");
          if (!cells.length) return;
          const desig = (cells[0].innerText || "").trim();
          if (!desig || desig.length < 3 || seen.has(desig)) return;
          seen.add(desig);
          htmlArticles.push({
            designation:    desig,
            quantite:       cells.length >= 3 ? (cells[cells.length - 2].innerText || "").trim() : "",
            unite:          cells.length >= 3 ? (cells[cells.length - 1].innerText || "").trim() : "",
            specifications: cells.length >= 2 ? (cells[1].innerText || "").trim().slice(0, 400) : "",
            estimation: "", caution: "",
          });
        });
      }

      // Tous les liens de telechargement (ZIP prioritaire, puis PDF)
      const allLinks = [...document.querySelectorAll("a[href]")].map(a => ({
        href: a.href,
        text: (a.textContent || a.innerText || "").trim().toLowerCase(),
      }));
      const isDocLink = l =>
        /\.(zip|pdf)$/i.test(l.href) ||
        l.href.includes("DownloadDAO") ||
        l.href.includes("DownloadAnnonce") ||
        l.href.includes("/download") ||
        l.href.includes("/document") ||
        l.href.includes("/fichier") ||
        l.href.includes("telecharger") ||
        /dao|dossier|bordereau|bdp|cps|cahier|reglement|rc\b/i.test(l.text);

      const zipLinks = allLinks.filter(l => isDocLink(l) && (/\.zip$/i.test(l.href) || l.href.includes("DownloadDAO") || /dao|dossier/i.test(l.text)));
      const pdfLinks = allLinks.filter(l => isDocLink(l) && /\.pdf$/i.test(l.href));
      const orgM     = window.location.href.match(/orgAcronyme[=]([^&\s]+)/);
      const refM     = window.location.href.match(/refConsultation[=]([^&\s]+)/);
      // Logger tous les liens pour diagnostic
      const allHrefs = [...document.querySelectorAll("a[href]")]
        .map(a => ({ t: (a.textContent||"").trim().slice(0,30), h: a.getAttribute("href")||"" }))
        .filter(l => l.h && l.h.length > 2 && !l.h.startsWith("#"))
        .slice(0, 20);
      return {
        reference:  get(".reference,#reference,.num-ao,.numero-ao,h2") || document.title.replace(/.*#/, "").trim(),
        objet:      get(".objet,#objet,h1,.panel-title,.intitule,.titre-ao"),
        organisme:  get(".acheteur,.organisme,#acheteur,.maitre-ouvrage,.mo"),
        lieu:       get(".lieu,#lieu"),
        wilaya:     get("[class*='wilaya'],[class*='region'],[class*='prefect']"),
        budget:     get(".montant,.budget,.estimation,[class*='montant'],[class*='budget']"),
        procedure:  get(".type-procedure,.procedure,.type-ao,[class*='procedure']"),
        date_limite,
        estimation_totale,
        htmlArticles,
        zipLinks:   zipLinks.map(l => l.href).slice(0, 3),
        pdfLinks:   pdfLinks.map(l => l.href).slice(0, 4),
        orgAcronyme: orgM ? orgM[1] : "",
        refConsultation: refM ? refM[1] : "",
        bodyText,
        pageUrl: window.location.href,
        allHrefs,
      };
    });

    log("  MP " + mp.id + ": ZIP=" + (d.zipLinks||[]).length + " PDF=" + (d.pdfLinks||[]).length +
        " HTML=" + (d.htmlArticles||[]).length + " articles | page: " + (d.pageUrl||"").slice(0,70));
    if ((d.bodyText||"").length < 200) {
      log("  MP " + mp.id + " popup vide! bodyText=" + (d.bodyText||"").slice(0,100));
      log("  MP " + mp.id + " liens popup: " + JSON.stringify((d.allHrefs||[]).slice(0,8)));
    } else {
      log("  MP " + mp.id + " popup ok (" + (d.bodyText||"").length + " chars): " + (d.bodyText||"").slice(0,150).replace(/\s+/g," "));
    }

    let daoArticles = [], daoBodyText = "";

    if (!skipDAO) {
      // PACK AVANCÉ : téléchargement DAO (ZIP BDP/CPS)
      const daoUrls = [...(d.zipLinks || [])];
      const refC = d.refConsultation || mp.id;
      const org  = d.orgAcronyme || mp.orgAcronyme || "";
      if (refC) {
        const daoBase = "https://www.marchespublics.gov.ma/index.php?page=entreprise.EntrepriseDownloadDAO";
        daoUrls.push(daoBase + "&refConsultation=" + refC + (org ? "&orgAcronyme=" + org : ""));
      }
      log("  MP " + mp.id + " [AVANCÉ] org=" + org + " daoUrls=" + daoUrls.length);
      const sortedPDFs = [
        ...(d.pdfLinks || []).filter(u => /bordereau|bdp|bpu/i.test(u)),
        ...(d.pdfLinks || []).filter(u => /\bcps\b|cahier|prescri/i.test(u)),
        ...(d.pdfLinks || []).filter(u => !/bordereau|bdp|bpu|\bcps\b|cahier|prescri/i.test(u)),
      ];

      for (const url of daoUrls) {
        const result = await downloadDAO(page, url);
        if (result.articles.length > 0 || result.bodyText.length > 200) {
          log("  MP " + mp.id + ": DAO OK -> " + result.articles.length + " articles, " + result.bodyText.length + " chars");
          daoArticles = result.articles;
          daoBodyText = result.bodyText;
          break;
        }
      }
      // Fallback PDFs si DAO ZIP vide
      if (daoArticles.length === 0 && daoBodyText.length < 200) {
        for (const pdfUrl of sortedPDFs.slice(0, 3)) {
          const result = await downloadDAO(page, pdfUrl);
          if (result.articles.length > 0 || result.bodyText.length > 200) {
            log("  MP " + mp.id + ": PDF fallback OK -> " + result.articles.length + " articles");
            daoArticles = result.articles;
            daoBodyText = result.bodyText;
            break;
          }
        }
      }
    } else {
      log("  MP " + mp.id + " [MOYEN] skip DAO, popup HTML uniquement");
    }

    // Articles finaux: DAO > HTML
    const articles = daoArticles.length > 0 ? daoArticles : (d.htmlArticles || []);
    // bodyText final: page HTML + contenu DAO (si avancé)
    const bodyText = (d.bodyText || "") + (daoBodyText ? "\n" + daoBodyText : "");

    if (articles.length === 0 && daoBodyText.length < 200) {
      log("  MP " + mp.id + ": aucun contenu extrait - URL: " + mp.url.slice(0, 80));
    }

    const { htmlArticles, zipLinks, pdfLinks, orgAcronyme, refConsultation, pageUrl, ...rest } = d;
    // Ne pas écraser les champs non-vides issus des résultats de recherche (objet, organisme, etc.)
    // Le popup PopUpDetailLot ne contient pas ces champs → rest.objet = "" → on garde mp.objet
    const cleanRest = Object.fromEntries(Object.entries(rest).filter(([k, v]) => {
      if (v === "" || v === null || v === undefined) return false;
      // Le popup retourne "Descriptif des lots - Consultation" comme titre générique → ne pas écraser l'objet réel
      if (k === "objet" && /descriptif des lots/i.test(String(v))) return false;
      return true;
    }));
    // bodyText final enrichi des métadonnées de base (pour que le matching keyword fonctionne même si popup vide)
    const metaPrefix = [mp.objet, mp.organisme, mp.reference].filter(Boolean).join(" ");
    const finalBodyText = (metaPrefix ? metaPrefix + " " : "") + bodyText;
    return { ...mp, ...cleanRest, articles, bodyText: finalBodyText.slice(0, 20000), estimation_totale: d.estimation_totale || mp.estimation_totale || "" };
  } catch (e) { log("  MP Detail " + mp.id + ": " + e.message); return mp; }
}

async function loadDetails(browser, items, label, isMP, opts) {
  if (!items.length) return [];
  const packLabel = opts && opts.skipDAO === true ? "[MOYEN]" : opts && opts.skipDAO === false ? "[AVANCÉ]" : "";
  // ── BC_DETAIL_CONCURRENT : parallélisme chargement fiches (défaut 3, max 6) ──
  const BATCH = (() => {
    const raw = parseInt(process.env.BC_DETAIL_CONCURRENT || "", 10);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 6) return raw;
    return 3;  // défaut inchangé
  })();
  log("  Chargement " + items.length + " fiches " + label + " " + packLabel + " (" + BATCH + " en parallele)...");
  // ── BC_DETAIL_TIMEOUT_MS : timeout dur par fiche BC (defaut 45s) ──────────
  const bcDetailTimeoutMs = (() => {
    const raw = parseInt(process.env.BC_DETAIL_TIMEOUT_MS || "", 10);
    return (Number.isFinite(raw) && raw > 0) ? raw : 45000;
  })();
  const _fiches_start = Date.now();
  let _fiches_failed = 0;
  const PROGRESS_EVERY = items.length >= 100 ? 50 : 25;
  const result = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const pages = await Promise.all(batch.map(() => newPage(browser)));
    const prevLen = result.length;
    const detailed = await Promise.all(batch.map((item, idx) => {
      if (isMP) {
        return scrapeMPDetail(pages[idx], item, opts).catch(() => item);
      }
      // BC : timeout dur via Promise.race
      const t0 = Date.now();
      const timeoutReject = new Promise((_, rej) =>
        setTimeout(() => rej(new Error("TIMEOUT")), bcDetailTimeoutMs));
      return Promise.race([scrapeBCDetail(pages[idx], item), timeoutReject]).catch(e => {
        const elapsed = Date.now() - t0;
        if (e && e.message === "TIMEOUT") {
          log("[FICHE_ERR] ref=" + (item.reference || item.id) + " category=TIMEOUT elapsed=" + elapsed + " url=" + (item.url || ""));
        }
        _fiches_failed++;
        return item;
      });
    }));
    await Promise.all(pages.map(p => p.close().catch(() => {})));
    result.push(...detailed);
    // Progress log tous les PROGRESS_EVERY items
    const prevMilestone = Math.floor(prevLen / PROGRESS_EVERY);
    const currMilestone = Math.floor(result.length / PROGRESS_EVERY);
    if (currMilestone > prevMilestone) {
      const elapsed = Date.now() - _fiches_start;
      log("[FICHES] loaded=" + result.length + "/" + items.length + " failed=" + _fiches_failed + " elapsed=" + elapsed + "ms");
    }
    await delay(isMP ? 400 : 200);
  }
  return result;
}

// ============================================================
// SHADOW MODE — HOOKS FIRE-AND-FORGET (Livrable 4)
//
// Observe le core intelligent EN PARALLÈLE du legacy, sans aucun effet de bord.
// Aucune notification n'est modifiée. Aucun await bloquant dans le pipeline.
// Désactivé par défaut (SHADOW_MODE_ENABLED=false → comportement legacy identique).
//
// Kill switch immédiat : SHADOW_MODE_EMERGENCY_KILL=true
// ============================================================

const _SHADOW_ENABLED        = process.env.SHADOW_MODE_ENABLED        === "true";
const _SHADOW_LLM_ON         = process.env.SHADOW_LLM_ENABLED         === "true";
const _SHADOW_CLIENT_FILTER  = process.env.SHADOW_CLIENT_FILTER        || "all";
const _SHADOW_RATE           = parseFloat(process.env.SHADOW_BC_SAMPLE_RATE  || "0.1");
const _SHADOW_OPP_MAX        = parseInt( process.env.SHADOW_OPPORTUNITY_MAX  || "5", 10);
const _SHADOW_EMERGENCY      = process.env.SHADOW_MODE_EMERGENCY_KILL  === "true";

/** Singleton lazy du ShadowRunner compilé. null si dist/ absent. */
let _shadowRunnerInstance = null;

function _getShadowRunner() {
  if (_shadowRunnerInstance) return _shadowRunnerInstance;
  try {
    const { ShadowRunner } = require("./dist/core/shadow/runner");
    const config = {
      shadow_mode_enabled:    _SHADOW_ENABLED,
      shadow_llm_enabled:     _SHADOW_LLM_ON,
      shadow_client_filter:   _SHADOW_CLIENT_FILTER,
      shadow_bc_sample_rate:  _SHADOW_RATE,
      shadow_opportunity_max: _SHADOW_OPP_MAX,
    };
    _shadowRunnerInstance = new ShadowRunner(config);
  } catch (_e) {
    // dist/ non compilé → shadow inactif, legacy inchangé
    _shadowRunnerInstance = null;
  }
  return _shadowRunnerInstance;
}

/**
 * Convertit un item BC legacy en forme compatible ParsedBC.
 * Ne valide pas via Zod — conversion best-effort.
 */
function _toShadowBC(item) {
  const url = (item.url && item.url.startsWith("http"))
    ? item.url
    : "https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/" + (item.id || "unknown");
  return {
    id:          String(item.id          || ""),
    objet:       String(item.objet       || ""),
    organisme:   String(item.organisme   || ""),
    wilaya:      String(item.wilaya      || ""),
    lieu:        String(item.lieu        || ""),
    date_limite: String(item.date_limite || ""),
    reference:   String(item.reference  || ""),
    url,
    radar_type:  "bc",
    articles:    Array.isArray(item.articles) ? item.articles.map(function(a) {
      return {
        designation:    String(a.designation    || ""),
        specifications: String(a.specifications || ""),
        quantite:       String(a.quantite       || ""),
        unite:          String(a.unite          || ""),
      };
    }) : [],
    bodyText:    String(item.bodyText || "").slice(0, 10000),
    montant:     (typeof item.montant === "number" && item.montant > 0) ? item.montant : null,
  };
}

/**
 * Convertit un profil client legacy + critères en forme compatible ClientProfile.
 * Ne valide pas via Zod — conversion best-effort.
 */
function _toShadowClient(client, criteres) {
  return {
    id:   String(client.id   || ""),
    nom:  String(client.nom  || ""),
    pack: client.pack || "starter",
    business_profile: {
      secteurs:          Array.isArray(client.secteurs)          ? client.secteurs          : [],
      types_prestation:  Array.isArray(client.types_prestation)  ? client.types_prestation  : [],
      organismes_cibles: Array.isArray(client.organismes_cibles) ? client.organismes_cibles : [],
      exclusions_metier: Array.isArray(client.exclusions_metier) ? client.exclusions_metier : [],
    },
    technical_profile: {
      produits:       Array.isArray(client.produits)       ? client.produits       : [],
      specifications: Array.isArray(client.specifications) ? client.specifications : [],
    },
    organization_profile: {
      ville:             String(client.ville || ""),
      wilayas_couvertes: Array.isArray(client.wilayas_couvertes) ? client.wilayas_couvertes : [],
      wilayas_exclues:   Array.isArray(client.wilayas_exclues)   ? client.wilayas_exclues   : [],
    },
    criteres: Array.isArray(criteres) ? criteres.map(function(c) {
      return {
        id:            String(c.id     || ""),
        type:          c.type || "contenu",
        valeur:        String(c.valeur || ""),
        radar_type:    "bc",
        ai_inclusions: Array.isArray(c.ai_inclusions) ? c.ai_inclusions : [],
        ai_exclusions: Array.isArray(c.ai_exclusions) ? c.ai_exclusions : [],
        actif:         true,
      };
    }) : [],
    notifications_enabled: true,
  };
}

/**
 * Persiste un ShadowRunLog dans Supabase — best-effort, jamais fatal.
 * @param {object} entry — ShadowRunLog
 */
function _shadowPersistLog(entry) {
  if (!CFG.sbUrl || !CFG.sbKey) return;
  fetch(CFG.sbUrl + "/rest/v1/shadow_run_log", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        CFG.sbKey,
      "Authorization": "Bearer " + CFG.sbKey,
      "Prefer":        "return=minimal",
    },
    body: JSON.stringify(entry),
  }).catch(function() { /* best-effort — erreur réseau ignorée */ });
}

/**
 * Persiste une liste de ShadowOpportunity dans Supabase — best-effort, jamais fatal.
 * @param {object[]} opps — ShadowOpportunity[]
 */
function _shadowPersistOpportunities(opps) {
  if (!opps.length || !CFG.sbUrl || !CFG.sbKey) return;
  fetch(CFG.sbUrl + "/rest/v1/shadow_opportunity", {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        CFG.sbKey,
      "Authorization": "Bearer " + CFG.sbKey,
      "Prefer":        "return=minimal",
    },
    body: JSON.stringify(opps),
  }).catch(function() { /* best-effort — erreur réseau ignorée */ });
}

/**
 * J1 — Compare la décision legacy vs core pour un BC × critère × client.
 *
 * Fire-and-forget : ne bloque jamais le pipeline legacy.
 * Appelé à deux points :
 *   - J1-miss  : legacyDecision=false, critereId=""
 *   - J1-match : legacyDecision=true,  critereId=matched[0].id
 *
 * @param {object} item           — item BC legacy (non muté)
 * @param {object} client         — client legacy (non muté)
 * @param {object[]} criteres     — critères actifs du client
 * @param {boolean} legacyDecision
 * @param {string}  critereId     — ID du critère matchant (ou "" pour miss)
 */
function fireShadowEval(item, client, criteres, legacyDecision, critereId) {
  if (_SHADOW_EMERGENCY || !_SHADOW_ENABLED) return;
  const runner = _getShadowRunner();
  if (!runner) return;
  const legacyScore = legacyDecision ? 100 : 0;
  const shadowBC     = _toShadowBC(item);
  const shadowClient = _toShadowClient(client, criteres);
  void runner.evaluateCritere({
    bc:              shadowBC,
    client:          shadowClient,
    critere_id:      critereId || "",
    legacy_score:    legacyScore,
    legacy_decision: legacyDecision,
  }).then(function(result) {
    if (!result.skipped) _shadowPersistLog(result.log);
  }).catch(function() { /* isolation totale — jamais fatal */ });
}

/**
 * J1-miss / J2 — Détecte des opportunités cachées pour un BC faible ou déjà notifié.
 *
 * Fire-and-forget : ne bloque jamais le pipeline legacy.
 * Appelé à deux points :
 *   - J1-miss : wasNotifiedLegacy=false → BC faible, candidat opportunité
 *   - J2      : wasNotifiedLegacy=true  → runner skippe immédiatement (already_notified)
 *
 * @param {object} item              — item BC legacy (non muté)
 * @param {object} client            — client legacy (non muté)
 * @param {object[]} criteres        — critères actifs du client
 * @param {boolean} wasNotifiedLegacy
 */
function fireShadowDetect(item, client, criteres, wasNotifiedLegacy) {
  if (_SHADOW_EMERGENCY || !_SHADOW_ENABLED) return;
  const runner = _getShadowRunner();
  if (!runner) return;
  const legacyScore  = wasNotifiedLegacy ? 100 : 0;
  const shadowBC     = _toShadowBC(item);
  const shadowClient = _toShadowClient(client, criteres);
  void runner.detectOpportunities({
    bc:                   shadowBC,
    client:               shadowClient,
    legacy_score:         legacyScore,
    was_notified_legacy:  wasNotifiedLegacy,
  }).then(function(result) {
    if (!result.skipped && result.opportunities.length > 0) {
      _shadowPersistOpportunities(result.opportunities.slice());
    }
  }).catch(function() { /* isolation totale — jamais fatal */ });
}

// ============================================================
// SNAPSHOT LOCAL DU SCAN BC
// Sauvegarde chaque décision de matching pour audit offline.
// Aucune logique de matching modifiée — observation pure.
// ============================================================
// Configurable via RADAR_BC_SNAPSHOT_DIR (ex: /tmp/radar-bc-snapshots sur Fly.io).
// Par défaut : data/scan-snapshots et data/input-snapshots à côté du script.
const _SNAPSHOT_BASE     = process.env.RADAR_BC_SNAPSHOT_DIR
  ? process.env.RADAR_BC_SNAPSHOT_DIR
  : path.join(__dirname, "data");
const SNAPSHOT_DIR       = path.join(_SNAPSHOT_BASE, "scan-snapshots");
const INPUT_SNAPSHOT_DIR = path.join(_SNAPSHOT_BASE, "input-snapshots");
// Opt-in : RADAR_BC_WRITE_INPUT_SNAPSHOT=1 → écrit data/input-snapshots/bc-input-<ts>.jsonl
// Capture les BC détaillés AVANT matching client — snapshot brut d'entrée.
const WRITE_INPUT_SNAPSHOT = process.env.RADAR_BC_WRITE_INPUT_SNAPSHOT === "1";

// ============================================================
// SHADOW MATCH COMPARISON
// Activé par RADAR_BC_MATCH_SHADOW=1 — aucun effet sans ce flag.
// Compare la logique actuelle (legacy) avec un texte propre
// (objet + articles uniquement, sans boilerplate portail).
// ============================================================
const SHADOW_ENABLED = process.env.RADAR_BC_MATCH_SHADOW === "1";
const SHADOW_DIR          = path.join(__dirname, "data", "shadow");
const SHADOW_CLIENT_FILTER = process.env.RADAR_BC_MATCH_SHADOW_CLIENT || null;
// Quand OFF (defaut) : le matching legacy utilise seulement c.valeur.
// Mettre a "1" pour retrouver l'ancien comportement valeur+ai_inclusions.
const LEGACY_USE_AI_INCLUSIONS = process.env.RADAR_BC_LEGACY_USE_AI_INCLUSIONS === "1";
// Seuils de force pour le clean shadow scoring (observation uniquement)
const CLEAN_WEAK_THRESHOLD   = 5;   // score >= 5  → match_faible (signal unique, incertain)
const CLEAN_STRONG_THRESHOLD = 15;  // score >= 15 → match_fort (plusieurs signaux concordants)
// GD-023 : signaux inclusions haute confiance (100% keep, >=3 occurrences humaines)
// Recevront +10 au lieu de +5 dans _shadowScoreClean — shadow uniquement, pas de notif
const CLEAN_TRUSTED_INCLUSION_SCORE = new Set([
  'photocopieur', 'insecticide', 'deratisation', 'desinsectisation',
  'desinfection', 'savon', 'eau minerale',
]);
var   _shadowAccum        = [];  // remis à zéro à chaque rapport

/**
 * Construit le texte de matching propre :
 *   objet + articles[] (désignations + spécifications si disponibles)
 *   + section "Articles" du bodyText en fallback
 * Exclut : navigation portail, "Nature de prestation", boilerplate.
 */
/**
 * Construit le texte de matching propre pour le shadow :
 *   objet (direct ou extrait de bodyText) + articles structurés ou section bodyText.
 *
 * Différences vs legacy matchCritere :
 *   - N'utilise PAS item._keyword  (évite les faux positifs keyword de recherche)
 *   - Cherche "Articles" APRÈS la section OBJET (évite les hits dans la nav portail)
 *   - Supprime la boilerplate portail connue des désignations d'articles
 */
function buildCleanMatchText(item) {
  var bt = item.bodyText || "";

  // 1. Objet : champ CSS-extrait ou extraction regex depuis bodyText
  //    (même logique que makeSnapshotRow — évite de retourner "" quand le sélecteur CSS a échoué)
  var objet = (item.objet || "").trim();
  if (!objet && bt) {
    objet = (_snapExtractObjet(bt) || "");
  }

  // 2. Articles structurés (tables HTML scrappées par scrapeBCDetail)
  var articlesText = "";
  if (item.articles && item.articles.length) {
    articlesText = item.articles.map(function(a) {
      return [(a.designation || ""), (a.specifications || "")].join(" ");
    }).join(" ").trim();
    // Supprimer boilerplate portail connu ("Nature de prestation" systématique)
    articlesText = articlesText
      .replace(/Achat de mat[eé]riel technique[,\s]+de logiciels et de mat[eé]riel informatique/gi, " ")
      .trim();
  }

  // 3. Fallback bodyText : chercher la section "Articles" APRÈS "OBJET"
  //    Chercher APRÈS la section OBJET évite les occurrences dans la navigation portail
  if (!articlesText && bt) {
    // Point de départ : section OBJET (skip navigation portail ~0–1500 chars)
    var scanStart = 0;
    var objPos = bt.search(/\bOBJET\b/i);
    if (objPos > 0 && objPos < 1500) scanStart = objPos;
    var searchZone = bt.slice(scanStart);

    // Marqueurs précis d'un vrai tableau d'articles (vs navigation portail)
    var artMatch = searchZone.match(/Articles\s+(?:Tout afficher|N[°o°\s]|D[eé]signation|\d)/i)
                || searchZone.match(/D[eé]signation\s+(?:Quantit[eé]|Unit[eé]|Sp[eé]c)/i)
                || searchZone.match(/(?:Lot|Article)\s+N[°o]/i);
    if (artMatch) {
      var artIdx = searchZone.indexOf(artMatch[0]);
      articlesText = searchZone.slice(artIdx)
        .replace(/^Articles\s+Tout afficher\s+Tout r[eé]duire\s*/i, "")
        .replace(/Achat de mat[eé]riel technique[,\s]+de logiciels et de mat[eé]riel informatique/gi, " ")
        .trim()
        .slice(0, 2000);
    }
  }

  return (objet + " " + articlesText).trim();
}

/**
 * Debug shadow — loggue les champs clés des 3 premiers items en cours du client filtré.
 * No-op si SHADOW_CLIENT_FILTER n'est pas défini ou si le client ne correspond pas.
 * Appeler AVANT _computeShadowComparison pour diagnostiquer les divergences clean/legacy.
 */
function _shadowDebugItems(client, items, criteres) {
  if (!SHADOW_CLIENT_FILTER) return;
  var cn = client.nom || "";
  if (cn !== SHADOW_CLIENT_FILTER && String(client.id) !== SHADOW_CLIENT_FILTER) return;

  // ── 1. Profil critères du client ──────────────────────────────────────────
  log("[Shadow][Debug] ====== PROFIL CRITERES : " + cn + " ======");
  log("[Shadow][Debug] nb_criteres=" + criteres.length);
  criteres.slice(0, 10).forEach(function(c, ci) {
    var inclStr = (c.ai_inclusions || []).join(" | ") || "(vide)";
    var exclStr = (c.ai_exclusions || []).join(" | ") || "(vide)";
    log("[Shadow][Debug] critere[" + ci + "] valeur=" + JSON.stringify(c.valeur) +
        "  type=" + (c.type||"?") +
        "  inclusions(" + (c.ai_inclusions||[]).length + ")=" + inclStr.slice(0, 120) +
        "  exclusions(" + (c.ai_exclusions||[]).length + ")=" + exclStr.slice(0, 80));
  });

  // Pool total des signaux disponibles (valeur + toutes ai_inclusions)
  var signalPool = [];
  criteres.forEach(function(c) {
    signalPool.push(c.valeur);
    (c.ai_inclusions || []).forEach(function(t) { if (t) signalPool.push(t); });
  });
  log("[Shadow][Debug] signal_pool_total=" + signalPool.length +
      "  signaux=" + signalPool.slice(0, 20).join(" | "));

  // ── 2. Debug items (3 premiers en cours) ─────────────────────────────────
  var enCours = items.filter(function(i) { return isEnCours(i); }).slice(0, 3);
  log("[Shadow][Debug] items_en_cours=" +
      items.filter(function(i) { return isEnCours(i); }).length +
      "  debug sur " + enCours.length + " items");

  enCours.forEach(function(item, n) {
    var cleanText   = buildCleanMatchText(item);
    var legacyMatch = itemMatchesCriteres(item, criteres);
    var cleanResult = _shadowScoreClean(item, criteres);

    log("[Shadow][Debug " + (n+1) + "/3] bc_id=" + (item.id||"?") +
        "  legacy=" + legacyMatch + "  clean=" + cleanResult.match +
        "  clean_score=" + cleanResult.score +
        "  decision=" + cleanResult.decision);
    log("  objet.len=" + (item.objet||"").length +
        "  bodyText.len=" + (item.bodyText||"").length +
        "  articles.len=" + (item.articles||[]).length +
        "  _keyword=" + JSON.stringify((item._keyword||"").slice(0, 40)));
    log("  objet[:100]=" + JSON.stringify((item.objet||"").slice(0, 100)));
    log("  clean_text[:150]=" + JSON.stringify(cleanText.slice(0, 150)));
    log("  matched_signals=" + JSON.stringify(cleanResult.signals));
    // Signaux du pool disponibles dans le clean text (pour diagnostiquer si signal existe mais non scoré)
    var availInText = signalPool.filter(function(t) { return hasAnyKw(cleanText, [t]); });
    log("  signals_in_clean_text=" + JSON.stringify(availInText));
    if (item.articles && item.articles[0]) {
      log("  articles[0].designation=" + JSON.stringify((item.articles[0].designation||"").slice(0, 100)));
    }
  });
  log("[Shadow][Debug] ====== FIN PROFIL : " + cn + " ======");
}

/**
 * Score enrichi pour le shadow clean — calqué sur la logique replay.
 *
 * Pondération (shadow uniquement — n'affecte pas matchCritere) :
 *   valeur (critère principal)  → +10
 *   ai_inclusions[i]            → +5 chacun  (synonymes métier)
 *   ai_exclusions               → bloque si trouvé
 *
 * Décision :
 *   match_fort   → score ≥ 15  (critère principal + au moins un synonyme)
 *   match_faible → score ≥ 5   (au moins un signal — inclusions suffisent)
 *   bloque       → exclusion détectée avec signal principal
 *   no_match     → score < 5
 *
 * Différences vs matchCritere (legacy) :
 *   - N'utilise PAS item._keyword (source principale de FP en scan réel)
 *   - Pondère valeur (×10) vs inclusions (×5 chacune) au lieu de les traiter à égalité
 *   - Retourne un objet riche {match, score, signals, decision, reason} pour le rapport
 */
function _shadowScoreClean(item, criteres) {
  var cleanText = buildCleanMatchText(item);
  var score           = 0;
  var signals         = [];   // tous signaux (affichage)
  var primarySignals  = [];   // valeur principale qui a matché
  var inclusionSignals = [];  // inclusions qui ont matché
  var blocked   = false;
  var hasSignal = false;

  // Table de déduplication : évite de compter deux fois le même signal normalisé
  // (ex. "reseau" et "réseau" → même clé normalisée)
  var seenNorm = {};
  var guardBlockedList = []; // GD-024e : signaux filtrés par guard (read-only, reporting)
  var purchaseIntentSignals = []; // GD-027 : signaux rescapés par PI bypass
  var outOfScopePenaltyReason = null; // GD-027

  criteres.forEach(function(c) {
    var excl = c.ai_exclusions || [];

    // Exclusions — bloque le critère si trouvé dans le texte propre
    if (excl.length && excl.some(function(t) { return hasKw(cleanText, t); })) {
      blocked = true;
      signals.push("bloque(" + c.valeur + ")");
      return;
    }

    // Critère principal (valeur) → +10, dédupliqué
    var normV = _normSignal(c.valeur);
    if (_shadowHasAnyKw(cleanText, [c.valeur]) && _shadowContextGuardBlocked(normV, cleanText)) {
      // GD-024e : guard spécifique actif — tenter PI bypass (GD-027)
      var piSpecific = _purchaseIntent.detectPurchaseIntentNear(cleanText, c.valeur);
      if (piSpecific.detected && !seenNorm[normV]) {
        seenNorm[normV] = true;
        score += _purchaseIntent.PURCHASE_INTENT_SCORE;
        signals.push(c.valeur); primarySignals.push(c.valeur); hasSignal = true;
        purchaseIntentSignals.push({ signal: c.valeur, pattern: piSpecific.pattern });
      } else if (!seenNorm['__gb__' + normV]) {
        seenNorm['__gb__' + normV] = true;
        guardBlockedList.push(_explainShadowContextGuard(normV, cleanText));
      }
    } else if (_shadowHasAnyKw(cleanText, [c.valeur]) && !_shadowContextGuardBlocked(normV, cleanText)) {
      // GD-024f : guard contexte faible appliqué aussi aux signaux primaires
      // (ex. "produits alimentaires pour manifestation" = faux positif même sur c.valeur)
      var weakGuardPrimary = _shadowWeakContextBlocked(normV, cleanText);
      if (weakGuardPrimary.blocked) {
        // guard faible actif — tenter PI bypass (GD-027)
        var piWeak = _purchaseIntent.detectPurchaseIntentNear(cleanText, c.valeur);
        if (piWeak.detected && !seenNorm[normV]) {
          seenNorm[normV] = true;
          score += _purchaseIntent.PURCHASE_INTENT_SCORE;
          signals.push(c.valeur); primarySignals.push(c.valeur); hasSignal = true;
          purchaseIntentSignals.push({ signal: c.valeur, pattern: piWeak.pattern });
        } else if (!seenNorm['__wg__' + normV]) {
          seenNorm['__wg__' + normV] = true;
          guardBlockedList.push(weakGuardPrimary);
        }
      } else if (!seenNorm[normV]) {
        seenNorm[normV] = true;
        score += 10;
        signals.push(c.valeur);
        primarySignals.push(c.valeur);
        hasSignal = true;
      }
    }

    // Inclusions (synonymes métier) → +5 standard, +10 pour trusted (GD-023)
    // Shadow uniquement — n'affecte pas le matching legacy ni les notifications
    (c.ai_inclusions || []).forEach(function(t) {
      if (!t) return;
      var normT = _normSignal(t);
      if (!_shadowHasAnyKw(cleanText, [t])) return; // signal absent du texte
      if (_shadowContextGuardBlocked(normT, cleanText)) {
        // GD-024e : guard spécifique — tenter PI bypass (GD-027)
        var piInclSpec = _purchaseIntent.detectPurchaseIntentNear(cleanText, t);
        if (piInclSpec.detected && !seenNorm[normT]) {
          seenNorm[normT] = true;
          score += _purchaseIntent.PURCHASE_INTENT_SCORE;
          signals.push(t); inclusionSignals.push(t); hasSignal = true;
          purchaseIntentSignals.push({ signal: t, pattern: piInclSpec.pattern });
        } else if (!seenNorm['__gb__' + normT]) {
          seenNorm['__gb__' + normT] = true;
          guardBlockedList.push(_explainShadowContextGuard(normT, cleanText));
        }
        return;
      }
      // GD-024f : guard contexte faible — tenter PI bypass (GD-027)
      var weakGuard = _shadowWeakContextBlocked(normT, cleanText);
      if (weakGuard.blocked) {
        var piInclWeak = _purchaseIntent.detectPurchaseIntentNear(cleanText, t);
        if (piInclWeak.detected && !seenNorm[normT]) {
          seenNorm[normT] = true;
          score += _purchaseIntent.PURCHASE_INTENT_SCORE;
          signals.push(t); inclusionSignals.push(t); hasSignal = true;
          purchaseIntentSignals.push({ signal: t, pattern: piInclWeak.pattern });
        } else if (!seenNorm['__wg__' + normT]) {
          seenNorm['__wg__' + normT] = true;
          guardBlockedList.push(weakGuard);
        }
        return;
      }
      // Pas bloqué — scorer normalement
      if (!seenNorm[normT]) {
        seenNorm[normT] = true;
        score += CLEAN_TRUSTED_INCLUSION_SCORE.has(normT) ? 10 : 5; // GD-023
        signals.push(t);
        inclusionSignals.push(t);
        hasSignal = true;
      }
    });
  });

  // GD-027 : out-of-scope penalty (si aucun PI bypass actif)
  if (!purchaseIntentSignals.length) {
    var oosResult = _purchaseIntent.detectOutOfScopeContext(cleanText);
    if (oosResult.blocked && score > 0) {
      score = Math.max(0, score - _purchaseIntent.OUT_OF_SCOPE_PENALTY);
      outOfScopePenaltyReason = oosResult.reason;
    }
  }

  var decision;
  if (blocked && hasSignal) {
    decision = "bloque";
  } else if (!hasSignal || score < 5) {
    decision = "no_match";
  } else if (score >= 15) {
    decision = "match_fort";
  } else {
    decision = "match_faible";
  }

  return {
    match:                 hasSignal && !blocked && score >= 5,
    score:                 score,
    signals:               signals,
    primarySignals:        primarySignals,
    inclusionSignals:      inclusionSignals,
    blocked:               blocked,
    decision:              decision,
    reason:   signals.filter(function(s) { return s.indexOf("bloque(") === -1; })
                     .slice(0, 3).join(", ") || "aucun signal",
    guardBlockedList:      guardBlockedList,       // GD-024e
    purchaseIntentSignals: purchaseIntentSignals,  // GD-027
    outOfScopePenalty:     outOfScopePenaltyReason, // GD-027
  };
}

/**
 * Matching propre : délègue à _shadowScoreClean (score ≥ 5, sans exclusion).
 * Utilisé uniquement pour la comparaison shadow — aucune notification.
 */
// GD-024 : normSignal + shadowContextGuardBlocked extraits dans core/shadow/context-guards.runtime.js
const _purchaseIntent = require('./core/shadow/purchase-intent.runtime.js'); // GD-027
const { normSignal: _normSignal, shadowContextGuardBlocked: _shadowContextGuardBlocked,
        explainShadowContextGuard: _explainShadowContextGuard,
        shadowWeakContextBlocked: _shadowWeakContextBlocked } =
  require('./core/shadow/context-guards.runtime.js');
function _shadowHasAnyKw(text, terms) {
  return (terms || []).some(function(t) {
    if (!t) return false;
    var nk = norm(t);
    if (!nk) return false;
    // Signaux courts (≤ 4 chars normalisés) : mot complet strict des deux côtés
    // "pc" → \bpc\b : ne matche plus pcb, pcr, spc
    if (nk.length <= 4) {
      var esc = nk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp('\\b' + esc + '\\b').test(norm(text));
    }
    // Signaux longs : comportement standard (fuzzy inclus, \b au début)
    return hasKwFuzzy(text, t);
  });
}

function _itemMatchesCleanCriteres(item, criteres) {
  return _shadowScoreClean(item, criteres).match;
}

/**
 * Écrit les lignes de snapshot dans :
 *   data/scan-snapshots/bc-scan-YYYYMMDD-HHMMSS.jsonl
 *   data/scan-snapshots/latest-bc-scan.jsonl  (alias mis à jour)
 *
 * Silencieux en cas d'erreur (jamais bloquant).
 */
function writeScanSnapshot(rows, radarType) {
  if (!rows || rows.length === 0) return;
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const ts      = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fname   = radarType + "-scan-" + ts + ".jsonl";
    const fpath   = path.join(SNAPSHOT_DIR, fname);
    const latest  = path.join(SNAPSHOT_DIR, "latest-" + radarType + "-scan.jsonl");
    const content = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
    log("[Snapshot] dir=" + SNAPSHOT_DIR);
    fs.writeFileSync(fpath,   content, "utf8");
    fs.writeFileSync(latest,  content, "utf8");
    log("[Snapshot] saved path=" + fpath + " (" + rows.length + " lignes)");
    log("[Snapshot] latest=" + latest);
  } catch (e) {
    log("[Snapshot] ERREUR ecriture : " + e.message);
  }
}

/**
 * Snapshot brut d'entrée — capture les BC détaillés AVANT matching client.
 *
 * Activé par RADAR_BC_WRITE_INPUT_SNAPSHOT=1.
 * Écrit dans data/input-snapshots/bc-input-<ts>.jsonl.
 * 1 ligne = 1 BC complet : bodyText, articles, organisme, objet, url…
 * N'écrit JAMAIS : client_id, client_name, critere_valeur, matched_terms,
 *                  decision, score, status, reason, body_excerpt, _keyword.
 */
function writeInputSnapshot(items) {
  // SNAPSHOT_ONLY force l'écriture même sans RADAR_BC_WRITE_INPUT_SNAPSHOT=1
  if ((!WRITE_INPUT_SNAPSHOT && !SNAPSHOT_ONLY) || !items || !items.length) return;
  try {
    fs.mkdirSync(INPUT_SNAPSHOT_DIR, { recursive: true });
    const ts     = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fname  = "bc-input-" + ts + ".jsonl";
    const fpath  = path.join(INPUT_SNAPSHOT_DIR, fname);
    const latest = path.join(INPUT_SNAPSHOT_DIR, "latest-bc-input.jsonl");
    const scanTs = new Date().toISOString();
    // Champs interdits — contaminants de matching post-décision
    const FORBIDDEN = new Set([
      "client_id", "client_name", "critere_valeur", "matched_terms",
      "decision", "score", "status", "reason", "body_excerpt", "_keyword",
    ]);
    const content = items.map(function(item) {
      var row = { scan_timestamp: scanTs, bc_id: item.id || "" };
      ["objet", "reference", "organisme", "lieu", "wilaya", "date_limite",
       "url", "articles", "bodyText"].forEach(function(k) {
        if (item[k] !== undefined && item[k] !== null && item[k] !== "") {
          if (!FORBIDDEN.has(k)) row[k] = item[k];
        }
      });
      // Champs supplémentaires présents sur l'item (ex: acheteur) non interdits
      Object.keys(item).forEach(function(k) {
        if (!FORBIDDEN.has(k) && row[k] === undefined) row[k] = item[k];
      });
      return JSON.stringify(row);
    }).join("\n") + "\n";
    log("[InputSnapshot] dir=" + INPUT_SNAPSHOT_DIR);
    fs.writeFileSync(fpath,   content, "utf8");
    fs.writeFileSync(latest,  content, "utf8");
    log("[InputSnapshot] saved path=" + fpath + " (" + items.length + " BCs)");
    log("[InputSnapshot] latest=" + latest);
  } catch (e) {
    log("[InputSnapshot] ERREUR ecriture : " + e.message);
  }
}

/**
 * Calcule la comparaison shadow (legacy vs clean) pour un client+items.
 * N'envoie rien, n'écrit rien dans Supabase.
 *
 * Si RADAR_BC_MATCH_SHADOW_CLIENT est défini et ne correspond pas à ce client,
 * les listes legacy_only/clean_only sont tronquées à [] (compteurs conservés).
 *
 * @param {object} client
 * @param {Array}  items       — même liste que itemsToCheck
 * @param {Array}  criteres    — critères normalisés (valeur + inclusions)
 * @param {string} radarType
 * @returns {object} entrée shadow pour _shadowAccum
 */
// Déduplique une liste d'entrées shadow par bc_id.
// En cas de doublon, conserve l'entrée avec le clean_score le plus élevé.
function _dedupByBcId(list) {
  var seen = {};
  var result = [];
  list.forEach(function(e) {
    var key = String(e.bc_id || "");
    if (!seen[key]) {
      seen[key] = { entry: e, idx: result.length };
      result.push(e);
    } else {
      // Doublon : garder le score le plus élevé
      if ((e.clean_score || 0) > (seen[key].entry.clean_score || 0)) {
        result[seen[key].idx] = e;
        seen[key].entry = e;
      }
    }
  });
  return result;
}

function _computeShadowComparison(client, items, criteres, radarType) {
  var both = 0, legacyOnlyList = [], cleanOnlyList = [], neitherCount = 0;
  var bothScores = [];  // scores clean des items "both" pour calcul strong/weak
  var clientName  = client.nom || "";
  var wantDetail  = !SHADOW_CLIENT_FILTER ||
                    clientName === SHADOW_CLIENT_FILTER ||
                    String(client.id) === SHADOW_CLIENT_FILTER;

  items.forEach(function(item) {
    if (!isEnCours(item)) return;  // mêmes exclusions que le scan réel
    var legacy = itemMatchesCriteres(item, criteres);
    var clean  = _itemMatchesCleanCriteres(item, criteres);
    if (legacy && clean) {
      var cleanResultBoth = _shadowScoreClean(item, criteres);
      bothScores.push(cleanResultBoth.score);
      both++;
    } else if (legacy && !clean) {
      if (wantDetail) {
        var matched       = getMatchedCriteres(item, criteres);
        var cleanResult   = _shadowScoreClean(item, criteres);
        var legacyExcerpt = ((item.objet || "") + " " + (item.bodyText || "")).slice(0, 150);
        var cleanExcerpt  = buildCleanMatchText(item).slice(0, 150);
        // Tous les signaux du profil client présents dans le clean text
        // (y compris ceux qui n'ont pas suffi à dépasser le seuil)
        var _signalPool = [];
        criteres.forEach(function(_c) {
          _signalPool.push(_c.valeur);
          (_c.ai_inclusions || []).forEach(function(_t) { if (_t) _signalPool.push(_t); });
        });
        var _cleanTextForPool = buildCleanMatchText(item);
        var _availSignals = _signalPool.filter(function(_t) {
          return hasAnyKw(_cleanTextForPool, [_t]);
        });
        legacyOnlyList.push({
          client:                clientName,
          bc_id:                 item.id || "",
          objet:                 (item.objet || "").slice(0, 120),
          critere:               matched[0] ? matched[0].valeur : "",
          legacy_text_excerpt:   legacyExcerpt,
          clean_text_excerpt:    cleanExcerpt,
          clean_score:           cleanResult.score,
          matched_signals:       cleanResult.signals,
          clean_decision:        cleanResult.decision,
          reason:                cleanResult.reason || "aucun signal propre détecté",
          available_signal_count: _availSignals.length,
          available_signals:      _availSignals.slice(0, 10),
          guard_blocked_signals:  cleanResult.guardBlockedList || [], // GD-024e
        });
      } else {
        legacyOnlyList.push({ bc_id: item.id || "", critere: "" }); // compteur minimal
      }
    } else if (!legacy && clean) {
      if (wantDetail) {
        var cleanResult2      = _shadowScoreClean(item, criteres);
        var cleanTextExcerpt2 = buildCleanMatchText(item).slice(0, 200);
        var cleanSigs2        = cleanResult2.signals.filter(function(s) { return s.indexOf('bloque(') === -1; });
        var primCount2        = cleanResult2.primarySignals.length;
        var inclCount2        = cleanResult2.inclusionSignals.length;
        var isWeakSingle2     = cleanSigs2.length === 1 && cleanResult2.score < CLEAN_STRONG_THRESHOLD;
        var isStrong2         = cleanResult2.score >= CLEAN_STRONG_THRESHOLD;
        var exclusionHit2     = cleanResult2.blocked;
        var isAutoCandidate2  = isStrong2 && !isWeakSingle2 && !exclusionHit2;
        // strength_reason : générique, basé sur la structure des signaux
        var strengthReason2;
        if (exclusionHit2) {
          strengthReason2 = "exclu (ai_exclusions)";
        } else if (primCount2 > 0 && inclCount2 > 0) {
          strengthReason2 = "valeur_principale + inclusions (" + primCount2 + "p+" + inclCount2 + "i)";
        } else if (primCount2 > 0) {
          strengthReason2 = "valeur_principale seule (" + primCount2 + "p)";
        } else if (inclCount2 >= 2) {
          strengthReason2 = "inclusions_multiples (" + inclCount2 + "i, score=" + cleanResult2.score + ")";
        } else if (isWeakSingle2) {
          strengthReason2 = "signal_secondaire_unique (" + (cleanSigs2[0] || "?") + ")";
        } else {
          strengthReason2 = "inclusions_faibles (score=" + cleanResult2.score + ")";
        }
        cleanOnlyList.push({
          client:                clientName,
          bc_id:                 item.id || "",
          objet:                 (item.objet || "").slice(0, 120),
          clean_score:           cleanResult2.score,
          matched_signals:       cleanResult2.signals,
          clean_decision:        cleanResult2.decision,
          reason:                cleanResult2.reason,
          signal_origin:         primCount2 > 0 ? "primary" : "inclusion",
          primary_signal_count:  primCount2,
          inclusion_signal_count: inclCount2,
          exclusion_hit:         exclusionHit2 || undefined,
          strength:              isStrong2 ? "strong" : "weak",
          strength_reason:       strengthReason2,
          clean_text_excerpt:    cleanTextExcerpt2,
          weak_single_signal:    isWeakSingle2 || undefined,
          auto_notify_candidate: isAutoCandidate2 || undefined,
          review_candidate:      (!isAutoCandidate2 && cleanResult2.score >= CLEAN_WEAK_THRESHOLD) || undefined,
        });
      } else {
        cleanOnlyList.push({ bc_id: item.id || "" });
      }
    } else {
      neitherCount++;
    }
  });

  // top critères responsables des legacy_only
  var critCount = {};
  legacyOnlyList.forEach(function(e) {
    var c = e.critere || "inconnu";
    critCount[c] = (critCount[c] || 0) + 1;
  });
  var topCriteria = Object.keys(critCount)
    .sort(function(a, b) { return critCount[b] - critCount[a]; })
    .slice(0, 5)
    .map(function(c) { return { critere: c, count: critCount[c] }; });

  // Déduplication par bc_id (un même BC peut apparaître plusieurs fois
  // si plusieurs critères le capturent dans des passages distincts)
  var legacyOnlyUniq  = _dedupByBcId(legacyOnlyList);
  var cleanOnlyUniq   = _dedupByBcId(cleanOnlyList);
  var legacyDupCount  = legacyOnlyList.length - legacyOnlyUniq.length;
  var cleanDupCount   = cleanOnlyList.length  - cleanOnlyUniq.length;

  // ── Compteurs de force ─────────────────────────────────────────────
  var bothStrongCount = bothScores.filter(function(s) { return s >= CLEAN_STRONG_THRESHOLD; }).length;
  var bothWeakCount   = bothScores.filter(function(s) { return s < CLEAN_STRONG_THRESHOLD; }).length;

  var cleanOnlyStrong = cleanOnlyUniq.filter(function(e) { return e.strength === "strong"; });
  var cleanOnlyWeak   = cleanOnlyUniq.filter(function(e) { return e.strength === "weak"; });
  var weakSingleCount = cleanOnlyUniq.filter(function(e) { return e.weak_single_signal; }).length;
  var autoNotifCands  = cleanOnlyUniq.filter(function(e) { return e.auto_notify_candidate; });
  var reviewCands     = cleanOnlyUniq.filter(function(e) { return e.review_candidate && !e.auto_notify_candidate; });
  var primaryBased    = cleanOnlyUniq.filter(function(e) { return e.signal_origin === "primary"; });
  var inclusionOnly   = cleanOnlyUniq.filter(function(e) { return e.signal_origin === "inclusion"; });

  var legacyTotal  = both + legacyOnlyUniq.length;
  var cleanTotal   = both + cleanOnlyUniq.length;
  var fpRate       = legacyTotal > 0 ? Math.round(legacyOnlyUniq.length / legacyTotal * 100) : 0;

  // ── Recommandation ─────────────────────────────────────────────────
  var recommendation;
  if (cleanOnlyStrong.length >= 5 && weakSingleCount < cleanOnlyUniq.length * 0.5) {
    recommendation = "candidate_for_clean_shadow_review";
  } else {
    recommendation = "keep_legacy_production";
  }

  return {
    client_id:                  client.id,
    client_name:                clientName,
    radar_type:                 radarType,
    total_checked:              items.filter(function(i) { return isEnCours(i); }).length,
    legacy:                     legacyTotal,
    clean:                      cleanTotal,
    both_match:                 both,
    both_strong_count:          bothStrongCount,
    both_weak_count:            bothWeakCount,
    clean_strong_count:         bothStrongCount + cleanOnlyStrong.length,
    clean_weak_count:           bothWeakCount   + cleanOnlyWeak.length,
    legacy_only_count:          legacyOnlyUniq.length,
    legacy_only_unique_count:   legacyOnlyUniq.length,
    clean_only_count:           cleanOnlyUniq.length,
    clean_only_unique_count:    cleanOnlyUniq.length,
    clean_only_strong_count:    cleanOnlyStrong.length,
    clean_only_weak_count:      cleanOnlyWeak.length,
    weak_single_signal_count:   weakSingleCount,
    duplicate_count:            legacyDupCount + cleanDupCount,
    neither:                    neitherCount,
    fp_rate_pct:                fpRate,
    top_criteria_legacy_only:   topCriteria,
    clean_auto_notify_candidates: autoNotifCands.length,
    clean_review_candidates:      reviewCands.length,
    clean_blocked_or_weak:        weakSingleCount,
    primary_based_matches:        primaryBased.length,
    inclusion_only_matches:       inclusionOnly.length,
    recommendation:               recommendation,
    legacy_only:                wantDetail ? legacyOnlyUniq : [],
    clean_only:                 wantDetail ? cleanOnlyUniq  : [],
    // Section dédiée : uniquement les candidats à revue manuelle
    review_candidates_detail:   wantDetail ? reviewCands : [],
    detail_available:           wantDetail,
  };
}

/**
 * Écrit le rapport shadow dans data/shadow/shadow-bc-YYYY-MM-DDTHH-MM-SS.json,
 * loggue un résumé par client, et remet _shadowAccum à zéro.
 *
 * Si RADAR_BC_MATCH_SHADOW_CLIENT est défini, seul ce client a le détail
 * (legacy_only[]) dans le JSON — les autres ont legacy_only:[].
 */
function writeShadowReport() {
  if (!_shadowAccum.length) return;
  try {
    fs.mkdirSync(SHADOW_DIR, { recursive: true });
    const ts    = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fname = "shadow-bc-" + ts + ".json";
    const fpath = path.join(SHADOW_DIR, fname);

    // ── Résumé global ──────────────────────────────────────────────────────
    const totLegacy     = _shadowAccum.reduce(function(s, e) { return s + e.legacy; }, 0);
    const totClean      = _shadowAccum.reduce(function(s, e) { return s + e.clean; }, 0);
    const totLegacyOnly = _shadowAccum.reduce(function(s, e) { return s + e.legacy_only_count; }, 0);
    const totCleanOnly  = _shadowAccum.reduce(function(s, e) { return s + e.clean_only_count; }, 0);
    const fpRate        = totLegacy > 0 ? Math.round(totLegacyOnly / totLegacy * 100) : 0;

    // ── Log par client ──────────────────────────────────────────────────────
    _shadowAccum.forEach(function(e) {
      log("[Shadow][" + e.client_name + "]" +
          "  legacy="        + e.legacy +
          "  clean="         + e.clean +
          "  clean_strong="  + (e.clean_strong_count || 0) +
          "  clean_weak="    + (e.clean_weak_count   || 0) +
          "  both="          + e.both_match +
          "  legacy_only="   + e.legacy_only_count +
          " (" + e.fp_rate_pct + "% FP)" +
          "  clean_only="         + e.clean_only_count +
          "  clean_only_strong="  + (e.clean_only_strong_count || 0) +
          "  clean_only_weak="    + (e.clean_only_weak_count   || 0) +
          "  weak_single="        + (e.weak_single_signal_count || 0) +
          "  auto_candidates="    + (e.clean_auto_notify_candidates || 0) +
          "  review_candidates="  + (e.clean_review_candidates || 0) +
          "  => " + (e.recommendation || "?"));
    });
    log("[Shadow] TOTAL  legacy=" + totLegacy + "  clean=" + totClean +
        "  legacy_only=" + totLegacyOnly + " (" + fpRate + "% FP global)" +
        "  clean_only=" + totCleanOnly +
        (SHADOW_CLIENT_FILTER ? "  [filtre: " + SHADOW_CLIENT_FILTER + "]" : ""));

    const report = {
      scan_date:     new Date().toISOString(),
      client_filter: SHADOW_CLIENT_FILTER || null,
      summary: {
        total_legacy_matches: totLegacy,
        total_clean_matches:  totClean,
        total_legacy_only:    totLegacyOnly,
        total_clean_only:     totCleanOnly,
        fp_rate_pct:          fpRate,
      },
      clients: _shadowAccum,
    };
    fs.writeFileSync(fpath, JSON.stringify(report, null, 2), "utf8");
    log("[Shadow] Rapport écrit : " + fname);

    // Export optionnel des review candidates (RADAR_BC_EXPORT_REVIEW_CANDIDATES=1)
    if (process.env.RADAR_BC_EXPORT_REVIEW_CANDIDATES === "1") {
      var allReviewCands = [];
      _shadowAccum.forEach(function(e) {
        (e.review_candidates_detail || []).forEach(function(rc) {
          allReviewCands.push(rc);
        });
      });
      if (allReviewCands.length) {
        var rcFname = "review-candidates-" + ts + ".json";
        var rcFpath = path.join(SHADOW_DIR, rcFname);
        var rcReport = {
          scan_date:         new Date().toISOString(),
          source_report:     fname,
          total_candidates:  allReviewCands.length,
          candidates:        allReviewCands,
        };
        fs.writeFileSync(rcFpath, JSON.stringify(rcReport, null, 2), "utf8");
        log("[Shadow] Review candidates exportés : " + rcFname + " (" + allReviewCands.length + " entrées)");
      }
    }

    _shadowAccum = [];
  } catch (e) {
    log("[Shadow] Erreur ecriture rapport : " + e.message);
  }
}

/**
 * Construit une ligne de snapshot à partir d'une décision de matching.
 *
 * Enrichissement inline (pas de require circulaire) :
 *   - objet   : extrait de bodyText si item.objet est vide
 *   - body_excerpt : nettoyé du boilerplate portail, cadré sur OBJET
 */
function _snapExtractObjet(bodyText) {
  if (!bodyText || bodyText.trim() === "") return null;
  var m = bodyText.match(/\bOBJET\s*[:\-]?\s*([^\n\r]{10,200})/i);
  if (m) return m[1].trim().replace(/\s+/g, " ").slice(0, 200);
  var lines = bodyText.split(/[\n\r]+/);
  var BOILER = ["accueil", "liste des avis", "avis d'achat", "marchespublics", "portail"];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.length < 15) continue;
    var lower = line.toLowerCase();
    if (BOILER.some(function(p) { return lower.indexOf(p) !== -1; })) continue;
    if (/^\d+$/.test(line)) continue;
    if (/^(date|organisme|acheteur|lieu|reference|N[o\xb0])/i.test(line)) continue;
    return line.slice(0, 200);
  }
  return null;
}

function _snapCleanBody(bodyText, maxLen) {
  maxLen = maxLen || 400;
  if (!bodyText || bodyText.trim() === "") return "";
  var text = bodyText;
  var objIdx = text.search(/\bOBJET\b/i);
  if (objIdx > 0 && objIdx < 600) {
    text = text.slice(objIdx);
  } else {
    var lower = text.toLowerCase();
    var boiler = ["accueil", "liste des avis"];
    for (var i = 0; i < boiler.length; i++) {
      var pIdx = lower.indexOf(boiler[i]);
      if (pIdx !== -1 && pIdx < 100) {
        var nlIdx = text.indexOf("\n", pIdx);
        if (nlIdx !== -1) { text = text.slice(nlIdx + 1).trim(); }
        break;
      }
    }
  }
  return text.slice(0, maxLen).trim();
}

function makeSnapshotRow(scanTs, client, item, radarType, status, critereValeur, matchedTerms, reason) {
  var rawObjet = item.objet || "";
  var objet = rawObjet.trim()
    ? rawObjet.slice(0, 200)
    : (_snapExtractObjet(item.bodyText || "") || "");
  return {
    scan_timestamp:  scanTs,
    client_id:       client.id,
    client_name:     client.nom || client.name || "",
    radar_type:      radarType,
    bc_id:           item.id || "",
    critere_valeur:  critereValeur  || null,
    status:          status,
    reason:          reason         || null,
    score:           null,           // non calculé dans le legacy engine
    matched_terms:   matchedTerms   || null,
    objet:           objet,
    url:             item.url       || null,
    date_limite:     item.date_limite || null,
    body_excerpt:    _snapCleanBody(item.bodyText || "", 400),
  };
}

// ============================================================
// MATCHING PAR CLIENT
// radarType: 'bc' ou 'mp'
// ============================================================
async function matchClient(client, itemsToCheck, label, radarType, snapshotRows, _noDeliverySet) {
  const rawCriteres = getCriteresCapped(client, radarType);
  const criteres = rawCriteres.map(c => ({
    id:            c.id,
    type:          c.type,
    valeur:        c.valeur,
    ai_inclusions: c.ai_inclusions || [],
    ai_exclusions: c.ai_exclusions || [],
  }));
  if (!criteres.length) return;

  const getSentIds = radarType === "bc" ? db.getBCSentIds : db.getMPSentIds;
  const markSent   = radarType === "bc" ? db.markBCSent   : db.markMPSent;

  const sentIds = await getSentIds(client.id);
  let found = 0, sent = 0;
  const _snapTs = new Date().toISOString(); // timestamp partagé pour toutes les lignes de ce client

  for (const item of itemsToCheck) {
    if (!isEnCours(item)) {
      log("  skip " + (item.id || "") + " expire (date_limite=" + (item.date_limite || "none") + ")");
      // ── snapshot : item expiré ou annulé ─────────────────────────────────
      if (snapshotRows) {
        const isCancelled = isCancelledNotice((item.bodyText || "") + " " + (item.objet || ""));
        snapshotRows.push(makeSnapshotRow(
          _snapTs, client, item, radarType,
          isCancelled ? "blocked_cancelled" : "skipped_expired",
          null, null,
          isCancelled ? "notice annulee" : ("date_limite=" + (item.date_limite || "none")),
        ));
      }
      continue;
    }
    if (!itemMatchesCriteres(item, criteres)) {
      fireShadowEval(item, client, criteres, false, "");    // J1-miss : core évalue sans match legacy
      fireShadowDetect(item, client, criteres, false);      // J1-miss : BC faible → candidat opportunité
      // ── snapshot : aucun critère ne matche ───────────────────────────────
      // (non loggué en masse — trop volumineux ; on saute les no-match)
      continue;
    }
    found++;
    if (sentIds.has(item.id)) {
      log("[SEND] ALREADY_SENT_SKIP client=" + client.nom + " item=" + item.id);
      // ── snapshot : déjà envoyé ────────────────────────────────────────────
      if (snapshotRows) {
        const matched0 = getMatchedCriteres(item, criteres);
        snapshotRows.push(makeSnapshotRow(
          _snapTs, client, item, radarType,
          "skipped_already_sent",
          matched0[0] ? matched0[0].valeur : null,
          matched0.map(c => c.valeur),
          "deja notifie",
        ));
      }
      continue;
    }
    const matched = getMatchedCriteres(item, criteres);
    fireShadowEval(item, client, criteres, true, matched[0] ? matched[0].id : "");  // J1-match

    // Validation IA — uniquement pack Pro/Business
    let aiResume = null;
    const limits = getPackLimits(client);
    if (limits.hasAIValidation && (CFG.ollamaUrl || CFG.anthropicKey) && matched.length > 0) {
      const v = await validateMatchWithAI(item, matched[0], radarType);
      if (v) {
        if (!v.pertinent && v.confiance === "haute") {
          // Seul cas de rejet : IA très sûre que c'est hors-sujet
          log("  [IA] REJETE (confiance haute) " + item.id);
          // ── snapshot : rejeté par IA ──────────────────────────────────────
          if (snapshotRows) {
            snapshotRows.push(makeSnapshotRow(
              _snapTs, client, item, radarType,
              "skipped_ai_rejected",
              matched[0] ? matched[0].valeur : null,
              matched.map(c => c.valeur),
              "IA confiance haute : hors-sujet",
            ));
          }
          continue;
        }
        if (!v.pertinent) {
          // Doute IA mais on envoie quand même avec avertissement
          aiResume = "⚠️ A verifier: " + (v.resume || "pertinence incertaine");
          log("  [IA] DOUTEUX (envoi quand meme) " + item.id);
        } else {
          aiResume = v.resume || null;
          log("  [IA] VALIDE " + item.id);
        }
      }
    }

    const trigger = getMatchTrigger(item, matched[0]);
    const triggerLog = trigger ? (trigger.isEnrichissement ? trigger.keyword + "→" + trigger.trigger : trigger.keyword) : "";
    const tag = "[" + radarType.toUpperCase() + "][" + client.nom + "] " + item.id +
      " [" + triggerLog + "] " + (item.objet || "").slice(0, 50);
    log("  MATCH " + tag);
    fireShadowDetect(item, client, criteres, true);           // J2 : legacy va notifier → runner skippe (already_notified)

    // ── Quality gate ──────────────────────────────────────────────────────
    const _effectiveObjet = item.objet || _snapExtractObjet(item.bodyText || "") || "";
    const _qg = _runQualityGate({
      critere_valeur: matched[0] ? matched[0].valeur : "",
      objet:          _effectiveObjet,
      bodyText:       item.bodyText || "",
      matched_terms:  matched.map(function(c) { return c.valeur; }),
      radar_type:     radarType,
      is_cancelled:   false,
    });
    if (_qg.decision === "block") {
      log("[GATE] BLOQUE client=" + client.nom + " item=" + item.id +
          " critere=" + (matched[0] ? matched[0].valeur : "") +
          " reason=" + _qg.reason);
      if (snapshotRows) {
        snapshotRows.push(makeSnapshotRow(
          _snapTs, client, item, radarType,
          "blocked_quality_gate",
          matched[0] ? matched[0].valeur : null,
          matched.map(function(c) { return c.valeur; }),
          _qg.reason || "quality gate block",
        ));
      }
      continue;
    }
    if (_qg.decision === "warn") {
      log("[GATE] WARN client=" + client.nom + " item=" + item.id +
          " critere=" + (matched[0] ? matched[0].valeur : "") +
          " reason=" + _qg.reason);
    }
    // ─────────────────────────────────────────────────────────────────────

    const _critereForFb = matched[0] ? matched[0].valeur : "";
    const _fbNotifId    = require("crypto")
      .createHash("sha1")
      .update(String(client.id) + String(item.id) + String(radarType) + String(_critereForFb))
      .digest("hex").slice(0, 8);
    const _fbOpts = {
      notifId:      _fbNotifId,
      matchedTerms: triggerLog || "",
      bcTitle:      (item.objet || "").slice(0, 60),
    };
    const _fbHtml  = isFeedbackEnabledForClient(client.id) ? _buildFeedbackSection(client.id, item.id, _critereForFb, radarType, "html",  _fbOpts) : null;
    const _fbPlain = isFeedbackEnabledForClient(client.id) ? _buildFeedbackSection(client.id, item.id, _critereForFb, radarType, "plain", _fbOpts) : null;
    const msgPlain = buildMessage(item, matched, radarType, aiResume) + (_fbPlain || "");
    const msgHtml  = buildHtmlMessage(item, matched, radarType, aiResume) + (_fbHtml || "");
    // TG_DECISION : utilise getTelegramDeliveryDecision — même ordre que sendTelegram
    const _dec       = getTelegramDeliveryDecision(client, msgHtml);
    const _tgDecision = _dec.reason;
    log("[SEND] TG_DECISION client=" + client.nom + " item=" + item.id
      + " has_tg_chat_id=" + _dec.has_chat_id
      + " cfg_token_env=" + (_dec.has_cfg_token ? "set" : "empty")
      + " cfg_token_cached=" + (_dec.has_cfg_token_cached ? "set" : "empty")
      + " resolved=" + (_dec.resolved_token_present ? "set" : "empty")
      + " has_client_token=" + (_dec.has_client_token ? "set" : "empty")
      + " msg_len=" + msgHtml.length
      + " reason=" + _tgDecision);
    const _tgOk  = await sendTelegram(client, msgHtml);
    log("[SEND] TG_POST client=" + client.nom + " item=" + item.id + " tg=" + _tgOk);
    const _waOk  = await sendWhatsApp(client, msgPlain);
    const _emlOk = client.email_notif ? await sendEmail(client, item, matched, radarType, aiResume) : false;
    log("[SEND] RESULT client=" + client.nom + " item=" + item.id + " tg=" + _tgOk + " wa=" + _waOk + " email=" + _emlOk);
    const _delivered = _tgOk || _waOk || _emlOk;
    if (_delivered) {
      sentIds.add(item.id); sent++;
      // ── snapshot : match envoyé ─────────────────────────────────────────
      if (snapshotRows) {
        snapshotRows.push(makeSnapshotRow(
          _snapTs, client, item, radarType,
          "sent",
          matched[0] ? matched[0].valeur : null,
          matched.map(function(c) { return c.valeur; }),
          triggerLog || null,
        ));
      }
      await markSent(client.id, item.id, matched[0] ? matched[0].type : "", matched[0] ? matched[0].valeur : "", item);
    } else {
      log("[SEND] NO_DELIVERY_RETRYABLE client=" + client.nom + " item=" + item.id
        + " tg=" + _tgOk + " wa=" + _waOk + " email=" + _emlOk);
      if (_noDeliverySet) _noDeliverySet.add(item.id);
    }
    await delay(300);
  }
  await db.writeLog(client.id, itemsToCheck.length, found, sent, radarType);
  log("  [" + client.nom + "|" + radarType.toUpperCase() + "] " + label + ": " + found + " match(s) | " + sent + " envoye(s)");

  // ── Shadow comparison — observation pure, aucun effet sur la production ──
  if (SHADOW_ENABLED && radarType === "bc") {
    _shadowDebugItems(client, itemsToCheck, criteres);  // no-op sans SHADOW_CLIENT_FILTER
    const _se = _computeShadowComparison(client, itemsToCheck, criteres, radarType);
    _shadowAccum.push(_se);
  }
}

// ============================================================
// SCAN BC (Bons de Commande)
// ============================================================

// ── Diagnostic helpers ────────────────────────────────────────────────────────
/** Identifiant court (6 hex) pour corréler toutes les lignes d'un même scan. */
function _makeScanRunId() {
  return Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, "0");
}
/** Résumé mémoire rss/heap en MB arrondi. */
function _fmtMem() {
  try {
    const m = process.memoryUsage();
    return "rss=" + Math.round(m.rss / 1048576) + "MB heap=" + Math.round(m.heapUsed / 1048576) + "MB";
  } catch (_e) { return "mem=unavailable"; }
}
/** Uptime process en secondes depuis _startTime. */
function _fmtUptime() {
  return Math.round((Date.now() - _startTime) / 1000) + "s";
}
// ─────────────────────────────────────────────────────────────────────────────

let _scanningBC = false;
let _currentScanSource = "unknown";  // source du scan en cours (startup/cron/manual) — pour logs retry
// État du dernier scan BC — exposé dans /api/status pour diagnostic prod
let _lastBcScanOk     = null;   // null=jamais lancé, true=OK, false=échec technique
let _lastBcScanReason = "";     // raison lisible du dernier résultat
let _lastBcScanAt     = null;   // ISO timestamp de fin du dernier scan

async function runGlobalScanBC(source) {
  const _scanSource = source || "unknown";
  if (_scanningBC) { log("Scan BC precedent en cours, skip. [source=" + _scanSource + "]"); return; }
  _scanningBC = true;
  _currentScanSource = _scanSource;  // propagé dans les logs de retry scraping
  const _scanRunId = _makeScanRunId();  // corrélation lignes de ce scan
  const _scanStartMs = Date.now();       // durée totale du scan
  // ── Compteurs [SCAN_SUMMARY] — -1 = étape non atteinte ───────────────────
  let _sum_portal_total      = -1;
  let _sum_known_count       = -1;
  let _sum_new               = -1;
  let _sum_loaded            = -1;
  let _sum_failed            = -1;
  let _sum_vus_added         = -1;
  let _sum_no_delivery_retry = -1;
  let _sum_skipped_for_next  = -1;
  let _scanStatus            = "error"; // pessimiste par défaut
  const now = new Date().toLocaleString("fr-MA", { timeZone: "Africa/Casablanca" });
  log("\n" + "=".repeat(60));
  log("SCAN BC - " + now + " [source=" + _scanSource + " runId=" + _scanRunId + "]");
  log("=".repeat(60));
  log("[CTX] source=" + _scanSource
    + " runId=" + _scanRunId
    + " uptime=" + _fmtUptime()
    + " " + _fmtMem()
    + " scanningBC=" + _scanningBC
    + " currentSrc=" + _currentScanSource);
  let clients = [];
  try {
    const raw = await db.getClients();
    clients = (raw || []).filter(c => (c.criteres || []).some(cr => (cr.radar_type || "bc") === "bc"));
  } catch (e) { log("Supabase: " + e.message); _scanningBC = false; return; }
  if (!clients.length) { log("Aucun client BC actif."); _scanningBC = false; return; }
  log(clients.length + " client(s) BC actif(s) [runId=" + _scanRunId + "]");
  log("  [Legacy] ai_inclusions: " + (LEGACY_USE_AI_INCLUSIONS
    ? "ON  (valeur + ai_inclusions — RADAR_BC_LEGACY_USE_AI_INCLUSIONS=1)"
    : "OFF (valeur seul — defaut conservateur)"));
  await autoEnrichCriteres(clients, "bc");
  let browser;
  try {
    browser = await launchBrowser();
    log("[BROWSER] launched [runId=" + _scanRunId + " source=" + _scanSource
      + " headless=new" + " " + _fmtMem() + "]");
    // ── Charger vusIds AVANT scrapeAllItems pour permettre early stop listing ──
    const vusIds  = await db.getBCVusIds();
    // BC listing via Puppeteer sequentiel (1 page a la fois, evite OOM)
    const allBCs = await scrapeAllItems(browser, CFG.bcListUrl, "BC", vusIds);
    if (!allBCs.length) {
      if (allBCs._scanFailed) {
        const _techReason = "timeout/navigation portail (" + (allBCs._scanFailReason || "inconnu") + ")";
        log("SCAN BC FAILED: " + _techReason + " [source=" + _scanSource + "]");
        log("  -> Aucun BC ajoute a bcs_vus (echec technique avant parsing fiable)");
        if (_scanSource === "startup") {
          log("  -> [source=startup] echec scraping startup — le prochain cron horaire prendra le relais automatiquement");
        }
        _lastBcScanOk     = false;
        _lastBcScanReason = _techReason;
        _lastBcScanAt     = new Date().toISOString();
      } else {
        log("Aucun BC recupere (0 BC reel portail).");
        _lastBcScanOk     = true;
        _lastBcScanReason = "0 BC reel portail";
        _lastBcScanAt     = new Date().toISOString();
        _scanStatus = "ok"; // 0 BC portail = fin normale sans erreur
      }
      return;
    }
    _lastBcScanOk     = true;
    _lastBcScanReason = allBCs.length + " BC recuperes";
    _lastBcScanAt     = new Date().toISOString();
    const newBCs  = allBCs.filter(bc => !vusIds.has(bc.id));
    _sum_portal_total = allBCs.length;
    _sum_known_count  = vusIds.size;
    _sum_new          = newBCs.length;
    log(newBCs.length + " nouveaux BC | " + (allBCs.length - newBCs.length) + " deja connus");
    // ── KNOWN_DIAG : diagnostic "BC connus" — storage + échantillons ─────────
    {
      const _knownOnPortal = allBCs.filter(bc => vusIds.has(bc.id));
      log("[KNOWN_DIAG] storage=supabase:bcs_vus known_count=" + vusIds.size
        + " portal_total=" + allBCs.length + " new=" + newBCs.length);
      log("[KNOWN_DIAG] sample_known_refs="
        + (_knownOnPortal.length
          ? _knownOnPortal.slice(0, 5).map(bc => bc.id).join(",")
          : "(none — bcs_vus vide ou ids non correspondants)"));
      log("[KNOWN_DIAG] sample_new_refs="
        + newBCs.slice(0, 5).map(bc => bc.id + "=" + (bc.objet || "").slice(0, 25)).join(" | "));
    }
    // ── SNAPSHOT_ONLY : charger toutes les fiches portail et quitter ────────────
    // Placé AVANT le filtre bcToLoad/newBCs pour capturer TOUS les BC portail,
    // pas seulement les nouveaux. Mode normal : inchangé.
    if (SNAPSHOT_ONLY) {
      log("[SnapshotOnly] " + allBCs.length + " BC portail — chargement fiches complet (sans filtre known)...");
      const _snapshotBCs = await loadDetails(browser, allBCs, "BC tous (snapshot-only)", false);
      log("[SnapshotOnly] writing full portal snapshot: " + _snapshotBCs.length + " BC");
      writeInputSnapshot(_snapshotBCs);
      log("[SnapshotOnly] markBCVus skipped — RADAR_BC_SNAPSHOT_ONLY=1");
      log("[SnapshotOnly] matchClient skipped — RADAR_BC_SNAPSHOT_ONLY=1");
      log("[SnapshotOnly] notifications disabled — aucune notification envoyée");
      log("[SnapshotOnly] snapshot ecrit. Fermeture navigateur et exit propre.");
      await browser.close().catch(() => {});
      _scanningBC = false;
      process.exit(0);
    }
    // ── MAX_NEW_BC_DETAILS_PER_SCAN : cap chargement fiches (defaut 250, 0=sans limite) ──
    const _maxNewBCDetails = (() => {
      const raw = parseInt(process.env.MAX_NEW_BC_DETAILS_PER_SCAN || "", 10);
      if (!Number.isFinite(raw) || raw < 0) return 250;
      return raw; // 0 = pas de limite explicite
    })();
    const bcToLoad  = _maxNewBCDetails === 0 ? newBCs : newBCs.slice(0, _maxNewBCDetails);
    const bcSkipped = _maxNewBCDetails === 0 ? [] : newBCs.slice(_maxNewBCDetails);
    _sum_skipped_for_next = bcSkipped.length;
    if (bcSkipped.length > 0) {
      log("[FICHES] cap applied total_new=" + newBCs.length + " limit=" + _maxNewBCDetails + " skipped_for_next_scan=" + bcSkipped.length);
    }
    const newDetailed = await loadDetails(browser, bcToLoad, "BC nouveaux", false);
    _sum_loaded = newDetailed.length;
    _sum_failed = bcToLoad.length - newDetailed.length;
    writeInputSnapshot(newDetailed); // opt-in RADAR_BC_WRITE_INPUT_SNAPSHOT=1
    log("\nMatching clients BC...");
    const _noDeliveryIds = new Set();  // BC matchés mais non livrés — conservés hors bcs_vus
    const snapshotRows = []; // collecteur de snapshot — observation pure
    for (const client of clients) {
      const sentIds    = await db.getBCSentIds(client.id);
      const isNewClient = sentIds.size === 0 && vusIds.size > 0;
      if (isNewClient) {
        log("  [" + client.nom + "] NOUVEAU CLIENT BC - scan initial...");
        const historical = await db.getBCVusBCData();
        await matchClient(client, [...historical, ...newDetailed], "scan initial", "bc", snapshotRows, _noDeliveryIds);
      } else {
        await matchClient(client, newDetailed, "nouveaux BC", "bc", snapshotRows, _noDeliveryIds);
      }
    }
    if (newDetailed.length) {
      // Séparer items livrés (→ bcs_vus) et non-livrés (→ retry prochain scan)
      const _vusItems   = newDetailed.filter(bc => !_noDeliveryIds.has(bc.id));
      const _retryItems = newDetailed.filter(bc =>  _noDeliveryIds.has(bc.id));
      if (_retryItems.length) {
        log("[SEEN] " + _retryItems.length
          + " BC no_delivery_retryable → non ajoute a bcs_vus (retry prochain scan)");
        _retryItems.forEach(bc =>
          log("[SEEN] item=" + bc.id + " added_to_bcs_vus=false reason=no_delivery_retryable"));
      }
      if (_vusItems.length) {
        await db.markBCVus(_vusItems);
        log("[SEEN] " + _vusItems.length + " BC ajoutes a bcs_vus reason=delivered_or_no_match");
      }
      log("[KNOWN_DIAG] markBCVus_result vus_added=" + _vusItems.length
        + " no_delivery_retry=" + _retryItems.length
        + " loaded_this_scan=" + newDetailed.length
        + " skipped_for_next=" + bcSkipped.length);
      _sum_vus_added         = _vusItems.length;
      _sum_no_delivery_retry = _retryItems.length;
    }
    writeScanSnapshot(snapshotRows, "bc"); // toujours après markBCVus
    if (SHADOW_ENABLED) writeShadowReport();
    _scanStatus = "ok"; // scan complet sans exception
  } catch (e) {
    log("Erreur BC: " + e.message);
    if (e.stack) log(e.stack.split("\n").slice(0,3).join("\n"));
  } finally {
    if (browser) await browser.close().catch(() => {});
    _scanningBC = false;
    const _scanDurS = Math.round((Date.now() - _scanStartMs) / 1000);
    log("[SCAN_SUMMARY] runId=" + _scanRunId
      + " source=" + _scanSource
      + " duration=" + _scanDurS + "s"
      + " portal_total=" + _sum_portal_total
      + " known_count=" + _sum_known_count
      + " new=" + _sum_new
      + " loaded=" + _sum_loaded
      + " failed=" + _sum_failed
      + " vus_added=" + _sum_vus_added
      + " no_delivery_retry=" + _sum_no_delivery_retry
      + " skipped_for_next=" + _sum_skipped_for_next
      + " status=" + _scanStatus);
    log(_lastBcScanOk === false
      ? "Scan BC termine avec erreur technique (" + _lastBcScanReason + ")"
      : "Scan BC termine.");
  }
}

// ============================================================
// SCAN MP (Marches Publics / Appels d'Offres)
// Architecture SaaS 3 niveaux :
//   STANDARD : recherche portail par mot-clé (désignation lot)
//   MOYEN    : listing complet + popup detail HTML (sans DAO)
//   AVANCÉ   : listing complet + popup detail + DAO ZIP/PDF (BDP/CPS)
// ============================================================
let _scanningMP = false;

async function runGlobalScanMP() {
  if (!FEATURES.enableMP) { log("Radar MP desactive (v1 BC-only). Skip."); return; }
  if (_scanningMP) { log("Scan MP precedent en cours, skip."); return; }
  _scanningMP = true;
  const now = new Date().toLocaleString("fr-MA", { timeZone: "Africa/Casablanca" });
  log("\n" + "=".repeat(60));
  log("SCAN MARCHES PUBLICS v7 - " + now);
  log("=".repeat(60));

  let clients = [];
  try {
    const raw = await db.getClients();
    clients = (raw || []).filter(c => (c.criteres || []).some(cr => cr.radar_type === "mp"));
  } catch (e) { log("Supabase MP: " + e.message); _scanningMP = false; return; }
  if (!clients.length) { log("Aucun client MP actif."); _scanningMP = false; return; }

  // Grouper par pack (defaut = starter si champ pack absent/null)
  const stdClients = clients.filter(c => !c.pack || c.pack === "starter" || c.pack === "standard");
  const moyClients = clients.filter(c => c.pack === "pro" || c.pack === "moyen");
  const advClients = clients.filter(c => c.pack === "business" || c.pack === "avance");
  log(clients.length + " client(s) MP | " +
    stdClients.length + " starter | " +
    moyClients.length + " pro | " +
    advClients.length + " business");

  await autoEnrichCriteres(clients, "mp");
  let browser;
  try {
    browser = await launchBrowser();

    // Login si credentials dispo (utile pour pack avancé / DAO)
    if (CFG.login && CFG.password) {
      const lp = await newPage(browser);
      await loginPortal(lp, CFG.mpLoginUrl);
      await lp.close().catch(() => {});
    }

    const vusIds     = await db.getMPVusIds();
    const allMarques = []; // MPs à marquer vus à la fin (dédupliqués)

    // =====================================================
    // PACK STANDARD : recherche portail par mots-clés
    //   Le portail indexe les désignations de lots
    //   -> résultats rapides et ciblés, sans auth
    // =====================================================
    if (stdClients.length > 0) {
      log("\n" + "-".repeat(40));
      log("[PACK STANDARD] Recherche portail par mots-clés");
      log("-".repeat(40));

      // Collecter les paires (mot-clé, catégorie) depuis les critères MP
      // Une même clé peut avoir plusieurs catégories → on recherche chaque combo unique
      // categorie: "1"=Travaux, "2"=Fournitures, "3"=Services, "0"=Toutes
      const CATEGORIE_MAP = { "travaux": "1", "fournitures": "2", "services": "3" };
      const kwCatPairs = new Map(); // "kw||cat" -> {keyword, categorie}
      for (const client of stdClients) {
        let catValue = "0";
        // Chercher un critère catégorie pour ce client
        for (const c of (client.criteres || [])) {
          if (c.radar_type === "mp" && c.type === "categorie" && c.valeur) {
            catValue = CATEGORIE_MAP[c.valeur.toLowerCase()] || "0";
          }
        }
        for (const c of (client.criteres || [])) {
          if (c.radar_type === "mp" && c.type !== "categorie" && c.valeur) {
            const key = c.valeur + "||" + catValue;
            kwCatPairs.set(key, { keyword: c.valeur, categorie: catValue });
          }
        }
      }
      // Fallback: si aucune paire trouvée, chercher critères sans type spécifié
      if (kwCatPairs.size === 0) {
        for (const client of stdClients) {
          for (const c of (client.criteres || [])) {
            if (c.radar_type === "mp" && c.valeur) {
              kwCatPairs.set(c.valeur + "||0", { keyword: c.valeur, categorie: "0" });
            }
          }
        }
      }
      log("  Recherches: " + [...kwCatPairs.values()].map(p => "[" + p.keyword + (p.categorie !== "0" ? "/" + p.categorie : "") + "]").join(" "));

      const stdMap = new Map();
      for (const { keyword, categorie } of kwCatPairs.values()) {
        const found = await searchPortalByKeyword(browser, keyword, { categorie });
        for (const mp of found) { if (!stdMap.has(mp.id)) stdMap.set(mp.id, mp); }
        await delay(600);
      }
      const stdAll = [...stdMap.values()];
      const stdNew = stdAll.filter(mp => !vusIds.has(mp.id));
      const stdKnown = stdAll.filter(mp => vusIds.has(mp.id));
      log("  " + stdAll.length + " AO trouvés via portail | " + stdNew.length + " nouveaux");

      // STANDARD : charge le popup UNIQUEMENT pour les AO matchés par le portail
      // -> estimation + caution + lots, mais seulement pour les AO keyword-ciblés
      // Différence avec MOYEN : MOYEN charge le popup pour TOUS les AO du listing
      log("  Chargement popup pour " + stdNew.length + " nouveaux AO (standard)...");
      const stdNewDet = await loadDetails(browser, stdNew, "MP standard nouveaux", true, { skipDAO: true });

      log("  Matching clients standard...");
      for (const client of stdClients) {
        const sentIds = await db.getMPSentIds(client.id);
        const isNew   = sentIds.size === 0 && vusIds.size > 0;
        if (isNew) {
          log("  [" + client.nom + "] NOUVEAU CLIENT - scan initial standard...");
          const stdKnownDet = await loadDetails(browser, stdKnown, "scan initial standard", true, { skipDAO: true });
          await matchClient(client, [...stdKnownDet, ...stdNewDet], "scan initial (standard)", "mp");
        } else {
          await matchClient(client, stdNewDet, "nouveaux MP (standard)", "mp");
        }
      }
      for (const mp of stdNewDet) {
        if (!allMarques.find(m => m.id === mp.id)) allMarques.push(mp);
      }
    }

    // =====================================================
    // PACK MOYEN & AVANCÉ : listing complet + popup detail
    // =====================================================
    const needsFullScan = moyClients.length > 0 || advClients.length > 0;
    let allMPsListing = null;

    if (needsFullScan) {
      log("\n" + "-".repeat(40));
      log("[PACK MOYEN/AVANCÉ] Scan listing complet portail...");
      log("-".repeat(40));
      allMPsListing = await scrapeAllMPs(browser);
      if (!allMPsListing || !allMPsListing.length) {
        log("  Aucun MP récupéré du listing.");
        allMPsListing = [];
      }
    }

    // ---- PACK MOYEN (popup HTML, sans DAO) ----
    if (moyClients.length > 0 && allMPsListing && allMPsListing.length > 0) {
      log("\n[PACK MOYEN] Scan listing + popup candidats...");
      const moyNew   = allMPsListing.filter(mp => !vusIds.has(mp.id));
      const moyKnown = allMPsListing.filter(mp =>  vusIds.has(mp.id));
      log("  " + moyNew.length + " nouveaux | " + moyKnown.length + " connus");

      // Pré-filtre listing: ne charger le popup QUE pour les AOs candidats
      // Evite de charger 500+ popups sur le scan initial (mps_vus vide)
      // Les critères "contenu" cherchent dans l'objet du listing en premier pass
      const allMoyCriteres = moyClients.flatMap(c =>
        (c.criteres || []).filter(cr => cr.radar_type === "mp").map(cr => ({ type: cr.type, valeur: cr.valeur }))
      );
      const quickListingMatchMoy = mp => allMoyCriteres.some(c => {
        if (c.type === "region")    return hasKw(mp.wilaya, c.valeur) || hasKw(mp.lieu, c.valeur);
        if (c.type === "organisme") return hasKw(mp.organisme, c.valeur);
        return hasKw(mp.objet, c.valeur); // titre + contenu: objet du listing
      });
      const moyNewCands    = moyNew.filter(mp =>  quickListingMatchMoy(mp));
      const moyNewNonCands = moyNew.filter(mp => !quickListingMatchMoy(mp));
      log("  Pre-filtre: " + moyNewCands.length + " candidats popup | " + moyNewNonCands.length + " non-candidats (skip popup)");

      const moyNewDet = moyNewCands.length > 0
        ? await loadDetails(browser, moyNewCands, "MP moyen candidats", true, { skipDAO: true })
        : [];

      for (const client of moyClients) {
        const sentIds = await db.getMPSentIds(client.id);
        const isNew   = sentIds.size === 0 && vusIds.size > 0;
        if (isNew) {
          log("  [" + client.nom + "] NOUVEAU CLIENT MOYEN - scan initial...");
          const moyKnownCands = moyKnown.filter(mp => quickListingMatchMoy(mp));
          log("  " + moyKnownCands.length + " connus candidats popup");
          const moyKnownDet = moyKnownCands.length > 0
            ? await loadDetails(browser, moyKnownCands, "scan initial moyen", true, { skipDAO: true })
            : [];
          await matchClient(client, [...moyKnownDet, ...moyNewDet], "scan initial (moyen)", "mp");
        } else {
          await matchClient(client, moyNewDet, "nouveaux MP (moyen)", "mp");
        }
      }
      // Marquer TOUS les nouveaux comme vus: candidats (popup chargé) + non-candidats (listing only)
      for (const mp of [...moyNewDet, ...moyNewNonCands]) {
        if (!allMarques.find(m => m.id === mp.id)) allMarques.push(mp);
      }
    }

    // ---- PACK AVANCE (popup HTML + DAO) ----
    if (advClients.length > 0 && allMPsListing && allMPsListing.length > 0) {
      log("\n[PACK AVANCE] Scan listing + popup + DAO candidats...");
      const advNew   = allMPsListing.filter(mp => !vusIds.has(mp.id));
      const advKnown = allMPsListing.filter(mp =>  vusIds.has(mp.id));
      log("  " + advNew.length + " nouveaux | " + advKnown.length + " connus");

      // Pre-filtre listing: popup+DAO uniquement pour candidats
      const allAdvCriteres = advClients.flatMap(c =>
        (c.criteres || []).filter(cr => cr.radar_type === "mp").map(cr => ({ type: cr.type, valeur: cr.valeur }))
      );
      const quickListingMatchAdv = mp => allAdvCriteres.some(c => {
        if (c.type === "region")    return hasKw(mp.wilaya, c.valeur) || hasKw(mp.lieu, c.valeur);
        if (c.type === "organisme") return hasKw(mp.organisme, c.valeur);
        return hasKw(mp.objet, c.valeur);
      });
      const advNewCands    = advNew.filter(mp =>  quickListingMatchAdv(mp));
      const advNewNonCands = advNew.filter(mp => !quickListingMatchAdv(mp));
      log("  Pre-filtre: " + advNewCands.length + " candidats popup+DAO | " + advNewNonCands.length + " non-candidats (skip)");

      const advNewDet = advNewCands.length > 0
        ? await loadDetails(browser, advNewCands, "MP business candidats", true, { skipDAO: false })
        : [];

      for (const client of advClients) {
        const sentIds = await db.getMPSentIds(client.id);
        const isNew   = sentIds.size === 0 && vusIds.size > 0;
        if (isNew) {
          log("  [" + client.nom + "] NOUVEAU CLIENT BUSINESS - scan initial...");
          const advKnownCands = advKnown.filter(mp => quickListingMatchAdv(mp));
          log("  " + advKnownCands.length + " connus candidats popup+DAO");
          const advKnownDet = advKnownCands.length > 0
            ? await loadDetails(browser, advKnownCands, "scan initial business", true, { skipDAO: false })
            : [];
          await matchClient(client, [...advKnownDet, ...advNewDet], "scan initial (business)", "mp");
        } else {
          await matchClient(client, advNewDet, "nouveaux MP (business)", "mp");
        }
      }
      for (const mp of [...advNewDet, ...advNewNonCands]) {
        if (!allMarques.find(m => m.id === mp.id)) allMarques.push(mp);
      }
    }

    // Marquer tous les MPs traites comme vus
    if (allMarques.length > 0) {
      await db.markMPsVus(allMarques.map(mp => mp.id));
      log("\n" + allMarques.length + " MPs marques comme vus.");
    }

  } catch (e) {
    log("Erreur MP: " + e.message);
    if (e.stack) log(e.stack.split("\n").slice(0,3).join("\n"));
  } finally {
    if (browser) await browser.close().catch(() => {});
    _scanningMP = false;
    log("Scan MP termine.");
  }
}

// ============================================================
// SERVEUR HTTP (tests + health check)
// ============================================================
const http    = require("http");
const urlMod  = require("url");

const HTTP_PORT    = parseInt(process.env.PORT || "3000", 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
// Mode server-only : désactive cron + scan initial (tests locaux)
const SERVER_ONLY    = process.env.RADAR_BC_SERVER_ONLY   === "1";
// Mode snapshot-only : scrape → writeInputSnapshot → process.exit(0), sans HTTP/cron/matching/bcs_vus
const SNAPSHOT_ONLY  = process.env.RADAR_BC_SNAPSHOT_ONLY === "1";
// Délai avant le premier scan BC au démarrage (configurable, défaut 15 min)
// Augmenté à 900s pour laisser le portail se stabiliser après deploy
const _rawStartupDelay = parseInt(process.env.STARTUP_BC_SCAN_DELAY_MS || "", 10);
const STARTUP_BC_SCAN_DELAY_MS = (Number.isFinite(_rawStartupDelay) && _rawStartupDelay > 0)
  ? _rawStartupDelay
  : 900000;
// Timeout navigation scraping BC (configurable, défaut 120s — portail parfois lent depuis EU)
const _rawBcNavTimeout = parseInt(process.env.BC_NAV_TIMEOUT_MS || "", 10);
const BC_NAV_TIMEOUT_MS = (Number.isFinite(_rawBcNavTimeout) && _rawBcNavTimeout > 0)
  ? _rawBcNavTimeout
  : 120000;
const _reviewStore = require('./core/shadow/review-store.runtime.js'); // GD-029

const _startTime = Date.now();

function checkSecret(req) {
  if (!ADMIN_SECRET) return true; // pas de secret configuré = ouvert (dev)
  const u = urlMod.parse(req.url, true);
  return u.query.secret === ADMIN_SECRET;
}

function jsonResp(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

// ── readJsonBody helper (GD-029) ─────────────────────────────────────────
async function _readJsonBody(req) {
  const chunks = [];
  await new Promise(function(resolve, reject) {
    req.on('data', function(d) { chunks.push(d); });
    req.on('end', resolve);
    req.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const _httpServer = http.createServer(async (req, res) => {
  const parsed = urlMod.parse(req.url, true);
  const path_  = parsed.pathname;

  // ── GET /health  (Fly.io health check) ─────────────
  if (req.method === "GET" && path_ === "/health") {
    return jsonResp(res, 200, { status: "ok", uptime: Math.floor((Date.now() - _startTime) / 1000) });
  }

  // ── GET /api/status ──────────────────────────────
  if (req.method === "GET" && path_ === "/api/status") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    const cacheSize = Object.keys(AI_CACHE).length;
    return jsonResp(res, 200, {
      status:      "running",
      uptime_sec:  Math.floor((Date.now() - _startTime) / 1000),
      scanningBC:  _scanningBC,
      scanningMP:  _scanningMP,
      cache_size:  cacheSize,
      version:     "9.5",
      last_bc_scan_ok:     _lastBcScanOk,
      last_bc_scan_reason: _lastBcScanReason,
      last_bc_scan_at:     _lastBcScanAt,
    });
  }

  // ── POST /api/scan-now  (déclenche scan BC manuel — admin sécurisé) ──────
  // Usage PowerShell : Invoke-RestMethod -Method POST "$BASE_URL/api/scan-now?secret=XXXX"
  // Réponses :
  //   401 { ok:false, reason:"unauthorized" }            — secret absent/invalide
  //   409 { ok:false, reason:"scan_already_running" }    — scan BC déjà actif
  //   200 { ok:true,  accepted:true, source:"manual", accepted_at:... } — scan lancé
  if (req.method === "POST" && path_ === "/api/scan-now") {
    // 1. Auth — checkSecret ne logue jamais la valeur du secret
    if (!checkSecret(req)) {
      log("[HTTP] /api/scan-now refusé: secret absent ou invalide");
      return jsonResp(res, 401, { ok: false, reason: "unauthorized" });
    }
    // 2. Anti-doublon — refus si scan BC déjà actif
    if (_scanningBC) {
      log("[HTTP] /api/scan-now refusé: scan BC déjà en cours [source=" + _currentScanSource + "]");
      return jsonResp(res, 409, { ok: false, reason: "scan_already_running", current_source: _currentScanSource });
    }
    // 3. Lancer en arrière-plan sans bloquer la réponse HTTP
    const _acceptedAt = new Date().toISOString();
    log("[HTTP] /api/scan-now accepté [source=manual accepted_at=" + _acceptedAt + "]");
    runGlobalScanBC("manual").catch(e => log("[HTTP] Scan BC manual erreur: " + e.message));
    return jsonResp(res, 200, { ok: true, accepted: true, source: "manual", accepted_at: _acceptedAt });
  }

  // ── GET /api/test-notify  (envoie notif de test à un client) ─
  if (req.method === "GET" && path_ === "/api/test-notify") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    const clientId = parsed.query.client_id;
    try {
      const clients = await db.getClients();
      const client  = clientId
        ? clients.find(c => String(c.id) === String(clientId))
        : clients[0];
      if (!client) return jsonResp(res, 404, { error: "Client introuvable" });

      const fakeItem = {
        id:        "TEST-" + Date.now(),
        objet:     "BON DE COMMANDE TEST — Fourniture de matériel informatique",
        organisme: "Ministère de l'Économie et des Finances",
        date_limite: new Date(Date.now() + 7 * 86400000).toLocaleDateString("fr-MA"),
        url:       "https://www.marchespublics.gov.ma/bdc/entreprise/consultation/",
        montant:   null,
        articles:  [{ designation: "Ordinateurs portables", specifications: "Core i7, 16Go RAM" }],
        bodyText:  "fourniture matériel informatique ordinateur portable",
        _keyword:  "informatique",
      };
      const fakeMatched = [{
        valeur:        "informatique",
        type:          "titre",
        ai_inclusions: ["matériel informatique", "ordinateur"],
        ai_exclusions: [],
      }];
      // Liens feedback si le client est autorisé (FB-6C — utilise les mêmes gardes que le scan réel)
      const _fbTestHtml  = isFeedbackEnabledForClient(client.id)
        ? _buildFeedbackSection(client.id, fakeItem.id, "informatique", "bc", "html",  { notifId: "test-preview" })
        : null;
      const _fbTestPlain = isFeedbackEnabledForClient(client.id)
        ? _buildFeedbackSection(client.id, fakeItem.id, "informatique", "bc", "plain", { notifId: "test-preview" })
        : null;
      const msgPlain = buildMessage(fakeItem, fakeMatched, "bc", "Résumé IA test — marché de fourniture informatique pour administration.") + (_fbTestPlain || "");
      const msgHtml  = buildHtmlMessage(fakeItem, fakeMatched, "bc", "Résumé IA test — marché de fourniture informatique pour administration.") + (_fbTestHtml  || "");

      const results = {};
      if (client.tg_chat_id) {
        try { await sendTelegram(client, msgHtml); results.telegram = "ok"; }
        catch (e) { results.telegram = "erreur: " + e.message; }
      } else { results.telegram = "non configuré"; }

      if (client.phone) {
        try { await sendWhatsApp(client, msgPlain); results.whatsapp = "ok"; }
        catch (e) { results.whatsapp = "erreur: " + e.message; }
      } else { results.whatsapp = "non configuré"; }

      if (client.email_notif) {
        try { await sendEmail(client, fakeItem, fakeMatched, "bc", "Résumé IA test."); results.email = "ok"; }
        catch (e) { results.email = "erreur: " + e.message; }
      } else { results.email = "non configuré"; }

      log("[HTTP] Notif test envoyée au client: " + client.nom);
      return jsonResp(res, 200, { client: client.nom, channels: results });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // ── GET /api/replay-notify/list  (diagnostic — liste les snapshots disponibles) ──
  // Lecture seule : aucun scan, aucune écriture DB.
  if (req.method === "GET" && path_ === "/api/replay-notify/list") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    try {
      const snapshotFile = path.join(INPUT_SNAPSHOT_DIR, "latest-bc-input.jsonl");

      // Lister tous les fichiers du répertoire snapshot
      let filesFound = [];
      if (fs.existsSync(INPUT_SNAPSHOT_DIR)) {
        filesFound = fs.readdirSync(INPUT_SNAPSHOT_DIR)
          .filter(function(f) { return f.endsWith(".jsonl"); })
          .sort().reverse(); // plus récent en premier
      }

      // Lire le fichier utilisé par /api/replay-notify
      let items = [];
      const snapshotExists = fs.existsSync(snapshotFile);
      if (snapshotExists) {
        const lines = fs.readFileSync(snapshotFile, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try { items.push(JSON.parse(line)); } catch (_e) { /* ignorer lignes malformées */ }
        }
      }

      // 20 derniers bc_id (les plus récents = fin du fichier)
      const last20 = items.slice(-20).reverse().map(function(item) {
        return {
          bc_id: item.bc_id || item.id || "?",
          objet: item.objet || item.reference || "(sans objet)",
        };
      });

      return jsonResp(res, 200, {
        snapshot_dir:   INPUT_SNAPSHOT_DIR,
        files_found:    filesFound,
        file_used:      snapshotExists ? snapshotFile : null,
        item_count:     items.length,
        last_20_bc_ids: last20,
      });
    } catch (e) {
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // ── GET /api/replay-notify  (rejoue la notif Telegram d'un BC réel sans markSent) ──
  // Charge le client + l'item depuis le snapshot local, construit le message
  // identique au cron, appelle sendTelegram uniquement.
  // N'écrit JAMAIS dans bcs_envoyes — aucun appel à markSent.
  if (req.method === "GET" && path_ === "/api/replay-notify") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    const clientId = parsed.query.client_id;
    const bcId     = parsed.query.bc_id;
    const critereQ = parsed.query.critere || null;

    if (!clientId) return jsonResp(res, 400, { error: "Paramètre client_id manquant" });
    if (!bcId)     return jsonResp(res, 400, { error: "Paramètre bc_id manquant" });

    try {
      // 1. Charger le client (lecture Supabase, pas d'écriture)
      const clients = await db.getClients();
      const client  = clients.find(c => String(c.id) === String(clientId));
      if (!client) return jsonResp(res, 404, { error: "Client introuvable: " + clientId });

      // 2. Lire l'item depuis le snapshot d'entrée local (lecture seule, pas de scan)
      const snapshotFile = path.join(INPUT_SNAPSHOT_DIR, "latest-bc-input.jsonl");

      // Charger toutes les lignes valides du snapshot
      let snapshotItems = [];
      if (fs.existsSync(snapshotFile)) {
        const lines = fs.readFileSync(snapshotFile, "utf8").split("\n").filter(Boolean);
        for (const line of lines) {
          try { snapshotItems.push(JSON.parse(line)); } catch (_e) { /* ignorer lignes malformées */ }
        }
      }

      // Snapshot vide ou absent → réponse claire
      if (snapshotItems.length === 0) {
        return jsonResp(res, 404, {
          ok:    false,
          error: "Aucun snapshot disponible ou snapshot vide",
          hint:  "Attendre un scan avec BC récupérés (RADAR_BC_WRITE_INPUT_SNAPSHOT=1 requis)",
          snapshot_dir: INPUT_SNAPSHOT_DIR,
          file_used: fs.existsSync(snapshotFile) ? snapshotFile : null,
        });
      }

      // Support bc_id=latest → dernier item du snapshot (BC le plus récent)
      let item = null;
      const useLatest = (String(bcId).toLowerCase() === "latest");
      if (useLatest) {
        item = snapshotItems[snapshotItems.length - 1];
        log("[REPLAY] bc_id=latest → résolu en " + (item.bc_id || item.id || "?"));
      } else {
        for (const row of snapshotItems) {
          if (String(row.bc_id || row.id || "") === String(bcId)) { item = row; break; }
        }
      }

      if (!item) {
        return jsonResp(res, 404, {
          error:          "BC introuvable dans le snapshot local",
          bc_id:          bcId,
          item_count:     snapshotItems.length,
          sample_bc_ids:  snapshotItems.slice(-5).map(function(r) { return r.bc_id || r.id || "?"; }).reverse(),
          hint:           "Utiliser bc_id=latest pour rejouer le dernier item, ou /api/replay-notify/list pour voir les bc_id disponibles.",
        });
      }
      // Normaliser : le snapshot stocke l'identifiant dans bc_id — reconstruire item.id
      if (!item.id) item = Object.assign({}, item, { id: item.bc_id });

      // 3. Construire matchedCriteres
      //    Priorité : ?critere= → premier critère du client → fallback "—"
      const critereVal = critereQ
        || (client.criteres && client.criteres.length > 0 ? client.criteres[0].valeur : null)
        || "—";
      const matchedCriteres = [{
        valeur:        critereVal,
        type:          "titre",
        ai_inclusions: [],
        ai_exclusions: [],
      }];

      // 4. Construire le message HTML (mêmes builders que le cron réel)
      const _fbReplayHtml = isFeedbackEnabledForClient(client.id)
        ? _buildFeedbackSection(client.id, item.id, critereVal, "bc", "html", { notifId: "replay" })
        : null;
      const msgHtml = buildHtmlMessage(item, matchedCriteres, "bc", null) + (_fbReplayHtml || "");

      // 5. Détecter la troncature (Patch B — limite 4096 chars)
      const TG_MAX    = 4096;
      const msgLen    = msgHtml.length;
      const truncated = msgLen > TG_MAX;

      // 6. Vérifier que le client a un tg_chat_id configuré
      if (!client.tg_chat_id) {
        return jsonResp(res, 400, {
          ok: false, error: "Client sans tg_chat_id — Telegram impossible",
          client_id: clientId, bc_id: bcId,
        });
      }

      // 7. Envoyer via Telegram uniquement — jamais markSent, jamais bcs_envoyes
      const tgOk = await sendTelegram(client, msgHtml);
      const resolvedBcId = item.bc_id || item.id || bcId;
      log("[REPLAY] client=" + client.nom + " item=" + resolvedBcId + " tg=" + tgOk + " len=" + msgLen);

      return jsonResp(res, 200, {
        ok:        tgOk,
        client_id: clientId,
        bc_id:     resolvedBcId,
        tg_ok:     tgOk,
        msg_len:   msgLen,
        truncated: truncated,
        critere:   critereVal,
      });
    } catch (e) {
      log("[REPLAY] ERREUR: " + e.message);
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // ── POST /api/onboarding/enrich-criteria ──────────────────────────────────
  // Analyse locale des critères bêta — aucun appel IA, aucune écriture DB.
  if (req.method === "POST" && path_ === "/api/onboarding/enrich-criteria") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    try {
      const chunks = [];
      await new Promise(function(resolve, reject) {
        req.on("data", function(d) { chunks.push(d); });
        req.on("end",  resolve);
        req.on("error", reject);
      });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!body.criteria || !Array.isArray(body.criteria)) {
        return jsonResp(res, 400, { error: "criteria doit être un tableau de chaînes" });
      }
      const { enrichCriteriaList } = require("./core/onboarding/criteria-enrichment.runtime.js");
      const result = enrichCriteriaList({
        client_name: body.client_name || "",
        radar_type:  body.radar_type  || "bc",
        criteria:    body.criteria,
      });
      return jsonResp(res, 200, result);
    } catch (e) {
      log("[HTTP] Erreur enrich-criteria: " + e.message);
      return jsonResp(res, 500, { error: "Erreur interne: " + e.message });
    }
  }

  // ── POST /api/onboarding/ai-profile-questions ────────────────────────────
  if (req.method === "POST" && path_ === "/api/onboarding/ai-profile-questions") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    try {
      const chunks = [];
      await new Promise(function(resolve, reject) {
        req.on("data", function(d) { chunks.push(d); });
        req.on("end",  resolve);
        req.on("error", reject);
      });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!body.business_description) return jsonResp(res, 400, { error: "business_description requis" });
      const { generateProfileQuestions } = require("./core/onboarding/dynamic-profile-ai.runtime");
      const result = await generateProfileQuestions({
        client_name:          body.client_name || "",
        radar_type:           body.radar_type  || "bc",
        business_description: body.business_description,
      });
      return jsonResp(res, 200, result);
    } catch (e) {
      log("[HTTP] Erreur ai-profile-questions: " + e.message);
      return jsonResp(res, 500, { error: "Erreur interne: " + e.message });
    }
  }

  // ── POST /api/onboarding/ai-profile-finalize ──────────────────────────────
  if (req.method === "POST" && path_ === "/api/onboarding/ai-profile-finalize") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    try {
      const chunks = [];
      await new Promise(function(resolve, reject) {
        req.on("data", function(d) { chunks.push(d); });
        req.on("end",  resolve);
        req.on("error", reject);
      });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (!body.business_description) return jsonResp(res, 400, { error: "business_description requis" });
      if (!body.answers || typeof body.answers !== "object") return jsonResp(res, 400, { error: "answers requis (objet)" });
      const { finalizeProfileFromAnswers } = require("./core/onboarding/dynamic-profile-ai.runtime");
      const result = await finalizeProfileFromAnswers({
        client_name:          body.client_name || "",
        radar_type:           body.radar_type  || "bc",
        business_description: body.business_description,
        answers:              body.answers,
      });
      return jsonResp(res, 200, result);
    } catch (e) {
      log("[HTTP] Erreur ai-profile-finalize: " + e.message);
      return jsonResp(res, 500, { error: "Erreur interne: " + e.message });
    }
  }

  // ── POST /api/onboarding/ai-enrich-criterion ──────────────────────────────
  if (req.method === "POST" && path_ === "/api/onboarding/ai-enrich-criterion") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    try {
      const { enrichCriterionWithAI } = require("./core/onboarding/criteria-ai-enrichment.runtime");
      const body = await readJsonBody(req);
      if (!body.criterion) return jsonResp(res, 400, { error: "criterion requis" });
      const result = await enrichCriterionWithAI({
        criterion:      body.criterion,
        radar_type:     body.radar_type || "bc",
        client_context: body.client_context || undefined,
      });
      return jsonResp(res, 200, result);
    } catch (e) {
      log("[HTTP] Erreur ai-enrich-criterion: " + e.message);
      return jsonResp(res, 500, { error: "Erreur interne: " + e.message });
    }
  }

  // ── GET /api/admin/shadow-review/latest ── GD-029 ───────────────────────────
  if (req.method === "GET" && path_ === "/api/admin/shadow-review/latest") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    try {
      const DATA_DIR      = path.join(__dirname, "data");
      const shadowDir     = path.join(DATA_DIR, "shadow");
      const decisionsDir  = path.join(DATA_DIR, "review-decisions");
      const report = _reviewStore.getConsolidatedRows({ shadowDir, decisionsDir });
      return jsonResp(res, 200, report);
    } catch (e) {
      log("[HTTP] shadow-review/latest erreur: " + e.message);
      return jsonResp(res, 500, { error: "Erreur interne: " + e.message });
    }
  }

  // ── POST /api/admin/shadow-review/decide ── GD-029 ──────────────────────────
  if (req.method === "POST" && path_ === "/api/admin/shadow-review/decide") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    try {
      const body = await _readJsonBody(req);
      const { client, bc_id, decision, matched_signals, clean_score,
              signal_origin, strength_reason, clean_text_excerpt } = body;
      const decisionsDir = path.join(__dirname, "data", "review-decisions");
      const result = _reviewStore.saveDecision(
        { client, bc_id, decision, matched_signals: matched_signals || [],
          clean_score: clean_score || 0, signal_origin, strength_reason, clean_text_excerpt },
        decisionsDir
      );
      if (!result.ok) return jsonResp(res, 400, { error: result.error });
      log("[HTTP] shadow-review décision: " + decision + " bc=" + bc_id + " client=" + client);
      return jsonResp(res, 200, { ok: true, file: result.file, decision, bc_id, client });
    } catch (e) {
      log("[HTTP] shadow-review/decide erreur: " + e.message);
      return jsonResp(res, 500, { error: "Erreur interne: " + e.message });
    }
  }

  // ── POST /api/admin/onboarding/criteria/persist ────────────────────────────
  if (path_ === "/api/admin/onboarding/criteria/persist") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    try {
      const { handleOnboardingAdminRoute, readJsonBody } = require("./dist/core/onboarding/admin-router");
      const { persistPreparedCriteriaBatch }             = require("./dist/core/onboarding/criteria-repository");
      const { makeSbCriteriaClient }                     = require("./dist/core/onboarding/criteria-supabase-client");

      const body = await readJsonBody(req);

      const routerDeps = {
        env: process.env,
        persistBatch: (batch, opts) => {
          const client = makeSbCriteriaClient(CFG.sbUrl, CFG.sbKey);
          return persistPreparedCriteriaBatch(batch, opts, client);
        },
      };

      const result = await handleOnboardingAdminRoute(req.method, path_, body, routerDeps);
      if (result !== null) return jsonResp(res, result.status, result.body);
    } catch (e) {
      log("[HTTP] Erreur onboarding admin route: " + e.message);
      return jsonResp(res, 500, { ok: false, error: "Erreur interne serveur onboarding" });
    }
  }

  // ── Fichiers statiques (web/) ─────────────────────
  const WEB_DIR = path.join(__dirname, "web");
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".json": "application/json",
    ".png":  "image/png",
    ".ico":  "image/x-icon",
    ".svg":  "image/svg+xml",
  };

  // Redirect racine vers portail client
  if (path_ === "/" || path_ === "") {
    res.writeHead(302, { "Location": "/web/index.html" });
    return res.end();
  }

  // Servir les fichiers du dossier web/
  if (path_.startsWith("/web/")) {
    const filePath = path.join(WEB_DIR, path_.slice(5) || "index.html");
    const ext = path.extname(filePath);
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
      return res.end(data);
    } catch (e) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Fichier non trouvé: " + path_);
    }
  }

  // GET /feedback — capture d'un événement feedback
  if (req.method === "GET" && parsed.pathname === "/feedback") {
    const validation = validateFeedbackQuery(parsed.query);
    if (!validation.valid) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<html><body><p>Erreur : " + validation.error + "</p></body></html>");
    }
    // GD-085 : verification signature si FEEDBACK_REQUIRE_SIGNATURE=true
    // Comportement par defaut (flag absent) : anciens liens non signes acceptes
    if (_fbs.isFeedbackSignatureRequired(process.env.FEEDBACK_REQUIRE_SIGNATURE)) {
      const fbSecret = CFG.feedbackSigningSecret || "";
      if (!fbSecret) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<html><body><p>Erreur configuration : FEEDBACK_SIGNING_SECRET absent.</p></body></html>");
      }
      const sigVerif = _fbs.verifyFeedbackSignature(parsed.query, fbSecret, new Date());
      if (!sigVerif.valid) {
        res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<html><body><p>Lien feedback invalide : " + sigVerif.error + "</p></body></html>");
      }
    }
    const event = _fbh.buildFeedbackEvent(validation.data);
    // \u00c9criture Supabase \u2014 fire-and-forget, ne bloque jamais la r\u00e9ponse HTTP
    appendFeedbackToSupabase(event);
    // \u00c9criture JSONL locale \u2014 miroir/fallback, jamais bloquante
    const fbFile = require("path").join(__dirname, "data", "feedback", "feedback-events.jsonl");
    try {
      appendFeedbackEvent(event, fbFile);
    } catch (e) {
      log("Erreur \u00e9criture feedback JSONL: " + e.message);
      // JSONL non bloquant : Supabase a pu capturer l'\u00e9v\u00e9nement
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
      "<title>Feedback enregistr\u00e9</title></head><body>" +
      "<p>\u2705 Merci, votre retour a \u00e9t\u00e9 enregistr\u00e9.</p>" +
      "</body></html>"
    );
  }

  // ── GET /api/debug-snapshot-notify  (diagnostic matching + Telegram sans cron) ──────────────
  // Lit le snapshot local, evalue chaque item contre le client (is_en_cours,
  // already_sent, matching, quality_gate) et retourne un diagnostic JSON.
  // Mode dry-run par defaut (send=false) : aucun Telegram, aucun markSent.
  // Mode send=true : envoie UN seul item (bc_id requis) via sendTelegram, SANS markSent.
  if (req.method === "GET" && path_ === "/api/debug-snapshot-notify") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });

    const clientId      = parsed.query.client_id;
    const bcIdQ         = parsed.query.bc_id        || null;
    const critereQ      = parsed.query.critere       || null;
    const sendMode      = String(parsed.query.send   || "false").toLowerCase() === "true";
    const limit         = Math.min(parseInt(parsed.query.limit || "10", 10) || 10, 100);
    const searchAll     = String(parsed.query.search_all_snapshots || "false").toLowerCase() === "true";
    const onlyUnsent    = String(parsed.query.only_unsent    || "false").toLowerCase() === "true";
    const onlyWouldSend = String(parsed.query.only_would_send || "false").toLowerCase() === "true";

    if (!clientId) return jsonResp(res, 400, { error: "Parametre client_id manquant" });
    if (sendMode && !bcIdQ) return jsonResp(res, 400, { error: "send=true requiert bc_id" });

    try {
      // 1. Charger le client depuis Supabase (lecture seule)
      const allClients = await db.getClients();
      const client = allClients.find(c => String(c.id) === String(clientId));
      if (!client) return jsonResp(res, 404, { error: "Client introuvable: " + clientId });

      // 2. Construire la liste des fichiers snapshot a inspecter
      // input-snapshots : latest-bc-input.jsonl + bc-input-*.jsonl
      // scan-snapshots  : bc-scan-*.jsonl (SNAPSHOT_DIR)
      const latestFile = path.join(INPUT_SNAPSHOT_DIR, "latest-bc-input.jsonl");
      let filesToCheck = [latestFile];
      if (searchAll) {
        // Collecter depuis input-snapshots (bc-input-*.jsonl, hors latest)
        const inputArchives = fs.existsSync(INPUT_SNAPSHOT_DIR)
          ? fs.readdirSync(INPUT_SNAPSHOT_DIR)
              .filter(function(f) {
                return f.endsWith(".jsonl") && f.startsWith("bc-input-") &&
                  f !== "latest-bc-input.jsonl";
              })
              .sort().reverse()
              .map(function(f) { return path.join(INPUT_SNAPSHOT_DIR, f); })
          : [];
        // Collecter depuis scan-snapshots (bc-scan-*.jsonl)
        const scanArchives = fs.existsSync(SNAPSHOT_DIR)
          ? fs.readdirSync(SNAPSHOT_DIR)
              .filter(function(f) {
                return f.endsWith(".jsonl") && f.startsWith("bc-scan-");
              })
              .sort().reverse()
              .map(function(f) { return path.join(SNAPSHOT_DIR, f); })
          : [];
        // Fusionner : latest en premier, puis toutes archives triees newest-first, sans doublons
        const latestNorm = path.resolve(latestFile);
        const seen = new Set([latestNorm]);
        const allArchives = inputArchives.concat(scanArchives)
          .sort(function(a, b) { return b.localeCompare(a); }) // newest-first par nom
          .filter(function(f) {
            const n = path.resolve(f);
            if (seen.has(n)) return false;
            seen.add(n);
            return true;
          });
        filesToCheck = [latestFile].concat(allArchives);
      }

      let snapshotItems = [];
      let snapshotFileUsed = null;
      const filesChecked = [];
      const fileForItem = new Map(); // itemId -> fichier source

      if (bcIdQ && searchAll) {
        // Mode recherche : parcourir les fichiers jusqu'a trouver bc_id
        for (const f of filesToCheck) {
          if (!fs.existsSync(f)) continue;
          filesChecked.push(f);
          const rawLines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
          const parsedItems = [];
          for (const line of rawLines) {
            try { parsedItems.push(JSON.parse(line)); } catch (_e) {}
          }
          const hit = parsedItems.find(function(r) {
            return String(r.id || r.bc_id || "") === String(bcIdQ);
          });
          if (hit) {
            snapshotItems = parsedItems;
            snapshotFileUsed = f;
            log("[DEBUG-SNAPSHOT] bc_id=" + bcIdQ + " trouve dans " + f);
            break;
          }
        }
        // bc_id introuvable dans tous les snapshots
        if (snapshotItems.length === 0 && filesChecked.length > 0) {
          const sampleIds = [];
          for (const f of filesChecked) {
            if (!fs.existsSync(f)) continue;
            const rawLines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
            for (const line of rawLines.slice(-5)) {
              try { sampleIds.push(JSON.parse(line).id || JSON.parse(line).bc_id || "?"); } catch (_e) {}
            }
            if (sampleIds.length >= 10) break;
          }
          return jsonResp(res, 404, {
            ok:                     false,
            bc_found:               false,
            bc_id:                  bcIdQ,
            error:                  "bc_id introuvable dans tous les snapshots inspectes",
            snapshot_files_checked: filesChecked,
            sample_bc_ids:          sampleIds.slice(0, 10),
          });
        }
      } else if (!bcIdQ && searchAll) {
        // Mode critere multi-snapshot : parcourir tous les fichiers, dedupliquer par id
        const seenItemIds = new Set();
        for (const f of filesToCheck) {
          if (!fs.existsSync(f)) continue;
          filesChecked.push(f);
          const rawLines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
          for (const line of rawLines) {
            try {
              const item = JSON.parse(line);
              const itemId = String(item.id || item.bc_id || "");
              if (itemId && seenItemIds.has(itemId)) continue;
              if (itemId) seenItemIds.add(itemId);
              fileForItem.set(itemId, f);
              snapshotItems.push(item);
            } catch (_e) {}
          }
          if (!snapshotFileUsed) snapshotFileUsed = f;
        }
      } else {
        // Mode normal : latest seulement
        if (fs.existsSync(latestFile)) {
          filesChecked.push(latestFile);
          const rawLines = fs.readFileSync(latestFile, "utf8").split("\n").filter(Boolean);
          for (const line of rawLines) {
            try {
              const item = JSON.parse(line);
              const itemId = String(item.id || item.bc_id || "");
              if (itemId) fileForItem.set(itemId, latestFile);
              snapshotItems.push(item);
            } catch (_e) {}
          }
          snapshotFileUsed = latestFile;
        }
      }

      if (snapshotItems.length === 0) {
        return jsonResp(res, 404, {
          ok:                     false,
          error:                  "Snapshot vide ou absent",
          hint:                   "Attendre un run de cron avec RADAR_BC_WRITE_INPUT_SNAPSHOT=1",
          snapshot_file:          latestFile,
          snapshot_files_checked: filesChecked,
        });
      }

      // 3. Normaliser les items (bc_id -> id)
      snapshotItems = snapshotItems.map(function(r) {
        return r.id ? r : Object.assign({}, r, { id: r.bc_id });
      });

      // 4. Filtrer : par bc_id ou par critere textuel si fourni
      let candidates = snapshotItems;
      if (bcIdQ) {
        candidates = snapshotItems.filter(function(r) {
          return String(r.id || r.bc_id || "") === String(bcIdQ);
        });
      } else if (critereQ) {
        const cq = critereQ.toLowerCase();
        candidates = snapshotItems.filter(function(r) {
          return (r.objet || "").toLowerCase().includes(cq) ||
                 (r.bodyText || "").toLowerCase().includes(cq);
        });
      }
      // Cap de securite avant evaluation (filtrage onlyUnsent/onlyWouldSend apres)
      candidates = candidates.slice(0, Math.min(limit * 20, 500));

      // 5. Charger les ids deja envoyes (lecture seule, pas d'ecriture)
      const sentIds = await db.getBCSentIds(client.id);

      // 6. Preparer les criteres du client
      const criteres = (client.criteres || []).filter(function(c) {
        return (c.radar_type || "bc") === "bc";
      });

      // 7. Informations token (sans reveler la valeur)
      const hasCfgToken      = _isValidToken(process.env.TELEGRAM_BOT_TOKEN);
      const hasClientTgToken = _isValidToken(client.tg_token);
      const hasTgChatId      = !!(client.tg_chat_id);

      // 8. Evaluer chaque candidat
      const results = [];
      for (const item of candidates) {
        const enCours     = isEnCours(item);
        const alreadySent = sentIds.has(item.id);
        const matched     = criteres.length > 0 ? itemMatchesCriteres(item, criteres) : false;
        const matchedCriteres = matched ? getMatchedCriteres(item, criteres) : [];
        const matchedCritere  = matchedCriteres.length > 0 ? matchedCriteres[0].valeur : null;

        // Quality gate (seulement si match)
        let qualityGate = null;
        if (matched) {
          const _qg = _runQualityGate({
            critere_valeur: matchedCritere || "",
            objet:          item.objet || "",
            bodyText:       item.bodyText || "",
            matched_terms:  matchedCriteres.map(function(c) { return c.valeur; }),
            radar_type:     "bc",
            is_cancelled:   false,
          });
          qualityGate = { decision: _qg.decision, reason: _qg.reason || null };
        }

        // Message HTML (pour calculer la longueur)
        const critereVal = matchedCritere
          || (criteres.length > 0 ? criteres[0].valeur : null)
          || "---";
        const fakeCriteres = [{ valeur: critereVal, type: "titre", ai_inclusions: [], ai_exclusions: [] }];
        const msgHtml = buildHtmlMessage(item, fakeCriteres, "bc", null);
        const msgLen  = msgHtml.length;

        // would_send_telegram : true si tous les prerequis sont reunis
        const wouldSendTelegram = enCours && matched && !alreadySent
          && (qualityGate ? qualityGate.decision !== "block" : true)
          && hasTgChatId
          && (hasCfgToken || hasClientTgToken);

        const diag = {
          bc_id:               item.id || item.bc_id || null,
          titre:               (item.objet || "").slice(0, 80),
          date_limite:         item.date_limite || null,
          is_en_cours:         enCours,
          already_sent:        alreadySent,
          matched:             matched,
          matched_critere:     matchedCritere,
          quality_gate:        qualityGate,
          has_tg_chat_id:      hasTgChatId,
          has_token_cfg:       hasCfgToken,
          has_client_tg_token: hasClientTgToken,
          msg_len:             msgLen,
          would_send_telegram: wouldSendTelegram,
          send_attempted:      false,
          tg_ok:               null,
          delivery_result:     null,
        };

        // Mode send=true : envoyer CE seul item (bc_id requis, deja verifie)
        if (sendMode && bcIdQ && String(item.id || item.bc_id || "") === String(bcIdQ)) {
          log("[DEBUG-SNAPSHOT] send=true client=" + client.nom + " item=" + item.id);
          const tgOk = await sendTelegram(client, msgHtml);
          diag.send_attempted  = true;
          diag.tg_ok           = tgOk;
          diag.delivery_result = tgOk ? "delivered" : "failed";
          log("[DEBUG-SNAPSHOT] send=true tg=" + tgOk + " item=" + item.id);
        } else {
          log("[DEBUG-SNAPSHOT] client=" + client.nom + " item=" + (item.id || "?") +
              " send=false would_tg=" + wouldSendTelegram +
              " en_cours=" + enCours + " matched=" + matched + " sent=" + alreadySent);
        }

        results.push(diag);
      }

      const candidatesEvaluatedTotal = results.length;
      // Post-filtres optionnels (apres evaluation complete)
      let filteredResults = results;
      if (onlyUnsent)    filteredResults = filteredResults.filter(function(r) { return !r.already_sent; });
      if (onlyWouldSend) filteredResults = filteredResults.filter(function(r) { return r.would_send_telegram; });
      filteredResults = filteredResults.slice(0, limit);

      // Fichiers ayant au moins un item matche (avant post-filtres)
      const snapshotsWithMatchesSet = new Set(
        results
          .filter(function(r) { return r.matched; })
          .map(function(r) { return fileForItem.get(String(r.bc_id)) || snapshotFileUsed; })
          .filter(Boolean)
      );

      return jsonResp(res, 200, {
        ok:                         true,
        client_id:                  clientId,
        client_nom:                 client.nom,
        send_mode:                  sendMode,
        snapshot_file:              snapshotFileUsed,
        snapshot_files_checked:     filesChecked,
        snapshots_with_matches:     Array.from(snapshotsWithMatchesSet),
        bc_found:                   bcIdQ ? candidates.length > 0 : null,
        bc_found_in_snapshot:       (bcIdQ && candidates.length > 0) ? snapshotFileUsed : null,
        snapshot_total:             snapshotItems.length,
        candidates_evaluated:       filteredResults.length,
        candidates_evaluated_total: candidatesEvaluatedTotal,
        criteres_count:             criteres.length,
        has_tg_chat_id:             hasTgChatId,
        has_token_cfg:              hasCfgToken,
        results:                    filteredResults,
      });
    } catch (e) {
      log("[DEBUG-SNAPSHOT] ERREUR: " + e.message);
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // ── GET /api/debug-fetch-bc-page  (diagnostic fetch HTTP page BC — sans matching ni notif) ──
  if (req.method === "GET" && path_ === "/api/debug-fetch-bc-page") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    const _diagPage = Math.max(1, parseInt(String(parsed.query.page || "1"), 10) || 1);
    log("[HTTP] /api/debug-fetch-bc-page page=" + _diagPage);
    try {
      const diag = await debugFetchBcPage(_diagPage);
      log("[HTTP] debug-fetch-bc-page: " + diag.reason + " (status=" + diag.status + " elapsed=" + diag.elapsed_ms + "ms)");
      return jsonResp(res, 200, diag);
    } catch (e) {
      log("[HTTP] debug-fetch-bc-page erreur: " + e.message);
      return jsonResp(res, 500, { error: e.message });
    }
  }

  // ── GET /api/snapshot/latest  (télécharge le dernier snapshot JSONL) ──────────
  // type=scan   → SNAPSHOT_DIR/latest-bc-scan.jsonl
  // type=input  → INPUT_SNAPSHOT_DIR/latest-bc-input.jsonl
  // Protégé par ADMIN_SECRET (checkSecret).
  // Retourne le fichier en texte brut (application/x-ndjson) → curl-friendly.
  // Si le fichier n'existe pas, retourne 404 JSON avec un hint.
  if (req.method === "GET" && path_ === "/api/snapshot/latest") {
    if (!checkSecret(req)) return jsonResp(res, 401, { error: "Unauthorized" });
    const type_ = parsed.query.type || "scan";
    let latestPath;
    if (type_ === "input") {
      latestPath = path.join(INPUT_SNAPSHOT_DIR, "latest-bc-input.jsonl");
    } else if (type_ === "scan") {
      latestPath = path.join(SNAPSHOT_DIR, "latest-bc-scan.jsonl");
    } else {
      return jsonResp(res, 400, { error: "Paramètre type invalide. Valeurs acceptées : scan | input" });
    }
    if (!fs.existsSync(latestPath)) {
      return jsonResp(res, 404, {
        error:    "Fichier introuvable",
        type:     type_,
        path:     latestPath,
        hint:     type_ === "scan"
          ? "Aucun scan enregistré. Lancez un scan (POST /api/scan-now) ou vérifiez RADAR_BC_SNAPSHOT_DIR."
          : "WRITE_INPUT_SNAPSHOT non activé ou aucun scan effectué. Activez RADAR_BC_WRITE_INPUT_SNAPSHOT=1.",
      });
    }
    try {
      const stat    = fs.statSync(latestPath);
      const content = fs.readFileSync(latestPath, "utf8");
      res.writeHead(200, {
        "Content-Type":        "application/x-ndjson; charset=utf-8",
        "Content-Disposition": 'attachment; filename="' + path.basename(latestPath) + '"',
        "X-Snapshot-Path":     latestPath,
        "X-Snapshot-Size":     stat.size,
        "X-Snapshot-Mtime":    stat.mtime.toISOString(),
      });
      res.end(content);
    } catch (e) {
      return jsonResp(res, 500, { error: "Erreur lecture snapshot : " + e.message, path: latestPath });
    }
  }

  // 404 API
  return jsonResp(res, 404, { error: "Route inconnue", routes: [
    "GET  / \u2192 portail client",
    "GET  /web/index.html \u2192 portail client",
    "GET  /web/admin.html \u2192 admin",
    "GET  /web/shadow-review.html \u2192 shadow admin dashboard (GD-029)",
    "GET  /web/onboarding-review.html \u2192 revue crit\u00e8res onboarding (admin)",
    "GET  /web/pricing.html",
    "GET  /health",
    "GET  /api/status?secret=xxx",
    "POST /api/scan-now?secret=xxx",
    "GET  /api/test-notify?secret=xxx[&client_id=yyy]",
    "GET  /api/snapshot/latest?secret=xxx[&type=scan|input]",
    "GET  /api/replay-notify/list?secret=xxx",
    "GET  /api/replay-notify?secret=xxx&client_id=yyy&bc_id=<id|latest>[&critere=nettoyage]",
    "GET  /api/debug-snapshot-notify?secret=xxx&client_id=yyy[&bc_id=zzz][&critere=nettoyage][&send=false][&limit=10][&search_all_snapshots=false][&only_unsent=false][&only_would_send=false]",
    "GET  /api/debug-fetch-bc-page?secret=xxx[&page=1]",
    "POST /api/onboarding/enrich-criteria?secret=xxx",
    "GET  /api/admin/shadow-review/latest?secret=xxx",
    "POST /api/admin/shadow-review/decide?secret=xxx",
    "POST /api/admin/onboarding/criteria/persist?secret=xxx",
  ]});
});

// SNAPSHOT_ONLY : pas de serveur HTTP (one-shot snapshot + exit)
if (!SNAPSHOT_ONLY) {
  _httpServer.listen(HTTP_PORT, "0.0.0.0", () => {
    log("Serveur HTTP démarré sur 0.0.0.0:" + HTTP_PORT);
  });
}

// ============================================================
// PLANIFICATION CRON
// ============================================================
if (!SERVER_ONLY && !SNAPSHOT_ONLY) {
  // ── Garde anti-double déclenchement : clé YYYY-MM-DDTHH (UTC) ──────────
  let lastScheduledBcHourKey = "";

  function _makeHourKey() {
    const now = new Date();
    return now.getUTCFullYear() + "-"
      + String(now.getUTCMonth() + 1).padStart(2, "0") + "-"
      + String(now.getUTCDate()).padStart(2, "0") + "T"
      + String(now.getUTCHours()).padStart(2, "0");
  }

  function _triggerHourlyBC(source) {
    const key = _makeHourKey();
    if (lastScheduledBcHourKey === key) {
      log("[SCHED] hourly BC already triggered for hour=" + key + " source=" + source);
      return;
    }
    if (_scanningBC) {
      log("[SCHED] skipped because scan already running hour=" + key + " source=" + source);
      return;
    }
    lastScheduledBcHourKey = key;
    log("[SCHED] hourly BC trigger hour=" + key + " source=" + source);
    runGlobalScanBC(source).catch(e => log("Cron BC erreur [" + source + "]: " + e.message));
  }

  // ── Scheduler principal node-cron (0 * * * * UTC) ──────────────────────
  cron.schedule("0 * * * *", () => {
    _triggerHourlyBC("cron");
  });

  // ── Scheduler de secours setInterval (tick 60s, détection UTC minute===0) ─
  setInterval(() => {
    const now = new Date();
    log("[SCHED] heartbeat utc=" + now.toISOString().slice(0, 16));
    if (now.getUTCMinutes() === 0) {
      _triggerHourlyBC("cron-interval");
    }
  }, 60000);

  // Cron MP reserve pour activation future (FEATURES.enableMP = true)
  // cron.schedule("30 1,3,5,7,9,11,13,15,17,19,21,23 * * *", () => {
  //   runGlobalScanMP().catch(e => log("Cron MP erreur: " + e.message));
  // });

  log("Cron BC horaire programmé; Cron MP désactivé.");
}

// ============================================================
// DEMARRAGE
// ============================================================
if (SERVER_ONLY) {
  log("[ServerOnly] RADAR_BC_SERVER_ONLY=1 — scan initial et cron désactivés.");
  log("[ServerOnly] Serveur HTTP actif sur 0.0.0.0:" + HTTP_PORT + " — prêt pour tests locaux.");
} else if (SNAPSHOT_ONLY) {
  log("[SnapshotOnly] RADAR_BC_SNAPSHOT_ONLY=1 activé.");
  log("[SnapshotOnly] serveur HTTP non démarré.");
  log("[SnapshotOnly] cron non démarré.");
  log("[SnapshotOnly] notifications disabled — aucune notification ne sera envoyée.");
  (async () => {
    log("[SnapshotOnly] Chargement cache Supabase (lecture seule : getClients, getBCVusIds)...");
    await loadCacheFromSupabase();
    await runGlobalScanBC("snapshot-only");
  })().catch(e => { log("[SnapshotOnly] Erreur fatale: " + e.message); process.exit(1); });
} else {
  (async () => {
    log("[CFG] supabase=" + (CFG.sbUrl ? "set" : "empty")
      + " tg_token=" + (_isValidToken(process.env.TELEGRAM_BOT_TOKEN) ? "set" : "empty")
      + " tg_token_source=" + (_isValidToken(process.env.TELEGRAM_BOT_TOKEN) ? "env" : "absent")
      + " anthropic=" + (CFG.anthropicKey ? "set" : "empty")
      + " resend=" + (CFG.resendKey ? "set" : "empty"));
    log("[Snapshot] dir_scan=" + SNAPSHOT_DIR + " dir_input=" + INPUT_SNAPSHOT_DIR
      + (process.env.RADAR_BC_SNAPSHOT_DIR ? " (RADAR_BC_SNAPSHOT_DIR=" + process.env.RADAR_BC_SNAPSHOT_DIR + ")" : " (défaut)"));
    log("Bot demarre. Chargement cache Supabase...");
    await loadCacheFromSupabase();
    log("Cache charge. Premier scan BC dans " + (STARTUP_BC_SCAN_DELAY_MS / 1000) + "s, MP dans 65s...");
    setTimeout(() => runGlobalScanBC("startup").catch(e => log("Init BC: " + e.message)), STARTUP_BC_SCAN_DELAY_MS);
    // MP desactive en v1
    // setTimeout(() => runGlobalScanMP().catch(e => log("Init MP: " + e.message)), 65000);
  })();
}
