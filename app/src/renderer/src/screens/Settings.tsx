import { useEffect, useState } from 'react'
import type { AppInfo, UpdateKeyStatus } from '../../../shared/api'
import { reel, userMessage } from '../api'
import type { Go } from '../nav'
import { ConnectAI, DevProviders, ModelDownload, usingLine } from '../components/connect'
import { FOLDER_APP } from '../components/ui'
import { PostingSettings } from '../components/PostingSettings'
import { Icon } from '../components/icons'
import { useUpdateState } from '../components/update'
import { UpdateSettingsRow } from '../components/UpdateSettings'
import { useNotify } from '../App'

export function Settings({ info, onInfo }: { info: AppInfo; onInfo: (i: AppInfo) => void; go?: Go }) {
  const notify = useNotify()
  const update = useUpdateState()
  const [autoUpdates, setAutoUpdates] = useState<UpdateKeyStatus | null>(null)
  useEffect(() => {
    reel.updateKey
      .status()
      .then(setAutoUpdates)
      .catch(() => {})
    return reel.updateKey.onChange(setAutoUpdates)
  }, [])
  const pasteKey = async () => {
    try {
      setAutoUpdates(await reel.updateKey.paste())
      notify('Automatic updates are on.')
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }
  const clearKey = async () => {
    try {
      setAutoUpdates(await reel.updateKey.clear())
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }
  const toggleUpdates = async (on: boolean) => {
    try {
      await reel.update.setEnabled(on)
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

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
        <ModelDownload secondary />
      </section>

      <section className="panel">
        <h2>Where your videos are kept</h2>
        <p className="folder-line" title={info.root} data-testid="root-display">
          <Icon name="folder" /> {info.rootDisplay}
        </p>
        <div className="row">
          <button className="btn" onClick={() => reel.app.openFolder(info.root)}>
            Show in {FOLDER_APP}
          </button>
          <button className="btn ghost" onClick={change}>
            Change…
          </button>
        </div>
      </section>

      {info.dev && (
        <section className="panel">
          <h2>Developer: AI provider</h2>
          <p className="muted-sm" style={{ margin: '6px 0 12px' }}>Shown because REELSTUDIO_DEV=1.</p>
          <DevProviders />
        </section>
      )}

      <PostingSettings />

      <section className="panel">
        <h2>About</h2>
        <p className="muted" style={{ marginTop: 6 }}>
          Reel Studio {info.version}. Open source (AGPL-3.0). No accounts, no tracking.
        </p>
        <p className="muted-sm" style={{ marginTop: 6 }}>
          Copyright 2026 Curate Technologies LLC and contributors. You may share and change it under the GNU AGPL v3, and it
          comes with no warranty. License: gnu.org/licenses/agpl-3.0. Source: github.com/getcurate/reel-studio.
        </p>
        {autoUpdates !== null && (
          <div style={{ marginTop: 12 }} data-testid="auto-updates">
            <p style={{ margin: 0 }}>
              <strong>Automatic updates:</strong>{' '}
              {autoUpdates.on ? `on${autoUpdates.plan === 'monthly' ? ' (monthly plan)' : ''}` : 'off'}
            </p>
            <p className="muted-sm" style={{ margin: '2px 0 0' }}>
              {autoUpdates.on
                ? 'When a new version comes out, Reel Studio offers to update itself. Only that download carries your download key, so the server can check your purchase.'
                : 'Turn them on with the link in your receipt email: copy it, then paste it here.'}
            </p>
            <div className="row" style={{ marginTop: 8 }}>
              {autoUpdates.on ? (
                <button className="btn ghost" onClick={() => void clearKey()} data-testid="auto-updates-off">
                  Turn off
                </button>
              ) : (
                <button className="btn ghost" onClick={() => void pasteKey()} data-testid="auto-updates-paste">
                  Paste my download link
                </button>
              )}
            </div>
          </div>
        )}
        {update !== null && (
          <>
            <label className="toggle" style={{ marginTop: 12 }}>
              <input type="checkbox" checked={update.autoCheck} onChange={(e) => void toggleUpdates(e.target.checked)} data-testid="check-updates" />
              Check for updates
            </label>
            <p className="muted-sm" style={{ margin: '2px 0 0 30px' }}>
              Once a day, Reel Studio asks getreelstudio.com if there is a newer version. Nothing about you or your videos is sent.
            </p>
          </>
        )}
        <UpdateSettingsRow />
        {info.engine.mode === 'fake' && (
          <p className="muted-sm" style={{ marginTop: 6 }}>
            Test engine in use.
          </p>
        )}
      </section>
    </div>
  )
}
