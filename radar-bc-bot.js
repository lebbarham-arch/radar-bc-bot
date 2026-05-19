"use strict";

require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
const cron      = require("node-cron");
const fetch     = require("node-fetch");
let pdfParse;
try { pdfParse = require("pdf-parse"); } catch(e) { pdfParse = null; }
let AdmZip;
try { AdmZip = require("adm-zip"); } catch(e) { AdmZip = null; }

puppeteer.use(Stealth());

const CFG = {
  sbUrl:     process.env.SUPABASE_URL     || "",
  sbKey:     process.env.SUPABASE_KEY     || "",
  login:     process.env.PORTAL_LOGIN     || "",
  password:  process.env.PORTAL_PASSWORD  || "",
  tgToken:   process.env.TELEGRAM_BOT_TOKEN || "",
  // BC - Bons de Commande
  bcListUrl:  "https://www.marchespublics.gov.ma/bdc/entreprise/consultation/",
  bcLoginUrl: "https://www.marchespublics.gov.ma/index.php?page=entreprise.EntrepriseHome",
  // MP - Marchés Publics (Appels d'Offres)
  mpListUrl:  "https://www.marchespublics.gov.ma/index.php?page=entreprise.EntrepriseAdvancedSearch&AllCons&EnCours&searchAnnCons",
  mpLoginUrl: "https://www.marchespublics.gov.ma/index.php?page=entreprise.EntrepriseHome",
};

const delay     = ms     => new Promise(r => setTimeout(r, ms));
const randDelay = (a, b) => delay(Math.floor(Math.random() * (b - a)) + a);
const log       = msg    => console.log("[" + new Date().toLocaleTimeString("fr-MA") + "] " + msg);

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

function isEnCours(item) {
  if (norm(item.objet || "").includes("annul")) return false;
  if (item.date_limite) {
    const m = item.date_limite.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) {
      const dStr     = m[3] + "-" + m[2] + "-" + m[1];
      const todayStr = new Date().toISOString().slice(0, 10);
      if (dStr < todayStr) return false;
    }
  }
  return true;
}

// ============================================================
// MATCHING CRITERES
// FIX: "contenu" cherche UNIQUEMENT dans les articles/lots
//      pas dans le titre, l'organisme, ou la description brute
// ============================================================
function matchCritere(item, c) {
  switch (c.type) {
    case "region":
      return hasKw(item.wilaya, c.valeur) || hasKw(item.lieu, c.valeur);
    case "organisme":
      return hasKw(item.organisme, c.valeur);
    case "titre":
      return hasKw(item.objet, c.valeur);
    case "contenu":
      // Recherche dans les articles extraits ET dans le texte complet de la fiche
      return (item.articles || []).some(a =>
          hasKw(a.designation, c.valeur) || hasKw(a.specifications, c.valeur))
        || hasKw(item.bodyText || "", c.valeur)
        || hasKw(item.objet || "", c.valeur);
    default:
      return false;
  }
}

function itemMatchesCriteres(item, criteres) { return criteres.some(c => matchCritere(item, c)); }
function getMatchedCriteres(item, criteres)  { return criteres.filter(c => matchCritere(item, c)); }

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

const db = {
  // Tous les clients actifs avec leurs criteres
  getClients: () => sbReq("clients?actif=eq.true&select=*,criteres(*)"),

  // ---- BC (Bons de Commande) ----
  getBCVusIds: async () => {
    try {
      const rows = await sbReq("bcs_vus?select=bc_id&limit=20000");
      return new Set((rows || []).map(r => r.bc_id));
    } catch (e) { log("  bcs_vus indisponible: " + e.message); return new Set(); }
  },
  getBCVusBCData: async () => {
    try {
      const rows = await sbReq("bcs_vus?select=bc_data&limit=20000");
      return (rows || []).map(r => r.bc_data).filter(Boolean);
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
};

// ============================================================
// NOTIFICATIONS
// ============================================================
async function sendTelegram(client, msg) {
  const token = CFG.tgToken || client.tg_token;
  if (!token || !client.tg_chat_id) return;
  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: client.tg_chat_id, text: msg }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) log("  Telegram erreur " + r.status + ": " + (d.description || JSON.stringify(d)));
    else log("  Telegram -> " + client.tg_chat_id);
  } catch (e) { log("  Telegram erreur: " + e.message); }
}

