// The sidebar's update button, ported from T3 Code (apps/web/src/components/sidebar/SidebarUpdatePill.tsx and
// DesktopUpdateStatusIcon.tsx): a dot when a version is out, a progress ring while it downloads, a check badge
// once it is ready. Pointing at it (or tabbing to it) opens the "What's new" popover; clicking does the one
// thing its label says. It shows only when there is an update to act on, so it never sits in the way.
import { useEffect, useId, useRef, useState } from 'react'
import { releaseLinkLabel, showsUpdateButton, updateButtonLabel, updateHeadline, updateIcon, updateSubline, updateSummary, type UpdateState } from '../../../shared/update'
import { reel } from '../api'
import { useNotify } from '../App'
import { Icon } from './icons'
import { openReleasePage, useUpdateActions, useUpdateState } from './update'

const R = 12
const RING = 2 * Math.PI * R
const OPEN_DELAY_MS = 200
const CLOSE_DELAY_MS = 150

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
  // opened from the keyboard: appears at once, no slide (keyboard actions never animate)
  const [instant, setInstant] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The popover stays while the pointer is over the button or the popover, or focus is in either.
  const hovering = useRef(false)
  const focused = useRef(false)
  // Escape gives focus back to the button; that focus must not open the popover again.
  const quiet = useRef(false)
  const summaryId = useId()

  // "Update downloaded" once, when a download finishes (T3 Code: desktopUpdate.toast.tsx).
  const was = useRef(s?.status)
  useEffect(() => {
    if (was.current === 'downloading' && s?.status === 'downloaded') {
      notify('Restart from the update button in the sidebar to install it.', 'info', {
        title: 'Update downloaded',
        action: { label: 'Read more', run: () => openReleasePage(notify) }
      })
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
  // Escape also closes a popover opened by pointing, wherever focus is.
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
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [open])

  if (!s || !visible) return dialog ? <>{dialog}</> : null

  const openNow = (fromKeyboard: boolean): void => {
    clearTimer()
    const r = btn.current?.getBoundingClientRect()
    if (r) setPos({ left: r.right + 10, bottom: window.innerHeight - r.bottom })
    setInstant(fromKeyboard)
    setOpen(true)
  }
  const maybeClose = (): void => {
    clearTimer()
    timer.current = setTimeout(() => {
      if (!hovering.current && !focused.current) setOpen(false)
    }, CLOSE_DELAY_MS)
  }
  // Mouse only: a tap on a touch screen fires pointerenter too, and there the tap itself is the action.
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
    const to = e.relatedTarget as Node | null
    if (to && (btn.current?.contains(to) || pop.current?.contains(to))) return
    focused.current = false
    maybeClose()
  }

  const notes = s.releaseNotes
  const busy = s.status === 'downloading' || pending
  const version = s.downloadedVersion ?? s.availableVersion

  // "Not now" (the old update note's): the button goes away for 24 h; Settings and the menu still offer the update.
  const notNow = async (): Promise<void> => {
    if (!version) return
    close()
    hovering.current = false
    // the button is about to go: put focus somewhere that stays, the page you are on
    document.querySelector<HTMLElement>('.sidebar nav [aria-current="page"]')?.focus()
    try {
      await reel.update.dismiss(version)
      notify('Hidden until tomorrow. You can still update from Settings.')
    } catch {
      notify('I could not hide the update note. Try again in a moment.', 'error')
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
        aria-describedby={summaryId}
        data-testid="update-button"
      >
        <StatusIcon s={s} />
        <span className="update-pill-text">
          <span className="update-pill-label">{updateButtonLabel(s)}</span>
          <span className="update-pill-sub">{updateSubline(s)}</span>
        </span>
      </button>
      {/* the button's description: what is going on and what clicking does (the label already has the percentage) */}
      <span id={summaryId} className="sr-only">
        {s.status === 'downloading' ? '' : updateSummary(s)}
      </span>
      <div
        ref={pop}
        className="update-pop"
        data-open={open || undefined}
        data-instant={instant || undefined}
        style={pos ? { left: pos.left, bottom: pos.bottom } : undefined}
        role="region"
        aria-label={`What's new in Reel Studio ${s.downloadedVersion ?? s.availableVersion ?? ''}`}
        aria-hidden={!open}
        onPointerEnter={(e) => enter(e, false)}
        onPointerLeave={leave}
        data-testid="update-popover"
      >
        <div className="update-pop-head">
          <div className="update-pop-title">{updateHeadline(s)}</div>
          <div className="update-pop-sub">{s.status === 'error' ? updateSummary(s) : `Reel Studio ${s.downloadedVersion ?? s.availableVersion}`}</div>
        </div>
        {notes && (
          <section className="update-pop-notes">
            <h3>What's new</h3>
            <ul>
              {notes.items.map((t, i) => (
                <li key={`${i}:${t}`}>{t}</li>
              ))}
            </ul>
          </section>
        )}
        <div className="update-pop-foot">
          <button className="update-pop-link" tabIndex={open ? 0 : -1} onClick={() => openReleasePage(notify)} data-testid="update-release-link">
            {notes ? releaseLinkLabel(notes) : 'Read the release notes on GitHub'}
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
