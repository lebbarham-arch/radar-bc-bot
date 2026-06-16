/**
 * ONB-1a — Fiche Client UX (Layer L1)
 *
 * Source de vérité : client_onboarding_profile (Supabase)
 *
 * Règles anti-duplication absolues :
 *   - L1 ne contient PAS ai_inclusions / ai_exclusions
 *   - L1 ne contient PAS les critères radar finaux
 *   - L1 contient uniquement les informations métier brutes saisies par le client
 *   - Toute génération L1 → L2 → L3 viendra dans ONB-1b (phase suivante)
 *
 * Architecture des couches :
 *   L1  Fiche Client (ce fichier)
 *   L2  Profil Métier Structuré  ← ONB-1b
 *   L3  Critères Radar           ← ONB-1c
 *   L4  Enrichissement IA        ← ONB-1d
 *   L5  Matching (existant, non modifié)
 *   L6  Feedback Learning (existant, non modifié)
 *   L7  Shadow Mode (existant, non modifié)
 */

import { z } from 'zod';

// ─── Enums ────────────────────────────────────────────────────────────────────

/**
 * Types de prestations que le client peut réaliser ou refuser.
 * Source : architecture ONB-1b — mapping vers business_profile.types_prestation.
 */
export const PrestationSchema = z.enum([
  'fourniture',
  'installation',
  'maintenance',
  'support',
  'formation',
  'audit',
  'travaux',
  'autres',
]);

export type Prestation = z.infer<typeof PrestationSchema>;

export const PRESTATIONS: readonly Prestation[] = [
  'fourniture',
  'installation',
  'maintenance',
  'support',
  'formation',
  'audit',
  'travaux',
  'autres',
] as const;

/**
 * Niveau de précision du radar.
 * Agit sur le seuil de score effectif (pack_threshold override) en L5.
 *   large     → seuil abaissé, couverture maximale
 *   equilibre → seuil du pack (défaut)
 *   strict    → seuil relevé, haute précision
 */
export const NiveauPrecisionSchema = z.enum(['large', 'equilibre', 'strict']);

export type NiveauPrecision = z.infer<typeof NiveauPrecisionSchema>;

// ─── Helpers internes ─────────────────────────────────────────────────────────

