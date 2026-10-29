import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { AppCommand, AppInfo, ProviderInfo } from '../../shared/api'
import { reel, userMessage } from './api'
import type { Screen } from './nav'
import { IS_MAC, Toast } from './components/ui'
import { draggingOut } from './components/Player'
import { Icon, type IconName } from './components/icons'
import { ErrorBoundary } from './components/ErrorBoundary'
import { UpdateButton } from './components/UpdateButton'
import { Home } from './screens/Home'
import { NewVideo } from './screens/NewVideo'
import { Working } from './screens/Working'
import { Reel } from './screens/Reel'
import { Library } from './screens/Library'
import { MyStyle } from './screens/MyStyle'
import { Settings } from './screens/Settings'
import { FirstRun } from './screens/FirstRun'
import { Script } from './screens/Script'
import { Connect } from './screens/Connect'
import { createFromFiles, describeSorted } from './screens/create'

type Notify = (text: string, kind?: 'error' | 'info') => void
const NotifyCtx = createContext<Notify>(() => {})
export const useNotify = (): Notify => useContext(NotifyCtx)

/** Fired on window when the note box took a drop itself (Reel.tsx): the window overlay goes away. */
export const NOTE_DROP_DONE = 'reel:note-drop-done'

/** Fired on window by Cmd/Ctrl+E or the File menu; the Reel screen listens. */
export const EXPORT_EVENT = 'reel:export'

const NAV: { key: Screen['name']; label: string; icon: IconName }[] = [
  { key: 'home', label: 'My videos', icon: 'film' },
  { key: 'library', label: 'Library', icon: 'folder' },
  { key: 'style', label: 'My style', icon: 'sparkles' },
  { key: 'settings', label: 'Settings', icon: 'settings' }
]

