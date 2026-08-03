/*
 * Tests statiques du rattrapage backlog BC.
 * Aucun scan, aucune notification, aucun appel Supabase ou Git.
 */

'use strict';

import fs from 'fs';
import path from 'path';

const scriptPath = path.join(process.cwd(), 'ops', 'radar-catchup.ps1');
const source = fs.readFileSync(scriptPath, 'utf8');

describe('radar-catchup - orchestration bornee', () => {
  test('borne le nombre de cycles', () => {
    expect(source).toContain('[ValidateRange(1, 10)]');
    expect(source).toContain('[int]$MaxRounds = 4');
    expect(source).toContain('for ($round = 1; $round -le $MaxRounds; $round++)');
  });

  test('borne la duree de chaque scan', () => {
    expect(source).toContain('[ValidateRange(5, 60)]');
    expect(source).toContain('[int]$MaxMinutesPerScan = 30');
    expect(source).toContain('(Get-Date).AddMinutes($MaxMinutesPerScan)');
  });

  test('utilise uniquement les routes locales existantes', () => {
    expect(source).toContain('http://127.0.0.1:3000');
    expect(source).toContain('/api/status');
    expect(source).toContain('/api/scan-now');
  });

  test('attend un nouveau SCAN_SUMMARY', () => {
    expect(source).toContain('\\[SCAN_SUMMARY\\]');
    expect(source).toContain('$line -ne $PreviousLine');
    expect(source).toContain('-not $status.scanningBC');
  });

  test('s arrete quand skipped_for_next vaut zero', () => {
    expect(source).toContain('$result.SkippedForNext -eq 0');
    expect(source).toContain('Backlog draine');
  });

  test('rejoint un scan deja actif au lieu de doubler', () => {
    expect(source).toContain('if ($status.scanningBC)');
    expect(source).toContain('$responseCode -eq 409');
    expect(source).toContain('rattachement au scan existant');
  });
});

describe('radar-catchup - garde-fous', () => {
  test('refuse un scan non ok', () => {
    expect(source).toContain('$result.Status -ne "ok"');
  });

  test('refuse les fiches en echec', () => {
    expect(source).toContain('$result.Failed -gt 0');
  });

  test('ne journalise jamais ADMIN_SECRET', () => {
    expect(source).toContain('Get-EnvValue "ADMIN_SECRET"');
    expect(source).not.toMatch(/Write-Host[^\n]*secret/i);
  });

  test('ne lance pas directement le moteur Node', () => {
    expect(source).not.toContain('radar-bc-bot.js');
    expect(source).not.toMatch(/\bnode(?:\.exe)?\b/i);
  });

  test('ne modifie pas Git', () => {
    expect(source).not.toMatch(/git\s+(add|commit|push|pull|reset|restore|stash|switch|checkout)/i);
  });

  test('script strictement ASCII', () => {
    const bytes = fs.readFileSync(scriptPath);
    const nonAscii = Array.from(bytes).filter((value) => value > 0x7f);
    expect(nonAscii).toHaveLength(0);
  });
});
