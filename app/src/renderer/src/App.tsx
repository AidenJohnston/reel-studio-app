import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { AppCommand, AppInfo, DropResult, ProviderInfo } from '../../shared/api'
import { reel, userMessage } from './api'
import type { Screen } from './nav'
import { IS_MAC, Toast } from './components/ui'
import { draggingOut } from './components/Player'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RESIZE_SIDEBAR_EVENT, Sidebar, useRail } from './components/Sidebar'
import { TitleBar, TitleBarMain, TitleBarProvider } from './components/titlebar'
import { useInputMode } from './components/motion'
import { Home } from './screens/Home'
import { Reel } from './screens/Reel'
import { Library } from './screens/Library'
import { MyStyle } from './screens/MyStyle'
import { Insights } from './screens/Insights'
import { Settings } from './screens/Settings'
import { FirstRun } from './screens/FirstRun'
import { Connect } from './screens/Connect'
import { createFromFiles, describeSorted, newReel } from './screens/create'
import { DropVeil, draggedFiles, droppedFiles, intentFor, launchFlight, type Intent, type Veil } from './components/Intake'
import { reducedMotion } from './components/motion'
import { markSeen } from './seen'

type Notify = (text: string, kind?: 'error' | 'info') => void
const NotifyCtx = createContext<Notify>(() => {})
export const useNotify = (): Notify => useContext(NotifyCtx)

/** Fired on window when the note box took a drop itself (Reel.tsx): the window overlay goes away. */
export const NOTE_DROP_DONE = 'reel:note-drop-done'

/** Fired on window by Cmd/Ctrl+E or the File menu; the Reel screen listens. */
export const EXPORT_EVENT = 'reel:export'

