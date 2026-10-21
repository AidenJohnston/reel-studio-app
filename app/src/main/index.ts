import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell, type IpcMainInvokeEvent } from 'electron'
import { existsSync, promises as fs, appendFileSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  binDir,
  engineDir,
  engineEnv,
  engineMode,
  initPaths,
  projectsDir,
  pythonExe,
  reelStudioRoot,
  setRootOverride,
  settingsDir
} from './paths'
import { createEngineRunner, killAllEngines, toUserError, type RunEngine } from './engine'
import { handleMediaProtocol, registerMediaScheme } from './media'
import {
  addChat,
  detail,
  ensureRoot,
  listProjects,
  listVersions,
  projectDir,
  readAppState,
  readProject,
  readWords,
  recoverInterrupted,
  titleFromFile,
  uniqueSlug,
  updateAppState,
  writeJson,
  writeProject
} from './store'
import { addToLibrary, isVideo, listLibrary, uniqueDest } from './library'
import { createJobManager } from './jobs'
import { createLiveVideos } from './live-video'
import { rememberQuestion, styleConsent } from './style-consent'
import type { AgentResult } from './ai-types'
import { loadAI } from './ai'
import type { AI, EngineHost } from './ai-types'
import { closeAnimationRenderer, renderAnimation, TEST_TEMPLATE } from './animation'
import { captureWebsite } from './capture'
import { createModelManager } from './models'
import { loadSettings, saveSettings } from './settings'
import { createPidRegistry } from './orphans'
import { openSignInWindow, publicInfo } from './claude-signin'
import { aiChoiceSaved, carryOverDecision } from './ai-carryover'
import type { AppInfo, DropResult, ExportResult, JobEvent, ProjectJson } from '../shared/api'
import { noAiReply } from '../shared/notes'
import { versionMessage } from '../shared/describe'
import { displayPath } from '../shared/display-path'
import { registerPhoneIpc, stopPhoneShare } from './phone-ipc'
import { checkNoteAttachments, forChat, pickClipboardType, registerAttachmentIpc } from './attachments'
import { createUpdateService } from './update-check'
import { createJobFeedback, createMainWindow, feedbackLog, installMenu, startDragOut, windowStateFile, type AppCommand } from './window'

const TEST = process.env.REELSTUDIO_TEST === '1'
const DEV_PROVIDERS = process.env.REELSTUDIO_DEV === '1'
if (process.env.REELSTUDIO_USER_DATA) app.setPath('userData', process.env.REELSTUDIO_USER_DATA)

registerMediaScheme()

initPaths({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  documentsDir: app.getPath('documents'),
  userDataDir: app.getPath('userData'),
  appDir: app.getAppPath()
})

// ---- logging ------------------------------------------------------------------------------------
const logFile = (): string => join(settingsDir(), 'logs', 'main.log')
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

// ---- engine, AI, jobs ----------------------------------------------------------------------------
let pidRegistry: ReturnType<typeof createPidRegistry> | null = null
const runEngine: RunEngine = createEngineRunner({
  python: pythonExe,
  env: engineEnv,
  cwd: engineDir,
  log,
  onSpawn: (pid) => pidRegistry?.add(pid),
  onExit: (pid) => pidRegistry?.remove(pid)
})

const host: EngineHost = {
  runEngine,
  renderAnimation: (template, params, outPath) => renderAnimation(template, params, outPath),
  captureWebsite: (url, outPath, opts) => captureWebsite(url, outPath, opts),
  reelStudioRoot
}

let ai: AI
let aiSource: 'package' | 'mock' = 'mock'
let win: BrowserWindow | null = null

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
}

