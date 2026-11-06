// Settings › Editor: how notes run (Reel Studio's editor, or the editor in use's own app with Reel Studio's tools), and
// whether other AI apps may use Reel Studio (main/outside-access.ts), with the line to paste into each of them.
import { useEffect, useRef, useState } from 'react'
import type { NoteRunnerInfo, OutsideStatus } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Icon } from './icons'
import { SettingRow, Switch, useShown } from './settings-rows'
import { Button, Confirm, IS_MAC, Segmented } from './ui'
import './ai-apps.css'

const APP_NAME = { 'claude-code': 'Claude Code', codex: 'Codex' } as const

/** Settings › Editor › How notes run. Shown only while the editor in use is an app that can run notes itself. */
export function NoteRunnerRow({ onError }: { onError: (m: string) => void }) {
  const [info, setInfo] = useState<NoteRunnerInfo | null>(null)
  const saving = useRef(false)
  useEffect(() => {
    let live = true
    const load = () => void reel.ai.noteRunner().then((i) => live && setInfo(i), () => {})
    load()
    // the editor in use changed, or a note ended (its self-test may have failed): read it again
    const offAi = reel.ai.onChange(load)
    const offQueue = reel.queue.onChange(load)
    return () => {
      live = false
      offAi()
      offQueue()
    }
  }, [])
  if (!info?.app) return null
  const name = APP_NAME[info.app]
  const pick = async (runner: NoteRunnerInfo['runner']) => {
    if (saving.current || (runner === info.runner && !info.fellBack)) return
    saving.current = true
    const before = info
    setInfo({ ...info, runner, fellBack: undefined })
    try {
      setInfo(await reel.ai.setNoteRunner(runner))
    } catch (e) {
      setInfo(before)
      onError(userMessage(e))
    } finally {
      saving.current = false
    }
  }
  const fell = info.fellBack && info.runner === 'app' ? info.fellBack : null
  return (
    <SettingRow
      id="note-runner"
      line={
        info.runner === 'app'
          ? `Your ${name} app’s own agent makes each change, using Reel Studio’s tools. Notes take a little longer to start. Stop and undo work the same. With Double-check each edit on, your ${info.app === 'codex' ? 'Claude Code' : 'Codex'} app checks each note when it’s signed in.`
          : `Reel Studio’s editor makes each change. Or let your ${name} app make it, using Reel Studio’s tools.`
      }
      control={
        <Segmented
          label="How notes run"
          value={info.runner}
          options={[
            { key: 'reelstudio', label: 'Reel Studio' },
            { key: 'app', label: name }
          ]}
          onPick={(k) => void pick(k)}
          testid="note-runner"
        />
      }
    >
      {fell && (
        <div className="srow-more row" data-testid="note-runner-fell-back">
          <p className="mnote warn" role="status">
            <Icon name="alert" size={14} />
            <span>
              {name} couldn’t use Reel Studio’s tools, so your last note ran on Reel Studio’s editor instead. Notes keep running there until you try again or
              restart Reel Studio.
            </span>
          </p>
          <Button size="small" onClick={() => void pick('app')} data-testid="note-runner-retry">
            Try {name} again
          </Button>
        </div>
      )}
    </SettingRow>
  )
}

type Client = 'claudeCode' | 'claudeDesktop' | 'codex'
const CLIENTS: { key: Client; label: string }[] = [
  { key: 'claudeCode', label: 'Claude Code' },
  { key: 'claudeDesktop', label: 'Claude Desktop' },
  { key: 'codex', label: 'Codex' }
]

/** One thing to paste, and its Copy button (which says Copied until the text changes or 2 s pass). */
function Paste({ text, label, testid }: { text: string; label: string; testid: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(t)
  }, [copied])
  useEffect(() => setCopied(false), [text])
  return (
    <div className="paste">
      <pre tabIndex={0} aria-label={label} data-testid={testid}>
        {text}
      </pre>
      <Button size="small" onClick={() => void reel.app.copyText(text).then(() => setCopied(true))} data-testid={`${testid}-copy`}>
        <Icon name={copied ? 'check' : 'copy'} size={14} stroke={2} />
        {copied ? 'Copied' : 'Copy'}
      </Button>
      <span className="sr-only" role="status">
        {copied ? 'Copied' : ''}
      </span>
    </div>
  )
}

