import { useCallback, useEffect, useState } from 'react'
import type { ModelStatus, ProviderInfo } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Progress, Spinner } from './ui'
import { Icon } from './icons'
import { Connections } from './Connections'
import { USING_CLAUDE_CODE, USING_CODEX, VendorCards } from './vendor-connect'

export { USE_CLAUDE_CODE, USE_CODEX, USING_CLAUDE_CODE, USING_CODEX } from './vendor-connect'

/** What works with no AI at all. One honest line, shown wherever we ask people to connect. */
export const WITHOUT_AI =
  'Without AI, Reel Studio still cuts the pauses and repeated starts, adds subtitles, your music and a cover. ' +
  'With AI it also picks your best takes, adds pictures, writes your post caption and changes the video from your notes.'

/** The "connected" line for the person's own apps, else "Connected to <label>". */
export const usingLine = (p: ProviderInfo): string =>
  p.id === 'claude-cli' ? USING_CLAUDE_CODE : p.id === 'codex-cli' ? USING_CODEX : `Connected to ${p.label}${p.detail ? ` (${p.detail})` : ''}.`

/**
 * Connect your AI editor, for normal people: "Connect Claude" and "Connect ChatGPT" (vendor-connect.tsx), each of which
 * installs the person's own AI app if needed and opens that vendor's own sign-in page. Whatever the person already has
 * comes first. "Use an Anthropic API key" and "Use your own AI server" (Connections.tsx) stay the quiet advanced
 * choices. Used by the Connect screen, Settings and First run.
 */
export function ConnectAI({ onConnected }: { onConnected?: (p: ProviderInfo) => void }) {
  const [active, setActive] = useState<ProviderInfo | null>(null)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  // Once connected, the choices fold away behind "Use a different AI…" (critique 2).
  const [showOther, setShowOther] = useState(false)
  const [busy, setBusy] = useState<'claude' | null>(null)
  const [error, setError] = useState<{ text: string; link?: string } | null>(null)

  const fail = (e: unknown) => setError({ text: userMessage(e), link: (e as { link?: string })?.link })

  const done = useCallback(
    (p: ProviderInfo) => {
      setActive(p)
      setError(null)
      setShowOther(false)
      if (p.connected && p.id !== 'none') onConnected?.(p)
    },
    [onConnected]
  )

  useEffect(() => {
    reel.ai.active().then(setActive).catch(() => {})
  }, [])

  const claudeKey = async () => {
    setBusy('claude')
    setError(null)
    try {
      done(await reel.ai.setClaudeKey(key.trim()))
      setKey('')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const connected = !!active && active.connected && active.id !== 'none'
  const choices = !connected || showOther

  return (
    <div className="stack">
      {connected && (
        <div className="banner good" data-testid="ai-connected-banner">
          <Icon name="done" />
          <span data-testid="ai-connected">{usingLine(active!)}</span>
          <button
            className="btn small"
            onClick={async () => {
              await reel.ai.setActive('none')
              setActive(await reel.ai.active())
            }}
            data-testid="use-no-ai"
          >
            Disconnect
          </button>
        </div>
      )}
      {connected && !showOther && (
        <button className="link left" onClick={() => setShowOther(true)} data-testid="use-different-ai">
          Use a different AI…
        </button>
      )}
      {choices && <VendorCards activeId={active?.id} onConnected={done} />}
      {!choices ? null : !showKey ? (
        <button className="link center" onClick={() => setShowKey(true)} data-testid="claude-key-toggle">
          Use an Anthropic API key (advanced)
        </button>
      ) : (
        <>
          <div className="row">
            <input
              className="input"
              type="password"
              autoFocus
              placeholder="Paste your Anthropic API key"
              aria-label="Anthropic API key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && key.trim()) void claudeKey()
              }}
              data-testid="claude-key-input"
            />
            <button className="btn" onClick={claudeKey} disabled={!key.trim() || !!busy} data-testid="use-claude-key">
              {busy === 'claude' ? <Spinner /> : null} Use this key
            </button>
          </div>
          <p className="muted-sm">
            No key?{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              Get one here
            </a>
            . An API key is billed by Anthropic as you use it, separate from a Claude subscription.
          </p>
        </>
      )}
      {choices && <Connections onConnected={done} />}
      {active?.error && !error && <div className="banner error">{active.error.userMessage}</div>}
      {error && (
        <div className="banner error">
          <span>{error.text}</span>
          {error.link && (
            <a className="btn small" href={error.link} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
        </div>
      )}
      {!connected && (
        <p className="muted" data-testid="without-ai" style={{ fontSize: 14 }}>
          {WITHOUT_AI}
        </p>
      )}
    </div>
  )
}

/** Every provider as a chip, for developers (REELSTUDIO_DEV=1 adds the retired ChatGPT sign-in and replay). Never shown to users. */
export function DevProviders() {
  const [list, setList] = useState<ProviderInfo[]>([])
  const [active, setActive] = useState<string>('')
  const load = () => {
    reel.ai.providers().then(setList)
    reel.ai.active().then((a) => setActive(a.id))
  }
  useEffect(load, [])
  return (
    <div className="row wrap">
      {list.map((p) => (
        <button
          key={p.id}
          className={`chip${p.id === active ? ' active' : ''}`}
          onClick={async () => {
            await reel.ai.setActive(p.id)
            load()
          }}
          data-testid={`provider-${p.id}`}
        >
          {p.label}
        </button>
      ))}
    </div>
  )
}

/** One-time speech model download with progress. `secondary` on Settings, where the AI editor is the main action. */
export function ModelDownload({ onReady, secondary }: { onReady?: () => void; secondary?: boolean }) {
  const [s, setS] = useState<ModelStatus | null>(null)
  useEffect(() => {
    reel.model.status().then(setS)
    return reel.model.onProgress((m) => {
      setS(m)
      if (m.installed) onReady?.()
    })
  }, [onReady])
  if (!s) return <Spinner />
  if (s.installed)
    return (
      <div className="stack">
        <div className="banner good">The listening model is ready.</div>
        {onReady && (
          <button className="btn primary big" onClick={onReady} data-testid="model-next">
            Next
          </button>
        )}
      </div>
    )
  return (
    <div className="stack">
      {s.downloading ? (
        <>
          <Progress pct={s.pct} />
          <div className="row">
            <span className="muted">Downloading… {s.pct}%</span>
            <span className="spacer" />
            <button className="btn small ghost" onClick={() => reel.model.cancel()}>
              Pause
            </button>
          </div>
        </>
      ) : (
        <button className={`btn big${secondary ? '' : ' primary'}`} onClick={() => reel.model.download().then(setS)} data-testid="download-model">
          {s.pct > 0 && s.pct < 100 ? 'Keep downloading' : 'Download'}
        </button>
      )}
      {s.error && <div className="banner error">{s.error}</div>}
    </div>
  )
}
