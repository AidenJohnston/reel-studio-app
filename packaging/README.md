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
| `after-pack.js` | electron-builder hook: pre-compiles Python bytecode inside the packed app before signing. |
| `build-win.ps1` / `build-mac.sh` | One command each: fetch runtime, build the app JS, package. `-Spike` / `--spike` packages the spike instead of `app/`. |
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

### Release files

Installed copies update from the GitHub release tagged `v<version>`. Attach, next to the GPL sources:

* Windows: `Reel-Studio-Setup-<version>-x64.exe` **and** `latest.yml` from `app\release\`. `build-win.ps1` checks that
  `latest.yml` names that installer, its version and its SHA-512. Without `latest.yml`, Windows copies cannot update.
  The `.blockmap` is not needed.
* Mac: the three files from `app/release/signed/` (`docs/signing-mac.md`, "Release").

First run downloads about 250 MB of Python wheels + ffmpeg into `packaging/cache` and `packaging/runtime`
(both gitignored); later runs reuse them.

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
