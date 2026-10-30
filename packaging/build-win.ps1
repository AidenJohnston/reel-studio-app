<#
.SYNOPSIS
  Build the Reel Studio Windows installer (NSIS, x64, per-user). Unsigned by default; -Sign signs the installer and
  every bundled binary with Azure Artifact Signing (packaging\README.md, "Signing the Windows build").

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1             # the real app in app\
  powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1 -Spike      # packaging\spike (the packaging proof)
  powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1 -Sign       # signed: RS_AZURE_* and AZURE_* must be set

  Output: <AppDir>\release\Reel-Studio-Setup-<version>-x64.exe
#>
param(
  [string]$AppDir = "",            # folder with package.json + out/ ; default: <repo>\app
  [switch]$Spike,                  # build packaging\spike instead of app\
  [switch]$SkipFetch,              # reuse packaging\runtime\win-x64 as is
  [switch]$SkipUiBuild,            # real app only: do not run `npm run build` first
  [switch]$Sign,                   # Azure Artifact Signing (same as RS_WIN_SIGN=1 in the environment)
  [string]$Compression = "normal"  # store | normal | maximum
)
$ErrorActionPreference = "Stop"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # set by Electron-based shells; would make electron-builder tools run as plain node
$Packaging = $PSScriptRoot
$Repo = Split-Path $Packaging -Parent
$sw = [Diagnostics.Stopwatch]::StartNew()

