import { useEffect, useState } from 'react'
import { ConnectAI } from '../../components/connect'
import { reel } from '../../api'
import { StageShell } from './StageShell'

export function ConnectStage({ onDone }: { onDone: () => void }) {
  // Already connected (chosen earlier, or just now in the panel) shows "Continue", not "Skip".
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const check = () => reel.ai.active().then((p) => setConnected(p.connected && p.id !== 'none')).catch(() => undefined)
    void check()
    const t = setInterval(check, 1500) // Disconnect inside the panel flips it back
    return () => clearInterval(t)
  }, [])
  return (
    <StageShell
      title="Connect your AI editor"
      description="It picks your best takes and changes your video when you tell me what you want."
      footer={
        connected ? (
          // already connected: "Skip" read like it would undo that (grandma 2)
          <button className="btn primary" onClick={onDone} data-testid="skip">
            Continue
          </button>
        ) : (
          <button className="link" onClick={onDone} data-testid="skip">
            Skip for now
          </button>
        )
      }
    >
      <ConnectAI onConnected={onDone} />
    </StageShell>
  )
}
