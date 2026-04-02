<#
.SYNOPSIS
  Clowder AI (Cat Cafe) - Windows Fast Startup Script

.DESCRIPTION
  Rebuilds the runtime artifacts needed by API and Frontend, then starts them
  without skill mounting or runtime provisioning. Exits after services are ready.

.EXAMPLE
  .\scripts\start-windows-fast.ps1
  .\scripts\start-windows-fast.ps1 -Memory -Debug
#>

param(
    [switch]$Memory,
    [switch]$Debug
)

$ErrorActionPreference = "Stop"

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Write-Err { param([string]$msg) Write-Host "  [ERR] $msg" -ForegroundColor Red }

function Get-ListeningProcessIdsForPort {
    param([int]$Port)

    $owners = @()
    $pattern = "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    foreach ($line in (netstat -ano -p tcp 2>$null)) {
        if ($line -match $pattern) {
            $owners += [int]$Matches[1]
        }
    }

    return @($owners | Select-Object -Unique)
}

function Test-PortListening {
    param([int]$Port)
    return (Get-ListeningProcessIdsForPort -Port $Port).Count -gt 0
}

function Wait-PortFree {
    param([int]$Port, [int]$TimeoutSec = 5)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PortListening -Port $Port)) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }

    return -not (Test-PortListening -Port $Port)
}

function Assert-PortFree {
    param([int]$Port, [string]$Name)
    if (Wait-PortFree -Port $Port) {
        return
    }
    $listeners = Get-ListeningProcessIdsForPort -Port $Port
    if ($listeners.Count -gt 0) {
        $pidList = ($listeners | Select-Object -Unique) -join ", "
        throw "Port $Port ($Name) is already in use by PID $pidList. Run .\scripts\restart-windows-fast.ps1 or .\scripts\stop-windows.ps1 first."
    }
}

function Get-LogTail {
    param([string[]]$Paths, [int]$Lines = 40)

    $chunks = @()
    foreach ($path in $Paths) {
        if (-not $path -or -not (Test-Path $path)) {
            continue
        }
        $chunks += "----- $path -----"
        $chunks += (Get-Content $path -Tail $Lines)
    }

    return ($chunks -join "`n").Trim()
}

function Wait-ServiceReady {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$Port,
        [string]$Name,
        [int]$TimeoutSec,
        [string[]]$LogPaths
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortListening -Port $Port) {
            return
        }

        $Process.Refresh()
        if ($Process.HasExited) {
            $tail = Get-LogTail -Paths $LogPaths
            if ($tail) {
                throw "$Name exited before port $Port became ready.`n$tail"
            }
            throw "$Name exited before port $Port became ready."
        }

        Start-Sleep -Milliseconds 500
    }

    $tail = Get-LogTail -Paths $LogPaths
    if ($tail) {
        throw "$Name did not listen on port $Port within $TimeoutSec seconds.`n$tail"
    }
    throw "$Name did not listen on port $Port within $TimeoutSec seconds."
}

