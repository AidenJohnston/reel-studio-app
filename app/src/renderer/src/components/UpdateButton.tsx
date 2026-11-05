import { useEffect, useId, useRef, useState } from 'react'
import { showsUpdateButton, type UpdateState } from '../../../shared/update'
import { notesHeading, updateButtonLabel, updateHeadline, updateIcon, updateSubline, updateSummary } from './update-copy'
import { NoteText } from './UpdateSettings'
import { reel } from '../api'
import { useNotify } from '../App'
import { Icon } from './icons'
import { openReleasePage, useUpdateActions, useUpdateState } from './update'

const R = 12
const RING = 2 * Math.PI * R
const OPEN_DELAY_MS = 200
const CLOSE_DELAY_MS = 150
const GAP = 8
/** In the folded sidebar there is no column to fit, so the popover takes this width and reaches over the page. */
const RAIL_POP_W = 280

type PopPos = { left: number; bottom: number; width: number; maxHeight: number }

/**
 * Above the item, as wide as it (the sidebar's column), so it never covers the screen's own actions; in the folded
 * rail it reaches right instead. Clamped to the window: it never starts under the title row or past the right edge.
 */
function placeAbove(btn: HTMLElement): PopPos {
  const r = btn.getBoundingClientRect()
  const side = btn.closest('.side')?.getBoundingClientRect()
  const rail = !!side && side.width < 120
  const width = Math.min(rail ? RAIL_POP_W : Math.max(r.width, 200), window.innerWidth - r.left - GAP)
  const titlebar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar')) || 0
  // below the nav when there is room for it, so the rows you came from stay readable
  const nav = btn.closest('.side')?.querySelector('nav')?.getBoundingClientRect().bottom ?? 0
  const room = r.top - GAP - Math.max(titlebar, nav) - GAP
  const maxHeight = room >= 200 ? room : r.top - GAP - titlebar - GAP
  return { left: r.left, bottom: window.innerHeight - r.top + GAP, width, maxHeight }
}

function StatusIcon({ s }: { s: UpdateState }) {
  const kind = updateIcon(s)
  const pct = Math.min(100, Math.max(0, s.downloadPercent ?? 0))
  return (
    <span className={`update-icon ${kind}`} aria-hidden>
      {kind === 'downloading' && (
        <svg className="update-ring" viewBox="0 0 28 28">
          <circle cx="14" cy="14" r={R} className="track" />
          <circle cx="14" cy="14" r={R} className="bar" strokeDasharray={RING} strokeDashoffset={RING * (1 - pct / 100)} />
        </svg>
      )}
      <Icon name={kind === 'downloaded' ? 'restart' : 'download'} size={16} stroke={1.75} />
      {kind === 'available' && <span className="update-dot" />}
      {kind === 'failed' && <span className="update-dot failed" />}
      {kind === 'downloaded' && (
        <span className="update-badge">
          <Icon name="check" size={9} stroke={3.5} />
        </span>
      )}
    </span>
  )
}

