import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeCodeInfo, ModelStatus, ProviderInfo } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Progress, Spinner } from './ui'
import { Icon } from './icons'

/** What works with no AI at all. One honest line, shown wherever we ask people to connect. */
export const WITHOUT_AI =
  'Without AI, Reel Studio still cuts the pauses and repeated starts, adds subtitles, your music and a cover. ' +
  'With AI it also picks your best takes, adds pictures, writes your post caption and changes the video from your notes.'

/** Anthropic's own install page for the Claude Code app. */
export const CLAUDE_CODE_SETUP_URL = 'https://code.claude.com/docs/en/setup'
export const USE_CLAUDE_CODE = 'Use Claude (your Claude Code app)'
export const USING_CLAUDE_CODE = 'Using Claude through your Claude Code app.'
const CLAUDE_PLAN_LINE = 'It uses your own Claude plan and its usage limits.'
/** While a sign-in window is open: check every 3 s, for up to 10 minutes. */
const WAIT_EVERY_MS = 3000
const WAIT_FOR_MS = 10 * 60_000

/**
 * Connect your AI editor, for normal people. Whatever the person already has comes first: a signed-in Claude Code
 * app makes "Use Claude (your Claude Code app)" the big button; otherwise "Sign in with ChatGPT" is, with the
 * Claude choice below it in its real state (sign in, or how to install it). "Use an Anthropic API key" stays the
 * quiet advanced choice. Used by the Connect screen, Settings and First run.
 *
 * Reel Studio never sees the Claude sign-in: it happens in Anthropic's own app, in a terminal window, and the app
 * only asks that app "signed in or not?".
 */
