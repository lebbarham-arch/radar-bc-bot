-- Migration: ajout colonne pack pour SaaS 3 niveaux
-- À exécuter dans Supabase SQL Editor

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS pack TEXT
    NOT NULL DEFAULT 'standard'
    CHECK (pack IN ('standard', 'moyen', 'avance'));

COMMENT ON COLUMN clients.pack IS
  'Niveau SaaS: standard=recherche portail par mot-clé, moyen=listing+popup HTML, avance=listing+popup+DAO PDF';

-- Exemple: mettre un client en pack moyen
-- UPDATE clients SET pack = 'moyen' WHERE nom = 'Client X';

-- Exemple: mettre un client en pack avancé
-- UPDATE clients SET pack = 'avance' WHERE nom = 'Client Y';
