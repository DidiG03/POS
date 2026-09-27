<#
.SYNOPSIS
  Update every OneTap Waiter phone on this Wi-Fi to the latest release, over
  Android wireless debugging. Run it on the till PC.

.DESCRIPTION
  update-waiter-phones.cmd                       update all paired phones
  update-waiter-phones.cmd -Pair IP:PORT -Code CODE   pair a phone (once)
  update-waiter-phones.cmd -Connect IP:PORT      also try this phone directly
  update-waiter-phones.cmd -Apk FILE             install this APK instead
  update-waiter-phones.cmd -Reinstall            replace a debug build (wipes
                                                 that phone's app data)

  Pairing, once per phone: Settings > Developer options > Wireless debugging >
  "Pair device with pairing code", then run -Pair with the IP:port and the
  six-digit code shown on the phone.

  `adb install -r` keeps the app's data (till address, pairing, orders that
  are still queued). Installing closes the app on the phone for a few
  seconds, so run it when service is quiet.
#>
[CmdletBinding()]
param(
  [string]$Pair,
  [string]$Code,
  [string[]]$Connect = @(),
  [string]$Apk,
  [switch]$Reinstall,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'DidiG03/POS'
$Package = 'com.codeorbit.waiter'
$Activity = "$Package/.MainActivity"
$SupportDir = Join-Path $env:LOCALAPPDATA 'OneTap'
$ToolsUrl = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip'

function Fail([string]$message) {
  Write-Host "Error: $message" -ForegroundColor Red
  exit 1
}

# ---------------------------------------------------------------- adb

function Find-Adb {
  $cmd = Get-Command adb.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in @(
      (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'),
      (Join-Path $SupportDir 'platform-tools\adb.exe'))) {
    if (Test-Path $c) { return $c }
  }
  return $null
}

$Adb = Find-Adb
if (-not $Adb) {
  Write-Host 'Android platform-tools (adb) not found. Downloading from Google...'
  New-Item -ItemType Directory -Force -Path $SupportDir | Out-Null
  $zip = Join-Path $SupportDir 'platform-tools.zip'
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $ToolsUrl -OutFile $zip
  } catch {
    Fail "could not download platform-tools: $($_.Exception.Message)"
  }
  $old = Join-Path $SupportDir 'platform-tools'
  if (Test-Path $old) { Remove-Item -Recurse -Force $old }
  Expand-Archive -Path $zip -DestinationPath $SupportDir -Force
  Remove-Item -Force $zip
  $Adb = Join-Path $SupportDir 'platform-tools\adb.exe'
  if (-not (Test-Path $Adb)) { Fail 'adb missing after download' }
}

# adb writes progress to stderr; collect everything as text instead of
# letting PowerShell turn it into terminating errors. Shell calls pass -n so
# adb never reads this window's input (it would swallow the y/N answer).
function Invoke-Adb {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $Adb @args 2>&1 | ForEach-Object { "$_" }
  } finally {
    $ErrorActionPreference = $prev
  }
  return (($out -join "`n") -replace "`r", '')
}

Invoke-Adb start-server | Out-Null

if ($Pair) {
  if (-not $Code) { Fail '-Pair needs -Code with the six-digit pairing code' }
  Write-Host "Pairing with $Pair..."
  $out = Invoke-Adb pair $Pair $Code
  Write-Host $out
  if ($out -notmatch 'Successfully paired') { Fail 'pairing failed' }
  Write-Host 'Paired. The phone will be found automatically from now on.'
  Write-Host 'Run this script again without -Pair to update it.'
  exit 0
}

# ---------------------------------------------------------------- APK

$TargetVersion = $null
if ($Apk) {
  if (-not (Test-Path $Apk)) { Fail "APK not found: $Apk" }
  $Apk = (Resolve-Path $Apk).Path
  if ((Split-Path $Apk -Leaf) -match '-(\d+\.\d+\.\d+)\.apk$') {
    $TargetVersion = $Matches[1]
  }
} else {
  Write-Host 'Looking up the latest OneTap Waiter release...'
  try {
    $release = Invoke-RestMethod -UseBasicParsing `
      -Headers @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'OneTap' } `
      -Uri "https://api.github.com/repos/$Repo/releases/latest"
  } catch {
    Fail "could not reach GitHub: $($_.Exception.Message)"
  }
  $asset = $release.assets |
    Where-Object { $_.name -match '^OneTap-Waiter-(\d+\.\d+\.\d+)\.apk$' } |
    Select-Object -First 1
  if (-not $asset) { Fail 'the latest release has no Waiter APK yet' }
  $null = $asset.name -match '^OneTap-Waiter-(\d+\.\d+\.\d+)\.apk$'
  $TargetVersion = $Matches[1]
  $apkDir = Join-Path $SupportDir 'apk'
  New-Item -ItemType Directory -Force -Path $apkDir | Out-Null
  $Apk = Join-Path $apkDir $asset.name
  if (-not (Test-Path $Apk) -or (Get-Item $Apk).Length -eq 0) {
    Write-Host "Downloading $($asset.name)..."
    $part = "$Apk.part"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $part
    } catch {
      Fail "APK download failed: $($_.Exception.Message)"
    }
    Move-Item -Force $part $Apk
  }
}
$suffix = if ($TargetVersion) { " (version $TargetVersion)" } else { '' }
Write-Host "Installing: $(Split-Path $Apk -Leaf)$suffix"

