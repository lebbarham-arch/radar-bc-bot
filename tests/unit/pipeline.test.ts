/**
 * Tests Pipeline — Anaho
 *
 * Valide le pipeline de démonstration mocké de bout en bout.
 * Chaque test correspond à une fixture annotée dans pipeline.fixtures.ts.
 *
 * Structure des tests :
 *   [Parser]     — mockParseBc extrait correctement les articles
 *   [Classifier] — classifyArticles assigne les bonnes catégories
 *   [Runner]     — runPipeline produit la bonne décision finale
 *   [F1]         — CVC pertinent → notify
 *   [F2]         — CVC non pertinent → ignore
 *   [F3]         — IT réseau pertinent → notify
 *   [F4]         — IT consommables non pertinent → ignore/rerank
 *   [F5]         — Opportunité cachée → notify via articles uniquement
 *   [Batch]      — runBatchPipeline classe correctement les 5 fixtures
 */

import { mockParseBc } from '@core/pipeline/mock-parser';
import { classifyArticles } from '@core/pipeline/mock-classifier';
import { runPipeline, runBatchPipeline } from '@core/pipeline/runner';
import { isPipelineResult } from '@core/pipeline/types';

import {
  F1_CVC_PERTINENT,
  F2_CVC_NON_PERTINENT,
  F3_IT_RESEAU_PERTINENT,
  F4_IT_CONSOMMABLES_NON_PERTINENT,
  F5_HIDDEN_OPPORTUNITY,
  CVC_CLIENT,
  IT_NETWORK_CLIENT,
} from '@tests/fixtures/pipeline.fixtures';

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Exécute le pipeline pour une fixture donnée et vérifie que le résultat
 * est un PipelineResult (pas une PipelineError).
 */
function runAndAssert(raw: typeof F1_CVC_PERTINENT, client: typeof CVC_CLIENT) {
  const criteres = client.criteres;
  const outcome  = runPipeline({ raw, client, criteres });
  expect(isPipelineResult(outcome)).toBe(true);
  if (!isPipelineResult(outcome)) throw new Error('Pipeline error: ' + JSON.stringify(outcome));
  return outcome;
}

// ═════════════════════════════════════════════════════════════════════════════
// MOCK PARSER
// ═════════════════════════════════════════════════════════════════════════════

