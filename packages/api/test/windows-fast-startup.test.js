import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');

const startFastScriptPath = join(repoRoot, 'scripts', 'start-windows-fast.ps1');
const restartFastScriptPath = join(repoRoot, 'scripts', 'restart-windows-fast.ps1');
const startFastBatPath = join(repoRoot, 'scripts', 'start-fast.bat');
const restartFastBatPath = join(repoRoot, 'scripts', 'restart-fast.bat');

const startFastScript = existsSync(startFastScriptPath) ? readFileSync(startFastScriptPath, 'utf8') : '';
const restartFastScript = existsSync(restartFastScriptPath) ? readFileSync(restartFastScriptPath, 'utf8') : '';
const startFastBat = existsSync(startFastBatPath) ? readFileSync(startFastBatPath, 'utf8') : '';
const restartFastBat = existsSync(restartFastBatPath) ? readFileSync(restartFastBatPath, 'utf8') : '';

test('Windows fast startup script rebuilds runtime artifacts without falling back to heavy startup steps', () => {
  assert.notEqual(startFastScript, '');
  assert.match(startFastScript, /function Wait-PortFree/);
  assert.match(startFastScript, /if \(Wait-PortFree -Port \$Port\) \{/);
  assert.match(startFastScript, /function Test-BuildRequired/);
  assert.match(startFastScript, /function Invoke-BuildStepIfNeeded/);
  assert.match(startFastScript, /function Invoke-BuildStep/);
  assert.match(startFastScript, /Resolve-ToolCommand -Name "pnpm"/);
  assert.match(startFastScript, /Invoke-BuildStepIfNeeded/);
  assert.match(startFastScript, /StepLabel "shared"/);
  assert.match(startFastScript, /StepLabel "mcp-server"/);
  assert.match(startFastScript, /StepLabel "api"/);
  assert.match(startFastScript, /@\("exec", "tsc"\)/);
  assert.match(startFastScript, /StepLabel "web"/);
  assert.match(startFastScript, /@\("run", "build"\)/);
  assert.match(startFastScript, /Write-Ok "\$StepLabel \(up to date\)"/);
  assert.match(startFastScript, /packages\/api\/dist\/index\.js/);
  assert.match(startFastScript, /packages\/web\/\.next/);
  assert.match(startFastScript, /\$env:CAT_CAFE_WEB_STANDALONE = "0"/);
  assert.match(startFastScript, /Start-Process -FilePath \$nodeCommand/);
  assert.match(startFastScript, /Write-WindowsRuntimeStateFile/);
  assert.doesNotMatch(startFastScript, /Mount-InstallerSkills/);
  assert.doesNotMatch(startFastScript, /Ensure-WindowsDareRuntime/);
  assert.doesNotMatch(startFastScript, /Ensure-WindowsJiuwenClawRuntime/);
  assert.doesNotMatch(startFastScript, /Start-Job -Name/);
});

test('Windows fast restart script stops first and then starts the lightweight launcher', () => {
  assert.notEqual(restartFastScript, '');
  assert.match(restartFastScript, /Join-Path \$ScriptDir "stop-windows\.ps1"/);
  assert.match(restartFastScript, /Join-Path \$ScriptDir "start-windows-fast\.ps1"/);
  assert.match(restartFastScript, /Write-Step "Stop services"/);
  assert.match(restartFastScript, /Write-Step "Start services"/);
  assert.match(
    restartFastScript,
    /& powershell(?:\.exe)? -NoProfile -ExecutionPolicy Bypass -File \$stopScript/,
  );
  assert.match(
    restartFastScript,
    /& powershell(?:\.exe)? -NoProfile -ExecutionPolicy Bypass -File \$startScript @startArgs/,
  );
});

test('Windows fast bat wrappers delegate to the new PowerShell entrypoints', () => {
  assert.match(startFastBat, /start-windows-fast\.ps1/);
  assert.match(restartFastBat, /restart-windows-fast\.ps1/);
});
