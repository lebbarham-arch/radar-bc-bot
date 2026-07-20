/**
 * tests/unit/analyze-shadow-hints.test.ts
 * GD-141 — Tests unitaires pour scripts/shadow-hint-impact.js
 *
 * Suite ASH-1..12 couvrant :
 *   - baselineDecision() et postHintDecision() de facon isolee
 *   - computeHintImpact() sur des fixtures minimalistes
 *   - Coherence des totaux
 *   - Isolation entre plusieurs clients
 *   - Aucune logique specifique a un nom de client ou signal
 *   - Clean_score jamais modifie
 *   - Test ASH-12 sur le shadow Nettoyage reel
 */

import * as path from 'path';
import * as fs   from 'fs';

const impact = require('../../scripts/shadow-hint-impact');

// ── Constantes exportees ────────────────────────────────────────────────────
const STRONG = impact.CLEAN_STRONG_THRESHOLD as number; // 15
const WEAK   = impact.CLEAN_WEAK_THRESHOLD   as number; // 5

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Cree une entree BC minimaliste pour les tests. */
function makeEntry(opts: {
  bc_id?:                 string;
  clean_score?:           number;
  matched_signals?:       string[];
  hint_score_adj?:        number;
  hint_applied?:          string;
  hint_block_auto?:       boolean;
  auto_notify_candidate?: boolean;
  review_candidate?:      boolean;
  exclusion_hit?:         boolean;
  objet?:                 string;
}): Record<string, unknown> {
  return {
    bc_id:                 opts.bc_id              || 'bc-test',
    clean_score:           opts.clean_score        ?? 10,
    matched_signals:       opts.matched_signals    || ['signal-x'],
    hint_score_adj:        opts.hint_score_adj,
    hint_applied:          opts.hint_applied,
    hint_block_auto:       opts.hint_block_auto,
    auto_notify_candidate: opts.auto_notify_candidate,
    review_candidate:      opts.review_candidate,
    exclusion_hit:         opts.exclusion_hit,
    objet:                 opts.objet              || '',
  };
}

