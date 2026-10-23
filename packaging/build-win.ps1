<#
.SYNOPSIS
  Build the Reel Studio Windows installer (NSIS, x64, per-user, unsigned).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1             # the real app in app\
  powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1 -Spike      # packaging\spike (the packaging proof)

  Output: <AppDir>\release\Reel-Studio-Setup-<version>-x64.exe
#>
param(
  [string]$AppDir = "",            # folder with package.json + out/ ; default: <repo>\app
  [switch]$Spike,                  # build packaging\spike instead of app\
  [switch]$SkipFetch,              # reuse packaging\runtime\win-x64 as is
  [switch]$SkipUiBuild,            # real app only: do not run `npm run build` first
  [string]$Compression = "normal"  # store | normal | maximum
)
$ErrorActionPreference = "Stop"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # set by Electron-based shells; would make electron-builder tools run as plain node
$Packaging = $PSScriptRoot
$Repo = Split-Path $Packaging -Parent
$sw = [Diagnostics.Stopwatch]::StartNew()

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

Get-ChildItem (Join-Path $AppDir "release") -Filter "*.exe" | ForEach-Object {
  "{0}  {1:N1} MB" -f $_.FullName, ($_.Length / 1MB)
}

# 4. the update feed. Installed copies read latest.yml from the release, download the installer it names and
# refuse it unless its SHA-512 matches. electron-builder writes latest.yml next to the installer because
# make-config.js adds a publish block; --publish never only skips the upload.
$Release = Join-Path $AppDir "release"
$Version = (node -p "require(process.argv[1]).version" (Join-Path $AppDir "package.json")).Trim()
$Feed = Join-Path $Release "latest.yml"
if (-not (Test-Path $Feed)) { throw "latest.yml is missing from $Release; installed copies could not update to this build" }
$yml = Get-Content $Feed -Raw
$fields = @{}
foreach ($name in "version", "path", "sha512") {
  $m = [regex]::Match($yml, "(?m)^${name}: *'?([^'\r\n]+)'?\s*$")
  if (-not $m.Success) { throw "latest.yml has no top-level ${name}:" }
  $fields[$name] = $m.Groups[1].Value.Trim()
}
if ($fields.version -ne $Version) { throw "latest.yml is for $($fields.version), but this build is $Version" }
$Installer = Join-Path $Release $fields.path
if (-not (Test-Path $Installer)) { throw "latest.yml names $($fields.path), which is not in $Release" }
$stream = [IO.File]::OpenRead($Installer)
try { $digest = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream)) } finally { $stream.Close() }
if ($digest -ne $fields.sha512) { throw "the SHA-512 in latest.yml does not match $($fields.path)" }
# electron-updater checks the download against files[0], not the top-level copy
$first = [regex]::Match($yml, "(?m)^files:\s*\r?\n\s+- url: *([^\r\n]+?)\s*\r?\n\s+sha512: *([^\r\n]+?)\s*$")
if (-not $first.Success) { throw "latest.yml has no files[0] with url and sha512" }
if ($first.Groups[1].Value -ne $fields.path) { throw "latest.yml files[0] is $($first.Groups[1].Value), not $($fields.path)" }
if ($first.Groups[2].Value -ne $digest) { throw "the files[0] SHA-512 in latest.yml does not match $($fields.path)" }
$AppFeed = Join-Path $Release "win-unpacked\resources\app-update.yml"
if (-not (Test-Path $AppFeed)) { throw "app-update.yml is missing from the app; the publish block did not reach the build" }
"app-update.yml (where the installed app looks for updates):"
Get-Content $AppFeed | ForEach-Object { "  $_" }
"Upload BOTH to the GitHub release: $($fields.path) and latest.yml"
"build-win done in {0:N0}s" -f $sw.Elapsed.TotalSeconds
