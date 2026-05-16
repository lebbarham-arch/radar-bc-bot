"use strict";
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║   RADAR BC — Bot Puppeteer v4.0 (Production)                   ║
 * ║   marchespublics.gov.ma — Scan exhaustif + profond             ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  Ce bot :                                                       ║
 * ║  1. Se connecte avec votre compte fournisseur                  ║
 * ║  2. Parcourt TOUTES les pages de la liste des BC en cours      ║
 * ║  3. Ouvre chaque fiche et clique sur les accordéons JS         ║
 * ║  4. Lit tous les articles même absents du titre                ║
 * ║  5. Cherche les mots-clés dans tout le contenu                 ║
 * ║  6. Envoie chaque nouveau BC sur WhatsApp du client            ║
 * ║  7. Anti-doublons via Supabase                                 ║
 * ║  8. Tourne toutes les heures via cron                          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

require("dotenv").config();
const puppeteer = require("puppeteer-extra");
const Stealth   = require("puppeteer-extra-plugin-stealth");
const cron      = require("node-cron");
const fetch     = require("node-fetch");

puppeteer.use(Stealth());

// ── Configuration ────────────────────────────────────────────────
const CFG = {
  sbUrl:    process.env.SUPABASE_URL     || "",
  sbKey:    process.env.SUPABASE_KEY     || "",
  login:    process.env.PORTAL_LOGIN     || "",
  password: process.env.PORTAL_PASSWORD  || "",
  listUrl:  "https://www.marchespublics.gov.ma/bdc/entreprise/consultation/",
  loginUrl: "https://www.marchespublics.gov.ma/bdc/entreprise/login",
};

const delay     = ms     => new Promise(r => setTimeout(r, ms));
const randDelay = (a, b) => delay(Math.floor(Math.random() * (b - a)) + a);
const log       = (msg)  => console.log(`[${new Date().toLocaleTimeString("fr-MA")}] ${msg}`);

// ── Normalisation (insensible aux accents) ───────────────────────
function norm(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function hasKw(text, kw) { return norm(text).includes(norm(kw)); }

// Vérifie si un BC satisfait les critères du client (logique OU)
function bcMatchesCriteres(bc, criteres) {
  return criteres.some(c => {
    switch (c.type) {
      case "region":    return hasKw(bc.wilaya, c.valeur) || hasKw(bc.lieu, c.valeur);
      case "organisme": return hasKw(bc.organisme, c.valeur);
      case "titre":     return hasKw(bc.objet, c.valeur);
      case "contenu":
        return hasKw(bc.objet, c.valeur) ||
               hasKw(bc.description, c.valeur) ||
               (bc.articles || []).some(a =>
                 hasKw(a.designation, c.valeur) || hasKw(a.specifications, c.valeur)
               );
      default: return false;
    }
  });
}

function getMatchedCriteres(bc, criteres) {
  return criteres.filter(c => {
    switch (c.type) {
      case "region":    return hasKw(bc.wilaya, c.valeur) || hasKw(bc.lieu, c.valeur);
      case "organisme": return hasKw(bc.organisme, c.valeur);
      case "titre":     return hasKw(bc.objet, c.valeur);
      case "contenu":
        return hasKw(bc.objet, c.valeur) || hasKw(bc.description, c.valeur) ||
               (bc.articles || []).some(a => hasKw(a.designation, c.valeur) || hasKw(a.specifications, c.valeur));
      default: return false;
    }
  });
}

function isEnCours(bc) {
  if (norm(bc.objet || "").includes("annul")) return false;
  if (bc.date_limite) {
    const m = bc.date_limite.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) {
      const d = new Date(`${m[3]}-${m[2]}-${m[1]}`);
      if (d < new Date()) return false;
    }
  }
  return true;
}