export function UpdateButton() {
  const s = useUpdateState()
  const notify = useNotify()
  const { act, pending, dialog } = useUpdateActions()
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(false)
  const [pos, setPos] = useState<PopPos | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovering = useRef(false)
  const focused = useRef(false)
  const quiet = useRef(false)
  const summaryId = useId()
  const was = useRef(s?.status)
  useEffect(() => {
    if (was.current === 'downloading' && s?.status === 'downloaded') {
      notify('Update downloaded. Restart from the update button in the sidebar to install it.')
    }
    was.current = s?.status
  }, [s?.status, notify])

  const clearTimer = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const close = (): void => {
    clearTimer()
    setOpen(false)
  }

  const visible = showsUpdateButton(s)
  useEffect(() => {
    if (!visible) close()
  }, [visible])
  useEffect(() => clearTimer, [])
  useEffect(() => {
    if (!open) return
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      const inside = !!pop.current?.contains(document.activeElement)
      close()
      hovering.current = false
      if (inside) {
        quiet.current = true
        btn.current?.focus()
      }
    }
    // the window or the sidebar changed size under it: follow the item
    const follow = (): void => {
      if (btn.current) setPos(placeAbove(btn.current))
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('resize', follow)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('resize', follow)
    }
  }, [open])

  if (!s || !visible) return dialog ? <>{dialog}</> : null

  const openNow = (fromKeyboard: boolean): void => {
    clearTimer()
    if (btn.current) setPos(placeAbove(btn.current))
    setInstant(fromKeyboard)
    setOpen(true)
  }
  const maybeClose = (): void => {
    clearTimer()
    timer.current = setTimeout(() => {
      if (!hovering.current && !focused.current) setOpen(false)
    }, CLOSE_DELAY_MS)
  }
  const enter = (e: React.PointerEvent, delay: boolean): void => {
    if (e.pointerType !== 'mouse') return
    hovering.current = true
    if (open) return openNow(instant)
    clearTimer()
    if (delay) timer.current = setTimeout(() => openNow(false), OPEN_DELAY_MS)
    else openNow(false)
  }
  const leave = (e: React.PointerEvent): void => {
    if (e.pointerType !== 'mouse') return
    hovering.current = false
    maybeClose()
  }
  const focusIn = (e: React.FocusEvent): void => {
    focused.current = true
    if (quiet.current) {
      quiet.current = false
      return
    }
    if (!open && e.target === btn.current && btn.current.matches(':focus-visible')) openNow(true)
  }
  const focusOut = (e: React.FocusEvent): void => {
    const to = e.relatedTarget
    if (to && (btn.current?.contains(to) || pop.current?.contains(to))) return
    focused.current = false
    maybeClose()
  }

  // what the newer versions change, newest first (latest.json's notes, main/update-check.ts)
  const notes = s.notes.filter((n) => n.newer)
  const busy = s.status === 'downloading' || pending
  const version = s.downloadedVersion ?? s.availableVersion
  const notNow = async (): Promise<void> => {
    if (!version) return
    close()
    hovering.current = false
    document.querySelector<HTMLElement>('.sidebar nav [aria-current="page"]')?.focus()
    try {
      await reel.update.dismiss(version)
      notify('Hidden until tomorrow. You can still update from Settings.')
    } catch {
      notify('The update note could not be hidden. Try again in a moment.', 'error')
    }
  }

  return (
    <div className="update-wrap" onFocus={focusIn} onBlur={focusOut} data-testid="update-button-wrap">
      <button
        ref={btn}
        className={`update-pill ${updateIcon(s)}`}
        onClick={() => !busy && void act(s)}
        onPointerEnter={(e) => enter(e, true)}
        onPointerLeave={leave}
        aria-disabled={busy || undefined}
        aria-label={`${updateButtonLabel(s)}: Reel Studio ${version ?? s.currentVersion}`}
        aria-describedby={summaryId}
        title={s.status === 'downloading' ? undefined : updateSummary(s)}
        data-testid="update-button"
      >
        <StatusIcon s={s} />
        <span className="update-pill-text lbl">
          <span className="update-pill-label">{updateButtonLabel(s)}</span>
          <span className="update-pill-sub">{updateSubline(s)}</span>
        </span>
      </button>

      <span id={summaryId} className="sr-only">
        {s.status === 'downloading' ? '' : updateSummary(s)}
      </span>
      <div
        ref={pop}
        className="update-pop"
        data-open={open || undefined}
        data-instant={instant || undefined}
        style={pos ?? undefined}
        role="region"
        aria-label={`What's new in Reel Studio ${s.downloadedVersion ?? s.availableVersion ?? ''}`}
        aria-hidden={!open}
        onPointerEnter={(e) => enter(e, false)}
        onPointerLeave={leave}
        data-testid="update-popover"
      >
        <div className="update-pop-head">
          <div className="update-pop-title">{updateHeadline(s)}</div>
          <div className="update-pop-sub selectable">{s.status === 'error' ? updateSummary(s) : <>Reel Studio <span className="nowrap">{version}</span></>}</div>
        </div>
        {notes.map((n) => (
          <section className="update-pop-notes" key={n.version}>
            <h3>{notesHeading(n, notes.length)}</h3>
            <NoteText text={n.text} />
          </section>
        ))}
        {/* page mode only for want of a download key: with it, the update installs itself */}
        {s.keyNeeded && (
          <p className="update-pop-key">
            With the download link from your receipt, updates install themselves.{' '}
            <button className="update-pop-link inline" tabIndex={open ? 0 : -1} onClick={() => void reel.update.openAutoUpdatesPage().catch(() => notify('Reel Studio could not open that page. Try again in a moment.', 'error'))} data-testid="update-auto-link">
              Turn on automatic updates
            </button>
          </p>
        )}
        <div className="update-pop-foot">
          <button className="update-pop-link" tabIndex={open ? 0 : -1} onClick={() => openReleasePage(notify)} title="Opens getreelstudio.com in your browser" data-testid="update-release-link">
            Download page
            <Icon name="external" size={12} stroke={2} />
          </button>
          {s.status !== 'downloading' && (
            <button className="update-pop-link" tabIndex={open ? 0 : -1} onClick={() => void notNow()} data-testid="update-not-now">
              Not now
            </button>
          )}
        </div>
      </div>
      {dialog}
    </div>
  )
}