/** Cree un rawClient minimal pour computeHintImpact. */
function makeClient(name: string, entries: Record<string, unknown>[]): Record<string, unknown> {
  return { client_name: name, clean_only: entries };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('shadow-hint-impact — ASH-1..12', () => {

  // ── ASH-1 : sans hint, baseline === post-hint ──────────────────────────
  test('ASH-1 : sans hint — baseline et post-hint identiques', () => {
    const entry = makeEntry({ clean_score: STRONG, matched_signals: ['alpha', 'beta'] });
    expect(impact.baselineDecision(entry)).toBe('auto');
    expect(impact.postHintDecision(entry)).toBe('auto');

    const result = impact.computeHintImpact(makeClient('CLI', [entry]));
    expect(result.total).toBe(1);
    expect(result.without_hint).toBe(1);
    expect(result.with_hint).toBe(0);
    expect(result.baseline_auto).toBe(1);
    expect(result.post_auto).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.changed_entries).toHaveLength(0);
  });

  // ── ASH-2 : score 10 + boost +5, stored auto=true → review->auto ───────
  test('ASH-2 : score 10 + boost +5 (stored) -> review->auto', () => {
    const entry = makeEntry({
      clean_score: 10,
      hint_score_adj: 5,
      hint_applied: 'signal-x:boost',
      auto_notify_candidate: true,   // stored par le replay post-hints
    });
    expect(impact.baselineDecision(entry)).toBe('review');
    expect(impact.postHintDecision(entry)).toBe('auto');

    const result = impact.computeHintImpact(makeClient('CLI', [entry]));
    expect(result.baseline_review).toBe(1);
    expect(result.baseline_auto).toBe(0);
    expect(result.post_auto).toBe(1);
    expect(result.post_review).toBe(0);
    expect(result.review_to_auto).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(result.changed_entries).toHaveLength(1);
    expect(result.changed_entries[0].baseline_decision).toBe('review');
    expect(result.changed_entries[0].post_hint_decision).toBe('auto');
    expect(result.changed_entries[0].hint_score_adj).toBe(5);
    expect(result.changed_entries[0].effective_score).toBe(15);
  });

  // ── ASH-3 : score 15 + demote adj=-3 + block=true → auto->review ────────
  test('ASH-3 : score 15 + demote adj=-3 + block_auto (stored review) -> auto->review', () => {
    const entry = makeEntry({
      clean_score: STRONG,
      matched_signals: ['alpha', 'beta'],
      hint_score_adj: -3,
      hint_applied: 'alpha:demote_to_review',
      hint_block_auto: true,
      review_candidate: true,        // stored par le replay post-hints (block_auto => review)
    });
    expect(impact.baselineDecision(entry)).toBe('auto');  // clean_score=15, multi-signal
    expect(impact.postHintDecision(entry)).toBe('review'); // stored review_candidate=true

    const result = impact.computeHintImpact(makeClient('CLI', [entry]));
    expect(result.baseline_auto).toBe(1);
    expect(result.post_review).toBe(1);
    expect(result.auto_to_review).toBe(1);
    expect(result.hint_block_auto_count).toBe(1);
    expect(result.adj_negative).toBe(1);
  });

  // ── ASH-4 : score 14 + boost +5 mais block_auto=true → reste review ─────
  test('ASH-4 : score 14 + boost +5 mais hint_block_auto=true -> reste review (jamais auto)', () => {
    const entry = makeEntry({
      clean_score: 14,
      matched_signals: ['alpha', 'beta'],
      hint_score_adj: 5,
      hint_applied: 'alpha:boost',
      hint_block_auto: true,
      // auto_notify_candidate absent, review_candidate=true stocke
      review_candidate: true,
    });
    expect(impact.baselineDecision(entry)).toBe('review');  // 14 < 15
    expect(impact.postHintDecision(entry)).toBe('review');  // stored review_candidate=true

    const result = impact.computeHintImpact(makeClient('CLI', [entry]));
    expect(result.baseline_review).toBe(1);
    expect(result.post_review).toBe(1);
    expect(result.unchanged).toBe(1);
    expect(result.changed_entries).toHaveLength(0);
  });

  // ── ASH-5 : ajustement positif sans franchissement de seuil → review inchangee
  test('ASH-5 : adj=+3 sur score=10 (effectif=13 < 15) -> review inchangee', () => {
    const entry = makeEntry({
      clean_score: 10,
      hint_score_adj: 3,
      hint_applied: 'signal-x:boost',
      review_candidate: true,        // stored (effectif=13 ne franchit pas 15)
    });
    expect(impact.baselineDecision(entry)).toBe('review');
    expect(impact.postHintDecision(entry)).toBe('review');

    const result = impact.computeHintImpact(makeClient('CLI', [entry]));
    expect(result.unchanged).toBe(1);
    expect(result.with_hint).toBe(1);
    expect(result.adj_positive).toBe(1);
    expect(result.changed_entries).toHaveLength(0);
  });

  // ── ASH-6 : ajustement negatif sans changement de categorie ─────────────
  test('ASH-6 : adj=-2 sur score=12 (effectif=10, still review) -> review inchangee', () => {
    const entry = makeEntry({
      clean_score: 12,
      matched_signals: ['alpha', 'beta'],
      hint_score_adj: -2,
      hint_applied: 'alpha:demote_to_review',
      review_candidate: true,
    });
    expect(impact.baselineDecision(entry)).toBe('review');  // 12 < 15
    expect(impact.postHintDecision(entry)).toBe('review');  // stored, effectif=10 still review

    const result = impact.computeHintImpact(makeClient('CLI', [entry]));
    expect(result.unchanged).toBe(1);
    expect(result.adj_negative).toBe(1);
  });

  // ── ASH-7 : ancien shadow sans champs de decision → fallback effectif ────
  test('ASH-7 : fallback (pas de stored decision) — effective_score=15 -> review->auto', () => {
    // Pas d'auto_notify_candidate ni review_candidate stockes — utiliser le fallback
    const entry = makeEntry({
      clean_score: 10,
      matched_signals: ['alpha', 'beta'],  // multi-signal, non-weak
      hint_score_adj: 5,
      hint_applied: 'alpha:boost',
      // PAS de auto_notify_candidate, PAS de review_candidate
    });
    expect(impact.baselineDecision(entry)).toBe('review');  // 10 < 15
    expect(impact.postHintDecision(entry)).toBe('auto');    // fallback: effectif=15 >= 15, non-weak

    const result = impact.computeHintImpact(makeClient('CLI', [entry]));
    expect(result.review_to_auto).toBe(1);
    expect(result.changed_entries[0].effective_score).toBe(15);
  });

  // ── ASH-7b : fallback avec hint_block_auto=true → reste review ──────────
  test('ASH-7b : fallback avec hint_block_auto=true -> jamais auto malgre effectif >= 15', () => {
    const entry = makeEntry({
      clean_score: 10,
      matched_signals: ['alpha', 'beta'],
      hint_score_adj: 5,
      hint_applied: 'alpha:boost',
      hint_block_auto: true,
      // PAS de champs de decision stockes
    });
    expect(impact.postHintDecision(entry)).toBe('review'); // block_auto interdit auto
    const result = impact.computeHintImpact(makeClient('CLI', [entry]));
    expect(result.unchanged).toBe(1);  // review->review
    expect(result.hint_block_auto_count).toBe(1);
  });

  // ── ASH-8 : plusieurs clients, stats strictement isolees ─────────────────
  test('ASH-8 : deux clients — statistiques strictement isolees', () => {
    const entryA = makeEntry({
      bc_id: 'bc-a',
      clean_score: 10,
      hint_score_adj: 5,
      hint_applied: 'x:boost',
      auto_notify_candidate: true,
    });
    const entryB = makeEntry({
      bc_id: 'bc-b',
      clean_score: STRONG,
      matched_signals: ['p', 'q'],
      // Pas de hint
    });

    const impA = impact.computeHintImpact(makeClient('Client-A', [entryA]));
    const impB = impact.computeHintImpact(makeClient('Client-B', [entryB]));

    // Client A : review -> auto
    expect(impA.review_to_auto).toBe(1);
    expect(impA.with_hint).toBe(1);
    expect(impA.without_hint).toBe(0);

    // Client B : pas de hint, pas de changement
    expect(impB.unchanged).toBe(1);
    expect(impB.with_hint).toBe(0);
    expect(impB.without_hint).toBe(1);

    // Les totaux de A n'affectent pas B et vice-versa
    expect(impB.review_to_auto).toBe(0);
    expect(impA.unchanged).toBe(0);
  });

  // ── ASH-9 : aucune logique specifique a un nom de client ou signal ────────
  test('ASH-9 : noms arbitraires — meme comportement generique', () => {
    const names = ['ACME', 'Client-XYZ-789', 'Societe fictive Test'];
    const sigs  = ['signal-generique', 'autre-signal', 'critere-x'];

    names.forEach(function(name) {
      sigs.forEach(function(sig) {
        const entry = makeEntry({
          clean_score: 10,
          matched_signals: [sig, 'multi'],
          hint_score_adj: 5,
          auto_notify_candidate: true,
        });
        const result = impact.computeHintImpact(makeClient(name, [entry]));
        // Meme formule quelle que soit la valeur du nom/signal
        expect(result.review_to_auto).toBe(1);
        expect(result.changed_entries[0].hint_score_adj).toBe(5);
      });
    });
  });

  // ── ASH-10 : clean_score jamais modifie ──────────────────────────────────
  test('ASH-10 : clean_score original non modifie apres computeHintImpact', () => {
    const entry = makeEntry({
      clean_score: 10,
      hint_score_adj: 5,
      hint_applied: 'x:boost',
      auto_notify_candidate: true,
    });
    const originalScore = entry.clean_score;
    impact.computeHintImpact(makeClient('CLI', [entry]));
    expect(entry.clean_score).toBe(originalScore); // toujours 10
  });

  // ── ASH-11 : totaux baseline et post-hints coherents avec total ───────────
  test('ASH-11 : baseline_auto + baseline_review + baseline_none === total (et idem post-hints)', () => {
    const entries = [
      makeEntry({ clean_score: STRONG, matched_signals: ['a','b'] }),                      // auto/auto
      makeEntry({ clean_score: 10,  hint_score_adj: 5, auto_notify_candidate: true }),     // review->auto
      makeEntry({ clean_score: 10,  review_candidate: true }),                             // review/review
      makeEntry({ clean_score: 3 }),                                                       // none/none
      makeEntry({ clean_score: STRONG, matched_signals: ['a','b'],
                  hint_score_adj: -3, hint_block_auto: true, review_candidate: true }),    // auto->review
    ];

    const result = impact.computeHintImpact(makeClient('CLI', entries));
    const totalBL = result.baseline_auto + result.baseline_review + result.baseline_none;
    const totalPH = result.post_auto     + result.post_review     + result.post_none;
    expect(totalBL).toBe(result.total);
    expect(totalPH).toBe(result.total);
    expect(result.total).toBe(entries.length);
  });

  // ── ASH-12 : test sur le shadow Nettoyage reel ───────────────────────────
  test('ASH-12 : shadow Nettoyage reel — 4 baseline_auto, 13 baseline_review, 17 post_auto, 0 post_review', () => {
    const shadowPath = path.join(
      __dirname, '..', '..',
      'data', 'shadow', 'shadow-bc-input-replay-2026-07-20T16-49-17.json'
    );
    if (!fs.existsSync(shadowPath)) {
      // Si le fichier n'est pas present en CI, on skip proprement
      console.warn('ASH-12 : fichier shadow absent, test skipped');
      return;
    }

    const report = JSON.parse(fs.readFileSync(shadowPath, 'utf-8'));
    const nettoClient = (report.clients as any[]).find(
      (c: any) => c.client_name && c.client_name.indexOf('Nettoyage') !== -1
    );
    expect(nettoClient).toBeTruthy();

    const result = impact.computeHintImpact(nettoClient);

    // Totaux
    expect(result.total).toBe(17);
    expect(result.with_hint).toBe(17);
    expect(result.without_hint).toBe(0);

    // Baseline (clean_score seul : 4 BCs a 15, 13 BCs a 10)
    expect(result.baseline_auto).toBe(4);
    expect(result.baseline_review).toBe(13);
    expect(result.baseline_none).toBe(0);

    // Post-hints (decisions stockees par le replay : 17 auto)
    expect(result.post_auto).toBe(17);
    expect(result.post_review).toBe(0);
    expect(result.post_none).toBe(0);

    // Changements
    expect(result.review_to_auto).toBe(13);
    expect(result.unchanged).toBe(4);
    expect(result.changed_entries).toHaveLength(13);

    // Verifier qu'aucun changed_entry n'a un bc modifie (clean_score original intact)
    for (const e of result.changed_entries) {
      expect(e.baseline_score).toBe(10);      // tous les BCs changes etaient score=10
      expect(e.hint_score_adj).toBe(5);       // boost +5
      expect(e.effective_score).toBe(15);     // effectif = 10+5
      expect(e.baseline_decision).toBe('review');
      expect(e.post_hint_decision).toBe('auto');
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // ASH-D : cas limites presence/absence des champs de decision
  //
  //  Le replay stocke :  value || undefined  =>  jamais false, toujours absent ou true
  //  La logique postHintDecision doit neanmoins distinguer :
  //    - champ ABSENT (undefined) : ancien shadow, fallback autorise
  //    - champ PRESENT a false   : decision stored "non", AUCUN fallback
  //    - champ PRESENT a true    : decision stored "oui"
  // ════════════════════════════════════════════════════════════════════════════

  // ── ASH-D1 : auto=true, review=false → 'auto' ────────────────────────────
  test('ASH-D1 : auto_notify_candidate=true, review_candidate=false => auto', () => {
    const entry = makeEntry({
      clean_score: STRONG,
      auto_notify_candidate: true,
      review_candidate: false,
    });
    expect(impact.postHintDecision(entry)).toBe('auto');
  });

  // ── ASH-D2 : auto=false, review=true → 'review' ────────────────────────────
  test('ASH-D2 : auto_notify_candidate=false, review_candidate=true => review', () => {
    const entry = makeEntry({
      clean_score: STRONG,
      auto_notify_candidate: false,
      review_candidate: true,
    });
    expect(impact.postHintDecision(entry)).toBe('review');
  });

  // ── ASH-D3 : auto=false, review=false, clean_score=20 → 'none' (PAS auto) ─
  // Cas critique : si la verification etait seulement === true, le fallback
  // s'activerait et retournerait 'auto' pour clean_score=20. Ce test garantit
  // que la presence du champ (meme a false) verrouille la decision a 'none'.
  test('ASH-D3 : auto_notify=false, review=false, clean_score=20 => none (pas de fallback)', () => {
    const entry = makeEntry({
      clean_score: 20,
      matched_signals: ['a', 'b'],
      auto_notify_candidate: false,
      review_candidate: false,
    });
    expect(impact.postHintDecision(entry)).toBe('none');
  });

  // ── ASH-D4 : les deux champs absents → fallback actif ───────────────────────
  test('ASH-D4 : auto et review absents => fallback (clean_score=20 => auto)', () => {
    const entry = makeEntry({
      clean_score: 20,
      matched_signals: ['a', 'b'],
      // auto_notify_candidate et review_candidate volontairement absents
    });
    // makeEntry les positionne a undefined si non fournis
    expect(entry.auto_notify_candidate).toBeUndefined();
    expect(entry.review_candidate).toBeUndefined();
    expect(impact.postHintDecision(entry)).toBe('auto');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // ASH-F : miroirs fallback vs replay  (champs absent => fallback obligatoire)
  //
  //  Reproduit la logique de replay-shadow-from-input-snapshot.js lignes 665-714
  //  pour les quatre plages de score et le cas hint_block_auto.
  // ════════════════════════════════════════════════════════════════════════════

  // ── ASH-F1 : score < WEAK → none ────────────────────────────────────────────
  test('ASH-F1 : fallback — clean_score < WEAK (ex. 3) => none', () => {
    const entry = makeEntry({ clean_score: 3 });
    expect(entry.auto_notify_candidate).toBeUndefined();
    expect(impact.postHintDecision(entry)).toBe('none');
  });

  // ── ASH-F2 : WEAK <= score < STRONG → review ────────────────────────────────
  test('ASH-F2 : fallback — WEAK <= clean_score < STRONG (ex. 10) => review', () => {
    const entry = makeEntry({ clean_score: 10 });
    expect(entry.auto_notify_candidate).toBeUndefined();
    expect(impact.postHintDecision(entry)).toBe('review');
  });

  // ── ASH-F3 : score >= STRONG, signaux multiples → auto ─────────────────────
  test('ASH-F3 : fallback — clean_score >= STRONG, 2 signaux => auto', () => {
    const entry = makeEntry({ clean_score: STRONG, matched_signals: ['a', 'b'] });
    expect(entry.auto_notify_candidate).toBeUndefined();
    expect(impact.postHintDecision(entry)).toBe('auto');
  });

  // ── ASH-F4 : score >= STRONG, 1 signal (isWeakSingle=false car cs >= STRONG) → auto ──
  // Replay ligne 665 : isWeakSingle2 = sigs.length===1 && cs < CLEAN_STRONG_THRESHOLD
  // STRONG < STRONG est false => isWeakSingle=false => auto
  test('ASH-F4 : fallback — clean_score >= STRONG, 1 signal => auto (isWeakSingle false)', () => {
    const entry = makeEntry({ clean_score: STRONG, matched_signals: ['seul'] });
    expect(entry.auto_notify_candidate).toBeUndefined();
    expect(impact.postHintDecision(entry)).toBe('auto');
  });

  // ── ASH-F5 : score juste sous STRONG avec 1 signal (isWeakSingle) → review ─
  // cs=14, 1 signal => isWeakSingle=true => isAuto=false => review (cs >= WEAK)
  test('ASH-F5 : fallback — clean_score=14, 1 signal => review (isWeakSingle)', () => {
    const entry = makeEntry({ clean_score: STRONG - 1, matched_signals: ['seul'] });
    expect(entry.auto_notify_candidate).toBeUndefined();
    expect(impact.postHintDecision(entry)).toBe('review');
  });

  // ── ASH-F6 : hint_block_auto interdit auto meme si score >= STRONG ──────────
  // Replay ligne 682 : if (hintBlockAuto) isAutoCandidate2 = false
  // Le review threshold reste sur clean_score baseline (ligne 714)
  test('ASH-F6 : fallback — hint_block_auto => review quand cs >= STRONG >= WEAK', () => {
    const entry = makeEntry({
      clean_score: STRONG,
      matched_signals: ['a', 'b'],
      hint_block_auto: true,
    });
    expect(entry.auto_notify_candidate).toBeUndefined();
    expect(impact.postHintDecision(entry)).toBe('review');
  });

  // ── ASH-F7 : adj boost — isWeakSingle recalcule sur adjustedScore ───────────
  // Replay lignes 678-679 : si adj != 0, isWeakSingle2 recalcule sur adjustedScore
  // cs=13, 1 signal, adj=+3 => adjustedScore=16 >= 15
  // isWeakSingle recalcule : 1 && 16 < 15 => false => isAuto=true => 'auto'
  test('ASH-F7 : fallback avec adj — isWeakSingle recalcule sur adjustedScore => auto', () => {
    const entry = makeEntry({
      clean_score: 13,
      matched_signals: ['seul'],
      hint_score_adj: 3,
    });
    expect(entry.auto_notify_candidate).toBeUndefined();
    expect(impact.postHintDecision(entry)).toBe('auto');
  });

  // ── ASH-F8 : review threshold sur BASELINE meme si adj eleve le score ────────
  // Replay ligne 714 : review_candidate = !isAuto && cleanResult2.score >= WEAK
  // cs=3 (< WEAK=5), adj=+10 => effectif=13, mais cs < WEAK => none (pas review)
  test('ASH-F8 : fallback — review threshold baseline (cs=3 < WEAK meme si adj=+10) => none', () => {
    const entry = makeEntry({
      clean_score: 3,
      hint_score_adj: 10,
    });
    expect(entry.auto_notify_candidate).toBeUndefined();
    expect(impact.postHintDecision(entry)).toBe('none');
  });

});
