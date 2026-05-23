/**
 * Tests — notification.schema.ts
 *
 * Couvre :
 *   - NotificationChannelSchema  : enum strict
 *   - NotificationStatusSchema   : enum strict
 *   - NotificationPayloadSchema  : validation complète, defaults
 *   - formatTelegramMessage()    : format du message, champs optionnels
 *   - safeParseNotificationPayload : échec propre
 */

import {
  NotificationChannelSchema,
  NotificationStatusSchema,
  NotificationPayloadSchema,
  NotificationRecordSchema,
  safeParseNotificationPayload,
  formatTelegramMessage,
  type NotificationPayload,
} from '@core/schemas/notification.schema';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

const VALID_PAYLOAD_RAW = {
  bc_id:            'BC-001',
  client_id:        'client-001',
  score:            78,
  matched_criteres: ['câble réseau'],
  bc_objet:         'Fourniture câbles réseau',
  bc_organisme:     'DGSI',
  bc_wilaya:        'Rabat-Salé-Kénitra',
  bc_date_limite:   '30/06/2024',
  bc_url:           'https://www.marchespublics.gov.ma/bdc/entreprise/consultation/show/42',
  bc_montant:       null,
  channel:          'telegram' as const,
  telegram_chat_id: '-1001234567890',
  status:           'pending' as const,
  created_at:       NOW,
};

// ─── NotificationChannelSchema ────────────────────────────────────────────────

describe('NotificationChannelSchema', () => {
  it('accepte telegram, email, webhook', () => {
    expect(NotificationChannelSchema.safeParse('telegram').success).toBe(true);
    expect(NotificationChannelSchema.safeParse('email').success).toBe(true);
    expect(NotificationChannelSchema.safeParse('webhook').success).toBe(true);
  });

  it('rejette une valeur inconnue', () => {
    expect(NotificationChannelSchema.safeParse('sms').success).toBe(false);
    expect(NotificationChannelSchema.safeParse('').success).toBe(false);
  });
});

// ─── NotificationStatusSchema ─────────────────────────────────────────────────

describe('NotificationStatusSchema', () => {
  it('accepte pending, sent, failed, skipped', () => {
    const statuses = ['pending', 'sent', 'failed', 'skipped'];
    for (const s of statuses) {
      expect(NotificationStatusSchema.safeParse(s).success).toBe(true);
    }
  });

  it('rejette une valeur inconnue', () => {
    expect(NotificationStatusSchema.safeParse('delivered').success).toBe(false);
  });
});

// ─── NotificationPayloadSchema ────────────────────────────────────────────────

describe('NotificationPayloadSchema', () => {
  it('valide un payload complet', () => {
    expect(NotificationPayloadSchema.safeParse(VALID_PAYLOAD_RAW).success).toBe(true);
  });

  it('rejette si bc_id manquant', () => {
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, bc_id: '' }).success).toBe(false);
  });

  it('rejette si bc_url invalide', () => {
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, bc_url: 'pas-url' }).success).toBe(false);
  });

  it('rejette score hors [0, 100]', () => {
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, score: -1 }).success).toBe(false);
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, score: 101 }).success).toBe(false);
  });

  it('accepte score à 0 et 100', () => {
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, score: 0 }).success).toBe(true);
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, score: 100 }).success).toBe(true);
  });

  it('rejette bc_montant négatif ou zéro', () => {
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, bc_montant: 0 }).success).toBe(false);
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, bc_montant: -500 }).success).toBe(false);
  });

  it('accepte bc_montant positif', () => {
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, bc_montant: 150000 }).success).toBe(true);
  });

  it('accepte bc_montant null', () => {
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, bc_montant: null }).success).toBe(true);
  });

  it('applique status default "pending"', () => {
    const { status: _s, ...withoutStatus } = VALID_PAYLOAD_RAW;
    const result = NotificationPayloadSchema.safeParse(withoutStatus);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe('pending');
  });

  it('applique matched_criteres default []', () => {
    const { matched_criteres: _mc, ...withoutMc } = VALID_PAYLOAD_RAW;
    const result = NotificationPayloadSchema.safeParse(withoutMc);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.matched_criteres).toEqual([]);
  });

  it('telegram_chat_id est optionnel', () => {
    const { telegram_chat_id: _tg, ...withoutTg } = VALID_PAYLOAD_RAW;
    expect(NotificationPayloadSchema.safeParse(withoutTg).success).toBe(true);
  });

  it('sent_at est optionnel', () => {
    const result = NotificationPayloadSchema.safeParse(VALID_PAYLOAD_RAW);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sent_at).toBeUndefined();
  });

  it('rejette si created_at n\'est pas un datetime ISO', () => {
    expect(NotificationPayloadSchema.safeParse({ ...VALID_PAYLOAD_RAW, created_at: '01/01/2024' }).success).toBe(false);
  });
});

