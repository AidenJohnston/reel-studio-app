// Every filesystem location the app uses lives here, so packaging can adjust one file.
// This module never imports electron: index.ts calls initPaths() with the electron values,
// and tests call it with temp folders.
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { PRODUCT_NAME, type Channel } from '../shared/channel'

export interface PathContext {
  isPackaged: boolean
  /** process.resourcesPath in production. */
  resourcesPath: string
  /** app.getPath('documents'): where the library lived before ~/Movies became the default */
  documentsDir: string
  /** app.getPath('videos'): ~/Movies on a Mac */
  moviesDir: string
  /** app.getPath('userData') */
  userDataDir: string
  /** app.getPath('appData'): the folder that holds every app's userData. The nightly reads the stable app's models there. */
  appDataDir?: string
  /** shared/channel.ts channelOf(app.getVersion()); stable when left out */
  channel?: Channel
  /** The app/ folder in dev (where package.json lives). */
  appDir: string
  /** Optional override of the Reel Studio root (Settings > Storage). */
  rootOverride?: string | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** os.homedir() unless a test gives one */
  homeDir?: string
}

let ctx: PathContext | null = null

export function initPaths(c: PathContext): void {
  ctx = { platform: process.platform, env: process.env, homeDir: homedir(), ...c }
}

export function setRootOverride(root: string | null): void {
  need().rootOverride = root
}

function need(): PathContext {
  if (!ctx) throw new Error('paths not initialised')
  return ctx
}

const isWin = (): boolean => need().platform === 'win32'
const isNightly = (): boolean => need().channel === 'nightly'
export const channel = (): Channel => need().channel ?? 'stable'
const env = (): NodeJS.ProcessEnv => need().env ?? process.env

/** Repo root in dev (the folder holding app/, engine/, templates/). */
export function repoRoot(): string {
  return resolve(need().appDir, '..')
}

// ---- Reel Studio root (user documents) -----------------------------------------------------

export const BIN_FOLDERS = {
  raw: 'Raw takes',
  broll: 'B-roll',
  music: 'Music',
  images: 'Images',
  exports: 'Exports',
  fonts: 'Fonts'
} as const

export type BinKey = keyof typeof BIN_FOLDERS

export function reelStudioRoot(): string {
  const c = need()
  if (env().REELSTUDIO_ROOT) return resolve(env().REELSTUDIO_ROOT as string)
  if (c.rootOverride) return c.rootOverride
  return defaultRoot()
}

/** The library folder's own name: the nightly keeps its reels apart from the stable app's. */
export const libraryFolderName = (): string => PRODUCT_NAME[channel()]

/** A new install's library folder: ~/Movies is not one of the folders macOS asks about. */
export const defaultRoot = (): string => join(need().moviesDir, libraryFolderName())

/** The library folder of stable installs made before ~/Movies became the default. Never the nightly's. */
export const legacyRoot = (): string => join(need().documentsDir, PRODUCT_NAME.stable)

/** The stable app's library folders, both defaults. The nightly never adopts, moves or writes into them. */
export const stableLibraryRoots = (): string[] => [legacyRoot(), join(need().moviesDir, PRODUCT_NAME.stable)]

const within = (child: string, parent: string): boolean => {
  const r = relative(resolve(parent), resolve(child))
  return r === '' || (!r.startsWith('..') && !isAbsolute(r))
}

/**
 * Where a folder really is, with every link and junction on the way resolved, even when its last parts don't exist
 * yet (a library folder the app is about to create). A part it can't read throws: the caller refuses, rather than
 * comparing a path it could not check.
 */
function realPlace(path: string): string {
  let at = resolve(path)
  const missing: string[] = []
  while (!existsSync(at)) {
    const up = dirname(at)
    if (up === at) break
    missing.unshift(basename(at))
    at = up
  }
  return join(realpathSync.native(at), ...missing)
}

/**
 * Settings › Storage: the library folder for a folder the person picked. Picking the library folder itself keeps it;
 * any other folder gets one inside it. The nightly refuses a folder that is, holds, or sits inside a stable library,
 * so it cannot write into the person's real reels. `stableRoots` adds the root the stable app saved, if it has one.
 */
export function chosenRoot(picked: string, stableRoots: string[] = stableLibraryRoots()): string {
  const name = libraryFolderName()
  const root = picked.split(/[\\/]/).filter(Boolean).pop() === name ? picked : join(picked, name)
  // Compared where both really are: a "Reel Studio (Nightly)" inside the picked folder can be a link or junction to
  // the stable library, and the nightly would then write the person's real reels through it.
  const real = isNightly() ? realPlace(root) : root
  if (isNightly() && stableRoots.some((s) => within(real, realPlace(s)) || within(realPlace(s), real))) {
    throw Object.assign(new Error(`refusing ${root}: it overlaps the stable app's library`), {
      code: 'STABLE_LIBRARY',
      userMessage: `That folder holds Reel Studio's own library. ${name} keeps its reels in a separate folder; pick another place.`
    })
  }
  return root
}

