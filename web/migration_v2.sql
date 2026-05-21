-- ============================================================
-- RADAR BC + MARCHES PUBLICS - Migration SQL v2
-- Executer dans Supabase SQL Editor (APRES migration_v1)
-- ============================================================

-- 1. Table memoire bot pour Marches Publics
CREATE TABLE IF NOT EXISTS mps_vus (
  mp_id       TEXT PRIMARY KEY,
  mp_data     JSONB,
  date_limite TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE mps_vus DISABLE ROW LEVEL SECURITY;

-- 2. Ajouter radar_type sur criteres (bc = Bon de Commande, mp = Marche Public)
ALTER TABLE criteres ADD COLUMN IF NOT EXISTS radar_type TEXT DEFAULT 'bc'
  CHECK (radar_type IN ('bc', 'mp'));

-- 3. Ajouter radar_type sur bcs_envoyes (notifications envoyees)
ALTER TABLE bcs_envoyes ADD COLUMN IF NOT EXISTS radar_type TEXT DEFAULT 'bc'
  CHECK (radar_type IN ('bc', 'mp'));

-- 4. Ajouter radar_type sur scan_logs
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS radar_type TEXT DEFAULT 'bc';

-- 5. Index pour performance
CREATE INDEX IF NOT EXISTS idx_criteres_radar_type   ON criteres (radar_type);
CREATE INDEX IF NOT EXISTS idx_bcs_envoyes_radar_type ON bcs_envoyes (radar_type);
CREATE INDEX IF NOT EXISTS idx_bcs_envoyes_client_type ON bcs_envoyes (client_id, radar_type);

-- 6. Mettre a jour les criteres existants (tous sont BC par defaut)
UPDATE criteres SET radar_type = 'bc' WHERE radar_type IS NULL;

-- ============================================================
-- VERIFICATION
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name IN ('criteres','bcs_envoyes') AND column_name = 'radar_type';
-- ============================================================
