import { useEffect, useState } from 'react'
import type { AppInfo, PermissionStatus } from '../../../shared/api'
import { RELEASES_URL } from '../../../shared/config'
import { reel, userMessage } from '../api'
import type { Go } from '../nav'
import { ConnectAI, DevProviders, ModelDownload, usingLine } from '../components/connect'
import { usePermissionStatus } from '../components/permissions'
import { FOLDER_APP } from '../components/ui'
import { Icon } from '../components/icons'
import { useNotify } from '../App'

export function Settings({ info, onInfo }: { info: AppInfo; onInfo: (i: AppInfo) => void; go?: Go }) {
  const notify = useNotify()
  const [checkUpdates, setCheckUpdates] = useState<boolean | null>(null)
  useEffect(() => {
    reel.update
      .status()
      .then((st) => setCheckUpdates(st.enabled))
      .catch(() => {})
  }, [])
  const toggleUpdates = async (on: boolean) => {
    setCheckUpdates(on)
    try {
      setCheckUpdates((await reel.update.setEnabled(on)).enabled)
    } catch (e) {
      setCheckUpdates(!on)
      notify(userMessage(e), 'error')
    }
  }

  // Re-checked while Settings is open, so a change made in System Settings shows here.
  const { status: perm, apply } = usePermissionStatus()
  // What a request that is still out asked for. "asking" can also mean macOS never answered; the switch stays usable.
  const [pending, setPending] = useState<'folder' | { notifications: boolean } | null>(null)
  const request = async (what: NonNullable<typeof pending>, fn: () => Promise<PermissionStatus>) => {
    setPending(what)
    try {
      apply(await fn())
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setPending(null)
    }
  }
  const toggleAlerts = (on: boolean) => request({ notifications: on }, () => reel.perm.setNotifications(on))
  const alerts = perm?.notifications
  const alertsOn = pending && pending !== 'folder' ? pending.notifications : alerts !== 'off'
  const isMac = info.platform === 'darwin'

  const change = async () => {
    const p = await reel.app.chooseFolder()
    if (!p) return
    try {
      onInfo(await reel.app.setRoot(p))
      notify('New videos will be kept there. Your old videos stay where they were.')
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Settings</h1>
      </div>

      <section className="panel">
        <h2>Your AI editor</h2>
        <p className="muted" style={{ margin: '6px 0 14px' }}>
          It picks your best takes, adds pictures that match what you say, and changes your video from your notes.
        </p>
        <ConnectAI onConnected={(p) => notify(usingLine(p))} />
      </section>

      <section className="panel">
        <h2>Listening model</h2>
        <p className="muted" style={{ margin: '6px 0 12px' }}>
          Turns your voice into words. About 500 MB, one time only.
        </p>
        <ModelDownload />
      </section>

      <section className="panel">
        <h2>Where your videos are kept</h2>
        <p className="folder-line" title={info.root} data-testid="root-display">
          <Icon name="folder" /> {info.rootDisplay}
        </p>
        {perm && perm.folder !== 'allowed' && (
          <p className="perm-problem" role="alert" style={{ margin: '0 0 12px' }} data-testid="folder-problem">
            {perm.folder === 'unusable'
              ? "I can't save in this folder. Choose another one."
              : perm.folder === 'denied'
                ? "Your Mac isn't letting Reel Studio use this folder. Press Allow to turn it on in System Settings."
                : 'Press Allow so Reel Studio can use this folder.'}
          </p>
        )}
        <div className="row">
          {perm && (perm.folder === 'denied' || perm.folder === 'not-asked') && (
            <button className="btn primary" disabled={pending === 'folder'} onClick={() => void request('folder', () => reel.perm.allowFolder())} data-testid="folder-allow">
              Allow
            </button>
          )}
          <button className="btn" onClick={() => reel.app.openFolder(info.root)}>
            Show in {FOLDER_APP}
          </button>
          <button className="btn ghost" onClick={change}>
            Change…
          </button>
        </div>
      </section>

      {alerts !== undefined && alerts !== 'unsupported' && (
        <section className="panel">
          <h2>When a video is ready</h2>
          <label className="toggle" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={alertsOn}
              disabled={pending !== null && pending !== 'folder'}
              onChange={(e) => void toggleAlerts(e.target.checked)}
              data-testid="notifications-toggle"
            />
            Tell me with a notification
          </label>
          <p className="muted-sm" style={{ margin: '2px 0 0 30px' }} data-testid="notifications-note">
            {alerts === 'asking'
              ? 'Your Mac asks in the top-right corner of the screen. Choose Allow.'
              : alerts === 'blocked'
                ? 'Notifications are off for Reel Studio on this computer. Turn them on in your system settings, then press Try again.'
                : alerts === 'unverified' && isMac
                  ? "Your Mac decides whether they show. If you don't see them, turn them on in System Settings."
                  : 'So you can do other things while your video is being made.'}
          </p>
          {alerts !== 'off' && (isMac || alerts === 'asking' || alerts === 'blocked') && (
            <div className="row" style={{ marginTop: 10, marginLeft: 30 }}>
              {isMac && (
                <button className="btn small" onClick={() => void reel.perm.openSettings('notifications')} data-testid="notifications-settings">
                  Open System Settings
                </button>
              )}
              {alerts === 'asking' && pending === null && (
                <button className="btn small ghost" onClick={() => void toggleAlerts(true)}>
                  Ask again
                </button>
              )}
              {alerts === 'blocked' && (
                <button className="btn small ghost" onClick={() => void toggleAlerts(true)}>
                  Try again
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {info.dev && (
        <section className="panel">
          <h2>Developer: AI provider</h2>
          <p className="muted-sm" style={{ margin: '6px 0 12px' }}>Shown because REELSTUDIO_DEV=1.</p>
          <DevProviders />
        </section>
      )}

      <section className="panel">
        <h2>About</h2>
        <p className="muted" style={{ marginTop: 6 }}>
          Reel Studio {info.version}. Free and open source (MIT). No accounts, no tracking.
        </p>
        {checkUpdates !== null && (
          <>
            <label className="toggle" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={checkUpdates} onChange={(e) => void toggleUpdates(e.target.checked)} data-testid="check-updates" />
              Check for updates
            </label>
            <p className="muted-sm" style={{ margin: '2px 0 0 30px' }}>
              Once a day, Reel Studio asks GitHub if there is a newer version. Nothing about you or your videos is sent.
            </p>
          </>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          {/* Opens the releases page in the browser (window open handler). The automatic check is main/update-check.ts. */}
          <a className="btn ghost" href={RELEASES_URL} target="_blank" rel="noreferrer">
            <Icon name="external" size={16} /> Check for a newer version
          </a>
        </div>
        {info.engine.mode === 'fake' && (
          <p className="muted-sm" style={{ marginTop: 6 }}>
            Test engine in use.
          </p>
        )}
      </section>
    </div>
  )
}
