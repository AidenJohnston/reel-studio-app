import { useEffect, useId, useRef, useState } from 'react'
import type { VersionInfo } from '../../../shared/api'
import { niceDate } from '../api'
import { Icon } from './icons'

const versionName = (n: number): string => (n === 0 ? 'Preview' : `Version ${n}`)

/** "3:41 PM" for today, the date otherwise. */
function madeAt(iso: string): string {
  const d = new Date(iso)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : niceDate(iso)
}

/**
 * Which version of the reel is showing, as one quiet line under its title: "Version 3 · Latest".
 * The arrows (and Left/Right while it has focus) step through versions, and the menu lists every
 * version, newest first, with what changed. An older version turns amber and offers a way back,
 * so it is never mistaken for the latest.
 */
export function VersionSwitch({
  versions,
  shown,
  changes,
  onPick
}: {
  versions: VersionInfo[]
  shown: number
  /** What each version changed (shared/versions.ts). */
  changes: Map<number, string>
  onPick: (n: number) => void
}) {
  // How the menu was opened: from the keyboard it appears at once (no animation on keyboard actions).
  const [open, setOpen] = useState<null | 'pointer' | 'keys'>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role=menuitemradio][aria-checked=true]')?.focus()
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(null)
    }
    window.addEventListener('mousedown', away)
    return () => window.removeEventListener('mousedown', away)
  }, [open])

  const latest = versions[versions.length - 1]
  const at = versions.findIndex((v) => v.n === shown)
  const older = shown !== latest.n
  const step = (by: -1 | 1) => {
    const to = at + by
    const v = versions[to]
    if (!v) return
    // The arrow just pressed is about to be disabled at either end: keep focus on the indicator.
    if ((to === 0 || to === versions.length - 1) && document.activeElement?.classList.contains('vswitch-step')) trigger.current?.focus()
    onPick(v.n)
  }
  const pick = (n: number) => {
    setOpen(null)
    trigger.current?.focus()
    onPick(n)
  }
  const closeAndReturn = () => {
    setOpen(null)
    trigger.current?.focus()
  }

  const onMenuKey = (e: React.KeyboardEvent) => {
    // Tab moves on from the indicator, so focus is not lost with the closing menu.
    if (e.key === 'Tab') return closeAndReturn()
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role=menuitemradio]') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    const go = (j: number) => items[(j + items.length) % items.length]?.focus()
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
    else if (e.key === 'Escape') closeAndReturn()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className={`vswitch${older ? ' older' : ''}`} ref={root}>
      {versions.length === 1 ? (
        <span className="vswitch-solo" data-testid="versions">
          {versionName(latest.n)}
        </span>
      ) : (
        <span className="vswitch-steps" data-testid="versions">
          <button className="vswitch-step" onClick={() => step(-1)} disabled={at <= 0} aria-label="Older version" title="Older version" data-testid="version-prev">
            <Icon name="chevron-left" size={16} />
          </button>
          <button
            ref={trigger}
            className="vswitch-current"
            aria-haspopup="menu"
            aria-expanded={!!open}
            aria-controls={open ? menuId : undefined}
            aria-keyshortcuts="ArrowLeft ArrowRight"
            onClick={(e) => setOpen(open ? null : e.detail === 0 ? 'keys' : 'pointer')}
            onKeyDown={(e) => {
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') step(e.key === 'ArrowLeft' ? -1 : 1)
              else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setOpen('keys')
              else if (e.key === 'Escape' && open) setOpen(null)
              else return
              e.preventDefault()
            }}
            data-testid="version-switch"
          >
            <span className="vswitch-name">{versionName(shown)}</span>
            <span className="vswitch-sep" aria-hidden>
              ·
            </span>
            <span className="vswitch-state">{older ? 'Older' : 'Latest'}</span>
            <Icon name="chevron-down" size={14} />
          </button>
          <button className="vswitch-step" onClick={() => step(1)} disabled={!older} aria-label="Newer version" title="Newer version" data-testid="version-next">
            <Icon name="chevron-right" size={16} />
          </button>
        </span>
      )}
      {older && (
        <button className="link vswitch-back" onClick={() => pick(latest.n)} data-testid="version-latest">
          Back to latest
        </button>
      )}
      <span className="vswitch-live" aria-live="polite">
        {`Showing ${versionName(shown)}${older ? ', an older version' : ''}`}
      </span>

      {open && (
        <div className="vmenu" id={menuId} role="menu" aria-label="Versions" data-instant={open === 'keys' || undefined} onKeyDown={onMenuKey} data-testid="version-menu">
          {[...versions].reverse().map((v) => {
            const what = changes.get(v.n)
            return (
              <button
                key={v.n}
                role="menuitemradio"
                aria-checked={v.n === shown}
                tabIndex={-1}
                className="vmenu-item"
                onClick={() => pick(v.n)}
                data-testid={`version-item-${v.n}`}
              >
                <span className="vmenu-top">
                  <span className="vmenu-name">{versionName(v.n)}</span>
                  {v.n === latest.n && <span className="vmenu-tag">Latest</span>}
                  <span className="vmenu-when">{madeAt(v.createdAt)}</span>
                  <span className="vmenu-check">{v.n === shown && <Icon name="check" size={16} stroke={2} />}</span>
                </span>
                {what && <span className="vmenu-what">{what}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