# ---------------------------------------------------------------- phones

foreach ($target in $Connect) { Invoke-Adb connect $target | Out-Null }

# Paired phones advertise themselves on the Wi-Fi; give discovery a moment,
# then connect to each one it found (a no-op for ones already connected).
Start-Sleep -Seconds 3
foreach ($line in ((Invoke-Adb mdns services) -split "`n")) {
  $cols = $line -split '\s+'
  if ($cols.Count -ge 3 -and $cols[1] -like '_adb-tls-connect*') {
    Invoke-Adb connect $cols[2] | Out-Null
  }
}
Start-Sleep -Seconds 1

$serials = @()
foreach ($line in ((Invoke-Adb devices) -split "`n" | Select-Object -Skip 1)) {
  $cols = $line -split '\s+'
  if ($cols.Count -ge 2 -and $cols[1] -eq 'device') { $serials += $cols[0] }
}
if ($serials.Count -eq 0) {
  Write-Host ''
  Write-Host 'No phones found. On each phone check that Wireless debugging is on'
  Write-Host '(it switches off after a restart or a Wi-Fi change), that it is on'
  Write-Host 'this Wi-Fi, and that it was paired with -Pair.'
  exit 1
}

$updated = 0
$current = 0
$failed = 0
$seen = @{}

foreach ($serial in $serials) {
  # One phone can show up twice (found on the network and connected by
  # address). Its hardware serial tells the two apart.
  $hw = (Invoke-Adb -s $serial shell -n getprop ro.serialno).Trim()
  $key = if ($hw) { $hw } else { $serial }
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true

  $model = (Invoke-Adb -s $serial shell -n getprop ro.product.model).Trim()
  if (-not $model) { $model = 'phone' }
  $label = "$model ($serial)"
  $installed = $null
  $dump = Invoke-Adb -s $serial shell -n dumpsys package $Package
  if ($dump -match 'versionName=([^\s]+)') { $installed = $Matches[1] }

  if ($installed -and $TargetVersion) {
    $have = $null
    $want = $null
    if ([version]::TryParse($installed, [ref]$have) -and
      [version]::TryParse($TargetVersion, [ref]$want) -and $have -ge $want) {
      Write-Host "  ${label}: already on $installed"
      $current++
      continue
    }
  }

  $from = if ($installed) { $installed } else { 'not installed' }
  $to = if ($TargetVersion) { $TargetVersion } else { 'new' }
  Write-Host "  ${label}: $from -> $to..."
  $out = Invoke-Adb -s $serial install -r $Apk
  if ($out -match 'Success') {
    Invoke-Adb -s $serial shell -n am start -n $Activity | Out-Null
    Write-Host '    updated' -ForegroundColor Green
    $updated++
    continue
  }

  if ($out -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE') {
    if (-not $Reinstall) {
      Write-Host '    this phone has a build signed with a different key (the old' -ForegroundColor Yellow
      Write-Host '    debug install). Run again with -Reinstall to replace it.' -ForegroundColor Yellow
      $failed++
      continue
    }
    if (-not $Yes) {
      Write-Host "    Replacing it deletes the app's data on this phone: the saved"
      Write-Host '    till address, the pairing, and any orders not yet sent.'
      # No answer (closed window, end of input) must mean no. Read-Host
      # then returns $null, and `$null -notmatch` is not "true".
      $answer = Read-Host '    Make sure it has no unsent orders. Replace it now? [y/N]'
      if ($null -eq $answer) { $answer = '' }
      if (-not ($answer.Trim() -match '^(y|yes)$')) {
        Write-Host '    skipped'
        $failed++
        continue
      }
    }
    Invoke-Adb -s $serial uninstall $Package | Out-Null
    $out = Invoke-Adb -s $serial install $Apk
    if ($out -match 'Success') {
      Invoke-Adb -s $serial shell -n am start -n $Activity | Out-Null
      Write-Host '    reinstalled: sign in again and re-pair it with the till' -ForegroundColor Green
      $updated++
      continue
    }
  }

  $last = ($out -split "`n" | Where-Object { $_ } | Select-Object -Last 1)
  Write-Host "    FAILED: $last" -ForegroundColor Red
  $failed++
}

Write-Host ''
Write-Host "Done: $updated updated, $current already current, $failed need attention."
if ($failed -gt 0) { exit 1 }
exit 0
