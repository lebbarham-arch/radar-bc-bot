/*
 * Tests statiques et Windows du gestionnaire de tache feedback -> learning.
 * Aucun appel ScheduledTasks, Supabase, scan, notification ou Git.
 */

'use strict';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

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

  test('Windows reel: archive les nouveaux hints et restaure le fichier initial', () => {
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], {
      timeout: 5000,
      stdio: 'pipe',
    });
    if (probe.status !== 0) {
      console.log('  [SKIP] powershell.exe indisponible');
      return;
    }

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-feedback-task-'));
    try {
      const opsDir = path.join(tmp, 'ops');
      const hintsDir = path.join(tmp, 'data', 'client-learning');
      fs.mkdirSync(opsDir, { recursive: true });
      fs.mkdirSync(hintsDir, { recursive: true });

      const copiedTask = path.join(opsDir, 'feedback-task.ps1');
      const fakeCycle = path.join(opsDir, 'feedback-cycle.ps1');
      const trackedHints = path.join(hintsDir, 'client-learning-hints.json');
      const initialJson = '{"generated_at":"initial","clients":[]}\n';
      const changedJson = '{"generated_at":"changed","clients":[{"client":"demo","signals":[]}]}';

      fs.copyFileSync(taskPath, copiedTask);
      fs.writeFileSync(trackedHints, initialJson, 'utf8');
      fs.writeFileSync(fakeCycle, [
        '$repo = Split-Path $PSScriptRoot -Parent',
        '$hints = Join-Path $repo "data\\client-learning\\client-learning-hints.json"',
        `'${changedJson}' | Set-Content -Path $hints -Encoding UTF8`,
        'exit 0',
      ].join('\r\n'), 'ascii');

      const result = spawnSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', copiedTask,
        'run',
      ], {
        cwd: tmp,
        timeout: 30000,
        encoding: 'utf8',
      });

      if (result.status !== 0) {
        throw new Error(
          'feedback-task.ps1 exit=' + result.status +
          '\nSTDOUT:\n' + (result.stdout || '') +
          '\nSTDERR:\n' + (result.stderr || '')
        );
      }

      expect(fs.readFileSync(trackedHints, 'utf8')).toBe(initialJson);

      const pendingLatest = path.join(
        tmp,
        'data',
        'feedback',
        'pending-learning',
        'client-learning-hints-latest.json'
      );
      expect(fs.existsSync(pendingLatest)).toBe(true);
      expect(fs.readFileSync(pendingLatest, 'utf8')).toContain('"generated_at":"changed"');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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
