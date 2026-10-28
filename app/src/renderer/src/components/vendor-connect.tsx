import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderInfo, VendorId, VendorInfo } from '../../../shared/api'
import { CLAUDE_PLANS_URL, VENDOR_INSTALL_PAGES } from '../../../shared/config'
import { reel, userMessage } from '../api'
import { Spinner } from './ui'
import { Icon } from './icons'

/**
 * "Connect Claude" / "Connect ChatGPT": one card per vendor. One click installs the person's own AI app if it is
 * missing (Anthropic's Claude Code app, OpenAI's Codex app), opens that vendor's own sign-in page in the browser, and
 * makes it the AI editor once the app says it is signed in. Reel Studio never sees the sign-in: it happens on the
 * vendor's page and in the vendor's app (main/vendor-connect.ts).
 */

export const USE_CLAUDE_CODE = 'Use Claude (your Claude Code app)'
export const USE_CODEX = 'Use ChatGPT (your Codex app)'
export const USING_CLAUDE_CODE = 'Using Claude through your Claude Code app.'
export const USING_CODEX = 'Using ChatGPT through your Codex app.'

const NAME: Record<VendorId, string> = { claude: 'Claude', chatgpt: 'ChatGPT' }
const MAKER: Record<VendorId, string> = { claude: 'Anthropic', chatgpt: 'OpenAI' }
const APP: Record<VendorId, string> = { claude: "Anthropic's Claude Code app", chatgpt: "OpenAI's Codex app" }
const PLAN_LINE: Record<VendorId, string> = {
  claude: 'It uses your own Claude plan and its usage limits.',
  chatgpt: 'It uses your own ChatGPT plan and its usage limits.'
}
const PITCH: Record<VendorId, string> = {
  claude: "Needs Claude Pro or Max. Installs Anthropic's Claude Code app if you don't have it.",
  chatgpt: "Works with your ChatGPT plan, free ones too. Installs OpenAI's Codex app if you don't have it."
}

const busy = (i: VendorInfo | null): boolean => !!i && ['installing', 'signing_in', 'checking'].includes(i.step)

