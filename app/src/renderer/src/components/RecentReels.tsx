// Insights > Your recent reels: one thing that's working, one moment, one edit to try (shared/wrapped.ts). Built only
// when the creator asks, from what is saved on this computer; "Try this edit" opens that reel with the note written
// and unsent.
import { useState } from 'react'
import type { WrappedReport } from '../../../shared/wrapped'
import type { Go } from '../nav'
import { reel, userMessage } from '../api'
import { Button, Spinner } from './ui'
import './recent-reels.css'

export function RecentReels({ go }: { go: Go }) {
  const [report, setReport] = useState<WrappedReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const look = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setReport(await reel.wrapped.report())
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
        <p data-testid="recent-too-few">
          {report.posted === 0
            ? 'There are no results for posted reels on this computer yet. Post 3 reels and connect where you posted them, and this compares them.'
            : `Only ${report.posted} posted ${report.posted === 1 ? 'reel has' : 'reels have'} results so far. With 3, this compares them.`}
        </p>
      )}
      {report?.state === 'ready' && (
        <div className="recent-body" data-testid="recent-report">
          <div>
            <span className="recent-label">Working</span>
            <b>{report.strength.headline}</b>
            <p className="muted-sm">{report.strength.detail}</p>
          </div>
          {report.edit ? (
            <div data-testid="recent-edit">
              <span className="recent-label">One to try</span>
              <b>{report.edit.headline}</b>
              <p className="muted-sm">{report.edit.detail}</p>
              {report.edit.fixedIn !== null ? (
                <p className="muted-sm" data-testid="recent-fixed">
                  That was the posted version. Version {report.edit.fixedIn}, made since, doesn't have this. Post it and compare.
                </p>
              ) : (
                <>
                  <div className="row">
                    <Button size="small" onClick={() => go({ name: 'reel', slug: report.edit!.project, draft: report.edit!.note })} data-testid="recent-try">
                      {report.edit.editName}
                    </Button>
                    {report.edit.changes !== null && <span className="muted-sm">It changes Version {report.edit.changes}, the newest.</span>}
                  </div>
                  <p className="muted-sm">{report.edit.measure}</p>
                </>
              )}
            </div>
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
