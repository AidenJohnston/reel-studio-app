import type { AppInfo } from '../../../shared/api'
import { RELEASES_URL } from '../../../shared/config'
import { reel, userMessage } from '../api'
import type { Go } from '../nav'
import { ConnectAI, DevProviders, ModelDownload } from '../components/connect'
import { FOLDER_APP } from '../components/ui'
import { Icon } from '../components/icons'
import { useNotify } from '../App'

export function Settings({ info, onInfo }: { info: AppInfo; onInfo: (i: AppInfo) => void; go?: Go }) {
  const notify = useNotify()

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
        <ConnectAI onConnected={(p) => notify(`Connected to ${p.label}.`)} />
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

      <section className="panel">
        <h2>About</h2>
        <p className="muted" style={{ marginTop: 6 }}>
          Reel Studio {info.version}. Free and open source (MIT). No accounts, no tracking.
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          {/* Opens in the browser (window open handler); the app never checks for updates on its own. */}
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
