import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { ProjectSummary, ProviderInfo } from '../../../shared/api'
import { reel } from '../api'
import { stateOf } from '../screens/home-state'
import type { Go } from '../nav'
import { Icon, type IconName } from './icons'
import { UpdateButton } from './UpdateButton'
import { byKeyboard, reducedMotion } from './motion'
import { SIDE, sideWidth } from './side-width'
import { IS_MAC } from './ui'
import './shell.css'

const RAIL_KEY = 'rs.sidebar-rail'
const WIDTH_KEY = 'rs.sidebar-width'
const RAIL_W = 64
const RESIZE_KEYS = IS_MAC ? 'Meta+Shift+\\' : 'Control+Shift+\\'
/** The page's and the title row's slide when the sidebar folds, so a second fold can stop it before measuring. */
const slides = new WeakMap<HTMLElement, Animation>()
/** The sidebar toggle in the title row: where focus goes when the resize edge it was on is hidden or has nowhere to return. */
const sidebarToggle = (): HTMLElement | null => document.querySelector<HTMLElement>('.titlebar .sbt')
/** Shift+\: matched by the character it types, or by the key's place when a layout types something else there. */
const isResizeChord = (e: KeyboardEvent): boolean =>
  (e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '\\' || e.key === '|' || e.code === 'Backslash')
/** View › Resize Sidebar (macOS menu, App.tsx): the same as the chord, which the menu takes before the page sees it. */
export const RESIZE_SIDEBAR_EVENT = 'reel:resize-sidebar'

// Insights is always here, so analytics have one place to live before any reel is posted (spec.md section 9).
const NAV: { key: 'home' | 'library' | 'style' | 'insights'; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Reels', icon: 'film' },
  { key: 'library', label: 'Library', icon: 'folder' },
  { key: 'style', label: 'My style', icon: 'layers' },
  { key: 'insights', label: 'Insights', icon: 'chart' }
]

export const providerName = (p: ProviderInfo | null): string | null => {
  if (!p || !p.connected || p.id === 'none') return null
  if (p.id === 'claude-cli') return 'Claude'
  if (p.id === 'codex-cli') return 'ChatGPT'
  return p.label
}

/**
 * The sidebar folds to a 64 px rail (Cmd/Ctrl+\, remembered). The column takes its new width at once and the
 * page and the title row slide from where they were, so nothing reflows while it moves; from the keyboard it just changes.
 */
