<#
.SYNOPSIS
  Clowder AI (Cat Cafe) - Windows Stop Script

.DESCRIPTION
  Stops Cat Cafe services (API, Frontend, Redis) by port.

.EXAMPLE
  .\scripts\stop-windows.ps1
#>

$ErrorActionPreference = "Continue"

function Write-Ok   { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  [!!] $msg" -ForegroundColor Yellow }

function Get-ListeningConnectionsForPort {
    param([int]$Port)

    $connections = @()
    $pattern = "^\s*TCP\s+\S+:$Port\s+\S+\s+LISTENING\s+(\d+)\s*$"
    foreach ($line in (netstat -ano -p tcp 2>$null)) {
        if ($line -match $pattern) {
            $connections += [pscustomobject]@{
                OwningProcess = [int]$Matches[1]
            }
        }
    }

    return @($connections | Sort-Object OwningProcess -Unique)
}

$ScriptPath = if ($PSCommandPath) { $PSCommandPath } elseif ($MyInvocation.MyCommand.Path) { $MyInvocation.MyCommand.Path } else { $null }
$ScriptDir = if ($ScriptPath) { Split-Path -Parent $ScriptPath } else { $null }
if ($ScriptDir) {
    . (Join-Path $ScriptDir "install-windows-helpers.ps1")
}
$ProjectRoot = if ($ScriptDir) { Split-Path -Parent $ScriptDir } else { $null }
$RunDir = if ($ProjectRoot) { Join-Path $ProjectRoot ".cat-cafe/run/windows" } else { $null }
$RuntimeStateFile = if ($RunDir) { Join-Path $RunDir "runtime-state.json" } else { $null }
$runtimeState = Read-WindowsRuntimeStateFile -StateFile $RuntimeStateFile

Write-Host "Cat Cafe - Stopping services" -ForegroundColor Cyan
Write-Host "============================="

# Load .env for port config
$envFile = Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) ".env"
$ApiPort = 3004
$WebPort = 3003
$RedisPort = 6399

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#")) {
            $parts = $line -split "=", 2
            if ($parts.Count -eq 2) {
                $key = $parts[0].Trim()
                $val = $parts[1].Trim().Trim('"').Trim("'")
                switch ($key) {
                    "API_SERVER_PORT" { $ApiPort = [int]$val }
                    "FRONTEND_PORT"   { $WebPort = [int]$val }
                    "REDIS_PORT"      { $RedisPort = [int]$val }
                }
            }
        }
    }
}

if ($runtimeState) {
    if ($runtimeState.ApiPort) {
        $ApiPort = [int]$runtimeState.ApiPort
    }
    if ($runtimeState.WebPort) {
        $WebPort = [int]$runtimeState.WebPort
    }
    if ($runtimeState.RedisPort) {
        $RedisPort = [int]$runtimeState.RedisPort
    }
}

$configuredRedisUrl = if ($runtimeState -and $runtimeState.RedisUrl) {
    [string]$runtimeState.RedisUrl
} else {
    Get-InstallerEnvValueFromFile -EnvFile $envFile -Key "REDIS_URL"
}
$redisStartedByLauncher = [bool]($runtimeState -and $runtimeState.RedisStartedByLauncher)
if (-not $configuredRedisUrl -and $env:REDIS_URL) {
    $configuredRedisUrl = $env:REDIS_URL.Trim()
}

function Get-ManagedProcessId {
    param([string]$ManagedPidFile)
    if (-not $ManagedPidFile -or -not (Test-Path $ManagedPidFile)) {
        return $null
    }
    try {
        return [int](Get-Content $ManagedPidFile -TotalCount 1).Trim()
    } catch {
        return $null
    }
}

function Stop-ManagedProcessTree {
    param([int]$ProcessId)

    if (-not $ProcessId) {
        return $false
    }

    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $process) {
        return $false
    }

    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    return $true
}

function Get-ProcessCommandLine {
    param([int]$ProcessId)
    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        return $processInfo.CommandLine
    } catch {
        return $null
    }
}

