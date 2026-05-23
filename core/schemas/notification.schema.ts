/**
 * Notification Schema — Anaho
 *
 * Modélise les notifications envoyées aux clients lorsqu'un BC matche leur profil.
 *
 * Un NotificationPayload est l'objet construit juste avant l'envoi,
 * après que le scoring a produit un verdict "match".
 *
 * Règle : jamais de `any`. Toute donnée manquante → valeur par défaut explicite.
 */

import { z } from 'zod';

// ─── NotificationChannel ──────────────────────────────────────────────────────

/**
 * Canal de notification disponible.
 * - `telegram` : message Telegram (canal principal pour les clients Anaho)
 * - `email`    : email (futur — non implémenté en Phase 1)
 * - `webhook`  : webhook HTTP (futur — pour intégrations tierces)
 */
export const NotificationChannelSchema = z.enum(['telegram', 'email', 'webhook']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

// ─── NotificationStatus ───────────────────────────────────────────────────────

/**
 * Statut d'envoi d'une notification.
 * - `pending`  : en attente d'envoi
 * - `sent`     : envoyée avec succès
 * - `failed`   : échec d'envoi (avec raison dans `error`)
 * - `skipped`  : ignorée (déjà envoyée, BC déjà vu, seuil non atteint)
 */
export const NotificationStatusSchema = z.enum(['pending', 'sent', 'failed', 'skipped']);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

// ─── NotificationPayload ──────────────────────────────────────────────────────

/**
 * Payload complet d'une notification Anaho.
 *
 * Construit après scoring, avant envoi.
 * Contient toutes les informations nécessaires pour générer le message.
 *
 * - `bc_id`          : ID du BC concerné
 * - `client_id`      : ID du client destinataire
 * - `score`          : score final (0–100)
 * - `matched_criteres` : libellés des critères matchés (pour le message)
 * - `bc_objet`       : objet du BC (titre)
 * - `bc_organisme`   : organisme émetteur
 * - `bc_wilaya`      : région du BC
 * - `bc_date_limite` : date limite de soumission
 * - `bc_url`         : URL de la fiche BC sur le portail
 * - `bc_montant`     : montant estimé (null si non renseigné)
 * - `channel`        : canal d'envoi
 * - `telegram_chat_id` : identifiant du chat Telegram (si canal = telegram)
 * - `status`         : statut d'envoi
 * - `error`          : message d'erreur si status = failed
 * - `sent_at`        : timestamp d'envoi effectif
 * - `created_at`     : timestamp de création du payload
 */
export const NotificationPayloadSchema = z.object({
  bc_id:              z.string().min(1),
  client_id:          z.string().min(1),
  score:              z.number().min(0).max(100),
  matched_criteres:   z.array(z.string()).default([]),
  bc_objet:           z.string().default(''),
  bc_organisme:       z.string().default(''),
  bc_wilaya:          z.string().default(''),
  bc_date_limite:     z.string().default(''),
  bc_url:             z.string().url(),
  bc_montant:         z.number().positive().nullable().default(null),
  channel:            NotificationChannelSchema,
  telegram_chat_id:   z.string().optional(),
  status:             NotificationStatusSchema.default('pending'),
  error:              z.string().optional(),
  sent_at:            z.string().datetime().optional(),
  created_at:         z.string().datetime(),
});

export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

// ─── NotificationRecord ───────────────────────────────────────────────────────

/**
 * Enregistrement persisté d'une notification (pour l'historique et la déduplication).
 * Étend NotificationPayload avec un `id` et un `feedback_id` optionnel.
 */
export const NotificationRecordSchema = NotificationPayloadSchema.extend({
  id:           z.string().min(1),
  feedback_id:  z.string().optional(),
});

export type NotificationRecord = z.infer<typeof NotificationRecordSchema>;

// ─── NotificationStats ────────────────────────────────────────────────────────

/**
 * Statistiques d'envoi pour une période donnée.
 */
export const NotificationStatsSchema = z.object({
  client_id:  z.string().min(1),
  period:     z.string().min(1),
  sent:       z.number().int().min(0),
  failed:     z.number().int().min(0),
  skipped:    z.number().int().min(0),
  total:      z.number().int().min(0),
});

export type NotificationStats = z.infer<typeof NotificationStatsSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Valide et parse un payload de notification brut.
 */
export const safeParseNotificationPayload = (raw: unknown) =>
  NotificationPayloadSchema.safeParse(raw);

/**
 * Formate un message Telegram court à partir d'un payload.
 * Format : ligne objet + organisme + score + URL.
 */
export function formatTelegramMessage(payload: NotificationPayload): string {
  const lines: string[] = [
    `🎯 *Nouveau BC pertinent* — Score ${payload.score}/100`,
    '',
    `📋 *${payload.bc_objet || 'Objet non renseigné'}*`,
    `🏛 ${payload.bc_organisme || 'Organisme non renseigné'}`,
    `📍 ${payload.bc_wilaya || 'Wilaya non renseignée'}`,
  ];

  if (payload.bc_date_limite) {
    lines.push(`⏰ Date limite : ${payload.bc_date_limite}`);
  }

  if (payload.bc_montant !== null) {
    lines.push(`💰 Montant estimé : ${payload.bc_montant.toLocaleString('fr-MA')} MAD`);
  }

  if (payload.matched_criteres.length > 0) {
    lines.push(`\n🔍 Critères matchés : ${payload.matched_criteres.join(', ')}`);
  }

  lines.push(`\n🔗 [Voir le BC](${payload.bc_url})`);

  return lines.join('\n');
}
