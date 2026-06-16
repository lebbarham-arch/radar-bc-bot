/**
 * ONB-1i — Router admin onboarding (module pur, sans DOM, sans framework)
 *
 * Branché dans http.createServer vanilla de radar-bc-bot.js.
 * Expose handleOnboardingAdminRoute() — testable indépendamment du serveur.
 *
 * Règles :
 *   - Aucune logique métier ici — tout délègue à criteria-admin-handler.ts
 *   - Route unique : POST /api/admin/onboarding/criteria/persist
 *   - Retourne null si la route ne correspond pas (passthrough)
 *   - Feature flag ONBOARDING_ADMIN_API_ENABLED=false par défaut
 *   - dryRun=true par défaut (protecteur)
 *   - actor_id obligatoire pour écriture réelle
 */

import {
  handleAdminCriteriaPersist,
  type HandlerRequest,
  type HandlerDeps,
} from './criteria-admin-handler';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RouterResponse {
  status: number;
  body:   unknown;
}

/** Dépendances injectables du routeur (séparées pour testabilité) */
export type AdminRouterDeps = HandlerDeps;

// ─── Route matcher ────────────────────────────────────────────────────────────

const PERSIST_PATH = '/api/admin/onboarding/criteria/persist';

/**
 * Tente de gérer la requête admin onboarding.
 *
 * @returns RouterResponse si la route correspond, null sinon (passthrough).
 */
export async function handleOnboardingAdminRoute(
  method:   string,
  pathname: string,
  body:     unknown,
  deps:     AdminRouterDeps,
): Promise<RouterResponse | null> {
  // Ne correspond pas à cette route → passthrough
  if (pathname !== PERSIST_PATH) return null;

  const req: HandlerRequest = { method, body };
  const result = await handleAdminCriteriaPersist(req, deps);
  return { status: result.status, body: result.body };
}

// ─── Helper lecture body JSON (utilisé par radar-bc-bot.js) ──────────────────

/**
 * Lit et parse le body JSON d'une requête Node.js IncomingMessage.
 * Retourne null si le body est absent, vide ou invalide.
 */
export async function readJsonBody(
  req: { on(event: string, cb: (chunk: Buffer) => void): void },
): Promise<unknown> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        resolve(raw ? JSON.parse(raw) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