export function useRail(): [boolean, (byShortcut?: boolean) => void] {
  const [rail, setRail] = useState(() => localStorage.getItem(RAIL_KEY) === '1')
  // byKeyboard() does not count Cmd/Ctrl shortcuts (motion.ts), so the shortcut says so itself
  const toggle = useCallback((byShortcut = false) => {
    // folding hides the resize edge: focus on it moves to the toggle first, so it isn't left on nothing
    if (document.activeElement?.classList.contains('side-resize')) sidebarToggle()?.focus()
    const moving = Array.from(document.querySelectorAll<HTMLElement>('.main, .tb-main'))
    // where each is on screen now, partway through a slide included
    const before = moving.map((el) => el.getBoundingClientRect().left)
    const instant = byShortcut || byKeyboard() || reducedMotion()
    document.documentElement.classList.toggle('rail-instant', instant)
    setRail((r) => {
      localStorage.setItem(RAIL_KEY, r ? '0' : '1')
      return !r
    })
    if (instant) {
      moving.forEach((el) => slides.get(el)?.cancel())
      requestAnimationFrame(() => document.documentElement.classList.remove('rail-instant'))
      return
    }
    requestAnimationFrame(() =>
      moving.forEach((el, i) => {
        // a slide still running would be measured as part of the new place: stop it, then slide from where it was
        slides.get(el)?.cancel()
        const dx = before[i] - el.getBoundingClientRect().left
        slides.set(el, el.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.23, 1, .32, 1)' }))
      })
    )
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === '\\') {
        e.preventDefault()
        toggle(true)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [toggle])
  return [rail, toggle]
}

/** The open width lives in CSS (--side-open, and the rail's scale of it), so a drag restyles without re-rendering the app. */
function applyWidth(w: number): void {
  const root = document.documentElement.style
  root.setProperty('--side-open', `${w}px`)
  root.setProperty('--rail-scale', String(RAIL_W / w))
}

/**
 * Drag the sidebar's edge between 232 and 360 px; a double-click goes back to 248. It is out of the Tab order, so Tab
 * goes from the account row to the screen (audit-1028 finding 24). Cmd/Ctrl+Shift+\ focuses it from anywhere; then
 * the arrow keys, Home and End size the sidebar and Esc goes back to where you were.
 */
function SideResizer() {
  const [width, setWidth] = useState(() => sideWidth(localStorage.getItem(WIDTH_KEY)))
  const edge = useRef<HTMLDivElement>(null)
  const back = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const reach = (e: Event) => {
      const el = edge.current
      // folded to the rail, the edge is hidden: there is no width to set
      if (!el || el.offsetParent === null) return
      e.preventDefault()
      // pressed again on the edge, Esc still goes back to where the first press came from
      if (document.activeElement !== el) back.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      // Chromium doesn't count a Cmd/Ctrl chord as keyboard use, so :focus-visible may not match; shell.css shows the
      // edge's focus under html.kb, which motion.ts clears on the next pointer press
      document.documentElement.classList.add('kb')
      el.focus()
    }
    const key = (e: KeyboardEvent) => {
      if (isResizeChord(e)) reach(e)
    }
    window.addEventListener('keydown', key)
    window.addEventListener(RESIZE_SIDEBAR_EVENT, reach)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener(RESIZE_SIDEBAR_EVENT, reach)
    }
  }, [])
  useEffect(() => applyWidth(width), [width])
  const commit = (w: number) => {
    setWidth(w)
    localStorage.setItem(WIDTH_KEY, String(w))
  }
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const w0 = width
    document.documentElement.classList.add('side-resizing')
    const move = (m: PointerEvent) => setWidth(sideWidth(w0 + m.clientX - x0))
    // A released drag keeps its width; a cancelled one (capture lost, the system took the pointer) goes back.
    const end = (e: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', end)
      el.removeEventListener('lostpointercapture', end)
      document.documentElement.classList.remove('side-resizing')
      if (e.type === 'pointerup') commit(sideWidth(w0 + e.clientX - x0))
      else setWidth(w0)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', end)
    el.addEventListener('lostpointercapture', end)
  }
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowLeft' ? -8 : e.key === 'ArrowRight' ? 8 : 0
    if (e.key === 'Escape') {
      back.current?.focus()
      // gone, hidden or not focusable: the toggle, so focus never stays on the edge
      if (document.activeElement === e.currentTarget) sidebarToggle()?.focus()
    } else if (e.key === 'Home') commit(SIDE.min)
    else if (e.key === 'End') commit(SIDE.max)
    else if (step) commit(sideWidth(width + step))
    else return
    e.preventDefault()
  }
  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-controls="sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDE.min}
      aria-valuemax={SIDE.max}
      tabIndex={-1}
      aria-keyshortcuts={RESIZE_KEYS}
      title={`Drag to change the sidebar’s width, or press ${IS_MAC ? '⌘⇧\\' : 'Ctrl+Shift+\\'} and use the arrow keys`}
      ref={edge}
      onPointerDown={down}
      onKeyDown={key}
      onDoubleClick={() => commit(SIDE.default)}
      data-testid="sidebar-resize"
    />
  )
}

/** How many reels the sidebar lists: enough to move between the ones in hand, not a second Reels page. */
const RECENT_MAX = 6

/**
 * The reels in hand, newest first, under the nav (as T3 Code lists its threads), so moving from one reel to another
 * doesn't go through Reels. A dot says which are being made or need you; the open one is marked. Folded to the rail,
 * it hides with the labels.
 */
/** A New reel nothing was done with yet (no video, no word said, its first name): main discards it when it is left
 * (store.ts isUntouchedPlanned), and listed here it only repeated the New reel button above. */
const untouched = (r: ProjectSummary): boolean => r.noVideo && r.title === 'New reel' && r.updatedAt === r.createdAt

