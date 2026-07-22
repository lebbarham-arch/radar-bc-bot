/*
 * Tests statiques du gestionnaire de tache Windows feedback -> learning.
 * Aucun appel ScheduledTasks, Supabase, scan, notification ou Git.
 */

'use strict';

import fs from 'fs';
import path from 'path';

const taskPath = path.join(process.cwd(), 'ops', 'feedback-task.ps1');
const source = fs.readFileSync(taskPath, 'utf8');
const executableSource = source
  .replace(/<#[\s\S]*?#>/g, '')
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

describe('feedback-task - commandes et cadence', () => {
  test('declare install status run remove', () => {
    expect(source).toContain('[ValidateSet("install", "status", "run", "remove")]');
  });

  test('cadence par defaut de 4 heures', () => {
    expect(source).toContain('[int]$EveryHours = 4');
    expect(source).toContain('-RepetitionInterval (New-TimeSpan -Hours $EveryHours)');
  });

  test('premier lancement proche et StartWhenAvailable', () => {
    expect(source).toContain('(Get-Date).AddMinutes(2)');
    expect(source).toContain('-StartWhenAvailable');
  });
});

describe('feedback-task - execution sure', () => {
  test('appelle uniquement le cycle feedback existant', () => {
    expect(source).toContain('feedback-cycle.ps1');
    expect(source).not.toContain('radar-bc-bot.js');
  });

  test('mutex anti-chevauchement', () => {
    expect(source).toContain('Local\\RadarBCFeedbackLearning');
    expect(source).toContain('$mutex.WaitOne(0)');
    expect(source).toContain('$mutex.ReleaseMutex()');
  });

  test('ScheduledTasks ignore une deuxieme instance', () => {
    expect(source).toContain('-MultipleInstances IgnoreNew');
  });

  test('logs locaux avec retention de 30 fichiers', () => {
    expect(source).toContain('data\\feedback\\task-logs');
    expect(source).toContain('feedback-task-*.log');
    expect(source).toContain('Select-Object -Skip 30');
  });

  test('hints generes archives hors fichier versionne', () => {
    expect(source).toContain('data\\feedback\\pending-learning');
    expect(source).toContain('client-learning-hints-latest.json');
    expect(source).toContain('ConvertFrom-Json | Out-Null');
  });

  test('fichier hints versionne restaure dans finally', () => {
    expect(source).toContain('[System.IO.File]::ReadAllBytes($trackedHints)');
    expect(source).toContain('[System.IO.File]::WriteAllBytes($trackedHints, $hintsBackup)');
    expect(source).toContain('elseif (-not $hintsExisted -and (Test-Path $trackedHints))');
  });
});

describe('feedback-task - interdictions', () => {
  test('aucun appel Fly executable', () => {
    expect(executableSource).not.toMatch(/\bfly\b/i);
  });

  test('aucun scan ou notification executable', () => {
    expect(executableSource).not.toContain('runGlobalScanBC');
    expect(executableSource).not.toContain('test-notify');
    expect(executableSource).not.toContain('sendTelegram');
  });

  test('aucune mutation Git automatique', () => {
    expect(executableSource).not.toMatch(/git\s+(add|commit|push|reset|restore|stash)/i);
  });

  test('script PowerShell strictement ASCII', () => {
    const bytes = fs.readFileSync(taskPath);
    const nonAscii = Array.from(bytes).filter((value) => value > 0x7f);
    expect(nonAscii).toHaveLength(0);
  });
});
