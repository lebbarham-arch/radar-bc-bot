/**
 * Scoring Engine — Anaho V1
 *
 * Moteur de scoring déterministe et explicable pour les bons de commande.
 * Aucune IA, aucun embedding, aucune API externe.
 * Chaque point de score est justifié par une règle explicite.
 *
 * Architecture du score (max 100) :
 * ┌─────────────────────────────────┬──────┐
 * │ Composant                       │  Max │
 * ├─────────────────────────────────┼──────┤
 * │ title_score       (objet BC)    │   10 │
 * │ content_score     (bodyText)    │   10 │
 * │ article_score     (articles)    │   40 │  ← poids dominant
 * │ business_intent_score           │   20 │
 * │ technical_score   (specs)       │   15 │
 * │ organization_score              │    5 │
 * ├─────────────────────────────────┼──────┤
 * │ TOTAL POSITIF MAX               │  100 │
 * │ contextual_exclusion_penalty    │  −50 │
 * └─────────────────────────────────┴──────┘
 *
 * Décision finale :
 *   notify  — score ≥ seuil du pack (starter 50 / pro 40 / business 35)
 *   rerank  — score ≥ 20 et < seuil
 *   ignore  — score < 20
 *
 * Règles fondamentales :
 *   - Les articles pèsent plus que le titre
 *   - Business intent et technical intent sont séparés
 *   - Les exclusions sont contextuelles (jamais lexicales)
 *   - "achat" ne rejette jamais automatiquement un BC
 */

import { type ParsedBC } from '@core/schemas/bc.schema';
import { type ClientProfile, type Critere } from '@core/schemas/client.schema';
import { matchKeyword, normalizeText, type MatchTrigger } from './matchers';

// ─── Détection d'intention ────────────────────────────────────────────────────

export type BCIntent =
  | 'maintenance'
  | 'installation'
  | 'fourniture'
  | 'travaux'
  | 'mixed'
  | 'unknown';

/**
 * Mots-clés associés à chaque type d'intention.
 * Chaque terme compte pour 1 vote lors de la détection.
 * Les termes forts (pièces de rechange, dépannage) comptent pour 2.
 */
const INTENT_VOTES: Record<string, { intent: string; weight: number }[]> = {
  'maintenance':           [{ intent: 'maintenance',  weight: 2 }],
  'entretien':             [{ intent: 'maintenance',  weight: 2 }],
  'pieces de rechange':    [{ intent: 'maintenance',  weight: 2 }],
  'pdr':                   [{ intent: 'maintenance',  weight: 1 }],
  'depannage':             [{ intent: 'maintenance',  weight: 2 }],
  'reparation':            [{ intent: 'maintenance',  weight: 2 }],
  'revision':              [{ intent: 'maintenance',  weight: 1 }],
  'sav':                   [{ intent: 'maintenance',  weight: 1 }],
  'piece detachee':        [{ intent: 'maintenance',  weight: 2 }],
  'installation':          [{ intent: 'installation', weight: 2 }],
  'mise en place':         [{ intent: 'installation', weight: 2 }],
  'mise en service':       [{ intent: 'installation', weight: 2 }],
  'deploiement':           [{ intent: 'installation', weight: 1 }],
  'montage':               [{ intent: 'installation', weight: 1 }],
  'fourniture':            [{ intent: 'fourniture',   weight: 1 }],
  'acquisition':           [{ intent: 'fourniture',   weight: 1 }],
  'achat':                 [{ intent: 'fourniture',   weight: 1 }],   // ← poids faible, jamais exclu
  'approvisionnement':     [{ intent: 'fourniture',   weight: 1 }],
  'livraison':             [{ intent: 'fourniture',   weight: 1 }],
  'travaux':               [{ intent: 'travaux',      weight: 2 }],
  'construction':          [{ intent: 'travaux',      weight: 2 }],
  'renovation':            [{ intent: 'travaux',      weight: 2 }],
  'amenagement':           [{ intent: 'travaux',      weight: 1 }],
  'genie civil':           [{ intent: 'travaux',      weight: 2 }],
  'batiment':              [{ intent: 'travaux',      weight: 1 }],
  'maconnerie':            [{ intent: 'travaux',      weight: 2 }],
  'terrassement':          [{ intent: 'travaux',      weight: 2 }],
};

