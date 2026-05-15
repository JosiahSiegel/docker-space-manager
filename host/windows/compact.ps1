[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Status', 'Compact')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Docker Desktop's host CLI captures stdout as UTF-8. Windows PowerShell 5.1
# defaults to the console code page, which would corrupt the JSON payload.
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
}
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script:LogPath = Join-Path $env:TEMP 'dsm-host.log'
function Write-DsmLog {
    param([string]$Message)
    try {
        $line = "[{0}] [{1}] {2}" -f (Get-Date -Format 'o'), $Mode, $Message
        Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
    }
}
Write-DsmLog "start pid=$PID psver=$($PSVersionTable.PSVersion) host=$($Host.Name)"

$script:HasGetVHD = [bool](Get-Command Get-VHD -ErrorAction SilentlyContinue)
Write-DsmLog "HasGetVHD=$script:HasGetVHD"

function Find-VhdxFiles {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Docker\wsl\disk\docker_data.vhdx'),
        (Join-Path $env:LOCALAPPDATA 'Docker\wsl\data\ext4.vhdx'),
        (Join-Path $env:LOCALAPPDATA 'Docker\wsl\main\ext4.vhdx')
    )
    $dockerRoot = Join-Path $env:LOCALAPPDATA 'Docker\wsl'
    if (Test-Path $dockerRoot) {
        $found = Get-ChildItem -Path $dockerRoot -Recurse -Filter '*.vhdx' -ErrorAction SilentlyContinue |
                 Select-Object -ExpandProperty FullName
        $candidates = @($candidates + $found) | Sort-Object -Unique
    }
    $candidates | Where-Object { Test-Path $_ }
}

function Get-EngineUsedBytes {
    # Single-quoted on purpose: PowerShell would otherwise eat $3 as a variable
    # (and backslash is not its escape character).
    $shCmd = 'df -B1 / 2>/dev/null | tail -n 1 | awk ''{print $3}'''
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-DsmLog 'engine: docker.exe not on PATH'
        return $null
    }
    $prevErr = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $vmUsage = & docker run --rm --privileged --pid=host alpine sh -c $shCmd 2>$null
        $code = $LASTEXITCODE
        Write-DsmLog "engine: docker exit=$code raw=[$vmUsage]"
        if ($code -eq 0 -and $vmUsage) {
            $trimmed = ($vmUsage | Out-String).Trim()
            if ($trimmed -match '^\d+$') {
                $usedBytes = [int64]$trimmed
                Write-DsmLog "engine: usedBytes=$usedBytes"
                if ($usedBytes -gt 0) { return $usedBytes }
            } else {
                Write-DsmLog "engine: unparseable output [$trimmed]"
            }
        }
    } catch {
        Write-DsmLog "engine: exception $($_.Exception.Message)"
    } finally {
        $ErrorActionPreference = $prevErr
    }
    return $null
}

function Get-VhdxStatus {
    $rows = @()
    foreach ($p in (Find-VhdxFiles)) {
        try {
            $fi = Get-Item -LiteralPath $p -ErrorAction Stop
        } catch {
            continue
        }

        $row = [ordered]@{
            path  = $fi.FullName
            bytes = [int64]$fi.Length
        }

        if ($script:HasGetVHD) {
            try {
                $vhd = Get-VHD -Path $fi.FullName -ErrorAction Stop
                if ($null -ne $vhd.FileSize) { $row.fileSize = [int64]$vhd.FileSize }
                if ($null -ne $vhd.MinimumSize) { $row.minimumSize = [int64]$vhd.MinimumSize }
            } catch {
                # Missing permissions, locked files, or unsupported VHDX states should not block status.
            }
        }

        $rows += [pscustomobject]$row
    }

    $needsVmEstimate = $rows | Where-Object { -not $_.PSObject.Properties['minimumSize'] } | Sort-Object -Property bytes -Descending | Select-Object -First 1
    if ($needsVmEstimate) {
        $usedBytes = Get-EngineUsedBytes
        if ($null -ne $usedBytes) {
            $needsVmEstimate | Add-Member -NotePropertyName usedBytes -NotePropertyValue ([int64]$usedBytes) -Force
        }
    }

    return ,$rows
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-DockerDesktopExe {
    # Probe live process, registry, PATH, then default install dirs. The
    # ProgramFiles fallback is last because users with custom install paths or
    # non-C: drive installs would otherwise be told to restart manually.
    try {
        $proc = Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc -and $proc.Path -and (Test-Path -LiteralPath $proc.Path)) { return $proc.Path }
    } catch { }

    foreach ($key in 'HKLM:\SOFTWARE\Docker Inc.\Docker\1.0', 'HKCU:\SOFTWARE\Docker Inc.\Docker\1.0') {
        try {
            $appPath = (Get-ItemProperty -Path $key -Name 'AppPath' -ErrorAction Stop).AppPath
            if ($appPath) {
                $exe = Join-Path $appPath 'Docker Desktop.exe'
                if (Test-Path -LiteralPath $exe) { return $exe }
            }
        } catch { }
    }

    foreach ($key in 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop',
                     'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Docker Desktop') {
        try {
            $installLoc = (Get-ItemProperty -Path $key -Name 'InstallLocation' -ErrorAction Stop).InstallLocation
            if ($installLoc) {
                $exe = Join-Path $installLoc 'Docker Desktop.exe'
                if (Test-Path -LiteralPath $exe) { return $exe }
            }
        } catch { }
    }

    try {
        $cmd = Get-Command 'Docker Desktop.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source)) { return $cmd.Source }
    } catch { }

    foreach ($p in @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe')
    )) {
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    return $null
}