export function ConnectAI({ onConnected }: { onConnected?: (p: ProviderInfo) => void }) {
  const [active, setActive] = useState<ProviderInfo | null>(null)
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  // Once connected, the sign-in choices fold away behind "Use a different AI…" (critique 2).
  const [showOther, setShowOther] = useState(false)
  const [busy, setBusy] = useState<'chatgpt' | 'claude' | 'claude-code' | null>(null)
  const [error, setError] = useState<{ text: string; link?: string } | null>(null)
  // The person's own Claude Code app, in its real state; `waiting` = a sign-in window is open.
  const [claude, setClaude] = useState<ClaudeCodeInfo | null>(null)
  const [waiting, setWaiting] = useState(false)
  const [showInstall, setShowInstall] = useState(false)
  const waitingRef = useRef(false)
  const checking = useRef(false)
  waitingRef.current = waiting

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

  const useClaudeCode = useCallback(async () => {
    setBusy('claude-code')
    setError(null)
    try {
      await reel.ai.setActive('claude-cli')
      done(await reel.ai.active())
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }, [done])

  const checkClaude = useCallback(async () => {
    if (checking.current) return
    checking.current = true
    try {
      const s = await reel.ai.claudeCodeStatus()
      setClaude(s)
      // They started the sign-in here, so once it worked, that is their choice: use it.
      if (s.state === 'ready' && waitingRef.current) {
        setWaiting(false)
        await useClaudeCode()
      }
    } catch {
      /* keep the last answer */
    } finally {
      checking.current = false
    }
  }, [useClaudeCode])

  useEffect(() => {
    reel.ai.active().then(setActive).catch(() => {})
    void checkClaude()
  }, [checkClaude])

  // Coming back to the window (after signing in or installing) checks again.
  useEffect(() => {
    const onFocus = () => void checkClaude()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [checkClaude])

  useEffect(() => {
    if (!waiting) return
    const started = Date.now()
    const t = setInterval(() => {
      if (Date.now() - started > WAIT_FOR_MS) setWaiting(false)
      else void checkClaude()
    }, WAIT_EVERY_MS)
    return () => clearInterval(t)
  }, [waiting, checkClaude])

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

  const signInClaude = async () => {
    setError(null)
    try {
      await reel.ai.openClaudeSignIn()
      setWaiting(true)
    } catch (e) {
      fail(e)
    }
  }

  const signOut = async () => {
    await reel.ai.signOutChatGPT()
    setActive(await reel.ai.active())
  }

  const connected = !!active && active.connected && active.id !== 'none'
  const choices = !connected || showOther
  const claudeReady = claude?.state === 'ready'
  const offerClaude = choices && !!claude && active?.id !== 'claude-cli'
  // Recommend what they already have: a ready Claude Code app goes first.
  const claudeFirst = offerClaude && claudeReady

  const chatgptChoice = choices && (busy === 'chatgpt' ? (
    <div className="row">
      <Spinner />
      <span className="muted">Finish signing in in your web browser.</span>
      <span className="spacer" />
      <button className="btn small ghost" onClick={() => reel.ai.cancelSignIn()}>
        Cancel
      </button>
    </div>
  ) : (
    <>
      <button className={`btn big${claudeFirst ? '' : ' primary'}`} onClick={chatgpt} disabled={!!busy} data-testid="signin-chatgpt">
        Sign in with ChatGPT
      </button>
      {!connected && <p className="muted-sm center" style={{ marginTop: -4 }}>Uses your own ChatGPT plan. Reel Studio never sees your password.</p>}
    </>
  ))

  const checkAgain = (
    <button className="btn small" onClick={() => void checkClaude()} data-testid="claude-code-check">
      Check again
    </button>
  )
  const installSteps = (
    <ol className="muted-sm" style={{ margin: 0, paddingLeft: 20 }} data-testid="claude-code-install">
      <li>
        Open{' '}
        <a href={CLAUDE_CODE_SETUP_URL} target="_blank" rel="noreferrer">
          Anthropic's install page
        </a>
        .
      </li>
      <li>Follow the steps for your computer.</li>
      <li>Come back here and click Check again.</li>
    </ol>
  )

  let claudeChoice: ReactNode = null
  if (offerClaude && claude.state === 'ready') {
    claudeChoice = (
      <>
        <button className="btn primary big" onClick={useClaudeCode} disabled={!!busy} data-testid="use-claude-code">
          {busy === 'claude-code' ? <Spinner /> : null} {USE_CLAUDE_CODE}
        </button>
        <p className="muted-sm center" style={{ marginTop: -4 }}>{CLAUDE_PLAN_LINE}</p>
      </>
    )
  } else if (offerClaude && claude.state === 'signed_out') {
    claudeChoice = (
      <div className="stack" style={{ gap: 6 }} data-testid="claude-code-choice" data-state="signed_out">
        <button className="btn big" onClick={signInClaude} disabled={!!busy} data-testid="claude-code-signin">
          Sign in to your Claude Code app
        </button>
        {waiting ? (
          <div className="row" data-testid="claude-code-waiting">
            <Spinner />
            <span className="muted">Waiting for you to sign in in the other window.</span>
            <span className="spacer" />
            {checkAgain}
          </div>
        ) : (
          <p className="muted-sm center" style={{ margin: 0 }}>
            A window opens. Sign in there with your Claude account. Reel Studio never sees it. {CLAUDE_PLAN_LINE}
          </p>
        )}
        {waiting && <p className="muted-sm center" style={{ margin: 0 }}>{CLAUDE_PLAN_LINE}</p>}
        {claude.reason && !/not signed in yet/.test(claude.reason) && <p className="muted-sm center" style={{ margin: 0 }}>{claude.reason}</p>}
        {!waiting && <div className="row" style={{ justifyContent: 'center' }}>{checkAgain}</div>}
      </div>
    )
  } else if (offerClaude && claude.state === 'broken') {
    claudeChoice = (
      <div className="stack" style={{ gap: 6 }} data-testid="claude-code-choice" data-state="broken">
        <p className="muted-sm">We found your Claude Code app, but it did not start. Install it again, then click Check again.</p>
        {installSteps}
        <div className="row">{checkAgain}</div>
      </div>
    )
  } else if (offerClaude && claude.state === 'missing') {
    claudeChoice = !showInstall ? (
      <button className="link center" onClick={() => setShowInstall(true)} data-testid="claude-code-toggle">
        Use Claude instead
      </button>
    ) : (
      <div className="stack" style={{ gap: 6 }} data-testid="claude-code-choice" data-state="missing">
        <p className="muted-sm">
          To use Claude, install Anthropic's Claude Code app. It needs a paid Claude plan (Pro or Max). {CLAUDE_PLAN_LINE}
        </p>
        {installSteps}
        <div className="row">{checkAgain}</div>
      </div>
    )
  }

  return (
    <div className="stack">
      {connected && (
        <div className="banner good" data-testid="ai-connected-banner">
          <Icon name="done" />
          <span data-testid="ai-connected">
            {active!.id === 'claude-cli' ? USING_CLAUDE_CODE : `Connected to ${active!.label}`}
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
      {claudeFirst ? (
        <>
          {claudeChoice}
          {chatgptChoice}
        </>
      ) : (
        <>
          {chatgptChoice}
          {claudeChoice}
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

/** Every provider as a chip, for developers (REELSTUDIO_DEV=1 adds codex-cli and replay). Never shown to users. */
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
