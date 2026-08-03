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

  test('enregistre le chemin du script courant avec PSCommandPath', () => {
    expect(source).toContain('$scriptPath = $PSCommandPath');
    expect(source).not.toContain('$scriptPath = $MyInvocation.MyCommand.Path');
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

  test('artifact runtime ecrit de maniere atomique', () => {
    expect(source).toContain('data\\feedback\\runtime-learning');
    expect(source).toContain('$runtimeTemp = $runtimeHintsFile + ".tmp"');
    expect(source).toContain('Move-Item -Path $runtimeTemp -Destination $runtimeHintsFile -Force');
  });

  test('temporaire runtime nettoye dans finally', () => {
    expect(source).toContain('$residualTemp = $runtimeHintsFile + ".tmp"');
    expect(source).toContain('Remove-Item $residualTemp -Force -ErrorAction SilentlyContinue');
  });

  test('artifact runtime ecrit en UTF-8 sans BOM', () => {
    expect(source).toContain('New-Object System.Text.UTF8Encoding($false)');
    expect(source).toContain('[System.IO.File]::WriteAllText($runtimeTemp, $raw, $utf8NoBom)');
  });

  test('BOM initial retire avant validation et ecriture', () => {
    expect(source).toContain('function Remove-Utf8Bom');
    expect(source).toContain('if ([int]$Text[0] -eq 0xFEFF) { return $Text.Substring(1) }');
  });

  test('politique no_new_feedback : initialise si artifact absent ou invalide', () => {
    expect(source).toContain('function Test-RuntimeArtifactValid');
    expect(source).toContain('elseif (-not (Test-RuntimeArtifactValid $runtimeHintsFile))');
  });
});

/* ------------------------------------------------------------------ */
/* Harnais Windows reel                                                */
/* ------------------------------------------------------------------ */

const INITIAL_JSON = '{"generated_at":"initial","clients":[]}\n';
const CHANGED_JSON = '{"generated_at":"changed","clients":[{"client":"demo","signals":[]}]}';
const EXISTING_RUNTIME_JSON = '{"generated_at":"existing-runtime","clients":[]}';

interface Repo {
  root: string;
  taskScript: string;
  cycleScript: string;
  trackedHints: string;
  runtimeFile: string;
  runtimeTemp: string;
  pendingLatest: string;
}

function powershellAvailable(): boolean {
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'], {
    timeout: 5000,
    stdio: 'pipe',
  });
  return probe.status === 0;
}

/** Cree un depot jetable minimal reproduisant l'arborescence attendue. */
function makeRepo(): Repo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-feedback-task-'));
  const opsDir = path.join(root, 'ops');
  const hintsDir = path.join(root, 'data', 'client-learning');
  fs.mkdirSync(opsDir, { recursive: true });
  fs.mkdirSync(hintsDir, { recursive: true });

  const taskScript = path.join(opsDir, 'feedback-task.ps1');
  fs.copyFileSync(taskPath, taskScript);

  const trackedHints = path.join(hintsDir, 'client-learning-hints.json');
  fs.writeFileSync(trackedHints, INITIAL_JSON, 'utf8');

  const runtimeDir = path.join(root, 'data', 'feedback', 'runtime-learning');
  const runtimeFile = path.join(runtimeDir, 'client-learning-hints.json');

  return {
    root,
    taskScript,
    cycleScript: path.join(opsDir, 'feedback-cycle.ps1'),
    trackedHints,
    runtimeFile,
    runtimeTemp: runtimeFile + '.tmp',
    pendingLatest: path.join(
      root, 'data', 'feedback', 'pending-learning', 'client-learning-hints-latest.json'
    ),
  };
}

/**
 * Ecrit le faux cycle feedback.
 * `payload` null => cycle sans nouveau feedback (statut no_new_feedback).
 * Set-Content -Encoding UTF8 en PowerShell 5.1 ajoute un BOM : c'est
 * volontaire, cela reproduit exactement la source du defaut corrige.
 */
function writeCycle(repo: Repo, payload: string | null): void {
  const lines = ['$repo = Split-Path $PSScriptRoot -Parent'];
  if (payload !== null) {
    lines.push('$hints = Join-Path $repo "data\\client-learning\\client-learning-hints.json"');
    lines.push(`'${payload}' | Set-Content -Path $hints -Encoding UTF8`);
  } else {
    lines.push('Write-Host "Statut : no_new_feedback"');
  }
  lines.push('exit 0');
  fs.writeFileSync(repo.cycleScript, lines.join('\r\n'), 'ascii');
}

function seedRuntimeArtifact(repo: Repo, content: string): void {
  fs.mkdirSync(path.dirname(repo.runtimeFile), { recursive: true });
  fs.writeFileSync(repo.runtimeFile, content, 'utf8');
}

function runTask(repo: Repo): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', repo.taskScript, 'run'],
    { cwd: repo.root, timeout: 30000, encoding: 'utf8' }
  );
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function expectSuccess(repo: Repo, r: { status: number | null; stdout: string; stderr: string }): void {
  if (r.status !== 0) {
    throw new Error(
      'feedback-task.ps1 exit=' + r.status + '\nSTDOUT:\n' + r.stdout + '\nSTDERR:\n' + r.stderr
    );
  }
}

function hasUtf8Bom(file: string): boolean {
  const b = fs.readFileSync(file);
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}

