[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Status', 'Compact')]
    [string]$Mode
)

$ErrorActionPreference = 'Stop'

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

function Get-VhdxStatus {
    $rows = @()
    foreach ($p in (Find-VhdxFiles)) {
        $fi = Get-Item -LiteralPath $p
        $rows += [pscustomobject]@{
            path  = $fi.FullName
            bytes = [int64]$fi.Length
        }
    }
    return $rows
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Mode -eq 'Status') {
    $vhdx = Get-VhdxStatus
    $payload = [pscustomobject]@{
        admin = (Test-Admin)
        vhdx  = $vhdx
    }
    $payload | ConvertTo-Json -Compress
    return
}

# --- Compact mode (requires admin) ---
if (-not (Test-Admin)) {
    Write-Error 'compact.ps1 -Mode Compact must run elevated.'
    exit 1
}

$lockPath = Join-Path $env:TEMP 'dsm-compact.lock'
try {
    $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $lockBytes = [System.Text.Encoding]::UTF8.GetBytes("pid=$PID started=$(Get-Date -Format o)")
    $lockStream.Write($lockBytes, 0, $lockBytes.Length)
} catch {
    Write-Error "Another Docker Space Manager compaction is already running. If this is stale, remove $lockPath after confirming no compaction window is open."
    exit 1
}

try {
Write-Host '==> Stopping Docker Desktop and WSL'
# Try the documented graceful path first: `Docker Desktop.exe -Quit` triggers an
# orderly engine + tray shutdown. Fall back to Stop-Process only if processes
# linger past the grace window, so we don't slam containers mid-flush unnecessarily.
$dockerProcs = @('Docker Desktop', 'com.docker.backend', 'com.docker.service', 'com.docker.dev-envs', 'Docker.Desktop.Service')

$exeCandidates = @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if ($exeCandidates) {
    Write-Host "  graceful: $exeCandidates -Quit"
    try {
        Start-Process -FilePath $exeCandidates -ArgumentList '-Quit' -ErrorAction Stop | Out-Null
    } catch {
        Write-Host "  graceful quit failed: $($_.Exception.Message)"
    }
}

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

Write-Host '==> Done. Restart Docker Desktop manually if it did not relaunch automatically.'
($summary | ConvertTo-Json -Compress) | Out-File -FilePath (Join-Path $env:TEMP 'dsm-compact-result.json') -Encoding utf8
} finally {
    if ($lockStream) { $lockStream.Dispose() }
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