// ── Supabase ─────────────────────────────────────────────────────
async function sbReq(path, opts = {}) {
  const r = await fetch(`${CFG.sbUrl}/rest/v1/${path}`, {
    headers: {
      "Content-Type":  "application/json",
      "apikey":        CFG.sbKey,
      "Authorization": `Bearer ${CFG.sbKey}`,
      "Prefer":        opts.prefer || "return=representation",
      ...opts.headers,
    },
    ...opts,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || d.error || JSON.stringify(d));
  return d;
}

const db = {
  getClients:   () => sbReq("clients?actif=eq.true&select=*,criteres(*)"),
  getSentIds:   id => sbReq(`bcs_envoyes?client_id=eq.${id}&select=bc_id`)
                        .then(r => new Set((r || []).map(x => x.bc_id))),
  markSent: (cid, bcId, ct, cv, data) =>
    sbReq("bcs_envoyes", {
      method: "POST", prefer: "return=minimal",
      body: JSON.stringify({ client_id: cid, bc_id: bcId, critere_type: ct, critere_valeur: cv, bc_data: data }),
    }).catch(() => {}),
  writeLog: (cid, ana, found, sent) =>
    sbReq("scan_logs", {
      method: "POST", prefer: "return=minimal",
      body: JSON.stringify({ client_id: cid, nb_analyses: ana, nb_trouves: found, nb_nouveaux: sent }),
    }).catch(() => {}),
};

// ── Telegram ──────────────────────────────────────────────────────
async function sendTelegram(client, msg) {
  const token  = client.tg_token;
  const chatId = client.tg_chat_id;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "HTML" }),
    });
    log(`  📨 Telegram → ${chatId}`);
  } catch (e) {
    log(`  ⚠️  Telegram erreur: ${e.message}`);
  }
}

