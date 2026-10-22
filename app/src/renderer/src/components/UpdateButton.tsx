import { useEffect, useId, useRef, useState } from 'react'
import { RELEASES_URL } from '../../../shared/config'
import { showsUpdateButton, type UpdateState } from '../../../shared/update'
import { notesHeading, releaseLinkLabel, updateButtonLabel, updateHeadline, updateIcon, updateSubline, updateSummary } from './update-copy'
import { reel } from '../api'
import { useNotify } from '../App'
import { Icon } from './icons'
import { FadeScroll } from './ui'
import { openReleasePage, useUpdateActions, useUpdateState } from './update'

const R = 14
const RING = 2 * Math.PI * R
const OPEN_DELAY_MS = 200
const CLOSE_DELAY_MS = 150
const GAP = 6

function StatusIcon({ s }: { s: UpdateState }) {
  const kind = updateIcon(s)
  const pct = Math.min(100, Math.max(0, s.downloadPercent ?? 0))
  return (
    <span className={`update-icon ${kind}`} aria-hidden>
      {kind === 'downloading' && (
        <svg className="update-ring" viewBox="0 0 32 32">
          <circle cx="16" cy="16" r={R} className="track" />
          <circle cx="16" cy="16" r={R} className="bar" strokeDasharray={RING} strokeDashoffset={RING * (1 - pct / 100)} />
        </svg>
      )}
      <span className="update-glyph">
        <Icon name={kind === 'downloaded' ? 'restart' : 'download'} size={16} stroke={1.75} />
        {kind === 'available' && <span className="update-dot" />}
        {kind === 'downloaded' && (
          <span className="update-badge">
            <Icon name="check" size={8} stroke={3.5} />
          </span>
        )}
      </span>
    </span>
  )
}

export function UpdateButton() {
  const s = useUpdateState()
  const notify = useNotify()
  const { act, pending, dialog } = useUpdateActions()
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(false)
  const [pos, setPos] = useState<{ left: number; bottom: number; room: number } | null>(null)
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
      const inside = !!pop.current?.contains(document.activeElement)
      if (inside || document.activeElement === btn.current) e.stopPropagation()
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
    if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top + GAP, room: r.top - GAP - 12 })
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

  const kind = updateIcon(s)
  const busy = s.status === 'downloading' || pending
  const version = s.downloadedVersion ?? s.availableVersion
  const notes = s.releaseNotes
  const tab = open ? 0 : -1
  const notNow = async (): Promise<void> => {
    if (!version) return
    close()
    hovering.current = false
    document.querySelector<HTMLElement>('.sidebar nav [aria-current="page"]')?.focus()
    try {
      await reel.update.dismiss(version)
      notify('Hidden until tomorrow. You can still update from Settings.')
    } catch {
      notify('I could not hide the update note. Try again in a moment.', 'error')
    }
  }
  const openVersion = (v: string): void =>
    void reel.update.openRelease(v).catch(() => notify('I could not open the release page. Try again in a moment.', 'error'))

  return (
    <>
      <div className="update-strip" onFocus={focusIn} onBlur={focusOut} data-testid="update-button-wrap">
        <button
          ref={btn}
          className={`update-pill ${kind}`}
          onClick={() => !busy && void act(s)}
          onPointerEnter={(e) => enter(e, true)}
          onPointerLeave={leave}
          aria-disabled={busy || undefined}
          aria-describedby={summaryId}
          data-testid="update-button"
        >
          <span className="update-pill-label">{updateButtonLabel(s)}</span>
          {kind === 'failed' ? <span className="update-pill-retry">Retry</span> : <StatusIcon s={s} />}
        </button>

        <span id={summaryId} className="sr-only">
          {s.status === 'downloading' ? '' : updateSummary(s)}
        </span>
        <div
          ref={pop}
          className="update-pop"
          data-open={open || undefined}
          data-instant={instant || undefined}
          style={pos ? ({ left: pos.left, bottom: pos.bottom, '--room': `${pos.room}px` } as React.CSSProperties) : undefined}
          role="region"
          aria-label={`What's new in Reel Studio ${version ?? ''}`}
          aria-hidden={!open}
          onPointerEnter={(e) => enter(e, false)}
          onPointerLeave={leave}
          data-testid="update-popover"
        >
          <div className="update-pop-head">
            <div className="update-pop-heading">
              <div className="update-pop-title">{updateHeadline(s)}</div>
              <div className={`update-pop-sub${s.status === 'error' ? ' failed' : ''}`}>{updateSubline(s)}</div>
            </div>
            {kind === 'failed' && (
              <button className="update-pop-quiet" tabIndex={tab} onClick={() => !busy && void act(s)} data-testid="update-retry">
                Retry
              </button>
            )}
            {s.status !== 'downloading' && (
              <button className="update-pop-quiet" tabIndex={tab} onClick={() => void notNow()} data-testid="update-not-now">
                Not now
              </button>
            )}
          </div>
          <FadeScroll className="update-notes" testid="update-notes">
            {notes.map((n, i) => (
              <section key={n.version}>
                <h3>{notesHeading(n, notes.length)}</h3>
                <ul>
                  {n.items.map((t, j) => (
                    <li key={`${j}:${t}`}>{t}</li>
                  ))}
                </ul>
                <button
                  className="update-pop-link"
                  tabIndex={tab}
                  onClick={() => openVersion(n.version)}
                  aria-label={`${releaseLinkLabel(n)}: Reel Studio ${n.version}`}
                  data-testid={i === 0 ? 'update-release-link' : undefined}
                >
                  {releaseLinkLabel(n)}
                  <Icon name="external" size={12} stroke={2} />
                </button>
              </section>
            ))}
            {!notes.length && (
              <section>
                <button className="update-pop-link" tabIndex={tab} onClick={() => openReleasePage(notify)} data-testid="update-release-link">
                  Read the release notes on GitHub
                  <Icon name="external" size={12} stroke={2} />
                </button>
              </section>
            )}
            {s.olderNotes > 0 && (
              <section>
                <a className="update-pop-link" tabIndex={tab} href={RELEASES_URL} target="_blank" rel="noreferrer">
                  {s.olderNotes} older {s.olderNotes === 1 ? 'release' : 'releases'} on GitHub
                  <Icon name="external" size={12} stroke={2} />
                </a>
              </section>
            )}
          </FadeScroll>
        </div>
      </div>
      {dialog}
    </>
  )
}
