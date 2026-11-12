import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ModelStatus, ProviderInfo } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Button, Progress, Spinner } from './ui'
import { Icon } from './icons'
import { Connections } from './Connections'
import { ConnectedMark, Disclosure, ProviderRow } from './provider-row'
import { HubRow, VendorRows, useHub } from './vendor-connect'
import { EditorDetails, StageModels, useStages } from './editor-limits'
import { SETTINGS } from './settings-index'
import { SearchHits } from './settings-rows'
import { GuidedChoices, useEasyAi } from './AiSetup'
import './connect.css'

/** What Reel Studio makes with no editor connected. Nobody says "I" here: no editor is there to say it. */
export const WITHOUT_EDITOR = 'Without an editor, Reel Studio makes a basic version: pauses and retakes removed, subtitles and a cover.'

export { USE_CLAUDE_CODE, USE_CODEX, USING_CLAUDE_CODE, USING_CODEX, USING_HUB, usingLine } from './vendor-connect'

/** The editor in use, kept current: every call that changes it announces the change (main/index.ts changesAI). */
export function useActiveEditor(): [ProviderInfo | null, (p: ProviderInfo) => void] {
  const [active, setActive] = useState<ProviderInfo | null>(null)
  useEffect(() => {
    let live = true
    reel.ai
      .active()
      .then((p) => live && setActive(p))
      .catch(() => {})
    const off = reel.ai.onChange(setActive)
    return () => {
      live = false
      off()
    }
  }, [])
  return [active, setActive]
}

/**
 * Choose your editor: one component for the first run, Settings › Editor, the Connect screen, the composer with no
 * editor and a failed Version 1. CLIProxyAPI comes first (one click, the key read from its config), or, not found while
 * one of the person's own apps is ready, under Advanced; then the Claude Code and Codex apps, each with its plan; then Advanced (your own server, an
 * API key), closed. The editor in use shows its accounts, plans and limits, a Test, and a model for each stage. It
 * has no scroll area of its own: it fits the column it is given. `stagesOpen`: the stage list shows open (Settings).
 */
