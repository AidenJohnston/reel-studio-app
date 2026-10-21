import type { Go, Screen } from '../nav'
import { ConnectAI, USING_CLAUDE_CODE } from '../components/connect'
import { useNotify } from '../App'
import { Icon } from '../components/icons'

const BACK_LABEL: Record<Exclude<Screen, { name: 'connect' }>['name'], string> = {
  home: 'My videos',
  new: 'Back',
  script: 'Back to my script',
  working: 'Back to my video',
  reel: 'Back to my video',
  library: 'Library',
  style: 'My style',
  settings: 'Settings'
}

/** Where every "Connect" button goes: one simple screen, nothing else on it. */
export function Connect({ back, go }: { back?: Exclude<Screen, { name: 'connect' }>; go: Go }) {
  const notify = useNotify()
  const leave = () => go(back ?? { name: 'home' })
  return (
    <div className="page" style={{ maxWidth: 560 }} data-testid="connect-screen">
      <button className="back" onClick={leave} data-testid="connect-back">
        <Icon name="back" size={16} /> {BACK_LABEL[back?.name ?? 'home']}
      </button>
      <h1>Turn on your AI editor</h1>
      <p className="muted" style={{ margin: '8px 0 22px', fontSize: 16 }}>
        Sign in once. Then just tell me what to change, in plain words.
      </p>
      <div className="panel">
        <ConnectAI
          onConnected={(p) => {
            notify(p.id === 'claude-cli' ? USING_CLAUDE_CODE : `Connected to ${p.label}.`)
            leave()
          }}
        />
      </div>
    </div>
  )
}
