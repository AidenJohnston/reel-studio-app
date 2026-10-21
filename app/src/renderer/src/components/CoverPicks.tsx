import { useEffect, useState, type KeyboardEvent } from 'react'
import type { CoverCandidate } from '../../../shared/api'
import { coverReason } from '../../../shared/cover'
import { clock } from '../../../shared/progress'
import { userMessage } from '../api'
import { Icon } from './icons'

const ARROW_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/** The cover suggestions: the best frame of you near a few moments of the video, each with its time and
 * why it was picked. Picking one hands its exact time back. */
export function CoverPicks({
  load,
  waiting,
  chosen,
  onPick
}: {
  /** the engine's answer; the drawer keeps one per opening so switching tabs does not look again */
  load: () => Promise<CoverCandidate[]>
  /** how many frames are being looked for (the placeholders while it looks) */
  waiting: number
  /** the cover's time now, in raw-take seconds */
  chosen: number
  onPick: (c: CoverCandidate) => void
}) {
  const [picks, setPicks] = useState<CoverCandidate[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    load()
      .then((r) => live && setPicks(r))
      .catch((e) => {
        if (!live) return
        setProblem(userMessage(e))
        setPicks([])
      })
    return () => {
      live = false
    }
    // load hands back the drawer's one promise, so only the first call matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isChosen = (c: CoverCandidate) => Math.abs(c.atSourceTime - chosen) < 0.01

  // One Tab stop for the group; arrow keys move and pick, as in any set of radio buttons.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEP[e.key]
    if (!step || !picks?.length) return
    e.preventDefault()
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=radio]')]
    const i = (Math.max(0, buttons.findIndex((b) => b === document.activeElement)) + step + picks.length) % picks.length
    buttons[i].focus()
    onPick(picks[i])
  }

  return (
    <section className="stack" aria-labelledby="cover-picks-title">
      <div>
        <h3 id="cover-picks-title">Picked from your video</h3>
        {picks?.length !== 0 && <p className="muted-sm">The moments where your face is clearest. Pick one, or choose any moment below.</p>}
      </div>
      {picks === null ? (
        <div className="cover-picks" aria-busy="true" data-testid="cover-picks-loading">
          <p className="muted-sm cover-picks-status" role="status">Looking through your video</p>
          {Array.from({ length: waiting }, (_, i) => (
            <span key={i} className="cover-pick">
              <span className="cover-pick-frame cover-pick-wait" />
            </span>
          ))}
        </div>
      ) : picks.length === 0 ? (
        <p className="muted-sm" data-testid="cover-picks-none">
          {problem ?? 'I could not find a clear frame of your face. Pick any moment below.'}
        </p>
      ) : (
        <div className="cover-picks" role="radiogroup" aria-labelledby="cover-picks-title" onKeyDown={onKey} data-testid="cover-picks">
          {picks.map((c, i) => {
            const on = isChosen(c)
            const tabbable = on || (i === 0 && !picks.some(isChosen))
            const why = coverReason(c)
            return (
              <button
                key={c.atSourceTime}
                role="radio"
                aria-checked={on}
                tabIndex={tabbable ? 0 : -1}
                aria-label={`${clock(c.atSourceTime)}, ${why}`}
                className={`cover-pick${on ? ' on' : ''}`}
                onClick={() => onPick(c)}
                data-testid="cover-pick"
              >
                <span className="cover-pick-frame">
                  <img src={c.image} alt="" />
                  {on && (
                    <span className="cover-pick-check">
                      <Icon name="check" size={14} stroke={2.5} />
                    </span>
                  )}
                </span>
                <span className="cover-pick-time">{clock(c.atSourceTime)}</span>
                <span className="cover-pick-why">{why}</span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
