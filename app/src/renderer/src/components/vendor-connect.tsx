import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { HubFound, ProviderInfo, VendorId, VendorInfo } from '../../../shared/api'
import { CLAUDE_PLANS_URL, VENDOR_INSTALL_PAGES } from '../../../shared/config'
import { reel, userMessage } from '../api'
import { Button, IS_MAC, Spinner } from './ui'
import { Icon } from './icons'
import { BrandMark } from './brand'
import { ConnectedMark, ProviderRow, type Tone } from './provider-row'

/**
 * The editor picker's rows (connect.tsx): CLIProxyAPI when it runs on this computer, then the person's own Claude Code
 * app and Codex app. Reel Studio installs none of them. CLIProxyAPI is found by reading its config (main/vendor-hub.ts)
 * and connects with one click. A signed-in app shows its plan and connects with one click; a signed-out one starts its
 * own sign-in on its maker's page; a missing one says so and links to its install page.
 */

export const USE_CLAUDE_CODE = 'Use Claude (your Claude Code app)'
export const USE_CODEX = 'Use ChatGPT (your Codex app)'
export const USING_CLAUDE_CODE = 'Using Claude through your Claude Code app.'
export const USING_CODEX = 'Using ChatGPT through your Codex app.'
export const USING_HUB = 'Using CLIProxyAPI on this computer.'

