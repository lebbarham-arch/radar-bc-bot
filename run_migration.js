/**
 * run_migration.js
 * Execute migration_packs.sql + migration_v9.sql via Supabase
 * Usage: node run_migration.js
 */
require("dotenv").config();
const fetch = require("node-fetch");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY; // service_role key

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("ERREUR: SUPABASE_URL ou SUPABASE_KEY manquant dans .env");
  process.exit(1);
}

// ─────────────────────────────────────────────
// Toutes les instructions SQL à exécuter
// ─────────────────────────────────────────────
const STATEMENTS = [

  // ── MIGRATION PACKS ──────────────────────────────────────────
  `ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_pack_check`,
  `ALTER TABLE clients ALTER COLUMN pack SET DEFAULT 'starter'`,
  `ALTER TABLE clients ADD CONSTRAINT clients_pack_check
     CHECK (pack IN ('starter', 'pro', 'business'))`,
  `UPDATE clients SET pack = 'starter'  WHERE pack = 'standard'`,
  `UPDATE clients SET pack = 'pro'      WHERE pack = 'moyen'`,
  `UPDATE clients SET pack = 'business' WHERE pack = 'avance'`,
  `ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_notif    TEXT`,
  `ALTER TABLE clients ADD COLUMN IF NOT EXISTS trial_ends_at  TIMESTAMPTZ`,
  `ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscribed_at  TIMESTAMPTZ`,
  `ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_cycle  TEXT DEFAULT 'monthly'
     CHECK (billing_cycle IN ('monthly', 'annual'))`,
  `CREATE INDEX IF NOT EXISTS idx_clients_pack ON clients (pack)`,

  // ── VUE STATS ─────────────────────────────────────────────────
  `CREATE OR REPLACE VIEW v_clients_stats AS
   SELECT
     c.id, c.nom, c.pack, c.email_notif,
     c.tg_chat_id IS NOT NULL AS has_telegram,
     c.phone IS NOT NULL      AS has_whatsapp,
     c.trial_ends_at, c.subscribed_at, c.billing_cycle,
     COUNT(DISTINCT cr.id)  AS nb_criteres,
     COUNT(DISTINCT be.id)  AS nb_alertes_total,
     MAX(be.created_at)     AS derniere_alerte,
     SUM(CASE WHEN be.created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END) AS alertes_30j
   FROM clients c
   LEFT JOIN criteres    cr ON cr.client_id = c.id
   LEFT JOIN bcs_envoyes be ON be.client_id = c.id
   GROUP BY c.id, c.nom, c.pack, c.email_notif,
            c.tg_chat_id, c.phone,
            c.trial_ends_at, c.subscribed_at, c.billing_cycle`,

  // ── PACK CONFIG ───────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS pack_config (
     pack          TEXT PRIMARY KEY,
     label         TEXT NOT NULL,
     prix_mensuel  INTEGER NOT NULL,
     prix_annuel   INTEGER NOT NULL,
     max_criteres  INTEGER NOT NULL,
     has_ia        BOOLEAN DEFAULT true,
     has_mp        BOOLEAN NOT NULL,
     has_email     BOOLEAN NOT NULL,
     has_whatsapp  BOOLEAN NOT NULL,
     has_dao       BOOLEAN DEFAULT false
   )`,

  `INSERT INTO pack_config VALUES
     ('starter',  'Starter',   99,  75,  5,  true, false, true, false, false),
     ('pro',      'Pro',       249, 190, 20,  true, false, true, true,  false),
     ('business', 'Business',  599, 449, 50,  true, false, true, true,  false)
   ON CONFLICT (pack) DO UPDATE SET
     prix_mensuel = EXCLUDED.prix_mensuel,
     prix_annuel  = EXCLUDED.prix_annuel,
     max_criteres = EXCLUDED.max_criteres,
     has_mp       = EXCLUDED.has_mp,
     has_email    = EXCLUDED.has_email,
     has_whatsapp = EXCLUDED.has_whatsapp,
     has_dao      = EXCLUDED.has_dao`,

  // ── MIGRATION V9 ─────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ai_cache (
     cache_key   TEXT PRIMARY KEY,
     valeur      TEXT NOT NULL,
     inclusions  JSONB DEFAULT '[]',
     exclusions  JSONB DEFAULT '[]',
     updated_at  TIMESTAMPTZ DEFAULT NOW()
   )`,

  `CREATE TABLE IF NOT EXISTS scan_logs (
     id           BIGSERIAL PRIMARY KEY,
     radar_type   TEXT NOT NULL,
     status       TEXT NOT NULL,
     started_at   TIMESTAMPTZ DEFAULT NOW(),
     duration_s   INTEGER,
     items_found  INTEGER DEFAULT 0,
     items_new    INTEGER DEFAULT 0,
     notifs_sent  INTEGER DEFAULT 0,
     error_msg    TEXT
   )`,

  `ALTER TABLE bcs_envoyes ADD COLUMN IF NOT EXISTS item_url   TEXT`,
  `ALTER TABLE bcs_envoyes ADD COLUMN IF NOT EXISTS item_titre TEXT`,
  `ALTER TABLE bcs_envoyes ADD COLUMN IF NOT EXISTS item_date  TEXT`,
  `ALTER TABLE bcs_envoyes ADD COLUMN IF NOT EXISTS notif_msg  TEXT`,
];

