[CmdletBinding()]
param(
    [string]$Tag = 'local/docker-space-manager:latest',
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "==> Building $Tag from $repoRoot"
& docker build --tag=$Tag $repoRoot
if ($LASTEXITCODE -ne 0) { throw "docker build failed (exit $LASTEXITCODE)" }

$installed = $false
try {
    $list = & docker extension ls 2>$null
    if ($LASTEXITCODE -eq 0 -and $list -match [regex]::Escape(($Tag -split ':')[0])) {
        $installed = $true
    }
} catch { }

if ($Install -or -not $installed) {
    Write-Host "==> Installing $Tag"
    & docker extension install -f $Tag
} else {
    Write-Host "==> Updating $Tag"
    & docker extension update -f $Tag
}
if ($LASTEXITCODE -ne 0) { throw "docker extension command failed (exit $LASTEXITCODE)" }

Write-Host "==> Done"
