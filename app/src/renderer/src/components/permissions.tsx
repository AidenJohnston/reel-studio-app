// A permission checklist, ported from T3 Code (PermissionChecklist.tsx, usePermissionStatus.ts): one row per thing
// the Mac is asked, each with what it is for and one button. Used by first run (screens/setup/MacStage.tsx).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PermissionStatus } from '../../../shared/api'
import { pollPermissions } from '../../../shared/permission-poll'
import { reel } from '../api'
import { Icon } from './icons'
import { Spinner } from './ui'

export interface PermissionItem {
  id: string
  icon: ReactNode
  title: string
  description?: ReactNode
  optional?: boolean
  /** ask = an Allow button; working = waiting for the Mac's answer. */
  state: 'ask' | 'working' | 'allowed'
  onAllow: () => void
  /** What went wrong and how to fix it, in plain words. */
  problem?: ReactNode
  /** Quieter fixes under the text (Open System Settings, Use another folder). */
  actions?: ReactNode
}

export function PermissionChecklist({ items, busy = false }: { items: readonly PermissionItem[]; busy?: boolean }) {
  return (
    <ul className="perm-list">
      {items.map((p) => (
        <li key={p.id} className={`perm-row${p.problem ? ' has-problem' : ''}`} data-testid={`perm-${p.id}`} data-state={p.state}>
          <span className="perm-icon" aria-hidden>
            {p.icon}
          </span>
          <div className="perm-text">
            <p className="perm-title" id={`perm-${p.id}-title`}>
              {p.title}
              {p.optional && <span className="perm-optional">Optional</span>}
            </p>
            {p.description && <p className="perm-desc">{p.description}</p>}
            {p.problem && (
              <p className="perm-problem" role="alert" data-testid={`perm-${p.id}-problem`}>
                {p.problem}
              </p>
            )}
            {p.actions && <div className="perm-actions">{p.actions}</div>}
          </div>
          {/* Mounted from the start, so a screen reader hears each change: "A folder for your videos: allowed". */}
          <span className="sr-only" role="status">
            {p.state === 'allowed' ? `${p.title}: allowed` : p.state === 'working' ? `${p.title}: waiting for your Mac` : ''}
          </span>
          <div className="perm-end">
            {p.state === 'allowed' ? (
              <span className="perm-ok">
                <Icon name="check" size={16} stroke={2.25} />
                Allowed
              </span>
            ) : p.state === 'working' ? (
              <span className="perm-wait">
                <Spinner /> Asking
              </span>
            ) : (
              <button
                className="btn small"
                disabled={busy}
                onClick={p.onAllow}
                aria-describedby={`perm-${p.id}-title`}
                data-testid={`perm-${p.id}-allow`}
              >
                Allow
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * The live status: checked right away, every 1.5 s while the window is visible, and when it gets focus again
 * (shared/permission-poll.ts). `apply` takes the answer an action returned; a check that was already on its way
 * when the action finished is dropped, so the row never flips back for a moment.
 */
export function usePermissionStatus(enabled = true) {
  const [status, setStatus] = useState<PermissionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
    if (!enabled) return
    return pollPermissions(
      async () => {
        const g = generation.current
        return { g, s: await reel.perm.status() }
      },
      {
        status: (r) => {
          if (r.g === generation.current) setStatus(r.s)
        },
        error: setError
      },
      {
        hidden: () => document.visibilityState === 'hidden',
        every: (fn, ms) => {
          const t = window.setInterval(fn, ms)
          return () => window.clearInterval(t)
        },
        onWake: (fn) => {
          window.addEventListener('focus', fn)
          document.addEventListener('visibilitychange', fn)
          return () => {
            window.removeEventListener('focus', fn)
            document.removeEventListener('visibilitychange', fn)
          }
        }
      }
    )
  }, [enabled])
  const apply = useCallback((s: PermissionStatus) => {
    generation.current++
    setStatus(s)
  }, [])
  return { status, error, apply }
}