/** Settings › Editor › Let other AI apps use Reel Studio. Off by default; on, it shows what to paste into each app. */
export function OutsideAppsRow({ onError }: { onError: (m: string) => void }) {
  const [st, setSt] = useState<OutsideStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [client, setClient] = useState<Client>('claudeCode')
  const [asking, setAsking] = useState(false)
  const shown = useShown('outside-apps')
  useEffect(() => {
    let live = true
    reel.outside.status().then((s) => live && setSt(s), () => {})
    const off = reel.outside.onChange((s) => live && setSt(s))
    return () => {
      live = false
      off()
    }
  }, [])
  if (!st) return null
  const run = async (fn: () => Promise<OutsideStatus>) => {
    setBusy(true)
    try {
      setSt(await fn())
    } catch (e) {
      onError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const setup = st.setup
  const where = IS_MAC ? '~/Library/Application Support/Claude/claude_desktop_config.json' : '%APPDATA%\\Claude\\claude_desktop_config.json'
  return (
    <SettingRow
      id="outside-apps"
      line="Claude, Codex or the ChatGPT app can list your reels, send notes and press Stop, as you do here. Everything they do shows in Reel Studio."
      control={<Switch on={st.on} disabled={busy} labelledBy="set-outside-apps" onToggle={() => void run(() => reel.outside.setEnabled(!st.on))} testid="outside-apps" />}
    >
      {st.on && setup && shown && (
        <div className="srow-more outside" data-testid="outside-setup">
          <p className="muted-sm" role="status" data-testid="outside-connected">
            {st.connected.length ? `Connected now: ${st.connected.join(', ')}.` : 'No AI app is connected yet. Add Reel Studio to one:'}
          </p>
          <Segmented label="AI app" value={client} options={CLIENTS} onPick={setClient} testid="outside-client" />
          {client === 'claudeCode' && (
            <>
              <p className="muted-sm">Paste this in a terminal, then start Claude Code again.</p>
              <Paste text={setup.claudeCode} label="Command for Claude Code" testid="outside-claude-code" />
            </>
          )}
          {client === 'claudeDesktop' && (
            <>
              <p className="muted-sm">
                In Claude, open Settings › Developer › Edit Config, add this to <bdi dir="ltr">{where}</bdi> (inside its <code>mcpServers</code> if it has
                one), then quit and reopen Claude.
              </p>
              <Paste text={setup.claudeDesktop} label="Settings for Claude Desktop" testid="outside-claude-desktop" />
            </>
          )}
          {client === 'codex' && (
            <>
              <p className="muted-sm">Paste this in a terminal. The ChatGPT app for Mac and Windows uses the same setup as Codex.</p>
              <Paste text={setup.codex} label="Command for Codex" testid="outside-codex" />
              <p className="muted-sm">No terminal? Add this to ~/.codex/config.toml instead, or in the ChatGPT app: Settings › MCP servers › Add server.</p>
              <Paste text={setup.codexToml} label="Codex config.toml settings" testid="outside-codex-toml" />
              <p className="muted-sm" data-testid="outside-chatgpt-web">
                ChatGPT in a web browser can only reach servers on the internet, so it can’t use Reel Studio on this computer.
              </p>
            </>
          )}
          <div className="row outside-reset">
            <p className="muted-sm">Only apps on this computer can connect.</p>
            <Button size="small" kind="tertiary" disabled={busy} onClick={() => setAsking(true)} data-testid="outside-reset">
              Reset access…
            </Button>
          </div>
        </div>
      )}
      {asking && (
        <Confirm
          title="Reset access?"
          body="Every AI app connected to Reel Studio is disconnected now. Each one connects again after you restart it."
          yes="Reset access"
          no="Cancel"
          onYes={() => {
            setAsking(false)
            void run(() => reel.outside.reset())
          }}
          onNo={() => setAsking(false)}
        />
      )}
    </SettingRow>
  )
}