// The window, menu, Dock/taskbar and notifications (window.ts) hear about every job too.
const sendCommand = (c: AppCommand): void => broadcast('app:command', c)
const feedback = createJobFeedback({
  window: () => win,
  title: async (slug) => (await readProject(slug).catch(() => null))?.title || slug,
  send: sendCommand,
  test: TEST
})
if (TEST) (globalThis as { __reelFeedback?: unknown }).__reelFeedback = feedbackLog
// Honest progress (main/progress.ts): phase times measured on this computer, per minute of video.
const speedHistoryFile = (): string => join(settingsDir(), 'speed-history.json')
const jobs = createJobManager(
  (e: JobEvent) => {
    broadcast('job:event', e)
    feedback.onJobEvent(e)
  },
  log,
  {
    loadHistory: async () => JSON.parse(await fs.readFile(speedHistoryFile(), 'utf8')),
    saveHistory: (h) => writeJson(speedHistoryFile(), h),
    mediaSeconds: async (slug) =>
      ((await readProject(slug)).sources ?? []).reduce((a: number, s: { duration?: number }) => a + (Number(s?.duration) || 0), 0)
  },
  // render events carry a playable URL (a stable copy for drafts: main/live-video.ts)
  ((live) => (slug: string, e) => live(projectDir(slug), e))(createLiveVideos())
)
const models = createModelManager(runEngine, (s) => broadcast('model:progress', s))
// "Update available" notice (main/update-check.ts): one anonymous GET a day, never in test runs.
const updates = createUpdateService({
  active: !TEST,
  version: app.getVersion(),
  load: loadSettings,
  save: saveSettings,
  fetch: (url, init) => fetch(url, init), // Node's fetch: no Electron session, so no cookies
  now: () => Date.now(),
  log,
  openExternal: (url) => shell.openExternal(url),
  send: (n) => broadcast('update:change', n)
})

// ---- helpers ------------------------------------------------------------------------------------
type Handler = (e: IpcMainInvokeEvent, ...args: any[]) => unknown

/** Every IPC call returns {ok, value} or {ok:false, error:{code,userMessage}} so errors stay friendly. */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (e, ...args) => {
    try {
      return { ok: true, value: await fn(e, ...args) }
    } catch (err) {
      const u = toUserError(err)
      log(`[ipc ${channel}] ${u.code}: ${u.message ?? u.userMessage}`)
      const link = (err as { link?: unknown })?.link
      return { ok: false, error: { code: u.code, userMessage: u.userMessage, ...(typeof link === 'string' ? { link } : {}) } }
    }
  })
}

async function appInfo(): Promise<AppInfo> {
  const s = await loadSettings()
  // The real long path, never an 8.3 short name like USERNA~1 (design critique 1.9).
  let root = reelStudioRoot()
  try {
    root = realpathSync.native(root)
  } catch {
    /* not created yet: show it as configured */
  }
  return {
    version: app.getVersion(),
    platform: process.platform,
    root,
    rootDisplay: displayPath(
      root,
      { documents: app.getPath('documents'), desktop: app.getPath('desktop'), home: app.getPath('home') },
      process.platform
    ),
    firstRunDone: s.firstRunDone,
    engine: { mode: engineMode(), dir: engineDir(), python: pythonExe() },
    ai: aiSource,
    test: TEST,
    dev: DEV_PROVIDERS
  }
}

function startFirstEdit(slug: string, initArgs: { title: string; files: string[] } | null): string {
  const dir = projectDir(slug)
  return jobs.start(slug, 'first-edit', async (emit, signal) => {
    if (initArgs && !existsSync(join(dir, 'project.json'))) {
      emit({ type: 'status', message: 'Copying your video', pct: 0 })
      await runEngine(
        'init',
        ['--project', dir, '--title', initArgs.title, '--slug', slug, ...initArgs.files],
        (p) => emit({ type: 'status', message: 'Copying your video', pct: Math.round(p.pct * 0.01) }),
        signal
      )
    }
    const provider = await ai.active().catch(() => null)
    // A render event with firstLook = the quick no-AI draft is ready while the AI keeps editing; the
    // Working screen plays it (shared/live.ts) and says what it is. Once listening is done (the first
    // status of a later phase), the words heard go to the Working screen ("I heard: ...").
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
      signal
    )
    // Honest "What I did": only an AI that ran to the end picked the takes and wrote the caption.
    // A notice means it stopped and (usually) the simple edit stepped in, so claim nothing.
    const aiEdited = !!provider && provider.connected && provider.id !== 'none' && !r.notice
    await updateAppState(slug, (s) => {
      s.aiEdited = aiEdited
    })
    if (r.notice?.userMessage) await addChat(slug, 'editor', r.notice.userMessage)
    return replyAskingAboutStyle(slug, r, r.summary)
  })
}

/** The editor's reply into the chat, then one "Remember this for next time?" per My style rule the AI
 * proposed or saved (a saved one is taken out again until the user says Yes): main/style-consent.ts. */
