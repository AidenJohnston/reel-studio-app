// Ported from T3 Code: PermissionChecklist.tsx and usePermissionStatus.ts.
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
  state: 'ask' | 'working' | 'allowed'
  onAllow: () => void
  problem?: ReactNode
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
          {/* Mounted from the start, so a screen reader hears each change. */}
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

/** `apply` takes an action's answer and drops a check already on its way, so the row never flips back for a moment. */
export function usePermissionStatus() {
  const [status, setStatus] = useState<PermissionStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  useEffect(() => {
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
  }, [])
  const apply = useCallback((s: PermissionStatus) => {
    generation.current++
    setStatus(s)
  }, [])
  return { status, error, apply }
}