/** Chaîne non vide après trim */
const NonEmptyString = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} : minimum ${min} caractère(s)`)
    .max(max, `${label} : maximum ${max} caractères`);

/** Tableau de chaînes non vides, dédupliqué à la validation */
const StringArray = (itemMin: number, itemMax: number, label: string) =>
  z
    .array(NonEmptyString(itemMin, itemMax, label))
    .transform(arr => [...new Set(arr.map(s => s.trim()).filter(s => s.length > 0))]);

// ─── Schema principal ─────────────────────────────────────────────────────────

/**
 * OnboardingClientFormSchema — couche L1
 *
 * Représente la fiche remplie par le client lors de l'onboarding.
 * Aucun critère de matching n'est présent ici.
 * Aucun enrichissement IA n'est présent ici.
 */
export const OnboardingClientFormSchema = z
  .object({
    /**
     * Description libre de l'activité principale du client.
     * Alimente business_profile.secteurs en L2.
     * Exemple : "Fourniture et installation de matériel informatique"
     */
    activite_principale: NonEmptyString(
      5,
      300,
      'Activité principale',
    ),

    /**
     * Liste des produits ou services que le client fournit.
     * Alimente technical_profile.produits et criteres[].valeur en L3.
     * Exemple : ["ordinateurs", "imprimantes", "serveurs réseau"]
     * Min 1, max 20 items. Dédupliqué automatiquement.
     */
    capacites: StringArray(2, 100, 'Capacité')
      .pipe(
        z
          .array(z.string())
          .min(1, 'Au moins une capacité / produit est requise')
          .max(20, 'Maximum 20 capacités'),
      ),

    /**
     * Prestations que le client est capable de réaliser.
     * Alimente business_profile.types_prestation en L2.
     * Min 1 prestation requise.
     */
    prestations_realisees: z
      .array(PrestationSchema)
      .min(1, 'Au moins une prestation réalisée est requise')
      .refine(arr => new Set(arr).size === arr.length, {
        message: 'Les prestations réalisées ne doivent pas contenir de doublons',
      }),

    /**
     * Prestations que le client refuse explicitement.
     * Alimente business_profile.exclusions_metier et criteres[].ai_exclusions en L2/L3.
     * Optionnel. Doit être disjoint de prestations_realisees.
     */
    prestations_refusees: z
      .array(PrestationSchema)
      .default([])
      .refine(arr => new Set(arr).size === arr.length, {
        message: 'Les prestations refusées ne doivent pas contenir de doublons',
      }),

    /**
     * Zones géographiques couvertes par le client.
     * Alimente organization_profile.wilayas_couvertes en L2.
     * Exemple : ["Casablanca-Settat", "Rabat-Salé-Kénitra"]
     * Min 1, max 20 zones.
     */
    zones_geographiques: StringArray(2, 100, 'Zone géographique')
      .pipe(
        z
          .array(z.string())
          .min(1, 'Au moins une zone géographique est requise')
          .max(20, 'Maximum 20 zones'),
      ),

    /**
     * Types d'organismes publics favoris.
     * Alimente business_profile.organismes_cibles en L2.
     * Exemple : ["ministères", "CHU", "communes", "offices"]
     * Optionnel, max 10 items.
     */
    organismes_favoris: StringArray(2, 100, 'Organisme favori')
      .pipe(z.array(z.string()).max(10, 'Maximum 10 organismes favoris'))
      .default([]),

    /**
     * Exemples de BCs que le client aurait voulu recevoir.
     * Utilisés en L4 pour enrichir les ai_inclusions par extraction de termes.
     * Exemple : ["Fourniture ordinateurs HP EliteBook 840", "Acquisition imprimantes laser A4"]
     * Optionnel, max 10 exemples.
     */
    exemples_bc_recherches: StringArray(5, 500, 'Exemple BC')
      .pipe(z.array(z.string()).max(10, 'Maximum 10 exemples de BC'))
      .default([]),

    /**
     * Niveau de précision souhaité pour les alertes.
     * large     → beaucoup d'alertes, couverture maximale
     * equilibre → comportement par défaut du pack
     * strict    → peu d'alertes, haute pertinence uniquement
     */
    niveau_precision: NiveauPrecisionSchema.default('equilibre'),
  })
  // ── Règle métier : pas de conflit souhaitées / refusées ──────────────────
  .refine(
    data =>
      data.prestations_realisees.every(
        p => !data.prestations_refusees.includes(p),
      ),
    {
      message:
        'Une prestation ne peut pas être à la fois réalisée et refusée',
      path: ['prestations_refusees'],
    },
  );

export type OnboardingClientForm = z.infer<typeof OnboardingClientFormSchema>;

// ─── Helpers de validation ────────────────────────────────────────────────────

/**
 * Parse et valide une fiche brute sans lancer d'exception.
 * Retourne { success: true, data } ou { success: false, error }.
 */
export const safeParseOnboardingForm = (raw: unknown) =>
  OnboardingClientFormSchema.safeParse(raw);

/**
 * Parse et valide une fiche brute. Lance une ZodError si invalide.
 * Utiliser en contexte serveur où les erreurs sont gérées globalement.
 */
export const parseOnboardingForm = (raw: unknown): OnboardingClientForm =>
  OnboardingClientFormSchema.parse(raw);

/**
 * Vérifie si la fiche est "complète" au sens métier :
 * - Au moins 2 capacités renseignées
 * - Au moins 1 zone géographique
 * - Au moins 1 prestation réalisée
 * - Activité principale suffisamment descriptive (≥ 10 chars)
 *
 * Une fiche peut être valide (Zod) mais pas encore complète (métier).
 */
export function isFormComplete(form: OnboardingClientForm): boolean {
  return (
    form.activite_principale.length >= 10 &&
    form.capacites.length >= 2 &&
    form.zones_geographiques.length >= 1 &&
    form.prestations_realisees.length >= 1
  );
}

/**
 * Retourne la liste des conflits entre prestations réalisées et refusées.
 * Utile pour l'affichage UX avant soumission.
 */
export function getPrestationConflicts(form: OnboardingClientForm): Prestation[] {
  return form.prestations_realisees.filter(p =>
    form.prestations_refusees.includes(p),
  );
}

/**
 * Retourne un résumé lisible de la fiche pour les logs et l'UI.
 */
export function summarizeForm(form: OnboardingClientForm): string {
  const lines = [
    `Activité : ${form.activite_principale}`,
    `Capacités (${form.capacites.length}) : ${form.capacites.slice(0, 3).join(', ')}${form.capacites.length > 3 ? '...' : ''}`,
    `Prestations : ${form.prestations_realisees.join(', ')}`,
    `Zones : ${form.zones_geographiques.join(', ')}`,
    `Précision : ${form.niveau_precision}`,
  ];
  if (form.prestations_refusees.length > 0) {
    lines.push(`Refusées : ${form.prestations_refusees.join(', ')}`);
  }
  return lines.join(' | ');
}