export const projectsDir = (): string => join(reelStudioRoot(), 'Projects')
export const libraryDir = (): string => join(reelStudioRoot(), 'Library')
export const binDir = (bin: BinKey): string => join(libraryDir(), BIN_FOLDERS[bin])
export const stylePath = (): string => join(reelStudioRoot(), 'My style.json')

// ---- App data (not user-facing) -------------------------------------------------------------

export const settingsDir = (): string => need().userDataDir
export const settingsFile = (): string => join(need().userDataDir, 'settings.json')
/**
 * Downloaded speech models. The nightly reads and writes the stable app's folder, so the 500 MB model is fetched once
 * per computer; an isolated profile (REELSTUDIO_USER_DATA, tests) keeps its own. Downloads into it are atomic and
 * locked (engine transcribe.download_model), so both apps can fetch at once.
 */
export function modelsDir(): string {
  const c = need()
  if (env().REELSTUDIO_MODELS_DIR) return env().REELSTUDIO_MODELS_DIR as string
  if (isNightly() && !env().REELSTUDIO_USER_DATA) {
    if (!c.appDataDir) throw new Error('paths: the nightly needs appDataDir to find the shared models folder')
    return join(c.appDataDir, PRODUCT_NAME.stable, 'models')
  }
  return join(c.userDataDir, 'models')
}
/** Files attached to a note while a job runs on its reel. They move into the project when their note runs. */
export const noteStagingRoot = (): string => join(need().userDataDir, 'note-staging')
/** One folder per project folder, not per name: videos with the same name in two storage folders (Settings >
 * Storage) never share, or clean up, each other's files. */
export const noteStagingDir = (projectFolder: string): string =>
  join(noteStagingRoot(), createHash('sha256').update(resolve(projectFolder)).digest('hex').slice(0, 16))
export const logsDir = (): string => join(need().userDataDir, 'logs')

/**
 * The engine's cache of song analysis, logo lookups and picture credits (engine assets.cache_dir). The app passes it
 * to every engine process, so Settings › Advanced measures and clears the folder the engine really uses. Outside an
 * isolated profile it is the engine's own default, so an existing cache is kept.
 */
export function engineCacheDir(): string {
  const e = env()
  if (e.REELENGINE_CACHE_DIR) return resolve(e.REELENGINE_CACHE_DIR)
  if (e.REELSTUDIO_USER_DATA) return join(settingsDir(), 'engine cache')
  const home = need().homeDir as string
  // The nightly's engine may write a newer cache format, so it never shares the stable app's cache.
  const n = isNightly() ? 'ReelStudio-Nightly' : 'ReelStudio'
  if (isWin()) return join(e.LOCALAPPDATA || join(home, 'AppData', 'Local'), n, 'cache')
  if (need().platform === 'darwin') return join(home, 'Library', 'Caches', n)
  return join(e.XDG_CACHE_HOME || join(home, '.cache'), n.toLowerCase())
}

// ---- Bundled resources -----------------------------------------------------------------------

function resource(...p: string[]): string {
  return join(need().resourcesPath, ...p)
}

const LEGAL_FILES = { license: 'LICENSE', notices: 'THIRD_PARTY.md' } as const

/** Settings › About › License / Third-party notices. packaging/electron-builder.yml copies both files from the repo
 * root to resources/licenses. Anything but those two names throws. */
export function legalFile(doc: unknown): string {
  if (doc !== 'license' && doc !== 'notices') throw new Error(`Unknown legal document: ${String(doc)}`)
  return join(need().isPackaged ? resource('licenses') : repoRoot(), LEGAL_FILES[doc])
}

/** The folder that contains the `reelengine` Python package. */
export function engineDir(): string {
  const e = env().REELSTUDIO_ENGINE_DIR
  if (e) return resolve(e)
  if (need().isPackaged) return resource('engine')
  const repoEngine = join(repoRoot(), 'engine')
  if (existsSync(join(repoEngine, 'reelengine', '__main__.py'))) return repoEngine
  return fakeEngineDir()
}

/** The engine's built-in sound effects (pack.json and its .opus files). The stand-in engine has none, so in
 * development this is always the repo's real engine. */
export function sfxPackDir(): string {
  return join(need().isPackaged ? resource('engine') : join(repoRoot(), 'engine'), 'reelengine', 'sfx')
}