async function replyAskingAboutStyle(slug: string, r: AgentResult, summary: string): Promise<{ summary: string; version: number; quiet: true }> {
  const c = styleConsent(summary, r.styleRulesAdded, r.styleSuggestions)
  if (c.undo.length) {
    const rules = await ai.styleRules().catch(() => [])
    for (const rule of rules) if (c.undo.includes(rule.text)) await ai.removeStyleRule(rule.id).catch(() => undefined)
  }
  await addChat(slug, 'editor', c.summary, r.version)
  for (const rule of c.suggestions) await addChat(slug, 'editor', rememberQuestion(rule), undefined, ['remember-yes', 'remember-no'], rule)
  return { summary: c.summary, version: r.version, quiet: true }
}

const EDITABLE: (keyof ProjectJson)[] = ['title', 'cut', 'captions', 'music', 'broll', 'zooms', 'cover', 'post']

function safeFileName(s: string): string {
  const t = s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  return t.slice(0, 80) || 'My video'
}

async function exportVersion(slug: string, n: number): Promise<ExportResult> {
  const dir = projectDir(slug)
  let versions = await listVersions(dir)
  let v = versions.find((x) => x.n === n) ?? versions[versions.length - 1]
  if (!v) throw { code: 'NO_VERSION', userMessage: 'This video is not ready yet. Wait for it to finish, then try again.' }
  if (jobs.forSlug(slug)) throw { code: 'BUSY', userMessage: 'I am still working on this video. Wait until it is done, then export.' }
  if (v.draft) {
    // A preview is not the full-quality file: make it first, as a normal job (progress, Stop, and
    // nothing else can run on this video meanwhile) (review 25).
    jobs.start(slug, 'rerender', async (emit, signal) => {
      emit({ type: 'status', message: 'Making the full-quality video', pct: 1, phase: 'final' })
      const r: any = await runEngine(
        'render',
        ['--project', dir],
        (pr) => emit({ type: 'status', message: pr.message || 'Making the full-quality video', pct: pr.pct, phase: 'final' }),
        signal
      )
      const version = Number(r?.version ?? 0)
      emit({ type: 'render', version, draft: false })
      return { summary: '', version, quiet: true }
    })
    await jobs.forSlug(slug)?.done
    versions = await listVersions(dir)
    v = versions[versions.length - 1]
    if (!v || v.draft) throw { code: 'EXPORT_FAILED', userMessage: 'I could not make the full-quality video. Try Export again.' }
  }
  const p = await readProject(slug)
  const exportsDir = binDir('exports')
  await fs.mkdir(exportsDir, { recursive: true })
  // "<title> - Version 2.mp4": the same words as the version buttons, never a bare "(2)".
  const name = `${safeFileName(p.title || slug)} - Version ${v.n}`
  const video = uniqueDest(exportsDir, `${name}.mp4`)
  const stem = basename(video, '.mp4')
  await fs.copyFile(v.videoPath, video)
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
  if (!TEST) shell.showItemInFolder(video)
  return { folder: exportsDir, video, cover, captionFile, caption }
}