if ($Mode -eq 'Status') {
    $vhdx = Get-VhdxStatus
    $payload = [pscustomobject]@{
        admin = (Test-Admin)
        vhdx  = $vhdx
    }
    $json = $payload | ConvertTo-Json -Compress -Depth 6
    Write-DsmLog "status payload=$json"
    # Explicit UTF-8, no BOM, no trailing CRLF mangling. [Console]::Out is a
    # TextWriter already wired to OutputEncoding (set at script top).
    [Console]::Out.Write($json)
    [Console]::Out.Write([Environment]::NewLine)
    [Console]::Out.Flush()
    return
}

function Wait-ForExit {
    param([string]$Message = 'Press Enter to close this window')
    try { Read-Host $Message | Out-Null } catch { }
}

# --- Compact mode (requires admin) ---
if (-not (Test-Admin)) {
    Write-Host 'ERROR: compact.ps1 -Mode Compact must run elevated.' -ForegroundColor Red
    Wait-ForExit
    exit 1
}

$lockPath = Join-Path $env:TEMP 'dsm-compact.lock'
function Open-CompactLock {
    param([string]$Path)
    return [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
}

$lockStream = $null
try {
    $lockStream = Open-CompactLock -Path $lockPath
} catch {
    # CreateNew failed. Inspect the existing lock: if the PID it names is no
    # longer alive, the lock is stale (previous run crashed before its finally
    # ran) and we can safely reclaim it.
    $stale = $false
    try {
        $existing = Get-Content -LiteralPath $lockPath -ErrorAction Stop -Raw
        Write-DsmLog "lock: existing contents=[$existing]"
        if ($existing -match 'pid=(\d+)') {
            $heldPid = [int]$Matches[1]
            $holder = Get-Process -Id $heldPid -ErrorAction SilentlyContinue
            if (-not $holder) {
                Write-DsmLog "lock: holder pid=$heldPid no longer alive, treating as stale"
                $stale = $true
            } else {
                Write-DsmLog "lock: holder pid=$heldPid still alive ($($holder.ProcessName))"
            }
        } else {
            Write-DsmLog 'lock: no pid recorded, treating as stale'
            $stale = $true
        }
    } catch {
        Write-DsmLog "lock: could not read existing lock ($($_.Exception.Message)), treating as stale"
        $stale = $true
    }

    if ($stale) {
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
        try {
            $lockStream = Open-CompactLock -Path $lockPath
        } catch {
            Write-Host "ERROR: Could not acquire compaction lock at $lockPath even after removing stale entry: $($_.Exception.Message)" -ForegroundColor Red
            Wait-ForExit
            exit 1
        }
    } else {
        Write-Host "ERROR: Another Space Manager compaction is already running (lock at $lockPath). If this is wrong, close any other compaction window and delete that file." -ForegroundColor Red
        Wait-ForExit
        exit 1
    }
}

$lockBytes = [System.Text.Encoding]::UTF8.GetBytes("pid=$PID started=$(Get-Date -Format o)")
$lockStream.Write($lockBytes, 0, $lockBytes.Length)
$lockStream.Flush()

try {
Write-Host '==> Stopping Docker Desktop and WSL'
# Graceful shutdown order, fall-through on failure:
#   1. `docker desktop stop` (Docker Desktop 4.37+ CLI; reliable when present)
#   2. `Docker Desktop.exe -Quit` (older releases)
#   3. Stop-Process after the grace window, so we never slam containers mid-flush
#      unless the orderly paths actually fail.
$dockerProcs = @('Docker Desktop', 'com.docker.backend', 'com.docker.service', 'com.docker.dev-envs', 'Docker.Desktop.Service')

$dockerDesktopExe = Resolve-DockerDesktopExe
Write-DsmLog "resolved dockerDesktopExe=$dockerDesktopExe"

function Invoke-DockerDesktopStopBounded {
    param([int]$TimeoutSeconds = 25)
    $dockerExe = (Get-Command docker -ErrorAction SilentlyContinue).Source
    if (-not $dockerExe) { return 'missing' }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $dockerExe
    $psi.Arguments = 'desktop stop'
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $proc = [System.Diagnostics.Process]::Start($psi)

    if ($proc.WaitForExit($TimeoutSeconds * 1000)) {
        $stdout = $proc.StandardOutput.ReadToEnd()
        $stderr = $proc.StandardError.ReadToEnd()
        Write-DsmLog "graceful: docker desktop stop exit=$($proc.ExitCode) out=[$stdout] err=[$stderr]"
        if ($proc.ExitCode -eq 0) { return 'ok' }
        return 'failed'
    }

    Write-Host '  docker desktop stop did not return within timeout; killing CLI and falling back'
    Write-DsmLog 'graceful: docker desktop stop timed out, killing CLI'
    try { $proc.Kill() } catch { }
    return 'timeout'
}

$gracefulIssued = $false
Write-Host '  graceful: docker desktop stop (timeout 25s)'
$stopResult = Invoke-DockerDesktopStopBounded -TimeoutSeconds 25
if ($stopResult -eq 'ok') { $gracefulIssued = $true }

if (-not $gracefulIssued -and $dockerDesktopExe) {
    Write-Host "  graceful: `"$dockerDesktopExe`" -Quit"
    try {
        Start-Process -FilePath $dockerDesktopExe -ArgumentList '-Quit' -ErrorAction Stop | Out-Null
        $gracefulIssued = $true
    } catch {
        Write-Host "  graceful quit failed: $($_.Exception.Message)"
        Write-DsmLog "graceful: -Quit threw $($_.Exception.Message)"
    }
}

if (-not $gracefulIssued) {
    Write-Host '  no graceful shutdown path completed; will rely on force-stop'
}

Write-Host '  waiting up to 20s for Docker processes to exit...'
$gracefulDeadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $gracefulDeadline) {
    $still = $dockerProcs | ForEach-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue }
    if (-not $still) { break }
    Start-Sleep -Milliseconds 500
}

$leftover = $dockerProcs | ForEach-Object { Get-Process -Name $_ -ErrorAction SilentlyContinue }
if ($leftover) {
    Write-Host '  graceful shutdown timed out; force-stopping leftover processes'
    $leftover | Stop-Process -Force -ErrorAction SilentlyContinue
}

& wsl.exe --shutdown | Out-Null
Start-Sleep -Seconds 3

$before = Get-VhdxStatus
foreach ($v in $before) { Write-Host ("  before: {0,12:N0} bytes  {1}" -f $v.bytes, $v.path) }

foreach ($v in $before) {
    Write-Host "==> Compacting $($v.path)"
    $script = @"
select vdisk file="$($v.path)"
attach vdisk readonly
compact vdisk
detach vdisk
exit
"@
    $tmp = New-TemporaryFile
    Set-Content -LiteralPath $tmp.FullName -Value $script -Encoding ASCII
    try {
        & diskpart.exe /s $tmp.FullName | Out-Host
    } finally {
        Remove-Item -LiteralPath $tmp.FullName -Force -ErrorAction SilentlyContinue
    }
}

$after = Get-VhdxStatus
$summary = @()
foreach ($a in $after) {
    $b = $before | Where-Object { $_.path -eq $a.path } | Select-Object -First 1
    $delta = if ($b) { [int64]($b.bytes - $a.bytes) } else { 0 }
    Write-Host ("  after:  {0,12:N0} bytes  {1}  (reclaimed {2:N0} bytes)" -f $a.bytes, $a.path, $delta)
    $summary += [pscustomobject]@{ path = $a.path; before = ($b.bytes); after = $a.bytes; reclaimed = $delta }
}

($summary | ConvertTo-Json -Compress) | Out-File -FilePath (Join-Path $env:TEMP 'dsm-compact-result.json') -Encoding utf8
if ($dockerDesktopExe) {
    Write-Host '==> Done. Restarting Docker Desktop...'
    try {
        Start-Process -FilePath $dockerDesktopExe -ErrorAction Stop | Out-Null
        Write-DsmLog "restart: launched $dockerDesktopExe"
    } catch {
        Write-DsmLog "restart: failed $($_.Exception.Message)"
        Write-Host "==> Done. Restart Docker Desktop manually: $dockerDesktopExe"
    }
} else {
    Write-DsmLog 'restart: Docker Desktop executable not found'
    Write-Host '==> Done. Restart Docker Desktop manually.'
}
try {
    Read-Host 'Press Enter to close this window'
} catch {
}
} finally {
    if ($lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
