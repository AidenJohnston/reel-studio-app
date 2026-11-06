<#
.SYNOPSIS
  Upgrade a Windows install the way the in-app updater does, and fail unless the result is the new version, installed
  exactly as a fresh install of it would be.
.DESCRIPTION
  1. Installs -From silently into a folder with spaces.
  2. Runs -To over it with the arguments electron-updater gives an NSIS installer when it installs an update
     (/S --updated), so installer.nsh's update path runs.
  3. Requires one uninstall entry for the app, at -To's version, and a passing --self-test of the upgraded copy that
     reports -To's version.
  4. Installs -To fresh into a second folder and compares the two file lists and the files' hashes: an upgrade must not
     leave files the new version no longer ships, nor miss any.
  Both copies are uninstalled at the end. Signing is not checked here (check-win-signatures.ps1 does that for a signed
  build); with signed installers this is the "upgraded from" test signed updates need.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\test-win-upgrade.ps1 -From old\Reel-Studio-Setup-0.9.1-x64.exe -To app\release\Reel-Studio-Setup-0.9.2-x64.exe
#>
param(
  [Parameter(Mandatory)][string]$From,
  [Parameter(Mandatory)][string]$To,
  [string]$ExeName = "Reel Studio.exe",
  [string]$Work = (Join-Path $env:TEMP "rs upgrade test")
)
$ErrorActionPreference = "Stop"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$From = (Resolve-Path $From).Path
$To = (Resolve-Path $To).Path
if (Test-Path $Work) { Remove-Item -Recurse -Force $Work }
$upgraded = Join-Path $Work "upgraded copy"
$fresh = Join-Path $Work "fresh copy"
$userData = Join-Path $Work "user data"
$name = [IO.Path]::GetFileNameWithoutExtension($ExeName)
$failures = @()

function Install([string]$installer, [string]$dir, [string[]]$extra = @()) {
  # /D= must be the last argument and is not quoted (NSIS rule; spaces are fine)
  $p = Start-Process -FilePath $installer -ArgumentList (@("/S") + $extra + @("/D=$dir")) -Wait -PassThru
  if ($p.ExitCode -ne 0) { throw "$([IO.Path]::GetFileName($installer)) exited with $($p.ExitCode)" }
  if (-not (Test-Path (Join-Path $dir $ExeName))) { throw "no $ExeName in $dir after $([IO.Path]::GetFileName($installer))" }
}

function Uninstall([string]$dir) {
  $un = Join-Path $dir "Uninstall $name.exe"
  if (-not (Test-Path $un)) { return }
  Start-Process $un -ArgumentList @("/S") -Wait
  # the NSIS uninstaller re-launches itself from %TEMP%, so -Wait can return before it has finished
  for ($i = 0; $i -lt 120 -and (Test-Path (Join-Path $dir $ExeName)); $i++) { Start-Sleep -Milliseconds 500 }
}

function Listing([string]$dir) {
  $root = (Resolve-Path $dir).Path.TrimEnd('\') + '\'
  Get-ChildItem $dir -Recurse -File | Where-Object { $_.Name -notlike "Uninstall *.exe" } |
    ForEach-Object { "{0}  {1}" -f $_.FullName.Substring($root.Length), (Get-FileHash $_.FullName -Algorithm SHA256).Hash } | Sort-Object
}

function Entries() {
  $keys = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
  @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "$name*" })
}

$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  "1. install $([IO.Path]::GetFileName($From)) into: $upgraded"
  Install $From $upgraded
  $before = Entries
  "   uninstall entries: $(($before | ForEach-Object { "$($_.DisplayName) $($_.DisplayVersion)" }) -join ', ')"

  "2. upgrade with $([IO.Path]::GetFileName($To)) /S --updated"
  Install $To $upgraded @("--updated")
  $after = Entries
  "   uninstall entries: $(($after | ForEach-Object { "$($_.DisplayName) $($_.DisplayVersion)" }) -join ', ')"
  # listed now, before the self-test runs anything from the folder
  $a = Listing $upgraded

  "3. self-test of the upgraded copy"
  $out = Join-Path $Work "selftest-result.json"
  $r = Start-Process -FilePath (Join-Path $upgraded $ExeName) -ArgumentList @("--self-test", "--out", "`"$out`"", "--user-data-dir=`"$userData`"") -PassThru
  if (-not $r.WaitForExit(300000)) { & taskkill /PID $r.Id /T /F | Out-Null; $failures += "the self-test did not exit within 300 s" }
  $j = if (Test-Path $out) { Get-Content $out -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
  if (-not $j) { $failures += "no self-test result" }
  else {
    "   self-test ok=$($j.ok) version=$($j.version) channel=$($j.channel) isPackaged=$($j.isPackaged)"
    if (-not $j.ok) { $failures += "the self-test failed" }
    if ($after.Count -ne 1) { $failures += "$($after.Count) uninstall entries after the upgrade, not 1" }
    elseif ($after[0].DisplayVersion -ne $j.version) { $failures += "the uninstall entry says $($after[0].DisplayVersion), the app says $($j.version)" }
    if ($before.Count -eq 1 -and $before[0].DisplayVersion -eq $j.version) { $failures += "-From and -To are the same version ($($j.version)): nothing was upgraded" }
  }

  "4. install $([IO.Path]::GetFileName($To)) fresh into: $fresh, and compare"
  # a fresh install registers under the same uninstall key, so the upgraded copy goes first
  Uninstall $upgraded
  Install $To $fresh
  $b = Listing $fresh
  $diff = @(Compare-Object $a $b)
  foreach ($d in $diff) { "   {0} {1}" -f $(if ($d.SideIndicator -eq '<=') { "only after the upgrade:" } else { "only in a fresh install:" }), $d.InputObject }
  if ($diff.Count) { $failures += "the upgraded folder differs from a fresh install in $($diff.Count) file(s)" }
  else { "   same $($a.Count) files and hashes as a fresh install" }
} finally {
  Uninstall $upgraded
  Uninstall $fresh
}
"done in $([int]$sw.Elapsed.TotalSeconds) s"
if ($failures.Count) { foreach ($f in $failures) { "FAILED: $f" }; exit 1 }
"UPGRADE PASSED"