async function sendWhatsApp(client, msg) {
  const num = (client.phone || "").replace(/\D/g, "");
  if (!num) return;
  try {
    if (client.wa_provider === "callmebot") {
      const r = await fetch("https://api.callmebot.com/whatsapp.php?phone=" + num +
        "&text=" + encodeURIComponent(msg) + "&apikey=" + client.wa_apikey);
      if (!r.ok) log("  WhatsApp erreur HTTP " + r.status);
      else log("  WhatsApp -> +" + num);
    }
  } catch (e) { log("  WhatsApp erreur: " + e.message); }
}

function buildMessage(item, matchedCriteres, radarType) {
  const arts = (item.articles || []).slice(0, 10)
    .map((a, i) => {
      let line = "  " + (i + 1) + ". " + a.designation;
      // Montant estimé et caution (extraits du popup PopUpDetailLots)
      if (a.estimation && a.estimation !== "-" && a.estimation !== "")
        line += "\n       Estimation : " + a.estimation;
      if (a.caution && a.caution !== "-" && a.caution !== "" && !/^0[,.]?0*\s*DH?$/i.test(a.caution.trim()))
        line += " | Caution : " + a.caution;
      // Fallback quantite (BCs)
      if (!a.estimation && a.quantite)
        line += " - " + a.quantite + " " + (a.unite || "");
      return line;
    })
    .join("\n");
  const more  = item.articles && item.articles.length > 10
    ? "\n  ... +" + (item.articles.length - 10) + " autres lots" : "";
  const icons = { region: "[region]", organisme: "[org]", titre: "[titre]", contenu: "[contenu]" };
  const tags  = matchedCriteres.map(c => icons[c.type] + " " + c.valeur).join(" | ");
  const header = radarType === "mp" ? "NOUVEAU MARCHE PUBLIC" : "NOUVEAU BC EN COURS";
  const budgetLine = item.estimation_totale
    ? "Budget estimatif : " + item.estimation_totale + " DH TTC" : null;
  return [
    header, tags, "",
    "Ref: "    + (item.reference || item.id || "N/A"),
    "Org: "    + (item.organisme || "N/A"),
    "Objet: "  + (item.objet || "N/A"),
    "Lieu: "   + (item.wilaya || item.lieu || "N/A"),
    "Limite: " + (item.date_limite || "N/A"),
    budgetLine,
    "", radarType === "mp" ? "Lots :" : "Articles :",
    arts || "  (voir la fiche)",
    more, "",
    "Lien: " + item.url, "",
    "Radar Marches Maroc - Veille automatique",
  ].filter(l => l !== undefined && l !== null).join("\n");
}

// ============================================================
// PUPPETEER
// ============================================================
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--window-size=1440,900"],
  });
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  await page.setExtraHTTPHeaders({ "Accept-Language": "fr-FR,fr;q=0.9,ar;q=0.8" });
  return page;
}

async function loginPortal(page, loginUrl) {
  log("Connexion au portail...");
  try {
    // Timeout genereux : le portail marocain est parfois lent depuis l'Europe
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
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
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 45000 });
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
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) { log("  Page " + pageNum + " retry..."); await delay(3000); }
    let pg;
    try {
      pg = await newPage(browser);
      await pg.goto(url, { waitUntil: "domcontentloaded", timeout: isBDC ? 35000 : 55000 });
      await delay(200 + Math.floor(Math.random() * 250));
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
      if (pg) await pg.close().catch(() => {});
      if (attempt === 1) return { items: [], hasNext: false, failed: true };
    }
  }
  return { items: [], hasNext: false, failed: true };
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
      await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 35000 });
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
        await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 });
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
  return all;
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
      await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 35000 });
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
        await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 });
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