describe('feedback-task - Windows reel : artifact runtime', () => {
  let repo: Repo | null = null;
  let skip = false;

  beforeAll(() => {
    skip = !powershellAvailable();
    if (skip) console.log('  [SKIP] powershell.exe indisponible');
  });

  beforeEach(() => {
    if (skip) return;
    repo = makeRepo();
  });

  afterEach(() => {
    if (repo) fs.rmSync(repo.root, { recursive: true, force: true });
    repo = null;
  });

  test('nouveaux hints : artifact publie, sans BOM, JSON.parse direct reussit', () => {
    if (skip || !repo) return;
    writeCycle(repo, CHANGED_JSON);

    expectSuccess(repo, runTask(repo));

    expect(fs.existsSync(repo.runtimeFile)).toBe(true);
    expect(hasUtf8Bom(repo.runtimeFile)).toBe(false);

    // Exactement l'appel que fait le loader runtime.
    const parsed = JSON.parse(fs.readFileSync(repo.runtimeFile, 'utf8'));
    expect(parsed.generated_at).toBe('changed');

    // L'archive pending reste alimentee comme avant.
    expect(fs.existsSync(repo.pendingLatest)).toBe(true);
    expect(fs.readFileSync(repo.pendingLatest, 'utf8')).toContain('"generated_at":"changed"');
  });

  test('no_new_feedback : artifact absent est initialise depuis le fichier stable', () => {
    if (skip || !repo) return;
    writeCycle(repo, null);
    expect(fs.existsSync(repo.runtimeFile)).toBe(false);

    expectSuccess(repo, runTask(repo));

    expect(fs.existsSync(repo.runtimeFile)).toBe(true);
    expect(hasUtf8Bom(repo.runtimeFile)).toBe(false);

    const parsed = JSON.parse(fs.readFileSync(repo.runtimeFile, 'utf8'));
    expect(parsed.generated_at).toBe('initial');
  });

  test('no_new_feedback : artifact valide existant n est pas reecrit', () => {
    if (skip || !repo) return;
    seedRuntimeArtifact(repo, EXISTING_RUNTIME_JSON);
    const before = fs.readFileSync(repo.runtimeFile);
    writeCycle(repo, null);

    expectSuccess(repo, runTask(repo));

    expect(fs.readFileSync(repo.runtimeFile)).toEqual(before);
    const parsed = JSON.parse(fs.readFileSync(repo.runtimeFile, 'utf8'));
    expect(parsed.generated_at).toBe('existing-runtime');
  });

  test('no_new_feedback : artifact invalide est remplace par la source stable', () => {
    if (skip || !repo) return;
    seedRuntimeArtifact(repo, '{ ceci nest pas du json');
    writeCycle(repo, null);

    expectSuccess(repo, runTask(repo));

    const parsed = JSON.parse(fs.readFileSync(repo.runtimeFile, 'utf8'));
    expect(parsed.generated_at).toBe('initial');
    expect(hasUtf8Bom(repo.runtimeFile)).toBe(false);
  });

  test('source JSON invalide : le dernier artifact valide est conserve', () => {
    if (skip || !repo) return;
    seedRuntimeArtifact(repo, EXISTING_RUNTIME_JSON);
    const before = fs.readFileSync(repo.runtimeFile);
    writeCycle(repo, '{ source corrompue');

    runTask(repo); // le cycle peut echouer, l artifact ne doit pas bouger

    expect(fs.readFileSync(repo.runtimeFile)).toEqual(before);
    expect(fs.existsSync(repo.runtimeTemp)).toBe(false);
  });

  test('fichier temporaire supprime dans tous les cas', () => {
    if (skip || !repo) return;

    writeCycle(repo, CHANGED_JSON);
    expectSuccess(repo, runTask(repo));
    expect(fs.existsSync(repo.runtimeTemp)).toBe(false);

    writeCycle(repo, null);
    expectSuccess(repo, runTask(repo));
    expect(fs.existsSync(repo.runtimeTemp)).toBe(false);

    writeCycle(repo, '{ source corrompue');
    runTask(repo);
    expect(fs.existsSync(repo.runtimeTemp)).toBe(false);
  });

  test('Git reste propre : le fichier versionne est restaure a l identique', () => {
    if (skip || !repo) return;
    const before = fs.readFileSync(repo.trackedHints);

    writeCycle(repo, CHANGED_JSON);
    expectSuccess(repo, runTask(repo));
    expect(fs.readFileSync(repo.trackedHints)).toEqual(before);

    writeCycle(repo, null);
    expectSuccess(repo, runTask(repo));
    expect(fs.readFileSync(repo.trackedHints)).toEqual(before);

    writeCycle(repo, '{ source corrompue');
    runTask(repo);
    expect(fs.readFileSync(repo.trackedHints)).toEqual(before);
  });

  test('artifact reste lisible par le loader runtime apres cycles successifs', () => {
    if (skip || !repo) return;

    writeCycle(repo, CHANGED_JSON);
    expectSuccess(repo, runTask(repo));

    writeCycle(repo, null);
    expectSuccess(repo, runTask(repo));

    expect(hasUtf8Bom(repo.runtimeFile)).toBe(false);
    const parsed = JSON.parse(fs.readFileSync(repo.runtimeFile, 'utf8'));
    expect(parsed.generated_at).toBe('changed');
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
