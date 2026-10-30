# packaging/

Everything that turns the repo into an installer a non-technical person can double-click.
Proven on Windows x64 and macOS arm64 by `spike/`.

| File | What it is |
|---|---|
| `fetch_runtime.py` | Downloads, checksum-verifies and assembles `runtime/<win-x64\|mac-arm64>/{python,ffmpeg}` (CPython 3.11 + pinned deps, static ffmpeg/ffprobe). Re-runnable; skips work when up to date. `--force`, `--relock`. |
| `hash_requirements.py`, `requirements-extra.txt`, `requirements-runtime.hashed.txt` | ONE source of truth for Python deps: `engine/requirements.txt` (+ the bundle-only extras in `requirements-extra.txt`, today pi-heif). The script writes the generated, hashed file that `fetch_runtime.py` installs with `--require-hashes --no-deps`; a stale copy stops the build (`hash_requirements.py --check`). Edit the inputs, run the script, commit. NO torch. |
| `licenses/` | Committed GPL-3.0, LGPL-3.0, LGPL-2.1, YuNet MIT texts (checksum-pinned in `fetch_runtime.py`, which refuses to build without them) and `npm-licenses.txt` (from `gen_npm_notices.py`). Shipped as `resources/licenses/texts/`. |
| `mirror_gpl_sources.py` | Downloads the FFmpeg + library source we owe under the GPL/LGPL into `release/gpl-sources/`. Attach everything in it to the GitHub release (see THIRD_PARTY.md). |
| `electron-builder.yml` | The config TEMPLATE (do not pass it to electron-builder directly). |
| `make-config.js` | Fills the template's `${env.RS_*}` with absolute paths -> `.build/electron-builder.resolved.yml`. |
| `after-pack.js` | electron-builder hook: pre-compiles Python bytecode inside the packed app before signing; with `RS_WIN_SIGN=1` it then runs `sign-win-resources.ps1`. |
| `build-win.ps1` / `build-mac.sh` | One command each: fetch runtime, build the app JS, package. `-Spike` / `--spike` packages the spike instead of `app/`. `build-win.ps1 -Sign` signs (see "Signing the Windows build"). |
| `check-win-unpacked.ps1` | Fails if `release\win-unpacked\resources` holds a `.venv` (the README's engine dev venv). `build-win.ps1` runs it after packaging. |
| `sign-win-resources.ps1` | Signs every `.exe`/`.dll`/`.pyd`/`.node` in `win-unpacked` that has no signature yet with Azure Artifact Signing, in one `Invoke-TrustedSigning` call; leaves validly signed files alone. |
| `check-win-signatures.ps1` | Fails unless every PE file in `win-unpacked` and the installer verify (`Get-AuthenticodeSignature`) and the installer's CN matches `RS_AZURE_PUBLISHER`. Works on an installed copy too. |
| `test-win-install.ps1` | Silent-installs a built installer into a folder with spaces, runs `--self-test`, prints every check, uninstalls. |
| `sign-mac.sh` | Developer ID sign (inside-out) + notarize + staple + dmg. Run it in a GUI session. Guide: `docs/signing-mac.md`. |
| `entitlements.main.plist` / `entitlements.inherit.plist` | Hardened-runtime entitlements: `allow-jit` only, for the Electron main process and its helper apps. Python, ffmpeg and every dylib are signed with none. |
| `spike/` | Minimal Electron app with `--self-test` that proves the bundled Python/ffmpeg/model/transcribe chain works from an INSTALLED copy. |

## Build

```
# Windows (on the Windows PC)
powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1            # real app (needs app\ built)
powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1 -Spike     # the spike
#   -> <app>\release\Reel-Studio-Setup-<version>-x64.exe

# macOS (on a Mac, in a checkout of this repo)
packaging/build-mac.sh            # or --spike
#   -> <app>/release/Reel-Studio-<version>-arm64.dmg   (+ release/mac-arm64/<Product>.app)
packaging/sign-mac.sh             # run in a GUI session: sign + notarize + staple
```

First run downloads about 250 MB of Python wheels + ffmpeg into `packaging/cache` and `packaging/runtime`
(both gitignored); later runs reuse them.

## Signing the Windows build

`build-win.ps1 -Sign` signs the installer, the uninstaller, the app `.exe` and every bundled `.exe`/`.dll`/`.pyd`/`.node`
with [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (formerly Trusted Signing). Without
`-Sign` nothing changes: the build is unsigned, as before. None of the values below is in the repo; they come from the
environment of the shell that runs the build.

Once, on the build PC:

1. In Azure: an Artifact Signing account, a completed identity validation, a *Public Trust* certificate profile, and an
   app registration (service principal) with the *Artifact Signing Certificate Profile Signer* role on the account.
2. The [TrustedSigning PowerShell module](https://www.powershellgallery.com/packages/TrustedSigning), 0.5.0 or newer:
   `Install-Module -Name TrustedSigning -Scope CurrentUser`. Install it in the PowerShell electron-builder will use:
   `pwsh.exe` if that is installed, otherwise Windows PowerShell (`powershell.exe`); each has its own module folder.
   On first use the module downloads `signtool.exe` (Windows SDK build tools) and the Azure signing client itself.
3. A .NET SDK (`dotnet --list-sdks` must list one; `winget install -e --id Microsoft.DotNet.SDK.8`): the module installs
   its `sign` tool with `dotnet tool install`, an SDK command.

Per build, in the environment (never on a command line that ends up in the repo, never committed):

| Variable | What |
|---|---|
| `RS_AZURE_ENDPOINT` | The account's regional endpoint, for example `https://<region>.codesigning.azure.net` |
| `RS_AZURE_ACCOUNT` | The Artifact Signing account name |
| `RS_AZURE_PROFILE` | The certificate profile name |
| `RS_AZURE_PUBLISHER` | The certificate's subject as Windows shows it, ideally the full DN (`CN=Example Publisher, O=Example Publisher, L=City, S=State, C=US`); the `CN=` value alone also works. electron-builder writes it into the app as `publisherName`, and electron-updater refuses an update installer whose certificate does not match it. |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | The service principal. Read by the TrustedSigning module (Azure `EnvironmentCredential`); the build scripts only check that they are set and never print them. |

Then:

```
powershell -ExecutionPolicy Bypass -File packaging\build-win.ps1 -Sign      # or set RS_WIN_SIGN=1
```

What happens, in order:

* `build-win.ps1` checks the variables, the module (for the shell electron-builder will use) and the .NET SDK before the
  slow steps, and names what is missing (never a value).
* `make-config.js` puts `win.azureSignOptions` (endpoint, account, profile, publisher) into the resolved config.
* `after-pack.js` runs `sign-win-resources.ps1`: every PE file under `release\win-unpacked` with no signature (about
  160, in `resources\python`, `resources\ffmpeg` and Electron's own DLLs) goes to ONE `Invoke-TrustedSigning` call
  (SHA-256, timestamped at `http://timestamp.acs.microsoft.com`). Files already signed by Microsoft, the PSF, NVIDIA or
  Intel are left alone; a file whose signature does not verify stops the build. Not `win.signExts`: electron-builder
  signs extraResources one file at a time while copying them (a PowerShell + signtool process each) and re-signs the
  already-signed ones.
* electron-builder (26.15.3) signs `Reel Studio.exe`, the uninstaller and the installer through the same module. It
  also runs `Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Scope CurrentUser` on every signed build,
  so the build PC needs access to the PowerShell Gallery.
* `check-win-signatures.ps1` fails the build if the installer does not verify, its CN is not `RS_AZURE_PUBLISHER`, or any
  PE file in the package is left unsigned. Run it by hand on an installed copy to check a release.

About 170 signatures per build (the Basic tier allows 5,000 a month). A signed installer passes Smart App Control and
shows the publisher's name in the SmartScreen box; the box itself disappears only once the certificate has reputation.

## What the installed app looks like (the contract with `app/`)

`process.resourcesPath` contains real folders (extraResources, not inside asar):

```
python/         win: python.exe        mac: bin/python3
ffmpeg/         ffmpeg(.exe) ffprobe(.exe) LICENSE.txt
engine/         PYTHONPATH root:  engine/reelengine/
fonts/          packaging/fonts  (Montserrat, Inter, Roboto, Fraunces TTFs + OFL texts)  -> REELENGINE_FONTS
templates/      HTML treatments + animations (top-level templates/ in the repo, once it exists)
test-animation/ app/resources/test-animation
licenses/       LICENSE, THIRD_PARTY.md
```

Spawn it like `spike/src/main.js` does:

```js
spawn(pythonExe, ['-s', '-m', 'reelengine', cmd, '--project', dir], {
  cwd: userDataOrProjectDir,
  env: { ...process.env, PYTHONPATH: enginePath, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8',
         PYTHONDONTWRITEBYTECODE: '1',            // never write into the (signed) app bundle
         REELENGINE_FFMPEG, REELENGINE_FFPROBE, REELENGINE_MODELS: userData/models, REELENGINE_FONTS, REELENGINE_ROOT,
         HF_HOME: userData/hf-cache, HF_HUB_DISABLE_TELEMETRY: '1' },
  windowsHide: true })
```

Notes the app stream needs:

* Spawn `python -s -E -B -X utf8 -m reelengine ...` with `cwd = <resources>/engine`: `python -m` puts the cwd on `sys.path`, which is how
  `reelengine` is found once `-E` has made Python ignore `PYTHONPATH`/`PYTHONHOME`/`PYTHONSTARTUP` (a stale `PYTHONHOME` breaks
  start-up). `-E` also ignores `PYTHONUTF8`/`PYTHONDONTWRITEBYTECODE`, hence `-X utf8` and `-B`. Not `-I`: it would drop the cwd too.
* Never pass `ELECTRON_RUN_AS_NODE` to a child or run `electron` from a shell that has it set.
* The shipped engine downloads the speech model itself with `urllib` (`engine/reelengine/transcribe.py` `download_model`) into
  `<userData>/models`. `spike/engine-stub/reelengine/selftest.py` uses `huggingface_hub.snapshot_download` only to prove the chain.
* **`app/package.json` must list `"@reelstudio/ai": "*"` under `dependencies`.** The app loads it with a dynamic
  `import()` at run time (it is `external` in electron.vite.config.ts), so electron-builder only puts it (and its
  `@anthropic-ai/sdk`) into `app.asar` if it is a declared dependency. Without it the installed app silently uses
  the mock AI. The build scripts refuse to build without it, and run `npm run build --workspace ai` first
  (`ai/dist` is what ships).
* Add `electron-builder@26.15.3` to the root/app devDependencies if you want the build scripts to use the local copy
  (they fall back to `npx electron-builder@26.15.3`).
* ffmpeg is pinned to 7.1.1 on purpose (see THIRD_PARTY.md): `reelengine.tools.filters()` mis-parses the 2-character
  flag column that FFmpeg 8/9 print for `ffmpeg -filters`.
* The bundled ctranslate2 is CPU-only. `get_cuda_device_count()` still reports an NVIDIA card, but loading a model
  on it fails with `cublas64_12.dll not found`, so the engine's cuda->cpu fallback in `load_model` is what keeps
  transcription working on NVIDIA machines (it does). `doctor` reports "GPU for listening: OK" there, which is
  optimistic. A real GPU pack (nvidia-cublas/cudnn wheels, ~700 MB) would have to be an optional download.
* First launch after install is slow on Windows (about 15 s before `import numpy, cv2, ...` finishes: Defender scans
  the freshly written files). Show "Getting ready" UI on the first engine call; later launches take ~1.5 s.
* Icons: `packaging/icons/icon.icns` / `icon.ico` (the config points at them).
