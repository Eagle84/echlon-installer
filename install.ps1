# Echlon customer pack, Windows (PowerShell). Checks Node, then hands over to the installer.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$need = 20

function Get-NodeMajor {
  try { return [int]((& node --version 2>$null) -replace '^v(\d+)\..*', '$1') } catch { return 0 }
}

if ((Get-NodeMajor) -lt $need) {
  Write-Host "Echlon needs Node $need or newer, and it was not found on this computer."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    $answer = Read-Host 'Install it now with winget? (y/N)'
    if ($answer -match '^[Yy]') {
      & winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
      Write-Host 'Node was installed. Close this window, open a new one, and run install.bat again.'
      exit 0
    }
  }
  Write-Host 'Install Node from https://nodejs.org (the LTS version), then run install.bat again.'
  exit 1
}

& node (Join-Path $here 'installer\install.mjs') @args
exit $LASTEXITCODE