// ─── NotificationRecordSchema ─────────────────────────────────────────────────

describe('NotificationRecordSchema', () => {
  it('valide un record avec id', () => {
    const result = NotificationRecordSchema.safeParse({ ...VALID_PAYLOAD_RAW, id: 'notif-001' });
    expect(result.success).toBe(true);
  });

  it('rejette si id manquant', () => {
    expect(NotificationRecordSchema.safeParse({ ...VALID_PAYLOAD_RAW, id: '' }).success).toBe(false);
  });

  it('feedback_id est optionnel', () => {
    const result = NotificationRecordSchema.safeParse({ ...VALID_PAYLOAD_RAW, id: 'notif-001' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.feedback_id).toBeUndefined();
  });
});

// ─── safeParseNotificationPayload ─────────────────────────────────────────────

describe('safeParseNotificationPayload', () => {
  it('ne lance pas d\'exception sur entrée invalide', () => {
    expect(() => safeParseNotificationPayload(null)).not.toThrow();
    expect(safeParseNotificationPayload(null).success).toBe(false);
  });

  it('retourne success: true pour un payload valide', () => {
    expect(safeParseNotificationPayload(VALID_PAYLOAD_RAW).success).toBe(true);
  });
});

// ─── formatTelegramMessage ────────────────────────────────────────────────────

describe('formatTelegramMessage', () => {
  const payload = NotificationPayloadSchema.parse(VALID_PAYLOAD_RAW) as NotificationPayload;

  it('contient le score', () => {
    const msg = formatTelegramMessage(payload);
    expect(msg).toContain('78/100');
  });

  it('contient l\'objet du BC', () => {
    const msg = formatTelegramMessage(payload);
    expect(msg).toContain('Fourniture câbles réseau');
  });

  it('contient l\'organisme', () => {
    const msg = formatTelegramMessage(payload);
    expect(msg).toContain('DGSI');
  });

  it('contient la wilaya', () => {
    const msg = formatTelegramMessage(payload);
    expect(msg).toContain('Rabat-Salé-Kénitra');
  });

  it('contient la date limite si définie', () => {
    const msg = formatTelegramMessage(payload);
    expect(msg).toContain('30/06/2024');
  });

  it('contient le lien vers le BC', () => {
    const msg = formatTelegramMessage(payload);
    expect(msg).toContain('marchespublics.gov.ma');
  });

  it('contient les critères matchés', () => {
    const msg = formatTelegramMessage(payload);
    expect(msg).toContain('câble réseau');
  });

  it('affiche le montant si défini', () => {
    const withMontant = NotificationPayloadSchema.parse({
      ...VALID_PAYLOAD_RAW, bc_montant: 150000,
    }) as NotificationPayload;
    const msg = formatTelegramMessage(withMontant);
    expect(msg).toContain('150');
  });

  it('n\'affiche pas le montant si null', () => {
    const msg = formatTelegramMessage(payload);
    expect(msg).not.toContain('MAD');
  });

  it('gère les champs vides sans crash', () => {
    const minimal = NotificationPayloadSchema.parse({
      bc_id: 'BC-MIN', client_id: 'c-1', score: 42,
      bc_url: 'https://marchespublics.gov.ma/bdc/entreprise/consultation/show/0',
      channel: 'telegram', created_at: NOW,
    }) as NotificationPayload;

    expect(() => formatTelegramMessage(minimal)).not.toThrow();
    const msg = formatTelegramMessage(minimal);
    expect(msg).toContain('42/100');
  });
});