// ── WhatsApp ─────────────────────────────────────────────────────
async function sendWhatsApp(client, msg) {
  const num = (client.phone || "").replace(/\D/g, "");
  if (!num) return;
  try {
    if (client.wa_provider === "callmebot") {
      await fetch(`https://api.callmebot.com/whatsapp.php?phone=${num}&text=${encodeURIComponent(msg)}&apikey=${client.wa_apikey}`);
    } else if (client.wa_provider === "twilio") {
      const b64 = Buffer.from(`${client.wa_account_sid}:${client.wa_auth_token}`).toString("base64");
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${client.wa_account_sid}/Messages.json`, {
        method: "POST",
        headers: { Authorization: `Basic ${b64}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          From: `whatsapp:+${(client.wa_from_number || "").replace(/\D/g, "")}`,
          To:   `whatsapp:+${num}`, Body: msg,
        }),
      });
    } else if (client.wa_provider === "meta") {
      await fetch(`https://graph.facebook.com/v19.0/${client.wa_phone_id}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${client.wa_access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: num, type: "text", text: { body: msg } }),
      });
    }
    log(`  📱 WhatsApp → +${num}`);
  } catch (e) {
    log(`  ⚠️  WhatsApp erreur: ${e.message}`);
  }
}

function buildMessage(bc, matchedCriteres) {
  const arts = (bc.articles || []).slice(0, 10)
    .map((a, i) => `  ${i + 1}. ${a.designation}${a.quantite ? ` — ${a.quantite} ${a.unite || ""}` : ""}`)
    .join("\n");
  const more  = bc.articles?.length > 10 ? `\n  … +${bc.articles.length - 10} autres` : "";
  const icons = { region:"🗺️", organisme:"🏢", titre:"🔤", contenu:"🔍" };
  const tags  = matchedCriteres.map(c => `${icons[c.type]} ${c.valeur}`).join(" · ");

  return [
    `🚨 *NOUVEAU BC EN COURS*`,
    tags,
    ``,
    `📋 *${bc.reference || bc.id || "N/A"}*`,
    `🏢 ${bc.organisme || "N/A"}`,
    `📝 ${bc.objet || "N/A"}`,
    `📍 ${bc.wilaya || bc.lieu || "N/A"}`,
    `⏱️  Limite: ${bc.date_limite || "N/A"}`,
    ``,
    `📦 *Articles:*`,
    arts || "  Voir la fiche",
    more,
    ``,
    `🔗 ${bc.url}`,
    ``,
    `_Radar BC Maroc — Veille automatique_`,
  ].filter(l => l !== undefined).join("\n");
}

// ── Puppeteer setup ──────────────────────────────────────────────
async function launchBrowser() {
  return puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-gpu",
      "--window-size=1440,900",
    ],
  });
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "fr-FR,fr;q=0.9,ar;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
  return page;
}

// ── Connexion au portail ─────────────────────────────────────────
async function login(page) {
  log("🔐 Connexion au portail...");
  try {
    await page.goto(CFG.loginUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randDelay(1000, 2000);

    // Remplit login
    const loginSels = ["#login","#username","input[name='login']","input[name='username']","input[type='text']"];
    const passSels  = ["#password","input[name='password']","input[type='password']"];

    let loginField = null;
    for (const s of loginSels) { loginField = await page.$(s); if (loginField) break; }
    let passField  = null;
    for (const s of passSels)  { passField  = await page.$(s); if (passField)  break; }

    if (!loginField || !passField) {
      log("❌ Formulaire login non trouvé");
      return false;
    }

    await loginField.click({ clickCount: 3 });
    await loginField.type(CFG.login, { delay: 70 });
    await randDelay(300, 600);
    await passField.click({ clickCount: 3 });
    await passField.type(CFG.password, { delay: 70 });
    await randDelay(300, 600);

    const submitBtn = await page.$("button[type='submit'], input[type='submit'], form button:last-of-type");
    if (submitBtn) await submitBtn.click();
    else           await passField.press("Enter");

    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 });
    await randDelay(1000, 2000);

    const url  = page.url();
    const text = await page.evaluate(() => document.body.innerText.toLowerCase());
    const ok   = !url.includes("login") &&
                 !text.includes("mot de passe incorrect") &&
                 !text.includes("identifiant invalide");

    if (ok) { log("✅ Connecté !"); return true; }
    log("❌ Échec connexion — vérifiez PORTAL_LOGIN / PORTAL_PASSWORD");
    return false;
  } catch (e) {
    log(`❌ Erreur login: ${e.message}`);
    return false;
  }
}

// ── Scraping liste exhaustive des BC en cours ────────────────────
// Parcourt TOUTES les pages — pas juste ce que Google a indexé
async function scrapeAllBCs(page) {
  const allBCs  = [];
  let   pageNum = 1;

  log("  📋 Chargement de TOUTES les pages de BC en cours...");

  while (true) {
    const url = pageNum === 1
      ? CFG.listUrl
      : `${CFG.listUrl}?page=${pageNum}`;

    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await randDelay(800, 2000);

      // Scroll humain
      await page.evaluate(() => window.scrollBy(0, 300));
      await randDelay(200, 500);

      const { bcs, hasNext } = await page.evaluate(() => {
        const items = [];
        const seen  = new Set();

        // Récupère tous les liens vers des fiches show/{ID}
        document.querySelectorAll("a[href*='/show/']").forEach(link => {
          const href    = link.getAttribute("href") || "";
          const idMatch = href.match(/\/show\/(\d+)/);
          if (!idMatch) return;
          const id = idMatch[1];
          if (seen.has(id)) return;
          seen.add(id);

          // Remonte au conteneur parent
          const row   = link.closest("tr, .avis-item, li, article, div.row, .consultation-row");
          const txt   = row ? row.innerText : link.innerText;
          const lines = txt.split("\n").map(l => l.trim()).filter(Boolean);

          // Cherche la date limite dans le texte
          const dateMatch = txt.match(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/);

          items.push({
            id,
            reference:   lines[0] || "",
            objet:       lines[1] || lines[0] || link.textContent.trim(),
            organisme:   lines[2] || "",
            date_limite: dateMatch ? dateMatch[1] : "",
            lieu:        lines.find(l => l.length > 5 && !l.match(/^\d{2}\/\d{2}/)) || "",
            wilaya:      "",
            url: href.startsWith("http") ? href
               : `https://www.marchespublics.gov.ma${href.startsWith("/") ? href : "/bdc/entreprise/consultation/show/" + id}`,
          });
        });

        // Vérifie si page suivante existe
        const nextEl = document.querySelector(
          "a.next, a[rel='next'], .pagination li:last-child:not(.disabled) a, li.next:not(.disabled) a"
        );

        return { bcs: items, hasNext: !!nextEl && items.length > 0 };
      });

      if (bcs.length === 0) { log(`  → Page ${pageNum} vide, fin.`); break; }

      allBCs.push(...bcs);
      log(`  → Page ${pageNum}: ${bcs.length} BC (total: ${allBCs.length})`);

      if (!hasNext || pageNum >= 500) break; // max 500 pages de sécurité
      pageNum++;
      await randDelay(1000, 2500);

    } catch (e) {
      log(`  ⚠️  Page ${pageNum}: ${e.message}`);
      break;
    }
  }

  log(`  ✅ ${allBCs.length} BC en cours récupérés (${pageNum} page(s))`);
  return allBCs;
}

