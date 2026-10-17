import { useEffect, useState } from 'react'
import type { ModelStatus, ProviderInfo } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Progress, Spinner } from './ui'
import { Icon } from './icons'

/** What works with no AI at all. One honest line, shown wherever we ask people to connect. */
export const WITHOUT_AI =
  'Without AI, Reel Studio still cuts the pauses and repeated starts, adds subtitles, your music and a cover. ' +
  'With AI it also picks your best takes, adds pictures, writes your post caption and changes the video from your notes.'

/**
 * Connect your AI editor, for normal people: one big "Sign in with ChatGPT" (most people have it),
 * "I have a Claude key" as the quiet second choice, and in the local Claude Code build "Use Claude Code on
 * this computer". Used by the Connect screen, Settings and First run.
 */
export function ConnectAI({ onConnected }: { onConnected?: (p: ProviderInfo) => void }) {
  const [active, setActive] = useState<ProviderInfo | null>(null)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  // Once connected, the sign-in choices fold away behind "Use a different AI…" (critique 2).
  const [showOther, setShowOther] = useState(false)
  const [busy, setBusy] = useState<'chatgpt' | 'claude' | 'local' | null>(null)
  const [error, setError] = useState<{ text: string; link?: string } | null>(null)
  // Local Claude Code build only: the Claude Code already signed in on this computer.
  const [local, setLocal] = useState<ProviderInfo | null>(null)

  useEffect(() => {
    reel.ai.active().then(setActive).catch(() => {})
    reel.ai
      .providers()
      .then((list) => setLocal(list.find((p) => p.id === 'claude-cli') ?? null))
      .catch(() => {})
  }, [])
  const fail = (e: unknown) => setError({ text: userMessage(e), link: (e as { link?: string })?.link })

  const done = (p: ProviderInfo) => {
    setActive(p)
    setError(null)
    setShowOther(false)
    if (p.connected && p.id !== 'none') onConnected?.(p)
  }

  const chatgpt = async () => {
    setBusy('chatgpt')
    setError(null)
    try {
      done(await reel.ai.signInChatGPT())
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const claude = async () => {
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

  const useLocal = async () => {
    setBusy('local')
    setError(null)
    try {
      await reel.ai.setActive('claude-cli')
      done(await reel.ai.active())
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const signOut = async () => {
    await reel.ai.signOutChatGPT()
    setActive(await reel.ai.active())
  }

  const connected = !!active && active.connected && active.id !== 'none'
  const choices = !connected || showOther

  return (
    <div className="stack">
      {connected && (
        <div className="banner good" data-testid="ai-connected-banner">
          <Icon name="done" />
          <span data-testid="ai-connected">
            {active!.id === 'claude-cli' ? 'Using Claude Code on this computer.' : `Connected to ${active!.label}`}
            {active!.id !== 'claude-cli' && active!.detail ? ` (${active!.detail})` : ''}
            {active!.id === 'claude-cli' ? '' : '.'}
          </span>
          {active!.id === 'chatgpt' ? (
            <button className="btn small" onClick={signOut} data-testid="use-no-ai">
              Sign out
            </button>
          ) : (
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
          )}
        </div>
      )}
      {connected && !showOther && (
        <button className="link left" onClick={() => setShowOther(true)} data-testid="use-different-ai">
          Use a different AI…
        </button>
      )}
      {choices && (busy === 'chatgpt' ? (
        <div className="row">
          <Spinner />
          <span className="muted">Finish signing in in your web browser.</span>
          <span className="spacer" />
          <button className="btn small ghost" onClick={() => reel.ai.cancelSignIn()}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="btn primary big" onClick={chatgpt} disabled={!!busy} data-testid="signin-chatgpt">
          Sign in with ChatGPT
        </button>
      ))}
      {!connected && <p className="muted-sm center" style={{ marginTop: -4 }}>Uses your own ChatGPT plan. Reel Studio never sees your password.</p>}
      {choices && local && active?.id !== 'claude-cli' && (
        <>
          <button className="btn big" onClick={useLocal} disabled={!!busy || !local.connected} data-testid="use-local-claude">
            {busy === 'local' ? <Spinner /> : null} Use Claude Code on this computer
          </button>
          {!local.connected && local.error?.userMessage && <p className="muted-sm">{local.error.userMessage}</p>}
        </>
      )}
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
                if (e.key === 'Enter' && key.trim()) void claude()
              }}
              data-testid="claude-key-input"
            />
            <button className="btn" onClick={claude} disabled={!key.trim() || !!busy} data-testid="use-claude-key">
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

/** Dev-only providers (REELSTUDIO_DEV=1): claude-cli, codex-cli, replay. Never shown to users. */
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

/** One-time speech model download with progress. */
export function ModelDownload({ onReady }: { onReady?: () => void }) {
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
        <button className="btn primary big" onClick={() => reel.model.download().then(setS)} data-testid="download-model">
          {s.pct > 0 && s.pct < 100 ? 'Keep downloading' : 'Download'}
        </button>
      )}
      {s.error && <div className="banner error">{s.error}</div>}
    </div>
  )
}
