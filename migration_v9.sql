-- ============================================================
-- RADAR MARCHES PUBLICS v9 — Migration prod-ready
-- Exécuter dans Supabase SQL Editor
-- ============================================================

-- 1. Cache LLM persistant (remplace ai_cache.json éphémère)
CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key   TEXT PRIMARY KEY,          -- norm(critere.valeur)
  valeur      TEXT NOT NULL,
  inclusions  JSONB NOT NULL DEFAULT '[]',
  exclusions  JSONB NOT NULL DEFAULT '[]',
  model_used  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE ai_cache DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_ai_cache_key ON ai_cache (cache_key);

-- 2. Logs de scan (observabilité)
CREATE TABLE IF NOT EXISTS scan_logs (
  id          BIGSERIAL PRIMARY KEY,
  radar_type  TEXT NOT NULL CHECK (radar_type IN ('bc','mp')),
  status      TEXT NOT NULL CHECK (status IN ('ok','error','partial')),
  started_at  TIMESTAMPTZ NOT NULL,
  duration_s  INTEGER,
  items_found INTEGER DEFAULT 0,
  items_new   INTEGER DEFAULT 0,
  notifs_sent INTEGER DEFAULT 0,
  error_msg   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE scan_logs DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_scan_logs_type_date ON scan_logs (radar_type, created_at DESC);

-- 3. Colonnes AI sur critères (si pas encore faites)
ALTER TABLE criteres ADD COLUMN IF NOT EXISTS ai_inclusions JSONB DEFAULT '[]';
ALTER TABLE criteres ADD COLUMN IF NOT EXISTS ai_exclusions JSONB DEFAULT '[]';

-- 4. Colonne url/lien sur bcs_envoyes (pour historique client)
ALTER TABLE bcs_envoyes ADD COLUMN IF NOT EXISTS item_url   TEXT;
ALTER TABLE bcs_envoyes ADD COLUMN IF NOT EXISTS item_titre TEXT;
ALTER TABLE bcs_envoyes ADD COLUMN IF NOT EXISTS item_date  TEXT;
ALTER TABLE bcs_envoyes ADD COLUMN IF NOT EXISTS notif_msg  TEXT;

-- 5. Index performance
CREATE INDEX IF NOT EXISTS idx_bcs_envoyes_client_date ON bcs_envoyes (client_id, created_at DESC);

-- 6. Vue pratique pour admin : résumé clients
CREATE OR REPLACE VIEW v_clients_stats AS
SELECT
  c.id,
  c.nom,
  c.pack,
  c.tg_chat_id IS NOT NULL AS has_telegram,
  c.phone IS NOT NULL      AS has_whatsapp,
  COUNT(DISTINCT cr.id)    AS nb_criteres,
  COUNT(DISTINCT be.id)    AS nb_alertes_total,
  MAX(be.created_at)       AS derniere_alerte,
  SUM(CASE WHEN be.created_at > NOW() - INTERVAL '30 days' THEN 1 ELSE 0 END) AS alertes_30j
FROM clients c
LEFT JOIN criteres   cr ON cr.client_id = c.id
LEFT JOIN bcs_envoyes be ON be.client_id = c.id
GROUP BY c.id, c.nom, c.pack, c.tg_chat_id, c.phone;

-- ============================================================
-- VÉRIFICATION
-- SELECT * FROM v_clients_stats;
-- SELECT * FROM scan_logs ORDER BY created_at DESC LIMIT 10;
-- SELECT cache_key, valeur, jsonb_array_length(inclusions) FROM ai_cache;
-- ============================================================
