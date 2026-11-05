import { useEffect, useId, useState } from 'react'
import type { LegalDoc, UpdateKeyStatus } from '../../../shared/api'
import { productName } from '../../../shared/channel'
import { updateAction } from '../../../shared/update'
import { noteBlocks, noteDay, updateSummary } from './update-copy'
import { reel, userMessage } from '../api'
import { useNotify } from '../App'
import { Button, FOLDER_APP, Modal, Progress } from './ui'
import { useUpdateActions, useUpdateState } from './update'

/** Under Settings › Check for updates: where the update stands, and the one thing to do about it. */
export function UpdateSettingsRow() {
  const s = useUpdateState()
  const { act, pending, dialog } = useUpdateActions()
  if (!s) return null
  const action = updateAction(s)
  const disabled = ['disabled', 'checking', 'downloading', 'installing'].includes(s.status)
  const text = s.status === 'idle' ? `You have ${productName(s.currentVersion)} ${s.currentVersion}.` : updateSummary(s).replace(/ Click to .*$/, '')
  const button = action !== 'none' ? (s.status === 'error' ? 'Try again' : action === 'install' ? 'Restart to update' : action === 'open-page' ? 'Open download page' : 'Download')
    : s.status === 'checking' ? 'Checking…' : s.status === 'downloading' ? 'Downloading…' : s.status === 'installing' ? 'Restarting…'
    : s.status === 'up-to-date' ? 'Check again' : s.status === 'error' ? 'Try again' : 'Check now'
  return (
    <div className="srow-more update-row" data-testid="update-settings">
      <div className="update-row-line">
        <p className="muted-sm" data-testid="update-settings-text">
          {text}
        </p>
        {s.status !== 'disabled' && (
          <Button size="small" disabled={disabled || pending} onClick={() => void act(s)} data-testid="update-settings-button">
            {button}
          </Button>
        )}
      </div>
      {s.status === 'downloading' && <Progress pct={s.downloadPercent ?? 0} label="Downloading the update" />}
      <span className="sr-only" role="status">
        {s.status === 'downloading' ? 'Downloading the update.' : text}
      </span>
      {dialog}
    </div>
  )
}

/** The download key from the receipt email (main/update-key.ts): with it, an update downloads and installs itself;
 * without it, an update opens the download page. The page never sees the key. */
export function useUpdateKey(): UpdateKeyStatus | null {
  const [status, setStatus] = useState<UpdateKeyStatus | null>(null)
  useEffect(() => {
    reel.updateKey
      .status()
      .then(setStatus)
      .catch(() => {})
    return reel.updateKey.onChange(setStatus)
  }, [])
  return status
}

/** Settings › Automatic updates: on with a pasted download link (or the reelstudio:// link the receipt opens), off. */
export function AutoUpdatesControl({ status }: { status: UpdateKeyStatus }) {
  const notify = useNotify()
  const [pending, setPending] = useState(false)
  const run = async (f: () => Promise<unknown>, done?: string): Promise<void> => {
    setPending(true)
    try {
      await f()
      if (done) notify(done)
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setPending(false)
    }
  }
  if (status.on) {
    return (
      <Button size="small" disabled={pending} onClick={() => void run(() => reel.updateKey.clear())} data-testid="auto-updates-off">
        Turn off
      </Button>
    )
  }
  return (
    <span className="sctl">
      <button className="ext-link" disabled={pending} onClick={() => void run(() => reel.update.openAutoUpdatesPage())} data-testid="auto-updates-get">
        Get my link
      </button>
      <Button size="small" disabled={pending} onClick={() => void run(() => reel.updateKey.paste(), 'Automatic updates are on.')} data-testid="auto-updates-paste">
        Paste link
      </Button>
    </span>
  )
}

export const autoUpdatesLine = (s: UpdateKeyStatus): string =>
  s.on
    ? `On${s.plan === 'monthly' ? ' (monthly plan)' : ''}. A new version downloads and installs when you say yes. Only that download carries your download key.`
    : 'Off. Copy the download link from your receipt email, then paste it here, and new versions install themselves.'

/** One release's lines: paragraphs, and bullets as a list. Text only; nothing in a note is markup. */
export function NoteText({ text }: { text: string }) {
  return (
    <>
      {noteBlocks(text).map((b, i) =>
        b.kind === 'list' ? (
          <ul key={i}>
            {b.items.map((t, j) => (
              <li key={j}>{t}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{b.text}</p>
        )
      )}
    </>
  )
}

/** What's new: the notes the download site's latest.json carries, newest first (main/update-check.ts). */
export function WhatsNew() {
  const s = useUpdateState()
  if (!s?.notes.length) {
    return (
      <div className="srow-more">
        <p className="muted-sm">
          {s?.status === 'disabled' ? 'Release notes show here in the installed app.' : 'Release notes show here after Reel Studio checks for updates.'}
        </p>
      </div>
    )
  }
  return (
    <div className="srow-more">
      <ol className="whats-new" tabIndex={0} aria-label="What’s new in Reel Studio" data-testid="whats-new">
        {s.notes.map((n) => {
          const day = noteDay(n.date)
          return (
            <li key={n.version} data-testid={`release-${n.version}`}>
              <p className="whats-new-head">
                <b>{n.version}</b>
                {n.newer ? <span className="whats-new-tag">New</span> : n.version === s.currentVersion ? <span className="whats-new-tag quiet">Installed</span> : null}
                {day && <time dateTime={n.date}>{day}</time>}
              </p>
              <NoteText text={n.text} />
            </li>
          )
        })}
      </ol>
    </div>
  )
}

const LEGAL_TITLE: Record<LegalDoc, string> = { license: 'GNU Affero General Public License v3', notices: 'Third-party notices' }

/** The license or the third-party notices this copy ships (main/paths.ts legalFile), read in the app. */
export function LegalText({ doc, onClose }: { doc: LegalDoc; onClose: () => void }) {
  const notify = useNotify()
  const titleId = useId()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    reel.app.legal(doc).then(setText, (e) => {
      notify(userMessage(e), 'error')
      onClose()
    })
  }, [doc])
  return (
    <Modal onClose={onClose} wide testid="legal" labelledBy={titleId}>
      <h2 id={titleId}>{LEGAL_TITLE[doc]}</h2>
      <pre className="legal-text selectable" tabIndex={0} aria-labelledby={titleId}>
        {text ?? ''}
      </pre>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button kind="tertiary" onClick={() => void reel.app.showLegal(doc).catch((e) => notify(userMessage(e), 'error'))}>
          Show in {FOLDER_APP}
        </Button>
        <Button kind="primary" onClick={onClose} data-autofocus>
          Done
        </Button>
      </div>
    </Modal>
  )
}
