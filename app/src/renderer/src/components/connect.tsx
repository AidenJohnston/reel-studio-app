import { useCallback, useEffect, useRef, useState } from 'react'
import type { ModelStatus, ProviderInfo } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Progress, Spinner } from './ui'
import { Icon } from './icons'
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
 * comes first. "Use an Anthropic API key" stays the quiet advanced choice. Used by the Connect screen, Settings and
 * First run.
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

export const MODEL_FOUND = 'Found the listening model on this computer. Using it, no download needed.'

const mb = (bytes: number): number => Math.round(bytes / 1e6)

function downloadLine(s: ModelStatus, verb: 'Downloading' | 'Paused at'): string {
  return s.total > 0 ? `${verb} ${mb(s.bytes)} of ${mb(s.total)} MB` : `${verb} ${s.pct}%`
}

/**
 * The listening model's state, after looking for a matching copy already on this computer. `onDownloaded` fires only
 * the moment a download finishes, not for a model that was already here or a copy found here.
 */
export function useModelStatus(onDownloaded?: () => void) {
  const [s, setS] = useState<ModelStatus | null>(null)
  const [looked, setLooked] = useState(false)
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  const wasInstalled = useRef<boolean | null>(null)
  const downloaded = useRef(onDownloaded)
  downloaded.current = onDownloaded
  useEffect(() => {
    let alive = true
    const show = (m: ModelStatus) => {
      if (!alive) return
      setS(m)
      if (wasInstalled.current === false && m.installed && !m.reused) downloaded.current?.()
      wasInstalled.current = m.installed
    }
    const off = reel.model.onProgress(show)
    void (async () => {
      try {
        const m = await reel.model.status()
        show(m)
        if (!m.installed && !m.downloading) show(await reel.model.find())
      } catch {
        if (alive) setFailed(true)
      } finally {
        if (alive) setLooked(true)
      }
    })()
    return () => {
      alive = false
      off()
    }
  }, [tries])
  const retry = (): void => {
    setFailed(false)
    setLooked(false)
    setTries((n) => n + 1)
  }
  return { s, looked, failed, retry }
}

/** The one-time listening model download, for Settings and the "model missing" screen. */
export function ModelDownload() {
  const { s } = useModelStatus()
  return s ? <ModelPanel s={s} /> : <Spinner />
}

/** With `onNext`, a model that is here shows Next. */
export function ModelPanel({ s, onNext }: { s: ModelStatus; onNext?: () => void }) {
  if (s.installed)
    return (
      <div className="stack">
        <div className="banner good">The listening model is ready.</div>
        {s.checkFailed && (
          <p className="muted-sm" data-testid="model-check-failed">
            I couldn't work out the fastest settings for this computer, so the listening model uses its usual ones.
            Everything still works.
          </p>
        )}
        {onNext && (
          <button className="btn primary big" onClick={onNext} data-testid="model-next">
            Next
          </button>
        )}
      </div>
    )
  if (s.checking)
    return (
      <div className="stack" data-testid="model-checking">
        <Progress pct={s.pct} label="Checking the listening model" />
        <span className="muted">Checking the listening model on this computer</span>
      </div>
    )
  const paused = !s.downloading && s.pct > 0 && s.pct < 100
  return (
    <div className="stack">
      {s.downloading || paused ? (
        <>
          <Progress pct={s.pct} paused={!s.downloading} label="Downloading the listening model" />
          <div className="row">
            <span className="muted" data-testid="model-progress">
              {downloadLine(s, s.downloading ? 'Downloading' : 'Paused at')}
            </span>
            <span className="spacer" />
            {s.downloading ? (
              <button className="btn small ghost" onClick={() => reel.model.cancel()} data-testid="pause-model">
                Pause
              </button>
            ) : (
              <button className="btn small" onClick={() => void reel.model.download()} data-testid="download-model">
                Keep downloading
              </button>
            )}
          </div>
        </>
      ) : (
        <button className="btn primary big" onClick={() => void reel.model.download()} data-testid="download-model">
          Download
        </button>
      )}
      {s.error && (
        <div className="banner error" role="alert" data-testid="model-error">
          {s.error}
        </div>
      )}
    </div>
  )
}
