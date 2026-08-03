/*
 * Propagation de client_name le long du pipeline feedback -> learning.
 *
 * Chemin couvert :
 *   autopilot -> cycle -> export -> JSONL -> conversion CSV -> import
 *
 * Invariants verrouilles :
 *   - client_id UUID reste l'identifiant ;
 *   - client_name est une metadonnee d'affichage, jamais un identifiant ;
 *   - les appels sans client_name restent valides (retrocompatibilite).
 *
 * Nomenclature : CNP-N.
 */

'use strict';

import fs from 'fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const exporter = require('../../scripts/export-client-feedback-events.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const converter = require('../../scripts/convert-feedback-events-to-review-csv.js');

const UUID = '15a96b88-0c98-4de9-9f66-739e3a28dafa';
const NAME = 'TEST PROD - Nettoyage Hygiène';

const AUTOPILOT_SRC = fs.readFileSync('scripts/run-feedback-learning-cycle.js', 'utf8');
const CYCLE_SRC     = fs.readFileSync('scripts/run-client-feedback-learning-cycle.js', 'utf8');
const EXPORT_SRC    = fs.readFileSync('scripts/export-client-feedback-events.js', 'utf8');

interface SbRow {
  client_id: string;
  item_id: string;
  radar_type: string;
  critere: string;
  type: string;
  source: string;
  created_at: string;
  client_name?: string;
}

function sbRow(over: Partial<SbRow> = {}): SbRow {
  return Object.assign({
    client_id:  UUID,
    item_id:    '366389',
    radar_type: 'bc',
    critere:    'nettoyage',
    type:       'irrelevant',
    source:     'telegram',
    created_at: '2026-08-01T10:00:00Z',
  }, over);
}

/* ------------------------------------------------------------------ */

describe('export - client_name', () => {
  test('CNP-1 avec clientName : UUID dans client_id, nom exact dans client_name', () => {
    const r = exporter.filterAndTransform([sbRow()], { clientName: NAME });
    expect(r.events).toHaveLength(1);
    expect(r.events[0].client_id).toBe(UUID);
    expect(r.events[0].client_name).toBe(NAME);
  });

  test('CNP-2 sans clientName : retrocompatible, nom vide, UUID inchange', () => {
    const r = exporter.filterAndTransform([sbRow()], {});
    expect(r.events[0].client_id).toBe(UUID);
    expect(r.events[0].client_name).toBe('');
  });

  test('CNP-3 opts absent : aucun crash, nom vide', () => {
    const r = exporter.filterAndTransform([sbRow()]);
    expect(r.events[0].client_id).toBe(UUID);
    expect(r.events[0].client_name).toBe('');
  });

  test('CNP-4 repli sur row.client_name quand le cycle ne fournit rien', () => {
    const r = exporter.filterAndTransform([sbRow({ client_name: 'Nom porte par la ligne' })], {});
    expect(r.events[0].client_name).toBe('Nom porte par la ligne');
    expect(r.events[0].client_id).toBe(UUID);
  });

  test('CNP-5 le nom explicite du cycle prime sur celui de la ligne', () => {
    const r = exporter.filterAndTransform(
      [sbRow({ client_name: 'Ancien libelle' })],
      { clientName: NAME }
    );
    expect(r.events[0].client_name).toBe(NAME);
  });

  test('CNP-6 le nom n est jamais recopie dans client_id', () => {
    const r = exporter.filterAndTransform([sbRow()], { clientName: NAME });
    expect(r.events[0].client_id).toBe(UUID);
    expect(r.events[0].client_id).not.toBe(NAME);
  });

  test('CNP-7 clientName vide ou espaces reste vide', () => {
    expect(exporter.filterAndTransform([sbRow()], { clientName: '   ' }).events[0].client_name).toBe('');
    expect(exporter.filterAndTransform([sbRow()], { clientName: null }).events[0].client_name).toBe('');
  });

  test('CNP-8 option CLI --client-name declaree', () => {
    expect(EXPORT_SRC).toContain("_a === '--client-name'");
    expect(EXPORT_SRC).toContain('clientName: clientName');
  });
});

