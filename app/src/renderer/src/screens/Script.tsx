import { useEffect, useState } from 'react'
import type { ProviderInfo, ScriptResult } from '../../../shared/api'
import { reel, userMessage } from '../api'
import type { Go } from '../nav'
import { Spinner } from '../components/ui'
import { Icon } from '../components/icons'
import { useNotify } from '../App'

export function Script({ go }: { go: Go }) {
  const notify = useNotify()
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ScriptResult | null>(null)
  // Check before they type: script help needs an AI editor (critique 2: no pink error after the fact).
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  useEffect(() => {
    reel.ai.active().then(setProvider).catch(() => {})
  }, [])
  const aiOff = !!provider && (!provider.connected || provider.id === 'none')

  const write = async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await reel.script.write(idea))
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const copy = async (t: string) => {
    await reel.app.copyText(t)
    notify('Copied.')
  }

  return (
    <div className="page narrow">
      <button className="back" onClick={() => go({ name: 'new' })}>
        <Icon name="back" size={16} /> New video
      </button>
      <div className="page-head">
        <div>
          <h1>Write a script</h1>
          <p className="muted">Tell me your idea. I'll write a hook and what to say, in your voice.</p>
        </div>
      </div>
      <div className="panel stack">
        <textarea className="textarea" aria-label="Your idea" placeholder="What is your video about?" value={idea} onChange={(e) => setIdea(e.target.value)} />
        <div className="row">
          <button className="btn primary" onClick={write} disabled={!idea.trim() || busy || aiOff} data-testid="write-script">
            {busy && <Spinner />} Write my script
          </button>
          {aiOff && (
            <p className="muted-sm" data-testid="script-needs-ai">
              Script help needs an AI editor.{' '}
              <button className="link inline" onClick={() => go({ name: 'connect' })}>
                Connect one
              </button>
            </p>
          )}
        </div>
        {error && (
          <div className="banner error">
            <span>{error}</span>
            <button className="btn small" onClick={() => go({ name: 'settings' })}>
              Settings
            </button>
          </div>
        )}
      </div>
      {result && (
        <>
          <section className="panel">
            <div className="row">
              <h2>Hook</h2>
              <span className="spacer" />
              <button className="btn small" onClick={() => copy(result.hook)}>
                Copy
              </button>
            </div>
            <p className="copy-box" style={{ marginTop: 10 }}>{result.hook}</p>
          </section>
          <section className="panel">
            <div className="row">
              <h2>What to say</h2>
              <span className="spacer" />
              <button className="btn small" onClick={() => copy(result.script)}>
                Copy
              </button>
            </div>
            <p className="copy-box" style={{ marginTop: 10 }}>{result.script}</p>
          </section>
          {result.onScreenText.length > 0 && (
            <section className="panel">
              <h2>Words on screen</h2>
              <ul>
                {result.onScreenText.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            </section>
          )}
          <div style={{ marginTop: 20 }}>
            <button className="btn primary big" onClick={() => go({ name: 'new' })}>
              I filmed it. Add my video
            </button>
          </div>
        </>
      )}
    </div>
  )
}