function Get-ProcessParentId {
    param([int]$ProcessId)
    try {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        return [int]$processInfo.ParentProcessId
    } catch {
        return $null
    }
}

function Test-ClowderOwnedProcess {
    param([int]$ProcessId, [string]$ClowderProjectRoot)
    if (-not $ClowderProjectRoot) {
        return $false
    }
    $commandLine = Get-ProcessCommandLine -ProcessId $ProcessId
    if (-not $commandLine) {
        return $false
    }
    $normalizedRoot = $ClowderProjectRoot.TrimEnd('\', '/') + '\'
    return ($commandLine -like "*$normalizedRoot*") -or ($commandLine -like "*$ClowderProjectRoot`"*") -or ($commandLine -like "*$ClowderProjectRoot'*")
}

function Stop-ClowderProcessChain {
    param([int]$ProcessId, [string]$ProjectRoot)

    $visited = @{}
    $currentPid = $ProcessId
    while ($currentPid -and -not $visited.ContainsKey($currentPid)) {
        $visited[$currentPid] = $true

        if (-not (Test-ClowderOwnedProcess -ProcessId $currentPid -ClowderProjectRoot $ProjectRoot)) {
            break
        }

        $parentPid = Get-ProcessParentId -ProcessId $currentPid
        Stop-Process -Id $currentPid -Force -ErrorAction SilentlyContinue
        $currentPid = $parentPid
    }
}

function Wait-PortReleased {
    param([int]$Port, [int]$TimeoutSec = 5)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        $connections = Get-ListeningConnectionsForPort -Port $Port
        if (-not $connections) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }

    return -not (Get-ListeningConnectionsForPort -Port $Port)
}

function Stop-PortProcess {
    param([int]$Port, [string]$Name, [string]$PidFile, [string]$ProjectRoot)
    $managedPid = Get-ManagedProcessId -ManagedPidFile $PidFile
    if ($managedPid) {
        $stoppedManagedProcess = Stop-ManagedProcessTree -ProcessId $managedPid
        if ($stoppedManagedProcess) {
            Remove-Item $PidFile -ErrorAction SilentlyContinue
            if (Wait-PortReleased -Port $Port) {
                Write-Ok "Stopped $Name (port $Port)"
                return
            }
            Write-Warn "$Name (port $Port) still has a listener after managed stop"
        } else {
            Remove-Item $PidFile -ErrorAction SilentlyContinue
        }
    }

    $connections = Get-ListeningConnectionsForPort -Port $Port
    if ($connections) {
        $stopped = $false
        foreach ($conn in $connections) {
            if (-not (Test-ClowderOwnedProcess -ProcessId $conn.OwningProcess -ClowderProjectRoot $ProjectRoot)) {
                Write-Warn "Skipping non-Clowder $Name listener on port $Port (PID $($conn.OwningProcess))"
                continue
            }
            Stop-ClowderProcessChain -ProcessId $conn.OwningProcess -ProjectRoot $ProjectRoot
            $stopped = $true
        }
        if ($stopped) {
            Remove-Item $PidFile -ErrorAction SilentlyContinue
            if (Wait-PortReleased -Port $Port) {
                Write-Ok "Stopped $Name (port $Port)"
            } else {
                Write-Warn "$Name (port $Port) still has a listener after stop"
            }
        } else {
            Write-Warn "$Name (port $Port) - no Clowder-owned listener found"
        }
    } else {
        Write-Warn "$Name (port $Port) - not running"
    }
}

$ApiPidFile = if ($runtimeState -and $runtimeState.ApiPidFile) {
    [string]$runtimeState.ApiPidFile
} elseif ($RunDir) {
    Join-Path $RunDir "api-$ApiPort.pid"
} else {
    $null
}
$WebPidFile = if ($runtimeState -and $runtimeState.WebPidFile) {
    [string]$runtimeState.WebPidFile
} elseif ($RunDir) {
    Join-Path $RunDir "web-$WebPort.pid"
} else {
    $null
}

Stop-PortProcess -Port $ApiPort -Name "API Server" -PidFile $ApiPidFile -ProjectRoot $ProjectRoot
Stop-PortProcess -Port $WebPort -Name "Frontend" -PidFile $WebPidFile -ProjectRoot $ProjectRoot

# Stop Redis if running on our port
$redisCommands = $null
$redisLayout = if ($ProjectRoot) { Resolve-PortableRedisLayout -ProjectRoot $ProjectRoot } else { $null }
$redisPidFile = if ($runtimeState -and $runtimeState.RedisPidFile) {
    [string]$runtimeState.RedisPidFile
} elseif ($redisLayout) {
    Join-Path $redisLayout.Data "redis-$RedisPort.pid"
} else {
    $null
}
if ($ProjectRoot) {
    $redisCommands = Resolve-PortableRedisBinaries -ProjectRoot $ProjectRoot
}
if (-not $redisCommands) {
    $redisCommands = Resolve-GlobalRedisBinaries
}

if ($configuredRedisUrl -and -not (Test-LocalRedisUrl -RedisUrl $configuredRedisUrl -RedisPort $RedisPort)) {
    Write-Warn "Skipping local Redis shutdown because REDIS_URL points to an external host"
} else {
    try {
        if (-not $redisCommands -or -not $redisCommands.CliPath) {
            throw "redis-cli unavailable"
        }
        $redisConnections = Get-ListeningConnectionsForPort -Port $RedisPort
        if (-not $redisConnections) {
            Write-Warn "Redis (port $RedisPort) - not running"
        } else {
            $managedRedisPid = Get-ManagedProcessId -ManagedPidFile $redisPidFile
            $redisStopped = $false
            if ($redisStartedByLauncher -and $managedRedisPid) {
                if (Stop-ManagedProcessTree -ProcessId $managedRedisPid) {
                    Write-Ok "Redis stopped (port $RedisPort)"
                    Remove-Item $redisPidFile -ErrorAction SilentlyContinue
                    $redisStopped = $true
                }
            }
            if (-not $redisStopped) {
                $ownedRedisConnections = @()
                if ($redisStartedByLauncher) {
                    $ownedRedisConnections = @($redisConnections)
                }
                foreach ($conn in $redisConnections) {
                    if ($redisStartedByLauncher) {
                        break
                    }
                    $isManagedPid = $managedRedisPid -and ($conn.OwningProcess -eq $managedRedisPid)
                    $isClowderOwned = $isManagedPid -or (Test-ClowderOwnedProcess -ProcessId $conn.OwningProcess -ClowderProjectRoot $ProjectRoot)
                    if (-not $isClowderOwned) {
                        Write-Warn "Skipping non-Clowder Redis listener on port $RedisPort (PID $($conn.OwningProcess))"
                        continue
                    }
                    $ownedRedisConnections += $conn
                }
                if ($ownedRedisConnections.Count -eq 0) {
                    Write-Warn "Redis (port $RedisPort) - no Clowder-owned listener found"
                } else {
                    $redisCli = $redisCommands.CliPath
                    $redisAuthArgs = Get-RedisAuthArgs -RedisUrl $configuredRedisUrl
                    $redisPing = & $redisCli -p $RedisPort @redisAuthArgs ping 2>$null
                    if ($redisPing -eq "PONG") {
                        & $redisCli -p $RedisPort @redisAuthArgs shutdown save 2>$null
                        Write-Ok "Redis stopped (port $RedisPort)"
                    } elseif ($redisStartedByLauncher -and $managedRedisPid) {
                        Stop-Process -Id $managedRedisPid -Force -ErrorAction SilentlyContinue
                        Write-Warn "Redis required forced termination (port $RedisPort)"
                    } else {
                        Write-Warn "Redis (port $RedisPort) - not running"
                    }
                }
            }
        }
    } catch {
        Write-Warn "Redis (port $RedisPort) - not running"
    }
}

Remove-Item $ApiPidFile -ErrorAction SilentlyContinue
Remove-Item $WebPidFile -ErrorAction SilentlyContinue
Remove-Item $redisPidFile -ErrorAction SilentlyContinue
Remove-WindowsRuntimeStateFile -StateFile $RuntimeStateFile

Write-Host "`nAll services stopped." -ForegroundColor Green