// ─────────────────────────────────────────────
// Exécution via Supabase Management SQL API
// ─────────────────────────────────────────────
async function runSQL(sql) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({ query: sql }),
  });

  // Fallback: essaie l'endpoint de query direct
  if (res.status === 404) {
    const res2 = await fetch(
      `https://api.supabase.com/v1/projects/xuqxoersxhtyvrslbxzl/database/query`,
      {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({ query: sql }),
      }
    );
    const body2 = await res2.text();
    return { status: res2.status, body: body2 };
  }

  const body = await res.text();
  return { status: res.status, body };
}

async function main() {
  console.log("=".repeat(55));
  console.log("  MIGRATION RADAR BC — Supabase");
  console.log("=".repeat(55));
  console.log(`  Projet : xuqxoersxhtyvrslbxzl`);
  console.log(`  URL    : ${SUPABASE_URL}`);
  console.log();

  let ok = 0, fail = 0;

  for (let i = 0; i < STATEMENTS.length; i++) {
    const sql   = STATEMENTS[i].trim();
    const label = sql.slice(0, 60).replace(/\n/g, " ") + "...";
    process.stdout.write(`[${i+1}/${STATEMENTS.length}] ${label}\n`);

    try {
      const { status, body } = await runSQL(sql);
      if (status >= 200 && status < 300) {
        console.log(`  ✓ OK (${status})`);
        ok++;
      } else {
        // "already exists" errors are acceptable
        const txt = body.toLowerCase();
        const harmless = txt.includes("already exists") || txt.includes("does not exist")
                      || txt.includes("duplicate") || txt.includes("42p07");
        if (harmless) {
          console.log(`  ~ OK (ignoré: ${body.slice(0,80)})`);
          ok++;
        } else {
          console.log(`  ✗ ECHEC (${status}): ${body.slice(0,120)}`);
          fail++;
        }
      }
    } catch (e) {
      console.log(`  ✗ ERREUR: ${e.message}`);
      fail++;
    }
  }

  console.log();
  console.log("=".repeat(55));
  console.log(`  Résultat: ${ok} OK  |  ${fail} échec(s)`);

  if (fail > 0) {
    console.log();
    console.log("  Les instructions en échec doivent être exécutées");
    console.log("  manuellement dans le SQL Editor Supabase :");
    console.log("  https://supabase.com/dashboard/project/xuqxoersxhtyvrslbxzl/sql");
  }
  console.log("=".repeat(55));
}

main().catch(e => { console.error("Erreur fatale:", e.message); process.exit(1); });