// Always "Claude Code app", never "Claude Code" alone: Reel Studio is not Claude Code, it uses the app the person has
const APP: Record<VendorId, string> = { claude: 'Claude Code app', chatgpt: 'Codex app' }
const MAKER: Record<VendorId, string> = { claude: 'Anthropic', chatgpt: 'OpenAI' }
const PROVIDER: Record<VendorId, ProviderInfo['id']> = { claude: 'claude-cli', chatgpt: 'codex-cli' }
const MARK: Record<VendorId, 'claude' | 'openai'> = { claude: 'claude', chatgpt: 'openai' }
const PLAN_OF: Record<VendorId, string> = { claude: 'Claude', chatgpt: 'ChatGPT' }
const HERE = IS_MAC ? 'this Mac' : 'this PC'
/** What CLIProxyAPI is, on its maker's page. */
const HUB_ABOUT = 'https://github.com/router-for-me/CLIProxyAPI'
const PLAN_NAMES: Record<string, string> = { max: 'Max', max5x: 'Max 5x', max20x: 'Max 20x', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free', plus: 'Plus', go: 'Go', business: 'Business', edu: 'Edu' }
/** "max" → "Max"; a plan name the app already wrote ("Pro 5x") stays as it is. */
export const planName = (p: string | undefined): string | undefined => (p ? (PLAN_NAMES[p.toLowerCase()] ?? p) : undefined)

// OpenAI's docs: "Enable device code login in your ChatGPT security settings (personal account) or ChatGPT workspace
// permissions (workspace admin)." Until then OpenAI's page refuses the code, and Codex just keeps waiting.
const DEVICE_CODE_HINT = "Turn on device code login in ChatGPT’s security settings first (work accounts: your workspace admin)."

const running = (i: VendorInfo | null): boolean => !!i && ['signing_in', 'checking'].includes(i.step)

/** The "connected" line for each editor. */
export const usingLine = (p: ProviderInfo): string =>
  p.id === 'claude-cli' ? USING_CLAUDE_CODE : p.id === 'codex-cli' ? USING_CODEX : p.label === 'CLIProxyAPI' ? USING_HUB : `Connected to ${p.label}${p.detail ? ` (${p.detail})` : ''}.`

/** CLIProxyAPI on this computer, looked for when the picker opens and when the window comes back. */
export function useHub(): [HubFound | null, () => Promise<void>] {
  const [hub, setHub] = useState<HubFound | null>(null)
  const look = useCallback(async () => {
    try {
      setHub(await reel.ai.hubStatus())
    } catch {
      setHub({ state: 'none' })
    }
  }, [])
  useEffect(() => {
    void look()
    const onFocus = (): void => void look()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [look])
  return [hub, look]
}

/**
 * CLIProxyAPI's row: found with a key that works (one Use it), or answering without one (a key box). `primary`: it is
 * the recommended choice and nothing is connected, so its pill is the screen's one filled button.
 */
export function HubRow({ hub, on, primary, onConnected, onDisconnect, onLook, children }: { hub: HubFound | null; on: boolean; primary: boolean; onConnected: (p: ProviderInfo) => void; onDisconnect: () => void; onLook: () => Promise<void>; children?: ReactNode }) {
  const [busy, setBusy] = useState(false)
  const [looking, setLooking] = useState(false)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const host = hub?.origin?.replace(/^https?:\/\//, '') ?? ''
  const look = (): void => {
    setLooking(true)
    void onLook().finally(() => setLooking(false))
  }

  const use = async (typed?: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await reel.ai.hubUse(typed)
      if (r.error) setError(r.error.userMessage)
      else {
        setKey('')
        onConnected(r.status)
      }
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }

  let status: ReactNode
  let tone: Tone = 'plain'
  let action: ReactNode = null
  let more: ReactNode = null
  if (!hub) {
    status = (
      <>
        <Spinner /> Looking on {HERE}…
      </>
    )
  } else if (on) {
    status = <ConnectedMark testid="ai-connected" />
    tone = 'ok'
    action = (
      <Button size="small" kind="tertiary" onClick={onDisconnect} data-testid="use-no-ai">
        Disconnect
      </Button>
    )
  } else if (hub.state === 'none') {
    // always the first row, so a person who runs it, or wants to, knows where it would be
    status = (
      <span className="pv-line" title={hub.looked ? `Looked at ${hub.looked}` : undefined}>
        Not running on this computer{hub.looked ? ` · Looked at ${hub.looked}` : ''}
      </span>
    )
    action = (
      <Button size="small" onClick={look} disabled={looking} data-testid="hub-look">
        {looking ? <Spinner /> : null}
        Check again
      </Button>
    )
    more = (
      <p className="pv-more vsteps-hint">
        <a href={HUB_ABOUT} target="_blank" rel="noreferrer" data-testid="hub-about">
          What is CLIProxyAPI?
        </a>{' '}
        It pools your Claude and ChatGPT accounts on this computer.
      </p>
    )
  } else if (hub.state === 'elsewhere') {
    // a config naming another computer: shown so the person knows why it isn't offered, and never sent a key
    status = (
      <span className="pv-line" title={`${hub.host} · ${hub.keySource ?? ''}`}>
        Its config names {hub.host}, not this computer.
      </span>
    )
    more = <p className="pv-more vsteps-hint">To use a server elsewhere, add it under Advanced with its address and key.</p>
  } else if (hub.state === 'ready') {
    status = (
      <span className="pv-line">
        {hub.models} {hub.models === 1 ? 'model' : 'models'} on {HERE}
      </span>
    )
    tone = error ? 'error' : 'plain'
    action = (
      <Button size="small" kind={primary ? 'primary' : 'secondary'} onClick={() => void use()} disabled={busy} aria-label="Use CLIProxyAPI" data-testid="hub-use">
        {busy ? <Spinner /> : null}
        Use it
      </Button>
    )
    more = (
      <div className="pv-more hub-src">
        <p className="pv-src" title={`Key read from ${hub.keySource}`}>
          Key read from its config
        </p>
        {error && (
          <p className="pv-note error" role="alert" data-testid="hub-error">
            {error}
          </p>
        )}
      </div>
    )
  } else {
    status = (
      <span className="pv-line" title={hub.keySource ? `Config: ${hub.keySource}` : undefined}>
        {hub.keyRefused ? 'It refused the keys in its config.' : hub.keySource ? 'No key in its config.' : `Answers at ${host}. It needs a key.`}
      </span>
    )
    more = (
      <form
        className="pv-more hub-key"
        onSubmit={(e) => {
          e.preventDefault()
          if (key.trim()) void use(key.trim())
        }}
      >
        <div className="hub-key-row">
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste a key from api-keys"
            aria-label="CLIProxyAPI key"
            aria-invalid={!!error}
            aria-describedby="hub-key-help"
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setError(null)
            }}
            data-testid="hub-key"
          />
          <Button type="submit" size="small" kind={primary ? 'primary' : 'secondary'} disabled={!key.trim() || busy} data-testid="hub-use-key">
            {busy ? <Spinner /> : null}
            Use it
          </Button>
        </div>
        <p id="hub-key-help" className={`vsteps-hint${error ? ' error' : ''}`} role={error ? 'alert' : undefined}>
          {error ?? 'Kept encrypted on this computer and never shown again.'}
        </p>
      </form>
    )
  }

  return (
    <div data-testid="hub-row" data-state={on ? 'connected' : (hub?.state ?? 'loading')}>
      <ProviderRow
        id="cliproxy"
        mark={<Icon name="server" size={20} />}
        name={
          <>
            <span className="pv-name">CLIProxyAPI</span>
            {!on && (hub?.state === 'ready' || hub?.state === 'needs-key') && <span className="pv-tag">Recommended</span>}
          </>
        }
        status={status}
        tone={tone}
        action={action}
      >
        {more}
        {children}
      </ProviderRow>
    </div>
  )
}

/**
 * Claude Code's and the Codex app's rows, in order: what the person already has first, otherwise Claude Code. `lead`:
 * nothing is connected and no CLIProxyAPI leads, so the first row's pill is the screen's one filled button. Every row
 * is there before the first answer, so the page never jumps when one arrives.
 */
export function VendorRows({
  active,
  lead,
  onConnected,
  onDisconnect,
  details,
  hubLeads = false,
  onAttention,
  onReady
}: {
  active: ProviderInfo | null
  lead: boolean
  onConnected: (p: ProviderInfo) => void
  onDisconnect: () => void
  /** shown under the row of the editor in use */
  details?: ReactNode
  /** CLIProxyAPI's row holds the screen's filled button, so a row the person did not start stays quiet */
  hubLeads?: boolean
  /** a sign-in or check the person started is running or failed here: that row holds the filled button */
  onAttention?: (on: boolean) => void
  /** whether one of the person's apps is signed in and ready to use (ConnectAI orders CLIProxyAPI's row by it) */
  onReady?: (ready: boolean) => void
}) {
  const [info, setInfo] = useState<Record<VendorId, VendorInfo | null>>({ claude: null, chatgpt: null })
  // The click before main's first step: "Use Claude Code" checks Claude with one short message, which shows no step.
  const [asked, setAsked] = useState<VendorId | null>(null)
  const [error, setError] = useState<{ v: VendorId; text: string } | null>(null)
  // the first look at a vendor's app failed, so there is no answer to show yet
  const [lookFailed, setLookFailed] = useState<Record<VendorId, boolean>>({ claude: false, chatgpt: false })
  const infoRef = useRef(info)
  infoRef.current = info
  const anyReady = info.claude?.state === 'ready' || info.chatgpt?.state === 'ready'
  useEffect(() => onReady?.(anyReady), [anyReady, onReady])
  const announce = useRef(onConnected)
  announce.current = onConnected

  const refresh = useCallback(async (v: VendorId) => {
    try {
      const i = await reel.ai.vendorStatus(v)
      setInfo((s) => ({ ...s, [v]: i }))
      setLookFailed((s) => ({ ...s, [v]: false }))
    } catch {
      // a later failure keeps the last answer; a first one says so and offers another look
      if (!infoRef.current[v]) setLookFailed((s) => ({ ...s, [v]: true }))
    }
  }, [])

  useEffect(() => {
    void refresh('claude')
    void refresh('chatgpt')
    return reel.ai.onVendor((i) => {
      setInfo((s) => ({ ...s, [i.vendor]: i }))
      if (i.step === 'done') void reel.ai.active().then((p) => announce.current(p), () => undefined)
    })
  }, [refresh])

  // Back to the window (after installing an app, or signing in some other way): look again, unless a connect runs.
  useEffect(() => {
    const onFocus = (): void => {
      for (const v of ['claude', 'chatgpt'] as VendorId[]) if (!running(infoRef.current[v])) void refresh(v)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const start = (v: VendorId, how: (v: VendorId) => Promise<VendorInfo>, ask = true): void => {
    setError(null)
    if (ask) setAsked(v)
    how(v)
      .then((i) => setInfo((s) => ({ ...s, [v]: i })))
      .catch((e) => setError({ v, text: userMessage(e) }))
      .finally(() => setAsked((a) => (a === v ? null : a)))
  }

  const order: VendorId[] = info.chatgpt?.state === 'ready' && info.claude?.state !== 'ready' ? ['chatgpt', 'claude'] : ['claude', 'chatgpt']
  // A row that is connecting, failed or unsure holds the screen's one filled button; the leading row's pill goes quiet
  const needs = (v: VendorId): boolean => {
    const i = info[v]
    return asked === v || error?.v === v || running(i) || i?.step === 'failed' || i?.problem === 'status_unknown'
  }
  const leadIdle = lead && !order.some(needs)
  const started = order.some((v) => asked === v || error?.v === v || running(info[v]) || info[v]?.step === 'failed')
  useEffect(() => onAttention?.(started), [started, onAttention])
  return (
    <>
      {order.map((v, k) => {
        const on = !!active?.connected && active.id === PROVIDER[v]
        return (
          <VendorRow
            key={v}
            vendor={v}
            info={info[v]}
            on={on}
            primary={leadIdle && k === 0 && info[v]?.state !== 'missing'}
            asked={asked === v}
            error={error?.v === v ? error.text : null}
            lookFailed={lookFailed[v]}
            onLook={() => void refresh(v)}
            onConnect={() => start(v, reel.ai.vendorConnect)}
            onCode={() => start(v, reel.ai.vendorSignInWithCode, false)}
            onCheck={() => refresh(v)}
            onSignIn={() => start(v, reel.ai.vendorSignIn)}
            onOther={() => start(order[1 - k], reel.ai.vendorConnect)}
            onDisconnect={onDisconnect}
          >
            {on ? details : null}
          </VendorRow>
        )
      })}
    </>
  )
}

function VendorRow({
  vendor: v,
  info,
  on,
  primary,
  asked,
  error,
  lookFailed,
  onLook,
  onConnect,
  onCode,
  onCheck,
  onSignIn,
  onOther,
  onDisconnect,
  children
}: {
  vendor: VendorId
  info: VendorInfo | null
  lookFailed: boolean
  onLook: () => void
  on: boolean
  primary: boolean
  asked: boolean
  error: string | null
  onConnect: () => void
  onCode: () => void
  /** asks the app's status again, nothing else */
  onCheck: () => Promise<void>
  onSignIn: () => void
  /** the other vendor's connect: the way out of a Claude plan that can't be used */
  onOther: () => void
  onDisconnect: () => void
  children?: ReactNode
}) {
  const [fallbackError, setFallbackError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirmSignIn, setConfirmSignIn] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const step = info?.step ?? 'loading'
  const plan = planName(info?.plan)
  const attrs = { 'data-testid': `vendor-${v}`, 'data-step': step, 'data-state': info?.state ?? 'loading', ...(info?.problem ? { 'data-problem': info.problem } : {}), ...(info?.signIn ? { 'data-sign-in': info.signIn } : {}) }

  // The pill pressed gives way to Cancel, and Cancel to the row's next pill. React keeps the same button when it can;
  // when the focused control went away instead (a link in the steps), focus comes back to the row's pill, never to
  // the page. Only a row that had the focus takes it back.
  const owned = useRef(false)
  useEffect(() => {
    if (owned.current && document.activeElement === document.body)
      row.current?.querySelector<HTMLElement>('.pv-main > button')?.focus({ preventScroll: true })
  }, [step, asked, on])
  // a window sign-in that failed belongs to the attempt it was part of
  useEffect(() => setFallbackError(null), [step])

  const cancel = (): void => {
    void reel.ai.vendorCancel(v)
  }
  const windowFallback = (): void => {
    setFallbackError(null)
    reel.ai.openClaudeSignIn().catch((e) => setFallbackError(userMessage(e)))
  }

  let status: ReactNode
  let tone: Tone = 'plain'
  let action: ReactNode = null
  let more: ReactNode = null

  if (!info && lookFailed) {
    tone = 'error'
    status = `Couldn’t look for ${MAKER[v]}’s ${APP[v]} on ${HERE}.`
    action = (
      <Button size="small" onClick={onLook} data-testid={`vendor-look-${v}`}>
        Try again
      </Button>
    )
  } else if (!info) {
    status = (
      <>
        <Spinner /> Looking on {HERE}…
      </>
    )
  } else if (on) {
    status = <ConnectedMark testid="ai-connected" />
    tone = 'ok'
    action = (
      <Button size="small" kind="tertiary" onClick={onDisconnect} data-testid="use-no-ai">
        Disconnect
      </Button>
    )
  } else if (info.state === 'missing' || info.state === 'broken') {
    status = <span className="pv-line">{info.state === 'missing' ? `Not on ${HERE}.` : `On ${HERE}, but it doesn’t start.`}</span>
    action = (
      <a className="btn small" href={VENDOR_INSTALL_PAGES[v]} target="_blank" rel="noreferrer" aria-label={`Get ${APP[v]} from ${MAKER[v]} (opens your browser)`} data-testid={`vendor-install-page-${v}`}>
        Get it <Icon name="external" size={12} stroke={2} />
      </a>
    )
  } else if (info.problem === 'status_unknown' && !running(info) && !asked && !error) {
    // The app could not tell whether ChatGPT is signed in. Nothing starts on its own: Check again only asks again,
    // and a new sign-in is the person's choice, asked for in its own confirm, because it makes Codex forget the one
    // it has. One action at a time.
    status = <span data-testid={`vendor-message-${v}`}>{info.message}</span>
    action = confirmSignIn ? null : (
      <Button
        size="small"
        disabled={checking}
        onClick={() => {
          setChecking(true)
          void onCheck().finally(() => setChecking(false))
        }}
        data-testid={`vendor-check-${v}`}
      >
        {checking ? 'Checking…' : 'Check again'}
      </Button>
    )
    more = confirmSignIn ? (
      <div className="pv-more conn-confirm" role="group" aria-label="Sign in again?">
        <p>A new sign-in makes your Codex app forget the one it has.</p>
        <div className="row">
          <Button size="small" kind="tertiary" onClick={() => setConfirmSignIn(false)} autoFocus>
            Cancel
          </Button>
          <Button size="small" onClick={onSignIn} data-testid={`vendor-signin-${v}`}>
            Sign in again
          </Button>
        </div>
      </div>
    ) : (
      <p className="pv-more vsteps-hint">
        <button className="link inline" onClick={() => setConfirmSignIn(true)} data-testid={`vendor-signin-ask-${v}`}>
          Sign in again instead…
        </button>
      </p>
    )
  } else if (running(info) && info.signIn === 'code') {
    const dc = info.deviceCode
    tone = 'busy'
    status = 'Signing in…'
    action = (
      <Button size="small" kind="tertiary" onClick={cancel} data-testid={`vendor-cancel-${v}`}>
        Cancel
      </Button>
    )
    more = (
      <div className="pv-more vendor-steps">
        <ol className="vsteps">
          <Step state="now">
            {dc ? (
              <>
                <b>Enter this code on {MAKER[v]}’s page.</b>
                <span>Come back here when the page says you’re signed in.</span>
              </>
            ) : (
              <b>Getting a sign-in code from {MAKER[v]}…</b>
            )}
          </Step>
        </ol>
        {dc && <DeviceCodeBox v={v} code={dc.code} url={dc.url} />}
        <p className="vsteps-hint">{DEVICE_CODE_HINT}</p>
      </div>
    )
  } else if (running(info)) {
    const signing = step === 'signing_in'
    // the steps below carry the detail and the one spinner; the row's line only says a sign-in is running
    tone = 'busy'
    status = 'Signing in…'
    action = (
      <Button size="small" kind="tertiary" onClick={cancel} data-testid={`vendor-cancel-${v}`}>
        Cancel
      </Button>
    )
    more = (
      <div className="pv-more vendor-steps">
        <ol className="vsteps">
          <Step state="now">
            {signing ? (
              <>
                <b>Finish signing in on {MAKER[v]}’s page.</b>
                <span>Come back here when it says you’re signed in.</span>
              </>
            ) : (
              <b>Checking that it worked…</b>
            )}
          </Step>
        </ol>
        {signing && (
          <div className="row wrap vsteps-acts">
            <Button size="small" onClick={() => void reel.ai.vendorSignInAgain(v)} data-testid={`vendor-again-${v}`}>
              Open the page again
            </Button>
            {v === 'claude' && (
              <button className="link inline" onClick={windowFallback} data-testid="claude-window-fallback">
                Page shows a code? Use a sign-in window
              </button>
            )}
          </div>
        )}
        {signing && v === 'claude' && (
          <p className="vsteps-hint" data-testid="claude-free-hint">
            Does {MAKER[v]}’s page say you need Claude Pro or Max? The free Claude plan can’t be used here.{' '}
            <a href={CLAUDE_PLANS_URL} target="_blank" rel="noreferrer">
              See Claude plans
            </a>{' '}
            or{' '}
            <button className="link inline" onClick={onOther} data-testid="claude-free-switch">
              connect ChatGPT
            </button>
            , whose free plan works.
          </p>
        )}
        {fallbackError && <p className="pv-note error">{fallbackError}</p>}
      </div>
    )
  } else if (asked) {
    // main has not sent a step yet: Claude Code's short check before it becomes the editor
    tone = 'busy'
    status = (
      <>
        <Spinner /> {v === 'claude' ? 'Checking Claude…' : 'Connecting…'}
      </>
    )
    action = (
      <Button size="small" kind="tertiary" onClick={cancel} data-testid={v === 'claude' ? 'claude-check-cancel' : `vendor-cancel-${v}`}>
        Cancel
      </Button>
    )
  } else if (step === 'failed' || error) {
    const free = info.problem === 'free_plan'
    // ChatGPT's port held (in use, or reserved by Windows), or its code sign-in turned off: a code is the way through
    const offerCode = v === 'chatgpt' && !error && (info.problem === 'port_busy' || info.problem === 'device_code_off')
    // Reserved by Windows, Try again fails every time until the port is freed, so the code is the row's filled pill.
    const codeFirst = offerCode && info.portReserved === true
    tone = free ? 'plain' : 'error'
    status = <span data-testid={`vendor-message-${v}`}>{error ?? info.message}</span>
    const retry = (kind: 'primary' | 'secondary') => (
      <Button size="small" kind={kind} onClick={onConnect} data-testid={`vendor-retry-${v}`}>
        {free ? 'Check again' : 'Try again'}
      </Button>
    )
    const code = (kind: 'primary' | 'secondary') => (
      <Button size="small" kind={kind} onClick={onCode} data-testid={`vendor-code-start-${v}`}>
        Sign in with a code instead
      </Button>
    )
    // outlined like every other row action: the panel's one filled button is the recommended one, or Continue
    action = codeFirst ? code('secondary') : retry('secondary')
    if (offerCode)
      more = (
        <div className="pv-more vendor-steps">
          <div className="row wrap vsteps-acts">{codeFirst ? retry('secondary') : code('secondary')}</div>
          {codeFirst && <p className="vsteps-hint">Trying again won’t help until Windows lets go of the port, usually after a restart.</p>}
        </div>
      )
    else if (free)
      more = (
        <div className="pv-more vendor-steps">
          <div className="row wrap vsteps-acts">
            <a className="btn small" href={CLAUDE_PLANS_URL} target="_blank" rel="noreferrer">
              See Claude plans <Icon name="external" size={12} stroke={2} />
            </a>
          </div>
          <p className="vsteps-hint">Or connect ChatGPT. Its free plan works, with limits.</p>
        </div>
      )
  } else {
    const ready = info.state === 'ready'
    status = <span className="pv-line">{ready ? `Signed in. It uses your ${PLAN_OF[v]} plan’s limits.` : 'Not signed in.'}</span>
    action = (
      <Button
        size="small"
        kind={primary ? 'primary' : 'secondary'}
        onClick={onConnect}
        aria-label={ready ? (v === 'claude' ? USE_CLAUDE_CODE : USE_CODEX) : `Sign in to ${APP[v]}`}
        data-testid={ready ? (v === 'claude' ? 'use-claude-code' : 'use-codex') : `connect-${v}`}
      >
        {ready ? 'Use it' : 'Sign in'}
      </Button>
    )
    if (info.message)
      more = (
        <p className="pv-more vsteps-hint" data-testid={`vendor-note-${v}`}>
          {info.message}
        </p>
      )
  }

  // One announcer per row that is always there, so each step is read out once; the steps list itself is not live.
  const said = !info || !running(info) ? ''
    : info.signIn === 'code'
      ? info.deviceCode
        ? `Your sign-in code is ${info.deviceCode.code.split('').join(' ')}. Enter it on ${MAKER[v]}’s page.`
        : 'Getting a sign-in code.'
    : step === 'signing_in' ? `Finish signing in on ${MAKER[v]}’s page.`
    : 'Checking that it worked.'
  return (
    <div
      ref={row}
      {...attrs}
      onFocus={() => (owned.current = true)}
      onBlur={(e) => {
        // a control that was removed blurs with nowhere to go: the row still owns the focus
        if (e.relatedTarget) owned.current = row.current?.contains(e.relatedTarget) ?? false
      }}
    >
      <p className="sr-only" role="status">
        {said}
      </p>
      <ProviderRow
        id={PROVIDER[v]}
        mark={<BrandMark name={MARK[v]} size={20} />}
        name={
          <>
            <span className="pv-name">{APP[v]}</span>
            {plan && info?.state === 'ready' && <span className="pv-plan" data-testid={`vendor-plan-${v}`}>{plan}</span>}
          </>
        }
        status={status}
        tone={tone}
        action={action}
      >
        {more}
        {children}
      </ProviderRow>
    </div>
  )
}

/** One line of a sign-in: running now, done (a tick) or still to come. */
function Step({ state, children }: { state: 'now' | 'done' | 'later'; children: ReactNode }) {
  return (
    <li className={`vstep ${state}`}>
      <span className="vstep-mark" aria-hidden>
        {state === 'now' ? <Spinner /> : state === 'done' ? <Icon name="check" size={14} stroke={2.4} /> : <span className="vstep-dot" />}
      </span>
      <span className="vstep-what">{children}</span>
    </li>
  )
}

/** ChatGPT's sign-in code: read here, typed on OpenAI's page, often on another screen. */
export function DeviceCodeBox({ v, code, url }: { v: VendorId; code: string; url: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="vcode-box">
      {/* the row's announcer reads it out one character at a time */}
      <p className="vcode selectable" data-testid={`vendor-code-${v}`}>
        {code}
      </p>
      <div className="row wrap vsteps-acts">
        <a className="btn small primary" href={url} target="_blank" rel="noreferrer" data-testid={`vendor-code-open-${v}`}>
          <Icon name="external" size={14} /> Open sign-in page
        </a>
        <Button size="small" onClick={() => void reel.app.copyText(code).then(() => setCopied(true), () => undefined)} data-testid={`vendor-code-copy-${v}`}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="sr-only" role="status">
        {copied ? 'Copied the code.' : ''}
      </p>
    </div>
  )
}
