/**
 * ONB-1g — Handler HTTP Admin : Persistance des Critères Approuvés
 *
 * Handler isolé pour POST /api/admin/onboarding/criteria/persist.
 * Peut être branché sur n'importe quel serveur HTTP (http.createServer, Express…).
 *
 * Règles absolues :
 *   - ONBOARDING_ADMIN_API_ENABLED=false par défaut → 403
 *   - dryRun=true par défaut (forcé si absent)
 *   - enabled=false par défaut (forcé si absent)
 *   - actor_id obligatoire pour toute écriture réelle
 *   - Aucun throw non contrôlé
 *   - Pas de modification du matching, des notifications, du scraping
 *   - Pas d'appel IA
 *   - Pas de suppression d'anciens critères
 *   - Admin/internal uniquement
 */

import { z } from 'zod';

import {
  ReviewableCriteriaSetSchema,
} from './l3-review.schema';

import {
  ConflictStrategySchema,
} from './criteria-repository.schema';

import {
  runCriteriaPersistenceWorkflow,
  type WorkflowDeps,
  type WorkflowReport,
} from './criteria-workflow';

// ─── Feature flag ─────────────────────────────────────────────────────────────

/**
 * Feature flag — false par défaut.
 * Activer explicitement via ONBOARDING_ADMIN_API_ENABLED=true.
 */
export function isAdminApiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env['ONBOARDING_ADMIN_API_ENABLED'] === 'true';
}

// ─── Schéma de la request ─────────────────────────────────────────────────────

export const AdminPersistRequestSchema = z.object({
  /** Session de revue humaine post-approbation */
  review_set: ReviewableCriteriaSetSchema,

  options: z.object({
    /**
     * Si true : simulation sans écriture DB.
     * Forcé à true si absent — comportement protecteur.
     */
    dryRun: z.boolean().default(true),

    /**
     * Feature flag — forcé à false si absent.
     * Écriture réelle uniquement si enabled=true explicitement.
     */
    enabled: z.boolean().default(false),

    /** Stratégie de gestion des doublons */
    conflictStrategy: ConflictStrategySchema.default('skip_existing'),

    /**
     * Identifiant de l'acteur admin.
     * Obligatoire si dryRun=false et enabled=true.
     */
    actor_id: z.string().optional(),

    /** Source de l'opération */
    source: z.enum(['admin', 'client_validation']).default('admin'),
  }).default({}),
});
export type AdminPersistRequest = z.infer<typeof AdminPersistRequestSchema>;

// ─── Schéma de la response ────────────────────────────────────────────────────

export const AdminPersistResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok:     z.literal(true),
    report: z.object({
      approved_count:     z.number(),
      skipped_count:      z.number(),
      would_insert_count: z.number(),
      inserted_count:     z.number(),
      upserted_count:     z.number(),
      errors:             z.array(z.unknown()),
      warnings:           z.array(z.string()),
      dry_run:            z.boolean(),
      enabled:            z.boolean(),
      ok:                 z.boolean(),
    }),
  }),
  z.object({
    ok:    z.literal(false),
    error: z.string(),
    code:  z.number(),
  }),
]);
export type AdminPersistResponse = z.infer<typeof AdminPersistResponseSchema>;

// ─── Types du handler ─────────────────────────────────────────────────────────

export interface HandlerRequest {
  /** Corps JSON parsé de la requête */
  body: unknown;
  /** Méthode HTTP */
  method: string;
}

export interface HandlerResponse {
  /** Code HTTP à retourner */
  status: number;
  /** Corps JSON */
  body: AdminPersistResponse;
}

export type HandlerDeps = WorkflowDeps & { env?: Record<string, string | undefined> };

// ─── Handler principal ────────────────────────────────────────────────────────

/**
 * Handler isolé pour POST /api/admin/onboarding/criteria/persist.
 *
 * Retourne toujours un { status, body } — jamais d'exception.
 *
 * @param req   Requête HTTP (body + method)
 * @param deps  Dépendances injectées (workflow, env)
 * @returns     { status: number, body: AdminPersistResponse }
 */
export async function handleAdminCriteriaPersist(
  req: HandlerRequest,
  deps: WorkflowDeps & { env?: Record<string, string | undefined> },
): Promise<HandlerResponse> {

  // ── 1. Feature flag ───────────────────────────────────────────────────────
  if (!isAdminApiEnabled(deps.env)) {
    return {
      status: 403,
      body: {
        ok:    false,
        error: 'Endpoint désactivé. Activez ONBOARDING_ADMIN_API_ENABLED=true pour utiliser cet endpoint.',
        code:  403,
      },
    };
  }

  // ── 2. Méthode HTTP ───────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return {
      status: 405,
      body: { ok: false, error: 'Méthode non autorisée. Utilisez POST.', code: 405 },
    };
  }

  // ── 3. Validation Zod de la request ───────────────────────────────────────
  const parsed = AdminPersistRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return {
      status: 400,
      body: {
        ok:    false,
        error: `Request invalide : ${parsed.error.message}`,
        code:  400,
      },
    };
  }

  const { review_set, options } = parsed.data;

  // ── 4. Guard actor_id pour écriture réelle ────────────────────────────────
  if (!options.dryRun && options.enabled && !options.actor_id) {
    return {
      status: 400,
      body: {
        ok:    false,
        error: 'actor_id obligatoire pour une écriture réelle (dryRun=false, enabled=true).',
        code:  400,
      },
    };
  }

  // ── 5. Appel du workflow ───────────────────────────────────────────────────
  let report: WorkflowReport;
  try {
    report = await runCriteriaPersistenceWorkflow(
      {
        review_set,
        options: {
          dryRun:           options.dryRun,
          enabled:          options.enabled,
          conflictStrategy: options.conflictStrategy,
          actor_id:         options.actor_id,
          source:           options.source,
        },
      },
      { persistBatch: deps.persistBatch },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 500,
      body: {
        ok:    false,
        error: `Erreur inattendue du workflow : ${message}`,
        code:  500,
      },
    };
  }

  // ── 6. Retourner le rapport ────────────────────────────────────────────────
  return {
    status: report.ok ? 200 : 500,
    body:   { ok: true, report },
  };
}