# 0. signing preflight, before the slow steps. Only the NAMES of missing variables are printed, never a value.
if ($env:RS_WIN_SIGN -eq "1") { $Sign = $true }
if ($Sign) {
  $env:RS_WIN_SIGN = "1"
  $missing = @("RS_AZURE_ENDPOINT", "RS_AZURE_ACCOUNT", "RS_AZURE_PROFILE", "RS_AZURE_PUBLISHER", "AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET" |
    Where-Object { -not [Environment]::GetEnvironmentVariable($_) })
  if ($missing.Count) { throw "-Sign needs these environment variables (packaging\README.md, 'Signing the Windows build'): $($missing -join ', ')" }
  # electron-builder runs Invoke-TrustedSigning in pwsh.exe when that exists, else in Windows PowerShell; each has its own
  # module folder, so the module must be installed for THAT shell. after-pack.js makes the same choice.
  $signShell = "powershell.exe"
  if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { $signShell = "pwsh.exe" }
  $module = & $signShell -NoProfile -NonInteractive -Command "Get-Module -ListAvailable TrustedSigning | Where-Object { `$_.Version -ge [version]'0.5.0' } | Sort-Object Version | Select-Object -Last 1 | ForEach-Object { `$_.Version.ToString() }"
  if (-not $module) {
    throw "The TrustedSigning PowerShell module (0.5.0 or newer) is not installed for $signShell. Install it, then build again:`n  $signShell -NoProfile -Command `"Install-Module -Name TrustedSigning -Scope CurrentUser`""
  }
  # On first use the module downloads signtool.exe and the Azure signing client, and installs its `sign` tool with
  # `dotnet tool install`, which is a .NET SDK command: the runtime alone is not enough.
  $dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
  $sdks = @()
  if ($dotnet) { $sdks = @(& $dotnet.Source --list-sdks) }
  if (-not $sdks.Count) { throw "No .NET SDK found (dotnet --list-sdks lists none). The TrustedSigning module needs one: winget install -e --id Microsoft.DotNet.SDK.8" }
  "signing with Azure Artifact Signing: TrustedSigning $module in $signShell, .NET SDK $(($sdks[-1] -split ' ')[0])"
}

if ($Spike) { $AppDir = Join-Path $Packaging "spike" }
elseif (-not $AppDir) { $AppDir = Join-Path $Repo "app" }
$AppDir = (Resolve-Path $AppDir).Path
if (-not (Test-Path (Join-Path $AppDir "package.json"))) { throw "No package.json in $AppDir" }

# 1. runtime (python + deps + ffmpeg) -> packaging\runtime\win-x64
if (-not $SkipFetch) {
  & python (Join-Path $Packaging "fetch_runtime.py")
  if ($LASTEXITCODE -ne 0) { throw "fetch_runtime.py failed" }
}
$Runtime = Join-Path $Packaging "runtime\win-x64"
if (-not (Test-Path (Join-Path $Runtime "python\python.exe"))) { throw "Runtime missing: run fetch_runtime.py" }

# 2. the app's own JS (electron-vite output in out\)
if ($Spike) {
  Push-Location $AppDir
  if (-not (Test-Path "node_modules\electron-builder")) { npm.cmd install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm install failed" } }
  node prep.js; if ($LASTEXITCODE -ne 0) { throw "spike prep failed" }
  Pop-Location
  $env:RS_ENGINE_DIR = Join-Path $Packaging "spike\engine-stub"
  $env:RS_TEMPLATES_DIR = Join-Path $Packaging "spike\templates-stub"
  New-Item -ItemType Directory -Force $env:RS_TEMPLATES_DIR | Out-Null
  if (-not (Test-Path (Join-Path $env:RS_TEMPLATES_DIR "README.txt"))) { "placeholder" | Set-Content (Join-Path $env:RS_TEMPLATES_DIR "README.txt") }
} else {
  Push-Location $Repo
  if (-not $SkipUiBuild) {
    npm.cmd install --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    if (Test-Path (Join-Path $Repo "ai\package.json")) {
      npm.cmd run build --workspace ai; if ($LASTEXITCODE -ne 0) { throw "ai build failed" }   # app loads @reelstudio/ai from ai/dist at run time
    }
    npm.cmd run build --workspace app; if ($LASTEXITCODE -ne 0) { throw "app build failed" }
  }
  Pop-Location
  if (Test-Path (Join-Path $Repo "ai\package.json")) {
    # guard: a packaged app without @reelstudio/ai in its dependencies silently runs the mock AI
    node -e "const a=require(process.argv[1]);if(!(a.dependencies&&a.dependencies['@reelstudio/ai'])){console.error('app/package.json must list @reelstudio/ai under dependencies (for example the version *): the app loads it at run time, and without it the packaged app silently falls back to the mock AI.');process.exit(3)}" (Join-Path $AppDir "package.json")
    if ($LASTEXITCODE -ne 0) { throw "app/package.json is missing the @reelstudio/ai dependency" }
  }
  $env:RS_ENGINE_DIR = Join-Path $Repo "engine"
  $env:RS_TEMPLATES_DIR = Join-Path $Repo "templates"
}
$env:RS_REPO_ROOT = $Repo
$env:RS_APP_DIR = $AppDir
$env:RS_RUNTIME_DIR = $Runtime

# 3. package
$cfg = (node (Join-Path $Packaging "make-config.js")).Trim()
if ($LASTEXITCODE -ne 0) { throw "make-config.js failed" }
$args = @("--yes", "electron-builder@26.15.3", "--config", $cfg, "--projectDir", $AppDir, "--win", "nsis", "--x64", "--publish", "never", "-c.compression=$Compression")
if ($Spike) { $args += @("-c.appId=dev.reelstudio.spike", "-c.productName=Reel Studio Spike", "-c.extraMetadata.name=reel-studio-spike") }
Push-Location $AppDir
# electron-builder cannot always resolve a range like "^44.8.0" inside an npm workspace: hand it the installed version.
$ev = (node -e "try{console.log(require(require.resolve('electron/package.json',{paths:[process.cwd()]})).version)}catch(e){}")
if ($ev) { $args += "-c.electronVersion=$($ev.Trim())" }
& npx.cmd @args
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "electron-builder failed ($code)" }

# 4. nothing developer-only in the package (for example engine\.venv from the README setup)
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Packaging "check-win-unpacked.ps1") -Unpacked (Join-Path $AppDir "release\win-unpacked")
if ($LASTEXITCODE -ne 0) { throw "check-win-unpacked.ps1 found developer-only files in the package" }

# 5. signed build: the installer must verify, its publisher must be the one the app will trust for updates, and no PE
# file in the package may be left unsigned (electron-builder only signs .exe files; after-pack.js did the rest).
if ($Sign) {
  $installer = Get-ChildItem (Join-Path $AppDir "release") -Filter "*-Setup-*.exe" | Sort-Object LastWriteTime | Select-Object -Last 1
  if (-not $installer) { throw "no installer in $AppDir\release" }
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Packaging "check-win-signatures.ps1") -Unpacked (Join-Path $AppDir "release\win-unpacked") -Installer $installer.FullName -Publisher $env:RS_AZURE_PUBLISHER
  if ($LASTEXITCODE -ne 0) { throw "check-win-signatures.ps1 failed: the build is not fully signed" }
}

Get-ChildItem (Join-Path $AppDir "release") -Filter "*.exe" | ForEach-Object {
  "{0}  {1:N1} MB" -f $_.FullName, ($_.Length / 1MB)
}
"build-win done in {0:N0}s" -f $sw.Elapsed.TotalSeconds
