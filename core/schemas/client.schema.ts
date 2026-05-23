/**
 * Client Schema — Anaho
 *
 * Modélise le profil complet d'un client Anaho :
 * son profil métier, ses critères de recherche, et les limites de son pack.
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';
import { RadarTypeSchema } from './bc.schema';

// ─── Pack ─────────────────────────────────────────────────────────────────────

export const PackSchema = z.enum(['starter', 'pro', 'business']);
export type Pack = z.infer<typeof PackSchema>;

/**
 * Limites associées à chaque pack.
 * maxCriteres : nombre maximum de critères de recherche actifs.
 * scoreThreshold : score minimum pour déclencher une notification.
 * aiEnabled : accès aux enrichissements IA (inclusions/exclusions).
 */
export const PackLimitsSchema = z.object({
  maxCriteres:     z.number().int().positive(),
  scoreThreshold:  z.number().min(0).max(100),
  aiEnabled:       z.boolean(),
});

export type PackLimits = z.infer<typeof PackLimitsSchema>;

export const PACK_LIMITS: Record<Pack, PackLimits> = {
  starter:  { maxCriteres: 5,  scoreThreshold: 50, aiEnabled: false },
  pro:      { maxCriteres: 20, scoreThreshold: 40, aiEnabled: true  },
  business: { maxCriteres: 50, scoreThreshold: 35, aiEnabled: true  },
} as const;

// ─── BusinessProfile ──────────────────────────────────────────────────────────

/**
 * Profil métier du client : ce qu'il vend, à qui, et ce qu'il exclut.
 * Utilisé par le scoring pour les signaux métier (BS-01 à BS-04).
 */
export const BusinessProfileSchema = z.object({
  /** Secteurs d'activité du client (ex: ["informatique", "réseaux"]) */
  secteurs:            z.array(z.string()).default([]),
  /** Types de prestation proposées (ex: ["fourniture", "installation"]) */
  types_prestation:    z.array(z.string()).default([]),
  /** Organismes publics ciblés (ex: ["Ministère", "CHU", "DGSI"]) */
  organismes_cibles:   z.array(z.string()).default([]),
  /** Exclusions métier — contextes hors périmètre (ex: ["travaux", "bâtiment"]) */
  exclusions_metier:   z.array(z.string()).default([]),
});

export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;

// ─── TechnicalProfile ─────────────────────────────────────────────────────────

/**
 * Profil technique du client : produits et spécifications maîtrisés.
 * Utilisé par le scoring pour les signaux techniques (TS-01 à TS-03).
 */
export const TechnicalProfileSchema = z.object({
  /** Produits / lignes de produits du client (ex: ["câble réseau", "switch"]) */
  produits:        z.array(z.string()).default([]),
  /** Termes techniques qualifiants (ex: ["Cat6", "RJ45", "Gigabit", "PoE"]) */
  specifications:  z.array(z.string()).default([]),
});

export type TechnicalProfile = z.infer<typeof TechnicalProfileSchema>;

// ─── OrganizationProfile ──────────────────────────────────────────────────────

/**
 * Profil organisationnel du client : localisation et périmètre géographique.
 */
export const OrganizationProfileSchema = z.object({
  /** Ville / siège social du client */
  ville:              z.string().default(''),
  /** Wilayas couvertes (vide = toutes les régions acceptées) */
  wilayas_couvertes:  z.array(z.string()).default([]),
  /** Wilayas exclues explicitement par le client */
  wilayas_exclues:    z.array(z.string()).default([]),
});

export type OrganizationProfile = z.infer<typeof OrganizationProfileSchema>;

// ─── Critere ──────────────────────────────────────────────────────────────────

/**
 * Un critère de recherche défini par le client.
 *
 * - `valeur` : mot-clé principal (obligatoire, ce que le client cherche)
 * - `ai_inclusions` : variantes acceptées enrichies par IA
 * - `ai_exclusions` : variantes à exclure explicitement
 * - `radar_type` : portée du critère (bc = bons de commande, mp = marchés publics)
 */
export const CritereSchema = z.object({
  id:              z.string().min(1, 'L\'identifiant du critère est requis'),
  type:            z.enum(['contenu', 'organisme', 'wilaya']),
  valeur:          z.string().min(1, 'La valeur du critère est requise'),
  radar_type:      RadarTypeSchema.default('bc'),
  ai_inclusions:   z.array(z.string()).default([]),
  ai_exclusions:   z.array(z.string()).default([]),
  actif:           z.boolean().default(true),
  created_at:      z.string().datetime().optional(),
});

export type Critere = z.infer<typeof CritereSchema>;

// ─── ClientProfile ────────────────────────────────────────────────────────────

/**
 * Profil complet d'un client Anaho.
 *
 * C'est le modèle central utilisé par le moteur de scoring.
 * Il agrège pack, profil métier, profil technique, profil organisationnel,
 * et les critères de recherche actifs.
 */
export const ClientProfileSchema = z.object({
  id:                    z.string().min(1, 'L\'identifiant client est requis'),
  nom:                   z.string().default(''),
  email:                 z.string().email().optional(),
  pack:                  PackSchema,

  /** Score minimum pour recevoir une notification (override du pack si défini) */
  pack_threshold:        z.number().min(0).max(100).optional(),

  business_profile:      BusinessProfileSchema.default(() => ({
    secteurs: [],
    types_prestation: [],
    organismes_cibles: [],
    exclusions_metier: [],
  })),
  technical_profile:     TechnicalProfileSchema.default(() => ({
    produits: [],
    specifications: [],
  })),
  organization_profile:  OrganizationProfileSchema.default(() => ({
    ville: '',
    wilayas_couvertes: [],
    wilayas_exclues: [],
  })),
  criteres:              z.array(CritereSchema).default([]),

  /** Notifications activées (Telegram, email, etc.) */
  notifications_enabled: z.boolean().default(true),
  created_at:            z.string().datetime().optional(),
  updated_at:            z.string().datetime().optional(),
});

export type ClientProfile = z.infer<typeof ClientProfileSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Valide et parse un profil client brut.
 * Retourne le résultat Zod (success/error) sans lancer d'exception.
 */
export const safeParseClientProfile = (raw: unknown) =>
  ClientProfileSchema.safeParse(raw);

/**
 * Retourne le seuil de score effectif pour un client.
 * Utilise le pack_threshold si défini, sinon la valeur du pack.
 */
export function getEffectiveThreshold(client: ClientProfile): number {
  if (client.pack_threshold !== undefined) return client.pack_threshold;
  return PACK_LIMITS[client.pack].scoreThreshold;
}

/**
 * Retourne les critères actifs d'un client pour un radar_type donné.
 */
export function getActiveCriteres(
  client: ClientProfile,
  radarType: 'bc' | 'mp' = 'bc',
): Critere[] {
  return client.criteres.filter(c => c.actif && c.radar_type === radarType);
}