function SideRecent({ current, go }: { current: string | null; go: Go }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null)
  useEffect(() => {
    let alive = true
    const load = () =>
      reel.projects.list().then(
        (p) => alive && setList(p.filter((r) => !untouched(r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_MAX)),
        () => alive && setList([])
      )
    void load()
    // a reel made, renamed, finished or stopped anywhere changes its line here too
    const off = reel.jobs.onEvent((e) => {
      if (e.type !== 'status') void load()
    })
    const offQueue = reel.queue.onChange(() => void load())
    return () => {
      alive = false
      off()
      offQueue()
    }
  }, [current])
  if (!list?.length) return null
  return (
    <nav className="side-recent" aria-label="Recent reels" data-testid="side-recent">
      <h2 className="side-h">Recent</h2>
      {list.map((p) => {
        const s = stateOf(p)
        const dot = s === 'making' ? 'making' : s === 'failed' || (s === 'paused' && !p.pausedFor) ? 'needs' : null
        return (
          <button
            key={p.slug}
            className={p.slug === current ? 'on' : undefined}
            aria-current={p.slug === current ? 'page' : undefined}
            onClick={() => go({ name: 'reel', slug: p.slug })}
            title={p.title}
            data-testid="side-reel"
          >
            {/* the nav's 16 px icon slot holds the state dot, so the names start where the nav's labels do */}
            <span className="side-slot">{dot && <span className={`side-dot ${dot}`} role="img" aria-label={dot === 'making' ? 'Being made' : 'Needs you'} />}</span>
            <span className="lbl">{p.title}</span>
          </button>
        )
      })}
    </nav>
  )
}

export function Sidebar({
  section,
  current,
  go,
  provider,
  userName,
  onNewReel
}: {
  section: string
  /** the reel on screen, marked in Recent */
  current: string | null
  go: Go
  provider: ProviderInfo | null
  userName: string | null
  onNewReel: () => void
}) {
  const name = providerName(provider)
  const who = userName?.trim() || 'You'
  const inSettings = section === 'settings'
  return (
    <aside className="side" id="sidebar" aria-label="Sidebar">
      <nav className="nav" aria-label="Main">
        <button
          className="new-reel"
          onClick={onNewReel}
          title={`New reel (${IS_MAC ? '⌘N' : 'Ctrl+N'})`}
          aria-keyshortcuts={IS_MAC ? 'Meta+N' : 'Control+N'}
          data-testid="new-reel"
        >
          <Icon name="plus" size={16} stroke={1.75} />
          <span className="lbl">New reel</span>
        </button>
        {NAV.map((n) => (
          <button
            key={n.key}
            className={section === n.key ? 'on' : undefined}
            aria-current={section === n.key ? 'page' : undefined}
            onClick={() => go({ name: n.key })}
            title={n.label}
            data-testid={`nav-${n.key}`}
          >
            <Icon name={n.icon} size={16} stroke={1.75} />
            <span className="lbl">{n.label}</span>
          </button>
        ))}
      </nav>
      <SideRecent current={current} go={go} />
      <div className="side-foot">
        <div className="side-update">
          <UpdateButton />
        </div>
        <button
          className={`acct${inSettings ? ' on' : ''}`}
          aria-current={inSettings ? 'page' : undefined}
          aria-label={`${who}, ${name ? `editor ${name}` : 'no editor'}. Settings`}
          title={!name ? 'Settings' : provider?.id === 'claude-cli' ? 'Editor: Claude (your Claude Code app). Settings' : provider?.id === 'codex-cli' ? 'Editor: ChatGPT (your Codex app). Settings' : 'Settings'}
          onClick={() => go({ name: 'settings' })}
          data-testid="account"
        >
          <span className="av" aria-hidden>
            {who.charAt(0).toUpperCase()}
            <span className={`st${name ? '' : ' off'}`} />
          </span>
          <span className="who lbl">
            <b>{who}</b>
            <span data-testid="ai-status">{name ? `Editor: ${name}` : 'No editor'}</span>
          </span>
        </button>
      </div>
      <SideResizer />
    </aside>
  )
}
