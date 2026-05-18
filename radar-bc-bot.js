"use strict";

require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
const cron      = require("node-cron");
const fetch     = require("node-fetch");
let pdfParse;
try { pdfParse = require("pdf-parse"); } catch(e) { pdfParse = null; }

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
    .map((a, i) => "  " + (i + 1) + ". " + a.designation +
      (a.quantite ? " - " + a.quantite + " " + (a.unite || "") : ""))
    .join("\n");
  const more  = item.articles && item.articles.length > 10
    ? "\n  ... +" + (item.articles.length - 10) + " autres" : "";
  const icons = { region: "[region]", organisme: "[org]", titre: "[titre]", contenu: "[contenu]" };
  const tags  = matchedCriteres.map(c => icons[c.type] + " " + c.valeur).join(" | ");
  const header = radarType === "mp" ? "NOUVEAU MARCHE PUBLIC" : "NOUVEAU BC EN COURS";
  return [
    header, tags, "",
    "Ref: "    + (item.reference || item.id || "N/A"),
    "Org: "    + (item.organisme || "N/A"),
    "Objet: "  + (item.objet || "N/A"),
    "Lieu: "   + (item.wilaya || item.lieu || "N/A"),
    "Limite: " + (item.date_limite || "N/A"),
    "", radarType === "mp" ? "Lots:" : "Articles:",
    arts || "  Voir la fiche",
    more, "",
    "Lien: " + item.url, "",
    "Radar BC Maroc - Veille automatique",
  ].filter(l => l !== undefined).join("\n");
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

    // 2. Logger tous les inputs pour diagnostic
    const formInfo = await pg.evaluate(() => ({
      url:    window.location.href,
      title:  document.title,
      inputs: [...document.querySelectorAll("input,select,button,textarea")]
        .map(el => ({ tag: el.tagName, type: el.type||"", name: el.name||"", id: el.id||"", value: el.value ? "(val)" : "" }))
        .filter(el => el.name || el.id)
        .slice(0, 40),
      html: document.body.innerHTML.replace(/\s+/g," ").slice(0, 2000),
    }));
    log("  Formulaire URL: " + formInfo.url);
    log("  Formulaire inputs: " + JSON.stringify(formInfo.inputs));

    // 3. Soumettre le formulaire (recherche vide = tous les AO en cours)
    // Essayer plusieurs selecteurs pour le bouton Rechercher
    const submitSelectors = [
      "input[name*='echercher']", "input[name*='Rechercher']",
      "input[name*='recherche']", "input[name*='search']",
      "input[name*='Search']",   "input[name*='valider']",
      "input[name*='ok'][type='image']", "input[name*='OK'][type='image']",
      "input[type='submit']",    "button[type='submit']",
    ];
    let submitted = false;
    for (const sel of submitSelectors) {
      const btn = await pg.$(sel);
      if (btn) {
        log("  Soumission via: " + sel);
        await btn.click();
        try {
          await pg.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 });
          submitted = true;
        } catch(e) { log("  waitForNav: " + e.message.split("\n")[0]); submitted = true; }
        break;
      }
    }
    if (!submitted) log("  Aucun bouton submit trouve - on lit la page telle quelle");
    await delay(1000);

    // 4. Paginer et extraire les AOs
    let pageNum = 0;
    while (pageNum < 200) {
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
          seenIds.add(id);
          const row   = link.closest("tr,.avis-item,li,article,div.row,.consultation-row,.ao-item");
          const txt   = row ? row.innerText : link.innerText;
          const lines = txt.split("\n").map(l => l.trim()).filter(Boolean);
          const dates = [...txt.matchAll(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/g)].map(m => m[1]);
          const fullUrl = href.startsWith("http") ? href : base + (href.startsWith("/") ? href : "/" + href);
          items.push({
            id, reference: lines[0] || "",
            objet:       lines[1] || lines[0] || link.textContent.trim(),
            organisme:   lines[2] || "",
            date_limite: dates.length ? dates[dates.length - 1] : "",
            lieu:        lines.find(l => l.length > 5 && !l.match(/^\d{2}\//)) || "",
            wilaya:      "", url: fullUrl,
          });
        });
        const nextSel = "a.next,a[rel='next'],.pagination a:last-child:not(.disabled),.suivant:not(.disabled) a,a[id*='suivant'],a[id*='next'],li.next:not(.disabled) a,td.next a,a[title*='uivant'],a[title*='Next']";
        const nextEl  = document.querySelector(nextSel);
        return {
          items, hasNext: !!nextEl,
          nextText: nextEl ? (nextEl.textContent||"").trim().slice(0,20) : null,
          url:   window.location.href,
          title: document.title,
          html:  items.length === 0 ? document.body.innerHTML.replace(/\s+/g," ").slice(0, 1500) : "",
        };
      });

      log("  Page " + pageNum + ": " + result.items.length + " AO" +
        (result.nextText ? " | next: [" + result.nextText + "]" : " | fin"));
      if (pageNum <= 2 && result.items.length === 0) {
        log("  DEBUG url: " + result.url);
        log("  DEBUG html: " + (result.html||"").slice(0, 600));
      }

      for (const item of result.items) {
        if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
      }
      if (!result.hasNext || result.items.length === 0) break;

      try {
        const nextSel = "a.next,a[rel='next'],.pagination a:last-child:not(.disabled),.suivant:not(.disabled) a,a[id*='suivant'],a[id*='next'],li.next:not(.disabled) a,td.next a,a[title*='uivant'],a[title*='Next']";
        await pg.click(nextSel);
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
// SCRAPING FICHE DETAIL MP (HTML + PDF Bordereau/CPS)
// ============================================================
async function scrapeMPDetail(page, mp) {
  try {
    await page.goto(mp.url, { waitUntil: "domcontentloaded", timeout: 35000 });
    await delay(300 + Math.floor(Math.random() * 400));
    await page.evaluate(async () => {
      document.querySelectorAll(".accordion-toggle,.collapse-toggle,[data-toggle='collapse'],[data-bs-toggle='collapse'],.panel-heading a,.card-header button,button.accordion-button,summary").forEach(el => {
        try { el.click(); } catch(e) {}
      });
      document.querySelectorAll("details").forEach(d => { d.open = true; });
      await new Promise(r => setTimeout(r, 500));
    });

    // Extraire les infos HTML + les liens PDF
    const d = await page.evaluate(() => {
      const get = s => { const el = document.querySelector(s); return el ? el.innerText.trim() : ""; };
      // bodyText = texte complet pour scan profond + extraction date
      const mainElMP = document.querySelector("main,.main-content,#contenu,#main,.container,.content") || document.body;
      const bodyText = (mainElMP.innerText || document.body.innerText).replace(/\s+/g, " ").slice(0, 8000);
      let date_limite = "";
      const cm = bodyText.match(/(?:date\s*(?:limite|clot[uo]re|fin|d[eé]p[oô]t|remise|soumission)[^:]*:?\s*)(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/i);
      if (cm) date_limite = cm[1];
      else {
        const all = [...bodyText.matchAll(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/g)].map(m => m[1]);
        if (all.length) date_limite = all[all.length - 1];
      }

      // Articles HTML (lots eventuellement listes dans la page)
      const htmlArticles = [], seen = new Set();
      document.querySelectorAll("table").forEach(t => {
        t.querySelectorAll("tr").forEach((row, i) => {
          if (i === 0) return;
          const cells = row.querySelectorAll("td");
          if (!cells.length) return;
          const desig = (cells[0].innerText || "").trim();
          if (!desig || desig.length < 3 || seen.has(desig)) return;
          seen.add(desig);
          htmlArticles.push({
            designation:    desig,
            quantite:       cells.length >= 3 ? (cells[cells.length-2].innerText||"").trim() : "",
            unite:          cells.length >= 3 ? (cells[cells.length-1].innerText||"").trim() : "",
            specifications: cells.length >= 2 ? (cells[1].innerText||"").trim().slice(0,400) : "",
          });
        });
      });

      // Detecter les liens PDF : Bordereau > CPS > autres docs DAO
      const allLinks = [...document.querySelectorAll("a[href]")].map(a => ({
        href: a.href,
        text: (a.textContent || a.innerText || "").trim().toLowerCase(),
      }));
      const base = window.location.origin;
      const isPDF = l => l.href.match(/\.(pdf)$/i) || l.href.includes("/download") || l.href.includes("/document") || l.href.includes("/fichier");

      const bordereau = allLinks.filter(l => isPDF(l) && /bordereau|bp\b|prix\s*unit|prix\s*glo|bpu/i.test(l.text));
      const cps       = allLinks.filter(l => isPDF(l) && /\bcps\b|cahier.*prescri|speciif|specification/i.test(l.text));
      const dao       = allLinks.filter(l => isPDF(l) && /\bdao\b|dossier.*appel|reglement.*consul|\brc\b/i.test(l.text));
      const allDocs   = allLinks.filter(l => isPDF(l));

      // Priorite: Bordereau > CPS > DAO > premier PDF
      const pdfLinks = [
        ...(bordereau.length ? bordereau.slice(0,2) : []),
        ...(cps.length && bordereau.length === 0 ? cps.slice(0,1) : []),
        ...(dao.length && bordereau.length === 0 && cps.length === 0 ? dao.slice(0,1) : []),
        ...(allDocs.length && bordereau.length === 0 && cps.length === 0 ? allDocs.slice(0,2) : []),
      ];
      return {
        reference: get(".reference,#reference,.num-ao,.numero-ao,h2") || document.title.replace(/.*#/,"").trim(),
        objet:     get(".objet,#objet,h1,.panel-title,.intitule,.titre-ao"),
        organisme: get(".acheteur,.organisme,#acheteur,.maitre-ouvrage,.mo"),
        lieu:      get(".lieu,#lieu"),
        wilaya:    get("[class*='wilaya'],[class*='region'],[class*='prefect']"),
        budget:    get(".montant,.budget,.estimation,[class*='montant'],[class*='budget']"),
        procedure: get(".type-procedure,.procedure,.type-ao,[class*='procedure']"),
        date_limite,
        htmlArticles,
        pdfLinks: pdfLinks.map(l => l.href).slice(0, 4),
        bodyText,
      };
    });

    // Extraction PDF : Bordereau des Prix en priorite, CPS en fallback
    let pdfArticles = [];
    if (d.pdfLinks && d.pdfLinks.length > 0) {
      log("  MP " + mp.id + ": " + d.pdfLinks.length + " PDF(s) detecte(s) -> extraction...");
      for (const pdfUrl of d.pdfLinks) {
        const extracted = await extractPDFArticles(page, pdfUrl);
        if (extracted.length > 0) {
          log("  MP " + mp.id + ": " + extracted.length + " articles extraits du PDF");
          pdfArticles = extracted;
          break; // Prendre le premier PDF qui donne des resultats
        }
      }
    }

    // Fusionner: les articles PDF ont priorite sur HTML (plus complets)
    const articles = pdfArticles.length > 0 ? pdfArticles : d.htmlArticles;
    if (articles.length === 0) {
      log("  MP " + mp.id + ": aucun article extrait (PDF: " + (d.pdfLinks||[]).length + " liens, HTML: " + d.htmlArticles.length + ")");
    }

    const { htmlArticles, pdfLinks, ...rest } = d;
    return { ...mp, ...rest, articles };
  } catch (e) { log("  MP Detail " + mp.id + ": " + e.message); return mp; }
}

async function loadDetails(browser, items, label, isMP) {
  if (!items.length) return [];
  log("  Chargement " + items.length + " fiches " + label + " (3 en parallele)...");
  const result = []; const BATCH = 3;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const pages = await Promise.all(batch.map(() => newPage(browser)));
    const scrapeFunc = isMP ? scrapeMPDetail : scrapeBCDetail;
    const detailed = await Promise.all(batch.map((item, idx) => scrapeFunc(pages[idx], item).catch(() => item)));
    await Promise.all(pages.map(p => p.close().catch(() => {})));
    result.push(...detailed);
    if (i > 0 && i % 60 === 0) log("  " + i + "/" + items.length + " fiches chargees");
    await delay(isMP ? 400 : 200); // MP: delai supplementaire pour PDF
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
// ============================================================
let _scanningMP = false;

async function runGlobalScanMP() {
  if (_scanningMP) { log("Scan MP precedent en cours, skip."); return; }
  _scanningMP = true;
  const now = new Date().toLocaleString("fr-MA", { timeZone: "Africa/Casablanca" });
  log("\n" + "=".repeat(60));
  log("SCAN MARCHES PUBLICS - " + now);
  log("=".repeat(60));
  let clients = [];
  try {
    const raw = await db.getClients();
    clients = (raw || []).filter(c => (c.criteres || []).some(cr => cr.radar_type === "mp"));
  } catch (e) { log("Supabase MP: " + e.message); _scanningMP = false; return; }
  if (!clients.length) { log("Aucun client MP actif."); _scanningMP = false; return; }
  log(clients.length + " client(s) MP actif(s)");
  let browser;
  try {
    browser = await launchBrowser();
    let mpListUrl = CFG.mpListUrl;
    if (CFG.login && CFG.password) {
      const lp = await newPage(browser);
      const loggedIn = await loginPortal(lp, CFG.mpLoginUrl);
      if (loggedIn) {
        // Logger le contenu du dashboard pour trouver l'URL AO
        try {
          await delay(2000);
          const dashInfo = await lp.evaluate(() => ({
            url: window.location.href,
            title: document.title,
            links: [...document.querySelectorAll("a[href]")]
              .map(a => ({ text: (a.textContent||"").trim().slice(0,40), href: a.getAttribute("href")||"" }))
              .filter(l => l.href && l.href.length > 2 && !l.href.startsWith("#"))
              .slice(0, 30),
            bodySnippet: (document.body ? document.body.innerText : "").slice(0, 500),
          }));
          log("  Dashboard URL: " + dashInfo.url);
          log("  Dashboard title: " + dashInfo.title);
          log("  Dashboard liens: " + JSON.stringify(dashInfo.links));
          log("  Dashboard texte: " + dashInfo.bodySnippet.replace(/\n/g," ").slice(0,200));
        } catch(e) { log("  Erreur dashboard: " + e.message); }
      }
      await lp.close().catch(() => {});
    }
    const allMPs = await scrapeAllMPs(browser);
    if (!allMPs.length) { log("Aucun MP recupere."); return; }
    const vusIds   = await db.getMPVusIds();
    const newMPs   = allMPs.filter(mp => !vusIds.has(mp.id));
    log(newMPs.length + " nouveaux MP | " + (allMPs.length - newMPs.length) + " deja connus");
    const newDetailed = await loadDetails(browser, newMPs, "MP nouveaux", true);
    log("\nMatching clients MP...");
    for (const client of clients) {
      const sentIds    = await db.getMPSentIds(client.id);
      const isNewClient = sentIds.size === 0 && vusIds.size > 0;
      if (isNewClient) {
        log("  [" + client.nom + "] NOUVEAU CLIENT MP - scan initial...");
        const historical = await db.getMPVusMPData();
        await matchClient(client, [...historical, ...newDetailed], "scan initial", "mp");
      } else {
        await matchClient(client, newDetailed, "nouveaux MP", "mp");
      }
    }
    if (newDetailed.length) {
      await db.markMPVus(newDetailed);
      log(newDetailed.length + " MP ajoutes a mps_vus");
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
console.log("  RADAR BC + MARCHES PUBLICS - Bot v6.17");
console.log("  Scan BC  : toutes les 2h (a l'heure pile)");
console.log("  Scan MP  : heures impaires (1h,3h,5h,...)");
console.log("  contenu  : scan profond bodyText + articles");
console.log("  Frontiere de mot : eau != carreaux");
console.log("================================================");

const missing = [];
if (!CFG.sbUrl) missing.push("SUPABASE_URL");
if (!CFG.sbKey) missing.push("SUPABASE_KEY");
if (missing.length) { console.error("Variables manquantes: " + missing.join(", ")); process.exit(1); }

log("Supabase: " + CFG.sbUrl);
log("Portail: " + (CFG.login || "(public)"));
log("Telegram: " + (CFG.tgToken ? "token OK" : "non configure"));

// Cron BC : toutes les 2h a l'heure pile  (00:00, 02:00, 04:00, ...)
cron.schedule("0 */2 * * *", runGlobalScanBC, { timezone: "Africa/Casablanca" });
// Cron MP : toutes les 2h a la demi-heure (00:30, 02:30, 04:30, ...)
cron.schedule("0 1,3,5,7,9,11,13,15,17,19,21,23 * * *", runGlobalScanMP, { timezone: "Africa/Casablanca" });
log("Crons: BC heures paires (0h,2h,...), MP heures impaires (1h,3h,...). Jamais en meme temps.");

// Lancer les deux scans au demarrage
// TEST: BC desactive au boot pour tester MP seul
// runGlobalScanBC();
setTimeout(runGlobalScanMP, 5000); // TEST: MP seul, 5s apres boot
