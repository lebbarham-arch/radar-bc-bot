/**
 * notification-quality-gate.ts
 *
 * Couche de filtrage générique avant envoi de notification.
 * Décide si un match doit être autorisé, bloqué ou abaissé en avertissement.
 *
 * PRINCIPES :
 *  - Aucune modification de la DB, des critères ou du scoring.
 *  - En cas de doute, on préfère laisser passer (décision "warn" plutôt que "block").
 *  - Les règles sont déterministes et entièrement testables sans réseau.
 *
 * INTÉGRATION (radar-bc-bot.js) :
 *  juste avant sendTelegram() / sendWhatsApp() / sendEmail() :
 *    const gate = checkNotificationQuality({ ... });
 *    if (gate.decision === 'block') { /* snapshot blocked_quality_gate, continue *‌/ }
 *    // warn → autoriser + logger
 */

import { validateCritereLabel } from '@core/onboarding/criteria-label-guard';

// ─── Types ────────────────────────────────────────────────────────────────────

export type GateDecision = 'allow' | 'warn' | 'block';

export interface QualityGateInput {
  /** Valeur du critère ayant matché (ex: "eau", "toner") */
  critere_valeur:   string;
  /** Objet de l'avis BC */
  objet:            string;
  /** Texte complet de l'avis (body) */
  bodyText?:        string;
  /** Termes qui ont déclenché le match (inclusions enrichies ou valeur brute) */
  matched_terms?:   string[];
  /** Score existant (0-100) si disponible */
  score?:           number | null;
  /** Type radar ('bc' | 'mp') */
  radar_type?:      string;
  /** Vrai si l'avis a déjà été identifié comme annulé */
  is_cancelled?:    boolean;
}

export interface QualityGateResult {
  decision: GateDecision;
  reason:   string;
  signals:  string[];
}

// ─── Contextes métier forts par label générique ───────────────────────────────
//
// Si l'objet ou le body contient l'un de ces termes, le critère est considéré
// comme contextualisé → le bloc générique ne s'applique pas.

const STRONG_CONTEXTS: Record<string, string[]> = {
  eau: [
    'eau potable', 'point d eau', 'adduction', 'pompe',  'forage',
    'reseau d eau', 'assainissement', 'traitement des eaux', 'plomberie',
    'distribution d eau', 'citerne',
  ],
  informatique: [
    'serveur', 'reseau', 'ordinateur', 'imprimante', 'logiciel',
    'materiel informatique', 'switch', 'firewall', 'onduleur',
    'infrastructure', 'systeme d information', 'si ', 'datacenter',
    'virtualisation', 'stockage',
  ],
  cafe: [
    'cafe moulu', 'cafe en grains', 'capsule', 'dosette',
    'machine a cafe', 'boissons chaudes', 'distributeur de boissons',
  ],
  maintenance: [
    'maintenance preventive', 'maintenance corrective', 'contrat de maintenance',
    'entretien technique', 'curatif', 'preventif',
  ],
  nettoyage: [
    'nettoyage des locaux', 'nettoyage industriel', 'entretien des locaux',
    'hygiene', 'desinfection', 'produits d entretien',
  ],
  securite: [
    'securite incendie', 'surveillance', 'gardiennage', 'telesurveillance',
    'controle d acces', 'alarme', 'detection incendie',
  ],
  transport: [
    'transport de personnes', 'transport de marchandises', 'logistique',
    'demenagement', 'livraison', 'vehicule', 'flotte',
  ],
};

// ─── Termes hors-périmètre (si présents sans contexte fort → block/warn) ─────

const OFF_SCOPE_TERMS: string[] = [
  'restauration', 'hebergement', 'reception', 'evenement', 'traiteur',
  'hotellerie', 'seminaire', 'conference', 'banquet', 'cocktail',
  'location de salle', 'animation',
];

// ─── Labels que l'on ne bloque JAMAIS si le contexte impression est clair ────

const IMPRESSION_SAFE: string[] = [
  'toner', 'toner photocopieur', 'toner laser', 'cartouche toner',
  'imprimante', 'photocopieur', 'multifonction', 'reprographie',
];

const IMPRESSION_CONTEXT: string[] = [
  'toner', 'cartouche', 'imprimante', 'photocopieur', 'reprographie',
  'laser', 'impression', 'multifonction', 'encre',
];

// ─── Nettoyage du texte : suppression des métadonnées portail ────────────────
//
// Le portail BC ajoute après le vrai contenu des blocs administratifs du type :
//   "DÉTAILS  Acheteur public : ...  Date limite : ...  Date de réception : ..."
// Ces métadonnées contiennent des mots comme "reception" qui ne doivent pas
// déclencher les règles hors-périmètre.

const PORTAL_CUTOFF_MARKERS: string[] = [
  'DÉTAILS', 'DETAILS',
  'Acheteur public',
  'Date mise en ligne',
  'Date limite',
  "Lieu d'exécution",
  "Date de réception",
];

/**
 * Retourne uniquement la partie métier du texte,
 * en coupant au premier marqueur administratif portail trouvé.
 */
