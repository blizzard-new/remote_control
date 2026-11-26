param(
  [Parameter(Mandatory)][string] $Setup,
  [Parameter(Mandatory)][string] $Version
)

$ErrorActionPreference = 'Stop'
$Setup = (Resolve-Path -LiteralPath $Setup).Path
$root = Join-Path $env:RUNNER_TEMP 'Uniway Setup Smoke'
$target = Join-Path $root 'Installed app'
$hostExe = Join-Path $target 'RemoteControlHost.exe'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$previous = Join-Path $root 'Setup 0.5.7.exe'
$portable = Join-Path $root 'Portable 0.5.7.exe'
$base = 'https://github.com/blizzard-new/remote_control/releases/download/v0.5.7'

function Invoke-Setup($installer, $step) {
  $log = Join-Path $root "$step.log"
  $arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=`"$target`" /LOG=`"$log`""
  $process = Start-Process -FilePath $installer -ArgumentList $arguments -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    if (Test-Path $log) { Get-Content $log -Tail 30 }
    throw "$step returned exit code $($process.ExitCode)"
  }
}

function Wait-ForDashboard($expected, $path) {
  for ($i = 0; $i -lt 25; $i++) {
    try {
      $content = (Invoke-WebRequest 'http://127.0.0.1:8443/online.html' -TimeoutSec 2).Content
      $startup = Get-ItemPropertyValue -Path $runKey -Name UniwayRemote -ErrorAction SilentlyContinue
      if ($content -match ('<small>[^<]*' + [regex]::Escape($expected) + '</small>') -and
          $startup -and $startup.Contains($path)) { return }
    } catch {
      # The host has not opened its loopback port yet.
    }
    Start-Sleep -Milliseconds 500
  }
  throw "The running dashboard did not report version $expected"
}

function Assert-Handoff($oldProcess) {
  if (!$oldProcess.WaitForExit(20000)) { throw 'The previous host is still running' }
  $startup = Get-ItemPropertyValue -Path $runKey -Name UniwayRemote
  if (!$startup.Contains($hostExe)) { throw 'Sign-in startup still points to the previous executable' }
  $script:running = Start-Process -FilePath $hostExe -PassThru
  Wait-ForDashboard $Version $hostExe
}

New-Item -ItemType Directory -Path $root -Force | Out-Null
Invoke-WebRequest "$base/RemoteControl-Setup-Windows-x64.exe" -OutFile $previous
Invoke-WebRequest "$base/RemoteControl-Windows-x64.exe" -OutFile $portable
if ((Get-FileHash $previous).Hash -ne '878eae1c7c5c503853ab4e3cc4c137e7d28be8cf374f5c66b48819112e53c70a' -or
    (Get-FileHash $portable).Hash -ne '640d60543677661fa1236fcf408d09e7fff68f987a4025acae58201fb923382a') {
  throw 'Released Windows test fixtures did not match the published hashes'
}

try {
  $running = Start-Process -FilePath $portable -PassThru
  Wait-ForDashboard '0.5.7' $portable
  Invoke-Setup $Setup 'install-with-portable-host'
  Assert-Handoff $running
  Write-Output "Setup replaced the running portable session and launched the $Version dashboard."
  Start-Process -FilePath $hostExe -ArgumentList '--exit' -Wait
  if (!$running.WaitForExit(20000)) { throw 'Could not stop the first installed host' }

  Invoke-Setup $previous 'prepare-previous-installed-version'
  $running = Start-Process -FilePath $hostExe -PassThru
  Wait-ForDashboard '0.5.7' $hostExe
  Invoke-Setup $Setup 'upgrade-installed-host'
  Assert-Handoff $running
  Write-Output "In-place upgrade replaced the installed 0.5.7 host with the $Version dashboard."
} finally {
  if ($running -and !$running.HasExited) {
    Start-Process -FilePath $portable -ArgumentList '--exit' -Wait
  }
  $uninstaller = Join-Path $target 'unins000.exe'
  if (Test-Path $uninstaller) {
    Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -Wait
  }
  Remove-ItemProperty -Path $runKey -Name UniwayRemote -ErrorAction SilentlyContinue
}