async function scrapeAllItems(browser, baseUrl, label) {
  const all = []; let pageNum = 1; const BATCH = 3;
  log("  Chargement liste " + label + " (" + BATCH + " pages en parallele)...");
  while (pageNum <= 500) {
    const results = await Promise.all(
      Array.from({ length: BATCH }, (_, i) => scrapeOnePage(browser, baseUrl, pageNum + i))
    );
    let stop = false;
    for (const r of results) {
      if (r.failed || r.items.length === 0) { stop = true; break; }
      all.push(...r.items);
      if (!r.hasNext) { stop = true; break; }
    }
    log("  -> Pages " + pageNum + "-" + (pageNum + BATCH - 1) + ": " + all.length + " " + label);
    if (stop) break;
    pageNum += BATCH;
    await delay(600);
  }
  log("  " + all.length + " " + label + " sur le portail");
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
    await page.goto(bc.url, { waitUntil: "domcontentloaded", timeout: 35000 });
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
      document.querySelectorAll("table").forEach(t => {
        t.querySelectorAll("tr").forEach((row, i) => {
          if (i === 0) return;
          const cells = row.querySelectorAll("td");
          if (!cells.length) return;
          const desig = (cells[0].innerText || "").trim();
          if (!desig || desig.length < 3 || seen.has(desig)) return;
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
      document.querySelectorAll("table tr").forEach(row => {
        const cells = [...row.querySelectorAll("td")];
        if (!cells.length) return;
        const firstTxt = (cells[0].innerText || "").trim();
        const valueTxt = cells.length >= 2 ? (cells[cells.length - 1].innerText || "").trim() : firstTxt;
        // Détecter en-tête de lot : "Lot 1 :" dans la première cellule
        const lotM = firstTxt.match(/^Lot\s+(\d+)\s*:/i);
        if (lotM) {
          curLot = { lotNum: parseInt(lotM[1]), designation: valueTxt, estimation: "", caution: "", categorie: "" };
          lots.push(curLot);
          return;
        }
        if (!curLot) return;
        const lbl = firstTxt.toLowerCase();
        if (/estimation/i.test(lbl))  curLot.estimation = valueTxt;
        if (/caution/i.test(lbl))     curLot.caution    = valueTxt;
        if (/cat[eé]gorie/i.test(lbl)) curLot.categorie  = valueTxt;
      });

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
    return { ...mp, ...rest, articles, bodyText: bodyText.slice(0, 20000), estimation_totale: d.estimation_totale || "" };
  } catch (e) { log("  MP Detail " + mp.id + ": " + e.message); return mp; }
}

async function loadDetails(browser, items, label, isMP, opts) {
  if (!items.length) return [];
  const packLabel = opts && opts.skipDAO === true ? "[MOYEN]" : opts && opts.skipDAO === false ? "[AVANCÉ]" : "";
  log("  Chargement " + items.length + " fiches " + label + " " + packLabel + " (3 en parallele)...");
  const result = []; const BATCH = 3;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const pages = await Promise.all(batch.map(() => newPage(browser)));
    const detailed = await Promise.all(batch.map((item, idx) =>
      (isMP ? scrapeMPDetail(pages[idx], item, opts) : scrapeBCDetail(pages[idx], item)).catch(() => item)
    ));
    await Promise.all(pages.map(p => p.close().catch(() => {})));
    result.push(...detailed);
    if (i > 0 && i % 60 === 0) log("  " + i + "/" + items.length + " fiches chargees");
    await delay(isMP ? 400 : 200);
  }
  return result;
}

// ============================================================
// MATCHING PAR CLIENT
// radarType: 'bc' ou 'mp'
// ============================================================
async function matchClient(client, itemsToCheck, label, radarType) {
  const criteres = (client.criteres || [])
    .filter(c => (c.radar_type || "bc") === radarType)
    .map(c => ({ type: c.type, valeur: c.valeur }));
  if (!criteres.length) return;

  const getSentIds = radarType === "bc" ? db.getBCSentIds : db.getMPSentIds;
  const markSent   = radarType === "bc" ? db.markBCSent   : db.markMPSent;

  const sentIds = await getSentIds(client.id);
  let found = 0, sent = 0;

  for (const item of itemsToCheck) {
    if (!isEnCours(item)) continue;
    if (!itemMatchesCriteres(item, criteres)) continue;
    found++;
    if (sentIds.has(item.id)) continue;
    const matched = getMatchedCriteres(item, criteres);
    const tag = "[" + radarType.toUpperCase() + "][" + client.nom + "] BC " + item.id +
      " [" + matched.map(c => c.valeur).join(", ") + "] " + (item.objet || "").slice(0, 50);
    log("  MATCH " + tag);
    sentIds.add(item.id); sent++;
    const msg = buildMessage(item, matched, radarType);
    await sendTelegram(client, msg);
    await sendWhatsApp(client, msg);
    await markSent(client.id, item.id, matched[0] ? matched[0].type : "", matched[0] ? matched[0].valeur : "", item);
    await delay(300);
  }
  await db.writeLog(client.id, itemsToCheck.length, found, sent, radarType);
  log("  [" + client.nom + "|" + radarType.toUpperCase() + "] " + label + ": " + found + " match(s) | " + sent + " envoye(s)");
}

// ============================================================
// SCAN BC (Bons de Commande)
// ============================================================
let _scanningBC = false;

async function runGlobalScanBC() {
  if (_scanningBC) { log("Scan BC precedent en cours, skip."); return; }
  _scanningBC = true;
  const now = new Date().toLocaleString("fr-MA", { timeZone: "Africa/Casablanca" });
  log("\n" + "=".repeat(60));
  log("SCAN BC - " + now);
  log("=".repeat(60));
  let clients = [];
  try {
    const raw = await db.getClients();
    clients = (raw || []).filter(c => (c.criteres || []).some(cr => (cr.radar_type || "bc") === "bc"));
  } catch (e) { log("Supabase: " + e.message); _scanningBC = false; return; }
  if (!clients.length) { log("Aucun client BC actif."); _scanningBC = false; return; }
  log(clients.length + " client(s) BC actif(s)");
  let browser;
  try {
    browser = await launchBrowser();
    if (CFG.login && CFG.password) {
      const lp = await newPage(browser);
      await loginPortal(lp, CFG.bcLoginUrl);
      await lp.close().catch(() => {});
    }
    const allBCs = await scrapeAllItems(browser, CFG.bcListUrl, "BC");
    if (!allBCs.length) { log("Aucun BC recupere."); return; }
    const vusIds  = await db.getBCVusIds();
    const newBCs  = allBCs.filter(bc => !vusIds.has(bc.id));
    log(newBCs.length + " nouveaux BC | " + (allBCs.length - newBCs.length) + " deja connus");
    const newDetailed = await loadDetails(browser, newBCs, "BC nouveaux", false);
    log("\nMatching clients BC...");
    for (const client of clients) {
      const sentIds    = await db.getBCSentIds(client.id);
      const isNewClient = sentIds.size === 0 && vusIds.size > 0;
      if (isNewClient) {
        log("  [" + client.nom + "] NOUVEAU CLIENT BC - scan initial...");
        const historical = await db.getBCVusBCData();
        await matchClient(client, [...historical, ...newDetailed], "scan initial", "bc");
      } else {
        await matchClient(client, newDetailed, "nouveaux BC", "bc");
      }
    }
    if (newDetailed.length) {
      await db.markBCVus(newDetailed);
      log(newDetailed.length + " BC ajoutes a bcs_vus");
    }
  } catch (e) {
    log("Erreur BC: " + e.message);
    if (e.stack) log(e.stack.split("\n").slice(0,3).join("\n"));
  } finally {
    if (browser) await browser.close().catch(() => {});
    _scanningBC = false;
    log("Scan BC termine.");
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

  // Grouper par pack (défaut = standard si champ pack absent/null)
  const stdClients = clients.filter(c => !c.pack || c.pack === "standard");
  const moyClients = clients.filter(c => c.pack === "moyen");
  const advClients = clients.filter(c => c.pack === "avance");
  log(clients.length + " client(s) MP | " +
    stdClients.length + " standard | " +
    moyClients.length + " moyen | " +
    advClients.length + " avancé");

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
      log("\n[PACK MOYEN] Chargement popup detail (sans DAO)...");
      const moyNew   = allMPsListing.filter(mp => !vusIds.has(mp.id));
      const moyKnown = allMPsListing.filter(mp =>  vusIds.has(mp.id));
      log("  " + moyNew.length + " nouveaux | " + moyKnown.length + " connus");

      const moyNewDet = await loadDetails(browser, moyNew, "MP moyen nouveaux", true, { skipDAO: true });

      for (const client of moyClients) {
        const sentIds = await db.getMPSentIds(client.id);
        const isNew   = sentIds.size === 0 && vusIds.size > 0;
        if (isNew) {
          log("  [" + client.nom + "] NOUVEAU CLIENT MOYEN - scan initial...");
          const moyKnownDet = await loadDetails(browser, moyKnown, "scan initial moyen", true, { skipDAO: true });
          await matchClient(client, [...moyKnownDet, ...moyNewDet], "scan initial (moyen)", "mp");
        } else {
          await matchClient(client, moyNewDet, "nouveaux MP (moyen)", "mp");
        }
      }
      for (const mp of moyNewDet) {
        if (!allMarques.find(m => m.id === mp.id)) allMarques.push(mp);
      }
    }

    // ---- PACK AVANCE (popup HTML + DAO) ----
    if (advClients.length > 0 && allMPsListing && allMPsListing.length > 0) {
      log("\n[PACK AVANCE] Chargement popup detail + DAO...");
      const advNew   = allMPsListing.filter(mp => !vusIds.has(mp.id));
      const advKnown = allMPsListing.filter(mp =>  vusIds.has(mp.id));
      log("  " + advNew.length + " nouveaux | " + advKnown.length + " connus");

      const advNewDet = await loadDetails(browser, advNew, "MP avance nouveaux", true, { skipDAO: false });

      for (const client of advClients) {
        const sentIds = await db.getMPSentIds(client.id);
        const isNew   = sentIds.size === 0 && vusIds.size > 0;
        if (isNew) {
          log("  [" + client.nom + "] NOUVEAU CLIENT AVANCE - scan initial...");
          const advKnownDet = await loadDetails(browser, advKnown, "scan initial avance", true, { skipDAO: false });
          await matchClient(client, [...advKnownDet, ...advNewDet], "scan initial (avance)", "mp");
        } else {
          await matchClient(client, advNewDet, "nouveaux MP (avance)", "mp");
        }
      }
      for (const mp of advNewDet) {
        if (!allMarques.find(m => m.id === mp.id)) allMarques.push(mp);
      }
    }

    // Marquer tous les MPs vus (union de tous les packs)
    if (allMarques.length) {
      await db.markMPVus(allMarques);
      log(allMarques.length + " MP ajoutes a mps_vus");
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
// DEMARRAGE
// ============================================================
console.log("================================================");
console.log("  RADAR MARCHES PUBLICS - Bot v7.2");
console.log("  Packs : standard / moyen / avance");
console.log("  Cron  : toutes les 2h");
console.log("  Page size portail: 500 (optimise)");
console.log("================================================");

const missing = [];
if (!CFG.sbUrl) missing.push("SUPABASE_URL");
if (!CFG.sbKey) missing.push("SUPABASE_KEY");
if (missing.length) { console.error("Variables manquantes: " + missing.join(", ")); process.exit(1); }

log("Supabase: " + CFG.sbUrl);
log("Portail: " + (CFG.login || "(public)"));
log("Telegram: " + (CFG.tgToken ? "token OK" : "non configure"));

// Cron MP : toutes les 2h
cron.schedule("0 */2 * * *", runGlobalScanMP, { timezone: "Africa/Casablanca" });
log("Mode MP uniquement. Cron: toutes les 2h.");

// Scan MP au demarrage
runGlobalScanMP();
