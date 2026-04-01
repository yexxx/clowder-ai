<#
.SYNOPSIS
  Clowder AI (Cat Cafe) - Windows Restart Script

.DESCRIPTION
  Stops Clowder services and starts them again with the same startup flags.

.EXAMPLE
  .\scripts\restart-windows.ps1
  .\scripts\restart-windows.ps1 -Quick -Dev
#>

param(
    [switch]$Quick,
    [switch]$Memory,
    [switch]$Dev,
    [switch]$Debug
)

$ErrorActionPreference = "Stop"

function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Err   { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
if (-not $ScriptPath) {
    Write-Err "Could not resolve restart-windows.ps1 path. Run with: powershell -ExecutionPolicy Bypass -File .\scripts\restart-windows.ps1"
    exit 1
}

$ScriptDir = Split-Path -Parent $ScriptPath
$stopScript = Join-Path $ScriptDir "stop-windows.ps1"
$startScript = Join-Path $ScriptDir "start-windows.ps1"

if (-not (Test-Path $stopScript)) {
    Write-Err "stop-windows.ps1 not found"
    exit 1
}

if (-not (Test-Path $startScript)) {
    Write-Err "start-windows.ps1 not found"
    exit 1
}

$startArgs = @()
if ($Quick) { $startArgs += "-Quick" }
if ($Memory) { $startArgs += "-Memory" }
if ($Dev) { $startArgs += "-Dev" }
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
