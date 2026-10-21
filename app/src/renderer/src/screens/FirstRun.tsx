import { useCallback, useEffect, useState } from 'react'
import { ConnectAI, ModelDownload } from '../components/connect'
import { Icon } from '../components/icons'
import { reel } from '../api'

export function FirstRun({ onDone }: { onDone: () => void; platform?: string }) {
  const [step, setStep] = useState(0)
  const next = useCallback(() => setStep((s) => Math.min(2, s + 1)), [])
  // On the AI step: already connected (chosen earlier, or just now in the panel) shows "Continue", not "Skip".
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    if (step !== 2) return
    const check = () => reel.ai.active().then((p) => setConnected(p.connected && p.id !== 'none')).catch(() => undefined)
    void check()
    const t = setInterval(check, 1500) // Disconnect inside the panel flips it back
    return () => clearInterval(t)
  }, [step])
  // On the model step: a model already on this computer gets "Ready", not "One download" (grandma3 #1).
  const [modelReady, setModelReady] = useState(false)
  useEffect(() => {
    if (step !== 1) return
    reel.model.status().then((m) => setModelReady(m.installed)).catch(() => undefined)
    return reel.model.onProgress((m) => setModelReady(m.installed))
  }, [step])
  return (
    <div className="first">
      <div className="first-card">
        <div className="steps">
          {[0, 1, 2].map((i) => (
            <span key={i} className={i <= step ? 'on' : ''} />
          ))}
        </div>
        {step === 0 && (
          <>
            <div className="hero-mark">
              <Icon name="play" size={32} stroke={1.75} />
            </div>
            <h1>Welcome to Reel Studio</h1>
            <p className="muted" style={{ fontSize: 17, maxWidth: 440 }}>
              Drop in a video of you talking. I cut it, add captions, music and a cover, and get it ready for Instagram.
            </p>
            <button className="btn primary big" onClick={next} data-testid="get-started">
              Get started
            </button>
          </>
        )}
        {step === 1 && (
          <>
            <h1 data-testid="model-heading">{modelReady ? 'Ready to listen' : 'One download, about 500 MB'}</h1>
            <p className="muted" style={{ fontSize: 17, maxWidth: 460 }}>
              {modelReady
                ? 'The listening model that understands what you say is already on this computer.'
                : 'I need a listening model to understand what you say. It only downloads once.'}
            </p>
            <div className="panel">
              <ModelDownload onReady={next} />
            </div>
            {!modelReady && (
              <>
                <button className="link" onClick={next} data-testid="later">
                  Do this later
                </button>
                <p className="muted-sm" style={{ marginTop: -12 }}>You'll need it before your first video.</p>
              </>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <h1>Connect your AI editor</h1>
            <p className="muted" style={{ fontSize: 17, maxWidth: 460 }}>
              It picks your best takes and changes your video when you tell me what you want. You can also do this later.
            </p>
            <div className="panel">
              <ConnectAI onConnected={onDone} />
            </div>
            {connected ? (
              // already connected: "Skip" read like it would undo that (grandma 2)
              <button className="btn primary big" onClick={onDone} data-testid="skip">
                Continue
              </button>
            ) : (
              <button className="link" onClick={onDone} data-testid="skip">
                Skip for now
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