// ── Scraping détail complet d'une fiche BC ───────────────────────
// Clique sur les accordéons JS pour révéler les articles
async function scrapeBCDetail(page, bc) {
  try {
    await page.goto(bc.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await randDelay(600, 1500);

    // ── Clique sur TOUS les accordéons pour révéler les articles ──
    // Structure du portail : boutons/divs avec chevron ▼ qui affichent les specs
    await page.evaluate(async () => {
      // Sélecteurs d'accordéons typiques du portail
      const accordions = document.querySelectorAll(
        ".accordion-toggle, .collapse-toggle, [data-toggle='collapse'], " +
        "[data-bs-toggle='collapse'], .panel-heading a, .card-header button, " +
        "button.accordion-button, details, summary, " +
        "[class*='accordion'] button, [class*='collapse'] .header"
      );

      // Clique sur chaque accordéon fermé
      for (const el of accordions) {
        try {
          const isCollapsed = el.classList.contains("collapsed") ||
                              el.getAttribute("aria-expanded") === "false" ||
                              el.closest("details")?.open === false;
          if (isCollapsed || accordions.length <= 20) {
            el.click();
            await new Promise(r => setTimeout(r, 150));
          }
        } catch {}
      }

      // Déplie aussi les <details> natifs
      document.querySelectorAll("details").forEach(d => { d.open = true; });

      // Attend le rendu
      await new Promise(r => setTimeout(r, 500));
    });

    await randDelay(400, 800);

    // ── Extrait tout le contenu après dépliage ────────────────────
    const detail = await page.evaluate(() => {
      const get = sel => document.querySelector(sel)?.innerText?.trim() || "";

      const reference = get(".reference") || get("#reference") ||
                        get("h2") || get(".consultation-title") ||
                        document.title.replace(/.*#/, "").trim();

      const objet     = get(".objet") || get("#objet") ||
                        get("h1") || get(".panel-title");

      const organisme = get(".acheteur") || get(".organisme") || get("#acheteur") ||
                        get("[class*='acheteur']");

      const lieu      = get(".lieu") || get("#lieu") || get("[class*='lieu']");

      // Date limite
      const bodyText   = document.body.innerText;
      const dateMatch  = bodyText.match(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/);
      const date_limite = dateMatch ? dateMatch[1] : "";

      // Wilaya depuis le lieu
      const wilaya = get("[class*='wilaya']") || get("[class*='region']") || "";

      // ── Articles — 3 méthodes complémentaires ─────────────────
      const articles = [];
      const seenDesig = new Set();

      // Méthode 1 : Tableaux
      document.querySelectorAll("table").forEach(table => {
        table.querySelectorAll("tr").forEach((row, i) => {
          if (i === 0) return;
          const cells = row.querySelectorAll("td");
          if (cells.length < 1) return;
          const desig = cells[0]?.innerText?.trim();
          if (!desig || desig.length < 3) return;
          if (/^(désignation|article|n°|#|qté|unité|montant|libellé)/i.test(desig)) return;
          if (seenDesig.has(desig)) return;
          seenDesig.add(desig);
          articles.push({
            designation:    desig,
            quantite:       cells.length >= 3 ? (cells[cells.length - 2]?.innerText?.trim() || "") : "",
            unite:          cells.length >= 3 ? (cells[cells.length - 1]?.innerText?.trim() || "") : "",
            specifications: cells.length >= 2 ? (cells[1]?.innerText?.trim().slice(0, 500) || "") : "",
          });
        });
      });

      // Méthode 2 : Blocs accordéon dépliés (h4/h5 + contenu suivant)
      document.querySelectorAll("h4, h5, .article-title, .lot-title, [class*='article-header']").forEach(h => {
        const desig = h.innerText?.trim();
        if (!desig || desig.length < 3) return;
        if (/^(objet|acheteur|organisme|référence|date|lieu|catégorie)/i.test(desig)) return;
        if (seenDesig.has(desig)) return;
        seenDesig.add(desig);

        // Collecte les specs dans les éléments suivants
        let specs = "";
        let next  = h.nextElementSibling;
        let count = 0;
        while (next && !["H3","H4","H5"].includes(next.tagName) && count < 5) {
          specs += next.innerText?.trim() + " ";
          next   = next.nextElementSibling;
          count++;
        }
        articles.push({ designation: desig, specifications: specs.trim().slice(0, 600), quantite: "", unite: "" });
      });

      // Méthode 3 : Listes si rien trouvé
      if (articles.length === 0) {
        document.querySelectorAll("ul.articles li, ol.articles li, .article-list li").forEach(li => {
          const txt = li.innerText?.trim();
          if (txt && txt.length > 3 && !seenDesig.has(txt)) {
            seenDesig.add(txt);
            articles.push({ designation: txt, quantite: "", unite: "", specifications: "" });
          }
        });
      }

      // Texte complet (pour scan fallback)
      const mainEl     = document.querySelector("main, .content, .consultation-detail, article") || document.body;
      const description = mainEl.innerText.slice(0, 10000);

      return { reference, objet, organisme, lieu, wilaya, date_limite, articles, description };
    });

    return { ...bc, ...detail };

  } catch (e) {
    log(`    ⚠️  Détail BC ${bc.id}: ${e.message}`);
    return bc;
  }
}

// ── Scan pour un client ──────────────────────────────────────────
async function scanClient(page, client, allBCs) {
  const criteres = (client.criteres || []).map(c => ({ type: c.type, valeur: c.valeur }));
  if (!criteres.length) return;

  log(`\n  👤 ${client.nom} | Critères: [${criteres.map(c=>`${c.type}:${c.valeur}`).join(", ")}]`);

  const sentIds = await db.getSentIds(client.id);
  let analyzed = 0, found = 0, sent = 0;

  for (let i = 0; i < allBCs.length; i++) {
    const bcShort = allBCs[i];

    // Pré-filtre rapide sur ce qu'on a déjà (titre, organisme, lieu)
    if (!isEnCours(bcShort)) continue;

    // Pré-match rapide : si aucun critère ne peut matcher sur les données de surface
    // ET ce n'est pas un critère "contenu" → skip pour économiser des requêtes
    const hasSurface = criteres.some(c =>
      c.type === "region"    ? hasKw(bcShort.lieu, c.valeur) || hasKw(bcShort.wilaya, c.valeur) :
      c.type === "organisme" ? hasKw(bcShort.organisme, c.valeur) :
      c.type === "titre"     ? hasKw(bcShort.objet, c.valeur) :
      false
    );
    const hasContenu = criteres.some(c => c.type === "contenu");

    // Si pas de match surface ET pas de critère contenu → skip
    if (!hasSurface && !hasContenu) continue;

    analyzed++;
    log(`    [${i + 1}/${allBCs.length}] BC ${bcShort.id}: ${(bcShort.objet || "").slice(0, 55)}…`);

    // Charge le détail complet (accordéons JS dépliés)
    const bc = await scrapeBCDetail(page, bcShort);
    await randDelay(500, 1500);

    if (!isEnCours(bc)) { log(`      ↷ Clôturé`); continue; }

    // Vérifie les critères sur le contenu complet
    if (!bcMatchesCriteres(bc, criteres)) continue;

    found++;
    const bcId = bc.id;

    if (sentIds.has(bcId)) { log(`      ↺ Déjà envoyé`); continue; }

    // Nouveau BC → envoie WhatsApp
    const matched = getMatchedCriteres(bc, criteres);
    log(`      ✅ MATCH [${matched.map(c=>c.valeur).join(", ")}] → Notification`);
    sentIds.add(bcId);
    sent++;

    const msg = buildMessage(bc, matched);
    await sendWhatsApp(client, msg);
    await sendTelegram(client, msg);
    await db.markSent(client.id, bcId, matched[0]?.type || "", matched[0]?.valeur || "", bc);
    await delay(2000);
  }

  await db.writeLog(client.id, analyzed, found, sent);
  log(`    📊 Analysés: ${analyzed} | Correspondances: ${found} | Envoyés: ${sent}`);
}

// ── Scan global ──────────────────────────────────────────────────
async function runGlobalScan() {
  const now = new Date().toLocaleString("fr-MA", { timeZone: "Africa/Casablanca" });
  log(`\n${"═".repeat(60)}`);
  log(`🔍 SCAN GLOBAL — ${now}`);
  log(`${"═".repeat(60)}`);

  // Récupère les clients actifs
  let clients = [];
  try {
    const raw = await db.getClients();
    clients   = (raw || []).filter(c => c.criteres?.length > 0);
  } catch (e) {
    log(`❌ Supabase: ${e.message}`); return;
  }

  if (!clients.length) { log("Aucun client actif avec critères."); return; }
  log(`👥 ${clients.length} client(s) à scanner`);

  let browser;
  try {
    browser = await launchBrowser();
    const page = await newPage(browser);

    // ── Connexion unique au portail ───────────────────────────────
    if (CFG.login && CFG.password) {
      const loggedIn = await login(page);
      if (!loggedIn) {
        log("⚠️  Scan sans authentification (données publiques uniquement)");
      }
    } else {
      log("ℹ️  Pas de credentials portail — scan public uniquement");
    }

    // ── Récupère UNE SEULE FOIS toute la liste des BC en cours ────
    // Partagée entre tous les clients pour éviter de recharger toutes les pages
    log("\n📋 Chargement exhaustif de la liste des BC en cours...");
    const allBCs = await scrapeAllBCs(page);

    if (!allBCs.length) {
      log("⚠️  Aucun BC récupéré depuis le portail."); return;
    }

    // ── Scanne chaque client sur la même liste ────────────────────
    for (const client of clients) {
      await scanClient(page, client, allBCs);
      await randDelay(2000, 4000);
    }

    await page.close();

  } catch (e) {
    log(`❌ Erreur Puppeteer: ${e.message}`);
    if (e.stack) log(e.stack.split("\n").slice(0, 3).join("\n"));
  } finally {
    if (browser) await browser.close();
    log("\n✅ Scan global terminé.");
  }
}

// ── Validation au démarrage ──────────────────────────────────────
console.log(`
╔══════════════════════════════════════════════════════════════╗
║   RADAR BC — Bot Puppeteer v4.0 (Production)               ║
║                                                              ║
║   ✓ Scan exhaustif : TOUTES les pages du portail           ║
║   ✓ Accordéons JS dépliés : tous les articles lus          ║
║   ✓ 4 critères : région / organisme / titre / contenu      ║
║   ✓ Logique OU : 1 critère suffit pour alerter             ║
║   ✓ Anti-doublons Supabase                                  ║
║   ✓ WhatsApp : CallMeBot / Twilio / Meta                   ║
║   ✓ Cron : toutes les heures (Africa/Casablanca)           ║
╚══════════════════════════════════════════════════════════════╝
`);

const missing = [];
if (!CFG.sbUrl)  missing.push("SUPABASE_URL");
if (!CFG.sbKey)  missing.push("SUPABASE_KEY");
if (missing.length) {
  console.error("❌ Variables manquantes dans .env :");
  missing.forEach(v => console.error(`   ${v}=...`));
  process.exit(1);
}

if (!CFG.login || !CFG.password) {
  log("⚠️  PORTAL_LOGIN / PORTAL_PASSWORD non définis — scan public uniquement");
} else {
  log(`✓ Portail: ${CFG.login}`);
}
log(`✓ Supabase: ${CFG.sbUrl}`);

// Scan immédiat au démarrage puis toutes les heures
runGlobalScan();
cron.schedule("0 * * * *", runGlobalScan, { timezone: "Africa/Casablanca" });
log("⏰ Cron actif — scan toutes les heures (Africa/Casablanca)\n");