function Stop-StartedProcess {
    param([System.Diagnostics.Process]$Process)
    if (-not $Process) {
        return
    }

    try {
        $Process.Refresh()
        if (-not $Process.HasExited) {
            Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {
    }
}

function Test-RedisReady {
    param(
        [string]$RedisCliPath,
        [int]$RedisPort,
        [string[]]$RedisAuthArgs
    )

    try {
        $redisPing = & $RedisCliPath -p $RedisPort @RedisAuthArgs ping 2>$null
        return $redisPing -eq "PONG"
    } catch {
        return $false
    }
}

function Invoke-BuildStep {
    param(
        [string]$StepLabel,
        [string]$WorkingDirectory,
        [string[]]$Arguments,
        [hashtable]$EnvironmentOverrides = @{}
    )

    Write-Host "  Building $StepLabel..."
    $envSnapshot = @{}
    foreach ($entry in $EnvironmentOverrides.GetEnumerator()) {
        $envSnapshot[$entry.Key] = [System.Environment]::GetEnvironmentVariable($entry.Key, "Process")
    }
    Push-Location $WorkingDirectory
    try {
        foreach ($entry in $EnvironmentOverrides.GetEnumerator()) {
            [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
        & $pnpmCommand @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "Build failed: $StepLabel"
        }
    } finally {
        foreach ($entry in $envSnapshot.GetEnumerator()) {
            [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
        }
        Pop-Location
    }
    Write-Ok $StepLabel
}

function Get-LatestWriteTimeUtc {
    param([string[]]$Paths)

    $latest = [datetime]::MinValue
    foreach ($path in $Paths) {
        if (-not $path -or -not (Test-Path $path)) {
            continue
        }

        $item = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        if (-not $item) {
            continue
        }

        $candidates = if ($item.PSIsContainer) {
            Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue
        } else {
            @($item)
        }

        foreach ($candidate in $candidates) {
            if ($candidate.LastWriteTimeUtc -gt $latest) {
                $latest = $candidate.LastWriteTimeUtc
            }
        }
    }

    return $latest
}

function Test-BuildRequired {
    param(
        [string[]]$SourcePaths,
        [string[]]$MarkerPaths
    )

    $markerLatest = Get-LatestWriteTimeUtc -Paths $MarkerPaths
    if ($markerLatest -eq [datetime]::MinValue) {
        return $true
    }

    $sourceLatest = Get-LatestWriteTimeUtc -Paths $SourcePaths
    if ($sourceLatest -eq [datetime]::MinValue) {
        return $false
    }

    return $sourceLatest -gt $markerLatest
}

function Invoke-BuildStepIfNeeded {
    param(
        [string]$StepLabel,
        [string]$WorkingDirectory,
        [string[]]$Arguments,
        [string[]]$SourcePaths,
        [string[]]$MarkerPaths,
        [hashtable]$EnvironmentOverrides = @{}
    )

    if (Test-BuildRequired -SourcePaths $SourcePaths -MarkerPaths $MarkerPaths) {
        Invoke-BuildStep -StepLabel $StepLabel -WorkingDirectory $WorkingDirectory -Arguments $Arguments -EnvironmentOverrides $EnvironmentOverrides
    } else {
        Write-Ok "$StepLabel (up to date)"
    }
}

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
if (-not $ScriptPath) {
    Write-Err "Could not resolve start-windows-fast.ps1 path. Run with: powershell -ExecutionPolicy Bypass -File .\scripts\start-windows-fast.ps1"
    exit 1
}

$ScriptDir = Split-Path -Parent $ScriptPath
. (Join-Path $ScriptDir "install-windows-helpers.ps1")
$ProjectRoot = Split-Path -Parent $ScriptDir
Set-Location $ProjectRoot

Write-Host "Cat Cafe - Windows Fast Startup" -ForegroundColor Cyan
Write-Host "==============================="

$envFile = Join-Path $ProjectRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile -Encoding UTF8 | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Count -eq 2) {
                $key = $parts[0].Trim()
                $val = $parts[1].Trim().Trim('"').Trim("'")
                [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
            }
        }
    }
    Write-Ok ".env loaded"
} else {
    Write-Warn ".env not found - using defaults"
}

$ApiPort = if ($env:API_SERVER_PORT) { [int]$env:API_SERVER_PORT } else { 3004 }
$WebPort = if ($env:FRONTEND_PORT) { [int]$env:FRONTEND_PORT } else { 3003 }
$RedisPort = if ($env:REDIS_PORT) { [int]$env:REDIS_PORT } else { 6399 }
$ConfiguredRedisUrl = if ($env:REDIS_URL) { $env:REDIS_URL.Trim() } else { "" }

$RunDir = Join-Path $ProjectRoot ".cat-cafe/run/windows"
New-Item -Path $RunDir -ItemType Directory -Force | Out-Null

$ApiPidFile = Join-Path $RunDir "api-$ApiPort.pid"
$WebPidFile = Join-Path $RunDir "web-$WebPort.pid"
$RuntimeStateFile = Join-Path $RunDir "runtime-state.json"
$ApiOutLog = Join-Path $RunDir "api-$ApiPort.out.log"
$ApiErrLog = Join-Path $RunDir "api-$ApiPort.err.log"
$WebOutLog = Join-Path $RunDir "web-$WebPort.out.log"
$WebErrLog = Join-Path $RunDir "web-$WebPort.err.log"

$nodeCommand = Resolve-BundledNodeCommand -ProjectRoot $ProjectRoot
if (-not $nodeCommand) {
    $nodeCommand = Resolve-ToolCommand -Name "node"
}
if (-not $nodeCommand) {
    throw "Node.js not found. Run .\scripts\install.ps1 first."
}
Write-Ok "Node: $nodeCommand"

$pnpmCommand = Resolve-ToolCommand -Name "pnpm"
if (-not $pnpmCommand) {
    throw "pnpm not found. Run .\scripts\install.ps1 first."
}
Write-Ok "pnpm: $pnpmCommand"

$nextCli = @(
    (Join-Path $ProjectRoot "packages/web/node_modules/next/dist/bin/next"),
    (Join-Path $ProjectRoot "node_modules/next/dist/bin/next")
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $nextCli) {
    throw "Next CLI not found. Run pnpm install first."
}

$mcpPath = Join-Path $ProjectRoot "packages/mcp-server/dist/index.js"
Assert-PortFree -Port $ApiPort -Name "API"
Assert-PortFree -Port $WebPort -Name "Frontend"

$apiProcess = $null
$webProcess = $null
$startedRedis = $false
$redisLayout = Resolve-PortableRedisLayout -ProjectRoot $ProjectRoot
$redisPidFile = Join-Path $redisLayout.Data "redis-$RedisPort.pid"
$redisCliPath = $null
$redisStartedPid = $null

try {
    $env:API_SERVER_PORT = "$ApiPort"
    $env:FRONTEND_PORT = "$WebPort"
    $env:NEXT_PUBLIC_API_URL = "http://127.0.0.1:$ApiPort"
    $env:CAT_CAFE_WEB_STANDALONE = "0"
    if ($Debug) {
        $env:LOG_LEVEL = "debug"
    } else {
        Remove-Item Env:LOG_LEVEL -ErrorAction SilentlyContinue
    }

    Write-Step "Build packages"
    Invoke-BuildStepIfNeeded `
        -StepLabel "shared" `
        -WorkingDirectory (Join-Path $ProjectRoot "packages/shared") `
        -Arguments @("run", "build") `
        -SourcePaths @(
            (Join-Path $ProjectRoot "packages/shared/src"),
            (Join-Path $ProjectRoot "packages/shared/package.json"),
            (Join-Path $ProjectRoot "packages/shared/tsconfig.json")
        ) `
        -MarkerPaths @(
            (Join-Path $ProjectRoot "packages/shared/dist"),
            (Join-Path $ProjectRoot "packages/shared/tsconfig.tsbuildinfo")
        )
    Invoke-BuildStepIfNeeded `
        -StepLabel "mcp-server" `
        -WorkingDirectory (Join-Path $ProjectRoot "packages/mcp-server") `
        -Arguments @("run", "build") `
        -SourcePaths @(
            (Join-Path $ProjectRoot "packages/mcp-server/src"),
            (Join-Path $ProjectRoot "packages/mcp-server/package.json"),
            (Join-Path $ProjectRoot "packages/mcp-server/tsconfig.json")
        ) `
        -MarkerPaths @(
            (Join-Path $ProjectRoot "packages/mcp-server/dist"),
            (Join-Path $ProjectRoot "packages/mcp-server/tsconfig.tsbuildinfo")
        )
    Invoke-BuildStepIfNeeded `
        -StepLabel "api" `
        -WorkingDirectory (Join-Path $ProjectRoot "packages/api") `
        -Arguments @("exec", "tsc") `
        -SourcePaths @(
            (Join-Path $ProjectRoot "packages/api/src"),
            (Join-Path $ProjectRoot "packages/api/package.json"),
            (Join-Path $ProjectRoot "packages/api/tsconfig.json")
        ) `
        -MarkerPaths @(
            (Join-Path $ProjectRoot "packages/api/dist"),
            (Join-Path $ProjectRoot "packages/api/tsconfig.tsbuildinfo")
        )
    Invoke-BuildStepIfNeeded `
        -StepLabel "web" `
        -WorkingDirectory (Join-Path $ProjectRoot "packages/web") `
        -Arguments @("run", "build") `
        -SourcePaths @(
            (Join-Path $ProjectRoot "packages/web/src"),
            (Join-Path $ProjectRoot "packages/web/worker"),
            (Join-Path $ProjectRoot "packages/web/next.config.js"),
            (Join-Path $ProjectRoot "packages/web/package.json"),
            (Join-Path $ProjectRoot "packages/web/tsconfig.json"),
            (Join-Path $ProjectRoot "packages/web/postcss.config.js"),
            (Join-Path $ProjectRoot "packages/web/tailwind.config.js")
        ) `
        -MarkerPaths @(
            (Join-Path $ProjectRoot "packages/web/.next/BUILD_ID"),
            (Join-Path $ProjectRoot "packages/web/.next/build-manifest.json")
        ) `
        -EnvironmentOverrides @{ CAT_CAFE_WEB_STANDALONE = "0" }

    $apiEntry = Join-Path $ProjectRoot "packages/api/dist/index.js"
    if (-not (Test-Path $apiEntry)) {
        throw "API build artifact not found at packages/api/dist/index.js after build."
    }

    $nextDir = Join-Path $ProjectRoot "packages/web/.next"
    if (-not (Test-Path $nextDir)) {
        throw "Frontend build artifact not found at packages/web/.next after build."
    }

    if (Test-Path $mcpPath) {
        $env:CAT_CAFE_MCP_SERVER_PATH = $mcpPath
    }

    Write-Step "Storage"

    if ($Memory) {
        Remove-Item Env:REDIS_URL -ErrorAction SilentlyContinue
        Remove-Item Env:REDIS_PORT -ErrorAction SilentlyContinue
        $env:MEMORY_STORE = "1"
        Write-Warn "Memory mode - data will be lost on restart"
    } else {
        $redisCommands = Resolve-PortableRedisBinaries -ProjectRoot $ProjectRoot
        if (-not $redisCommands) {
            $redisCommands = Resolve-GlobalRedisBinaries
        }
        if (-not $redisCommands) {
            throw "Redis binaries not found. Run .\scripts\start-windows.ps1 once to provision Redis, or use -Memory."
        }

        $redisCliPath = $redisCommands.CliPath
        $redisAuthArgs = Get-RedisAuthArgs -RedisUrl $ConfiguredRedisUrl
        $useExternalRedis = $ConfiguredRedisUrl -and -not (Test-LocalRedisUrl -RedisUrl $ConfiguredRedisUrl -RedisPort $RedisPort)

        if ($useExternalRedis) {
            $safeRedisUrl = Get-RedactedRedisUrl -RedisUrl $ConfiguredRedisUrl
            $env:REDIS_URL = $ConfiguredRedisUrl
            $env:REDIS_PORT = "$RedisPort"
            Remove-Item Env:MEMORY_STORE -ErrorAction SilentlyContinue
            Write-Ok "Using external Redis: $safeRedisUrl"
        } else {
            if (-not (Test-RedisReady -RedisCliPath $redisCliPath -RedisPort $RedisPort -RedisAuthArgs $redisAuthArgs)) {
                if (-not $redisCommands.ServerPath) {
                    throw "redis-server not found. Run .\scripts\start-windows.ps1 once to provision Redis, or use -Memory."
                }

                New-Item -Path $redisLayout.Data -ItemType Directory -Force | Out-Null
                New-Item -Path $redisLayout.Logs -ItemType Directory -Force | Out-Null
                $redisLogFile = Join-Path $redisLayout.Logs "redis-$RedisPort.log"
                $redisAclFile = Join-Path $redisLayout.Data "redis-$RedisPort.acl"
                $redisServerAuthArgs = Get-RedisServerAuthArgs -RedisUrl $ConfiguredRedisUrl -AclFilePath $redisAclFile
                $redisArgs = @(
                    "--port", $RedisPort,
                    "--bind", "127.0.0.1",
                    "--dir", (Quote-WindowsProcessArgument -Value $redisLayout.Data),
                    "--logfile", (Quote-WindowsProcessArgument -Value $redisLogFile),
                    "--pidfile", (Quote-WindowsProcessArgument -Value $redisPidFile)
                ) + $redisServerAuthArgs
                $redisProcess = Start-Process -FilePath $redisCommands.ServerPath -ArgumentList $redisArgs -PassThru -WindowStyle Hidden
                $redisStartedPid = $redisProcess.Id
                Start-Sleep -Seconds 2
                if (-not (Test-RedisReady -RedisCliPath $redisCliPath -RedisPort $RedisPort -RedisAuthArgs $redisAuthArgs)) {
                    throw "Redis did not become ready on port $RedisPort."
                }
                $startedRedis = $true
                Write-Ok "Redis started on port $RedisPort"
            } else {
                Write-Ok "Redis already running on port $RedisPort"
            }

            if ($ConfiguredRedisUrl) {
                $env:REDIS_URL = $ConfiguredRedisUrl
            } else {
                $env:REDIS_URL = "redis://localhost:$RedisPort"
            }
            $env:REDIS_PORT = "$RedisPort"
            Remove-Item Env:MEMORY_STORE -ErrorAction SilentlyContinue
        }
    }

    Write-Step "Start services"

    $apiArgs = @((Quote-WindowsProcessArgument -Value $apiEntry))
    if ($Debug) {
        $apiArgs += "--debug"
    }
    $apiProcess = Start-Process -FilePath $nodeCommand `
        -ArgumentList $apiArgs `
        -WorkingDirectory (Join-Path $ProjectRoot "packages/api") `
        -RedirectStandardOutput $ApiOutLog `
        -RedirectStandardError $ApiErrLog `
        -PassThru `
        -WindowStyle Hidden
    Wait-ServiceReady -Process $apiProcess -Port $ApiPort -Name "API" -TimeoutSec 20 -LogPaths @($ApiOutLog, $ApiErrLog)
    Set-Content -Path $ApiPidFile -Value "$($apiProcess.Id)" -Encoding ASCII
    Write-Ok "API started on http://127.0.0.1:$ApiPort"

    $webArgs = @(
        (Quote-WindowsProcessArgument -Value $nextCli),
        "start",
        (Quote-WindowsProcessArgument -Value (Join-Path $ProjectRoot "packages/web")),
        "-p", "$WebPort",
        "-H", "0.0.0.0"
    )
    $webProcess = Start-Process -FilePath $nodeCommand `
        -ArgumentList $webArgs `
        -WorkingDirectory (Join-Path $ProjectRoot "packages/web") `
        -RedirectStandardOutput $WebOutLog `
        -RedirectStandardError $WebErrLog `
        -PassThru `
        -WindowStyle Hidden
    Wait-ServiceReady -Process $webProcess -Port $WebPort -Name "Frontend" -TimeoutSec 30 -LogPaths @($WebOutLog, $WebErrLog)
    Set-Content -Path $WebPidFile -Value "$($webProcess.Id)" -Encoding ASCII
    Write-Ok "Frontend started on http://127.0.0.1:$WebPort"

    Write-WindowsRuntimeStateFile -StateFile $RuntimeStateFile -State ([ordered]@{
        GeneratedAt = (Get-Date).ToString("o")
        ProjectRoot = $ProjectRoot
        FrontendUrl = "http://127.0.0.1:$WebPort/"
        ApiUrl = "http://127.0.0.1:$ApiPort"
        ApiPort = [int]$ApiPort
        WebPort = [int]$WebPort
        RedisPort = if ($Memory) { $null } else { [int]$RedisPort }
        RedisUrl = if ($env:REDIS_URL) { $env:REDIS_URL } else { "" }
        UseExternalRedis = [bool]($ConfiguredRedisUrl -and -not (Test-LocalRedisUrl -RedisUrl $ConfiguredRedisUrl -RedisPort $RedisPort))
        RedisStartedByLauncher = [bool]$startedRedis
        PreferRandomPorts = $false
        ApiPidFile = $ApiPidFile
        WebPidFile = $WebPidFile
        RedisPidFile = $redisPidFile
    })

    Write-Host ""
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host "  Cat Cafe started (fast path)!" -ForegroundColor Green
    Write-Host "  ========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Frontend: http://localhost:$WebPort"
    Write-Host "  API:      http://localhost:$ApiPort"
    if ($Memory) {
        Write-Host "  Storage:  Memory (restart loses data)"
    } elseif ($env:REDIS_URL) {
        Write-Host "  Storage:  Redis ($($env:REDIS_URL))"
    }
    Write-Host "  Logs:     $RunDir"
    Write-Host ""
    Write-Host "  Use .\scripts\stop-windows.ps1 to stop services" -ForegroundColor Yellow
    Write-Host ""
} catch {
    Stop-StartedProcess -Process $webProcess
    Stop-StartedProcess -Process $apiProcess

    if ($startedRedis) {
        try {
            if ($redisCliPath) {
                $redisAuthArgs = Get-RedisAuthArgs -RedisUrl $ConfiguredRedisUrl
                & $redisCliPath -p $RedisPort @redisAuthArgs shutdown save 2>$null | Out-Null
            } elseif ($redisStartedPid) {
                Stop-Process -Id $redisStartedPid -Force -ErrorAction SilentlyContinue
            }
        } catch {
            if ($redisStartedPid) {
                Stop-Process -Id $redisStartedPid -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Remove-Item $ApiPidFile, $WebPidFile -ErrorAction SilentlyContinue
    Remove-WindowsRuntimeStateFile -StateFile $RuntimeStateFile
    Write-Err $_.Exception.Message
    exit 1
}
