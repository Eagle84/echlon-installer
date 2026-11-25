# Echlon customer pack, Windows (PowerShell). Makes sure there is a Node to run the installer on, then hands over to it.
# If this computer has no Node 20 or newer, it downloads the one pinned in runtime.txt into the profile (nothing
# system-wide changes), checks it against the published checksum, and runs the installer on that.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$need = 20

function Get-NodeMajor {
  try { return [int]((& node --version 2>$null) -replace '^v(\d+)\..*', '$1') } catch { return 0 }
}

function Read-Runtime([string]$file) {
  $pin = @{}
  foreach ($line in Get-Content -LiteralPath $file) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $i = $t.IndexOf('=')
    if ($i -gt 0) { $pin[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1).Trim() }
  }
  return $pin
}

$node = 'node'
if ((Get-NodeMajor) -lt $need) {
  Write-Host "Echlon needs Node $need or newer, and this computer does not have it."
  $runtimeFile = if ($env:ECHLON_RUNTIME_FILE) { $env:ECHLON_RUNTIME_FILE } else { Join-Path $here 'runtime.txt' }
  $pin = Read-Runtime $runtimeFile
  $version = $pin['version']
  $plat = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
  $expected = $pin["$plat.zip"]
  if (-not $version -or -not $expected) {
    Write-Host "Echlon has no Node to offer for this computer ($plat). Install Node from https://nodejs.org (the LTS version), then run install.bat again."
    exit 1
  }
  $root = if ($env:ECHLON_RUNTIME_ROOT) { $env:ECHLON_RUNTIME_ROOT } else { Join-Path $env:LOCALAPPDATA 'Echlon\runtime' }
  $folder = "node-v$version-$plat"
  $bin = Join-Path $root $folder
  if (-not (Test-Path (Join-Path $bin 'node.exe'))) {
    Write-Host "Echlon will download its own copy of Node $version (about 30 MB) into $root. Nothing on your system is changed."
    if ($args -notcontains '--yes') {
      $answer = Read-Host 'Download it now? (Y/n)'
      if ($answer -match '^[Nn]') { Write-Host 'Install Node from https://nodejs.org (the LTS version), then run install.bat again.'; exit 1 }
    }
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $work = Join-Path $root ('.download-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    try {
      $dist = if ($env:ECHLON_NODE_DIST) { $env:ECHLON_NODE_DIST.TrimEnd('/') } else { 'https://nodejs.org/dist' }
      $zip = Join-Path $work "$folder.zip"
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Write-Host "Downloading Node $version ..."
      # The progress bar Windows PowerShell draws makes a download of this size many times slower.
      $ProgressPreference = 'SilentlyContinue'
      try { Invoke-WebRequest -UseBasicParsing -Uri "$dist/v$version/$folder.zip" -OutFile $zip }
      catch { Write-Host "Could not download Node $version ($($_.Exception.Message)). Check the internet connection and try again."; exit 1 }
      $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
      if ($actual -ne $expected.ToLower()) {
        Write-Host 'The Node download did not match its published checksum, so it was thrown away and nothing was installed. Try again; if it keeps happening, install Node from https://nodejs.org.'
        exit 1
      }
      Write-Host "Unpacking Node $version ..."
      Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $work 'x') -Force
      if (-not (Test-Path (Join-Path $work "x\$folder\node.exe"))) { Write-Host 'The Node download did not hold the program it should, so nothing was installed.'; exit 1 }
      if (Test-Path $bin) { Remove-Item -LiteralPath $bin -Recurse -Force }
      # The whole folder arrives in one step, so a half-unpacked Node is never mistaken for a finished one.
      Move-Item -LiteralPath (Join-Path $work "x\$folder") -Destination $bin
    } finally {
      Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Node $version is ready."
  }
  $node = Join-Path $bin 'node.exe'
}

& $node (Join-Path $here 'installer\install.mjs') @args
exit $LASTEXITCODE
