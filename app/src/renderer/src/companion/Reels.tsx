// Every reel on the computer, as a wall of 9:16 covers two across: the shape a creator's own Reels grid has.
// A reel being made carries its job's words and a slim bar under its title.
import { useEffect, useRef, useState, type MouseEvent } from 'react'
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
  onOffline,
  focusOn
}: {
  pulse: Pulse
  jobs: LiveJobs
  reels: ReelSummaryDto[] | null
  onReels: (r: ReelSummaryDto[]) => void
  onOpen: (id: ProjectId) => void
  onOffline: () => void
  /** The reel just left with Back: its card takes focus again. */
  focusOn: ProjectId | null
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
        // a job read before this list (or before a reconnect) is kept only for a reel the list still calls making
        setSeeded((s) => Object.fromEntries(Object.entries(s).filter(([id]) => list.some((x) => x.id === id && isMaking(x.status)))))
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

  const grid = useRef<HTMLUListElement>(null)
  const listed = reels !== null
  useEffect(() => {
    if (!focusOn || !listed) return
    grid.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusOn)}"]`)?.focus({ preventScroll: true })
  }, [focusOn, listed])

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
        <ul className="cp-grid" ref={grid}>
          {reels.map((r, i) => (
            <li key={r.id}>
              <Card r={r} eager={i < 4} job={r.id in jobs ? jobs[r.id] : (seeded[r.id] ?? null)} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** `eager`: the first row or two, on screen at once, load before the rest. */
function Card({ r, eager, job, onOpen }: { r: ReelSummaryDto; eager: boolean; job: LiveJobs[string]; onOpen: (id: ProjectId) => void }) {
  const status = statusOf(r)
  const making = isMaking(r.status)
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    // a new tab or window (Cmd/Ctrl-click, middle click) opens the reel there, by its link
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    onOpen(r.id)
  }
  return (
    <a className="cp-card" href={`#r=${encodeURIComponent(r.id)}`} onClick={go} data-id={r.id} data-testid="cp-reel-row">
      <span className="cp-card-pic">
        {r.cover ? (
          <img src={mediaUrl(r.cover)} alt="" loading={eager ? 'eager' : 'lazy'} decoding="async" />
        ) : (
          <span className="cp-card-blank" aria-hidden>
            {r.title}
          </span>
        )}
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