const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [screen, setScreen] = useState<Screen>({ name: 'home' })
  const [toast, setToast] = useState<{ text: string; kind?: 'error' | 'info'; id: number } | null>(null)
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  const [dragging, setDragging] = useState(false)
  const [overNote, setOverNote] = useState(false) // a drag over the note box (Reel.tsx): it attaches, no overlay
  const [libraryTick, setLibraryTick] = useState(0)
  const notify = useCallback<Notify>((text, kind) => setToast({ text, kind, id: Date.now() }), [])
  const closeToast = useCallback(() => setToast(null), [])
  // A toast belongs to the screen it was said on: every screen change clears it (critique 1.1).
  const go = useCallback((s: Screen) => {
    setToast(null)
    setScreen(s)
  }, [])
  const screenRef = useRef(screen)
  screenRef.current = screen

  useEffect(() => {
    reel.app.info().then(setInfo)
  }, [])
  // The sidebar says which AI editor is on, and is a way in when none is.
  useEffect(() => {
    reel.ai.active().then(setProvider).catch(() => {})
  }, [screen, info?.firstRunDone])

  // Menu items (macOS) and notification clicks.
  useEffect(
    () =>
      reel.app.onCommand((c: AppCommand) => {
        if (c.type === 'new-video') go({ name: 'new' })
        else if (c.type === 'settings') go({ name: 'settings' })
        else if (c.type === 'library') go({ name: 'library' })
        else if (c.type === 'export') window.dispatchEvent(new Event(EXPORT_EVENT))
        else if (c.type === 'open-reel') go({ name: 'reel', slug: c.slug })
      }),
    [go]
  )

  // Keyboard shortcuts. On a Mac the menu owns Cmd+N / Cmd+, / Cmd+E (it sees them first); on
  // Windows there is no menu bar, so the page handles Ctrl+N / Ctrl+, / Ctrl+E itself.
  useEffect(() => {
    if (IS_MAC) return
    const key = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return
      const k = e.key.toLowerCase()
      if (k === 'n') go({ name: 'new' })
      else if (k === ',') go({ name: 'settings' })
      else if (k === 'e') window.dispatchEvent(new Event(EXPORT_EVENT))
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [go])

  // The whole window is a drop target (critique 3): a video makes a reel, anything on the Library
  // screen goes into the Library. Also: a dropped file must never navigate the window to the file.
  const firstRunDone = !!info?.firstRunDone
  useEffect(() => {
    let depth = 0
    const enter = (e: DragEvent) => {
      e.preventDefault()
      if (!hasFiles(e) || !firstRunDone || draggingOut()) return
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      // the note box (Reel.tsx) sets its own drop effect: a file dropped there is attached to the note
      setOverNote(!!(e.target as Element | null)?.closest?.('[data-note-drop]'))
      if (e.defaultPrevented) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = firstRunDone && hasFiles(e) ? 'copy' : 'none'
    }
    const noteDropDone = () => {
      depth = 0
      setDragging(false)
      setOverNote(false)
    }
    const leave = () => {
      depth = Math.max(0, depth - 1)
      if (!depth) {
        setDragging(false)
        setOverNote(false)
      }
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      setOverNote(false)
      if (draggingOut()) {
        ;(window as { __rsDraggingOut?: boolean }).__rsDraggingOut = false
        return
      }
      if (!firstRunDone || !e.dataTransfer) return
      const paths = Array.from(e.dataTransfer.files).map((f) => reel.app.pathForFile(f)).filter(Boolean)
      if (!paths.length) return
      if (screenRef.current.name === 'library') {
        reel.library
          .add(paths)
          .then((r) => {
            notify(describeSorted(r) || 'Done.')
            setLibraryTick((t) => t + 1)
          })
          .catch((err) => notify(userMessage(err), 'error'))
      } else void createFromFiles(paths, go, notify)
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
  }, [firstRunDone, go, notify])

  if (!info) return null
  const platform = `platform-${info.platform}`
  const toastEl = toast && <Toast key={toast.id} text={toast.text} kind={toast.kind} onClose={closeToast} />

  if (!info.firstRunDone) {
    return (
      <NotifyCtx.Provider value={notify}>
        <div className={`first-shell ${platform}`}>
          <div className="titlebar" aria-hidden />
          <FirstRun
            platform={info.platform}
            onDone={async () => {
              await reel.app.finishFirstRun()
              setInfo(await reel.app.info())
            }}
          />
        </div>
        {toastEl}
      </NotifyCtx.Provider>
    )
  }

  const section =
    screen.name === 'new' || screen.name === 'working' || screen.name === 'reel' || screen.name === 'script'
      ? 'home'
      : screen.name === 'connect'
        ? 'settings'
        : screen.name
  const aiOn = !!provider && provider.connected && provider.id !== 'none'

  return (
    <NotifyCtx.Provider value={notify}>
      <div className={`shell ${platform}`}>
        <div className="titlebar" aria-hidden />
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">
              <Icon name="play" size={14} stroke={2} />
            </span>
            Reel Studio
          </div>
          <nav aria-label="Main">
            {NAV.map((n) => (
              <button
                key={n.key}
                className={`nav-item${section === n.key ? ' active' : ''}`}
                aria-current={section === n.key ? 'page' : undefined}
                onClick={() => go({ name: n.key } as Screen)}
                data-testid={`nav-${n.key}`}
              >
                <Icon name={n.icon} />
                {n.label}
              </button>
            ))}
          </nav>
          <UpdateButton />
          <div className="sidebar-foot" data-testid="ai-status">
            {provider &&
              (aiOn ? (
                <span className="ai-on">
                  <span className="dot-on" aria-hidden /> AI editor: {provider.id === 'claude-cli' ? 'Claude (your Claude Code app)' : provider.label}
                </span>
              ) : (
                <>
                  <div className="muted-sm">No AI editor connected.</div>
                  <button className="link" style={{ padding: '4px 0' }} onClick={() => go({ name: 'connect' })} data-testid="sidebar-connect">
                    Connect one
                  </button>
                </>
              ))}
          </div>
        </aside>
        <main className="main">
          <ErrorBoundary resetKey={JSON.stringify(screen)} onReset={() => go({ name: 'home' })}>
            {screen.name === 'home' && <Home go={go} />}
            {screen.name === 'new' && <NewVideo go={go} />}
            {screen.name === 'script' && <Script go={go} />}
            {screen.name === 'working' && <Working key={screen.slug} slug={screen.slug} go={go} />}
            {screen.name === 'reel' && <Reel key={screen.slug} slug={screen.slug} go={go} fresh={screen.fresh} />}
            {screen.name === 'library' && <Library refreshKey={libraryTick} />}
            {screen.name === 'style' && <MyStyle />}
            {screen.name === 'settings' && <Settings info={info} onInfo={setInfo} go={go} />}
            {screen.name === 'connect' && <Connect back={screen.back} go={go} />}
          </ErrorBoundary>
        </main>
      </div>
      {dragging && !overNote && (
        <div className={`drop-overlay${screen.name === 'reel' ? ' light' : ''}`} data-testid="drop-overlay">
          <div>
            <Icon name="upload" size={28} />
            {screen.name === 'library'
              ? 'Drop to add to your Library'
              : screen.name === 'reel'
                ? 'Drop on your note to attach it, or here to make a new reel'
                : 'Drop to make a reel'}
          </div>
        </div>
      )}
      {toastEl}
    </NotifyCtx.Provider>
  )
}
