<#
 .SYNOPSIS
    One-click launcher for the Aeolus workbench (backend / Python compute / frontend).
    Starts all services in the background; does not block the terminal.

 .DESCRIPTION
    - No args: launch all services in order (backend -> Python compute -> frontend),
      each in its own background process with logs and recorded PIDs.
    - With args: legacy mode - run a script via the project venv python
      (.\run.ps1 script.py [args...]).

    Features: environment readiness check, port-based de-duplication (won't
    re-launch an already-running service), per-service stdout/stderr log files,
    PID recorder (logs/service_pids.json), and clear failure reporting.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition

# ---- Legacy mode: run a python script with the project venv ----
if ($args.Count -gt 0) {
    $py = Join-Path $root "python/.venv/Scripts/python.exe"
    if (-not (Test-Path $py)) { Write-Error "venv not found: $py"; exit 1 }
    & $py @args
    exit $LASTEXITCODE
}

# ===================== dirs / logs =====================
$logDir = Join-Path $root "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$pidFile = Join-Path $logDir "service_pids.json"

# ===================== helpers =====================
function Test-PortListening($port) {
    try {
        return ($null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1))
    } catch { return $false }
}
function Get-PortPid($port) {
    try {
        return (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    } catch { return $null }
}
function Test-PidAlive($procId) {
    if (-not $procId) { return $false }
    return ($null -ne (Get-Process -Id $procId -ErrorAction SilentlyContinue))
}
function Write-Status($name, $status, $detail) {
    $color = 'White'
    if ($status -eq 'UP') { $color = 'Green' }
    elseif ($status -eq 'STARTING') { $color = 'Yellow' }
    elseif ($status -eq 'SKIP') { $color = 'Cyan' }
    elseif ($status -eq 'FAIL') { $color = 'Red' }
    Write-Host ("  [{0,-8}] {1}" -f $status, $name) -ForegroundColor $color
    if ($detail) { Write-Host ("            $detail") -ForegroundColor Gray }
}
function Tail-Log($path, $lines) {
    if (-not (Test-Path $path)) { return }
    Write-Host ("            --- $path (last $lines lines) ---") -ForegroundColor DarkGray
    Get-Content -Path $path -Tail $lines | ForEach-Object { Write-Host ("            $_") -ForegroundColor DarkGray }
}

# ===================== environment check =====================
Write-Host "`n=== Environment check ===" -ForegroundColor Cyan
$nodeOk = ($null -ne (Get-Command node -ErrorAction SilentlyContinue))
$npmOk  = ($null -ne (Get-Command npm  -ErrorAction SilentlyContinue))
$pyVenv = Join-Path $root "python/.venv/Scripts/python.exe"
$venvOk = Test-Path $pyVenv

if ($nodeOk) { $nodeVer = node --version } else { $nodeVer = 'NOT FOUND' }
if ($npmOk)  { $npmVer  = npm --version; $npmCmd = (Get-Command npm).Source } else { $npmVer  = 'NOT FOUND'; $npmCmd = 'npm' }
if ($venvOk) { $venvPath = $pyVenv } else { $venvPath = 'NOT FOUND' }

Write-Status "Node.js"      $(if ($nodeOk) { 'UP' } else { 'FAIL' }) $nodeVer
Write-Status "npm"          $(if ($npmOk)  { 'UP' } else { 'FAIL' }) $npmVer
Write-Status "Python venv"  $(if ($venvOk) { 'UP' } else { 'FAIL' }) $venvPath

if (-not ($nodeOk -and $npmOk -and $venvOk)) {
    Write-Host "`nEnvironment not ready. Fix the items above before launching." -ForegroundColor Red
    exit 1
}

# ===================== service list (order = start order) =====================
$services = @(
    @{
        Name = 'Backend (NestJS)'; Port = 8787; Dir = 'backend'; Log = 'backend'
        Cmd  = $npmCmd; Args = @('run', 'start')
        NeedModules = $true
    },
    @{
        Name = 'Python Compute'; Port = 8900; Dir = 'python'; Log = 'python-compute'
        Cmd  = $pyVenv; Args = @('-m', 'gunicorn', '-k', 'uvicorn.workers.UvicornWorker', '-w', '4', '--bind', '127.0.0.1:8900', 'compute_api.main:app')
        NeedModules = $false
    },
    @{
        Name = 'Frontend (Vite)'; Port = 5173; Dir = 'web'; Log = 'web'
        Cmd  = $npmCmd; Args = @('run', 'dev')
        NeedModules = $true
    }
)

# ===================== load existing pid records =====================
$pidRecords = @()
if (Test-Path $pidFile) {
    try { $pidRecords = Get-Content -Path $pidFile -Raw | ConvertFrom-Json } catch { $pidRecords = @() }
}
if ($pidRecords -is [System.Management.Automation.PSCustomObject]) { $pidRecords = @($pidRecords) }

# ===================== 为 Python 计算服务注入 NEST_AUTH_TOKEN =====================
# 单一配置来源 = 仓库根 .env（与 systemd / Nest 同一份）。nest_client 优先用 NEST_AUTH_TOKEN，
# 缺失时回退读仓库根 .env 的 AUTH_TOKEN。这里显式注入，避免依赖隐式回退。
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    $tokLine = Get-Content -Path $envFile | Where-Object { $_ -match '^AUTH_TOKEN=' } | Select-Object -First 1
    if ($tokLine) {
        $env:NEST_AUTH_TOKEN = $tokLine.Substring($tokLine.IndexOf('=') + 1).Trim()
        Write-Host ("  [env] NEST_AUTH_TOKEN injected from .env (len=" + $env:NEST_AUTH_TOKEN.Length + ")") -ForegroundColor DarkGray
    } else {
        Write-Host "  [env] 仓库根 .env 未找到 AUTH_TOKEN，Python 计算服务将走 nest_client 回退" -ForegroundColor Yellow
    }
} else {
    Write-Host "  [env] 仓库根 .env 不存在，Python 计算服务将走 nest_client 回退" -ForegroundColor Yellow
}

