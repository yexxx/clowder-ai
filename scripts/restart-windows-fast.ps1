<#
.SYNOPSIS
  Clowder AI (Cat Cafe) - Windows Fast Restart Script

.DESCRIPTION
  Stops running services and restarts them using start-windows-fast.ps1.

.EXAMPLE
  .\scripts\restart-windows-fast.ps1
  .\scripts\restart-windows-fast.ps1 -Memory -Debug
#>

param(
    [switch]$Memory,
    [switch]$Debug
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Err { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
if (-not $ScriptPath) {
    Write-Err "Could not resolve restart-windows-fast.ps1 path. Run with: powershell -ExecutionPolicy Bypass -File .\scripts\restart-windows-fast.ps1"
    exit 1
}

$ScriptDir = Split-Path -Parent $ScriptPath
$stopScript = Join-Path $ScriptDir "stop-windows.ps1"
$startScript = Join-Path $ScriptDir "start-windows-fast.ps1"

if (-not (Test-Path $stopScript)) {
    Write-Err "stop-windows.ps1 not found"
    exit 1
}

if (-not (Test-Path $startScript)) {
    Write-Err "start-windows-fast.ps1 not found"
    exit 1
}

$startArgs = @()
if ($Memory) { $startArgs += "-Memory" }
if ($Debug) { $startArgs += "-Debug" }

Write-Step "Stop services"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

Write-Step "Start services"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript @startArgs
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
