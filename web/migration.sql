-- ============================================================
-- RADAR BC MAROC - Migration SQL SaaS
-- Executer dans Supabase SQL Editor (dans l'ordre)
-- ============================================================

-- 1. Table memoire du bot (BCs analyses)
CREATE TABLE IF NOT EXISTS bcs_vus (
  bc_id       TEXT PRIMARY KEY,
  bc_data     JSONB,
  date_limite TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Ajouter auth_user_id sur clients (lien avec Supabase Auth)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tg_chat_id  TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone       TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS wa_provider TEXT DEFAULT 'callmebot';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS wa_apikey   TEXT;

-- 3. Activer RLS sur toutes les tables exposees
ALTER TABLE clients    ENABLE ROW LEVEL SECURITY;
ALTER TABLE criteres   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bcs_envoyes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_logs  ENABLE ROW LEVEL SECURITY;

-- 4. Policies clients : chaque client voit/modifie uniquement ses donnees
DROP POLICY IF EXISTS "clients_own" ON clients;
CREATE POLICY "clients_own" ON clients
  FOR ALL USING (auth_user_id = auth.uid());

-- 5. Policies criteres : via client_id
DROP POLICY IF EXISTS "criteres_own" ON criteres;
CREATE POLICY "criteres_own" ON criteres
  FOR ALL USING (
    client_id IN (SELECT id FROM clients WHERE auth_user_id = auth.uid())
  );

-- 6. Policies bcs_envoyes : lecture seule
DROP POLICY IF EXISTS "bcs_envoyes_own_read" ON bcs_envoyes;
CREATE POLICY "bcs_envoyes_own_read" ON bcs_envoyes
  FOR SELECT USING (
    client_id IN (SELECT id FROM clients WHERE auth_user_id = auth.uid())
  );

-- 7. Policies scan_logs : lecture seule
DROP POLICY IF EXISTS "scan_logs_own_read" ON scan_logs;
CREATE POLICY "scan_logs_own_read" ON scan_logs
  FOR SELECT USING (
    client_id IN (SELECT id FROM clients WHERE auth_user_id = auth.uid())
  );

-- 8. bcs_vus : pas de RLS (le bot utilise la cle service_role)
-- Mais permettre lecture publique pour stats futures
ALTER TABLE bcs_vus DISABLE ROW LEVEL SECURITY;

-- 9. Trigger : creation automatique du client a l'inscription
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO clients (auth_user_id, nom, actif)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    true
  )
  ON CONFLICT (auth_user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- 10. Contrainte unicite sur auth_user_id (un compte = un client)
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_auth_user_id_key;
ALTER TABLE clients ADD CONSTRAINT clients_auth_user_id_key UNIQUE (auth_user_id);

-- ============================================================
-- VERIFICATION : verifier que tout est en ordre
-- ============================================================
-- SELECT table_name, row_security FROM information_schema.tables
-- WHERE table_schema = 'public' AND table_name IN ('clients','criteres','bcs_envoyes','bcs_vus');
