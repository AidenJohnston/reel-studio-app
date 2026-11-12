// The guided AI setup (main/easy-ai.ts), shown only while the easy-AI flag is on. Two choices in plain words come
// first, each one press: "Sign in with ChatGPT" (the app gets ChatGPT ready, then OpenAI's page opens) and "Use
// Reel Studio's AI" (publik's page opens). Today's ways to connect wait under "Other ways" (connect.tsx ConnectAI).
// A running sign-in takes over its row: one sentence that changes in place, Cancel, and what to do in the browser.
import { useEffect, useRef, useState } from 'react'
import type { EasyAiInfo, GuidedInfo, GuidedRoute, ProviderInfo, VendorInfo } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { BrandMark, Logo } from './brand'
import { Icon } from './icons'
import { ProviderRow, type Tone } from './provider-row'
import { Button, Progress, Spinner } from './ui'
import { ConnectAI } from './connect'
import { SettingRow, Switch } from './settings-rows'
import { DeviceCodeBox } from './vendor-connect'
import './ai-setup.css'

let known: EasyAiInfo | null = null

/** The flag and whether this build can offer Reel Studio's AI. Null until known; remembered for the session. */
export function useEasyAi(): EasyAiInfo | null {
  const [info, setInfo] = useState<EasyAiInfo | null>(known)
  useEffect(() => {
    let live = true
    reel.ai
      .easyStatus()
      .then((i) => {
        known = i
        if (live) setInfo(i)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return info
}

/** Settings › Advanced flips it: every screen reads the new value on its next mount. */
export function rememberEasyAi(i: EasyAiInfo): void {
  known = i
}

const RUNNING = new Set<GuidedInfo['step']>(['checking', 'getting', 'waiting'])

/** The two guided rows, for ConnectAI while nothing is connected. */
export function GuidedChoices({ easy, onConnected }: { easy: EasyAiInfo; onConnected: (p: ProviderInfo) => void }) {
  const [info, setInfo] = useState<Record<GuidedRoute, GuidedInfo | null>>({ chatgpt: null, publik: easy.publikNotice ?? null })
  const [codex, setCodex] = useState<VendorInfo | null>(null)
  const connectedRef = useRef(onConnected)
  connectedRef.current = onConnected
  useEffect(() => {
    let live = true
    reel.ai.vendorStatus('chatgpt').then((i) => live && setCodex(i), () => {})
    // one already running (the person left this screen and came back) shows where it is, with its Cancel
    for (const r of ['chatgpt', 'publik'] as const)
      reel.ai.guidedStatus(r).then((i) => live && RUNNING.has(i.step) && setInfo((s) => ({ ...s, [r]: i })), () => {})
    const off = reel.ai.onGuided((i) => {
      if (!live) return
      setInfo((s) => ({ ...s, [i.route]: i }))
      // the one place a guided sign-in connects the screen, however it was started
      if (i.step === 'done') void reel.ai.active().then((p) => live && connectedRef.current(p), () => {})
    })
    return () => {
      live = false
      off()
    }
  }, [])
  const busy = (['chatgpt', 'publik'] as const).find((r) => info[r] && RUNNING.has(info[r]!.step)) ?? null

  const start = async (r: GuidedRoute) => {
    setInfo((s) => ({ ...s, [r]: { route: r, step: 'checking' } }))
    try {
      // every step, done included, arrives on onGuided above
      await reel.ai.guidedStart(r)
    } catch (e) {
      setInfo((s) => ({ ...s, [r]: { route: r, step: 'failed', problem: 'failed', message: userMessage(e) } }))
    }
  }

  const row = (r: GuidedRoute) => {
    const i = info[r]
    const running = !!i && RUNNING.has(i.step)
    const failed = i?.step === 'failed'
    const already = r === 'chatgpt' && codex?.state === 'ready'
    const name = r === 'chatgpt' ? 'Sign in with ChatGPT' : 'Use Reel Studio’s AI'
    const idle =
      r === 'chatgpt'
        ? already
          ? 'You’re already signed in to ChatGPT on this computer.'
          : 'Use the ChatGPT account you already have.'
        : 'Free to start. You sign in with publik in your browser.'
    const tone: Tone = failed ? 'error' : running ? 'busy' : 'plain'
    const status = running ? (
      <span>
        <Spinner /> {i!.message ?? 'One moment.'}
      </span>
    ) : failed ? (
      (i!.message ?? 'That didn’t work. Try again.')
    ) : (
      idle
    )
    const action = running ? (
      <Button size="small" kind="tertiary" onClick={() => void reel.ai.guidedCancel(r)} data-testid={`guided-cancel-${r}`}>
        Cancel
      </Button>
    ) : (
      <Button
        size="small"
        kind={r === 'chatgpt' ? 'primary' : 'secondary'}
        disabled={busy !== null && busy !== r}
        onClick={() => void start(r)}
        data-testid={`guided-start-${r}`}
      >
        {failed ? (i!.problem === 'signed_out' ? 'Sign in' : 'Try again') : r === 'chatgpt' ? (already ? 'Use it' : 'Sign in') : 'Start'}
      </Button>
    )
    const more = running && i && (i.step === 'getting' || i.canReopen || i.deviceCode) && (
      <div className="pv-more guided-more">
        {i.step === 'getting' && <Progress pct={i.pct ?? 0} label="Getting ChatGPT ready" />}
        {i.deviceCode && <DeviceCodeBox v="chatgpt" code={i.deviceCode.code} url={i.deviceCode.url} />}
        {i.canReopen && !i.deviceCode && (
          <div className="row wrap">
            <Button size="small" onClick={() => void reel.ai.guidedReopen(r)} data-testid={`guided-reopen-${r}`}>
              <Icon name="external" size={14} /> Open the page again
            </Button>
          </div>
        )}
      </div>
    )
    return (
      <div className="guided-row" data-testid={`guided-${r}`} data-step={i?.step ?? 'idle'} data-problem={i?.problem ?? ''}>
        <ProviderRow id={`guided-${r}`} name={name} mark={r === 'chatgpt' ? <BrandMark name="openai" size={20} /> : <Logo size={20} />} status={status} tone={tone} action={action}>
          {more}
        </ProviderRow>
      </div>
    )
  }

  return (
    <div className="prov guided" role="group" aria-label="Sign in" data-testid="guided-choices">
      {row('chatgpt')}
      {easy.publik && row('publik')}
    </div>
  )
}

/**
 * The AI setup as one block, for the default path (lane L1 places it): what it is in one line, the guided choices
 * (or, with the flag off, today's editor picker), and Not now. `onDone` runs once an editor is connected.
 */
export function AiSetup({ onDone, onSkip }: { onDone: (p: ProviderInfo) => void; onSkip: () => void }) {
  return (
    <section className="ai-setup" aria-labelledby="ai-setup-title" data-testid="ai-setup">
      <h2 id="ai-setup-title">Let the AI edit your reels</h2>
      <p className="muted">Sign in once. After that you just say what to change.</p>
      <ConnectAI onConnected={onDone} />
      <div className="ai-setup-skip">
        <Button kind="tertiary" onClick={onSkip} data-testid="ai-setup-skip">
          Not now
        </Button>
      </div>
    </section>
  )
}

/** Settings › Advanced › Easier AI sign-in: the easy-AI flag's switch (main/easy-ai.ts), off until turned on. */
export function EasyAiRow({ onError }: { onError: (m: string) => void }) {
  const easy = useEasyAi()
  const [busy, setBusy] = useState(false)
  const [on, setOn] = useState<boolean | null>(null)
  const value = on ?? easy?.on ?? false
  const flip = async () => {
    setBusy(true)
    try {
      const i = await reel.ai.setEasyAi(!value)
      rememberEasyAi(i)
      setOn(i.on)
    } catch (e) {
      onError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingRow
      id="easy-ai"
      line="Sign in to the AI with one button, with nothing to install yourself. Turn it off to go back to the usual choices."
      control={<Switch on={value} disabled={busy || !easy} labelledBy="set-easy-ai" onToggle={() => void flip()} testid="easy-ai" />}
    />
  )
}