// ---- IPC ----------------------------------------------------------------------------------------
function registerIpc(): void {
  handle('app:info', () => appInfo())
  handle('app:finishFirstRun', async () => {
    await saveSettings({ firstRunDone: true })
  })
  handle('app:openFolder', async (_e, p: string) => {
    if (TEST) return
    const st = await fs.stat(p).catch(() => null)
    if (st?.isDirectory()) await shell.openPath(p)
    else shell.showItemInFolder(p)
  })
  handle('app:copyText', (_e, t: string) => clipboard.writeText(String(t)))
  ipcMain.on('app:startDrag', (e, file: string) => {
    try {
      startDragOut(e.sender, file, [reelStudioRoot(), projectsDir()])
    } catch (err) {
      log(`[drag] ${String(err)}`)
    }
  })
  handle('app:chooseFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('app:setRoot', async (_e, p: string) => {
    if (jobs.runningCount()) throw { code: 'BUSY', userMessage: 'Wait until your video is finished, then change where videos are kept.' }
    const root = basename(p) === 'Reel Studio' ? p : join(p, 'Reel Studio')
    await fs.mkdir(root, { recursive: true })
    await saveSettings({ root })
    setRootOverride(root)
    await ensureRoot()
    return appInfo()
  })

  registerPhoneIpc({ handle, roots: () => [reelStudioRoot(), projectsDir()], send: broadcast, log, test: TEST })
  // pictures, GIFs and clips on a note (main/attachments.ts)
  registerAttachmentIpc({
    handle,
    runEngine,
    log,
    projectDir,
    readProject,
    busy: (slug) => !!jobs.forSlug(slug),
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
      const r = await dialog.showOpenDialog(win!, { title: 'Attach a picture or a clip', properties: ['openFile', 'multiSelections'], filters })
      return r.canceled ? null : r.filePaths
    }
  })

  handle('model:status', () => models.status())
  handle('model:download', () => models.download())
  handle('model:cancel', () => models.cancel())

  handle('ai:providers', () => ai.providers())
  handle('ai:active', () => ai.active())
  handle('ai:setActive', (_e, id) => ai.setActive(id))
  handle('ai:signInChatGPT', () => ai.signInChatGPT((url) => shell.openExternal(url)))
  handle('ai:cancelSignIn', () => ai.cancelSignInChatGPT?.())
  handle('ai:signOutChatGPT', () => ai.signOutChatGPT())
  handle('ai:setClaudeKey', (_e, key: string | null) => ai.setClaudeKey(key))
  // The person's own Claude Code app: the page gets the state only; the sign-in happens in Anthropic's CLI.
  const claudeCode = async () => (await ai.claudeCodeStatus?.()) ?? { state: 'missing' as const }
  handle('ai:claudeCodeStatus', async () => publicInfo(await claudeCode()))
  handle('ai:openClaudeSignIn', async () => {
    const st = await claudeCode()
    if (st.state === 'ready') return
    const open = aiSource === 'mock' ? async () => (ai.mockClaudeSignInOpened?.(), '') : (f: string) => shell.openPath(f)
    await openSignInWindow(st.bin, { dir: join(settingsDir(), 'claude-sign-in'), platform: process.platform, open })
  })

  handle('projects:list', () => listProjects())
  handle('projects:get', async (_e, slug: string) => {
    const d = await detail(slug)
    const running = jobs.forSlug(slug)
    d.job = running
      ? { id: running.id, kind: running.kind, message: running.message, pct: running.pct, overall: running.overall, secondsLeft: running.secondsLeft, overdue: running.overdue, thinking: running.thinking }
      : null
    if (!running && d.status === 'working') d.status = 'interrupted'
    return d
  })
  handle('projects:create', async (_e, files: string[]) => {
    const videos = files.filter(isVideo)
    const others = files.filter((f) => !isVideo(f))
    const skipped: DropResult[] = others.length ? await addToLibrary(others, runEngine, log) : []
    if (!videos.length) {
      const sorted = skipped.filter((s) => s.bin)
      throw {
        code: 'NO_VIDEO',
        userMessage: sorted.length
          ? 'That was not a video, so I put it in your Library. Drop a video file (like .mp4 or .mov) to make a reel.'
          : 'Drop a video file (like .mp4 or .mov) to make a reel.'
      }
    }
    for (const v of videos) {
      if (!(await fs.stat(v).catch(() => null))?.isFile()) {
        throw { code: 'NOT_FOUND', userMessage: `I could not open "${basename(v)}". Check that the file is still there and try again.` }
      }
    }
    await ensureRoot()
    const title = titleFromFile(videos[0])
    const slug = await uniqueSlug(title)
    await fs.mkdir(projectDir(slug), { recursive: true })
    await updateAppState(slug, (s) => {
      s.status = 'working'
      s.title = title
    })
    const jobId = startFirstEdit(slug, { title, files: videos })
    return { slug, jobId, skipped }
  })
  handle('projects:resume', async (_e, slug: string) => {
    const dir = projectDir(slug)
    if (!existsSync(join(dir, 'project.json'))) {
      throw { code: 'CANNOT_RESUME', userMessage: 'This video never finished copying. Delete it and drop the video in again.' }
    }
    return { jobId: startFirstEdit(slug, null) }
  })
  handle('projects:note', async (_e, slug: string, text: string, attachments?: unknown) => {
    const note = String(text ?? '').trim()
    const dir = projectDir(slug)
    // never trust the page: every attached ref is re-read from THIS project's own sidecars
    const files = await checkNoteAttachments(dir, attachments)
    if (!note && !files.length) throw { code: 'EMPTY', userMessage: 'Type what you would like changed first.' }
    if (jobs.forSlug(slug)) throw { code: 'BUSY', userMessage: 'I am still working on this video. Give me a moment, or press Stop.' }
    await addChat(slug, 'you', note, undefined, undefined, undefined, files.map(forChat))
    const active = await ai.active().catch(() => null)
    if (!active || !active.connected || active.id === 'none') {
      // No AI editor: nothing can apply the note, so do not pretend. Say what they can do instead
      // and offer the matching manual control plus "Connect ChatGPT" (grandma test, finding 8).
      const reply = noAiReply(note, files.length)
      await addChat(slug, 'editor', reply.text, undefined, reply.actions)
      return { jobId: null }
    }
    const jobId = jobs.start(
      slug,
      'note',
      async (emit, signal) => {
        const opts = files.length ? { attachments: files.map((f) => f.asset) } : undefined
        const r: AgentResult = await ai.applyNote(dir, note, (e) => emit(e), signal, opts)
        const extra = r.notice?.userMessage ? ` ${r.notice.userMessage}` : ''
        return { ...(await replyAskingAboutStyle(slug, r, r.summary + extra)), made: { by: 'note', summary: note } }
      },
      { note: note || files.map((f) => f.name).join(', ') }
    )
    return { jobId }
  })
  handle('projects:update', async (_e, slug: string, patch: Partial<ProjectJson>) => {
    if (jobs.forSlug(slug)) throw { code: 'BUSY', userMessage: 'I am still working on this video. Give me a moment, or press Stop.' }
    const p = await readProject(slug)
    for (const k of Object.keys(patch ?? {}) as (keyof ProjectJson)[]) {
      if (!EDITABLE.includes(k)) continue
      ;(p as any)[k] = (patch as any)[k]
    }
    await writeProject(slug, p)
    const d = await detail(slug)
    return d
  })
  // `change` = what the user changed, in plain words ("bigger yellow subtitles"), for the chat and the version button.
  // A manual change is render-only (no AI), called what it is ("Updating your subtitles", never the engine's
  // own step names like "Adding pictures"), and fast to SEE: a half-size preview first (the Reel screen plays
  // it), then the full-quality version (grandma 2: a colour change took 3 minutes and said "Adding pictures").
  handle('projects:rerender', async (_e, slug: string, change?: string, label?: string) => {
    const dir = projectDir(slug)
    const words = typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : 'Updating your video'
    const jobId = jobs.start(slug, 'rerender', async (emit, signal) => {
      emit({ type: 'status', message: words, pct: 1, phase: 'final' })
      const look: any = await runEngine(
        'render',
        ['--project', dir, '--draft', '--no-cover'],
        (p) => emit({ type: 'status', message: words, pct: Math.round(p.pct * 0.3), phase: 'final' }),
        signal
      )
      emit({ type: 'render', version: Number(look?.version ?? 0), draft: true, ...(look?.file ? { file: String(look.file) } : {}) })
      const r: any = await runEngine(
        'render',
        ['--project', dir],
        (p) => emit({ type: 'status', message: words, pct: 30 + Math.round(p.pct * 0.7), phase: 'final' }),
        signal
      )
      const version = Number(r?.version ?? (await readProject(slug)).version)
      emit({ type: 'render', version, draft: false, ...(r?.file ? { file: String(r.file) } : {}) })
      const what = typeof change === 'string' ? change.slice(0, 200) : ''
      return { summary: versionMessage(version, what), version, made: { by: 'hand', summary: what } }
    })
    return { jobId }
  })
  handle('projects:export', (_e, slug: string, n: number) => exportVersion(slug, n))
  handle('projects:remove', async (_e, slug: string) => {
    const running = jobs.forSlug(slug)
    if (running) {
      jobs.abandon(running.id)
      await running.done
    }
    await fs.rm(projectDir(slug), { recursive: true, force: true })
  })

  handle('jobs:cancel', (_e, id: string) => jobs.cancel(id))

  handle('library:list', async () => {
    await ensureRoot()
    return listLibrary()
  })
  handle('library:add', async (_e, paths: string[]) => {
    await ensureRoot()
    return addToLibrary(paths, runEngine, log)
  })
  handle('library:choose', async (_e, kind: 'music' | 'images') => {
    const filters =
      kind === 'music'
        ? [{ name: 'Songs', extensions: ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg'] }]
        : [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'] }]
    const r = await dialog.showOpenDialog(win!, {
      title: kind === 'music' ? 'Pick a song' : 'Pick pictures',
      properties: ['openFile', 'multiSelections'],
      filters
    })
    if (r.canceled || !r.filePaths.length) return []
    await ensureRoot()
    return addToLibrary(r.filePaths, runEngine, log)
  })

  handle('style:rules', () => ai.styleRules())
  handle('style:remove', (_e, id: string) => ai.removeStyleRule(id))
  // "Remember this for next time?" Yes saves the rule; either answer replaces the buttons with a plain reply.
  handle('style:answer', async (_e, slug: string, messageId: string, yes: boolean) => {
    const st = await readAppState(slug)
    const m = st.chat.find((x) => x.id === messageId)
    if (!m?.suggestion || !m.actions?.includes('remember-yes')) return
    if (yes) {
      if (!ai.addStyleRule) throw { code: 'NOT_READY', userMessage: 'I could not save that to My style. Try again later.' }
      await ai.addStyleRule(m.suggestion)
    }
    await updateAppState(slug, (s) => {
      const x = s.chat.find((y) => y.id === messageId)
      if (x) delete x.actions
    })
    await addChat(slug, 'editor', yes ? "Saved. I'll do that in your next videos too. You can remove it in My style." : 'OK, only for this video.')
  })

  handle('script:write', (_e, idea: string) => {
    if (!String(idea ?? '').trim()) throw { code: 'EMPTY', userMessage: 'Tell me your idea in a sentence or two first.' }
    return ai.writeScript(String(idea), () => {})
  })

  handle('update:status', () => updates.status())
  handle('update:setEnabled', (_e, on: unknown) => updates.setEnabled(on))
  handle('update:open', (_e, url: unknown) => updates.open(url))
  handle('update:dismiss', (_e, version: unknown) => updates.dismiss(version))

  handle('dev:renderTestAnimation', (_e, outPath: string, fullSize?: boolean, template?: string, params?: Record<string, unknown>) => {
    if (!TEST && app.isPackaged) throw { code: 'NOT_ALLOWED', userMessage: 'Not available.' }
    if (template) return host.renderAnimation(template, params ?? {}, outPath)
    return host.renderAnimation(TEST_TEMPLATE, { text: 'Hi', duration: fullSize ? 2 : 1 }, outPath)
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

// ---- window -------------------------------------------------------------------------------------
function createWindow(): void {
  win = createMainWindow({ preload: join(__dirname, '../preload/index.js'), stateFile: windowStateFile(settingsDir()), test: TEST })
  installMenu(sendCommand, DEV_PROVIDERS || !app.isPackaged)
  win.once('ready-to-show', () => win?.show())
  // Stop flashing the taskbar once the person is back.
  win.on('focus', () => win?.flashFrame(false))
  // The animation renderer keeps a hidden offscreen window; it must not keep the app alive.
  win.on('closed', () => void closeAnimationRenderer())
  // Links open in the system browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The app is one page: it never navigates (review 30). Links go out through the handler above.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

const gotLock = TEST || app.requestSingleInstanceLock()
if (!gotLock) app.quit()
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.whenReady().then(async () => {
  pidRegistry = createPidRegistry(settingsDir())
  const reaped = await pidRegistry.reap().catch(() => 0)
  if (reaped) log(`[start] stopped ${reaped} engine process(es) left over from a crash`)
  const settings = await loadSettings()
  if (settings.root) setRootOverride(settings.root)
  await ensureRoot().catch((e) => log(`[root] ${String(e)}`))
  const recovered = await recoverInterrupted().catch((e) => {
    log(`[recover] ${String(e)}`)
    return []
  })
  if (recovered.length) log(`[recover] cleaned up ${recovered.join(', ')}`)
  const loaded = await loadAI(
    {
      host,
      settingsDir: join(settingsDir(), 'ai'),
      dev: DEV_PROVIDERS,
      secretStore: safeStorage
    },
    log
  )
  ai = loaded.ai
  aiSource = loaded.source
  await carryOverClaudeCode(settings).catch((e) => log(`[ai] carry-over: ${String(e)}`))
  log(`[start] root=${reelStudioRoot()} engine=${engineMode()}:${engineDir()} python=${pythonExe()} ai=${aiSource}`)
  handleMediaProtocol(() => [reelStudioRoot(), projectsDir()])
  registerIpc()
  createWindow()
  updates.start() // a few seconds after the window, so launch is never slower
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

let quitting = false
app.on('before-quit', (e) => {
  void stopPhoneShare() // the "Send to my phone" link never outlives the app
  if (quitting || !jobs.runningCount()) {
    void killAllEngines()
    return
  }
  // Stop running work cleanly so the next start finds a tidy project.
  e.preventDefault()
  quitting = true
  void jobs
    .cancelAll()
    .then(() => killAllEngines())
    .finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

export { readAppState }