export function ConnectAI({ onConnected, advanced = true, stagesOpen = false }: { onConnected?: (p: ProviderInfo) => void; advanced?: boolean; stagesOpen?: boolean }) {
  const [active, setActive] = useActiveEditor()
  const [hub, lookForHub] = useHub()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [vendorAttention, setVendorAttention] = useState(false)
  const [vendorReady, setVendorReady] = useState(false)
  // a Settings search for your own server or an API key opens Advanced, where they are
  const hits = useContext(SearchHits)
  const searchedAdvanced = !!hits && (hits.has('own-server') || hits.has('api-key'))
  const stages = useStages(active)
  const announce = useRef(onConnected)
  announce.current = onConnected

  const connected = useCallback(
    (p: ProviderInfo) => {
      setActive(p)
      if (p.connected && p.id !== 'none') announce.current?.(p)
    },
    [setActive]
  )

  const disconnect = async () => {
    await reel.ai.setActive('none')
    setActive(await reel.ai.active())
    void lookForHub()
  }

  const anyOn = !!active && active.connected && active.id !== 'none'
  // the easy-AI flag (main/easy-ai.ts): while nothing is connected, the guided choices come first and today's rows
  // wait under Other ways, with no filled button of their own. Off, everything below renders as it always has.
  const easy = useEasyAi()
  const guided = !!easy?.on && !anyOn
  const [otherWaysOpen, setOtherWaysOpen] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const hubOn = anyOn && active.id === 'custom' && active.label === 'CLIProxyAPI'
  const otherOn = anyOn && !hubOn && !['claude-cli', 'codex-cli'].includes(active.id)
  const [othersOpen, setOthersOpen] = useState(false)
  // CLIProxyAPI is the recommended choice: while nothing is connected its Use it is the one filled button
  const hubLeads = !anyOn && !guided && !!hub && (hub.state === 'ready' || hub.state === 'needs-key')
  // Not found here while one of the person's own apps is ready: it waits under Advanced, with the person's own server
  // and an API key. First, a first-timer met a row that could not be used above the one that could; after the app,
  // still a name they had to read past: both Sense judges (goal 3) named it first, round after round.
  const hubTrails = !hubOn && hub?.state === 'none' && vendorReady
  const details = anyOn ? (
    <>
      <EditorDetails active={active} stages={stages} />
      <StageModels active={active} state={stages} open={stagesOpen} />
    </>
  ) : null

  const vendorRows = (
    <VendorRows
      active={active}
      lead={!anyOn && !hubLeads && !guided}
      hubLeads={hubLeads && !vendorAttention}
      onAttention={setVendorAttention}
      onReady={setVendorReady}
      onConnected={connected}
      onDisconnect={() => void disconnect()}
      details={details}
    />
  )

  // Your own server or an API key, while it is the editor: first, so what's in use is never one click away.
  const otherRow = otherOn && (
    <ProviderRow
      key="other"
      id={active.id}
      mark={<Icon name={active.id === 'claude' ? 'key' : 'server'} size={20} />}
      name={active.id === 'claude' ? SETTINGS['api-key'].label : active.label}
      status={<ConnectedMark testid="ai-connected" />}
      tone="ok"
      action={
        easy?.on && active.id === 'custom' && active.label === REEL_STUDIO_AI ? (
          // the guided Reel Studio AI sign-in: Sign out removes its key and connection, not only the choice
          <Button
            size="small"
            onClick={() =>
              void reel.ai.guidedSignOut('publik').then(
                () => disconnect(),
                (e) => setSignOutError(userMessage(e))
              )
            }
            data-testid="guided-sign-out-publik"
          >
            Sign out
          </Button>
        ) : (
          <Button size="small" onClick={() => void disconnect()} data-testid="use-no-ai">
            Disconnect
          </Button>
        )
      }
    >
      {signOutError && (
        <p className="pv-note error" role="alert">
          {signOutError}
        </p>
      )}
      {details}
    </ProviderRow>
  )

  const hubRow = (
    <HubRow hub={hub} on={hubOn} primary={hubLeads && !vendorAttention} onConnected={connected} onDisconnect={() => void disconnect()} onLook={lookForHub}>
      {hubOn ? details : null}
    </HubRow>
  )

  const body = (
    <>
      <div className="prov" role="group" aria-label="Choose your editor" data-testid="ai-picker">
        {otherRow}
        {/* the first row: found, asking for a key, elsewhere, or not running here with nothing else ready */}
        {!hubTrails && hubRow}
        {hubOn ? (
          // CLIProxyAPI is the editor: the person's own apps wait behind one quiet line
          <Disclosure label="Other editors" hint="Claude Code app, Codex app" open={othersOpen} onToggle={() => setOthersOpen((o) => !o)} testid="other-editors">
            <div className="prov">{vendorRows}</div>
          </Disclosure>
        ) : (
          vendorRows
        )}
        {hubTrails && !advanced && hubRow}
      </div>
      {active?.error && !active.connected && (
        <p className="pv-note error" role="alert">
          {active.error.userMessage}
        </p>
      )}
      {advanced && (
        <Disclosure label="Advanced" hint="Your own server or an API key" open={advancedOpen || searchedAdvanced} onToggle={() => setAdvancedOpen((o) => !o)} testid="ai-advanced">
          {hubTrails && <div className="prov">{hubRow}</div>}
          <Connections onConnected={connected} />
          <AnthropicKey active={active} onConnected={connected} />
        </Disclosure>
      )}
      {!anyOn && (
        <p className="noai-line" data-testid="without-ai">
          {WITHOUT_EDITOR}
        </p>
      )}
    </>
  )

  return (
    <div className="picker" data-testid="editor-setup">
      {guided && easy ? (
        <>
          <GuidedChoices easy={easy} onConnected={connected} />
          <Disclosure label="Other ways" open={otherWaysOpen || searchedAdvanced} onToggle={() => setOtherWaysOpen((o) => !o)} testid="other-ways">
            {body}
          </Disclosure>
        </>
      ) : (
        body
      )}
    </div>
  )
}

