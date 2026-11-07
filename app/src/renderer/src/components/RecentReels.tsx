// Insights > Your recent reels: one thing that's working, one moment, one edit to try (shared/wrapped.ts). Built only
// when the creator asks, from what is saved on this computer; "Try this edit" opens that reel with the note written
// and unsent.
import { useState } from 'react'
import type { WrappedEdit, WrappedReport } from '../../../shared/wrapped'
import type { Go } from '../nav'
import { reel, userMessage } from '../api'
import { Button, Spinner } from './ui'
import './recent-reels.css'

export function RecentReels({ go }: { go: Go }) {
  const [report, setReport] = useState<WrappedReport | null>(null)
  // Without an AI editor the reel shows no note box, so the written note would be out of sight: say so here.
  const [editor, setEditor] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const look = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const [r, active] = await Promise.all([reel.wrapped.report(), reel.ai.active().catch(() => null)])
      setEditor(!!active && active.connected && active.id !== 'none')
      setReport(r)
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="recent-reels" aria-labelledby="recent-h" data-testid="recent-reels">
      <h2 id="recent-h">Your recent reels</h2>
      {!report && (
        <>
          <p className="muted-sm">
            Compares your last 3 posted reels with each other, using the results saved on this computer and the timing of your own videos. Nothing is sent
            anywhere, and it doesn't score you.
          </p>
          <div className="row">
            <Button size="small" disabled={busy} aria-busy={busy} onClick={() => void look()} data-testid="recent-look">
              {busy ? <Spinner /> : 'Look at my recent reels'}
            </Button>
          </div>
          {error && (
            <p className="pv-note error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
      {report?.state === 'too-few' && (
        <div className="recent-body">
          <p data-testid="recent-too-few">
            {report.posted === 0
              ? 'There are no results for posted reels on this computer yet. Post 3 reels and connect where you posted them, and this compares them.'
              : `Only ${report.posted} posted ${report.posted === 1 ? 'reel has' : 'reels have'} results so far. With 3, this compares them.`}
          </p>
          {report.edit && <TryEdit edit={report.edit} go={go} editor={editor} label="From your newest reels" />}
        </div>
      )}
      {report?.state === 'ready' && (
        <div className="recent-body" data-testid="recent-report">
          <div>
            <span className="recent-label">Working</span>
            <b>{report.strength.headline}</b>
            <p className="muted-sm">{report.strength.detail}</p>
          </div>
          {report.edit ? (
            <TryEdit edit={report.edit} go={go} editor={editor} label="One to try" />
          ) : (
            <p className="muted-sm">Nothing in these reels' timing stands out to change: they start talking at once, change shot early and end on the last word.</p>
          )}
          {report.notes.length > 0 && (
            <ul className="recent-notes muted-sm">
              {report.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <p className="muted-sm">Three reels can point at something to try. They can't prove why one did better.</p>
        </div>
      )}
    </section>
  )
}

/** One edit to try, and the button that writes it into that reel's note box (unsent). */
function TryEdit({ edit, go, editor, label }: { edit: WrappedEdit; go: Go; editor: boolean; label: string }) {
  return (
    <div data-testid="recent-edit">
      <span className="recent-label">{label}</span>
      <b>{edit.headline}</b>
      <p className="muted-sm">{edit.detail}</p>
      {edit.fixedIn !== null ? (
        <p className="muted-sm" data-testid="recent-fixed">
          That was the posted version. Version {edit.fixedIn}, made since, doesn't have this. Post it and compare.
        </p>
      ) : !editor ? (
        <div className="row" data-testid="recent-no-editor">
          <span className="muted-sm">Notes need an AI editor. Connect one, and this writes the note for you.</span>
          <Button size="small" onClick={() => go({ name: 'connect', back: { name: 'insights' } })}>
            Connect an editor
          </Button>
        </div>
      ) : (
        <>
          <div className="row">
            <Button size="small" onClick={() => go({ name: 'reel', slug: edit.project, draft: edit.note })} data-testid="recent-try">
              {edit.editName}
            </Button>
            {edit.changes !== null && <span className="muted-sm">It changes Version {edit.changes}, the newest.</span>}
          </div>
          <p className="muted-sm">{edit.measure}</p>
        </>
      )}
    </div>
  )
}