/** Contact sheets and waveforms made for the Library screen (library-preview.ts); safe to delete. */
export const libraryPreviewDir = (): string => join(need().userDataDir, 'library-previews')
/** A tiny stand-in engine for UI work before the real one lands. Dev and tests only. */
export function fakeEngineDir(): string {
  return join(need().appDir, 'dev', 'fake-engine')
}

export function engineMode(): 'real' | 'fake' {
  return resolve(engineDir()) === resolve(fakeEngineDir()) ? 'fake' : 'real'
}

export function pythonExe(): string {
  const e = env().REELSTUDIO_PYTHON
  if (e) return e
  if (need().isPackaged) {
    return isWin() ? resource('python', 'python.exe') : resource('python', 'bin', 'python3')
  }
  const venv = join(engineDir(), '.venv')
  const venvPy = isWin() ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  if (existsSync(venvPy)) return venvPy
  return isWin() ? 'python' : 'python3'
}

/** First match for an executable on PATH, or null. */
export function which(name: string): string | null {
  const exts = isWin() ? (env().PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()) : ['']
  for (const dir of (env().PATH ?? env().Path ?? '').split(isWin() ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir.replace(/^"|"$/g, ''), name + ext)
      if (existsSync(p)) return p
    }
  }
  return null
}

function bundledBin(name: 'ffmpeg' | 'ffprobe'): string {
  const exe = isWin() ? `${name}.exe` : name
  if (need().isPackaged) return resource('ffmpeg', exe)
  return which(name) ?? name // dev: from PATH
}

export function ffmpegPath(): string {
  return env().REELENGINE_FFMPEG ?? bundledBin('ffmpeg')
}

export function ffprobePath(): string {
  return env().REELENGINE_FFPROBE ?? bundledBin('ffprobe')
}

export function fontsDir(): string | null {
  if (need().isPackaged) return resource('fonts')
  const p = join(repoRoot(), 'packaging', 'fonts')
  return existsSync(p) ? p : null
}

export function templatesDir(): string {
  if (need().isPackaged) return resource('templates')
  return join(repoRoot(), 'templates')
}

export function appIconPath(): string {
  if (need().isPackaged) return resource('icon.png')
  return join(repoRoot(), 'packaging', 'icons', 'icon.png')
}

/** Small test template shipped with the app, used to prove the animation renderer. */
export function testAnimationDir(): string {
  if (need().isPackaged) return resource('test-animation')
  return join(need().appDir, 'resources', 'test-animation')
}

let asrThreads: number | null = null
export function setAsrThreads(n: number | null): void {
  asrThreads = n
}

/** Environment for every engine process. */
/** A project's one writer (docs/ownership.md, owner.ts). */
export const OWNER_LOCK = join('work', '.owner.lock')

export function engineEnv(): NodeJS.ProcessEnv {
  const base = { ...env() }
  // Electron-hosted shells set this; it must never leak into child processes.
  delete base.ELECTRON_RUN_AS_NODE
  // The user's own Python setup must not reach the bundled engine. The engine runs
  // with -s -E (engine.ts), which already ignores these; they are removed for any python it starts.
  for (const k of ['PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONSAFEPATH', 'PYTHONINSPECT', 'PYTHONUSERBASE']) delete base[k]
  const out: NodeJS.ProcessEnv = {
    ...base,
    PYTHONPATH: engineDir(),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
    REELENGINE_MODELS: modelsDir(),
    REELENGINE_ROOT: reelStudioRoot(),
    // The app's own commands: one run outside a job (the edit drawer's pace and match previews, a cover scan with no
    // job) is ordered by the job lane, and never claims the project as a command run by hand does (owner.py)
    REELENGINE_APP: '1'
  }
  // The engine's own default (tools.appdata_dir) is the stable app's folder, which neither an isolated profile nor
  // the nightly may write to.
  if (out.REELENGINE_CACHE === undefined && (env().REELSTUDIO_USER_DATA || isNightly())) out.REELENGINE_CACHE = settingsDir()
  out.REELENGINE_CACHE_DIR = engineCacheDir()
  // Only absolute paths: a bare name means "not found", and the engine does its own PATH search.
  if (isAbsolute(ffmpegPath())) out.REELENGINE_FFMPEG = ffmpegPath()
  if (isAbsolute(ffprobePath())) out.REELENGINE_FFPROBE = ffprobePath()
  // the person's own fonts first (Library › Fonts), so a caption can name one; the bundled fonts stay last (tools.font_dirs)
  out.REELENGINE_FONTS = [binDir('fonts'), fontsDir()].filter((d): d is string => !!d).join(delimiter)
  if (asrThreads) out.REELENGINE_ASR_THREADS = String(asrThreads)
  return out
}
