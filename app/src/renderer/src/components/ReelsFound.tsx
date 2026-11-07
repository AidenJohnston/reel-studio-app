// "Reels in this video": the other reels the editor found in a reel's video (main/propose-reels.ts), each with a tick,
// and one button that makes the ticked ones. It sits below the notes, above the note box, and follows the Plan card:
// one surface, rows split by hairlines, the same ticks. No score: the editor's order is its ranking, and its sentence
// says why. That sentence and the quote show on the editor's first pick; the other rows keep theirs behind a
// disclosure, so three rows fit the column at 1100 × 720 without a scroll inside the log's scroll.
import { useEffect, useRef, useState } from 'react'
import type { StoredProposal } from '../../../shared/api'
import { clock } from '../../../shared/progress'
import { reel, userMessage } from '../api'
import { Icon } from './icons'
import { Button } from './ui'
import './plan.css'
import './reels-found.css'

const makeLabel = (n: number): string => (n === 0 ? 'Make reels' : n === 1 ? 'Make this reel' : `Make ${n} reels`)

/** The first row the editor ranks highest starts ticked, if it is still to make. */
const firstOpen = (p: StoredProposal): string[] => {
  const top = p.candidates.find((c) => !p.made[c.id])
  return top ? [top.id] : []
}

export function ReelsFound({
  slug,
  proposal,
  busy,
  enter,
  onLookAgain,
  onChanged,
  onOpen,
  onError
}: {
  slug: string
  proposal: StoredProposal
  /** a job runs on this reel: nothing can be made until it ends */
  busy: boolean
  /** it just arrived on this screen: it enters like a result line */
  enter: boolean
  onLookAgain: () => void
  /** the proposal changed in app.json: read the reel again */
  onChanged: () => Promise<unknown>
  onOpen: (slug: string) => void
  onError: (message: string) => void
}) {
  const [picked, setPicked] = useState<string[]>(() => firstOpen(proposal))
  // rows showing their quote and why: the first pick, and any the person opened
  const [shown, setShown] = useState<string[]>(() => firstOpen(proposal))
  const [making, setMaking] = useState(false)
  // opened again from its folded line by a click: it enters the way it first did
  const [reopened, setReopened] = useState(false)
  // Where focus goes once the card changes shape under it. The request waits for the reel to be read again, until
  // its target is on screen: Show, the first tick (or the first Open when all are made), or the newest Open.
  const focusNext = useRef<{ to: 'show' } | { to: 'first' } | { to: 'open'; id: string } | null>(null)
  const box = useRef<HTMLElement>(null)
  const show = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const want = focusNext.current
    if (!want) return
    const el =
      want.to === 'show'
        ? show.current
        : want.to === 'first'
          ? (box.current?.querySelector<HTMLElement>('input[type="checkbox"]:not(:disabled)') ?? box.current?.querySelector<HTMLElement>('[data-open]'))
          : box.current?.querySelector<HTMLElement>(`[data-open="${want.id}"]`)
    if (!el) return
    focusNext.current = null
    el.focus()
  })

  const fold = async (folded: boolean) => {
    focusNext.current = { to: folded ? 'show' : 'first' }
    setReopened(!folded)
    try {
      await reel.projects.foldReels(slug, folded)
      await onChanged()
    } catch (e) {
      focusNext.current = null
      onError(userMessage(e))
    }
  }
  const make = async () => {
    const ids = proposal.candidates.filter((c) => picked.includes(c.id) && !proposal.made[c.id]).map((c) => c.id)
    if (!ids.length) return
    setMaking(true)
    try {
      await reel.projects.makeReels(slug, ids)
      setPicked([])
      focusNext.current = { to: 'open', id: ids[0] }
    } catch (e) {
      onError(userMessage(e))
    } finally {
      setMaking(false)
      await onChanged()
    }
  }

  const n = proposal.candidates.length
  if (proposal.folded)
    return (
      <div className="rf rf-folded" role="group" aria-label="Reels in this video" data-testid="reels-found" data-folded>
        <span>
          {n} {n === 1 ? 'reel' : 'reels'} found
        </span>
        <span className="sep" aria-hidden>
          ·
        </span>
        <button ref={show} className="lk" aria-expanded={false} onClick={() => void fold(false)} data-testid="reels-show">
          Show
        </button>
      </div>
    )

  const ticked = picked.filter((id) => !proposal.made[id]).length
  return (
    <section ref={box} className={`rf${enter || reopened ? ' enter' : ''}`} aria-label="Reels in this video" aria-busy={making || undefined} data-testid="reels-found">
      <div className="rf-head">
        <h3>Reels in this video</h3>
        <button className="lk" onClick={onLookAgain} disabled={busy || making} data-testid="reels-again">
          Look again
        </button>
      </div>
      <ol className="rf-list">
        {proposal.candidates.map((c) => {
          const made = proposal.made[c.id]
          const id = `rf-${slug}-${c.id}`
          const open = shown.includes(c.id)
          return (
            <li key={c.id} className={`pl-row rf-row${made ? ' made' : ''}`} data-testid="reels-row">
              {made ? (
                <span aria-hidden />
              ) : (
                <label className="pl-tick">
                  <input
                    id={id}
                    type="checkbox"
                    checked={picked.includes(c.id)}
                    disabled={making}
                    onChange={() => setPicked((p) => (p.includes(c.id) ? p.filter((x) => x !== c.id) : [...p, c.id]))}
                    data-testid="reels-tick"
                  />
                  <span aria-hidden>{picked.includes(c.id) ? <Icon name="check" size={10} stroke={2.6} /> : null}</span>
                </label>
              )}
              <div className="rf-body">
                <div className="rf-title">
                  {made ? <b>{c.title}</b> : <label htmlFor={id}>{c.title}</label>}
                  {made ? (
                    <button className="lk" onClick={() => onOpen(made)} aria-label={`Open ${c.title}`} data-open={c.id} data-testid="reels-open">
                      Open
                    </button>
                  ) : (
                    <span className="rf-len">{clock(c.seconds)}</span>
                  )}
                  <button
                    className="rf-more"
                    aria-expanded={open}
                    aria-controls={`${id}-why`}
                    aria-label={`Why this reel: ${c.title}`}
                    onClick={() => setShown((s) => (open ? s.filter((x) => x !== c.id) : [...s, c.id]))}
                    data-testid="reels-why"
                  >
                    <Icon name="chevron-down" size={14} />
                  </button>
                </div>
                <div id={`${id}-why`} className={`rf-acc${open ? ' open' : ''}`} inert={!open || undefined}>
                  <div>
                    <p className="rf-hook" title={c.hookText}>
                      “{c.hookText}”
                    </p>
                    <p className="rf-why" data-testid="reels-why-text">
                      {c.why}
                    </p>
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ol>
      <div className="rf-acts">
        <Button size="small" disabled={!ticked || busy || making} onClick={() => void make()} data-testid="reels-make">
          {makeLabel(ticked)}
        </Button>
        <Button kind="tertiary" size="small" onClick={() => void fold(true)} data-testid="reels-later">
          Not now
        </Button>
      </div>
    </section>
  )
}
