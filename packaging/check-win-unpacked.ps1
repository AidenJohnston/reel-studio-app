<#
.SYNOPSIS
  Fail if a packaged app carries developer-only folders. Run by build-win.ps1 after packaging; can be run by hand.

  A developer checkout that followed the README has engine\.venv (several hundred MB). The installed app never uses it
  (it runs resources\python), so finding one under resources means the electron-builder filter let it through.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\check-win-unpacked.ps1 -Unpacked app\release\win-unpacked
#>
param([Parameter(Mandatory)][string]$Unpacked)
$ErrorActionPreference = "Stop"
$resources = Join-Path (Resolve-Path $Unpacked).Path "resources"
if (-not (Test-Path $resources)) { throw "No resources folder in $Unpacked" }
$found = @(Get-ChildItem $resources -Recurse -Directory -Force -Filter ".venv" -ErrorAction SilentlyContinue)
foreach ($d in $found) {
  "DEV FOLDER IN PACKAGE: {0} ({1:N0} MB)" -f $d.FullName, ((Get-ChildItem $d.FullName -Recurse -File -Force | Measure-Object Length -Sum).Sum / 1MB)
}
if ($found.Count) { "PACKAGE CHECK FAILED"; exit 1 }
"package check passed: no .venv under $resources"
