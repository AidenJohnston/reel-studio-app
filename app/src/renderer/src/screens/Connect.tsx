import type { Go } from '../nav'
import { ConnectAI, usingLine } from '../components/connect'
import { useNotify } from '../App'
import { Icon } from '../components/icons'

/** Where every "Connect" button goes: one simple screen, nothing else on it. */
export function Connect({ back, go }: { back?: { name: 'reel'; slug: string }; go: Go }) {
  const notify = useNotify()
  const leave = () => go(back ?? { name: 'home' })
  return (
    <div className="page" style={{ maxWidth: 560 }} data-testid="connect-screen">
      <button className="back" onClick={leave}>
        <Icon name="back" size={16} /> {back ? 'Back to my video' : 'My videos'}
      </button>
      <h1>Turn on your AI editor</h1>
      <p className="muted" style={{ margin: '8px 0 22px', fontSize: 16 }}>
        Sign in once. Then just tell me what to change, in plain words.
      </p>
      <div className="panel">
        <ConnectAI
          onConnected={(p) => {
            notify(usingLine(p))
            leave()
          }}
        />
      </div>
    </div>
  )
}
