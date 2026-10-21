// "Your Mac": the folder for videos (needed) and notifications (optional), each asked right after its row says
// what it is for. After a "no", Allow opens the exact System Settings page with the helper beside it
// (main/permissions.ts, main/mac-permission-helper.ts). The local network is asked later, by Send to my phone.
import { useEffect, useRef, useState } from 'react'
import type { PermissionStatus } from '../../../../shared/api'
import { PermissionChecklist, usePermissionStatus, type PermissionItem } from '../../components/permissions'
import { Icon } from '../../components/icons'
import { Spinner } from '../../components/ui'
import { reel, userMessage } from '../../api'
import { useNotify } from '../../App'
import { StageShell } from './StageShell'

function folderItem(s: PermissionStatus, busy: boolean, allow: () => void, choose: () => void): PermissionItem {
  return {
    id: 'folder',
    icon: <Icon name="folder" />,
    title: 'A folder for your videos',
    description: s.folderDisplay,
    state: busy ? 'working' : s.folder === 'allowed' ? 'allowed' : 'ask',
    onAllow: allow,
    problem:
      s.folder === 'denied'
        ? 'Your Mac said no. Press Allow to turn it on in System Settings.'
        : s.folder === 'unusable'
          ? "I can't save in this folder. Use another one."
          : undefined,
    actions:
      s.folder === 'allowed' || busy ? undefined : (
        <button className="link inline" onClick={choose} data-testid="perm-folder-choose">
          Use another folder
        </button>
      )
  }
}

function notifyItem(s: PermissionStatus, busy: boolean, turnOn: () => void): PermissionItem | null {
  if (s.notifications === 'unsupported') return null
  const asking = busy || s.notifications === 'asking'
  return {
    id: 'notifications',
    icon: <Icon name="bell" />,
    title: 'Tell me when a video is ready',
    optional: true,
    description: asking ? 'Your Mac asks in the corner of the screen. Choose Allow.' : undefined,
    state: s.notifications === 'on' ? 'allowed' : asking ? 'working' : 'ask',
    onAllow: turnOn,
    problem: s.notifications === 'blocked' ? 'Your Mac said no. Press Allow to turn it on in System Settings.' : undefined,
    actions:
      s.notifications === 'asking' && !busy ? (
        <button className="link inline" onClick={turnOn} data-testid="perm-notifications-retry">
          Ask again
        </button>
      ) : undefined
  }
}

export function MacStage({ onNext }: { onNext: () => void }) {
  const notify = useNotify()
  const { status, error, apply } = usePermissionStatus()
  const [busy, setBusy] = useState<'folder' | 'notifications' | null>(null)
  const refocus = useRef(false)

  const run = (which: 'folder' | 'notifications', fn: () => Promise<PermissionStatus>) => async () => {
    setBusy(which)
    refocus.current = true
    try {
      apply(await fn())
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setBusy(null)
    }
  }
  const allowFolder = run('folder', () => reel.perm.allowFolder())
  const turnOn = run('notifications', () => reel.perm.setNotifications(true))
  // The system folder picker gives access to the folder picked in it, so no second question follows.
  const choose = async () => {
    const p = await reel.app.chooseFolder()
    if (!p) return
    await run('folder', async () => {
      await reel.app.setRoot(p)
      return reel.perm.status()
    })()
  }

  const ready = status?.folder === 'allowed'
  // A pressed Allow turns into "Allowed" and leaves the page, which drops keyboard focus; hand it to the next step.
  const continueRef = useRef<HTMLButtonElement>(null)
  const nextAllow = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!refocus.current || busy) return
    refocus.current = false
    if (document.activeElement !== document.body) return
    const pending = nextAllow.current?.querySelector<HTMLButtonElement>('[data-testid$="-allow"]')
    ;(ready ? continueRef.current : pending)?.focus()
  }, [status, busy, ready])
  const items = status ? [folderItem(status, busy === 'folder', allowFolder, choose), notifyItem(status, busy === 'notifications', turnOn)] : []
  return (
    <StageShell
      testid="stage-mac"
      title="Get your Mac ready"
      description="Reel Studio needs a folder for your videos."
      footer={
        <>
          <span className="stage-note" id="mac-note" role={error ? 'status' : undefined}>
            {error ?? (ready ? '' : 'Allow the folder to continue.')}
          </span>
          <button ref={continueRef} className="btn primary" disabled={!ready || busy !== null} aria-describedby="mac-note" onClick={onNext} data-testid="mac-continue">
            Continue
          </button>
        </>
      }
    >
      {status ? (
        <div ref={nextAllow}>
          <PermissionChecklist items={items.filter((i): i is PermissionItem => !!i)} busy={busy !== null} />
          <p className="perm-footnote" data-testid="perm-network">
            <Icon name="phone" size={15} /> Send to my phone asks about your local network the first time you use it.
          </p>
        </div>
      ) : (
        <div className="stage-loading">
          <Spinner />
        </div>
      )}
    </StageShell>
  )
}