/** the connection the guided Reel Studio AI sign-in saves (main/publik.ts PUBLIK_LABEL) */
const REEL_STUDIO_AI = 'Reel Studio AI'

const isOn = (p: ProviderInfo | null, id: ProviderInfo['id']): boolean => !!p && p.connected && p.id === id

/** An Anthropic API key: billed by Anthropic as it's used, separately from a Claude plan. */
export function AnthropicKey({ active, onConnected }: { active: ProviderInfo | null; onConnected: (p: ProviderInfo) => void }) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const on = isOn(active, 'claude')

  const save = async () => {
    if (!key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const p = await reel.ai.setClaudeKey(key.trim())
      if (p.connected) {
        setKey('')
        setOpen(false)
        onConnected(p)
      } else if (p.error) setError(p.error.userMessage)
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ProviderRow
      id="claude"
      setting="api-key"
      mark={<Icon name="key" size={20} />}
      tone={on ? 'ok' : error ? 'error' : 'plain'}
      status={on ? <ConnectedMark /> : (error ?? 'Billed by Anthropic as you use it')}
      action={
        on || open ? null : (
          <Button size="small" onClick={() => setOpen(true)} data-testid="claude-key-toggle">
            Add key
          </Button>
        )
      }
    >
      {open && !on && (
        <div className="pv-more">
          <div className="row">
            <input
              className="input"
              type="password"
              autoFocus
              placeholder="Paste your Anthropic API key"
              aria-label={SETTINGS['api-key'].label}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
                if (e.key === 'Escape') setOpen(false)
              }}
              data-testid="claude-key-input"
            />
            <Button size="small" onClick={() => void save()} disabled={!key.trim() || busy} data-testid="use-claude-key">
              {busy && <Spinner />} Use this key
            </Button>
          </div>
          <p className="muted-sm">
            No key?{' '}
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
              Get one from Anthropic
            </a>
            .
          </p>
        </div>
      )}
    </ProviderRow>
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

export function downloadLine(s: ModelStatus, verb: 'Downloading' | 'Paused at'): string {
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
/** `secondary` on Settings, where the AI editor is the main action (custom-server). */
export function ModelDownload({ secondary }: { secondary?: boolean } = {}) {
  const { s } = useModelStatus()
  return s ? <ModelPanel s={s} secondary={secondary} /> : <Spinner />
}

/** With `onNext`, a model that is here shows Next. */
export function ModelPanel({ s, onNext, secondary }: { s: ModelStatus; onNext?: () => void; secondary?: boolean }) {
  if (s.installed)
    return (
      <div className="stack">
        <div className="banner good">The listening model is ready.</div>
        {s.checkFailed && (
          <p className="muted-sm" data-testid="model-check-failed">
            Reel Studio couldn't work out the fastest settings for this computer, so the listening model uses its usual
            ones. Everything still works.
          </p>
        )}
        {onNext && (
          <Button kind="primary" size="big" onClick={onNext} data-testid="model-next">
            Next
          </Button>
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
          <Progress pct={s.pct} label="Downloading the listening model" />
          <div className="row">
            <span className="muted" data-testid="model-progress">
              {downloadLine(s, s.downloading ? 'Downloading' : 'Paused at')}
            </span>
            <span className="spacer" />
            {s.downloading ? (
              <Button size="small" kind="tertiary" onClick={() => reel.model.cancel()} data-testid="pause-model">
                Pause
              </Button>
            ) : (
              <Button size="small" onClick={() => void reel.model.download()} data-testid="download-model">
                Keep downloading
              </Button>
            )}
          </div>
        </>
      ) : (
        <Button size="big" kind={secondary ? 'secondary' : 'primary'} onClick={() => void reel.model.download()} data-testid="download-model">
          Download
        </Button>
      )}
      {s.error && (
        <div className="banner error" role="alert" data-testid="model-error">
          {s.error}
        </div>
      )}
    </div>
  )
}