Write-Host "`n=== Starting services (background) ===" -ForegroundColor Cyan
$results = @()

foreach ($svc in $services) {
    $svcDir = Join-Path $root $svc.Dir
    $outLog = Join-Path $logDir ($svc.Log + '.log')
    $errLog = Join-Path $logDir ($svc.Log + '.err.log')

    # --- de-dup by port: skip if already listening ---
    $existingPid = Get-PortPid $svc.Port
    if ($existingPid -and (Test-PidAlive $existingPid)) {
        Write-Status $svc.Name 'SKIP' ("port $($svc.Port) already used by PID $existingPid; reusing")
        $results += [PSCustomObject]@{ name = $svc.Name; pid = [int]$existingPid; port = $svc.Port; logOut = $outLog; logErr = $errLog; startedAt = (Get-Date).ToString('s') }
        continue
    }

    # --- dependency check: node_modules for frontend/backend ---
    if ($svc.NeedModules) {
        $modDir = Join-Path $svcDir 'node_modules'
        if (-not (Test-Path $modDir)) {
            Write-Host ("  node_modules missing, running npm install for $($svc.Name) ...") -ForegroundColor Yellow
            $instLog = Join-Path $logDir ($svc.Log + '.install.log')
            $inst = Start-Process -FilePath 'npm' -ArgumentList @('install') -WorkingDirectory $svcDir `
                -WindowStyle Hidden -RedirectStandardOutput $instLog -RedirectStandardError $instLog -Wait -PassThru
            if ($inst.ExitCode -ne 0) {
                Write-Status $svc.Name 'FAIL' ("npm install failed (exit $($inst.ExitCode)); see $instLog")
                Tail-Log $instLog
                $results += [PSCustomObject]@{ name = $svc.Name; pid = $null; port = $svc.Port; logOut = $outLog; logErr = $errLog; startedAt = $null }
                continue
            }
        }
    }

    # --- launch ---
    try {
        $proc = Start-Process -FilePath $svc.Cmd -ArgumentList $svc.Args `
            -WorkingDirectory $svcDir -WindowStyle Hidden `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    } catch {
        Write-Status $svc.Name 'FAIL' ("launch failed: $_")
        $results += [PSCustomObject]@{ name = $svc.Name; pid = $null; port = $svc.Port; logOut = $outLog; logErr = $errLog; startedAt = $null }
        continue
    }

    # --- readiness probe (port listen, up to 12s) ---
    $up = $false
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Seconds 1
        if (Test-PortListening $svc.Port) { $up = $true; break }
        if (-not (Test-PidAlive $proc.Id)) { break }
    }

    if ($up) {
        Write-Status $svc.Name 'UP' ("PID $($proc.Id)  port $($svc.Port)  log $outLog")
        $results += [PSCustomObject]@{ name = $svc.Name; pid = $proc.Id; port = $svc.Port; logOut = $outLog; logErr = $errLog; startedAt = (Get-Date).ToString('s') }
    } elseif (Test-PidAlive $proc.Id) {
        Write-Status $svc.Name 'STARTING' ("PID $($proc.Id) launched but port $($svc.Port) not listening yet (still initializing)")
        $results += [PSCustomObject]@{ name = $svc.Name; pid = $proc.Id; port = $svc.Port; logOut = $outLog; logErr = $errLog; startedAt = (Get-Date).ToString('s') }
    } else {
        Write-Status $svc.Name 'FAIL' ("process exited; port $($svc.Port) not listening; see $errLog")
        Tail-Log $errLog
        $results += [PSCustomObject]@{ name = $svc.Name; pid = $null; port = $svc.Port; logOut = $outLog; logErr = $errLog; startedAt = $null }
    }
}

# ===================== save pid records =====================
$results | ConvertTo-Json -Compress | Set-Content -Path $pidFile -Encoding UTF8

# ===================== summary =====================
Write-Host "`n=== Summary ===" -ForegroundColor Cyan
Write-Host ("  {0,-18} {1,-10} {2,-8} {3}" -f 'Service', 'Status', 'PID', 'Port') -ForegroundColor White
foreach ($r in $results) {
    $st = 'Not started'
    if ($r.pid) { $st = 'Running' }
    $pidStr = '-'
    if ($r.pid) { $pidStr = [string]$r.pid }
    Write-Host ("  {0,-18} {1,-10} {2,-8} {3}" -f $r.name, $st, $pidStr, $r.port)
}
Write-Host "`nPID record: $pidFile" -ForegroundColor Gray
Write-Host "Log dir:    $logDir" -ForegroundColor Gray
Write-Host "Frontend:   http://127.0.0.1:5173" -ForegroundColor Gray
Write-Host ""