const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
const sameIntent = (a: Intent, b: Intent): boolean =>
  (a.kind === 'note' && b.kind === 'note') || (a.kind === 'this-reel' && b.kind === 'this-reel')
    ? a.rect.x === b.rect.x && a.rect.y === b.rect.y && a.rect.width === b.rect.width && a.rect.height === b.rect.height
    : a.kind === 'refuse' && b.kind === 'refuse'
      ? a.what === b.what && a.where === b.where
      : a.kind === b.kind

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const [toast, setToast] = useState<{ text: string; kind?: 'error' | 'info'; id: number } | null>(null)
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  const [veil, setVeil] = useState<Veil | null>(null)
  const [arriving, setArriving] = useState(false)
  const [libraryAdded, setLibraryAdded] = useState<{ results: DropResult[]; at: number } | undefined>()
  const notify = useCallback<Notify>((text, kind) => setToast({ text, kind, id: Date.now() }), [])
  const closeToast = useCallback(() => setToast(null), [])
  // A toast belongs to the screen it was said on: every screen change clears it (critique 1.1).
  const go = useCallback((s: Screen) => {
    setToast(null)
    setScreen(s)
  }, [])
  const screenRef = useRef(screen)
  screenRef.current = screen
  useInputMode()
  const [rail, toggleRail] = useRail()

  useEffect(() => {
    reel.app.info().then(setInfo)
  }, [])
  // The sidebar says which AI editor is on, and is a way in when none is. The read on screen change catches what
  // main cannot announce, such as a Claude Code app signed out in a terminal.
  useEffect(() => reel.ai.onChange(setProvider), [])
  useEffect(() => {
    reel.ai.active().then(setProvider).catch(() => {})
  }, [screen, info?.firstRunDone])

  // Menu items (macOS) and notification clicks.
  useEffect(
    () =>
      reel.app.onCommand((c: AppCommand) => {
        if (c.type === 'new-video') void newReel(go, notify)
        else if (c.type === 'settings') go({ name: 'settings' })
        else if (c.type === 'library') go({ name: 'library' })
        else if (c.type === 'export') window.dispatchEvent(new Event(EXPORT_EVENT))
        else if (c.type === 'open-reel') go({ name: 'reel', slug: c.slug })
        else if (c.type === 'resize-sidebar') window.dispatchEvent(new Event(RESIZE_SIDEBAR_EVENT))
      }),
    [go, notify]
  )

  // Keyboard shortcuts. On a Mac the menu owns Cmd+N / Cmd+, / Cmd+E (it sees them first); on
  // Windows there is no menu bar, so the page handles Ctrl+N / Ctrl+, / Ctrl+E itself.
  useEffect(() => {
    if (IS_MAC) return
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === 'n') void newReel(go, notify)
      else if (k === ',') go({ name: 'settings' })
      else if (k === 'e') window.dispatchEvent(new Event(EXPORT_EVENT))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [go, notify])

  // A reel was on screen: what it showed then is watched, so its card stops saying New (seen.ts).
  useEffect(() => {
    if (screen.name !== 'reel') return
    const slug = screen.slug
    markSeen(slug)
    return () => markSeen(slug)
  }, [screen])

  // A drop or a paste does what the veil said it would. A dropped video's thumbnail flies into the new reel's player;
  // a paste is a keyboard action, so it doesn't move.
  const intake = useCallback(
    async (paths: string[], drop?: { file: File; x: number; y: number }) => {
      if (!paths.length) return setVeil(null)
      const intent = intentFor(droppedFiles(paths), screenRef.current.name, null)
      if (intent.kind === 'refuse') {
        setVeil({ kind: 'refused', intent })
        window.setTimeout(() => setVeil((v) => (v?.kind === 'refused' ? null : v)), 1800)
        return
      }
      setVeil(null)
      if (intent.kind === 'library') {
        reel.library
          .add(paths)
          .then((results) => {
            setLibraryAdded({ results, at: Date.now() })
            if (screenRef.current.name !== 'library') notify(describeSorted(results) || 'Done.')
          })
          .catch((err) => notify(userMessage(err), 'error'))
        return
      }
      const flight = drop && !reducedMotion() ? launchFlight(drop.file, drop.x, drop.y) : null
      if (await createFromFiles(paths, go, notify)) flight?.land()
      else flight?.cancel()
    },
    [go, notify]
  )

  const firstRunDone = !!info?.firstRunDone
  useEffect(() => {
    if (!firstRunDone) return
    const open = () => {
      // A file opened with Reel Studio (AirDrop's "Opens with", Finder's Open With): a new reel from it.
      void reel.app.takeOpenFiles().then((paths) => {
        if (paths.length) void intake(paths)
      }).catch((err) => notify(userMessage(err), 'error'))
    }
    const off = reel.app.onFilesAvailable(open)
    open()
    const paste = (event: ClipboardEvent) => {
      const target = event.target
      if (event.defaultPrevented || (target instanceof Element && target.closest('input, textarea, [contenteditable], [data-note-drop], [data-video-drop]'))) return
      void reel.app.clipboardFiles().then((paths) => intake(paths)).catch((err) => notify(userMessage(err), 'error'))
    }
    window.addEventListener('paste', paste)
    return () => {
      off()
      window.removeEventListener('paste', paste)
    }
  }, [firstRunDone, go, notify, intake])

  // The whole window is a drop target (critique 3), and says what letting go will do: make a reel, attach to the note
  // under the pointer, add to the Library, or why it can't. Also: a dropped file must never navigate the window to the file.
  useEffect(() => {
    let depth = 0
    const sense = (e: DragEvent) => {
      const at = e.target as Element | null
      const note = at?.closest?.('[data-video-drop]') ?? at?.closest?.('[data-note-drop]') ?? null
      const intent = intentFor(draggedFiles(e.dataTransfer!), screenRef.current.name, note)
      setVeil((v) => (v?.kind === 'refused' ? v : v && sameIntent(v.intent, intent) ? v : { kind: 'over', intent }))
    }
    const enter = (e: DragEvent) => {
      e.preventDefault()
      if (!hasFiles(e) || !firstRunDone || draggingOut()) return
      depth++
      setVeil((v) => (v?.kind === 'refused' ? null : v))
      sense(e)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e) && firstRunDone && !draggingOut()) sense(e)
      if (e.defaultPrevented) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = firstRunDone && hasFiles(e) ? 'copy' : 'none'
    }
    const clear = () => setVeil((v) => (v?.kind === 'over' ? null : v))
    const noteDropDone = () => {
      depth = 0
      clear()
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) clear()
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      if (draggingOut()) {
        ;(window as { __rsDraggingOut?: boolean }).__rsDraggingOut = false
        return clear()
      }
      if (!firstRunDone || !e.dataTransfer) return clear()
      const files = Array.from(e.dataTransfer.files)
      const paths = files.map((f) => reel.app.pathForFile(f))
      const video = files[droppedFiles(paths).findIndex((f) => f.kind === 'video')]
      void intake(paths.filter(Boolean), video ? { file: video, x: e.clientX, y: e.clientY } : undefined)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    window.addEventListener(NOTE_DROP_DONE, noteDropDone)
    return () => {
      window.removeEventListener(NOTE_DROP_DONE, noteDropDone)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [firstRunDone, intake])

  if (!info) return null
  const platform = `platform-${info.platform}`
  const toastEl = toast && <Toast key={toast.id} text={toast.text} kind={toast.kind} onClose={closeToast} />

  if (!info.firstRunDone) {
    return (
      <NotifyCtx.Provider value={notify}>
        <div className={`first-shell ${platform}`}>
          <div className="titlebar first-titlebar" aria-hidden />
          <FirstRun
            platform={info.platform}
            onDone={async () => {
              // it ends on a new reel with no video yet, and the window around it slides in (first-run.css)
              await reel.app.finishFirstRun()
              await newReel(go, notify)
              setArriving(true)
              setInfo(await reel.app.info())
            }}
          />
        </div>
        {toastEl}
      </NotifyCtx.Provider>
    )
  }

  const shown = screen.name === 'connect' ? (screen.back ?? { name: 'home' }) : screen
  const section = shown.name === 'reel' ? 'home' : shown.name

  return (
    <NotifyCtx.Provider value={notify}>
      <TitleBarProvider>
        <div className={`shell ${platform}${rail ? ' rail' : ''}${arriving ? ' arriving' : ''}`}>
          <TitleBar rail={rail} onToggle={toggleRail} />
          <Sidebar
            section={section}
            current={shown.name === 'reel' ? shown.slug : null}
            go={go}
            provider={provider}
            userName={info.userName}
            onNewReel={() => void newReel(go, notify)}
          />
          <TitleBarMain />
          <main className="main">
            <ErrorBoundary resetKey={JSON.stringify(screen)} onReset={() => go({ name: 'home' })}>
              {screen.name === 'home' && <Home go={go} />}
              {screen.name === 'reel' && <Reel key={screen.slug} slug={screen.slug} at={screen.version} go={go} />}
              {screen.name === 'library' && <Library added={libraryAdded} />}
              {screen.name === 'style' && <MyStyle />}
              {screen.name === 'insights' && <Insights go={go} />}
              {screen.name === 'settings' && <Settings key={screen.section ?? ''} info={info} onInfo={setInfo} go={go} section={screen.section} />}
              {screen.name === 'connect' && <Connect back={screen.back} go={go} />}
            </ErrorBoundary>
          </main>
        </div>
      </TitleBarProvider>
      <DropVeil veil={veil} />
      {toastEl}
    </NotifyCtx.Provider>
  )
}
