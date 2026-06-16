/**
 * ONB-1e-A — Adaptateur de Persistance des Critères Approuvés
 *
 * Transforme un ReviewableCriteriaSet (post-revue humaine) en batch de rows
 * prêtes pour insertion dans la table Supabase `criteres`.
 *
 * Règles absolues :
 *   - Seuls les critères approved → PreparedCritereRow avec actif=true
 *   - Les critères rejected/pending/edited → skipped avec raison typée
 *   - Aucun accès DB dans ce module
 *   - Aucun appel IA
 *   - Aucune mutation du ReviewableCriteriaSet en entrée
 *   - Payload validé par Zod avant retour (invalid_payload si échec)
 */

import {
  type ReviewableCriteriaSet,
  type ReviewableCritere,
} from './l3-review.schema';

import {
  PreparedCritereRowSchema,
  PreparedCriteriaPersistenceBatchSchema,
  type PreparedCritereRow,
  type SkippedCritere,
  type PreparedCriteriaPersistenceBatch,
} from './criteria-persistence.schema';

// ─── Helpers internes ─────────────────────────────────────────────────────────

/**
 * Extrait la valeur principale du critère.
 * Priorité : base_keywords[0] → label
 */
function extractValeur(critere: ReviewableCritere): string {
  return critere.base_keywords[0] ?? critere.label;
}

/**
 * Construit le metadata_json depuis un critère approuvé.
 * Contient les colonnes futures + enrichissements onboarding.
 */
function buildMetadata(critere: ReviewableCritere): Record<string, unknown> {
  return {
    domain_category:           critere.domain_category,
    precision_mode:            critere.precision_mode,
    zones_geographiques:       critere.zones_geographiques       ?? [],
    favorite_organizations:    critere.favorite_organizations    ?? [],
    source_trace:              critere.source_trace              ?? {},
    review_audit:              critere.audit_trail,
    generated_from_onboarding: true as const,
    prestations_recherchees:   critere.prestations_recherchees ?? [],
    prestations_exclues:       critere.prestations_exclues     ?? [],
  };
}

/**
 * Tente de construire une PreparedCritereRow depuis un critère approuvé.
 * Retourne { row } si succès, { error } si le payload Zod est invalide.
 */
function buildRow(
  critere: ReviewableCritere,
  clientId: string,
): { row: PreparedCritereRow } | { error: string } {
  const raw = {
    client_id:     clientId,
    valeur:        extractValeur(critere),
    type:          'contenu' as const,
    radar_type:    critere.radar_type,
    ai_inclusions: critere.ai_inclusions_initial ?? [],
    ai_exclusions: critere.ai_exclusions_initial ?? [],
    actif:         true as const,
    metadata_json: buildMetadata(critere),
  };

  const parsed = PreparedCritereRowSchema.safeParse(raw);

  if (!parsed.success) {
    return { error: parsed.error.message };
  }

  return { row: parsed.data };
}

// ─── Fonction principale ───────────────────────────────────────────────────────

/**
 * Prépare un batch de persistance depuis une session de revue terminée.
 *
 * @param reviewSet  Session de revue post-humaine (ReviewableCriteriaSet)
 * @returns          Batch prêt : rows (approved) + skipped + warnings
 *
 * Ne fait aucun accès DB — retourne uniquement des payloads structurés.
 */
export function preparePersistenceBatch(
  reviewSet: ReviewableCriteriaSet,
): PreparedCriteriaPersistenceBatch {
  const clientId       = reviewSet.client_id ?? '';
  const preparedAt     = new Date().toISOString();
  const sourceSession  = reviewSet.review_started_at;

  const rows:     PreparedCritereRow[] = [];
  const skipped:  SkippedCritere[]     = [];
  const warnings: string[]             = [];

  for (const critere of reviewSet.criteria) {
    // Critères rejetés — skip avec raison 'rejected'
    if (critere.review_status === 'rejected') {
      skipped.push({
        criterion_id:  critere.id,
        label:         critere.label,
        review_status: critere.review_status,
        reason:        'rejected',
      });
      continue;
    }

    // Critères pending ou edited — skip avec raison 'not_approved'
    if (
      critere.review_status === 'pending_validation' ||
      critere.review_status === 'edited'
    ) {
      skipped.push({
        criterion_id:  critere.id,
        label:         critere.label,
        review_status: critere.review_status,
        reason:        'not_approved',
      });
      continue;
    }

    // Critère approved — tenter la construction du payload
    const result = buildRow(critere, clientId);

    if ('error' in result) {
      // Payload invalide malgré le statut approved
      skipped.push({
        criterion_id:  critere.id,
        label:         critere.label,
        review_status: critere.review_status,
        reason:        'invalid_payload',
        detail:        result.error,
      });
      warnings.push(
        `Critère "${critere.label}" (${critere.id}) ignoré — payload Zod invalide : ${result.error}`,
      );
      continue;
    }

    rows.push(result.row);
  }

  // Avertissement si aucune row préparée
  if (rows.length === 0) {
    warnings.push(
      'Aucune row préparée — vérifiez que des critères sont bien approuvés dans la session de revue.',
    );
  }

  // Avertissement si des inclusions sont vides
  const emptyInclusions = rows.filter(r => r.ai_inclusions.length === 0);
  if (emptyInclusions.length > 0) {
    warnings.push(
      `${emptyInclusions.length} critère(s) ont des ai_inclusions vides — le matching pourra être moins précis.`,
    );
  }

  const raw = {
    client_id:             clientId,
    prepared_at:           preparedAt,
    source_review_session: sourceSession,
    rows,
    skipped,
    warnings,
  };

  return PreparedCriteriaPersistenceBatchSchema.parse(raw);
}
