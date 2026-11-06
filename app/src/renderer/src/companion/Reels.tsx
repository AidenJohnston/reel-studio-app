// Every reel on the computer, as a wall of 9:16 covers two across: the shape a creator's own Reels grid has.
// A reel being made carries its job's words and a slim bar under its title.
import { useEffect, useState, type MouseEvent } from 'react'
import type { ProjectId, ReelSummaryDto } from '../../../shared/contract'
import { Progress } from '../components/ui'
import { CompanionError, call, mediaUrl } from './client'
import type { LiveJobs, Pulse } from './Shell'
import { isMaking, jobWords, statusOf } from './words'

export function ReelsScreen({
  pulse,
  jobs,
  reels,
  onReels,
  onOpen,
  onOffline
}: {
  pulse: Pulse
  jobs: LiveJobs
  reels: ReelSummaryDto[] | null
  onReels: (r: ReelSummaryDto[]) => void
  onOpen: (id: ProjectId) => void
  onOffline: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  // The summary carries no job, so a reel already being made when the list loads is read once for its job; after
  // that its `job` events keep it current.
  const [seeded, setSeeded] = useState<LiveJobs>({})

  useEffect(() => {
    let gone = false
    call('projects.list', []).then(
      (list) => {
        if (gone) return
        onReels(list)
        setError(null)
        for (const r of list.filter((x) => isMaking(x.status))) {
          call('projects.get', [r.id]).then(
            (full) => !gone && setSeeded((s) => ({ ...s, [r.id]: full.job })),
            () => {
              /* the card still says Making Version N; its next job event fills in the rest */
            }
          )
        }
      },
      (e: unknown) => {
        if (gone) return
        if (e instanceof CompanionError && e.kind === 'offline') onOffline()
        else if (!(e instanceof CompanionError && e.kind === 'unpaired')) setError(e instanceof CompanionError ? e.userMessage : "Couldn't read your reels. Try again.")
      }
    )
    return () => {
      gone = true
    }
    // read again on every pulse; nothing else should start a read
  }, [pulse.n])

  return (
    <>
      <h1 className="cp-title">Your reels</h1>
      {error && (
        <p className="banner error" role="alert">
          <span>{error}</span>
        </p>
      )}
      {reels === null ? (
        !error && <Waiting />
      ) : reels.length === 0 ? (
        <p className="cp-empty" data-testid="cp-reels-empty">No reels yet. Make one in Reel Studio on your computer, and it shows up here.</p>
      ) : (
        <ul className="cp-grid">
          {reels.map((r) => (
            <li key={r.id}>
              <Card r={r} job={r.id in jobs ? jobs[r.id] : (seeded[r.id] ?? null)} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function Card({ r, job, onOpen }: { r: ReelSummaryDto; job: LiveJobs[string]; onOpen: (id: ProjectId) => void }) {
  const status = statusOf(r)
  const making = isMaking(r.status)
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    // a new tab or window (Cmd/Ctrl-click, middle click) opens the reel there, by its link
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    onOpen(r.id)
  }
  return (
    <a className="cp-card" href={`#r=${encodeURIComponent(r.id)}`} onClick={go} data-testid="cp-reel-row">
      <span className="cp-card-pic">
        {r.cover ? <img src={mediaUrl(r.cover)} alt="" loading="lazy" decoding="async" /> : <span className="cp-card-blank">{r.title}</span>}
      </span>
      <span className="cp-card-title">{r.title}</span>
      <span className={`badge ${status.tone}`}>{status.words}</span>
      {making && job && (
        <span className="cp-card-job">
          <span className="cp-card-step">{jobWords(job)}</span>
          <Progress pct={job.overall} label={`${r.title}: progress`} />
        </span>
      )}
    </a>
  )
}

/** Four blank covers while the list is read, so the grid doesn't jump in from nothing. */
function Waiting() {
  return (
    <>
      <p className="sr-only" role="status">
        Reading your reels…
      </p>
      <ul className="cp-grid" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="cp-card waiting">
            <span className="cp-card-pic" />
            <span className="cp-card-line" />
          </li>
        ))}
      </ul>
    </>
  )
}