describe('cycle et autopilot - transmission', () => {
  test('CNP-9 le cycle accepte --client-name', () => {
    expect(CYCLE_SRC).toContain("a === '--client-name'");
    expect(CYCLE_SRC).toContain('clientName: clientName');
  });

  test('CNP-10 le cycle ne transmet --client-name qu a l etape export', () => {
    expect(CYCLE_SRC).toContain(
      ".concat(opts.clientName ? ['--client-name', opts.clientName] : [])"
    );
    // Une seule occurrence : les etapes convert / import ne le recoivent pas.
    const occurrences = CYCLE_SRC.split("['--client-name', opts.clientName]").length - 1;
    expect(occurrences).toBe(1);
  });

  test('CNP-11 le cycle reste utilisable sans --client-name', () => {
    // L argument n est ajoute que si le nom est non vide.
    expect(CYCLE_SRC).toContain('opts.clientName ?');
    expect(CYCLE_SRC).not.toContain("'--client-name', opts.clientName]).concat(dr)");
  });

  test('CNP-12 l autopilot transmet id et nom du client actif', () => {
    expect(AUTOPILOT_SRC).toContain(
      'runClientCycle(client.id, since, opts.radarType, opts.dryRun, client.nom || \'\')'
    );
    expect(AUTOPILOT_SRC).toContain("if (clientName) args.push('--client-name', clientName);");
  });

  test('CNP-13 l autopilot ne relit pas Supabase pour obtenir le nom', () => {
    // Le nom vient de l objet client deja charge, pas d une requete dediee.
    expect(AUTOPILOT_SRC).toContain('client.nom');
    expect(AUTOPILOT_SRC).not.toMatch(/select=.*nom.*--client-name/);
  });
});

describe('chaine complete export -> CSV -> import', () => {
  test('CNP-14 le nom traverse la conversion CSV', () => {
    const ev = exporter.filterAndTransform([sbRow()], { clientName: NAME }).events[0];
    const review = converter.convertFeedbackEvent(ev);

    expect(review).not.toBeNull();
    expect(review.client).toBe(UUID);        // champ historique = UUID
    expect(review.client_id).toBe(UUID);
    expect(review.client_name).toBe(NAME);
  });

  test('CNP-15 les trois champs sont dans l entete CSV', () => {
    expect(converter.CSV_HEADER).toContain('client');
    expect(converter.CSV_HEADER).toContain('client_id');
    expect(converter.CSV_HEADER).toContain('client_name');
  });

  test('CNP-16 le CSV genere porte les trois colonnes et le nom exact', () => {
    const ev = exporter.filterAndTransform([sbRow()], { clientName: NAME }).events[0];
    const csv = converter.buildCsvContent([converter.convertFeedbackEvent(ev)]);

    // Le CSV est genere avec separateur ';' et un BOM UTF-8 en tete.
    const lines = csv.split(/\r?\n/).filter((l: string) => l.trim() !== '');
    const header = lines[0].replace(/^﻿/, '').split(';');
    expect(header).toContain('client');
    expect(header).toContain('client_id');
    expect(header).toContain('client_name');
    expect(csv).toContain(UUID);
    expect(csv).toContain(NAME);
  });

  test('CNP-17 import : les trois champs sont conserves', () => {
    // Le mapping d import lit client, client_id et client_name separement.
    const importSrc = fs.readFileSync('scripts/import-review-decisions.js', 'utf8');
    expect(importSrc).toContain("client_id:          header.indexOf('client_id')");
    expect(importSrc).toContain("client_name:        header.indexOf('client_name')");
    expect(importSrc).toContain('COL.client_id   >= 0');
    expect(importSrc).toContain('COL.client_name >= 0');
  });

  test('CNP-18 resultat final : client = client_id = UUID, client_name = nom', () => {
    const ev = exporter.filterAndTransform([sbRow()], { clientName: NAME }).events[0];
    const review = converter.convertFeedbackEvent(ev);

    expect({
      client:      review.client,
      client_id:   review.client_id,
      client_name: review.client_name,
    }).toEqual({
      client:      UUID,
      client_id:   UUID,
      client_name: NAME,
    });
  });

  test('CNP-19 sans nom : la chaine reste valide, nom vide, UUID intact', () => {
    const ev = exporter.filterAndTransform([sbRow()], {}).events[0];
    const review = converter.convertFeedbackEvent(ev);

    expect(review.client).toBe(UUID);
    expect(review.client_id).toBe(UUID);
    expect(review.client_name).toBe('');
  });

  test('CNP-20 client_name n est jamais un repli d identifiant', () => {
    // Un evenement sans client_id est rejete, meme si le nom est renseigne.
    const orphan = exporter.filterAndTransform(
      [sbRow({ client_id: '' })],
      { clientName: NAME }
    ).events[0];

    expect(converter.convertFeedbackEvent(orphan)).toBeNull();
  });
});
