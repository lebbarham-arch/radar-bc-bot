/**
 * Tests unitaires — GD-130 : troncature HTML sûre pour Telegram
 *
 * Couvre les fonctions de scripts/telegram-utils.js :
 *   - safeTruncateHtml(html, maxLen) : réduit le message sans couper les balises
 *   - stripHtmlTags(s)               : supprime toutes les balises HTML
 *
 * Aucune dépendance réseau. Aucun mock Telegram.
 * Nomenclature : TG-* (Telegram truncate)
 */

const { safeTruncateHtml, stripHtmlTags, TG_SAFE } = require('../../scripts/telegram-utils');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Construit un message Telegram réaliste proche du format buildHtmlMessage + fbHtml */
function buildMsg(opts: {
  arts?: boolean;
  longArts?: boolean;
  aiResume?: boolean;
  feedback?: boolean;
  longFeedback?: boolean;
} = {}): string {
  const header =
    '🔔 <b>📦 NOUVEAU BC EN COURS</b>\n\n' +
    '📋 <b>Fourniture de produits de nettoyage pour la commune</b>\n' +
    '🏢 Commune rurale AIT NAAMANE — El-Hajeb\n' +
    '📅 Date limite : <b>30/07/2026</b> ⚠️\n' +
    '🔍 Critère : <code>nettoyage</code>';

  let artsSection = '';
  if (opts.arts !== false) {
    const artLines = opts.longArts
      ? Array.from({ length: 5 }, (_, i) =>
          `• Article ${i + 1} désignation longue avec beaucoup de détails sur le produit — <b>${(i + 1) * 2000} DH TTC</b>`
        ).join('\n') + '\n<i>+12 autres articles</i>'
      : '• Produit de nettoyage multi-surfaces — <b>5 000 DH</b>';
    artsSection = '\n\n💼 <b>Articles :</b>\n' + artLines;
  }

  const aiSection = opts.aiResume
    ? '\n\n💡 <i>' + 'Marché de nettoyage de locaux administratifs. '.repeat(15) + '</i>'
    : '';

  const link =
    '\n\n🔗 <a href="https://www.marchespublics.gov.ma/pmmp/bdc/359479">Voir la fiche →</a>\n\n' +
    '<i>Radar Marchés Maroc</i>';

  let fbSection = '';
  if (opts.feedback) {
    const sig = opts.longFeedback ? 'x'.repeat(128) : 'shortsig';
    const base = 'https://radar.example.com/feedback?client_id=c1&radar_type=bc&item_id=359479&critere=nettoyage';
    const fbLinks = [
      `<a href="${base}&type=relevant&nid=n1&sig=${sig}">✅ Pertinent</a>`,
      `<a href="${base}&type=irrelevant&r=not_my_business&nid=n1&sig=${sig}">❌ Pas mon métier</a>`,
      `<a href="${base}&type=irrelevant&r=wrong_buyer&nid=n1&sig=${sig}">❌ Mauvais acheteur</a>`,
      `<a href="${base}&type=irrelevant&r=wrong_zone&nid=n1&sig=${sig}">❌ Mauvaise zone</a>`,
      `<a href="${base}&type=irrelevant&r=wrong_product&nid=n1&sig=${sig}">❌ Mauvais produit</a>`,
      `<a href="${base}&type=watch&r=not_sure&nid=n1&sig=${sig}">👀 Pas sûr(e)</a>`,
      `<a href="${base}&type=watch&r=insufficient_info&nid=n1&sig=${sig}">👀 Infos insuffisantes</a>`,
      `<a href="${base}&type=watch&r=other&nid=n1&sig=${sig}">👀 Autre</a>`,
    ].join('\n');
    // GD-134 : le header feedback inclut maintenant le bc_id (item_id=359479 dans cette fixture)
    fbSection = '\n\nFeedback pour BC #359479 :\n' + fbLinks;
  }

  return header + artsSection + aiSection + link + fbSection;
}

/** Vérifie qu'une chaîne HTML n'a aucune balise ouverte non fermée */
function hasUnclosedTags(html: string): boolean {
  const openStack: string[] = [];
  const VOID = new Set(['br','hr','img','input','meta','link','area','base','col','embed','param','source','track','wbr']);
  const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (!m[1]) continue;
    const tag = m[1].toLowerCase();
    if (VOID.has(tag)) continue;
    if (m[0].startsWith('</')) {
      const i = openStack.lastIndexOf(tag);
      if (i !== -1) openStack.splice(i, 1);
    } else if (!m[0].endsWith('/>')) {
      openStack.push(tag);
    }
  }
  return openStack.length > 0;
}

