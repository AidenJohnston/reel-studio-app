// TikTok API v2: https://developers.tiktok.com/doc/login-kit-desktop/
// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
import { accountName } from './account'
import { versionRows, type VersionRow } from '../shared/version-diff'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, net, powerMonitor, powerSaveBlocker, safeStorage, shell, type IpcMainInvokeEvent, Notification } from 'electron'
import { existsSync, promises as fs, appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { clipboardFiles, filesFromArgv } from './intake'
import { basename, dirname, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertIpcSender, validateIpcArgs } from './ipc-guard'
import { createRequire } from 'node:module'
import { createOutsideAccess, type OutsideAccess } from './outside-access'
import { createOutsideReels } from './outside-reels'
import {
  appIconPath,
  binDir,
  chosenRoot,
  engineCacheDir,
  engineDir,
  engineEnv,
  engineMode,
  ffmpegPath,
  ffprobePath,
  fontsDir,
  initPaths,
  legalFile,
  libraryDir,
  libraryPreviewDir,
  noteStagingDir,
  noteStagingRoot,
  logsDir,
  modelsDir,
  defaultRoot,
  projectsDir,
  pythonExe,
  reelStudioRoot,
  setAsrThreads,
  setRootOverride,
  settingsDir,
  sfxPackDir
} from './paths'
import { offerMoveToApplications, writeErrorCode } from './move-to-applications'
import { runSelfTest, selfTestArgs, type SelfTestResult } from './self-test'
import { createEngineRunner, killAllEngines, toUserError, type RunEngine } from './engine'
import { logDuration } from './diagnostics'
import { handleMediaProtocol, registerMediaScheme } from './media'
import {
  addChat,
  carryScript,
  detail,
  discardIfUntouched,
  ensureRoot,
  listProjects,
  searchProjects,
  listVersions,
  PLANNED_TITLE,
  planReel,
  PREVIEW_DIR,
  projectDir,
  readAppState,
  readJson,
  readProject,
  readWords,
  serialized,
  titleFromFile,
  uniqueSlug,
  updateAppState,
  stamp,
  summary as reelSummary,
  writeJson,
  writeProject,
  type AppState
} from './store'
import { COPY_GONE, canCopyAgain, clearFailedCopy, posterFrame, titleWithAnotherVideo } from './first-video'
import { addToLibrary, isVideo, listLibrary, uniqueDest } from './library'
import { libraryPreview } from './library-preview'
import { readLesson } from './style-learn'
import { countsOf, findPastEdits, mdfind, type FindDeps, type Found } from './past-edits'
import { appIcons, regDefault, type IconDeps } from './app-icons'
import { createJobManager } from './jobs'
import { createPauser, pauseFor, quitQuestion } from './pause'
import { createNoteQueue, noteOutcome, type NoteToRun, type StartHand } from './note-queue'
import { handEditJob, HAND_MESSAGE } from './hand-edit'
import { refreshMemories } from './memory-loop'
import { parseHandEdit } from '../shared/hand-edit'
import { learnPicker } from '../shared/style-editors'
import { checkPlan, planFromEditor, planReply, planTurns, titleFromTopic } from '../shared/plan'
import type { SoundEffect } from '../shared/sfx'
import { mediaUrl } from './media-url'
import { withRenderSlot } from './render-slot'
import { titleVersion } from './version-title'
import { createFootageIndexer } from './footage-index'
import { createFootageSources } from './footage-sources'
import { chooseSeries, groupReel } from './series'
import { createArchiveReels, libraryRef, seedFromArchive } from './archive-reels'
import { createProxyBuilds } from './proxy-builds'
import { WINDOW_SHOWN } from '../shared/perf-marks'
import { USAGE_ENDPOINT } from '../shared/config'
import { createUsage, editScore, postViews, usageCode } from './usage'
import { createLiveMoments, createLiveVideos } from './live-video'
import { askAboutStyle, type ChatLine, answerStyleQuestion, rememberQuestion } from './style-consent'
import type { AgentResult } from './ai-types'
import { loadAI } from './ai'
import type { AI, EngineHost } from './ai-types'
import { closeAnimationRenderer, renderAnimation, TEST_TEMPLATE } from './animation'
import { captureWebsite } from './capture'
import { createModelManager } from './models'
import { createWorkGate } from './work-gate'
import { TikTokService, tiktokSettings } from './tiktok'
import { registerTikTokIpc } from './tiktok-ipc'
import { InstagramService, instagramSettings } from './instagram'
import { registerInstagramIpc, testInstagramSession } from './instagram-ipc'
import { facebookFrom, instagramFrom, SigninDirectory, signinUrl, threadsFrom, tiktokFrom, xFrom, linkedinFrom } from './signin-config'
import { LinkedInService } from './linkedin'
import { XService } from './x'
import { ThreadsService } from './threads'
import { FacebookService } from './facebook'
import { registerSocialIpc } from './social-ipc'
import { testPlatformFetch } from './test-platforms'
import { SIGNIN_URL } from '../shared/config'
import { registerInsightsIpc } from './insights-ipc'
import { registerReferencesIpc } from './references-ipc'
import { createReferenceLibrary } from './references'
import { registerNicheIpc } from './niche-ipc'
import { ResultsRefresh, type ResultsSource } from './results-refresh'
import { testResultsSources } from './results-test-source'
import { InstagramError } from './instagram-http'
import { loadSettings, saveSettings, settleLibraryRoot, showsFirstRun, stableLibraries } from './settings'
import { clearEngineCache, engineCacheSize } from './engine-cache'
import { createPidRegistry } from './orphans'
import { settleLastRun } from './last-run'
import { openSignInWindow, publicInfo } from './claude-signin'
import { claudeCheckWords, createVendorConnect, type CliStatus, type VendorConnect } from './vendor-connect'
import { runLogin, testVendorEnv, testVendorLoginEnv, type Vendor } from './vendor-setup'
import { confirmHub, detectHub, type HubDetection } from './vendor-hub'
import { aiChoiceSaved, carryOverDecision } from './ai-carryover'
import type { UsageEvent } from '../shared/api'
import type { AppInfo, DropResult, EngineCache, ExportResult, JobEvent, ProjectDetail, ProjectJson, SettingsPane, CoverCandidate, MatchVerdict, NoteMoment, PacePreview, PlatformExportResult, VersionInfo, VersionTimeline, LearnedRule, MergeRequest, StyleRule, EditorName } from '../shared/api'
import { MERGE_LAYERS, MODEL_ROLES, type ModelChoice, type ModelRole } from '../shared/api'
import { mergeWords } from '../shared/combine'
import { COVER_SUGGESTIONS } from '../shared/cover'
import { coverScanOwner, createCoverScans, parseCoverCandidates } from './cover-scan'
import { noAiReply } from '../shared/notes'
import { aiNoteText, checkMoment, momentRoute, parseMoment, placeWords, typedMoment, type RenderSegment, forPerson, personText } from '../shared/moments'
import type { LayerItem } from '../shared/lanes'
import { parsePlatformExportRequest, sameVideo, secondTryPlatforms, type Platform, type PlatformTry, type TryVariable } from '../shared/platforms'
import { exportPlatforms, sweepExportStaging, type ExportTry } from './platform-export'
import { proposeTry } from './try-proposal'
import { foldProposal, makeReels, prepareReel, startProposal, type ReelsDeps } from './propose-reels'
import { versionMessage } from '../shared/describe'
import { mergeSourcesPatch } from '../shared/mirror'
import { assertWordCutEditable } from '../shared/cut'
import { displayPath } from '../shared/display-path'
import { channelOf } from '../shared/channel'
import { registerPhoneIpc, stopPhoneShare, cloudSavesRunning, cloudSavesSettled } from './phone-ipc'
import { forChat, pickClipboardType, registerAttachmentIpc, unstage, checkNoteAttachments } from './attachments'
import { LATEST_URL, type FetchLike } from './update-check'
import { createPermissions, notificationsWanted, parseFakes, type NotifyResult, type Permissions } from './permissions'
import { helperInstruction, MAC_PANES } from './mac-permission'
import { MacPermissionHelper } from './mac-permission-helper'
import { createUpdater, menuCheckForUpdates } from './updater'
import { autoUpdater } from 'electron-updater'
import { UPDATE_FEED_URL, electronUpdaterBackend, macBundleCheck, windowsInstaller } from './updater-electron'
import { disabledReason, updateMode } from './update-machine'
import { createJobFeedback, createMainWindow, feedbackLog, installMenu, showTimelineInMenu, startDragOut, windowStateFile, type AppCommand, titleBarOverlay } from './window'
import { takeNote } from './note-intake'
import { PROTOCOL, createUpdateKeyService } from './update-key'
import { setupPosting } from './posting-ipc'
import { createWindowHolder } from './window-holder'
import { registerCompanionIpc } from './companion-ipc'
import { insightsSummary } from './insights'
import { timingOf, wrappedReport, type WrappedReel } from '../shared/wrapped'
import { lanAddresses } from './phone-share'

const TEST = process.env.REELSTUDIO_TEST === '1'
// Test builds stand in for macOS's answers (permissions.ts parseFakes), and for a Mac itself (platform=darwin), so a
// run on Windows walks a Mac's first run. Notifications and folder access follow PERM_PLATFORM.
const PERM_FAKES = TEST ? parseFakes(process.env.REELSTUDIO_TEST_PERMISSIONS) : undefined
const PERM_PLATFORM: string = PERM_FAKES?.platform ?? process.platform
const DEV_PROVIDERS = process.env.REELSTUDIO_DEV === '1'
const SELF_TEST = selfTestArgs(process.argv)
// Stable or nightly, from the version alone (shared/channel.ts). The packaged name already differs per channel.
const CHANNEL = channelOf(app.getVersion())
const rendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  ? process.env.ELECTRON_RENDERER_URL
  : pathToFileURL(join(__dirname, '../renderer/index.html')).href
if (process.env.REELSTUDIO_USER_DATA) app.setPath('userData', process.env.REELSTUDIO_USER_DATA)
// The self-test must never read or write the person's own data: a throw-away folder stands in for both.
else if (SELF_TEST.selfTest) app.setPath('userData', mkdtempSync(join(tmpdir(), 'reel-studio-self-test-')))
// Test builds: stand-in Documents and Movies folders, so first run makes the real default folder inside them.
if (TEST && process.env.REELSTUDIO_DOCUMENTS) app.setPath('documents', process.env.REELSTUDIO_DOCUMENTS)
if (TEST && process.env.REELSTUDIO_MOVIES) app.setPath('videos', process.env.REELSTUDIO_MOVIES)
// Tests that save a key (safeStorage) must not write to the login keychain of the Mac they run on.
if (TEST && process.platform === 'darwin') app.commandLine.appendSwitch('use-mock-keychain')

registerMediaScheme()

initPaths({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  documentsDir: app.getPath('documents'),
  moviesDir: app.getPath('videos'),
  userDataDir: app.getPath('userData'),
  appDataDir: app.getPath('appData'),
  channel: CHANNEL,
  appDir: app.getAppPath(),
  rootOverride: SELF_TEST.selfTest ? join(app.getPath('userData'), 'Reel Studio') : null
})

// ---- logging ------------------------------------------------------------------------------------
const logFile = (): string => join(logsDir(), 'main.log')
function log(line: string): void {
  const s = `${new Date().toISOString()} ${line}`
  if (!app.isPackaged) console.log(s)
  try {
    mkdirSync(dirname(logFile()), { recursive: true })
    appendFileSync(logFile(), s + '\n')
  } catch {
    /* logging must never break the app */
  }
}

app.on('render-process-gone', (_event, contents, details) => {
  log(`[render-process-gone] type=Renderer webContentsId=${contents.id} reason=${details.reason} exitCode=${details.exitCode}`)
})
app.on('child-process-gone', (_event, details) => {
  log(`[child-process-gone] type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
})
app.on('browser-window-created', (_event, window) => {
  window.on('unresponsive', () => log(`[unresponsive] type=Renderer windowId=${window.id}`))
  window.on('responsive', () => log(`[responsive] type=Renderer windowId=${window.id}`))
})

function showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  return logDuration(`[dialog] ${options.title ?? 'Open folder'}`, log, async () => {
    const result = await dialog.showOpenDialog(win!, options)
    log(`[dialog] returned canceled=${result.canceled} selectedCount=${result.filePaths.length}`)
    return result
  })
}

// ---- engine, AI, jobs ----------------------------------------------------------------------------
let pidRegistry: ReturnType<typeof createPidRegistry> | null = null
const renderSlot = withRenderSlot(
  createEngineRunner({
    python: pythonExe,
    env: engineEnv,
    cwd: engineDir,
    log,
    onSpawn: (pid, project) => pidRegistry?.add(pid, project),
    onExit: (pid) => pidRegistry?.remove(pid)
  }),
  (owner, waiting) => jobs.waitingForRender(owner, waiting)
)
const runEngine: RunEngine = renderSlot.run
// Its own runner per build, with the same engine setup, so removing a project can wait for the exit.
const proxies = createProxyBuilds(
  (hooks) =>
    createEngineRunner({
      python: pythonExe,
      env: engineEnv,
      cwd: engineDir,
      log,
      onSpawn: (pid, project) => {
        pidRegistry?.add(pid, project)
        hooks.onSpawn(pid)
      },
      onExit: (pid) => {
        pidRegistry?.remove(pid)
        hooks.onExit(pid)
      }
    }),
  log
)

const host: EngineHost = {
  runEngine,
  renderAnimation: (template, params, outPath, fps) => renderAnimation(template, params, outPath, fps),
  captureWebsite: (url, outPath, opts) => captureWebsite(url, outPath, opts),
  reelStudioRoot,
  importFootage: (ref) => importFootage(ref)
}

// Reels across the whole footage archive (archive-reels.ts). Defined after jobs and startFirstEdit exist at run time.
const archiveReels = createArchiveReels({
  jobs: { start: (...a) => jobs.start(...a), get: (id) => jobs.get(id) },
  ai: () => ai,
  runEngine,
  root: reelStudioRoot,
  file: () => join(settingsDir(), 'archive-reels.json'),
  resolve: async (ref) => (ref.startsWith('Footage/') ? (await footageSources.resolve(ref)).abs : libraryRef(ref, libraryDir())),
  startFirstEdit: (slug, init) => startFirstEdit(slug, init)
})

/** A clip from a footage folder, put in the Library so the editor can place it (footage-sources.ts). */
async function importFootage(ref: string): Promise<string> {
  const { abs } = await footageSources.resolve(ref)
  await ensureRoot()
  const [r] = await addToLibrary([abs], runEngine, log, indexLibrary)
  if (!r?.dest) throw { code: 'IMPORT_FAILED', userMessage: r?.reason ?? 'That clip could not be added to your Library.' }
  return 'Library/' + relative(libraryDir(), r.dest).split(sep).join('/')
}

let ai: AI
let perms: Permissions
let aiSource: 'package' | 'mock' = 'mock'
let vendors: VendorConnect

// The environment the person's own Claude Code / Codex apps get. Normally the app's own; the test switch
// REELSTUDIO_TEST_VENDOR_HOME swaps in a throwaway home (a fresh machine) so a real install + sign-in can be tried
// without touching the apps already on this computer (vendor-setup.ts testVendorEnv).
const TEST_VENDOR_ENV = testVendorEnv(process.env, process.platform)
const cliBaseEnv = (): NodeJS.ProcessEnv => TEST_VENDOR_ENV ?? process.env
const TEST_LOGIN_ENV = testVendorLoginEnv(process.env, process.platform)
let win: BrowserWindow | null = null
const windows = createWindowHolder<BrowserWindow>()

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  companion?.publish(channel, payload)
}
/** Settings > Phone and browser: the paired phones and browsers (main/companion-ipc.ts). Set in registerIpc. */
let companion: ReturnType<typeof registerCompanionIpc> | null = null
/** This computer's name for "Connected to …" on a paired phone: the host name, without ".local" and dashes. */
const computerName = (): string => (TEST ? 'Test computer' : hostname().replace(/\.local$/i, '').replace(/[-_]+/g, ' ').trim() || 'this computer')

// The window, menu, Dock/taskbar and notifications (window.ts) hear about every job too.
const sendCommand = (c: AppCommand): void => broadcast('app:command', c)
let notificationsOn = true
const feedback = createJobFeedback({
  window: () => win,
  title: async (slug) => (await readProject(slug).catch(() => null))?.title || slug,
  send: sendCommand,
  test: TEST,
  notificationsOn: () => notificationsOn
})
if (TEST) (globalThis as { __reelFeedback?: unknown }).__reelFeedback = feedbackLog
// Under test, a paste reads these stand-in items (the e2e sets them), never the system clipboard.
const testClipboard: { items: Electron.ClipboardItem[] } = { items: [] }
if (TEST) (globalThis as { __reelClipboard?: unknown }).__reelClipboard = testClipboard
const workGate = createWorkGate()
/** Settings › Storage is moving the library: no job or manual edit may start until the new place is in use, or it
 * would take its project folder from the old place and its bookkeeping from the new one. */
let rootMoving = false
const refuseWhileRootMoves = (): void => {
  if (rootMoving) throw { code: 'BUSY', userMessage: 'Wait until your reels have finished moving, then try again.' }
}
/** Counts finished library moves. Work that reads paths, awaits, then starts a job takes this first and checks it
 * just before jobs.start: a move that finished in between means its paths point at the old place. */
let rootGeneration = 0
const sameRootSince = (generation: number): void => {
  if (generation !== rootGeneration) throw { code: 'BUSY', userMessage: 'Your reels moved meanwhile. Try again.' }
}
const footageSources = createFootageSources({
  load: async () => (await loadSettings()).footageSources,
  save: async (footageSources) => void (await saveSettings({ footageSources })),
  root: reelStudioRoot,
  changed: () => indexLibrary()
})
const footageIndex = createFootageIndexer({
  runEngine,
  root: reelStudioRoot,
  busy: () => jobs.runningCount() > 0,
  sources: () => footageSources.indexArgs(),
  done: (r) => { if (r.places) footageSources.indexed(r.places) }
})
// Tests leave the index alone (the stand-in engine has no speech to read) unless one asks for it.
const indexLibrary = (): void => { if (!TEST || process.env.REELSTUDIO_TEST_INDEX === '1') void footageIndex.request() }
// Honest progress (main/progress.ts): phase times measured on this computer, per minute of video.
const speedHistoryFile = (): string => join(settingsDir(), 'speed-history.json')
// Paused without you (main/pause.ts): work a plan limit, no internet, sleep or a quit stopped goes on by itself.
// A pause's margin after a plan's reset time is shortened only under test.
const pauser = createPauser({
  online: () => net.isOnline(),
  resume: (slug) => continuePaused(slug),
  log,
  ...(TEST && process.env.REELSTUDIO_PAUSE_MARGIN_MS ? { marginMs: Number(process.env.REELSTUDIO_PAUSE_MARGIN_MS) } : {})
})
/** When the computer last went to sleep: a job that fails after it paused for it. */
let sleptAt = 0
/** The editor's name for the words of a pause ("Your Claude plan…"). */
const editorName = (p: { id: string } | null): string | null =>
  p?.id === 'claude-cli' || p?.id === 'claude' ? 'Claude' : p?.id === 'chatgpt' ? 'ChatGPT' : null
const pauseCtx = (kind: 'first-edit' | 'note', startedAt: number, editor: string | null) => ({ kind, online: net.isOnline(), slept: sleptAt > startedAt, editor })
/** Reels being deleted: nothing continues them (continuePaused) or starts their preview copies. */
const removing = new Set<string>()
/** Starts the reel's preview copy build (proxy-builds.ts) unless the reel is being deleted. */
function startProxy(slug: string, dir: string): void {
  if (!removing.has(slug)) proxies.start(slug, dir)
}

/** Continues a paused reel: Version 1 starts again where it stopped (listening kept); waiting notes run on. */
async function continuePaused(slug: string): Promise<void> {
  const dir = projectDir(slug)
  if (!existsSync(dir)) return
  const st = await readAppState(slug)
  const made = (await listVersions(dir)).some((v) => !v.draft)
  // checked after the reads: a reel being deleted meanwhile, or started by the person, is left alone
  if (!st.paused || jobs.forSlug(slug) || removing.has(slug) || !existsSync(dir)) return
  if (made) {
    await updateAppState(slug, (s) => void delete s.paused)
    return noteQueue.resume(slug)
  }
  // paused during the copy: it copies the video again (startFirstEdit), unless the file it copied from is gone
  if (!existsSync(join(dir, 'project.json')) && !st.from && !(await canCopyAgain(st.copyFrom))) {
    await updateAppState(slug, (s) => {
      delete s.paused
      s.status = 'failed'
      s.lastError = COPY_GONE
    })
    return
  }
  startFirstEdit(slug, null)
}

// Settings › Privacy: anonymous usage data, only the parts the person switched on (main/usage.ts)
const usage = createUsage({
  dir: () => join(settingsDir(), 'usage'),
  sharing: async () => (await loadSettings()).sharing,
  version: app.getVersion(),
  platform: process.platform,
  log,
  endpoint: USAGE_ENDPOINT
})
const recordUsage = (e: UsageEvent): void => void usage.record(e).catch((err) => log(`[usage] ${String(err?.message ?? err)}`))
// Once a day to the collection address. There is none in any build yet (USAGE_ENDPOINT null), so nothing is scheduled.
if (USAGE_ENDPOINT) setInterval(() => void usage.send().catch((err) => log(`[usage] send: ${String(err?.message ?? err)}`)), 24 * 3_600_000).unref()
// Each version an edit made is scored once per run of the app, by the next thing done to its reel (usage.ts editScore).
// A version counts as scored only once a line was really kept: with quality sharing off nothing is used up, so turning
// it on later still scores what happens next. Cleared whenever quality sharing goes off (app:setSharing).
const scoredEdits = new Set<string>()
function scoreEdit(slug: string, made: number, next: Parameters<typeof editScore>[0]): void {
  const key = `${slug}:${made}`
  if (!(made >= 1) || scoredEdits.has(key)) return
  scoredEdits.add(key)
  void usage.record({ part: 'quality', name: 'edit', outcome: editScore(next, made) })
    .then((kept) => { if (!kept) scoredEdits.delete(key) }, (err) => {
      scoredEdits.delete(key)
      log(`[usage] ${String(err?.message ?? err)}`)
    })
}

const jobs = createJobManager(
  (e: JobEvent) => {
    broadcast('job:event', e)
    feedback.onJobEvent(e)
    noteQueue.onJobEvent(e)
    if (e.type === 'paused' && e.slug) pauser.schedule(e.slug, e.paused)
    if (e.type === 'done' && e.slug) pauser.settled(e.slug)
  },
  log,
  {
    profile: async (kind) => {
      if (kind !== 'first-edit') return kind
      const provider = await ai.active().catch(() => null)
      return provider?.connected && provider.id !== 'none' ? kind : 'first-edit-basic'
    },
    loadHistory: async () => JSON.parse(await fs.readFile(speedHistoryFile(), 'utf8')),
    saveHistory: (h) => writeJson(speedHistoryFile(), h),
    mediaSeconds: async (slug) =>
      ((await readProject(slug)).sources ?? []).reduce((a: number, s: { duration?: number }) => a + (Number(s?.duration) || 0), 0)
  },
  // render events carry a playable URL (a stable copy for drafts: main/live-video.ts)
  ((live) => (slug: string, e) => live(projectDir(slug), e))(createLiveVideos()),
  workGate,
  () => {
    refuseWhileRootMoves()
    updates.assertCanStartWork()
  },
  footageIndex,
  // and so do the pictures of each change made before its draft
  ((live) => (slug: string, e) => live(projectDir(slug), e))(createLiveMoments()),
  (kind, last, seconds) =>
    recordUsage({
      part: 'usage',
      name: 'job',
      job: kind,
      outcome: last.type === 'error' ? 'failed' : last.type,
      ...(last.type === 'error' ? { code: usageCode(last.code) } : {}),
      seconds: Math.round(seconds)
    })
)

/** A note job: the AI applies it as one all-or-nothing change (ai applyNote) on the newest version. */
async function startNote(slug: string, { id: noteId, text: own, attachments, moment, branch, steers, steer }: NoteToRun, record: (s: AppState) => void): Promise<string> {
  // words added on an earlier run (Add now) are part of the note from the start this time
  const text = [own, ...(steers ?? []).map((x) => x.text)].join('\n')
  const dir = projectDir(slug)
  const startedAt = Date.now()
  let editor: string | null = null
  let prepared!: () => void
  const preparing = new Promise<void>((resolve) => { prepared = resolve })
  const jobId = jobs.start(
    slug,
    'note',
    async (emit, signal, { id: jobId, owner }) => {
      try {
        editor = editorName(await ai.active().catch(() => null))
        await unstage(dir, noteStagingDir(dir), attachments)
      } finally {
        prepared()
      }
      const before = (await readProject(slug)).version ?? 0
      startProxy(slug, dir) // a project from before preview copies existed gets them now
      scoreEdit(slug, before, { type: 'note', on: branch ?? before })
      // saved under its queue entry's id (note-queue.ts), with the job's id in its version's receipt; the app asks
      // before anything goes into My style
      const { checkEdits: checkEdit, lookUps: helpers } = await loadSettings() // Settings > "Double-check each edit", "Look things up in parallel"
      const opts = { attachments: attachments.map((f) => f.asset), id: noteId, jobId, checkEdit, helpers, saveStyleRules: false, ...(branch !== undefined ? { base: branch } : {}), ...(owner ? { owner } : {}), ...(steer ? { steer } : {}) }
      // the AI reads the moment in the note text: "At 0:08 (around "...", words w18, w19): cut this part";
      // what it says back while it works reaches the progress card in the person's own words
      const aiText = [aiNoteText(own, moment), ...(steers ?? []).map((x) => aiNoteText(x.text, x.moment))].join('\n')
      const r: AgentResult = await ai.applyNote(dir, aiText, forPerson(emit, aiText, text), signal, opts)
      await recordMadeWith(dir, r)
      if (r.changed.length && r.version !== undefined && ai.rewordVersion) {
        void titleVersion(slug, r.version, ai.rewordVersion.bind(ai), AbortSignal.timeout(60_000)).catch((e) =>
          log(`[ai] version title: ${String(e?.message ?? e)}`)
        )
      }
      const extra = r.notice?.userMessage ? ` ${r.notice.userMessage}` : ''
      // the editor's summary may echo aiText, moment and word ids included
      const reply = await replyAskingAboutStyle(r, personText(r.summary, aiText, text) + extra)
      return { ...reply, outcome: noteOutcome(before, r), made: { by: 'note', summary: text } }
    },
    { note: text || attachments.map((f) => f.name).join(', '), record, pause: (e) => pauseFor(e, pauseCtx('note', startedAt, editor)) }
  )
  // pump holds the queue lane until preparation ends, including jobs that fail before their callback.
  await Promise.race([preparing, jobs.get(jobId)!.done])
  return jobId
}
/** A change from "Edit it myself", when its turn comes: render only, never the editor (hand-edit.ts). */
const startHand: StartHand = async (slug, entry, record) =>
  jobs.start(slug, 'rerender', handEditJob(runEngine, slug, entry), { note: HAND_MESSAGE, record })
const noteQueue = createNoteQueue({ jobs, startNote, startHand, changed: (slug) => broadcast('queue:change', slug), log, words: (q) => aiNoteText(q.text, q.moment) })

const models = createModelManager({
  runEngine,
  onChange: (s) => broadcast('model:progress', s),
  loadCheck: async () => (await loadSettings()).speechCheck,
  saveCheck: async (speechCheck) => void (await saveSettings({ speechCheck })),
  useThreads: setAsrThreads,
  gate: workGate,
  // The engine stops starting new counts after 15 s, and one count took at most about 7 s on a busy M4 Pro, so a
  // check still running after a minute is stuck.
  checkDeadlineMs: 60_000,
  log
})
const coverScans = createCoverScans(runEngine)
// The buyer's download key for automatic updates (main/update-key.ts). It arrives as a reelstudio://updates?key=…
// link (open-url on macOS, the command line on Windows) or pasted in Settings. Links that come before the app
// is ready wait for it.
const UPDATES_ON_DETAIL = 'When a new version comes out, Reel Studio offers to update itself: say yes and it downloads the new version and installs it when you restart. You can turn this off in Settings > About.'
function showWindow(): BrowserWindow {
  const live = windows.getLive() ?? createWindow()
  if (live.isMinimized()) live.restore()
  live.focus()
  return live
}
const updateKey = createUpdateKeyService({
  load: loadSettings,
  save: saveSettings,
  log,
  send: (s) => {
    broadcast('updateKey:change', s)
    updates.keyChanged(s.on)
  },
  // Any web page can open a reelstudio:// link, so a key from one is saved only after a yes.
  confirmLink: async ({ replacing }) => {
    const live = showWindow()
    const opts: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: [replacing ? 'Use this key' : 'Turn on', 'Cancel'],
      defaultId: replacing ? 1 : 0,
      cancelId: 1,
      message: replacing ? 'Use the download key from this link instead?' : 'Turn on automatic updates with the download key from this link?',
      detail: `Only say yes if you just clicked the button in your Reel Studio receipt email or on its thanks page. The key decides whose subscription this computer uses for updates and for posting.\n\n${replacing ? 'It replaces the download key saved on this computer now.' : UPDATES_ON_DETAIL}`
    }
    return (await dialog.showMessageBox(live, opts)).response === 0
  }
})

// ---- updates (main/updater.ts) -------------------------------------------------------------------
// Test runs never touch the network, except the update e2e, which points a dev build at a local server
// (REELSTUDIO_UPDATE_FEED, honoured only in an unpackaged test run: app/e2e/update.spec.ts).
const TEST_FEED = TEST && !app.isPackaged ? process.env.REELSTUDIO_UPDATE_FEED : undefined
let exportsWriting = 0
const updateBusy = () => ({ exporting: exportsWriting > 0, working: jobs.runningCount() })

/** electron-updater reads app-update.yml (packaging/electron-builder.yml `publish`) only to switch itself on;
 * the backend sets the feed at runtime. The e2e writes the same file for a dev build. */
function readUpdateConfig(): string | null {
  if (TEST_FEED) {
    const file = join(app.getPath('userData'), 'dev-app-update.yml')
    const text = `provider: generic\nurl: ${TEST_FEED}/u/\nupdaterCacheDirName: reel-studio-e2e-updater-${basename(dirname(app.getPath('userData')))}\n`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
    return file
  }
  const file = join(process.resourcesPath, 'app-update.yml')
  return existsSync(file) ? file : null
}

const updateConfig = app.isPackaged || TEST_FEED ? readUpdateConfig() : null
const updateEnv = {
  platform: process.platform,
  // a nightly build doesn't update itself (update-machine.ts disabledReason); REELSTUDIO_UPDATE_AS lets the update
  // e2e run a dev build as one
  channel: channelOf((TEST_FEED && process.env.REELSTUDIO_UPDATE_AS) || app.getVersion()),
  isPackaged: app.isPackaged || !!TEST_FEED,
  test: TEST && !TEST_FEED,
  hasFeed: updateConfig !== null,
  inApplications: !!TEST_FEED || (app.isPackaged && process.platform === 'darwin' && app.isInApplicationsFolder())
}
const siteFetch: FetchLike = (url, init) => fetch(url, init) // Node's fetch: no Electron session, so no cookies
const updateOff = disabledReason(updateEnv)
const updateHow = updateMode(updateEnv)
const updates = createUpdater({
  version: app.getVersion(),
  mode: updateHow,
  disabledReason: updateOff,
  backend: updateOff
    ? null
    : electronUpdaterBackend({
        updater: autoUpdater,
        version: app.getVersion(),
        fetch: siteFetch,
        latestUrl: TEST_FEED ? `${TEST_FEED}/latest.json` : LATEST_URL,
        feedUrl: TEST_FEED ? `${TEST_FEED}/u/` : UPDATE_FEED_URL,
        keys: updateKey,
        log,
        devFeedFile: TEST_FEED ? updateConfig ?? undefined : undefined,
        onError: (e) => updates.installFailed(e),
        install: process.platform === 'win32' ? windowsInstaller(app.getVersion()) : macBundleCheck(app.getVersion())
      }),
  load: loadSettings,
  save: saveSettings,
  busy: updateBusy,
  prepareToQuit: async () => {
    await stopPhoneShare()
    await jobs.cancelAll()
    await killAllEngines()
  },
  openExternal: (url) => shell.openExternal(url),
  send: (st) => broadcast('update:state', st),
  log,
  now: () => Date.now()
})
log(`[update] ${updateOff ?? `on (${updateHow})`}`)
let ready = false
const waitingKeyLinks: string[] = []
function acceptKeyLink(url: string): void {
  if (!ready) {
    waitingKeyLinks.push(url)
    return
  }
  void updateKey
    .fromLink(url)
    .then((s) => {
      if (!s?.on || s.asked) return // asked: the yes was enough
      const live = showWindow()
      void dialog.showMessageBox(live, { type: 'info', message: 'Automatic updates are on', detail: UPDATES_ON_DETAIL })
    })
    .catch((e) => log(`[updates] key link: ${String(e)}`))
}
app.on('open-url', (e, url) => {
  e.preventDefault()
  acceptKeyLink(url)
})

// ---- helpers ------------------------------------------------------------------------------------
type Handler = (e: IpcMainInvokeEvent, ...args: any[]) => unknown

/** Every IPC call returns {ok, value} or {ok:false, error:{code,userMessage}} so errors stay friendly. */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      assertIpcSender(e, win?.webContents, rendererUrl)
      validateIpcArgs(channel, args)
      return { ok: true, value: await fn(e, ...args) }
    } catch (err) {
      const u = toUserError(err)
      log(`[ipc ${channel}] ${u.code}: ${u.message ?? u.userMessage}`)
      const link = (err as { link?: unknown })?.link
      return { ok: false, error: { code: u.code, userMessage: u.userMessage, ...(typeof link === 'string' ? { link } : {}) } }
    }
  })
}

const rootDisplay = (root: string): string =>
  displayPath(root, { documents: app.getPath('documents'), desktop: app.getPath('desktop'), home: app.getPath('home') }, process.platform)

// Read once: the sidebar shows it on every screen. Tests show no name, so screenshots never carry one.
let accountNameRead: Promise<string | null> | null = null

/** firstRunAgain as it was when this launch started (settings.ts showsFirstRun). */
let firstRunAgainAtLaunch = false
const firstRunShows = async (): Promise<boolean> => showsFirstRun(await loadSettings(), firstRunAgainAtLaunch)

async function appInfo(): Promise<AppInfo> {
  const s = await loadSettings()
  accountNameRead ??= TEST ? Promise.resolve(null) : accountName()
  // The real long path, never an 8.3 short name like USERNA~1 (design critique 1.9). Not during first run: the
  // folder is not made yet, and looking inside Documents before setup explains why is what makes macOS ask.
  let root = reelStudioRoot()
  try {
    if (s.firstRunDone) root = realpathSync.native(root)
  } catch {
    /* not created yet: show it as configured */
  }
  return {
    version: app.getVersion(),
    platform: process.platform,
    root,
    rootDisplay: rootDisplay(root),
    firstRunDone: !showsFirstRun(s, firstRunAgainAtLaunch),
    firstRunAgain: s.firstRunAgain,
    fasterExports: s.fasterExports,
    footageIndex: footageIndex.status(),
    engine: { mode: engineMode(), dir: engineDir(), python: pythonExe() },
    ai: aiSource,
    test: TEST,
    dev: DEV_PROVIDERS,
    userName: await accountNameRead,
    models: s.models,
    sharing: s.sharing,
    phoneView: s.phoneView,
    timeline: s.timeline,
    soundEffects: s.soundEffects
  }
}

/** Engine arguments for a command a job runs: it joins the job's ownership of the project. */
function owned(args: string[], owner: string | null): string[] {
  return owner ? [...args, '--owner', owner] : args
}

/** `basic`: the version is made without the editor (a failed Version 1's "Make a basic version"). `initArgs` null: a
 * resume: one stopped during its copy copies the video again from app.json `copyFrom`. A reel made from another reel's
 * proposal starts from its app.json `from` (main/propose-reels.ts). `record`: changes to app.json written with the
 * job's start, so a start that is refused leaves none of them behind. */
function startFirstEdit(slug: string, initArgs: { title: string; files: string[] } | null, basic = false, record?: (s: AppState) => void): string {
  const dir = projectDir(slug)
  const startedAt = Date.now()
  let editor: string | null = null
  // a plan at its limit, no internet or sleep pauses Version 1 to continue by itself (main/pause.ts)
  const pause = (e: unknown) => (basic ? null : pauseFor(e, pauseCtx('first-edit', startedAt, editor)))
  // with the job's start: what the copy is made from, until it is in, so a Stop during the copy can copy it again
  const started = (s: AppState): void => {
    if (initArgs) s.copyFrom = initArgs.files
    record?.(s)
  }
  return jobs.start(slug, 'first-edit', async (emit, signal, { owner }) => {
    const st = await readAppState(slug)
    const copyIn = async (title: string, files: string[]) => {
      const { fasterExports } = await loadSettings()
      emit({ type: 'status', message: 'Copying your video', pct: 0 })
      // an archive pick's parts name their files by position (archive-reels.ts), so its copy never re-sorts them by date
      const keepOrder = st.fromArchive ? ['--keep-order'] : []
      await runEngine(
        'init',
        owned(['--project', dir, '--title', title, '--slug', slug, ...(fasterExports ? ['--faster-exports'] : []), ...keepOrder], owner).concat(files),
        // A copy is instant. A clip whose frame timing varies is re-encoded first (engine init.py says
        // "Preparing your video"), which can take minutes: that gets its own step with its real percent.
        (p) =>
          emit(
            p.message === 'Preparing your video'
              ? { type: 'status', message: p.message, pct: Math.round(p.pct), phase: 'prepare' }
              : { type: 'status', message: 'Copying your video', pct: Math.round(p.pct * 0.01) }
          ),
        signal
      )
    }
    // a reel made from another reel's proposal is copied in and seeded from it, on a resume too if the app closed
    // between the two, so it never becomes an edit of the whole video
    const from = st.from
    if (from) await prepareReel(slug, from, () => copyIn(from.about.title, [from.media]), { resumed: !initArgs, signal })
    else if (!existsSync(join(dir, 'project.json'))) {
      // No project.json: the copy is not in. A resume (Stop, a quit or a pause during the copy) copies again from the
      // files the person dropped, after clearing what was half copied, so a partial copy is never taken for the video.
      const files = initArgs?.files ?? st.copyFrom ?? []
      if (!initArgs) {
        if (!(await canCopyAgain(files))) throw COPY_GONE
        await clearFailedCopy(dir)
      }
      await copyIn(initArgs?.title ?? st.title ?? titleFromFile(files[0]), files).catch(async (e) => {
        // refused before a copy exists (no sound, not a video): the card shows the file's first frame instead
        await posterFrame(ffmpegPath(), files[0], dir).catch((err) => log(`[poster] ${slug}: ${String(err).slice(0, 300)}`))
        throw e
      })
      await updateAppState(slug, (s) => void delete s.copyFrom)
    }
    // a reel planned before it had a video: the editor reads its script from project.json (again on a resume,
    // in case the app closed between the copy and this)
    await carryScript(slug)
    // a reel from a pick across the footage archive: its spans become its cut (again on a resume, until they are in)
    await seedFromArchive(slug)
    startProxy(slug, dir)
    // A video picked on the welcome can come before the listening download is in (FirstRun.tsx starts it): Version 1
    // waits for that download, or starts it, rather than failing on a missing model (engine transcribe.py MODEL_MISSING).
    if (!models.status().installed && !existsSync(join(dir, 'work', 'transcript.json'))) {
      emit({ type: 'status', message: 'Getting ready to listen', pct: 0, phase: 'listen' })
      const ready = await models.download()
      if (signal.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
      if (!ready.installed)
        throw { code: 'MODEL_MISSING', userMessage: ready.error ?? "Reel Studio couldn't get ready to listen, so check your internet connection and try again." }
    }
    const provider = basic ? null : await ai.active().catch(() => null)
    editor = editorName(provider)
    // A render event with firstLook = the quick no-AI draft is ready while the AI keeps editing; the
    // Reel screen plays it (shared/live.ts) and says what it is. Once listening is done (the first
    // status of a later phase), the words heard go to the Reel screen ("I heard: ...").
    let heard = false
    const r = await ai.firstEdit(
      dir,
      (e) => {
        emit(e)
        if (!heard && e.type === 'status' && e.phase && e.phase !== 'listen') {
          heard = true
          void readProject(slug)
            .then((p) => readWords(dir, p))
            .then((w) => w.length && emit({ type: 'heard', words: w.map((x) => x.w) }))
            .catch(() => undefined)
        }
      },
      signal,
      { ...(owner ? { owner } : {}), ...(basic ? { basic } : { pauseOn: (e) => pause(e) !== null }) }
    )
    // Honest "What I did": only an AI that ran to the end picked the takes and wrote the caption.
    // A notice means it stopped and (usually) the simple edit stepped in, so claim nothing.
    const aiEdited = !!provider && provider.connected && provider.id !== 'none' && !r.notice
    if (aiEdited) await recordMadeWith(dir, { ...r, version: r.version ?? 1 })
    await updateAppState(slug, (s) => {
      s.aiEdited = aiEdited
    })
    if (r.notice?.userMessage) await addChat(slug, 'editor', r.notice.userMessage)
    await groupReel(slug).catch((e) => log(`[series] ${slug}: ${String(e).slice(0, 300)}`))
    return replyAskingAboutStyle(r, r.summary)
  }, { pause, record: started })
}

/** Which model made a version, beside it (`versions/vN/made-with.json`, as title.json is): its line in the notes names
 * it. A version a basic edit made has no model, and no file. */
async function recordMadeWith(dir: string, r: AgentResult): Promise<void> {
  if (!r.model || r.version === undefined) return
  await writeJson(join(dir, 'versions', `v${r.version}`, 'made-with.json'), { model: r.model }).catch((e) => log(`[ai] made-with: ${String(e)}`))
}

/** The editor's reply into the chat, then one "Remember this for next time?" per My style rule (style-consent.ts). */
function replyAskingAboutStyle(r: AgentResult, summary: string): Promise<{ summary: string; version?: number; chat: ChatLine[] }> {
  return askAboutStyle({ styleRules: () => ai.styleRules(), removeStyleRule: (id, o) => ai.removeStyleRule(id, o) }, r, summary)
}

const EDITABLE: (keyof ProjectJson)[] = ['title', 'cut', 'captions', 'music', 'broll', 'zooms', 'cover', 'post']

function safeFileName(s: string): string {
  const t = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  return t.slice(0, 80) || 'My reel'
}

async function finishedExportVersion(slug: string, n: number): Promise<VersionInfo> {
  const generation = rootGeneration
  const dir = projectDir(slug)
  let versions = await listVersions(dir)
  let v = versions.find((x) => x.n === n) ?? versions[versions.length - 1]
  if (!v) throw { code: 'NO_VERSION', userMessage: 'This reel has no version yet. Wait for Version 1, then share it.' }
  // the library moved while the versions were read: `dir` is the old place
  sameRootSince(generation)
  if (jobs.forSlug(slug)) throw { code: 'BUSY', userMessage: 'A version is still being made. Share once it’s ready.' }
  if (v.draft) {
    // A preview is not the full-quality file: make it first, as a normal job (progress, Stop, and
    // nothing else can run on this video meanwhile) (review 25).
    let stopped: AbortSignal | undefined
    jobs.start(slug, 'export', async (emit, signal, { id, owner }) => {
      stopped = signal
      emit({ type: 'status', message: 'Making the full-quality version', pct: 1, phase: 'final' })
      const r: any = await runEngine(
        'render',
        owned(['--project', dir, '--job-id', id], owner),
        (pr) => emit({ type: 'status', message: pr.message || 'Making the full-quality version', pct: pr.pct, phase: 'final' }),
        signal
      )
      const version = Number(r?.version ?? 0)
      emit({ type: 'render', version, draft: false })
      return { summary: '', version, chat: [] }
    })
    await jobs.forSlug(slug)?.done
    if (stopped?.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
    versions = await listVersions(dir)
    v = versions[versions.length - 1]
    if (!v || v.draft) throw { code: 'EXPORT_FAILED', userMessage: 'The full-quality version didn’t finish. Try again.' }
  }
  return v
}

async function exportVersion(slug: string, n: number): Promise<ExportResult> {
  const v = await finishedExportVersion(slug, n)
  const p = await readProject(slug)
  const exportsDir = binDir('exports')
  await fs.mkdir(exportsDir, { recursive: true })
  // "<title> - Version 2.mp4": the same words as the version buttons, never a bare "(2)".
  const name = `${safeFileName(p.title || slug)} - Version ${v.n}`
  const video = uniqueDest(exportsDir, `${name}.mp4`)
  const stem = basename(video, '.mp4')
  await fs.copyFile(v.videoPath, video)
  indexLibrary()
  let cover: string | null = null
  const coverSrc = join(dirname(v.videoPath), 'cover.png')
  if (existsSync(coverSrc)) {
    cover = join(exportsDir, `${stem} cover.png`)
    await fs.copyFile(coverSrc, cover)
  }
  const tags = (Array.isArray(p.post?.hashtags) ? p.post!.hashtags : [])
    .map((h) => String(h))
    .map((h) => (h.startsWith('#') ? h : `#${h}`))
    .join(' ')
  const caption = [p.post?.caption ?? '', tags].filter(Boolean).join('\n\n')
  const captionFile = join(exportsDir, `${stem} caption.txt`)
  await fs.writeFile(captionFile, caption + '\n', 'utf8')
  return { folder: exportsDir, video, cover, captionFile, caption, version: v.n }
}

// ---- IPC ----------------------------------------------------------------------------------------
// Every word version `n` (0 = the Preview) plays, placed by that render's own timeline: the segments
// the engine cut it from (render.json segmentsDetail, docs/versions.md). null when the version or its
// timeline is missing.
async function readTimeline(slug: string, n: number): Promise<VersionTimeline | null> {
  const dir = projectDir(slug)
  const vdir = join(dir, 'versions', n === 0 ? PREVIEW_DIR : `v${n}`)
  const r = await readJson<{ duration?: number; segmentsDetail?: RenderSegment[]; layerItems?: unknown }>(join(vdir, n === 0 ? 'render_draft.json' : 'render.json'), {})
  if (typeof r.duration !== 'number' || !r.segmentsDetail?.length) return null
  const project = await readProject(slug)
  const words = await readWords(dir, project)
  // the version's own copy, saved by its render; the reel's project.json when it is gone
  const own = (await readJson<ProjectJson | null>(join(vdir, 'project.json'), null)) ?? project
  const layers = Array.isArray(r.layerItems) ? r.layerItems.filter((x): x is LayerItem => !!x && typeof x === 'object' && typeof x.id === 'string') : []
  return {
    duration: r.duration,
    words: placeWords(r.segmentsDetail, words),
    segments: r.segmentsDetail,
    project: { broll: own.broll, sfx: own.sfx, music: own.music, cut: own.cut, sources: own.sources },
    layers
  }
}

// Before → after rows for version `n`: its saved project.json against the version before it, or for
// Version 1 against the raw video. null when the version's own snapshot is gone.
async function readVersionRows(slug: string, n: number): Promise<VersionRow[] | null> {
  const dir = projectDir(slug)
  const snap = (v: number) => readJson<ProjectJson | null>(join(dir, 'versions', `v${v}`, 'project.json'), null)
  const length = async (v: number) => (await readJson<{ duration?: number }>(join(dir, 'versions', `v${v}`, 'render.json'), {})).duration ?? null
  const after = await snap(n)
  if (!after) return null
  if (n === 1) {
    const raw = (after.sources ?? []).reduce((t, s) => t + (s.duration ?? 0), 0)
    return versionRows(null, after, { before: raw > 0 ? raw : null, after: await length(1) })
  }
  const before = await snap(n - 1)
  return before ? versionRows(before, after, { before: await length(n - 1), after: await length(n) }) : null
}

/** A note from the Reel screen, or from another AI app through Settings › Let other AI apps use Reel Studio
 * (outside-access.ts): either way it goes through the reel's note queue, so it shows, waits, runs and stops the same. */
/** `steer` (Add now from the window, or add_to_running_note): the words go into the note running now when they can;
 * otherwise they wait like any note, and `added` is false. */
async function sendNote(slug: string, text: string, attachments?: unknown, at?: unknown, onVersion?: unknown, requestedBase?: unknown, steer?: unknown): Promise<{ jobId: string | null; queued?: boolean; added?: boolean; noEditor?: true }> {
  // Admission (takeNote re-reads every attached file; the moment is checked against its render) runs in this
  // video's queue lane, so removing an attachment or a staged write can't land between the check and the entry.
  const admit = async () => {
    const dir = projectDir(slug)
    // never trust the page: every attached ref is re-read from THIS project's own sidecars or its staging folder, and
    // a video kept closed refuses the note before the queue or the chat shows it (note-intake.ts)
    const { note: typedText, files, base } = await takeNote(jobs, slug, text, attachments, requestedBase)
    // "At 1:00: zoom in" with Just here: the typed time is the moment, and the words are the note
    const typed = at !== undefined ? typedMoment(typedText) : null
    let note = typed ? typed.rest : typedText
    if (!note && !files.length) throw { code: 'EMPTY', userMessage: 'Type what you would like changed first.' }
    if (!note && typed) note = 'Put this here' // a typed time and a file, as the pop-up says it
    let moment: NoteMoment | undefined
    if (at !== undefined) {
      let asked: NoteMoment
      try {
        asked = parseMoment(at)
      } catch (e) {
        throw { code: 'BAD_MOMENT', message: String(e), userMessage: 'That moment was lost. Set the moment again, then send your note.' }
      }
      if (typed) asked = { ...asked, at: typed.at }
      // checked against the render it names, the one the pop-up read its words from; its words and
      // quote come from that render, never from the page
      const c = checkMoment(asked, await readTimeline(slug, asked.version))
      if ('refuse' in c) throw { code: 'BAD_MOMENT', userMessage: c.refuse }
      moment = c.moment
      if (moment.words.join() !== asked.words.join()) log(`[note] moment words from the page (${asked.words.join(' ')}) differ from the render's; using the render's`)
      // A setting global by nature ("smaller captions") goes without its moment, which would hide it
      // from applyNote's no-model fast path; the chat shows the words as typed.
      if (!files.length && (await momentRoute(typedText, (w) => ai.wholeReelSetting(dir, w))) === 'fast') moment = undefined
    }
    return { typedText, note, files, base, moment }
  }
  const active = await ai.active().catch(() => null)
  if (!active || !active.connected || active.id === 'none') {
    // No AI editor: nothing can apply the note, so do not pretend. Say what they can do instead
    // and offer the matching manual control plus "Connect ChatGPT" (grandma test, finding 8).
    return noteQueue.run(slug, async () => {
      const { typedText, note, files, moment } = await admit()
      // the chat keeps the words as typed, "At 0:05:" included
      await addChat(slug, 'you', typedText, undefined, undefined, undefined, files.map(forChat), moment)
      const reply = noAiReply(note, files.length)
      await addChat(slug, 'editor', reply.text, undefined, reply.actions)
      return { jobId: null, noEditor: true as const }
    })
  }
  const given = Number.isInteger(onVersion) ? Number(onVersion) : undefined
  return noteQueue.send(slug, async () => {
    const { note, files, base, moment } = await admit()
    // the queue entry carries the moment: its chat line shows it and the AI reads it (startNote). A branched note
    // (version-tree) carries the saved version it changes: startNote passes it to applyNote as `base`
    const seenVersion = given ?? moment?.version ?? (await readProject(slug)).version ?? 0
    return { text: note, attachments: files.map(forChat), ...(moment ? { moment } : {}), ...(base !== undefined ? { branch: base } : {}), seenVersion }
  }, given ?? 0, { steer: steer === true })
}

/** Settings › Editor › "Let other AI apps use Reel Studio" (outside-access.ts); made at startup, once `ai` is loaded. */
let outside: OutsideAccess | null = null
function createOutside(): OutsideAccess {
  const controls = createOutsideReels({
    // checked as the Reel screen's own send is (ipc-guard.ts): a reel id, the words, a saved version to branch from
    send: (slug, text, base, steer) => {
      validateIpcArgs('projects:note', [slug, text, undefined, undefined, undefined, base])
      return sendNote(slug, text, undefined, undefined, undefined, base, steer)
    },
    running: (slug) => jobs.forSlug(slug),
    stop: (jobId, slug) => noteQueue.stop(jobId, slug)
  })
  return createOutsideAccess({
    dir: join(settingsDir(), 'mcp'),
    platform: process.platform,
    command: process.execPath,
    // the relay ships with the AI package (ai/relay); the app copies it beside the access file each time access turns on
    relaySource: () => fs.readFile(createRequire(__filename).resolve('@reelstudio/ai/relay/reelstudio-mcp.js'), 'utf8'),
    controls,
    onChange: (st) => broadcast('outside:change', st),
    log
  })
}

function registerIpc(): void {
  // My style › Reference reels and Your niche
  const references = createReferenceLibrary({ root: reelStudioRoot, runEngine, log, mediaUrl, onChange: () => win?.webContents.send('refs:changed') })
  registerReferencesIpc({
    handle, library: references, ensureRoot,
    openExternal: (url) => (TEST ? Promise.resolve(log(`[references] test run: not opening ${url}`)) : shell.openExternal(url)),
    showItemInFolder: (file) => (TEST ? log(`[references] reveal ${file}`) : shell.showItemInFolder(file))
  })
  registerNicheIpc({ handle, root: reelStudioRoot, ai: () => ai, log, status: (s) => win?.webContents.send('niche:status', s) })
  // Instagram and TikTok connect through Reel Studio's sign-in service (docs/signin.md): its list of platforms says
  // which can be connected. A developer's own app (REELSTUDIO_DEV=1 and saved instagram*/tiktok* settings) wins.
  const platformFetch = TEST && process.env.REELSTUDIO_TEST_PLATFORMS
    ? testPlatformFetch(process.env.REELSTUDIO_TEST_PLATFORMS, (url, init) => fetch(url, init))
    : (url: string, init: RequestInit) => fetch(url, init)
  const signin = new SigninDirectory({ baseUrl: signinUrl(process.env, SIGNIN_URL, log), fetch: platformFetch, now: () => Date.now(), log })
  const ownApps = async () => {
    if (!DEV_PROVIDERS || TEST) return { instagram: null, tiktok: null }
    const saved = await loadSettings()
    const ig = instagramSettings(saved), tt = tiktokSettings(saved)
    return { instagram: ig.instagramEnabled ? ig : null, tiktok: tt.tiktokEnabled ? tt : null }
  }
  // test runs never open the browser: e2e/social.spec.ts reads the link here and plays the person signing in
  const openSignin = (url: string) => {
    if (!TEST) return shell.openExternal(url)
    ;(globalThis as { __reelstudioOpened?: string }).__reelstudioOpened = url
    log('[signin] test run: browser not opened')
    return Promise.resolve()
  }
  const tiktok = new TikTokService({
    settings: async () => (await ownApps()).tiktok ?? tiktokFrom(await signin.get(), signin.baseUrl), settingsDir: settingsDir(), projectsDir,
    secrets: safeStorage, fetch: platformFetch, openExternal: openSignin
  })
  registerTikTokIpc({ handle, service: tiktok, dev: DEV_PROVIDERS && !TEST, saveSettings })
  app.on('before-quit', () => { tiktok.stop() })
  const instagram = new InstagramService({
    settings: async () => (await ownApps()).instagram ?? instagramFrom(await signin.get(), signin.baseUrl),
    settingsDir: settingsDir(),
    projectsDir,
    exportsDir: () => binDir('exports'),
    secrets: safeStorage,
    fetch: platformFetch,
    openExternal: openSignin,
    coverJpeg: (bytes) => {
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) throw new InstagramError('IG_COVER', 'The cover image could not be read. Export this version again.')
      // Meta requires JPEG. Quality 90 is unmeasured and still subject to the API's 8 MB limit.
      return image.toJPEG(90)
    }
  })
  registerInstagramIpc({
    handle,
    service: instagram,
    dev: DEV_PROVIDERS && !TEST,
    saveSettings,
    testSession: TEST && process.env.REELSTUDIO_TEST_INSTAGRAM ? testInstagramSession(process.env.REELSTUDIO_TEST_INSTAGRAM) : undefined
  })
  app.on('before-quit', () => { instagram.stop() })
  const facebook = new FacebookService({
    settings: async () => facebookFrom(await signin.get(), signin.baseUrl), settingsDir: settingsDir(), projectsDir,
    secrets: safeStorage, fetch: platformFetch, openExternal: openSignin
  })
  handle('facebook:session', () => facebook.session())
  handle('facebook:connect', () => facebook.connect())
  handle('facebook:cancelConnect', () => facebook.cancelConnect())
  handle('facebook:disconnect', () => facebook.disconnect())
  handle('facebook:choosePage', (_e, pageId) => facebook.choosePage(pageId))
  handle('facebook:publish', (_e, input) => facebook.publish(input))
  app.on('before-quit', () => { facebook.stop() })
  const threads = new ThreadsService({
    settings: async () => threadsFrom(await signin.get(), signin.baseUrl), settingsDir: settingsDir(), projectsDir,
    secrets: safeStorage, fetch: platformFetch, openExternal: openSignin
  })
  handle('threads:session', () => threads.session())
  handle('threads:connect', () => threads.connect())
  handle('threads:cancelConnect', () => threads.cancelConnect())
  handle('threads:disconnect', () => threads.disconnect())
  handle('threads:publish', (_e, input) => threads.publish(input))
  app.on('before-quit', () => { threads.stop() })
  const xPosting = new XService({
    settings: async () => xFrom(await signin.get(), signin.baseUrl), settingsDir: settingsDir(), projectsDir,
    secrets: safeStorage, fetch: platformFetch, openExternal: openSignin
  })
  handle('x:session', () => xPosting.session())
  handle('x:connect', () => xPosting.connect())
  handle('x:cancelConnect', () => xPosting.cancelConnect())
  handle('x:disconnect', () => xPosting.disconnect())
  handle('x:publish', (_e, input) => xPosting.publish(input))
  app.on('before-quit', () => { xPosting.stop() })
  const linkedin = new LinkedInService({
    settings: async () => linkedinFrom(await signin.get(), signin.baseUrl), settingsDir: settingsDir(), projectsDir,
    secrets: safeStorage, fetch: platformFetch, openExternal: openSignin
  })
  handle('linkedin:session', () => linkedin.session())
  handle('linkedin:connect', () => linkedin.connect())
  handle('linkedin:cancelConnect', () => linkedin.cancelConnect())
  handle('linkedin:disconnect', () => linkedin.disconnect())
  handle('linkedin:publish', (_e, input) => linkedin.publish(input))
  app.on('before-quit', () => { linkedin.stop() })
  registerSocialIpc({
    handle, directory: signin, instagram, tiktok, facebook, threads, x: xPosting, linkedin,
    own: async () => { const o = await ownApps(); return { instagram: !!o.instagram, tiktok: !!o.tiktok } }
  })
  // Facebook reads the Page posts go to; a reel on another of the person's Pages is read when that Page is chosen again.
  const sources: ResultsSource[] = TEST && process.env.REELSTUDIO_TEST_RESULTS
    ? testResultsSources(process.env.REELSTUDIO_TEST_RESULTS, projectsDir)
    : [
        { platform: 'instagram', account: async () => { const s = await instagram.session(); return s.connected ? s.accountId : null },
          read: (slug, version, postId) => instagram.insights(slug, version, postId), audience: () => instagram.audience() },
        { platform: 'tiktok', account: async () => { const s = await tiktok.session(); return s.connected ? s.accountId : null },
          read: (slug, version, postId) => tiktok.insights(slug, version, postId) },
        { platform: 'facebook', account: async () => { const s = await facebook.session(); return s.connected ? s.page.id : null },
          read: (slug, version, postId) => facebook.insights(slug, version, postId) }
      ]
  const results = new ResultsRefresh({
    projectsRoot: projectsDir, stateDir: settingsDir(), sources,
    // new post results may make a trial's memory worth suggesting (memory-loop.ts): look now, not only when My style opens
    changed: () => {
      broadcast('insights:changed', null)
      void refreshMemories(ai, projectsDir(), log)
    },
    // Post results go into usage data only when sharing and its Post results part are both on (usage.ts record)
    onRead: (post, outcome) => {
      const views = postViews(post, outcome)
      if (views) recordUsage(views)
    }
  })
  registerInsightsIpc({
    handle, projectsRoot: projectsDir, refresh: results,
    describe: async (slug, version) => {
      const project = await readProject(slug).catch(() => null)
      if (!project) return null
      const v = (await listVersions(projectDir(slug)).catch(() => [])).find((x) => x.n === version)
      return { title: project.title || slug, cover: v?.cover ?? null }
    }
  })
  // Test runs read only when the test asks (Refresh), so what they show doesn't depend on timing.
  if (!TEST) results.start()
  app.on('before-quit', () => { results.stop() })
  handle('app:info', () => appInfo())
  handle('app:setModels', async (_e, m: unknown) => {
    const ok = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !v.includes('\0')
    const x = (m ?? {}) as Record<string, unknown>
    if (!MODEL_ROLES.every((r) => ok(x[r]))) throw { code: 'BAD_INPUT', userMessage: 'Choose a model for each stage.' }
    await saveSettings({ models: Object.fromEntries(MODEL_ROLES.map((r) => [r, x[r] as string])) as ModelChoice })
    return appInfo()
  })
  handle('app:setSharing', async (_e, v: unknown) => {
    const x = (v ?? {}) as Record<string, unknown>
    const keys = ['asked', 'on', 'usage', 'quality', 'posts'] as const
    if (!keys.every((k) => typeof x[k] === 'boolean')) throw { code: 'BAD_INPUT', userMessage: 'Choose what to share.' }
    const sharing = Object.fromEntries(keys.map((k) => [k, x[k]])) as Record<(typeof keys)[number], boolean>
    // off deletes what was kept and a part switched off loses its lines; on starts from an empty folder (usage.ts)
    await usage.changeSharing(sharing, () => saveSettings({ sharing }))
    if (!sharing.on || !sharing.quality) scoredEdits.clear()
    return appInfo()
  })
  handle('app:usage', () => usage.read())
  handle('app:setPhoneView', async (_e, view: unknown) => {
    if (view !== 'instagram' && view !== 'clean') throw { code: 'BAD_INPUT', userMessage: 'Choose Instagram or Clean.' }
    await saveSettings({ phoneView: view })
    return appInfo()
  })
  handle('app:setTimeline', async (_e, shown: unknown) => {
    if (typeof shown !== 'boolean') throw { code: 'BAD_INPUT', userMessage: 'Choose whether to show the timeline.' }
    await setTimeline(shown)
    return appInfo()
  })
  handle('app:setSoundEffects', async (_e, on: unknown) => {
    if (typeof on !== 'boolean') throw { code: 'BAD_INPUT', userMessage: 'Choose whether to play sound effects.' }
    await saveSettings({ soundEffects: on })
    return appInfo()
  })
  handle('app:setFasterExports', async (_e, on: boolean) => {
    if (typeof on !== 'boolean') throw { code: 'BAD_INPUT', userMessage: 'Choose whether to make reels at 30 fps.' }
    await saveSettings({ fasterExports: on })
    return appInfo()
  })
  handle('app:setFirstRunAgain', async (_e, on: unknown) => {
    if (typeof on !== 'boolean') throw { code: 'BAD_INPUT', userMessage: 'Choose whether to show the first run again.' }
    await saveSettings({ firstRunAgain: on })
    return appInfo()
  })
  const engineCache = async (): Promise<EngineCache> => {
    const path = engineCacheDir()
    return { path, pathDisplay: rootDisplay(path), bytes: await engineCacheSize(path) }
  }
  handle('app:engineCache', engineCache)
  handle('app:clearEngineCache', async () => {
    if (jobs.runningCount()) throw { code: 'BUSY', userMessage: 'Wait until no reel is being made, then clear the cache.' }
    await clearEngineCache(engineCacheDir())
    return engineCache()
  })
  handle('app:showLogs', async () => {
    await fs.mkdir(logsDir(), { recursive: true })
    const failed = await shell.openPath(logsDir())
    if (failed) throw { code: 'OPEN_FAILED', userMessage: `Couldn't open the logs folder: ${failed}` }
  })
  handle('app:clipboardFiles', () => clipboardFiles(TEST ? async () => testClipboard.items : undefined))
  handle('app:takeOpenFiles', async () => ((await firstRunShows()) ? [] : pendingOpenFiles.splice(0)))
  handle('app:finishFirstRun', async () => {
    // The first run never asks about the folder (ux-foundation-b.md section 4), so the library is made here.
    await ensureRoot().catch((e) => log(`[root] ${String(e)}`))
    perms.markTouched()
    const s = await loadSettings()
    // Notifications start off on a new Mac, so the first Version 1 asks for them (screens/Reel.tsx notifyAsk).
    const patch = PERM_PLATFORM === 'darwin' && s.notifications === null ? { notifications: false } : {}
    const next = await saveSettings({ firstRunDone: true, firstRunAgain: false, ...patch })
    firstRunAgainAtLaunch = false // a reset pressed later in this launch waits for the next one
    notificationsOn = notificationsWanted(next, PERM_PLATFORM)
  })
  handle('app:openFolder', async (_e, p: string) => {
    if (TEST) return
    const st = await fs.stat(p).catch(() => null)
    if (st?.isDirectory()) await shell.openPath(p)
    else shell.showItemInFolder(p)
  })
  handle('app:copyText', (_e, t: string) => clipboard.writeText(String(t)))
  handle('app:legal', (_e, doc: unknown) => fs.readFile(legalFile(doc), 'utf8'))
  handle('app:showLegal', (_e, doc: unknown) => {
    const file = legalFile(doc)
    if (!TEST) shell.showItemInFolder(file)
  })
  // The overlay follows two things at once: a modal's scrim (dimmed) and the full-screen stage (white symbols).
  const titleBar = { dimmed: false, onDark: false }
  const applyTitleBar = (): void => {
    if (process.platform !== 'darwin' && win && !win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay(titleBar.dimmed, titleBar.onDark))
  }
  handle('app:dimTitleBar', (_e, on: boolean) => {
    titleBar.dimmed = on === true
    applyTitleBar()
  })
  handle('app:titleBarOnStage', (_e, on: boolean) => {
    titleBar.onDark = on === true
    applyTitleBar()
  })
  ipcMain.on('app:startDrag', (e, file: string) => {
    try {
      assertIpcSender(e, win?.webContents, rendererUrl)
      validateIpcArgs('app:startDrag', [file])
      startDragOut(e.sender, file, [reelStudioRoot(), projectsDir()])
    } catch (err) {
      log(`[drag] ${String(err)}`)
    }
  })
  handle('app:chooseFolder', async () => {
    const r = await showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('app:setRoot', async (_e, p: string) => {
    refuseWhileRootMoves()
    if (jobs.writing()) throw { code: 'BUSY', userMessage: 'Wait until no reel is being made, then change where reels are kept.' }
    // Taken before the first await, so no job can start between this check and the new root being in use.
    rootMoving = true
    try {
      const root = chosenRoot(p, CHANNEL === 'nightly' ? await stableLibraries(app.getPath('appData')) : undefined)
      await fs.mkdir(root, { recursive: true })
      // indexing pauses while the Library moves, and starts again in the new place (footage-search-tool)
      await footageIndex.pause()
      try {
        await saveSettings({ root })
        setRootOverride(root)
        rootGeneration++
        await ensureRoot()
        perms.markTouched()
        indexLibrary()
      } finally {
        footageIndex.resume()
      }
    } finally {
      rootMoving = false
    }
    return appInfo()
  })

  handle('perm:status', () => perms.status())
  handle('perm:allowFolder', () => perms.allowFolder())
  handle('perm:openSettings', (_e, pane: unknown) => perms.openSettings(pane))
  handle('perm:setNotifications', async (_e, on: unknown) => {
    const st = await perms.setNotifications(on === true)
    notificationsOn = notificationsWanted(await loadSettings(), PERM_PLATFORM)
    return st
  })

  registerPhoneIpc({
    handle,
    roots: () => [reelStudioRoot(), projectsDir()],
    plan: async (slug) => {
      const st = await readAppState(slug)
      if (!st.plan) throw { code: 'NO_PLAN', userMessage: 'This reel has no plan to send yet.' }
      const title = await readProject(slug).then((p) => p.title).catch(() => st.title ?? 'My reel')
      return { title, plan: st.plan }
    },
    send: broadcast,
    log,
    test: TEST
  })
  // Settings > Phone and browser: a paired phone or browser watches versions and leaves notes (main/companion-ipc.ts). It reads
  // and notes through the same functions as the window's projects:get and projects:note.
  companion = registerCompanionIpc({
    handle,
    send: broadcast,
    dir: settingsDir(),
    secrets: safeStorage,
    staticDir: join(__dirname, '../renderer'),
    service: {
      list: () => listProjects(),
      get: (slug) => projectWithJob(slug),
      projectDir,
      note: (slug, text, attachments, moment, onVersion) => submitNote(slug, text, attachments, moment, onVersion),
      cancel: (id, slug) => noteQueue.stop(id, slug),
      timeline: (slug, n) => readTimeline(slug, n),
      editorConnected: async () => {
        const a = await ai.active().catch(() => null)
        return !!a && a.connected && a.id !== 'none'
      },
      appVersion: app.getVersion(),
      computer: computerName()
    },
    // The e2e runs the phone page in a browser on this computer, so it listens on loopback there.
    address: () => (TEST && process.env.REELSTUDIO_COMPANION_HOST ? process.env.REELSTUDIO_COMPANION_HOST : (lanAddresses()[0]?.address ?? null)),
    openExternal: (url) => shell.openExternal(url),
    log
  })
  // pictures, GIFs and clips on a note (main/attachments.ts)
  registerAttachmentIpc({
    handle,
    runEngine,
    log,
    projectDir,
    readProject,
    queue: (slug, fn, removing) => noteQueue.run(slug, fn, removing),
    reserve: (slug, fn) => jobs.hold(slug, fn),
    refuse: (slug) => jobs.refuseIfKeptClosed(slug),
    stagingDir: (slug) => noteStagingDir(projectDir(slug)),
    clipboardImage: async () => {
      // Electron's async clipboard: the first item that carries a picture, as bytes
      for (const item of await clipboard.read()) {
        const type = pickClipboardType(item.types)
        if (!type) continue
        const blob = await item.getType(type)
        if (blob instanceof Blob) return { mime: type, bytes: new Uint8Array(await blob.arrayBuffer()) }
      }
      return null
    },
    choose: async (filters) => {
      const r = await showOpenDialog({ title: 'Attach a picture or a clip', properties: ['openFile', 'multiSelections'], filters })
      return r.canceled ? null : r.filePaths
    }
  })

  handle('model:status', () => models.status())
  handle('model:download', async () => {
    const status = await models.download()
    if (status.installed) indexLibrary()
    return status
  })
  handle('model:find', () => models.find())
  handle('model:cancel', () => models.cancel())

  handle('ai:providers', () => ai.providers())
  handle('ai:active', () => ai.active())
  // Done or failed, every call that can change the AI editor announces it so the sidebar line follows at once.
  const changesAI = (channel: string, fn: Handler): void =>
    handle(channel, async (e, ...args) => {
      try {
        return await fn(e, ...args)
      } finally {
        ai.active().then((p) => broadcast('ai:change', p), () => {})
      }
    })
  changesAI('ai:setActive', (_e, id, connectionId?: string) => ai.setActive(id, typeof connectionId === 'string' ? connectionId : undefined))
  handle('ai:cancelCheck', () => ai.cancelCheck?.())
  changesAI('ai:setClaudeKey', (_e, key: string | null) => ai.setClaudeKey(key))
  // stock photo and footage keys (stock-search): saved by the AI package like the Claude key, never sent back
  handle('ai:stockProviders', () => ai.stockProviders())
  handle('ai:setStockKey', (_e, provider: 'pexels' | 'pixabay', key: string | null) => ai.setStockKey(provider, key))
  // The key goes from the page to the AI package once and never comes back.
  const text = (v: unknown): string => (typeof v === 'string' ? v : '')
  const connectionsNotReady = { code: 'NOT_READY', userMessage: 'Connecting your own AI server is not ready in this build yet. Your reels still work without it.' }
  handle('ai:connections', async () => (await ai.connections?.()) ?? [])
  changesAI('ai:saveConnection', async (_e, input: Record<string, unknown>) => {
    if (!ai.saveConnection) throw connectionsNotReady
    const kind = input?.kind === 'anthropic' ? 'anthropic' : 'openai'
    return ai.saveConnection({ ...(input?.id ? { id: text(input.id) } : {}), label: text(input?.label), kind, baseURL: text(input?.baseURL), model: text(input?.model), key: text(input?.key) })
  })
  changesAI('ai:removeConnection', async (_e, id: unknown) => {
    if (!ai.removeConnection) throw connectionsNotReady
    await ai.removeConnection(text(id))
  })
  handle('ai:setConnectionImages', async (_e, id: unknown, on: unknown) => {
    if (!ai.setConnectionImages) throw connectionsNotReady
    await ai.setConnectionImages(text(id), on === true)
  })
  handle('ai:connectionModels', async (_e, q: Record<string, unknown>) => {
    if (!ai.connectionModels) return { models: [], suggested: null, needsKey: false }
    const kind = q?.kind === 'anthropic' ? 'anthropic' : 'openai'
    return ai.connectionModels({ kind, baseURL: text(q?.baseURL), key: text(q?.key), ...(q?.id ? { id: text(q.id) } : {}) })
  })
  // The person's own Claude Code app: the page gets the state only; the sign-in happens in Anthropic's CLI.
  const claudeCode = async () => (await ai.claudeCodeStatus?.()) ?? { state: 'missing' as const }
  handle('ai:claudeCodeStatus', async () => publicInfo(await claudeCode()))
  handle('ai:checkEdits', async () => (await loadSettings()).checkEdits)
  handle('ai:lookUps', async () => (await loadSettings()).lookUps)
  handle('ai:setLookUps', async (_e, on: unknown) => {
    if (typeof on !== 'boolean') throw { code: 'BAD_INPUT', userMessage: 'That setting needs on or off.' }
    return (await saveSettings({ lookUps: on })).lookUps
  })
  handle('ai:setCheckEdits', async (_e, on: unknown) => {
    if (typeof on !== 'boolean') throw { code: 'BAD_INPUT', userMessage: 'That setting needs on or off.' }
    return (await saveSettings({ checkEdits: on })).checkEdits
  })
  // Settings › Editor › How notes run: Reel Studio's editor, or the editor in use's own app with Reel Studio's tools
  handle('ai:noteRunner', async () => (await ai.noteRunner?.()) ?? { runner: 'reelstudio', app: null })
  handle('ai:setNoteRunner', async (_e, runner: 'reelstudio' | 'app') => {
    if (!ai.setNoteRunner) throw { code: 'NOT_READY', userMessage: 'This editor runs notes only in Reel Studio.' }
    return ai.setNoteRunner(runner)
  })
  // Settings › Editor › Let other AI apps use Reel Studio
  handle('outside:status', () => outside!.status())
  handle('outside:setEnabled', async (_e, on: boolean) => {
    const st = on ? await outside!.enable() : await outside!.disable()
    await saveSettings({ outsideApps: st.on })
    return st
  })
  handle('outside:reset', () => outside!.reset())
  handle('ai:openClaudeSignIn', async () => {
    const st = await claudeCode()
    if (st.state === 'ready') return
    const open = aiSource === 'mock' ? async () => (ai.mockClaudeSignInOpened?.(), '') : (f: string) => shell.openPath(f)
    await openSignInWindow(st.bin, { dir: join(settingsDir(), 'claude-sign-in'), platform: process.platform, open })
  })
  // "Connect Claude" / "Connect ChatGPT" (vendor-connect.ts): the page gets VendorInfo only.
  const vendorOf = (v: unknown): Vendor => {
    if (v !== 'claude' && v !== 'chatgpt') throw { code: 'BAD_INPUT', userMessage: 'Unknown AI.' }
    return v
  }
  handle('ai:vendorStatus', (_e, v) => vendors.status(vendorOf(v)))
  handle('ai:vendorConnect', (_e, v) => vendors.connect(vendorOf(v)))
  handle('ai:vendorCancel', (_e, v) => vendors.cancel(vendorOf(v)))
  handle('ai:vendorSignInAgain', (_e, v) => void vendors.signInAgain(vendorOf(v)))
  handle('ai:vendorSignInWithCode', (_e, v) => vendors.signInWithCode(vendorOf(v)))
  handle('ai:vendorSignIn', (_e, v) => vendors.signIn(vendorOf(v)))
  // CLIProxyAPI on this computer (vendor-hub.ts). The key found in its config stays here until Use it; the page gets
  // the address, the model count and which file the key came from. Under test only REELSTUDIO_TEST_HUB_CONFIG is read,
  // so a test never talks to a real CLIProxyAPI on the developer's computer.
  let hubFound: HubDetection = { state: 'none' }
  const noHub = !ai.saveHub || (TEST && !process.env.REELSTUDIO_TEST_HUB_CONFIG)
  const hubDeps = { env: process.env, platform: process.platform, fetch: (u: string, i?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'error' }) => fetch(u, i) }
  handle('ai:hubStatus', async () => {
    if (noHub) return { state: 'none' }
    hubFound = await detectHub(hubDeps)
    const { key: _key, file: _file, ...found } = hubFound
    return found
  })
  changesAI('ai:hubUse', async (_e, typed: unknown) => {
    if (noHub) throw { code: 'NOT_FOUND', userMessage: 'CLIProxyAPI isn’t answering on this computer any more. Look again.' }
    // the config is read and checked again right here: the address the key goes to is this computer's, now
    const use = await confirmHub(hubDeps, hubFound, typeof typed === 'string' && typed.trim() ? typed.trim() : undefined)
    const r = await ai.saveHub!(use)
    if (!r.error) log(`[ai] connected CLIProxyAPI at ${use.origin} (key from ${use.keySource === 'typed' ? 'the person' : 'its config'})`)
    return r
  })
  handle('ai:setHubManagementKey', async (_e, key: unknown) => {
    if (!ai.setHubManagementKey) throw connectionsNotReady
    return ai.setHubManagementKey(typeof key === 'string' ? key : null)
  })
  handle('ai:editorModels', async () => (await ai.editorModels?.()) ?? [])
  handle('ai:autoModels', async () => (await ai.autoModels?.()) ?? {})
  handle('ai:editorAccounts', async () => (await ai.editorAccounts?.()) ?? { accounts: [] })
  handle('ai:test', async (_e, role: unknown) => {
    if (!ai.testConnection) throw { code: 'NOT_READY', userMessage: 'Testing the editor needs the AI package.' }
    const r = await ai.testConnection(undefined, (MODEL_ROLES as readonly unknown[]).includes(role) ? (role as ModelRole) : 'editor')
    return { reply: r.reply, ms: r.ms, ...(r.model ? { model: r.model } : {}), ...(r.limits ? { limits: r.limits } : {}), ...(r.note ? { note: r.note } : {}) }
  })

  handle('projects:list', () => listProjects())
  // Insights > Your recent reels (shared/wrapped.ts): the saved results of posted reels with each version's own timing.
  handle('wrapped:report', async () => {
    const summary = await insightsSummary(projectsDir(), { asOf: new Date().toISOString() })
    const reels: WrappedReel[] = []
    for (const r of summary.reels) {
      const title = (await readProject(r.project).catch(() => null))?.title || r.project
      const timeline = await readTimeline(r.project, r.version).catch(() => null)
      // the version a note would change: the newest saved one (a draft isn't one)
      const newest = Math.max(0, ...(await listVersions(projectDir(r.project)).catch(() => [])).filter((v) => !v.draft).map((v) => v.n))
      const later = newest > r.version ? await readTimeline(r.project, newest).catch(() => null) : null
      const m = r.totals.metrics
      reels.push({
        project: r.project, version: r.version, title, publishedAt: r.posts.map((p) => p.publishedAt).sort().at(-1) ?? '',
        plays: m.plays, averageWatchTimeMs: m.averageWatchTimeMs, shares: m.shares, saves: m.saves, timing: timeline ? timingOf(timeline) : null,
        ...(newest > r.version ? { latest: { version: newest, timing: later ? timingOf(later) : null } } : {})
      })
    }
    // Without enough results, the newest reels made here still have their own timing to look at.
    const made: WrappedReel[] = []
    for (const s of (await listProjects()).filter((p) => p.version > 0).sort((a, b) => (b.versionAt ?? '').localeCompare(a.versionAt ?? '')).slice(0, 3)) {
      const timeline = await readTimeline(s.slug, s.version).catch(() => null)
      made.push({ project: s.slug, version: s.version, title: s.title, publishedAt: '', plays: null, averageWatchTimeMs: null, shares: null, saves: null, timing: timeline ? timingOf(timeline) : null })
    }
    return wrappedReport(reels, Date.now(), made)
  })
  handle('projects:search', (_e, query: string) => searchProjects(query))
  handle('projects:get', (_e, slug: string) => projectWithJob(slug))
  async function projectWithJob(slug: string): Promise<ProjectDetail> {
    const d = await detail(slug)
    const running = jobs.forSlug(slug)
    d.job = running
      ? { id: running.id, kind: running.kind, message: jobs.message(running), pct: running.pct, overall: running.overall, secondsLeft: running.secondsLeft, overdue: running.overdue, thinking: running.thinking, waiting: running.waiting, waitingForRender: running.waitingForRender, steps: running.steps }
      : null
    if (!running && d.status === 'working') d.status = 'interrupted'
    return d
  }
  /** The videos among dropped or picked files; anything else goes to the Library. Throws when there is no video. */
  const takeVideos = async (files: string[]): Promise<{ videos: string[]; skipped: DropResult[] }> => {
    const videos = files.filter(isVideo)
    const others = files.filter((f) => !isVideo(f))
    const skipped: DropResult[] = others.length ? await addToLibrary(others, runEngine, log, indexLibrary) : []
    if (!videos.length) {
      const sorted = skipped.filter((s) => s.bin)
      throw {
        code: 'NO_VIDEO',
        userMessage: sorted.length
          ? 'That was not a video, so it went to your Library. Drop a video file (like .mp4 or .mov) to make a reel.'
          : 'Drop a video file (like .mp4 or .mov) to make a reel.'
      }
    }
    for (const v of videos) {
      if (!(await fs.stat(v).catch(() => null))?.isFile()) {
        throw { code: 'NOT_FOUND', userMessage: `Reel Studio could not open "${basename(v)}". Check that the file is still there and try again.` }
      }
    }
    await ensureRoot()
    return { videos, skipped }
  }
  handle('projects:create', async (_e, files: string[]) => {
    const { videos, skipped } = await takeVideos(files)
    const title = titleFromFile(videos[0])
    const slug = await uniqueSlug(title)
    await fs.mkdir(projectDir(slug), { recursive: true })
    await updateAppState(slug, (s) => {
      s.status = 'working'
      s.title = title
      s.fileTitle = title
    })
    const jobId = startFirstEdit(slug, { title, files: videos })
    return { slug, jobId, skipped }
  })
  const running = (slug: string): boolean => !!jobs.forSlug(slug)
  handle('projects:plan', async () => ({ slug: await planReel(running) }))
  // Leaving a New reel nobody touched removes it (store.ts isUntouchedPlanned).
  handle('projects:leave', async (_e, slug: string) => void (await discardIfUntouched(slug, running)))
  handle('projects:addVideo', async (_e, slug: string, files: string[]) => {
    const st = await readAppState(slug)
    // Version 1 failed and made nothing (a file with no sound, one that isn't a video): another video starts it again.
    // A reel cut from another reel's video can't change its video.
    const again = !st.from && !jobs.forSlug(slug) && (await reelSummary(slug))?.status === 'failed' && !(await listVersions(projectDir(slug))).length
    if (st.status !== 'planned' && !again) throw { code: 'HAS_VIDEO', userMessage: 'This reel already has its video. Drop it on Reels to make a new reel.' }
    // refused before anything is written or moved: not the title, and not the other files into the Library
    if (jobs.forSlug(slug)?.kind === 'script') throw { code: 'BUSY', userMessage: 'Your editor is still answering. Drop the video again in a moment, or press Stop.' }
    jobs.refuseIfBusy(slug)
    const { videos, skipped } = await takeVideos(files)
    const fromFile = titleFromFile(videos[0])
    let title: string
    if (again) {
      // read before the copy goes: a rename made once project.json existed is written there, not in app.json
      const current = (await reelSummary(slug))?.title ?? st.title ?? fromFile
      title = titleWithAnotherVideo(current, st.fileTitle, fromFile)
      await clearFailedCopy(projectDir(slug))
    } else title = st.title && st.title !== PLANNED_TITLE ? st.title : fromFile
    // the title is written with the first edit's start, so a start refused in the meantime leaves the reel as it was
    const named = (s: AppState): void => {
      s.title = title
      if (title === fromFile) s.fileTitle = title
    }
    return { jobId: startFirstEdit(slug, { title, files: videos }, false, named), skipped }
  })
  // A turn of a planned reel's planning chat: the editor asks a short question or proposes the whole plan, which
  // becomes the reel's plan (shared/plan.ts). The plan's title names the reel, unless the person named it.
  handle('projects:planSay', async (_e, slug: string, text: string) => {
    const words = String(text ?? '').trim()
    if (!words) throw { code: 'EMPTY', userMessage: 'Say what the reel is about in a sentence or two first.' }
    if ((await readAppState(slug)).status !== 'planned') throw { code: 'HAS_VIDEO', userMessage: 'This reel has its video now. Leave a note for your editor instead.' }
    const active = await ai.active().catch(() => null)
    if (!active?.connected || active.id === 'none') throw { code: 'NO_AI', userMessage: 'Connect an editor to plan a reel together.' }
    let jobId = ''
    jobId = jobs.start(
      slug,
      'script',
      async (emit, signal) => {
        const st = await readAppState(slug)
        const { turns, asked } = planTurns(st.chat)
        const plan = st.plan ? { hooks: st.plan.hooks, hook: st.plan.hook, beats: st.plan.beats.map((b) => b.text), shots: st.plan.shots.map((x) => x.text) } : null
        const r = await ai.planTurn({ turns, asked, plan }, emit, signal)
        if (r.kind === 'question') return { summary: r.text, chat: [planReply(r)] }
        const next = planFromEditor(st.plan?.topic || turns.find((t) => t.from === 'you')?.text || words, r)
        const title = r.title?.trim().slice(0, 80)
        await updateAppState(slug, (s) => {
          s.plan = next
          if (title && s.title === PLANNED_TITLE) s.title = title
        })
        return { summary: r.say, chat: [planReply(r)] }
      },
      { record: (s) => void s.chat.push(stamp({ from: 'you', text: words, plan: true, jobId })) }
    )
    return { jobId }
  })
  // An edited line, the picked hook or a ticked line in the Plan card, or the plain form's plan when no editor is
  // connected. The form names a New reel after what it's about.
  handle('projects:setPlan', async (_e, slug: string, plan: unknown) => {
    const next = checkPlan(plan)
    if (!existsSync(join(projectDir(slug), 'app.json'))) throw { code: 'NOT_FOUND', userMessage: 'That reel could not be found. It may have been moved or deleted.' }
    if (jobs.forSlug(slug)?.kind === 'script') throw { code: 'BUSY', userMessage: 'Your editor is changing the plan. Wait for the answer, or press Stop.' }
    await updateAppState(slug, (s) => {
      s.plan = next
      if (s.status === 'planned' && s.title === PLANNED_TITLE && next.topic) s.title = titleFromTopic(next.topic)
    })
  })
  handle('projects:resume', async (_e, slug: string, basic?: boolean) => {
    const dir = projectDir(slug)
    // stopped during the copy: Resume copies the video again from the file the person dropped, if it still opens
    // (startFirstEdit). The card never offers Resume otherwise (store.ts copyGone); this is for a file gone since.
    const st = await readAppState(slug)
    if (!existsSync(join(dir, 'project.json')) && !st.from && !(await canCopyAgain(st.copyFrom))) throw COPY_GONE
    // the person's Resume: nothing waits to continue it on its own any more
    pauser.cancel(slug)
    return { jobId: startFirstEdit(slug, null, basic === true) }
  })
  handle('projects:note', (_e, slug: string, text: string, attachments?: unknown, at?: unknown, onVersion?: unknown, requestedBase?: unknown, steer?: unknown) =>
    sendNote(slug, text, attachments, at, onVersion, requestedBase, steer)
  )
  // The note path for a paired phone (main/companion): sendNote, as the window and an outside AI app send. The phone
  // sends no `steer` (Add now), so its notes always queue.
  function submitNote(slug: string, text: string, attachments?: unknown, at?: unknown, onVersion?: unknown): ReturnType<typeof sendNote> {
    return sendNote(slug, text, attachments, at, onVersion)
  }
  // version-merge: one version's layers with another's, as a job of its own (it is not a note, so it does not queue)
  handle('projects:mergeVersions', (_e, slug: string, request: MergeRequest) => {
    const dir = projectDir(slug)
    if (!ai.mergeVersions) throw { code: 'MERGE_UNAVAILABLE', userMessage: 'This editor does not support combining versions. Update Reel Studio and try again.' }
    if (!request || typeof request !== 'object' || !request.take || typeof request.take !== 'object') throw { code: 'BAD_MERGE', userMessage: 'Choose which version each part comes from.' }
    const merge = ai.mergeVersions.bind(ai)
    // the notes show it as what was asked, with the version it made as its result
    const asked = mergeWords(request)
    let jobId = ''
    jobId = jobs.start(
      slug,
      'note',
      async (emit, signal, { id, owner }) => {
        const r = await merge(dir, request, emit, signal, { id, ...(owner ? { owner } : {}) })
        return { summary: [r.summary, ...r.report].join(' '), ...(r.version !== undefined ? { version: r.version } : {}), made: { by: 'note', summary: asked } }
      },
      { note: asked, record: (s) => void s.chat.push(stamp({ from: 'you', text: asked, jobId })) }
    )
    return { jobId }
  })
  handle('projects:mergeLayers', async (_e, slug: string, ours: number, theirs: number) => {
    const saved = (await readProject(slug)).version ?? 0
    for (const n of [ours, theirs]) if (!Number.isInteger(n) || n < 1 || n > saved) throw { code: 'BAD_VERSION', userMessage: 'Pick two saved versions of this reel.' }
    // an older AI package: every part is a choice
    return ai.mergeLayers ? ai.mergeLayers(projectDir(slug), ours, theirs) : [...MERGE_LAYERS]
  })
  handle('projects:versionRows', async (_e, slug: string, n: number) => {
    if (!Number.isInteger(n) || n < 1) throw { code: 'BAD_VERSION', userMessage: 'Pick a version of this reel first.' }
    return readVersionRows(slug, n)
  })
  handle('projects:timeline', async (_e, slug: string, n: number) => {
    if (!Number.isInteger(n) || n < 0) throw { code: 'BAD_VERSION', userMessage: 'Pick a version of this reel first.' }
    return readTimeline(slug, n)
  })
  handle('projects:setSeries', async (_e, slug: string, series: string | null) => {
    if (!existsSync(join(projectDir(slug), 'project.json'))) throw { code: 'NO_VIDEO', userMessage: 'Add a video to this reel first.' }
    // as a manual edit (projects:update): an Edit it myself job publishes the project it read before its render,
    // so a series picked meanwhile would be written over while app.json still says it was chosen. Refused (BUSY,
    // which the picker shows) while a job runs, and no job starts during this write.
    await jobs.hold(slug, () => chooseSeries(slug, series))
    return detail(slug)
  })
  handle('projects:update', async (_e, slug: string, patch: Partial<ProjectJson>) => {
    // a reel with no video yet has no project.json: only its name can change
    if (!existsSync(join(projectDir(slug), 'project.json'))) {
      const title = typeof patch?.title === 'string' ? patch.title.trim().slice(0, 120) : ''
      if (title) await updateAppState(slug, (s) => void (s.title = title))
      return detail(slug)
    }
    return jobs.hold(slug, async () => {
      const p = await readProject(slug)
      // a cut with clips from other sources (multi-source) is the AI's to change, not Edit it myself's word list
      if (patch?.cut !== undefined) assertWordCutEditable(p.cut?.keep)
      for (const k of Object.keys(patch ?? {}) as (keyof ProjectJson)[]) {
        // the "Flip picture" toggle: only each take's mirror flag, never its path or size
        if (k === 'sources') {
          p.sources = mergeSourcesPatch(p.sources, patch.sources)
          continue
        }
        if (!EDITABLE.includes(k)) continue
        ;(p as any)[k] = (patch as any)[k]
      }
      await writeProject(slug, p)
      return detail(slug)
    })
  })
  handle('projects:handEdit', async (_e, slug: string, edit: unknown, summary: string, changes: number, replace?: string) => {
    const hand = { edit: parseHandEdit(edit), changes: Math.max(1, Math.round(changes)) }
    const seen = (await readProject(slug)).version ?? 0
    return noteQueue.sendHand(slug, hand, String(summary).slice(0, 200), seen, replace)
  })
  handle('projects:export', async (_e, slug: string, n: number) => {
    updates.assertCanStartWork()
    exportsWriting++ // the updater will not restart the app while an export writes its file
    try {
      const done = await exportVersion(slug, n)
      // exporting the newest version keeps the edit that made it
      const latest = (await readProject(slug)).version ?? 0
      if (n === latest) scoreEdit(slug, n, { type: 'export' })
      return done
    } catch (e) {
      const code = e && typeof e === 'object' && 'code' in e ? String(e.code) : ''
      if (code === 'ENOSPC') throw { code: 'NO_SPACE', userMessage: `There isn't enough space on this ${process.platform === 'darwin' ? 'Mac' : 'PC'}. Free some up, then try again.` }
      if (code === 'EACCES' || code === 'EPERM') throw { code: 'NO_ACCESS', userMessage: "Reel Studio isn't allowed to write to its Library folder. Check the folder in Settings, then try again." }
      throw e
    } finally {
      exportsWriting--
    }
  })
  // a job like any other, so the updater waits for it (main/updater.ts counts running jobs)
  handle('projects:exportPlatforms', async (_e, slug: string, n: number, value: unknown) => {
    const request = parsePlatformExportRequest(value)
    const generation = rootGeneration
    const versions = await listVersions(projectDir(slug))
    if (![n, request.second?.version ?? n].every((m) => versions.some((v) => v.n === m))) throw { code: 'NO_VERSION', userMessage: 'Choose an available version before sharing.' }
    const version = await finishedExportVersion(slug, n)
    const project = await readProject(slug)
    const exportTry = (v: VersionInfo, platforms: Platform[], { caption, coverSeconds, brightness }: Pick<PlatformTry, 'caption' | 'coverSeconds' | 'brightness'>): ExportTry => {
      const chosenCover = join(dirname(v.videoPath), 'cover.png')
      return { version: v.n, source: v.videoPath, chosenCover: existsSync(chosenCover) ? chosenCover : null,
        name: `${safeFileName(project.title || slug)} - Version ${v.n}`, platforms, caption, coverSeconds, ...(brightness ? { brightness } : {}) }
    }
    const first = exportTry(version, request.platforms, request)
    const { second } = request
    const secondVersion = second && (second.version === n ? version : await finishedExportVersion(slug, second.version))
    const tries: [ExportTry] | [ExportTry, ExportTry] = second && secondVersion
      ? [first, exportTry(secondVersion, secondTryPlatforms(request.platforms, sameVideo(first, second)), second)]
      : [first]
    let result: PlatformExportResult | null = null
    let failure: unknown
    // the versions and project above were read before several awaits: a library move since then makes them stale
    sameRootSince(generation)
    jobs.start(slug, 'export', async (emit, signal) => {
      emit({ type: 'status', message: 'Reading the finished video', pct: 1 })
      try {
        result = await exportPlatforms({
          tries, folder: binDir('exports'), runEngine, signal, onProgress: (message, pct) => emit({ type: 'status', message, pct })
        })
        return { summary: '', chat: [] }
      } catch (e) { failure = e; throw e }
    })
    await jobs.forSlug(slug)?.done
    if (failure) throw failure
    if (!result) throw { code: 'EXPORT_FAILED', userMessage: 'Saving for those platforms stopped. Try again.' }
    // sharing the newest version keeps the edit that made it, as exporting it does (projects:export)
    if (n === (project.version ?? 0)) scoreEdit(slug, n, { type: 'export' })
    return result
  })
  handle('projects:coverCandidates', async (_e, slug: string, moments: number[], source: string): Promise<CoverCandidate[]> => {
    const at = moments.filter((t) => Number.isFinite(t) && t >= 0).slice(0, COVER_SUGGESTIONS)
    if (!at.length) return []
    const owner = coverScanOwner(jobs, slug)
    const r = await coverScans.scan(slug, owned(['--project', projectDir(slug), '--at', at.join(','), '--source', source], owner))
    return parseCoverCandidates(r, source, projectDir(slug))
  })
  handle('projects:stopCoverCandidates', (_e, slug: string) => coverScans.stop(slug))
  // How often each pace would change the picture of this reel, from the plan a render makes (engine pace-preview), for
  // the edit drawer's Pace: shown before the version is made, so the choice isn't blind.
  handle('projects:pacePreview', async (_e, slug: string): Promise<PacePreview> => {
    const owner = coverScanOwner(jobs, slug)
    const r: any = await runEngine('pace-preview', owned(['--project', projectDir(slug)], owner))
    const paces: PacePreview['paces'] = {}
    for (const [k, v] of Object.entries((r?.paces ?? {}) as Record<string, any>)) {
      if (Number.isFinite(v?.perMinute) && Number.isInteger(v?.opening) && Number.isInteger(v?.openingMax)) paces[k] = { perMinute: v.perMinute, opening: v.opening, openingMax: v.openingMax }
    }
    return { paces }
  })
  // Whether the cut into each range lines up as a match cut (engine match-joins; engine/reelengine/match.py), for the
  // edit drawer's Transitions. `keep`: the cut as the drawer has it, checked before it becomes a version.
  handle('projects:matchJoins', async (_e, slug: string, keep: unknown): Promise<MatchVerdict[]> => {
    if (!Array.isArray(keep) || keep.length > 2000) throw { code: 'BAD_CUT', userMessage: 'That cut could not be checked. Try again.' }
    const owner = coverScanOwner(jobs, slug)
    const r: any = await runEngine('match-joins', owned(['--project', projectDir(slug), '--keep', JSON.stringify(keep)], owner))
    return Array.isArray(r?.joins) ? r.joins.filter((j: any) => Number.isInteger(j?.keep) && typeof j?.matched === 'boolean')
      .map((j: any) => ({ keep: j.keep, matched: j.matched, ...(typeof j.why === 'string' ? { why: j.why } : {}) })) : []
  })

  // More reels from this video (main/propose-reels.ts)
  const reelsDeps = (): ReelsDeps => ({ jobs, ai, startFirstEdit: (slug, init) => startFirstEdit(slug, init) })
  handle('projects:proposeReels', (_e, slug: string) => startProposal(reelsDeps(), slug))
  handle('projects:makeReels', (_e, slug: string, ids: string[]) => makeReels(reelsDeps(), slug, ids))
  handle('projects:foldReels', (_e, slug: string, folded: boolean) => foldProposal(slug, folded))

  handle('projects:proposeTry', async (_e, slug: string, n: number, ask: { caption: string; variable?: TryVariable }) => {
    const timeline = await readTimeline(slug, n)
    if (!timeline) throw { code: 'NO_VERSION', userMessage: 'Choose an available version before sharing.' }
    // the cover of the version on screen: its own snapshot, or the project for a preview
    const snapshot = n > 0 ? await readJson<ProjectJson | null>(join(projectDir(slug), 'versions', `v${n}`, 'project.json'), null) : null
    const { cover } = snapshot ?? (await readProject(slug))
    return proposeTry({ ai, caption: ask.caption, variable: ask.variable, timeline, cover: cover ?? null, log })
  })
  handle('projects:remove', async (_e, slug: string) => {
    removing.add(slug)
    pauser.cancel(slug)
    try {
      await coverScans.stop(slug)
      await noteQueue.remove(slug, async () => {
        // after the reel's jobs have ended, so none can start a build behind this; a build that won't stop refuses
        await proxies.stop(slug)
        await fs.rm(noteStagingDir(projectDir(slug)), { recursive: true, force: true })
        // A cancelled engine's FFmpeg can hold its files for a moment after the cancel returns, and
        // Windows refuses to delete an open file (EBUSY/EPERM): retry for a few seconds.
        await fs.rm(projectDir(slug), { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
      })
    } finally {
      removing.delete(slug)
    }
  })

  handle('jobs:cancel', (_e, id: string, slug?: string) => noteQueue.stop(String(id), typeof slug === 'string' ? slug : undefined))
  handle('queue:edit', (_e, slug: string, id: string, text: string) => noteQueue.edit(slug, String(id), String(text ?? '')))
  handle('queue:cancel', (_e, slug: string, id: string) => noteQueue.cancel(slug, String(id)))
  handle('queue:move', (_e, slug: string, id: string, by: number) => noteQueue.move(slug, String(id), by < 0 ? -1 : 1))
  handle('queue:steer', (_e, slug: string, id: string) => noteQueue.steer(slug, String(id)))
  // Send now / Run next: a held queue goes on, and a paused job's wait ends (main/pause.ts)
  handle('queue:runNext', async (_e, slug: string) => {
    pauser.cancel(slug)
    await updateAppState(slug, (s) => void delete s.paused)
    await noteQueue.resume(slug)
  })
  handle('queue:clear', (_e, slug: string) => noteQueue.clear(slug))

  handle('library:list', async () => {
    await ensureRoot()
    return listLibrary()
  })
  handle('library:add', async (_e, paths: string[]) => {
    await ensureRoot()
    return addToLibrary(paths, runEngine, log, indexLibrary)
  })
  handle('library:choose', async (_e, kind: 'music' | 'images') => {
    const filters =
      kind === 'music'
        ? [{ name: 'Songs', extensions: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg'] }]
        : [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'] }]
    const r = await showOpenDialog({
      title: kind === 'music' ? 'Pick a song' : 'Pick pictures',
      properties: ['openFile', 'multiSelections'],
      filters
    })
    if (r.canceled || !r.filePaths.length) return []
    await ensureRoot()
    return addToLibrary(r.filePaths, runEngine, log, indexLibrary)
  })

  handle('library:preview', (_e, file: string) => libraryPreview(file))

  handle('footage:sources', () => footageSources.list())
  handle('footage:addSource', async () => {
    const r = await showOpenDialog({ title: 'Choose a folder of your videos', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths.length) return footageSources.list()
    return footageSources.add(r.filePaths[0])
  })
  handle('footage:removeSource', (_e, id: string) => footageSources.remove(id))
  handle('footage:status', () => footageIndex.status())
  handle('footage:findReels', () => archiveReels.find())
  handle('footage:reels', () => archiveReels.status())
  handle('footage:makeReels', (_e, ids: string[]) => archiveReels.make(ids))

  // Rules removed in this run of the app, for Undo; never written anywhere
  const removedRules = new Map<string, { rule: StyleRule; index: number }>()

  handle('style:rules', () => ai.styleRules())
  handle('style:add', (_e, text: string) => {
    if (!ai.addStyleRule) throw { code: 'NOT_READY', userMessage: 'That could not be saved to My style. Try again later.' }
    if (!text.trim()) throw { code: 'EMPTY', userMessage: 'Type the rule first.' }
    return ai.addStyleRule(text, { byYou: true })
  })
  handle('style:remove', async (_e, id: string) => {
    const gone = await ai.removeStyleRule(id)
    if (gone) removedRules.set(id, gone)
  })
  handle('style:restore', async (_e, id: string) => {
    const gone = removedRules.get(id)
    if (!gone || !ai.restoreStyleRule) throw { code: 'NOT_FOUND', userMessage: 'That rule can no longer be brought back. Add it again.' }
    await ai.restoreStyleRule(gone.rule, gone.index)
    removedRules.delete(id)
  })
  // What style:find last found, with the paths the page never sees
  let pastEdits: Found[] = []
  const findDeps = (): FindDeps =>
    TEST
      ? // tests never look at the machine's own files: a folder of fixtures stands in for the home folder
        {
          platform: process.platform,
          home: process.env.REELSTUDIO_TEST_PAST_EDITS_HOME ?? join(app.getPath('userData'), 'no-home'),
          spotlight: null,
          // smaller limits, so a test can reach one (JSON, e.g. {"walk":3})
          limits: process.env.REELSTUDIO_TEST_PAST_EDITS_LIMITS ? JSON.parse(process.env.REELSTUDIO_TEST_PAST_EDITS_LIMITS) : undefined
        }
      : { platform: process.platform, home: app.getPath('home'), spotlight: process.platform === 'darwin' ? mdfind : null }
  const foundEdit = (id: string): Found => {
    const f = pastEdits.find((x) => x.id === id)
    if (!f) throw { code: 'NOT_FOUND', userMessage: 'That edit is no longer where it was found. Close this and look again.' }
    return f
  }
  handle('style:find', async () => {
    const look = await findPastEdits(findDeps())
    pastEdits = look.edits
    return { edits: pastEdits.map(({ path: _path, ...edit }) => edit), cut: look.cut }
  })
  handle('style:count', async () => {
    const readable = pastEdits.filter((f) => f.readable)
    if (!readable.length) return {}
    return countsOf(readable, await runEngine('reference-scan', readable.map((f) => f.path)))
  })
  // the editors' own icons, looked up once a session; tests see only the apps in REELSTUDIO_TEST_APPS_DIR
  let editorIcons: ReturnType<typeof appIcons> | null = null
  const iconDeps = (): IconDeps => ({
    platform: process.platform,
    spotlight: TEST || process.platform !== 'darwin' ? null : async (q) => (await mdfind(q, 20))?.paths ?? null,
    registry: TEST || process.platform !== 'win32' ? null : regDefault,
    appFolders: TEST
      ? [process.env.REELSTUDIO_TEST_APPS_DIR].filter((d): d is string => !!d)
      : process.platform === 'darwin'
        ? ['/Applications', join(app.getPath('home'), 'Applications')]
        : [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((d): d is string => !!d),
    fileIcon: async (p) => {
      const icon = await app.getFileIcon(p, { size: 'normal' })
      return icon.isEmpty() ? null : icon.toDataURL()
    }
  })
  handle('style:appIcons', () => (editorIcons ??= appIcons(iconDeps())))
  handle('style:reveal', (_e, id: string) => {
    const f = foundEdit(id)
    if (TEST) log(`[style] reveal ${f.file}`)
    else shell.showItemInFolder(f.path)
  })
  handle('style:learn', async (e, ids?: string[]) => {
    let files: string[]
    if (ids) {
      files = ids.map((id) => foundEdit(id)).filter((f) => f.readable).map((f) => f.path)
      if (!files.length) throw { code: 'NOT_READABLE', userMessage: 'Choose an export or a CapCut project to learn from.' }
    } else {
      const mac = process.platform === 'darwin'
      const picker = learnPicker(mac)
      const r = await showOpenDialog({
        title: picker.title,
        // a .fcpxmld is a folder unless Final Cut Pro is installed to make it a package, and a CapCut project is a
        // folder; on Windows the person picks the draft_content.json inside it
        properties: mac ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
        filters: [{ name: picker.filter, extensions: ['fcpxml', 'fcpxmld', 'xml', 'edl', 'json'] }]
      })
      if (r.canceled || !r.filePaths.length) return null
      files = r.filePaths
    }
    return readLesson(files, (file) => runEngine('import-reference', [file]), (p) => e.sender.send('style:learnProgress', p))
  })
  handle('style:keepLearned', async (_e, rules: LearnedRule[], from: string, editor?: EditorName) => {
    if (!ai.addStyleRule) throw { code: 'NOT_READY', userMessage: 'That could not be saved to My style. Try again later.' }
    const kept: StyleRule[] = []
    for (const rule of rules) kept.push(await ai.addStyleRule(rule.text, { imported: { file: from, ...(editor ? { editor } : {}) } }))
    return kept
  })
  handle('style:damaged', async () => (await ai.styleWasDamaged?.()) ?? false)
  // a version's edit checks (engine score.py): read-only, so it needs no job and never waits behind one
  handle('projects:score', async (_e, slug: string, version: unknown) => {
    if (!Number.isSafeInteger(version) || (version as number) < 1) throw { code: 'BAD_ARGS', userMessage: 'That version is not saved.' }
    return runEngine('score', ['--project', projectDir(slug), '--version', String(version)])
  })
  // the learning loop (memory-loop.ts): looks again each time My style opens
  handle('style:suggestions', async () => {
    await refreshMemories(ai, projectsDir(), log)
    return (await ai.memoryProposals?.().catch(() => [])) ?? []
  })
  handle('style:keepSuggestion', async (_e, id: string, text?: unknown) => {
    if (!ai.acceptMemory) throw { code: 'NOT_READY', userMessage: 'That could not be saved to My style. Try again later.' }
    if (text !== undefined && (typeof text !== 'string' || !text.trim())) throw { code: 'EMPTY', userMessage: 'Type the rule first, or press No thanks.' }
    const rule = await ai.acceptMemory(id, text)
    if (!rule) throw { code: 'NOT_FOUND', userMessage: 'That suggestion is not in My style any more.' }
    return rule
  })
  handle('style:dismissSuggestion', async (_e, id: string) => {
    if (!ai.dismissMemory) throw { code: 'NOT_READY', userMessage: 'That could not be changed in My style. Try again later.' }
    await ai.dismissMemory(id)
  })
  handle('style:update', (_e, id: string, patch: { text?: unknown; paused?: unknown }) => {
    if (!ai.updateStyleRule) throw { code: 'NOT_READY', userMessage: 'That could not be changed in My style. Try again later.' }
    const text = typeof patch?.text === 'string' ? patch.text : undefined
    if (text !== undefined && !text.trim()) throw { code: 'EMPTY', userMessage: 'Type the rule first, or press Forget.' }
    return ai.updateStyleRule(id, { text, paused: typeof patch?.paused === 'boolean' ? patch.paused : undefined })
  })
  handle('style:answer', (_e, slug: string, messageId: string, yes: boolean) =>
    answerStyleQuestion(
      {
        chat: async (s) => (await readAppState(s)).chat,
        title: async (s) => (await readProject(s).catch(() => null))?.title || s,
        addStyleRule: ai.addStyleRule?.bind(ai),
        approveStyleProposal: ai.approveStyleProposal?.bind(ai),
        declineStyleProposal: ai.declineStyleProposal?.bind(ai),
        // one write: a crash can never leave the question without its buttons and without the reply
        settle: async (s, id, reply) => {
          await updateAppState(s, (st) => {
            const x = st.chat.find((y) => y.id === id)
            if (x) delete x.actions
            st.chat.push({ id: randomUUID(), from: 'editor', text: reply, at: new Date().toISOString() })
          })
        },
        serialized
      },
      slug,
      messageId,
      !!yes
    )
  )

  handle('style:rememberLowercase', async (_e, slug: string) => {
    if (!ai.approveStyleProposal) throw { code: 'NOT_READY', userMessage: 'That could not be saved to My style. Try again later.' }
    const p = await readProject(slug)
    await ai.approveStyleProposal({
      id: randomUUID(),
      text: 'Use lowercase subtitles.',
      payload: { kind: 'caption-case', case: 'lower' },
      source: { project: p.id, title: p.title, version: p.version ?? 0 }
    })
  })
  handle('sfx:pack', async (): Promise<SoundEffect[]> => {
    const dir = sfxPackDir()
    const pack = await readJson<{ sounds?: { id: string; job: string; file: string; seconds: number; onsetMs: number }[] }>(join(dir, 'pack.json'), {})
    return (pack.sounds ?? []).map((x) => ({ id: x.id, kind: x.job, seconds: x.seconds, onsetMs: x.onsetMs, url: mediaUrl(join(dir, x.file)) }))
  })

  handle('update:state', () => updates.state())
  handle('update:check', () => updates.check('button'))
  handle('update:download', () => updates.download())
  handle('update:install', () => updates.install())
  handle('update:openRelease', () => updates.openRelease())
  handle('update:openAutoUpdatesPage', () => updates.openAutoUpdatesPage())
  handle('update:busy', updateBusy)
  handle('update:dismiss', (_e, version: unknown) => updates.dismiss(version))
  handle('update:setEnabled', (_e, on: unknown) => updates.setEnabled(on))
  handle('updateKey:status', () => updateKey.status())
  // Read here, not in the page: the page never needs the key, and main already has the clipboard.
  handle('updateKey:paste', async () => {
    // Electron 44's clipboard.readText() returns a promise: without the await, every paste is "not a link".
    const s = await updateKey.fromText(await clipboard.readText())
    if (!s) throw { code: 'NO_KEY', userMessage: 'That is not a Reel Studio download link. Copy the link from your receipt email, then click Paste again.' }
    return s
  })
  handle('updateKey:clear', () => updateKey.clear())
  // Posting to YouTube (main/posting.ts), on unless REELSTUDIO_POSTING=0. It signs in with the same download key.
  setupPosting({
    handle,
    env: process.env,
    settingsDir: settingsDir(),
    exportsDir: () => binDir('exports'),
    secrets: safeStorage,
    appVersion: app.getVersion(),
    getKey: () => updateKey.get(),
    // test runs never open the browser (e2e/posting.spec.ts plays the person clicking Allow)
    openExternal: (url) => (TEST ? Promise.resolve(log('[posting] test run: browser not opened')) : shell.openExternal(url)),
    send: broadcast,
    log
  })

  handle('dev:renderTestAnimation', (_e, outPath: string, fullSize?: boolean, template?: string, params?: Record<string, unknown>) => {
    if (!TEST && app.isPackaged) throw { code: 'NOT_ALLOWED', userMessage: 'Not available.' }
    if (template) return host.renderAnimation(template, params ?? {}, outPath)
    return host.renderAnimation(TEST_TEMPLATE, { text: 'Hi', duration: fullSize ? 2 : 1 }, outPath)
  })
}

/** "Connect Claude" / "Connect ChatGPT": real installers and sign-ins, or the mock's (REELSTUDIO_MOCK_CLAUDE / _CODEX). */
function createVendors(): VendorConnect {
  const status = async (v: Vendor): Promise<CliStatus> =>
    (v === 'claude' ? await ai.claudeCodeStatus?.() : await ai.codexStatus?.()) ?? { state: 'missing' }
  const mock = aiSource === 'mock' ? ai.mockVendor : undefined
  return createVendorConnect({
    status,
    login: (v, bin, signal, onDeviceCode) =>
      mock
        ? mock.login(v, signal, onDeviceCode)
        : runLogin({ vendor: v, bin, env: TEST_LOGIN_ENV ?? process.env, platform: process.platform, signal, systemRoot: process.env.SystemRoot, onDeviceCode }),
    // Choosing Claude first sends it one short message (ai setActive); Cancel stops that too. The sidebar's editor
    // line follows like every other change of editor (changesAI).
    select: async (v, signal) => {
      const stop = (): void => void ai.cancelCheck?.()
      signal.addEventListener('abort', stop, { once: true })
      try {
        await ai.setActive(v === 'claude' ? 'claude-cli' : 'codex-cli')
      } catch (e) {
        throw signal.aborted || v !== 'claude' ? e : { code: 'CHECK_FAILED', userMessage: claudeCheckWords(e, process.platform) }
      } finally {
        signal.removeEventListener('abort', stop)
        ai.active().then((p) => broadcast('ai:change', p), () => {})
      }
    },
    emit: (i) => broadcast('ai:vendor', i),
    log
  })
}

/** Old local-Claude-Code installs used Claude Code without a saved choice; keep it for them, once (ai-carryover.ts). */
async function carryOverClaudeCode(settings: { aiAutoPicked: boolean; aiCarriedOver: boolean }): Promise<void> {
  const decision = carryOverDecision({
    aiAutoPicked: settings.aiAutoPicked,
    carriedOver: settings.aiCarriedOver,
    choiceSaved: await aiChoiceSaved(join(settingsDir(), 'ai')),
    activeId: (await ai.active()).id,
    claudeCodeReady: settings.aiAutoPicked && !settings.aiCarriedOver ? (await ai.claudeCodeStatus?.())?.state === 'ready' : false
  })
  if (decision === 'nothing-to-do') {
    if (settings.aiAutoPicked && !settings.aiCarriedOver) await saveSettings({ aiCarriedOver: true })
    return
  }
  if (decision === 'not-ready-yet') return // try again next start: their Claude Code app may be signed out right now
  await ai.setActive('claude-cli')
  await saveSettings({ aiCarriedOver: true })
  log('[ai] kept Claude (your Claude Code app), which this install used before 0.1.2')
}

const permissionHelper = new MacPermissionHelper()
/** Test builds: the System Settings pages that would have opened. */
const paneLog: { opened: string[] } = { opened: [] }

async function openPane(pane: SettingsPane, help: { isGranted?: () => Promise<boolean>; onEnd?: () => void }): Promise<void> {
  const url = MAC_PANES[pane].url
  if (TEST) paneLog.opened.push(url)
  else await shell.openExternal(url)
  // A dev build runs as "Electron", which is the name System Settings lists; the helper would point at the wrong
  // row, so only the packaged app (and test builds, with no System Settings) shows it.
  if (!app.isPackaged && !TEST) return
  await permissionHelper
    .show(pane, {
      owner: win,
      preload: join(__dirname, '../preload/permission-helper.js'),
      icon: appIconPath(),
      instruction: helperInstruction(pane, rootDisplay(reelStudioRoot())),
      isGranted: help.isGranted,
      onEnd: help.onEnd,
      test: TEST
    })
    .catch((e) => log(`[permissions] helper: ${String(e)}`))
}

/** On macOS the first notification is what asks (Electron 44 requests authorization then). */
function showTestNotification(): Promise<NotifyResult> {
  if (TEST) return Promise.resolve('shown')
  return new Promise((resolve) => {
    const n = new Notification({ title: 'Notifications are on', body: 'Reel Studio tells you here when a version is ready.', silent: true })
    // The macOS question is still on screen: the checklist offers "Ask again".
    const t = setTimeout(() => resolve('pending'), 20_000)
    n.once('show', () => {
      clearTimeout(t)
      resolve('shown')
    })
    n.once('failed', (_e, error) => {
      clearTimeout(t)
      log(`[notify] ${error}`)
      resolve('failed')
    })
    n.show()
  })
}

/**
 * The one way the timeline setting changes, from the Reel screen's button or View › Show Timeline: saved, then the
 * menu's check and every window follow. Saves run one at a time (settings.ts), so a quick run of changes from both
 * places ends with all three on the last one.
 */
async function setTimeline(shown: boolean): Promise<void> {
  await saveSettings({ timeline: shown })
  showTimelineInMenu(shown)
  sendCommand({ type: 'timeline', shown })
}

// ---- window -------------------------------------------------------------------------------------
function createWindow(): BrowserWindow {
  const created = createMainWindow({ preload: join(__dirname, '../preload/index.js'), stateFile: windowStateFile(settingsDir()), test: TEST })
  win = windows.track(created)
  // View › Show Timeline: a check that could not be saved goes back
  const toggleTimeline = (shown: boolean): void =>
    void setTimeline(shown).catch((e) => {
      showTimelineInMenu(!shown)
      log(`[settings] timeline not saved: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`)
    })
  installMenu(sendCommand, DEV_PROVIDERS || !app.isPackaged, toggleTimeline, () =>
    // On Mac the menu outlives a closed window, so the window may be gone when this runs.
    void menuCheckForUpdates(updates, {
      focus: () => void showWindow(),
      show: (o) => dialog.showMessageBox(showWindow(), o)
    }).catch((e) => log(`[update] menu check failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`))
  )
  void loadSettings().then((s) => showTimelineInMenu(s.timeline), () => undefined)
  created.once('ready-to-show', () => {
    performance.mark(WINDOW_SHOWN) // app/perf times launch to here
    created.show()
  })
  // Stop flashing the taskbar once the person is back.
  created.on('focus', () => created.flashFrame(false))
  // The animation renderer keeps a hidden offscreen window; it must not keep the app alive.
  created.on('closed', () => {
    if (win === created) win = null
    void closeAnimationRenderer()
  })
  // Links open in the system browser; the app window never navigates away.
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The app is one page: it never navigates (review 30). Links go out through the handler above.
  created.webContents.on('will-navigate', (e) => e.preventDefault())
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void created.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void created.loadFile(join(__dirname, '../renderer/index.html'))
  return created
}

/** `--self-test [--out <file>]`: check the bundled python, ffmpeg and engine, write JSON, exit 0 (passed) or 1. */
async function selfTestAndQuit(): Promise<void> {
  app.dock?.hide()
  const t0 = Date.now()
  const userData = app.getPath('userData')
  const out = SELF_TEST.out ?? join(userData, 'selftest-result.json')
  const locations = { python: pythonExe(), ffmpeg: ffmpegPath(), ffprobe: ffprobePath(), engine: engineDir() }
  // The engine's encoder probe and caches would otherwise land in the person's Application Support / Caches.
  const isolated = join(userData, 'engine cache')
  const run = createEngineRunner({
    python: pythonExe,
    env: () => ({ ...engineEnv(), REELENGINE_CACHE: isolated, REELENGINE_CACHE_DIR: isolated, HF_HOME: join(userData, 'hf-cache') }),
    cwd: engineDir,
    log
  })
  let outcome: { ok: boolean; result?: SelfTestResult; error?: string }
  try {
    const result = await runSelfTest({
      locations,
      runEngine: run
    })
    outcome = { ok: result.ok, result }
  } catch (e) {
    outcome = { ok: false, error: e instanceof Error ? e.stack ?? e.message : String(e) }
  } finally {
    await killAllEngines()
  }
  const payload = {
    ...outcome,
    seconds: Math.round((Date.now() - t0) / 100) / 10,
    electron: process.versions.electron,
    version: app.getVersion(),
    channel: CHANNEL,
    // where this build keeps the shared speech models and a new library, for checking an install without opening it
    paths: { models: modelsDir(), defaultLibrary: defaultRoot() },
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    userData,
    locations
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(payload, null, 2))
  app.exit(payload.ok ? 0 : 1)
}

const pendingOpenFiles: string[] = []
function queueOpenFiles(files: string[]): void {
  pendingOpenFiles.push(...files)
  // Early open-file events wait, like key links, until IPC and the app's services are ready.
  if (!ready) return
  if (!win || win.isDestroyed()) {
    createWindow() // The new renderer drains pendingOpenFiles on mount.
  } else {
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send('app:filesAvailable')
  }
}
app.on('open-file', (event, path) => {
  event.preventDefault()
  queueOpenFiles([path])
})
if (process.platform === 'win32') queueOpenFiles(filesFromArgv(process.argv, process.cwd(), !!process.defaultApp))

const gotLock = TEST || SELF_TEST.selfTest || app.requestSingleInstanceLock()
if (!gotLock) app.quit()
app.on('second-instance', (_event, argv, cwd) => {
  // Windows: a reelstudio:// link opened while the app runs arrives as the new instance's command line.
  const link = argv.find((a) => a.toLowerCase().startsWith(`${PROTOCOL}:`))
  if (link) acceptKeyLink(link)
  // Also brings the window back (or makes a new one) when the launch opened no file.
  queueOpenFiles(filesFromArgv(argv, cwd, !!process.defaultApp))
})

app.whenReady().then(async () => {
  if (process.platform === 'darwin' && process.execPath.startsWith('/Volumes/')) {
    log('[start] executable is under /Volumes/ on macOS; running from a mounted volume that may be a read-only disk image')
  }
  if (process.platform === 'darwin' && process.execPath.includes('/AppTranslocation/')) {
    log('[start] executable is under /AppTranslocation/ on macOS; running from a read-only Gatekeeper translocated copy')
  }
  if (SELF_TEST.selfTest) return selfTestAndQuit()
  if (gotLock) {
    const move = await offerMoveToApplications(
      {
        platform: process.platform,
        isPackaged: app.isPackaged,
        test: TEST,
        inApplications: process.platform === 'darwin' && app.isInApplicationsFolder(),
        exePath: process.execPath,
        writeError: writeErrorCode
      },
      {
        destinationExists: (path) => existsSync(path),
        ask: async (q) => (await dialog.showMessageBox(q)).response,
        askNow: (q) => dialog.showMessageBoxSync(q),
        move: (options) => app.moveToApplicationsFolder(options),
        log
      }
    )
    if (move === 'moving') return // this copy quits; the one in Applications opens
  }
  pidRegistry = createPidRegistry(settingsDir())
  // an engine that would not stop may be encoding: only its own video waits for it, the others render
  const settings = await settleLastRun(pidRegistry, (slug) => jobs.keepClosed(slug), log, (slug) => jobs.reopen(slug))
  // Settings › Advanced › Reset first run asks for the first run at the next launch (settings-sections)
  firstRunAgainAtLaunch = settings.firstRunAgain
  notificationsOn = notificationsWanted(settings, PERM_PLATFORM)
  perms = createPermissions({
    platform: PERM_PLATFORM,
    root: reelStudioRoot,
    rootDisplay: () => rootDisplay(reelStudioRoot()),
    touched: settings.firstRunDone,
    ensureRoot,
    load: loadSettings,
    save: saveSettings,
    notificationsSupported: () => Notification.isSupported(),
    showTestNotification,
    openPane,
    fakes: PERM_FAKES
  })
  if (TEST) Object.assign(globalThis, { __reelPermFakes: perms.fakes, __reelPermLog: paneLog })
  // reading the queues and the exports folder reads the Reel Studio folder, which a first run has not made yet
  if (settings.firstRunDone) {
    await noteQueue.recover().catch((e) => log(`[queue] ${String(e)}`))
    await sweepExportStaging(binDir('exports')).catch((e) => log(`[export] ${String(e)}`))
    // a New reel left untouched when the app last closed
    for (const slug of await fs.readdir(projectsDir()).catch(() => [] as string[])) await discardIfUntouched(slug, () => false).catch(() => false)
  }
  const loaded = await loadAI(
    {
      host,
      settingsDir: join(settingsDir(), 'ai'),
      dev: DEV_PROVIDERS,
      secretStore: safeStorage,
      roleModels: async () => (await loadSettings()).models,
      cliEnv: cliBaseEnv,
      moments: true
    },
    log
  )
  ai = loaded.ai
  aiSource = loaded.source
  vendors = createVendors()
  if (TEST_VENDOR_ENV) log(`[ai] test switch: the Claude Code and Codex apps see a throwaway home (REELSTUDIO_TEST_VENDOR_HOME)`)
  if (!DEV_PROVIDERS) {
    const retired = await ai.retireSignInWithChatGPT?.().catch((e) => (log(`[ai] retire Sign in with ChatGPT: ${String(e)}`), false))
    if (retired) log('[ai] signed out the old in-app ChatGPT sign-in; ChatGPT now connects through the Codex app')
  }
  await carryOverClaudeCode(settings).catch((e) => log(`[ai] carry-over: ${String(e)}`))
  log(`[start] root=${reelStudioRoot()} engine=${engineMode()}:${engineDir()} python=${pythonExe()} ai=${aiSource}`)
  // fontsDir: Library › Fonts shows each bundled font in its own face
  handleMediaProtocol(() => [reelStudioRoot(), projectsDir(), noteStagingRoot(), sfxPackDir(), libraryPreviewDir(), ...[fontsDir()].filter((d): d is string => !!d)])
  setAsrThreads(await models.savedThreads()) // before any engine call can start
  // first on usage's queue, so nothing reads it before a cut-short opt-out is finished (usage.ts reconcile)
  void usage.reconcile().catch((err) => log(`[usage] reconcile: ${String(err?.message ?? err)}`))
  outside = createOutside()
  if (settings.outsideApps) await outside.enable().catch((e) => log(`[outside] ${String(e?.userMessage ?? e)}`))
  registerIpc()
  void companion?.init().catch((e) => log(`[companion] ${String(e)}`))
  createWindow()
  // What a quit, a plan limit or no internet paused last time goes on now, or when it can (main/pause.ts). Sleep
  // was a different run of the app, so it waits only for the network.
  for (const p of await listProjects().catch(() => [])) {
    if (p.pausedFor) pauser.schedule(p.slug, p.pausedFor.reason === 'sleep' ? { ...p.pausedFor, reason: 'offline' } : p.pausedFor)
  }
  powerMonitor.on('suspend', () => {
    sleptAt = Date.now()
    pauser.slept()
  })
  powerMonitor.on('resume', () => pauser.woke())
  // B section 7: the computer stays awake while a reel is being made
  let awake: number | null = null
  setInterval(() => {
    const busy = jobs.making().length > 0
    if (busy && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension')
    else if (!busy && awake !== null) {
      powerSaveBlocker.stop(awake)
      awake = null
    }
  }, 5000).unref()
  await footageSources.start()
  indexLibrary()
  await updates.init()
  updates.start() // 15 s after the window, so launch is never slower
  // A model that was here before the timing check existed, or whose check a video interrupted, so it never slows launch.
  if (!TEST) setTimeout(() => void models.checkInBackground(), 30_000)
  // reelstudio:// links open this app (Windows writes it per user; macOS also reads Info.plist). Not in dev or tests,
  // which would point the scheme at a bare Electron.
  if (app.isPackaged && !TEST && !app.isDefaultProtocolClient(PROTOCOL) && !app.setAsDefaultProtocolClient(PROTOCOL)) log('[updates] could not register reelstudio:// links')
  ready = true
  // Beta's start waits for the updater (updates.init) after the window opens: files opened meanwhile only queued, so the
  // window is told once more that they are there.
  if (pendingOpenFiles.length && win && !win.isDestroyed()) win.webContents.send('app:filesAvailable')
  const firstLink = process.argv.find((a) => a.toLowerCase().startsWith(`${PROTOCOL}:`))
  for (const url of [...waitingKeyLinks.splice(0), ...(firstLink ? [firstLink] : [])]) acceptKeyLink(url)
  app.on('activate', () => {
    showWindow()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  void stopPhoneShare() // the "Send to my phone" link never outlives the app
  void companion?.stop() // nor does the phone and browser connection
  permissionHelper.close()
  const indexing = footageIndex.status().state === 'indexing'
  if (quitting || (!jobs.runningCount() && !cloudSavesRunning() && !indexing)) {
    footageSources.stop()
    void footageIndex.stop()
    void killAllEngines()
    return
  }
  // Ask once while a reel is being made (B section 7), then stop running work cleanly so the next start finds a tidy
  // project and continues what was being made, and give drive saves time to finish so the synced folder is not left
  // with a temporary file. Both waits are capped (jobs.ts, phone-ipc.ts).
  e.preventDefault()
  if (askingToQuit) return
  void (async () => {
    const making = jobs.making()
    const q = quitQuestion(making.length)
    if (q) {
      askingToQuit = true
      const ask = { type: 'question' as const, message: q.message, buttons: [q.yes, 'Cancel'], defaultId: 0, cancelId: 1 }
      // a test answers with REELSTUDIO_TEST_QUIT (stay = Cancel); the question still goes to main.log
      const yes = TEST
        ? process.env.REELSTUDIO_TEST_QUIT !== 'stay'
        : (await (win && !win.isDestroyed() ? dialog.showMessageBox(win, ask) : dialog.showMessageBox(ask))).response === 0
      askingToQuit = false
      log(`[quit] ${q.message} ${yes ? 'Quit' : 'Cancel'}`)
      if (!yes) return
      for (const slug of making) await updateAppState(slug, (s) => void (s.paused = { reason: 'quit', until: null, editor: null })).catch(() => undefined)
    }
    quitting = true
    footageSources.stop()
    noteQueue.quit()
    await Promise.allSettled([jobs.cancelAll().then(() => killAllEngines()), cloudSavesSettled(), footageIndex.stop(), outside?.close()]).finally(() => app.quit())
  })()
})
let askingToQuit = false

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

export { readAppState }
