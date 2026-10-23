import { useEffect, useId, useState, type ReactNode } from 'react'
import type { LegalDoc } from '../../../shared/api'
import { RELEASES_URL } from '../../../shared/config'
import { validDate, type ReleaseEntry, type UpdateState } from '../../../shared/update'
import { aboutButton, aboutStatus } from './update-copy'
import { reel, userMessage } from '../api'
import { useNotify } from '../App'
import { Icon } from './icons'
import { FadeScroll, FOLDER_APP, Modal, Progress } from './ui'
import { useUpdateActions } from './update'

const LEGAL_TITLE: Record<LegalDoc, string> = { license: 'MIT License', notices: 'Third-party notices' }

function LegalText({ doc, onClose }: { doc: LegalDoc; onClose: () => void }) {
  const notify = useNotify()
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    reel.app.legal(doc).then(setText, (e) => {
      notify(userMessage(e), 'error')
      onClose()
    })
  }, [doc])
  return (
    <Modal onClose={onClose} wide testid="legal">
      <h2>{LEGAL_TITLE[doc]}</h2>
      <pre className="legal-text selectable" tabIndex={0} aria-label={LEGAL_TITLE[doc]}>
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

export function AboutPanel({ s, onToggle, children }: { s: UpdateState; onToggle: (on: boolean) => void; children?: ReactNode }) {
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
      {note && <p className={`about-note${s.status === 'error' ? ' failed' : ''}`}>{note}</p>}
      {s.status === 'downloading' && <Progress pct={s.downloadPercent ?? 0} label="Downloading the update" />}
      <span className="sr-only" role="status">
        {s.status === 'downloading' ? 'Downloading the update.' : aboutStatus(s)}
      </span>

      <label className="toggle about-toggle">
        <input type="checkbox" checked={s.autoCheck} onChange={(e) => onToggle(e.target.checked)} data-testid="check-updates" />
        Check for updates automatically
      </label>
      <p className="muted-sm about-hint">Once a day, Reel Studio asks GitHub if there is a newer version. Nothing about you or your videos is sent.</p>

      <div className="about-license">
        <p className="muted-sm">Free and open source under the MIT License. No accounts, no tracking.</p>
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

const day = (iso: string | null): string | null => {
  const d = validDate(iso)
  return d && new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function ReleaseRow({ r, current, hint, onOpen }: { r: ReleaseEntry; current: string; hint: string; onOpen: (v: string) => void }) {
  const installed = r.version === current
  const date = day(r.date)
  return (
    <li>
      <button className="release-row" onClick={() => onOpen(r.version)} aria-describedby={hint} data-testid={`release-${r.version}`}>
        <span className="release-top">
          <span className="release-title">
            Version {r.version}
            {installed && <span className="release-tag">Installed</span>}
          </span>
          {date && <time dateTime={validDate(r.date) ?? undefined}>{date}</time>}
          <Icon name="external" size={12} stroke={2} />
        </span>
        {r.summary && <span className="release-summary">{r.summary}</span>}
      </button>
    </li>
  )
}

export function WhatsNew({ s }: { s: UpdateState }) {
  const notify = useNotify()
  const hint = useId()
  const open = (v: string): void => void reel.update.openRelease(v).catch(() => notify('I could not open the release page. Try again in a moment.', 'error'))
  return (
    <section className="panel whats-new" data-testid="whats-new">
      <div className="whats-new-head">
        <h2>What's new</h2>
        <a className="update-releases-link" href={RELEASES_URL} target="_blank" rel="noreferrer" data-testid="update-releases-link">
          All releases <Icon name="external" size={12} stroke={2} />
        </a>
      </div>
      {s.releases.length ? (
        <>
          <FadeScroll className="whats-new-scroll" testid="whats-new-list">
            <ol>
              {s.releases.map((r) => (
                <ReleaseRow key={r.version} r={r} current={s.currentVersion} hint={hint} onOpen={open} />
              ))}
            </ol>
          </FadeScroll>
          <span id={hint} className="sr-only">
            Opens the release on GitHub.
          </span>
        </>
      ) : (
        <p className="muted-sm">
          {s.status === 'disabled' ? 'Release notes show here in the installed app.' : 'Release notes show here after Reel Studio checks for updates.'}
        </p>
      )}
    </section>
  )
}