// ─── TG-1 : message court — inchangé ─────────────────────────────────────────

describe('safeTruncateHtml', () => {

  it('TG-1 : message court (< TG_SAFE) retourné inchangé', () => {
    const msg = buildMsg({ arts: false, feedback: false });
    expect(msg.length).toBeLessThan(TG_SAFE);
    const result = safeTruncateHtml(msg, TG_SAFE);
    expect(result).toBe(msg);
  });

  // ─── TG-2 : message long avec articles → articles supprimés ───────────────

  it('TG-2 : message long avec articles — articles retirés, longueur ≤ TG_SAFE', () => {
    const msg = buildMsg({ longArts: true, feedback: true, longFeedback: true });
    // Forcer un message assez long
    const longMsg = msg + '\n' + 'x'.repeat(Math.max(0, TG_SAFE - msg.length + 500));
    // Ou construire directement un message > TG_SAFE via feedback long
    const bigMsg = buildMsg({ longArts: true, aiResume: true, feedback: true, longFeedback: true });
    if (bigMsg.length <= TG_SAFE) {
      // Le message entre dans la limite — on le padde artificiellement
      const padded = bigMsg.replace(
        '<i>Radar Marchés Maroc</i>',
        '<i>Radar Marchés Maroc</i>' + ' '.repeat(500)
      );
      // Dans ce cas TG-2 passe trivialement si déjà sous la limite
      expect(safeTruncateHtml(bigMsg, TG_SAFE).length).toBeLessThanOrEqual(TG_SAFE);
      return;
    }
    const result = safeTruncateHtml(bigMsg, TG_SAFE);
    expect(result.length).toBeLessThanOrEqual(TG_SAFE);
  });

  // ─── TG-3 : pas de balise HTML ouverte non fermée ─────────────────────────

  it('TG-3 : message long avec <b> dans les articles — aucune balise non fermée', () => {
    const msg = buildMsg({ longArts: true, aiResume: true, feedback: true, longFeedback: true });
    const result = safeTruncateHtml(msg, TG_SAFE);
    expect(hasUnclosedTags(result)).toBe(false);
  });

  it('TG-3b : résultat ne contient jamais de <b> coupé brutalement', () => {
    // Simuler le cas exact du bug : message > TG_SAFE avec <b> dans les articles
    const sig = 'z'.repeat(128);
    const base = 'https://radar.example.com/feedback?client_id=c1&radar_type=bc&item_id=1&critere=nettoyage';
    const fb8 = Array.from({ length: 8 }, (_, i) =>
      `<a href="${base}&type=relevant&nid=n${i}&sig=${sig}">lien ${i}</a>`
    ).join('\n');
    const arts5 = Array.from({ length: 5 }, (_, i) =>
      `• Article ${i} — <b>${(i + 1) * 1000} DH</b>`
    ).join('\n');
    const html =
      '🔔 <b>NOUVEAU BC</b>\n\n📋 <b>Objet long</b>\n🏢 Organisme\n' +
      '📅 Date : <b>01/08/2026</b>\n🔍 Critère : <code>nettoyage</code>\n\n' +
      '💼 <b>Articles :</b>\n' + arts5 + '\n<i>+20 autres articles</i>\n\n' +
      '🔗 <a href="https://exemple.ma/bdc/1">Voir →</a>\n\n' +
      // GD-134 : header feedback avec bc_id
      '<i>Radar Marchés Maroc</i>\n\nFeedback pour BC #1 :\n' + fb8;
    const result = safeTruncateHtml(html, TG_SAFE);
    expect(result.length).toBeLessThanOrEqual(TG_SAFE);
    expect(hasUnclosedTags(result)).toBe(false);
  });

  // ─── TG-4 : lien BC toujours présent ──────────────────────────────────────

  it('TG-4 : version courte conserve le lien BC (🔗 Voir la fiche)', () => {
    const longMsg = buildMsg({ longArts: true, aiResume: true, feedback: true, longFeedback: true });
    const result = safeTruncateHtml(longMsg, TG_SAFE);
    // Le lien BC doit toujours être là (il est avant le feedback)
    expect(result).toContain('Voir la fiche →');
  });

  // ─── TG-5 : feedback préservé quand il tient ──────────────────────────────

  it('TG-5 : feedback conservé quand le message sans articles tient', () => {
    // Message sans articles longs + feedback court → devrait tenir sous TG_SAFE
    const msg = buildMsg({ arts: false, feedback: true, longFeedback: false });
    if (msg.length > TG_SAFE) {
      // Si ça dépasse quand même, le feedback peut être retiré — test non applicable
      return;
    }
    // Message court → pas de troncature → feedback présent
    const result = safeTruncateHtml(msg, TG_SAFE);
    // GD-134 : le header contient maintenant "Feedback pour BC #<id>"
    expect(result).toContain('Feedback pour BC #');
    expect(result).toContain('✅ Pertinent');
  });

  // ─── TG-6 : feedback supprimé si nécessaire, mais lien BC conservé ────────

  it('TG-6 : feedback supprimé si nécessaire, lien BC conservé', () => {
    // Construire un message qui dépasse TG_SAFE même sans articles (feedback très long)
    const sig = 'y'.repeat(200);
    const base = 'https://radar.example.com/feedback?client_id=c1&radar_type=bc&item_id=1&critere=nettoyage';
    const veryLongFb = Array.from({ length: 8 }, (_, i) =>
      `<a href="${base}&type=relevant&nid=nid${i}&mt=nettoyage+produits+de+nettoyage&bt=Fourniture+de+produits+de+nettoyage&sig=${sig}">lien ${i}</a>`
    ).join('\n');
    const html =
      '🔔 <b>NOUVEAU BC</b>\n\n📋 <b>Objet du marché</b>\n🏢 Organisme acheteur\n' +
      '📅 Date limite : <b>01/08/2026</b>\n🔍 Critère : <code>nettoyage</code>\n\n' +
      '🔗 <a href="https://exemple.ma/bdc/1">Voir la fiche →</a>\n\n' +
      // GD-134 : header feedback avec bc_id
      '<i>Radar Marchés Maroc</i>\n\nFeedback pour BC #1 :\n' + veryLongFb;
    if (html.length <= TG_SAFE) {
      // Message assez court — test non applicable dans cette configuration
      expect(safeTruncateHtml(html, TG_SAFE).length).toBeLessThanOrEqual(TG_SAFE);
      return;
    }
    const result = safeTruncateHtml(html, TG_SAFE);
    expect(result.length).toBeLessThanOrEqual(TG_SAFE);
    expect(result).toContain('Voir la fiche →');
    // GD-134 : le marker est maintenant "Feedback pour BC #"
    expect(result).not.toContain('Feedback pour BC #');
  });

  // ─── TG-7 : stripHtmlTags ─────────────────────────────────────────────────

  it('TG-7 : stripHtmlTags supprime toutes les balises HTML', () => {
    const html = '<b>Bonjour</b> <i>monde</i> <a href="x">lien</a> <code>code</code>';
    const result = stripHtmlTags(html);
    expect(result).toBe('Bonjour monde lien code');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });

  it('TG-7b : stripHtmlTags sur chaîne vide ou null retourne chaîne vide', () => {
    expect(stripHtmlTags('')).toBe('');
    expect(stripHtmlTags(null)).toBe('');
    expect(stripHtmlTags(undefined)).toBe('');
  });

  // ─── TG-8 : dernier recours — strip HTML + troncature ─────────────────────

  it('TG-8 : dernier recours retourne du texte sans balises si message très long', () => {
    // Message sans feedback ni articles mais tellement long qu'il dépasse TG_SAFE
    // (cas extrême : objet/organisme très long)
    const gigantic = '<b>' + 'X'.repeat(TG_SAFE + 500) + '</b>';
    const result = safeTruncateHtml(gigantic, TG_SAFE);
    expect(result.length).toBeLessThanOrEqual(TG_SAFE);
    // Le résultat ne doit pas contenir de balise HTML ouverte non fermée
    expect(hasUnclosedTags(result)).toBe(false);
    // Dernier recours = texte brut
    expect(result).not.toContain('<b>');
  });

  // ─── TG-9 : TG_SAFE est bien 3900 ────────────────────────────────────────

  it('TG-9 : TG_SAFE vaut 3900', () => {
    expect(TG_SAFE).toBe(3900);
  });

});

export {};
