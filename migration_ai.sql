-- =============================================================
-- Migration v8.0 : Couche IA - Enrichissement critères
-- Ajouter les colonnes IA à la table criteres
-- À exécuter une seule fois dans Supabase > SQL Editor
-- =============================================================

ALTER TABLE criteres
  ADD COLUMN IF NOT EXISTS ai_inclusions  JSONB         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_exclusions  JSONB         DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ai_enriched_at TIMESTAMPTZ   DEFAULT NULL;

-- Index pour trouver rapidement les critères non encore enrichis
CREATE INDEX IF NOT EXISTS idx_criteres_ai_enriched
  ON criteres (ai_enriched_at)
  WHERE ai_enriched_at IS NULL;

-- Vérification
SELECT
  id, client_id, type, valeur,
  ai_inclusions IS NOT NULL AS enrichi,
  ai_enriched_at
FROM criteres
ORDER BY client_id, type;