export function cleanBusinessText(text: string): string {
  if (!text) return '';
  let result = text;
  for (const marker of PORTAL_CUTOFF_MARKERS) {
    const idx = result.indexOf(marker);
    if (idx !== -1) {
      result = result.slice(0, idx);
    }
  }
  return result.trim();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsAny(text: string, terms: string[]): string | null {
  const n = norm(text);
  for (const t of terms) {
    if (n.includes(norm(t))) return t;
  }
  return null;
}

function getStrongContextTerms(labelNorm: string): string[] {
  // Cherche dans STRONG_CONTEXTS par correspondance exacte ou partielle du label
  for (const key of Object.keys(STRONG_CONTEXTS)) {
    if (labelNorm === norm(key) || labelNorm.startsWith(norm(key))) {
      return STRONG_CONTEXTS[key]!;
    }
  }
  return [];
}

// ─── Gate principale ─────────────────────────────────────────────────────────

/**
 * Évalue la qualité d'une notification avant envoi.
 *
 * @param input  Contexte du match (critère, objet, body, termes matchés…)
 * @returns      { decision, reason, signals }
 */
export function checkNotificationQuality(input: QualityGateInput): QualityGateResult {
  const signals: string[] = [];

  const valeur         = input.critere_valeur || '';
  const objetRaw       = input.objet          || '';
  const bodyRaw        = input.bodyText        || '';
  // Textes nettoyés : coupés avant les métadonnées portail
  const objet          = cleanBusinessText(objetRaw);
  const body           = cleanBusinessText(bodyRaw);
  const fullText       = objet + ' ' + body;
  const labelNorm      = norm(valeur);
  const matchTerms     = (input.matched_terms || []).map(norm);

  // ── Règle 0 : avis annulé ────────────────────────────────────────────────
  if (input.is_cancelled) {
    return {
      decision: 'block',
      reason:   'Avis annule detecte avant envoi',
      signals:  ['is_cancelled = true'],
    };
  }

  // ── Règle 1 : protection toner/impression ────────────────────────────────
  // Si l'objet ou les termes matchés contiennent un indicateur impression fort
  // → jamais bloqué, même si le critère seul serait générique.
  const isSafeImpression = IMPRESSION_SAFE.some(s => labelNorm.includes(norm(s)));
  if (isSafeImpression || IMPRESSION_SAFE.some(s => matchTerms.includes(norm(s)))) {
    const hasImprContext = containsAny(fullText, IMPRESSION_CONTEXT);
    if (hasImprContext) {
      return { decision: 'allow', reason: 'Contexte impression clair', signals: [] };
    }
  }

  // ── Règle 2 : label guard ────────────────────────────────────────────────
  const guard = validateCritereLabel(valeur);

  if (guard.level === 'block') {
    // Cherche contexte métier fort dans l'objet/body
    const ctxTerms = getStrongContextTerms(labelNorm);
    const strongCtx = ctxTerms.length > 0 ? containsAny(fullText, ctxTerms) : null;

    if (strongCtx) {
      signals.push('label block mais contexte fort detecte : "' + strongCtx + '"');
      // Vérifie quand même hors-périmètre
      const offScope = containsAny(objet, OFF_SCOPE_TERMS);
      if (offScope) {
        signals.push('terme hors-perimetre malgre contexte fort : "' + offScope + '"');
        return {
          decision: 'block',
          reason:   'Label block + terme hors-perimetre : "' + offScope + '"',
          signals,
        };
      }
      return { decision: 'allow', reason: 'Label block mais contexte metier fort', signals };
    }

    // Pas de contexte fort → cherche terme hors-périmètre
    const offScope = containsAny(objet, OFF_SCOPE_TERMS);
    if (offScope) {
      signals.push('terme hors-perimetre : "' + offScope + '"');
      return {
        decision: 'block',
        reason:   'Label block + terme hors-perimetre : "' + offScope + '"',
        signals,
      };
    }

    // Label block générique sans contexte → block
    signals.push('label block generique : "' + valeur + '"');
    return {
      decision: 'block',
      reason:   'Critere trop generique sans contexte metier fort ("' + valeur + '")',
      signals,
    };
  }

  if (guard.level === 'warn') {
    const ctxTerms = getStrongContextTerms(labelNorm);
    const strongCtx = ctxTerms.length > 0 ? containsAny(fullText, ctxTerms) : null;

    if (strongCtx) {
      signals.push('label warn mais contexte fort : "' + strongCtx + '"');
      return { decision: 'allow', reason: 'Label warn avec contexte metier fort', signals };
    }

    const offScope = containsAny(objet, OFF_SCOPE_TERMS);
    if (offScope) {
      signals.push('label warn + hors-perimetre : "' + offScope + '"');
      return {
        decision: 'block',
        reason:   'Label warn + terme hors-perimetre : "' + offScope + '"',
        signals,
      };
    }

    signals.push('label warn sans contexte fort pour "' + valeur + '"');
    return {
      decision: 'warn',
      reason:   'Critere ambigu sans contexte metier fort ("' + valeur + '") — verifier',
      signals,
    };
  }

  // ── Règle 3 : objet vide ou sans rapport avec le critère ─────────────────
  if (!objet.trim()) {
    signals.push('objet vide');
    return {
      decision: 'warn',
      reason:   'Objet vide — impossible de verifier la pertinence',
      signals,
    };
  }

  const objetNorm = norm(objet);
  const critereMentionned = objetNorm.includes(labelNorm)
    || matchTerms.some(t => objetNorm.includes(t));

  if (!critereMentionned && matchTerms.length === 0) {
    signals.push('critere absent de l objet et aucun matched_term');
    return {
      decision: 'warn',
      reason:   'Objet ne contient ni le critere ni un terme matche — verifier',
      signals,
    };
  }

  // ── Tout OK ───────────────────────────────────────────────────────────────
  return { decision: 'allow', reason: 'Aucun signal bloquant', signals: [] };
}