/**
 * Détecte l'intention principale du BC en votant sur le texte complet.
 * Retourne l'intention dominante, 'mixed' si égalité, 'unknown' si rien.
 *
 * Note : "achat" a un poids de 1. "pièces de rechange" a un poids de 2.
 * Un BC "Achat pièces de rechange pour maintenance" →
 *   fourniture: 1 (achat), maintenance: 4 (pdr+maintenance) → maintenance gagne.
 */
export function detectBCIntent(bc: ParsedBC): BCIntent {
  const fullText = normalizeText(
    [
      bc.objet,
      bc.bodyText,
      ...bc.articles.map(a => `${a.designation} ${a.specifications}`),
    ].join(' '),
  );

  const scores: Record<string, number> = {
    maintenance: 0, installation: 0, fourniture: 0, travaux: 0,
  };

  for (const [keyword, votes] of Object.entries(INTENT_VOTES)) {
    if (fullText.includes(keyword)) {
      for (const vote of votes) {
        scores[vote.intent] = (scores[vote.intent] ?? 0) + vote.weight;
      }
    }
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const first = sorted[0];
  const second = sorted[1];

  if (!first || first[1] === 0) return 'unknown';
  if (second && first[1] === second[1] && first[1] > 0) return 'mixed';

  return first[0] as BCIntent;
}

// ─── Composants de scoring ────────────────────────────────────────────────────

interface ComponentResult {
  score: number;
  matched_terms: string[];
  matched_critere_ids: string[];
}

/**
 * Évalue la présence des critères dans l'objet (titre) du BC.
 * Max 10 pts. Exact = 10, inclusion = 8, fuzzy = 5.
 */
function scoreTitleComponent(bc: ParsedBC, criteres: readonly Critere[]): ComponentResult {
  if (!bc.objet) return { score: 0, matched_terms: [], matched_critere_ids: [] };

  let best = 0;
  const terms: string[] = [];
  const ids: string[] = [];

  for (const crit of criteres) {
    const r = matchKeyword(bc.objet, crit.valeur, crit.ai_inclusions);
    if (r.matched) {
      terms.push(r.matched_term);
      ids.push(crit.id);
      const pts: Record<MatchTrigger, number> = { exact: 10, inclusion: 8, fuzzy: 5, none: 0 };
      best = Math.max(best, pts[r.trigger]);
    }
  }

  return { score: Math.min(10, best), matched_terms: terms, matched_critere_ids: ids };
}

/**
 * Évalue la présence des critères dans le bodyText du BC.
 * Max 10 pts. Exact = 10, inclusion = 7, fuzzy = 4.
 */
function scoreContentComponent(bc: ParsedBC, criteres: readonly Critere[]): ComponentResult {
  if (!bc.bodyText) return { score: 0, matched_terms: [], matched_critere_ids: [] };

  let best = 0;
  const terms: string[] = [];
  const ids: string[] = [];

  for (const crit of criteres) {
    const r = matchKeyword(bc.bodyText, crit.valeur, crit.ai_inclusions);
    if (r.matched) {
      terms.push(r.matched_term);
      ids.push(crit.id);
      const pts: Record<MatchTrigger, number> = { exact: 10, inclusion: 7, fuzzy: 4, none: 0 };
      best = Math.max(best, pts[r.trigger]);
    }
  }

  return { score: Math.min(10, best), matched_terms: terms, matched_critere_ids: ids };
}

// ─── Article scoring ──────────────────────────────────────────────────────────

interface ArticleScoreResult extends ComponentResult {
  matched_articles: number;
  total_articles:   number;
  density:          number;
}

/**
 * Évalue les articles du BC avec pondération par densité.
 * Max 40 pts.
 *
 * Principe fondamental :
 *   score = force_du_meilleur_match × densité_de_couverture
 *
 * Cela garantit qu'une seule ligne pertinente dans un BC non pertinent
 * ne domine pas : 1/15 articles → density 0.067 → max 3 pts.
 * Mais 5/5 articles → density 1.0 → max 40 pts.
 *
 * Force par trigger : exact = 40, inclusion = 30, fuzzy = 18.
 */
function scoreArticlesComponent(
  bc: ParsedBC,
  criteres: readonly Critere[],
): ArticleScoreResult {
  const total = bc.articles.length;
  const empty: ArticleScoreResult = {
    score: 0, matched_articles: 0, total_articles: 0, density: 0,
    matched_terms: [], matched_critere_ids: [],
  };

  if (total === 0) return empty;

  let matchedCount = 0;
  let bestStrength = 0;
  const terms: string[] = [];
  const ids: string[] = [];

  for (const article of bc.articles) {
    const text = `${article.designation} ${article.specifications}`;
    let articleHit = false;

    for (const crit of criteres) {
      const r = matchKeyword(text, crit.valeur, crit.ai_inclusions);
      if (r.matched) {
        articleHit = true;
        if (!ids.includes(crit.id)) ids.push(crit.id);
        const strength: Record<MatchTrigger, number> = {
          exact: 40, inclusion: 30, fuzzy: 18, none: 0,
        };
        bestStrength = Math.max(bestStrength, strength[r.trigger]);
        if (!terms.includes(r.matched_term)) terms.push(r.matched_term);
      }
    }

    if (articleHit) matchedCount++;
  }

  if (matchedCount === 0) return { ...empty, total_articles: total };

  const density = matchedCount / total;
  const score = Math.min(40, Math.round(bestStrength * density));

  return {
    score,
    matched_articles: matchedCount,
    total_articles: total,
    density,
    matched_terms: terms,
    matched_critere_ids: ids,
  };
}

// ─── Business intent ──────────────────────────────────────────────────────────

/**
 * Évalue la correspondance entre l'intention du BC et le profil métier du client.
 * Max 20 pts.
 *
 * Logique :
 *   - Si l'intention du BC correspond à un type_prestation du client → 20 pts
 *   - Si l'intention est inconnue ou mixte → 8 pts (neutre)
 *   - Si l'intention du BC ne correspond pas aux services du client → 3 pts
 *     (pas 0 : le client reste potentiellement intéressé, ex: fourniture de pièces)
 *
 * Exemples :
 *   - Client maintenance + BC maintenance → 20
 *   - Client maintenance + BC achat simple → 3 (mismatch, mais pas exclu)
 *   - Client maintenance + BC achat pièces rechange maintenance → mixed → 8
 *     (ou maintenance si les votes maintenance dominent)
 */
function scoreBusinessIntentComponent(client: ClientProfile, bcIntent: BCIntent): number {
  const clientTypes = client.business_profile.types_prestation.map(t => normalizeText(t));
  if (clientTypes.length === 0) return 10; // pas de préférence → neutre

  // Aliases par intention BC
  const intentAliases: Record<BCIntent, string[]> = {
    maintenance:  ['maintenance', 'entretien', 'reparation', 'depannage', 'revision'],
    installation: ['installation', 'mise en place', 'mise en service', 'deploiement'],
    fourniture:   ['fourniture', 'acquisition', 'achat', 'approvisionnement', 'livraison'],
    travaux:      ['travaux', 'construction', 'renovation', 'amenagement', 'genie civil'],
    mixed:        [],
    unknown:      [],
  };

  if (bcIntent === 'unknown' || bcIntent === 'mixed') return 8;

  const aliases = intentAliases[bcIntent];
  const clientMatches = clientTypes.some(ct =>
    aliases.some(alias => alias.includes(ct) || ct.includes(alias)),
  );

  return clientMatches ? 20 : 3;
}

// ─── Technical scoring ────────────────────────────────────────────────────────

interface TechnicalResult {
  score:         number;
  matched_specs: string[];
}

/**
 * Évalue la présence des spécifications et produits techniques du client dans le BC.
 * Max 15 pts.
 *
 * Basé sur le ratio de termes techniques matchés :
 *   score = 15 × (0.25 + 0.75 × ratio)  → minimum 4 pts si au moins 1 match.
 */
function scoreTechnicalComponent(bc: ParsedBC, client: ClientProfile): TechnicalResult {
  const specs = client.technical_profile.specifications;
  const produits = client.technical_profile.produits;
  const allTerms = [...specs, ...produits];

  if (allTerms.length === 0) return { score: 0, matched_specs: [] };

  const fullText = normalizeText(
    [bc.objet, bc.bodyText, ...bc.articles.map(a => `${a.designation} ${a.specifications}`)].join(' '),
  );

  const matched: string[] = [];
  for (const term of allTerms) {
    if (fullText.includes(normalizeText(term))) {
      matched.push(term);
    }
  }

  if (matched.length === 0) return { score: 0, matched_specs: [] };

  const ratio = matched.length / allTerms.length;
  const score = Math.min(15, Math.round(15 * (0.25 + 0.75 * ratio)));

  return { score, matched_specs: matched };
}

// ─── Organization scoring ─────────────────────────────────────────────────────

/**
 * Évalue la correspondance géographique et institutionnelle.
 * Max 5 pts. Retourne −5 si la wilaya est explicitement exclue.
 *
 *   +3 si l'organisme fait partie des cibles du client
 *   +2 si la wilaya est dans la zone couverte
 *   −5 si la wilaya est dans la liste d'exclusions
 */
function scoreOrganizationComponent(bc: ParsedBC, client: ClientProfile): number {
  const orgCibles = client.business_profile.organismes_cibles.map(o => normalizeText(o));
  const wilayasCouvertes = client.organization_profile.wilayas_couvertes.map(w => normalizeText(w));
  const wilayasExclues = client.organization_profile.wilayas_exclues.map(w => normalizeText(w));

  // Pénalité dure : wilaya explicitement exclue
  if (bc.wilaya) {
    const normWilaya = normalizeText(bc.wilaya);
    if (wilayasExclues.some(we => normWilaya.includes(we) || we.includes(normWilaya))) {
      return -5;
    }
  }

  let score = 0;

  // Bonus organisme
  if (bc.organisme && orgCibles.length > 0) {
    const normOrg = normalizeText(bc.organisme);
    if (orgCibles.some(o => normOrg.includes(o) || o.includes(normOrg))) {
      score += 3;
    }
  }

  // Bonus wilaya
  if (bc.wilaya && wilayasCouvertes.length > 0) {
    const normWilaya = normalizeText(bc.wilaya);
    if (wilayasCouvertes.some(w => normWilaya.includes(w) || w.includes(normWilaya))) {
      score += 2;
    }
  }

  return Math.min(5, score);
}

// ─── Exclusion contextuelle ───────────────────────────────────────────────────

interface ExclusionResult {
  penalty: number;
  reasons: string[];
}

/**
 * Calcule la pénalité d'exclusion contextuelle. Entre −50 et 0.
 *
 * RÈGLES FONDAMENTALES :
 *   1. Les exclusions sont contextuelles — jamais lexicales.
 *   2. "achat" ne pénalise JAMAIS automatiquement.
 *   3. "achat pièces de rechange pour maintenance" n'est PAS exclu.
 *   4. On pénalise uniquement si le CONTEXTE DOMINANT du BC correspond
 *      à une exclusion métier du client (densité d'articles > 50%).
 *
 * Stratégie :
 *   - Travaux/bâtiment : pénaliser uniquement si bcIntent === 'travaux'
 *   - Secteurs spécifiques (IT, mobilier) : pénaliser uniquement si
 *     > 50% des articles sont dans ce secteur (densité d'articles)
 *   - Termes génériques : pénaliser si densité articles > 30%
 */
function computeContextualExclusionPenalty(
  bc: ParsedBC,
  client: ClientProfile,
  bcIntent: BCIntent,
): ExclusionResult {
  const exclusions = client.business_profile.exclusions_metier.map(e => normalizeText(e));
  if (exclusions.length === 0) return { penalty: 0, reasons: [] };

  const reasons: string[] = [];
  let totalPenalty = 0;

  // Mots-clés représentatifs de chaque secteur à exclure
  const SECTOR_KEYWORDS: Record<string, string[]> = {
    travaux:      ['travaux', 'construction', 'renovation', 'genie civil', 'maconnerie', 'terrassement'],
    batiment:     ['batiment', 'gros oeuvre', 'second oeuvre', 'charpente', 'toiture'],
    informatique: ['ordinateur', 'laptop', 'serveur', 'imprimante', 'logiciel', 'reseau informatique'],
    bureautique:  ['imprimante', 'cartouche', 'toner', 'papier bureau'],
    mobilier:     ['bureau', 'chaise', 'armoire', 'meuble', 'mobilier', 'table de reunion'],
  };

  for (const excl of exclusions) {
    // ── Exclusion "travaux" / "bâtiment" : uniquement si bcIntent = travaux ──
    if (excl === 'travaux' || excl === 'batiment' || excl === 'genie civil') {
      if (bcIntent === 'travaux') {
        totalPenalty -= 30;
        reasons.push(`BC de type travaux/bâtiment (intention détectée: travaux)`);
      }
      // bcIntent != travaux → pas de pénalité même si le mot apparaît
      continue;
    }

    // ── Exclusion sectorielle : densité d'articles ────────────────────────
    const sectorKws = SECTOR_KEYWORDS[excl] ?? [excl];
    const sectorArticles = bc.articles.filter(a => {
      const text = normalizeText(`${a.designation} ${a.specifications}`);
      return sectorKws.some(kw => text.includes(kw));
    });

    const density = bc.articles.length > 0
      ? sectorArticles.length / bc.articles.length
      : 0;

    // Seuil : 50% des articles pour les secteurs forts, 30% pour les génériques
    const strongSectors = ['informatique', 'bureautique', 'mobilier'];
    const threshold = strongSectors.includes(excl) ? 0.5 : 0.3;

    if (density >= threshold) {
      const pen = Math.round(-25 * Math.min(1, density / threshold));
      totalPenalty += pen;
      reasons.push(
        `Secteur "${excl}" dominant (${Math.round(density * 100)}% articles — seuil ${Math.round(threshold * 100)}%)`,
      );
    }
  }

  return { penalty: Math.max(-50, totalPenalty), reasons };
}

// ─── Interface de sortie ──────────────────────────────────────────────────────

/**
 * Résultat complet du scoring d'un BC pour un profil client.
 * Tous les composants sont exposés pour audit et traçabilité.
 */
export interface ScoreComponents {
  /** Score titre (objet BC), max 10 */
  title_score:                   number;
  /** Score contenu (bodyText), max 10 */
  content_score:                 number;
  /** Score articles (pondéré par densité), max 40 */
  article_score:                 number;
  /** Score intention métier, max 20 */
  business_intent_score:         number;
  /** Score spécifications techniques, max 15 */
  technical_score:               number;
  /** Score organisationnel, max 5 (peut être −5 si wilaya exclue) */
  organization_score:            number;
  /** Pénalité exclusions contextuelles, entre −50 et 0 */
  contextual_exclusion_penalty:  number;
  /** Score final 0–100 (somme clampée) */
  final_score:                   number;
  /** Décision basée sur le seuil du pack client */
  decision:                      'notify' | 'rerank' | 'ignore';
  /** IDs des critères qui ont déclenché au moins un match */
  matched_critere_ids:           string[];
  /** Résumé textuel lisible (pour logs et notifications) */
  explanation:                   string;
  /** Détails pour audit et debug */
  details: {
    bc_intent:          BCIntent;
    article_density:    number;
    matched_articles:   number;
    total_articles:     number;
    matched_terms:      string[];
    matched_specs:      string[];
    exclusion_reasons:  string[];
  };
}

// ─── Fonction principale ──────────────────────────────────────────────────────

/**
 * Score un BC contre un profil client et ses critères actifs.
 *
 * @param bc       BC parsé et validé
 * @param client   Profil client complet
 * @param criteres Critères actifs du client pour ce radar_type
 *
 * @returns ScoreComponents avec score, décision et explication complète
 */
export function scoreBC(
  bc: ParsedBC,
  client: ClientProfile,
  criteres: readonly Critere[],
): ScoreComponents {
  // 1. Détection d'intention du BC
  const bcIntent = detectBCIntent(bc);

  // Guard : BC sans aucun contenu → score nul
  // Évite le bonus "unknown → 8" accordé par scoreBusinessIntentComponent
  // sur des BC vides qui n'ont pas de contenu à évaluer.
  if (!bc.objet.trim() && !bc.bodyText.trim() && bc.articles.length === 0) {
    return {
      title_score: 0, content_score: 0, article_score: 0,
      business_intent_score: 0, technical_score: 0, organization_score: 0,
      contextual_exclusion_penalty: 0,
      final_score: 0,
      decision: 'ignore',
      matched_critere_ids: [],
      explanation: 'BC vide — aucun contenu à scorer',
      details: {
        bc_intent:         'unknown',
        article_density:   0,
        matched_articles:  0,
        total_articles:    0,
        matched_terms:     [],
        matched_specs:     [],
        exclusion_reasons: [],
      },
    };
  }

  // 2. Scoring de chaque composant
  const titleR    = scoreTitleComponent(bc, criteres);
  const contentR  = scoreContentComponent(bc, criteres);
  const articleR  = scoreArticlesComponent(bc, criteres);
  const bizScore  = scoreBusinessIntentComponent(client, bcIntent);
  const techR     = scoreTechnicalComponent(bc, client);
  const orgScore  = scoreOrganizationComponent(bc, client);
  const exclR     = computeContextualExclusionPenalty(bc, client, bcIntent);

  // 3. Score total
  const raw = (
    titleR.score
    + contentR.score
    + articleR.score
    + bizScore
    + techR.score
    + orgScore
    + exclR.penalty
  );
  const finalScore = Math.min(100, Math.max(0, Math.round(raw)));

  // 4. Décision (seuil pack)
  const threshold =
    client.pack_threshold !== undefined
      ? client.pack_threshold
      : client.pack === 'starter'  ? 50
      : client.pack === 'pro'      ? 40
      :                              35;  // business

  const decision: ScoreComponents['decision'] =
    finalScore >= threshold ? 'notify'
    : finalScore >= 20      ? 'rerank'
    :                         'ignore';

  // 5. Critères matchés (union de toutes les sources)
  const matchedCritereIds = [
    ...new Set([
      ...titleR.matched_critere_ids,
      ...contentR.matched_critere_ids,
      ...articleR.matched_critere_ids,
    ]),
  ];

  // 6. Termes matchés (pour l'explication)
  const allTerms = [
    ...new Set([
      ...titleR.matched_terms,
      ...contentR.matched_terms,
      ...articleR.matched_terms,
    ]),
  ].slice(0, 6);

  // 7. Explication textuelle
  const parts: string[] = [
    `Score ${finalScore}/100 → ${decision.toUpperCase()}`,
    `Intent: ${bcIntent}`,
    `Articles: ${articleR.matched_articles}/${articleR.total_articles} (densité ${Math.round(articleR.density * 100)}%)`,
    `Composants: titre ${titleR.score} + contenu ${contentR.score} + articles ${articleR.score} + métier ${bizScore} + technique ${techR.score} + org ${orgScore} + excl ${exclR.penalty}`,
  ];
  if (allTerms.length > 0) parts.push(`Termes: ${allTerms.join(', ')}`);
  if (exclR.reasons.length > 0) parts.push(`Exclusions: ${exclR.reasons.join(' / ')}`);

  return {
    title_score:                  titleR.score,
    content_score:                contentR.score,
    article_score:                articleR.score,
    business_intent_score:        bizScore,
    technical_score:              techR.score,
    organization_score:           orgScore,
    contextual_exclusion_penalty: exclR.penalty,
    final_score:                  finalScore,
    decision,
    matched_critere_ids:          matchedCritereIds,
    explanation:                  parts.join(' | '),
    details: {
      bc_intent:         bcIntent,
      article_density:   articleR.density,
      matched_articles:  articleR.matched_articles,
      total_articles:    articleR.total_articles,
      matched_terms:     allTerms,
      matched_specs:     techR.matched_specs,
      exclusion_reasons: exclR.reasons,
    },
  };
}