export function VendorCards({ activeId, onConnected }: { activeId?: ProviderInfo['id']; onConnected: (p: ProviderInfo) => void }) {
  const [info, setInfo] = useState<Record<VendorId, VendorInfo | null>>({ claude: null, chatgpt: null })
  // Did this connect go through an install? Then the install line stays on screen, ticked.
  const [installed, setInstalled] = useState<Record<VendorId, boolean>>({ claude: false, chatgpt: false })
  const [error, setError] = useState<string | null>(null)
  const infoRef = useRef(info)
  infoRef.current = info

  const refresh = useCallback(async (v: VendorId) => {
    try {
      const i = await reel.ai.vendorStatus(v)
      setInfo((s) => ({ ...s, [v]: i }))
    } catch {
      /* keep the last answer */
    }
  }, [])

  useEffect(() => {
    void refresh('claude')
    void refresh('chatgpt')
    return reel.ai.onVendor((i) => {
      setInfo((s) => ({ ...s, [i.vendor]: i }))
      if (i.step === 'installing') setInstalled((s) => ({ ...s, [i.vendor]: true }))
      if (i.step === 'done') {
        setInstalled((s) => ({ ...s, [i.vendor]: false }))
        void reel.ai.active().then(onConnected).catch(() => undefined)
      }
    })
  }, [refresh, onConnected])

  // Back to the window (after "Install it myself", or signing in some other way): look again, unless a connect runs.
  useEffect(() => {
    const onFocus = (): void => {
      for (const v of ['claude', 'chatgpt'] as VendorId[]) if (!busy(infoRef.current[v])) void refresh(v)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const connect = (v: VendorId): void => {
    setError(null)
    setInstalled((s) => ({ ...s, [v]: false }))
    reel.ai.vendorConnect(v).catch((e) => setError(userMessage(e)))
  }

  // Recommend what they already have; otherwise Claude first.
  const order: VendorId[] = info.chatgpt?.state === 'ready' && info.claude?.state !== 'ready' ? ['chatgpt', 'claude'] : ['claude', 'chatgpt']
  const shown = order.filter((v) => activeId !== (v === 'claude' ? 'claude-cli' : 'codex-cli'))
  return (
    <>
      {shown.map((v, k) => (
        <VendorCard
          key={v}
          vendor={v}
          info={info[v]}
          primary={k === 0}
          installed={installed[v]}
          onConnect={() => connect(v)}
          onOther={shown.length > 1 ? () => connect(shown[1 - k]) : undefined}
        />
      ))}
      {error && <div className="banner error">{error}</div>}
    </>
  )
}

function VendorCard({
  vendor: v,
  info,
  primary,
  installed,
  onConnect,
  onOther
}: {
  vendor: VendorId
  info: VendorInfo | null
  primary: boolean
  installed: boolean
  onConnect: () => void
  onOther?: () => void
}) {
  const cancel = (): void => void reel.ai.vendorCancel(v)
  const again = (): void => void reel.ai.vendorSignInAgain(v)
  const [fallbackError, setFallbackError] = useState<string | null>(null)
  const windowFallback = (): void => {
    setFallbackError(null)
    reel.ai.openClaudeSignIn().catch((e) => setFallbackError(userMessage(e)))
  }
  const testid = `vendor-${v}`
  const attrs = { 'data-testid': testid, 'data-step': info?.step ?? 'loading', 'data-state': info?.state ?? 'loading' }

  if (!info) return <div className="vendor" {...attrs} />

  if (busy(info)) {
    const installing = info.step === 'installing'
    const signing = info.step === 'signing_in'
    return (
      <div className="vendor flow" {...attrs}>
        <h3>Connecting {NAME[v]}</h3>
        {(installing || installed) && (
          <Line on={installing} done={!installing}>
            {installing ? (
              <>
                <b>Installing {APP[v]}</b>
                <span className="muted-sm">Takes a minute or two.</span>
              </>
            ) : (
              <span>{APP[v]} installed</span>
            )}
          </Line>
        )}
        <Line on={signing || info.step === 'checking'} done={false} waiting={installing}>
          {signing ? (
            <>
              <b>Finish signing in in your browser.</b>
              <span className="muted-sm">It's {MAKER[v]}'s page. Come back here when it says you're signed in.</span>
            </>
          ) : info.step === 'checking' ? (
            <b>Checking that it worked…</b>
          ) : (
            <span className="muted">Sign in to {NAME[v]} in your browser</span>
          )}
        </Line>
        {signing && v === 'claude' && (
          <p className="muted-sm hint" data-testid="claude-free-hint">
            Does {MAKER[v]}'s page say you need Claude Pro or Max? The free Claude plan can't be used here.{' '}
            <a href={CLAUDE_PLANS_URL} target="_blank" rel="noreferrer">
              See Claude plans
            </a>
            {onOther ? (
              <>
                {' '}or{' '}
                <button className="link inline" onClick={onOther} data-testid="claude-free-switch">
                  connect ChatGPT
                </button>
                , whose free plan works.
              </>
            ) : null}
          </p>
        )}
        <div className="row wrap">
          {signing && (
            <button className="btn small" onClick={again} data-testid={`vendor-again-${v}`}>
              Open the sign-in page again
            </button>
          )}
          <span className="spacer" />
          <button className="btn small ghost" onClick={cancel} data-testid={`vendor-cancel-${v}`}>
            Cancel
          </button>
        </div>
        {signing && v === 'claude' && (
          <button className="link left" onClick={windowFallback} data-testid="claude-window-fallback">
            The page shows a code? Sign in in a window instead
          </button>
        )}
        {fallbackError && <div className="banner error">{fallbackError}</div>}
      </div>
    )
  }

  if (info.step === 'failed') {
    const installProblem = info.problem === 'install_failed' || info.problem === 'not_found_after_install'
    const free = info.problem === 'free_plan'
    return (
      <div className="vendor flow" {...attrs} data-problem={info.problem}>
        <h3>Connect {NAME[v]}</h3>
        <div className={`banner ${free ? '' : 'error'}`} data-testid={`vendor-message-${v}`}>
          {info.message}
        </div>
        <div className="row wrap">
          {free ? (
            <>
              <a className="btn small" href={CLAUDE_PLANS_URL} target="_blank" rel="noreferrer">
                See Claude plans
              </a>
              <button className="btn small" onClick={onConnect} data-testid={`vendor-retry-${v}`}>
                Check again
              </button>
            </>
          ) : (
            <button className="btn small primary" onClick={onConnect} data-testid={`vendor-retry-${v}`}>
              Try again
            </button>
          )}
          {installProblem && (
            <a className="btn small" href={VENDOR_INSTALL_PAGES[v]} target="_blank" rel="noreferrer" data-testid={`vendor-install-page-${v}`}>
              <Icon name="external" size={14} /> Install it myself
            </a>
          )}
        </div>
        {installProblem && <p className="muted-sm">"Install it myself" opens {MAKER[v]}'s install page. Come back here and we check again by ourselves.</p>}
        {free && onOther && <p className="muted-sm">Or connect ChatGPT. Its free plan works, with limits.</p>}
      </div>
    )
  }

  // idle (or done, before the parent swaps in the "Using …" banner)
  const ready = info.state === 'ready'
  return (
    <div className="vendor" {...attrs}>
      <button
        className={`btn big${primary ? ' primary' : ''}`}
        onClick={onConnect}
        data-testid={ready ? (v === 'claude' ? 'use-claude-code' : 'use-codex') : `connect-${v}`}
      >
        {ready ? (v === 'claude' ? USE_CLAUDE_CODE : USE_CODEX) : `Connect ${NAME[v]}`}
      </button>
      <p className="muted-sm center sub">{ready ? PLAN_LINE[v] : PITCH[v]}</p>
      {info.message && (
        <p className="muted-sm center" data-testid={`vendor-note-${v}`}>
          {info.message}
        </p>
      )}
    </div>
  )
}

function Line({ on, done, waiting, children }: { on: boolean; done: boolean; waiting?: boolean; children: React.ReactNode }) {
  return (
    <div className={`vendor-line${waiting ? ' later' : ''}`}>
      <span className="mark">{on ? <Spinner /> : done ? <Icon name="done" size={16} /> : <span className="dot" />}</span>
      <span className="what">{children}</span>
    </div>
  )
}
