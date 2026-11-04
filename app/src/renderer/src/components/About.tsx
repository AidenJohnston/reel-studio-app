// Settings › About (the app, its version, the update status with its one action, automatic updates, the license)
// and What's new (the release notes latest.json carries, newest first).
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { LegalDoc } from '../../../shared/api'
import type { UpdateState } from '../../../shared/update'
import { aboutButton, aboutStatus, noteBlocks, noteDay } from './update-copy'
import { reel, userMessage } from '../api'
import { useNotify } from '../App'
import { Icon } from './icons'
import { FOLDER_APP, Modal, Progress } from './ui'
import { useUpdateActions } from './update'

const LEGAL_TITLE: Record<LegalDoc, string> = { license: 'GNU Affero General Public License v3', notices: 'Third-party notices' }

function LegalText({ doc, onClose }: { doc: LegalDoc; onClose: () => void }) {
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
        <button className="btn ghost" onClick={() => void reel.app.showLegal(doc).catch((e) => notify(userMessage(e), 'error'))}>
          Show in {FOLDER_APP}
        </button>
        <button className="btn primary" onClick={onClose} data-autofocus>
          Done
        </button>
      </div>
    </Modal>
  )
}

/** `keys`: the automatic-updates block (download key), owned by Settings. `children`: notes at the end. */
export function AboutPanel({ s, onToggle, keys, children }: { s: UpdateState; onToggle: (on: boolean) => void; keys?: ReactNode; children?: ReactNode }) {
  const { act, pending, dialog } = useUpdateActions()
  const [legal, setLegal] = useState<LegalDoc | null>(null)
  const disabled = ['disabled', 'checking', 'downloading', 'installing'].includes(s.status)
  const note = s.status === 'error' || s.status === 'disabled' ? s.message : null
  return (
    <section className="panel about" data-testid="about">
      <h2>About</h2>
      <div className="about-id" data-testid="update-settings">
        <span className="brand-mark about-mark" aria-hidden>
          <Icon name="play" size={18} stroke={2} />
        </span>
        <div className="about-name">
          <div className="about-title">Reel Studio</div>
          <div className="muted-sm" data-testid="update-settings-text">
            {aboutStatus(s)}
          </div>
        </div>
        {s.status !== 'disabled' && (
          <button className="btn small" disabled={disabled || pending} onClick={() => void act(s)} data-testid="update-settings-button">
            {aboutButton(s)}
          </button>
        )}
      </div>
      {note && (
        <p className={`about-note${s.status === 'error' ? ' failed' : ''}`} data-testid="update-settings-note">
          {note}
        </p>
      )}
      {s.status === 'downloading' && <Progress pct={s.downloadPercent ?? 0} label="Downloading the update" />}
      <span className="sr-only" role="status">
        {s.status === 'downloading' ? 'Downloading the update.' : aboutStatus(s)}
      </span>

      {keys}

      <label className="toggle about-toggle">
        <input type="checkbox" checked={s.autoCheck} onChange={(e) => onToggle(e.target.checked)} data-testid="check-updates" />
        Check for updates
      </label>
      <p className="muted-sm about-hint">Once a day, Reel Studio asks getreelstudio.com if there is a newer version. Nothing about you or your videos is sent.</p>

      <div className="about-license">
        <p className="muted-sm">
          Open source under the GNU AGPL v3. No accounts, no tracking. Copyright 2026 Curate Technologies LLC and contributors;
          it comes with no warranty. Source: github.com/getcurate/reel-studio.
        </p>
        <div className="row">
          <button className="btn small" onClick={() => setLegal('license')} data-testid="about-license">
            License
          </button>
          <button className="btn small" onClick={() => setLegal('notices')} data-testid="about-notices">
            Third-party notices
          </button>
        </div>
      </div>
      {children}
      {legal && <LegalText doc={legal} onClose={() => setLegal(null)} />}
      {dialog}
    </section>
  )
}

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

export function WhatsNew({ s }: { s: UpdateState }) {
  return (
    <section className="panel whats-new" data-testid="whats-new">
      <h2>What's new</h2>
      {s.notes.length ? (
        <ol className="release-list">
          {s.notes.map((n) => {
            const day = noteDay(n.date)
            return (
              <li key={n.version} className="release" data-testid={`release-${n.version}`}>
                <div className="release-top">
                  <h3 className="release-title">Version {n.version}</h3>
                  {n.newer ? <span className="release-tag new">New</span> : n.version === s.currentVersion ? <span className="release-tag">Installed</span> : null}
                  {day && <time dateTime={n.date}>{day}</time>}
                </div>
                <div className="release-text">
                  <NoteText text={n.text} />
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="muted-sm" style={{ marginTop: 6 }}>
          {s.status === 'disabled' ? 'Release notes show here in the installed app.' : 'Release notes show here after Reel Studio checks for updates.'}
        </p>
      )}
    </section>
  )
}
