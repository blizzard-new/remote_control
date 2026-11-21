# Install the relay alongside a Windows Caddy + Docker Desktop setup.
[CmdletBinding()]
param(
    [string]$Caddyfile = 'C:\uniway\caddy\Caddyfile',
    [switch]$RestartSharedCaddy
)
$ErrorActionPreference = 'Stop'
$RelayDomain = 'remote.uniway-tw.com'
$Caddyfile = (Resolve-Path -LiteralPath $Caddyfile).Path
$CaddyExe = Join-Path (Split-Path $Caddyfile) 'caddy.exe'
$ComposeFile = Join-Path $PSScriptRoot 'compose.yaml'
$BlockFile = Join-Path $PSScriptRoot 'Caddyfile.remote'
if (-not (Test-Path -LiteralPath $CaddyExe)) { throw "Missing $CaddyExe" }

& docker compose -f $ComposeFile up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Docker could not start the remote-control relay.' }
$Ready = $false
for ($i = 0; $i -lt 20; $i++) {
    try {
        $Health = Invoke-RestMethod 'http://127.0.0.1:8788/health' -TimeoutSec 3
        if ($Health.service -eq 'remote-control' -and $Health.protocol -eq 1) { $Ready = $true; break }
    } catch { Start-Sleep 1 }
}
if (-not $Ready) { throw 'The local relay health check on 127.0.0.1:8788 failed.' }
[Net.Dns]::GetHostAddresses($RelayDomain) | Out-Null

function Test-PublicRelay {
    try {
        $Response = Invoke-RestMethod "https://$RelayDomain/health" -TimeoutSec 5
        return $Response.service -eq 'remote-control' -and $Response.protocol -eq 1
    } catch { return $false }
}
function Update-Caddy {
    & $CaddyExe reload --config $Caddyfile --adapter caddyfile
    if ($LASTEXITCODE -eq 0) { return }
    if (-not $RestartSharedCaddy) { throw 'Graceful reload unavailable. If the Caddy admin API is disabled, run with -RestartSharedCaddy from an elevated PowerShell.' }
    $Task = Get-ScheduledTask -TaskName 'UniWay-Caddy'
    if (($Task.Actions.Arguments -join ' ').IndexOf($Caddyfile, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'The scheduled task uses a different Caddyfile.'
    }
    Stop-ScheduledTask -TaskName 'UniWay-Caddy'
    Start-Sleep 2
    Start-ScheduledTask -TaskName 'UniWay-Caddy'
}

$Before = (Get-FileHash -LiteralPath $Caddyfile).Hash
$Original = [IO.File]::ReadAllText($Caddyfile)
if ($Original -match '(?mi)^\s*(?:https://)?remote\.uniway-tw\.com\s*\{') {
    if (Test-PublicRelay) { Write-Host "Ready: https://$RelayDomain"; return }
    throw 'A remote site is already configured. Review its upstream; the relay listens on 127.0.0.1:8788.'
}
$Candidate = "$Caddyfile.remote-$([Guid]::NewGuid().ToString('N'))"
$Backup = "$Candidate.backup"
try {
    $Block = [IO.File]::ReadAllText($BlockFile)
    [IO.File]::WriteAllText($Candidate, "$Original`r`n$Block`r`n", (New-Object Text.UTF8Encoding($false)))
    & $CaddyExe validate --config $Candidate --adapter caddyfile
    if ($LASTEXITCODE -ne 0) { throw 'Caddy validation failed.' }
    if ((Get-FileHash -LiteralPath $Caddyfile).Hash -ne $Before) { throw 'Caddyfile changed during validation. Retry using its current version.' }
    $Installed = (Get-FileHash -LiteralPath $Candidate).Hash
    [IO.File]::Replace($Candidate, $Caddyfile, $Backup)
    $Activated = $false
    try {
        Update-Caddy
        $Activated = $true
        for ($i = 0; $i -lt 24; $i++) {
            if (Test-PublicRelay) { Write-Host "Ready: https://$RelayDomain   Backup: $Backup"; return }
            Start-Sleep 3
        }
        throw 'Public HTTPS health check failed. Check DNS, firewall and Caddy logs.'
    } catch {
        if ((Get-FileHash -LiteralPath $Caddyfile).Hash -eq $Installed) {
            [IO.File]::Copy($Backup, $Caddyfile, $true)
            if ($Activated) { Update-Caddy }
        }
        throw
    }
} finally {
    if (Test-Path -LiteralPath $Candidate) { Remove-Item -LiteralPath $Candidate }
}
