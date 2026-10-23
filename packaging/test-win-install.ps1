<#
.SYNOPSIS
  Silent-install a built Windows installer into a temp folder (path WITH SPACES on purpose), run the app's
  --self-test, print every check, then uninstall.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\test-win-install.ps1 -Installer packaging\spike\release\Reel-Studio-Setup-0.0.1-x64.exe
#>
param(
  [Parameter(Mandatory)][string]$Installer,
  [string]$ExeName = "Reel Studio Spike.exe",
  [string]$InstallDir = (Join-Path $env:TEMP "rs install test"),
  [string]$UserDataDir = "",   # optional: --user-data-dir for the app (to test non-ASCII / spaces in the data path)
  [switch]$KeepInstalled
)
$ErrorActionPreference = "Stop"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$Installer = (Resolve-Path $Installer).Path
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
$sw = [Diagnostics.Stopwatch]::StartNew()

"Installing silently to: $InstallDir"
# /S = silent, /D= must be the LAST argument and is not quoted (NSIS rule, spaces are fine)
$p = Start-Process -FilePath $Installer -ArgumentList @("/S", "/D=$InstallDir") -Wait -PassThru
"installer exit code $($p.ExitCode) after $([int]$sw.Elapsed.TotalSeconds)s"
$exe = Join-Path $InstallDir $ExeName
if (-not (Test-Path $exe)) { throw "App not found at $exe after install" }
"installed size: {0:N0} MB, files: {1}" -f ((Get-ChildItem $InstallDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), (Get-ChildItem $InstallDir -Recurse -File | Measure-Object).Count

$out = Join-Path $env:TEMP "rs-selftest-result.json"
Remove-Item $out -ErrorAction SilentlyContinue
$sw.Restart()
$argList = @("--self-test", "--out", "`"$out`"")
if ($UserDataDir) { $argList += "--user-data-dir=`"$UserDataDir`"" }
$r = Start-Process -FilePath $exe -ArgumentList $argList -PassThru
# A build without --self-test opens its normal window and never exits; stop it so the uninstall check still runs.
if (-not $r.WaitForExit(300000)) {
  # Stop-Process leaves the bundled python.exe running and holding files open; end the whole tree.
  & taskkill /PID $r.Id /T /F | Out-Null
  $r.WaitForExit(30000) | Out-Null
  "self-test did not exit within 300 s; stopped it"
}
"self-test exit code $($r.ExitCode) after $([int]$sw.Elapsed.TotalSeconds)s"
$j = $null
if (Test-Path $out) { $j = Get-Content $out -Raw -Encoding UTF8 | ConvertFrom-Json } else { "No self-test result file written" }
if ($j) {
  "isPackaged=$($j.isPackaged) electron=$($j.electron) platform=$($j.platform)/$($j.arch)"
  "python: $($j.locations.python)"
  foreach ($c in $j.result.checks) {
    $d = ($c.detail | ConvertTo-Json -Compress -Depth 6)
    if ($d.Length -gt 220) { $d = $d.Substring(0, 220) + "..." }
    "{0,-24} {1,-5} {2,6}s  {3}" -f $c.name, $(if ($c.ok) { "PASS" } else { "FAIL" }), $c.seconds, $d
  }
}
if (-not $KeepInstalled) {
  $un = Join-Path $InstallDir "Uninstall $([IO.Path]::GetFileNameWithoutExtension($ExeName)).exe"
  if (Test-Path $un) { Start-Process $un -ArgumentList @("/S") -Wait; "uninstalled" }
  # The NSIS uninstaller re-launches itself from %TEMP%, so -Wait can return before it has finished.
  for ($i = 0; $i -lt 120 -and (Test-Path $exe); $i++) { Start-Sleep -Milliseconds 500 }
  Start-Sleep 2
  # The installer drops a byte copy of itself in %LOCALAPPDATA%\<name>-updater\installer.exe (electron-builder's
  # copyFile "$EXEPATH"). Other electron-builder apps keep their own installer.exe in their own *-updater folder, and an
  # older build may have left one, so only a copy of THIS installer counts.
  $self = Get-Item $Installer
  $selfHash = (Get-FileHash $Installer -Algorithm SHA256).Hash
  $leftover = @(Get-ChildItem $env:LOCALAPPDATA -Directory -Filter "*-updater" -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName "installer.exe" } |
    Where-Object { (Test-Path $_) -and (Get-Item $_).Length -eq $self.Length -and (Get-FileHash $_ -Algorithm SHA256).Hash -eq $selfHash })
  foreach ($f in $leftover) { "UNINSTALL LEFT {0} ({1:N0} MB)" -f $f, ((Get-Item $f).Length / 1MB) }
  if ($leftover.Count) { "UNINSTALL CHECK FAILED"; exit 1 }
  "uninstall left no updater installer copy"
}
if (-not $j -or -not $j.ok) { "SELF-TEST FAILED"; exit 1 }
"SELF-TEST PASSED"
