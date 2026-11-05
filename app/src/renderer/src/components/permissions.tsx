// Ported from T3 Code: usePermissionStatus.ts.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PermissionStatus } from '../../../shared/api'
import { pollPermissions } from '../../../shared/permission-poll'
import { reel, userMessage } from '../api'
import { useNotify } from '../App'
import { Icon } from './icons'
import { ProviderRow, type Tone } from './provider-row'
import { Button, Spinner } from './ui'

/**
 * Set once the person has been asked about notifications: in the first run's Your Mac step, or during their first
 * Version 1 (Reel.tsx), which asks only someone the first run never asked.
 */
export const NOTIFY_ASKED = 'rs.notify-asked'
export function markNotifyAsked(): void {
  try {
    localStorage.setItem(NOTIFY_ASKED, '1')
  } catch {
    /* storage refused: the Reel screen may ask once more */
  }
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

/**
 * The first run's notification row (FirstRun.tsx Your Mac), as T3 Code's permission rows: the bell bare, what it is,
 * one status line, one pill. Allow shows a notification, which is when macOS asks; macOS never says yes to an app, so
 * after Allow the row says Turned on and keeps System Settings one press away. `onOn` runs when it is on.
 */
export function NotifyRow({ onOn }: { onOn: () => void }) {
  const notify = useNotify()
  const { status, apply } = usePermissionStatus()
  const [busy, setBusy] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  // Allow goes while macOS is asked, taking the focus with it; once there is an answer, focus goes to what the row
  // offers then (Ask again, System Settings). A yes hands it to the step's Continue instead (FirstRun.tsx).
  const refocus = useRef(false)
  const allow = async () => {
    refocus.current = true
    setBusy(true)
    try {
      apply(await reel.perm.setNotifications(true))
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const n = status?.notifications
  // on after Allow, or once a late answer from macOS comes in through the re-check
  useEffect(() => {
    if (n === 'unverified') onOn()
    // onOn is the step's setter; the answer is what changes
  }, [n])
  useEffect(() => {
    if (busy || !refocus.current || n === 'unverified') return
    refocus.current = false
    if (document.activeElement === document.body || document.activeElement === null) row.current?.querySelector<HTMLElement>('button')?.focus()
  }, [busy, n])
  // `asking` after Allow came back: macOS did not answer within 20 s (main/index.ts showTestNotification), so its
  // question may have gone unseen; Ask again shows another
  const asking = busy || n === 'asking'
  const settings = (kind: 'secondary' | 'tertiary') => (
    <Button size="small" kind={kind} onClick={() => void reel.perm.openSettings('notifications')} data-testid="perm-notify-settings">
      Open System Settings
    </Button>
  )
  const [line, tone, action]: [React.ReactNode, Tone, React.ReactNode] = asking
    ? [
        <span key="asking">
          <Spinner />
          Your Mac is asking, in the top-right corner of the screen
        </span>,
        'busy',
        busy ? null : (
          <Button kind="tertiary" size="small" onClick={() => void allow()} data-testid="perm-notify-again">
            Ask again
          </Button>
        )
      ]
    : n === 'unverified'
      ? [
          <span key="on">
            <Icon name="check" size={13} stroke={2.4} />
            Turned on. Your Mac decides whether they show.
          </span>,
          'ok',
          settings('tertiary')
        ]
      : n === 'blocked'
        ? ['Your Mac said no. Turn them on in System Settings.', 'error', settings('secondary')]
        : [
            'One per video, when it’s ready.',
            'plain',
            <Button kind="primary" size="small" onClick={() => void allow()} disabled={!status} data-testid="perm-notify-allow">
              Allow
            </Button>
          ]
  return (
    <div ref={row} data-testid="perm-notify" data-state={asking ? 'asking' : (n ?? 'loading')}>
      <ProviderRow mark={<Icon name="bell" size={20} stroke={1.75} />} name="Notifications" status={line} tone={tone} action={action} />
    </div>
  )
}
