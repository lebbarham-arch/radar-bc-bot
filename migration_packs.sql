-- ============================================================
-- RADAR MARCHES PUBLICS — Migration packs commerciaux
-- starter (99 MAD) / pro (249 MAD) / business (599 MAD)
-- Exécuter dans Supabase SQL Editor
-- ============================================================

-- 1. Mettre à jour la contrainte pack
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_pack_check;
ALTER TABLE clients ALTER COLUMN pack SET DEFAULT 'starter';
ALTER TABLE clients ADD CONSTRAINT clients_pack_check
  CHECK (pack IN ('starter', 'pro', 'business'));

-- 2. Migrer les anciens noms de packs
UPDATE clients SET pack = 'starter'  WHERE pack = 'standard';
UPDATE clients SET pack = 'pro'      WHERE pack = 'moyen';
UPDATE clients SET pack = 'business' WHERE pack = 'avance';

-- 3. Email de notification (séparé de l'email de connexion Supabase Auth)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_notif TEXT;

-- 4. Date de début d'abonnement + période d'essai
ALTER TABLE clients ADD COLUMN IF NOT EXISTS trial_ends_at  TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS subscribed_at  TIMESTAMPTZ;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS billing_cycle   TEXT DEFAULT 'monthly'
  CHECK (billing_cycle IN ('monthly', 'annual'));

-- 5. Index
CREATE INDEX IF NOT EXISTS idx_clients_pack ON clients (pack);

-- 6. Mettre à jour la vue stats admin
CREATE OR REPLACE VIEW v_clients_stats AS
SELECT
  c.id,
  c.nom,
  c.pack,
  c.email_notif,
  c.tg_chat_id IS NOT NULL AS has_telegram,
  c.phone IS NOT NULL      AS has_whatsapp,
  c.trial_ends_at,
  c.subscribed_at,
  c.billing_cycle,
  COUNT(DISTINCT cr.id)    AS nb_criteres,
  COUNT(DISTINCT be.id)    AS nb_alertes_total,
  MAX(be.created_at)       AS derniere_alerte,
  SUM(CASE WHEN be.created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END) AS alertes_30j
FROM clients c
LEFT JOIN criteres    cr ON cr.client_id = c.id
LEFT JOIN bcs_envoyes be ON be.client_id = c.id
GROUP BY c.id, c.nom, c.pack, c.email_notif, c.tg_chat_id, c.phone,
         c.trial_ends_at, c.subscribed_at, c.billing_cycle;

-- 7. Limites par pack (table de référence)
CREATE TABLE IF NOT EXISTS pack_config (
  pack          TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  prix_mensuel  INTEGER NOT NULL,  -- en MAD
  prix_annuel   INTEGER NOT NULL,  -- en MAD/mois (annuel)
  max_criteres  INTEGER NOT NULL,
  has_ia        BOOLEAN DEFAULT true,
  has_mp        BOOLEAN NOT NULL,
  has_email     BOOLEAN NOT NULL,
  has_whatsapp  BOOLEAN NOT NULL,
  has_dao       BOOLEAN DEFAULT false
);

INSERT INTO pack_config VALUES
  ('starter',  'Starter',  99,  75,  5,  true, false, true, false, false),
  ('pro',      'Pro',     249, 190, 15,  true, true,  true, true,  false),
  ('business', 'Business',599, 449, 40,  true, true,  true, true,  true)
ON CONFLICT (pack) DO UPDATE SET
  prix_mensuel = EXCLUDED.prix_mensuel,
  prix_annuel  = EXCLUDED.prix_annuel,
  max_criteres = EXCLUDED.max_criteres,
  has_mp       = EXCLUDED.has_mp,
  has_email    = EXCLUDED.has_email,
  has_whatsapp = EXCLUDED.has_whatsapp,
  has_dao      = EXCLUDED.has_dao;

-- ============================================================
-- VÉRIFICATION
-- SELECT * FROM pack_config;
-- SELECT nom, pack, email_notif FROM clients;
-- ============================================================