describe('mockParseBc — extraction des articles', () => {
  it('parse correctement F1 (5 articles CVC)', () => {
    const result = mockParseBc(F1_CVC_PERTINENT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.articles).toHaveLength(5);
    expect(result.parsed.objet).toContain('climatiseurs');
  });

  it('extrait la désignation et les spécifications depuis raw_tables', () => {
    const result = mockParseBc(F3_IT_RESEAU_PERTINENT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const firstArticle = result.parsed.articles[0];
    expect(firstArticle?.designation).toContain('Câble réseau RJ45 Cat6');
    expect(firstArticle?.specifications).toContain('Cat6');
  });

  it('extrait quantite et unite', () => {
    const result = mockParseBc(F1_CVC_PERTINENT);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const first = result.parsed.articles[0];
    expect(first?.quantite).toBe('24');
    expect(first?.unite).toBe('unités');
  });

  it('tronque bodyText > 10 000 chars', () => {
    const rawWithLongBody = {
      ...F1_CVC_PERTINENT,
      raw_body: 'x'.repeat(15_000),
    };
    const result = mockParseBc(rawWithLongBody);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.bodyText.length).toBeLessThanOrEqual(10_000);
    expect(result.warnings.some(w => w.includes('tronqué'))).toBe(true);
  });

  it('échoue proprement si id manquant', () => {
    const result = mockParseBc({ objet: 'Test sans id' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain('id');
  });

  it('construit une URL de fallback si url absente', () => {
    const raw = { ...F1_CVC_PERTINENT };
    delete (raw as Partial<typeof raw>).url;
    const result = mockParseBc(raw);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.url).toContain('marchespublics.gov.ma');
  });

  it('gère les tables sans en-tête (fallback colonnes)', () => {
    const rawNoHeader = {
      id:  'BC-NO-HEADER',
      url: 'https://marchespublics.gov.ma/bdc/entreprise/consultation/show/0',
      raw_tables: [
        ['Climatiseur split 18000 BTU', '5', 'unités'],
        ['Compresseur CVC',             '2', 'unités'],
      ],
    };
    const result = mockParseBc(rawNoHeader);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.parsed.articles).toHaveLength(2);
    expect(result.parsed.articles[0]?.designation).toContain('Climatiseur');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MOCK CLASSIFIER
// ═════════════════════════════════════════════════════════════════════════════

describe('classifyArticles — catégorisation des articles', () => {
  it('F1 : catégorie dominante = cvc', () => {
    const parsed = mockParseBc(F1_CVC_PERTINENT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const summary = classifyArticles(parsed.parsed);
    expect(summary.dominant_category).toBe('cvc');
  });

  it('F2 : catégorie dominante = alimentaire', () => {
    const parsed = mockParseBc(F2_CVC_NON_PERTINENT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const summary = classifyArticles(parsed.parsed);
    expect(summary.dominant_category).toBe('alimentaire');
  });

  it('F3 : catégorie dominante = informatique', () => {
    const parsed = mockParseBc(F3_IT_RESEAU_PERTINENT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const summary = classifyArticles(parsed.parsed);
    expect(summary.dominant_category).toBe('informatique');
  });

  it('F4 : catégorie dominante = bureautique', () => {
    const parsed = mockParseBc(F4_IT_CONSOMMABLES_NON_PERTINENT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const summary = classifyArticles(parsed.parsed);
    expect(summary.dominant_category).toBe('bureautique');
  });

  it('F5 : catégorie dominante = informatique (malgré titre générique)', () => {
    const parsed = mockParseBc(F5_HIDDEN_OPPORTUNITY);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const summary = classifyArticles(parsed.parsed);
    expect(summary.dominant_category).toBe('informatique');
  });

  it('retourne les matched_keywords pour chaque article classifié', () => {
    const parsed = mockParseBc(F3_IT_RESEAU_PERTINENT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const summary = classifyArticles(parsed.parsed);
    const cableArticle = summary.classified.find(a =>
      a.designation.toLowerCase().includes('câble réseau') ||
      a.designation.toLowerCase().includes('cable reseau'),
    );
    expect(cableArticle).toBeDefined();
    expect(cableArticle?.matched_keywords.length).toBeGreaterThan(0);
  });

  it('confidence "high" si ≥ 3 keywords matchés', () => {
    const parsed = mockParseBc(F1_CVC_PERTINENT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const summary = classifyArticles(parsed.parsed);
    const highConf = summary.classified.filter(a => a.confidence === 'high');
    expect(highConf.length).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F1 — CVC pertinent → notify
// ═════════════════════════════════════════════════════════════════════════════

describe('F1 — CVC pertinent : maintenance climatiseurs → notify', () => {
  const result = runAndAssert(F1_CVC_PERTINENT, CVC_CLIENT);

  it('décision = notify', () => {
    expect(result.final_decision).toBe('notify');
  });

  it('score ≥ 65', () => {
    expect(result.final_score).toBeGreaterThanOrEqual(65);
  });

  it('business_intent_score = 20 (maintenance → maintenance)', () => {
    expect(result.stages.score_components.business_intent_score).toBe(20);
  });

  it('article_score > 0 (articles CVC matchés)', () => {
    expect(result.stages.score_components.article_score).toBeGreaterThan(0);
  });

  it('contextual_exclusion_penalty = 0', () => {
    expect(result.stages.score_components.contextual_exclusion_penalty).toBe(0);
  });

  it('5 articles extraits correctement', () => {
    const pr = result.stages.parse_result;
    expect(pr.success).toBe(true);
    if (pr.success) expect(pr.parsed.articles).toHaveLength(5);
  });

  it('classification dominante = cvc', () => {
    expect(result.stages.classification.dominant_category).toBe('cvc');
  });

  it('explication lisible produite', () => {
    expect(result.explanation).toContain('notify');
    expect(result.explanation).toContain('PARSE');
    expect(result.explanation).toContain('SCORE');
  });

  it('duration_ms est un nombre positif', () => {
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F2 — CVC non pertinent → ignore
// ═════════════════════════════════════════════════════════════════════════════

describe('F2 — CVC non pertinent : café et boissons → ignore', () => {
  const result = runAndAssert(F2_CVC_NON_PERTINENT, CVC_CLIENT);

  it('décision = ignore', () => {
    expect(result.final_decision).toBe('ignore');
  });

  it('score < 20', () => {
    expect(result.final_score).toBeLessThan(20);
  });

  it('article_score = 0 (aucun article CVC)', () => {
    expect(result.stages.score_components.article_score).toBe(0);
  });

  it('matched_critere_ids est vide', () => {
    expect(result.stages.score_components.matched_critere_ids).toHaveLength(0);
  });

  it('classification dominante = alimentaire', () => {
    expect(result.stages.classification.dominant_category).toBe('alimentaire');
  });

  it('score F2 << score F1 (non pertinent bien séparé du pertinent)', () => {
    const resultF1 = runAndAssert(F1_CVC_PERTINENT, CVC_CLIENT);
    expect(resultF1.final_score - result.final_score).toBeGreaterThanOrEqual(40);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F3 — IT réseau pertinent → notify
// ═════════════════════════════════════════════════════════════════════════════

describe('F3 — IT réseau pertinent : câbles RJ45 Cat6 → notify', () => {
  const result = runAndAssert(F3_IT_RESEAU_PERTINENT, IT_NETWORK_CLIENT);

  it('décision = notify', () => {
    expect(result.final_decision).toBe('notify');
  });

  it('score ≥ 70', () => {
    expect(result.final_score).toBeGreaterThanOrEqual(70);
  });

  it('title_score > 0 (câble réseau dans le titre)', () => {
    expect(result.stages.score_components.title_score).toBeGreaterThan(0);
  });

  it('article_score élevé (tous les articles sont réseau)', () => {
    expect(result.stages.score_components.article_score).toBeGreaterThan(20);
  });

  it('technical_score > 0 (Cat6, Gigabit, RJ45 matchés)', () => {
    expect(result.stages.score_components.technical_score).toBeGreaterThan(0);
  });

  it('contextual_exclusion_penalty = 0', () => {
    expect(result.stages.score_components.contextual_exclusion_penalty).toBe(0);
  });

  it('6 articles extraits correctement', () => {
    const pr = result.stages.parse_result;
    expect(pr.success).toBe(true);
    if (pr.success) expect(pr.parsed.articles).toHaveLength(6);
  });

  it('classification dominante = informatique', () => {
    expect(result.stages.classification.dominant_category).toBe('informatique');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F4 — IT consommables non pertinent → ignore/rerank
// ═════════════════════════════════════════════════════════════════════════════

describe('F4 — IT consommables non pertinent : cartouches/papier → ignore ou rerank', () => {
  const result = runAndAssert(F4_IT_CONSOMMABLES_NON_PERTINENT, IT_NETWORK_CLIENT);

  it('décision ≠ notify', () => {
    expect(result.final_decision).not.toBe('notify');
  });

  it('score < 40 (sous le seuil pro)', () => {
    expect(result.final_score).toBeLessThan(40);
  });

  it('article_score = 0 (aucun câble réseau)', () => {
    expect(result.stages.score_components.article_score).toBe(0);
  });

  it('pénalité exclusion active (bureautique dominant)', () => {
    expect(result.stages.score_components.contextual_exclusion_penalty).toBeLessThan(0);
  });

  it('classification dominante = bureautique', () => {
    expect(result.stages.classification.dominant_category).toBe('bureautique');
  });

  it('score F4 << score F3 (non pertinent bien séparé du pertinent)', () => {
    const resultF3 = runAndAssert(F3_IT_RESEAU_PERTINENT, IT_NETWORK_CLIENT);
    expect(resultF3.final_score - result.final_score).toBeGreaterThanOrEqual(30);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// F5 — Opportunité cachée → notify par les articles seuls
// ═════════════════════════════════════════════════════════════════════════════

describe('F5 — Opportunité cachée : titre générique, articles réseau → notify', () => {
  const result = runAndAssert(F5_HIDDEN_OPPORTUNITY, IT_NETWORK_CLIENT);

  it('décision = notify', () => {
    expect(result.final_decision).toBe('notify');
  });

  it('score ≥ 55', () => {
    expect(result.final_score).toBeGreaterThanOrEqual(55);
  });

  it('title_score = 0 (titre générique sans mot-clé réseau)', () => {
    // "Fourniture de matériels — Lot 3" → aucun match
    expect(result.stages.score_components.title_score).toBe(0);
  });

  it('content_score = 0 (bodyText générique sans mot-clé réseau)', () => {
    expect(result.stages.score_components.content_score).toBe(0);
  });

  it('article_score élevé (tous les articles = câblage réseau)', () => {
    expect(result.stages.score_components.article_score).toBeGreaterThan(25);
  });

  it('les articles ont révélé l\'opportunité que le titre masquait', () => {
    // Le score vient UNIQUEMENT des articles, pas du titre ni du contenu
    const { title_score, content_score, article_score } = result.stages.score_components;
    expect(title_score + content_score).toBe(0);
    expect(article_score).toBeGreaterThan(0);
  });

  it('5 articles extraits malgré le titre générique', () => {
    const pr = result.stages.parse_result;
    expect(pr.success).toBe(true);
    if (pr.success) expect(pr.parsed.articles).toHaveLength(5);
  });

  it('classification dominante = informatique (révèle le vrai contenu)', () => {
    expect(result.stages.classification.dominant_category).toBe('informatique');
  });

  it('explication mentionne les articles', () => {
    expect(result.explanation).toContain('5');  // 5 articles extraits
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BATCH PIPELINE
// ═════════════════════════════════════════════════════════════════════════════

describe('runBatchPipeline — classification correcte des 5 fixtures', () => {
  describe('Batch CVC (F1 + F2)', () => {
    const batch = runBatchPipeline({
      raws:     [F1_CVC_PERTINENT, F2_CVC_NON_PERTINENT],
      client:   CVC_CLIENT,
      criteres: CVC_CLIENT.criteres,
    });

    it('total = 2 BCs traités', () => {
      expect(batch.total).toBe(2);
    });

    it('F1 dans notify', () => {
      expect(batch.notify.some(r => r.bc_id === F1_CVC_PERTINENT.id)).toBe(true);
    });

    it('F2 dans ignore', () => {
      expect(batch.ignore.some(r => r.bc_id === F2_CVC_NON_PERTINENT.id)).toBe(true);
    });

    it('aucune erreur de parsing', () => {
      expect(batch.errors).toHaveLength(0);
    });

    it('notify triés par score décroissant', () => {
      for (let i = 0; i < batch.notify.length - 1; i++) {
        const a = batch.notify[i];
        const b = batch.notify[i + 1];
        if (a && b) expect(a.final_score).toBeGreaterThanOrEqual(b.final_score);
      }
    });
  });

  describe('Batch IT (F3 + F4 + F5)', () => {
    const batch = runBatchPipeline({
      raws:     [F3_IT_RESEAU_PERTINENT, F4_IT_CONSOMMABLES_NON_PERTINENT, F5_HIDDEN_OPPORTUNITY],
      client:   IT_NETWORK_CLIENT,
      criteres: IT_NETWORK_CLIENT.criteres,
    });

    it('total = 3 BCs traités', () => {
      expect(batch.total).toBe(3);
    });

    it('F3 dans notify', () => {
      expect(batch.notify.some(r => r.bc_id === F3_IT_RESEAU_PERTINENT.id)).toBe(true);
    });

    it('F5 dans notify (opportunité cachée détectée)', () => {
      expect(batch.notify.some(r => r.bc_id === F5_HIDDEN_OPPORTUNITY.id)).toBe(true);
    });

    it('F4 hors notify (consommables bureautique exclus)', () => {
      expect(batch.notify.some(r => r.bc_id === F4_IT_CONSOMMABLES_NON_PERTINENT.id)).toBe(false);
    });

    it('2 BCs en notify (F3 + F5)', () => {
      expect(batch.notify).toHaveLength(2);
    });

    it('aucune erreur de parsing', () => {
      expect(batch.errors).toHaveLength(0);
    });
  });

  describe('Batch complet (5 fixtures mixtes)', () => {
    // F1+F3+F5 doivent être notify, F2 ignore, F4 ignore/rerank
    const batchCVC = runBatchPipeline({
      raws: [F1_CVC_PERTINENT, F2_CVC_NON_PERTINENT],
      client: CVC_CLIENT,
      criteres: CVC_CLIENT.criteres,
    });
    const batchIT = runBatchPipeline({
      raws: [F3_IT_RESEAU_PERTINENT, F4_IT_CONSOMMABLES_NON_PERTINENT, F5_HIDDEN_OPPORTUNITY],
      client: IT_NETWORK_CLIENT,
      criteres: IT_NETWORK_CLIENT.criteres,
    });

    it('aucune erreur sur les 5 fixtures', () => {
      expect(batchCVC.errors).toHaveLength(0);
      expect(batchIT.errors).toHaveLength(0);
    });

    it('les 2 pertinents CVC sont correctement classés', () => {
      expect(batchCVC.notify.length).toBe(1);  // F1 only
      expect(batchCVC.ignore.length).toBe(1);  // F2 only
    });

    it('les 3 pertinents IT sont correctement classés', () => {
      expect(batchIT.notify.length).toBe(2);   // F3 + F5
      expect(batchIT.ignore.length + batchIT.rerank.length).toBe(1); // F4
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CAS LIMITES & ROBUSTESSE
// ═════════════════════════════════════════════════════════════════════════════

describe('Robustesse du pipeline', () => {
  it('gère un RawBC sans raw_tables (0 articles)', () => {
    const rawMin = {
      id:  'BC-MIN',
      url: 'https://marchespublics.gov.ma/bdc/entreprise/consultation/show/0',
      objet: 'Test minimum',
    };
    const outcome = runPipeline({ raw: rawMin, client: CVC_CLIENT, criteres: CVC_CLIENT.criteres });
    expect(isPipelineResult(outcome)).toBe(true);
    if (isPipelineResult(outcome)) {
      expect(outcome.stages.score_components.article_score).toBe(0);
    }
  });

  it('retourne PipelineError si id manquant', () => {
    const rawNoId = { objet: 'BC sans id' };
    const outcome = runPipeline({ raw: rawNoId, client: CVC_CLIENT, criteres: CVC_CLIENT.criteres });
    expect(isPipelineResult(outcome)).toBe(false);
    if (!isPipelineResult(outcome)) {
      expect(outcome.stage).toBe('parse');
      expect(outcome.error).toBeDefined();
    }
  });

  it('isPipelineResult distingue résultat d\'erreur', () => {
    const good = runPipeline({ raw: F1_CVC_PERTINENT, client: CVC_CLIENT, criteres: CVC_CLIENT.criteres });
    const bad  = runPipeline({ raw: { objet: 'sans id' }, client: CVC_CLIENT, criteres: CVC_CLIENT.criteres });
    expect(isPipelineResult(good)).toBe(true);
    expect(isPipelineResult(bad)).toBe(false);
  });

  it('runBatchPipeline gère un lot avec erreurs sans crash', () => {
    const batch = runBatchPipeline({
      raws:     [F1_CVC_PERTINENT, { objet: 'sans id' }],
      client:   CVC_CLIENT,
      criteres: CVC_CLIENT.criteres,
    });
    expect(batch.total).toBe(2);
    expect(batch.errors).toHaveLength(1);
    expect(batch.notify.length + batch.rerank.length + batch.ignore.length).toBe(1);
  });

  it('duration_ms est mesuré pour chaque pipeline', () => {
    const outcome = runPipeline({ raw: F3_IT_RESEAU_PERTINENT, client: IT_NETWORK_CLIENT, criteres: IT_NETWORK_CLIENT.criteres });
    if (isPipelineResult(outcome)) {
      expect(typeof outcome.duration_ms).toBe('number');
      expect(outcome.duration_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('final_score est toujours entre 0 et 100', () => {
    const fixtures = [
      { raw: F1_CVC_PERTINENT,                client: CVC_CLIENT,        criteres: CVC_CLIENT.criteres },
      { raw: F2_CVC_NON_PERTINENT,            client: CVC_CLIENT,        criteres: CVC_CLIENT.criteres },
      { raw: F3_IT_RESEAU_PERTINENT,          client: IT_NETWORK_CLIENT, criteres: IT_NETWORK_CLIENT.criteres },
      { raw: F4_IT_CONSOMMABLES_NON_PERTINENT,client: IT_NETWORK_CLIENT, criteres: IT_NETWORK_CLIENT.criteres },
      { raw: F5_HIDDEN_OPPORTUNITY,           client: IT_NETWORK_CLIENT, criteres: IT_NETWORK_CLIENT.criteres },
    ];
    for (const input of fixtures) {
      const outcome = runPipeline(input);
      if (isPipelineResult(outcome)) {
        expect(outcome.final_score).toBeGreaterThanOrEqual(0);
        expect(outcome.final_score).toBeLessThanOrEqual(100);
      }
    }
  });
});
