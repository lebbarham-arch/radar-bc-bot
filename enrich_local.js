"use strict";
// ============================================================
// enrich_local.js - Test enrichissement IA en local
// Lance : node enrich_local.js
// ============================================================
require("dotenv").config();
const fs   = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OLLAMA_URL    = process.env.OLLAMA_URL;
const OLLAMA_MODEL  = process.env.OLLAMA_MODEL || "qwen2.5:32b";

const log = msg => console.log("[" + new Date().toLocaleTimeString("fr-MA") + "] " + msg);
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

// --- Cache ---
const AI_CACHE_FILE = path.join(__dirname, "ai_cache.json");
function loadCache() {
  try {
    if (fs.existsSync(AI_CACHE_FILE))
      return JSON.parse(fs.readFileSync(AI_CACHE_FILE, "utf8"));
  } catch(e) { log("[Cache] Erreur: " + e.message); }
  return {};
}
function saveCache(c) {
  fs.writeFileSync(AI_CACHE_FILE, JSON.stringify(c, null, 2), "utf8");
}
const CACHE = loadCache();
log("[Cache] " + Object.keys(CACHE).length + " entrées chargées");

// --- Supabase helpers ---
async function sbFetch(table, qs) {
  const r = await fetch(SB_URL + "/rest/v1/" + table + "?" + qs, {
    headers: {
      "apikey": SB_KEY,
      "Authorization": "Bearer " + SB_KEY,
      "Content-Type": "application/json",
    }
  });
  if (!r.ok) throw new Error("Supabase " + r.status + ": " + await r.text());
  return r.json();
}

async function sbPatch(table, id, body) {
  const r = await fetch(SB_URL + "/rest/v1/" + table + "?id=eq." + id, {
    method: "PATCH",
    headers: {
      "apikey": SB_KEY,
      "Authorization": "Bearer " + SB_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("Supabase PATCH " + r.status + ": " + await r.text());
}

// --- LLM : Ollama ou Haiku ---
async function callLLM(systemPrompt, userPrompt, maxTokens = 500) {
  // 1. Essai Ollama
  if (OLLAMA_URL) {
    try {
      const r = await fetch(OLLAMA_URL + "/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userPrompt   },
          ],
          stream: false,
          format: "json",
          options: { temperature: 0.2, num_predict: maxTokens },
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const raw = (d.message?.content || "").trim();
        try { return JSON.parse(raw); } catch(e) {}
      }
    } catch(e) { log("[Ollama] " + e.message); }
  }

  // 2. Fallback Haiku
  if (ANTHROPIC_KEY) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const raw = (d.content?.[0]?.text || "").trim();
        // Extraire JSON du bloc ```json ... ```
        const m = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
        if (m) try { return JSON.parse(m[1]); } catch(e) {}
        try { return JSON.parse(raw); } catch(e) {}
      }
    } catch(e) { log("[Haiku] " + e.message); }
  }

  log("[LLM] Aucun LLM disponible (OLLAMA_URL et ANTHROPIC_API_KEY vides)");
  return null;
}

// --- Enrichissement d'un critere ---
async function enrichCritere(critere) {
  const cacheKey = norm(critere.valeur);
  if (CACHE[cacheKey]) {
    log('  [Cache HIT] "' + critere.valeur + '"');
    return CACHE[cacheKey];
  }

  const sys = `Tu es un expert en marchés publics marocains.
Génère une famille sémantique JSON pour aider un radar de marchés à trouver des BCs/MPs pertinents.
Réponds UNIQUEMENT en JSON valide, sans texte autour.
Format :
{
  "inclusions": ["terme1", "terme2", ...],
  "exclusions": ["terme_a_exclure", ...]
}
- inclusions : 8-15 termes/variantes du mot-clé (synonymes, abréviations, variantes orthographiques, termes métier)
- exclusions : 3-6 termes qui ressemblent mais sont hors-sujet`;

  const usr = 'Mot-clé client : "' + critere.valeur + '"\nType de radar : ' + (critere.radar_type || "bc");

  log('  [LLM] Enrichissement: "' + critere.valeur + '"...');
  const result = await callLLM(sys, usr, 400);
  if (!result || !Array.isArray(result.inclusions)) {
    log('  [LLM] Echec pour "' + critere.valeur + '"');
    return null;
  }

  const entry = {
    valeur:      critere.valeur,
    inclusions:  result.inclusions,
    exclusions:  result.exclusions || [],
    cached_at:   new Date().toISOString(),
  };
  CACHE[cacheKey] = entry;
  saveCache(CACHE);
  log('  [OK] ' + result.inclusions.length + ' inclusions, ' + (result.exclusions || []).length + ' exclusions');
  return entry;
}

// --- Programme principal ---
async function main() {
  if (!SB_URL || !SB_KEY) {
    log("ERREUR: SUPABASE_URL ou SUPABASE_KEY manquant dans .env");
    process.exit(1);
  }
  if (!OLLAMA_URL && !ANTHROPIC_KEY) {
    log("ERREUR: aucun LLM configuré. Mettre OLLAMA_URL ou ANTHROPIC_API_KEY dans .env");
    process.exit(1);
  }

  log("=== ENRICHISSEMENT LOCAL ===");
  log("Supabase: " + SB_URL);
  log("LLM: " + (OLLAMA_URL ? "Ollama (" + OLLAMA_MODEL + ")" : "Claude Haiku"));

  // Charger les critères non enrichis
  const criteres = await sbFetch("criteres",
    "select=id,valeur,radar_type,ai_inclusions,ai_exclusions&order=valeur"
  );
  log(criteres.length + " critère(s) trouvé(s) en base");

  const toEnrich = criteres.filter(c =>
    !c.ai_inclusions || c.ai_inclusions.length === 0
  );
  log(toEnrich.length + " à enrichir (sans ai_inclusions)");

  if (!toEnrich.length) {
    log("Tous les critères sont déjà enrichis !");
    log("Cache: " + Object.keys(CACHE).length + " entrées dans ai_cache.json");
    return;
  }

  let ok = 0, ko = 0;
  for (const c of toEnrich) {
    const result = await enrichCritere(c);
    if (result) {
      await sbPatch("criteres", c.id, {
        ai_inclusions: result.inclusions,
        ai_exclusions: result.exclusions,
      });
      log('  [Supabase] Sauvé: "' + c.valeur + '"');
      ok++;
    } else {
      ko++;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  log("=== RÉSULTAT ===");
  log("✅ " + ok + " enrichis, ❌ " + ko + " échecs");
  log("Cache final: " + Object.keys(CACHE).length + " entrées dans ai_cache.json");
}

main().catch(e => { log("ERREUR FATALE: " + e.message); process.exit(1); });
