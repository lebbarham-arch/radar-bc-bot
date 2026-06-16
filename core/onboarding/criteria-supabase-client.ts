/**
 * ONB-1i — Implémentation Supabase de ICriteriaDbClient
 *
 * Utilise le même pattern fetch REST que radar-bc-bot.js (sbReq).
 * Injectable : ne crée pas de client global.
 * Aucun import Supabase SDK — appels REST directs.
 */

import { type ICriteriaDbClient }  from './criteria-repository';
import { type DuplicateKey }        from './criteria-repository.schema';
import { type CritereDbRow }        from './criteria-repository.schema';

// ─── Type interne du résultat fetch ──────────────────────────────────────────

type DbResult<T> = { data: T | null; error: { message: string; code?: string } | null };

// ─── Helpers REST ─────────────────────────────────────────────────────────────

async function sbFetch<T = unknown[]>(
  sbUrl:   string,
  sbKey:   string,
  path:    string,
  method:  string,
  body?:   unknown,
  extraHeaders: Record<string, string> = {},
): Promise<DbResult<T>> {
  try {
    const headers: Record<string, string> = {
      'apikey':        sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=representation',
      ...extraHeaders,
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(`${sbUrl}/rest/v1/${path}`, init);

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      return { data: null, error: { message: `HTTP ${res.status}: ${text}`, code: String(res.status) } };
    }

    const json = await res.json().catch(() => null) as unknown;
    const data = Array.isArray(json) ? json : (json ? [json] : []);
    return { data: data as T, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, error: { message: msg } };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Crée un ICriteriaDbClient branché sur Supabase via fetch REST.
 * sbUrl et sbKey proviennent des variables d'environnement (jamais hardcodés).
 */
export function makeSbCriteriaClient(sbUrl: string, sbKey: string): ICriteriaDbClient {
  if (!sbUrl || !sbKey) {
    throw new Error('makeSbCriteriaClient : sbUrl et sbKey sont requis.');
  }

  return {
    async insert(rows: CritereDbRow[]) {
      return sbFetch<CritereDbRow[]>(sbUrl, sbKey, 'criteres', 'POST', rows);
    },

    async upsert(rows: CritereDbRow[], conflictColumns: string[]) {
      const onConflict = conflictColumns.join(',');
      return sbFetch<CritereDbRow[]>(sbUrl, sbKey, 'criteres', 'POST', rows, {
        'Prefer':      `return=representation,resolution=merge-duplicates`,
        'on-conflict': onConflict,
      });
    },

    async findExistingKeys(keys: DuplicateKey[]) {
      if (keys.length === 0) return { data: [], error: null };

      // Requête OR sur les tuples (client_id, valeur, radar_type, type)
      const clientIds  = [...new Set(keys.map(k => k.client_id))].join(',');
      const valeurs    = [...new Set(keys.map(k => k.valeur))].join(',');
      const radarTypes = [...new Set(keys.map(k => k.radar_type))].join(',');
      const types      = [...new Set(keys.map(k => k.type))].join(',');

      const qs = [
        `client_id=in.(${clientIds})`,
        `valeur=in.(${valeurs})`,
        `radar_type=in.(${radarTypes})`,
        `type=in.(${types})`,
        'select=client_id,valeur,radar_type,type',
      ].join('&');

      return sbFetch<DuplicateKey[]>(sbUrl, sbKey, `criteres?${qs}`, 'GET');
    },
  };
}
