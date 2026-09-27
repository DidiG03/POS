# Test helper for .github/workflows/test-phone-updater.yml.
#
# Runs the phone updater as a separate Windows PowerShell 5.1 process with
# its output going to files, not a pipe: adb's background service outlives
# the script, and a captured pipe it inherits would never close. Waits on
# the process itself (not its children), and on a hang prints what the
# script had written so far.
function Invoke-PhoneUpdater {
  param([string[]]$UpdaterArgs = @(), [switch]$ViaCmd)
  $out = Join-Path $env:RUNNER_TEMP ("updater-{0}.out" -f [guid]::NewGuid())
  $err = "$out.err"
  if ($ViaCmd) {
    $file = 'cmd.exe'
    $argList = '/c echo.| scripts\phones\update-waiter-phones.cmd ' + ($UpdaterArgs -join ' ')
  } else {
    $file = 'powershell.exe'
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      'scripts\phones\update-waiter-phones.ps1') + $UpdaterArgs
  }
  $p = Start-Process -FilePath $file -ArgumentList $argList -NoNewWindow -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle # keeps ExitCode readable after exit
  $done = $p.WaitForExit(240000)
  $text = ((Get-Content -Raw $out -ErrorAction SilentlyContinue) + "`n" +
    (Get-Content -Raw $err -ErrorAction SilentlyContinue))
  Write-Host "--- updater $($UpdaterArgs -join ' ')$(if ($ViaCmd) { ' (via .cmd)' })"
  Write-Host $text
  if (-not $done) {
    try { $p.Kill() } catch { }
    throw 'updater hung (output so far is above)'
  }
  Write-Host "--- exit code $($p.ExitCode)"
  return @{ Code = $p.ExitCode; Output = $text }
}
