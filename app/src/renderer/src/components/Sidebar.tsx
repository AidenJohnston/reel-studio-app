import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { ProjectSummary, ProviderInfo } from '../../../shared/api'
import { reel } from '../api'
import { onReelsChanged } from './reels-changed'
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

/** Narrower than this, the sidebar starts as its rail, so the reel keeps the room (the lead's call, 2026-11-06, for
 * Sam to keep or undo: at 1100 px the open sidebar took a fifth of the window). */
const RAIL_BELOW = 1200
/** The person's own choice, once they have folded or opened the sidebar: it wins at every width. null: none yet. */
function chosenRail(): boolean | null {
  try {
    const v = localStorage.getItem(RAIL_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/**
 * The sidebar folds to a 64 px rail (Cmd/Ctrl+\, remembered). Until the person folds or opens it themselves it follows
 * the window: the rail below RAIL_BELOW, open above. The column takes its new width at once and the page and the
 * title row slide from where they were, so nothing reflows while it moves; from the keyboard it just changes.
 */
export function useRail(): [boolean, (byShortcut?: boolean) => void] {
  const [rail, setRail] = useState(() => chosenRail() ?? window.innerWidth < RAIL_BELOW)
  useEffect(() => {
    const follow = (): void => {
      if (chosenRail() !== null) return
      const narrow = window.innerWidth < RAIL_BELOW
      // the rail hides the Recent list and the resize edge: focus on either moves to the toggle first, as a fold by
      // hand does
      const focused = document.activeElement
      if (narrow && (focused?.classList.contains('side-resize') || focused?.closest('.side-recent'))) sidebarToggle()?.focus()
      setRail(narrow)
    }
    window.addEventListener('resize', follow)
    return () => window.removeEventListener('resize', follow)
  }, [])
  // byKeyboard() does not count Cmd/Ctrl shortcuts (motion.ts), so the shortcut says so itself
  const toggle = useCallback((byShortcut = false) => {
    // folding hides the resize edge and the Recent list: focus on either moves to the toggle first, so it isn't left
    // on nothing
    const focused = document.activeElement
    if (focused?.classList.contains('side-resize') || focused?.closest('.side-recent')) sidebarToggle()?.focus()
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

function SideRecent({ current, go, onListed }: { current: string | null; go: Go; onListed: (listed: boolean) => void }) {
  const [list, setList] = useState<ProjectSummary[] | null>(null)
  /** the jobs already seen: a new one (a first edit, a Resume, a note) reads the list once, as a reel it starts on
   * may be listed as stopped, or not at all (a New reel keeps its slug when its video comes in) */
  const seenJobs = useRef(new Set<string>())
  useEffect(() => {
    let alive = true
    // one read at a time: a burst of events asks once more after the read in flight, so answers arrive in order and a
    // late one never puts back an older list
    let reading = false
    let again = false
    const load = (): void => {
      if (reading) return void (again = true)
      reading = true
      reel.projects
        .list()
        .then(
          (p) => {
            if (alive) setList(p.filter((r) => !untouched(r)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_MAX))
          },
          () => alive && setList([])
        )
        .finally(() => {
          reading = false
          if (alive && again) {
            again = false
            load()
          }
        })
    }
    load()
    // a reel made, finished or stopped anywhere changes its line here too: a job's first status, a kept render, and how
    // it ends or pauses (its words, tools and moments change nothing listed)
    const off = reel.jobs.onEvent((e) => {
      if (e.type === 'status') {
        if (seenJobs.current.has(e.jobId)) return
        seenJobs.current.add(e.jobId)
        return load()
      }
      if ((e.type === 'render' && !e.draft) || e.type === 'done' || e.type === 'error' || e.type === 'cancelled' || e.type === 'paused') load()
    })
    const offQueue = reel.queue.onChange(load)
    const offRenamed = onReelsChanged(load)
    return () => {
      alive = false
      off()
      offQueue()
      offRenamed()
    }
  }, [current])
  const listed = !!current && !!list?.some((p) => p.slug === current)
  // before paint, so no frame shows neither Reels nor the reel's row marked while moving between reels
  useLayoutEffect(() => onListed(listed), [listed, onListed])
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
            {/* told apart by shape, not colour alone: a turning ring while it is made, the alert mark when it needs you */}
            <span className="side-slot">
              {dot === 'making' && <span className="spin side-making" role="img" aria-label="Being made" />}
              {dot === 'needs' && (
                <span className="side-needs" role="img" aria-label="Needs you">
                  <Icon name="alert" size={14} />
                </span>
              )}
            </span>
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
  rail,
  go,
  provider,
  userName,
  onNewReel
}: {
  section: string
  /** the reel on screen, marked in Recent */
  current: string | null
  /** folded to the rail, which hides Recent */
  rail: boolean
  go: Go
  provider: ProviderInfo | null
  userName: string | null
  onNewReel: () => void
}) {
  // the open reel's row in Recent, when it is there and showing, is the one marked; otherwise Reels is
  const [listed, setListed] = useState(false)
  const reelRowShown = listed && !rail
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
        {NAV.map((n) => {
          // a reel open is marked by its own row in Recent, not also by Reels: one row selected at a time (Craft, goal 4:
          // two read as current). A reel not in Recent (untouched, older than its six) or the rail hiding it: Reels.
          const here = section === n.key && !(n.key === 'home' && reelRowShown)
          return (
          <button
            key={n.key}
            className={here ? 'on' : undefined}
            aria-current={here ? 'page' : undefined}
            onClick={() => go({ name: n.key })}
            title={n.label}
            data-testid={`nav-${n.key}`}
          >
            <Icon name={n.icon} size={16} stroke={1.75} />
            <span className="lbl">{n.label}</span>
          </button>
          )
        })}
      </nav>
      <SideRecent current={current} go={go} onListed={setListed} />
      <div className="side-foot">
        <div className="side-update">
          <UpdateButton />
        </div>
        <button
          className={`acct${inSettings ? ' on' : ''}`}
          aria-current={inSettings ? 'page' : undefined}
          aria-label={`${who}, ${name ? `editor ${name}` : 'no editor'}. Settings`}
          title={!name ? 'Settings' : provider?.id === 'claude-cli' ? 'Editor: Claude. Settings' : provider?.id === 'codex-cli' ? 'Editor: ChatGPT. Settings' : 'Settings'}
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
