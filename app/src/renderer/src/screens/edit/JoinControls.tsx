import { useMemo, useRef, useState } from 'react'
import { rangesKeepingOrder } from '../../../../shared/cut'
import { cutRows, joinFor, TRANSITION_HINTS, TRANSITION_LABELS, TRANSITIONS, withJoin, type KeepRange, type Transition } from '../../../../shared/joins'
import { clock } from '../../../../shared/progress'
import { reel, userMessage } from '../../api'
import { Segmented } from '../../components/ui'
import type { TabProps } from './controls'

const OPTIONS = TRANSITIONS.map((key) => ({ key, label: TRANSITION_LABELS[key], title: TRANSITION_HINTS[key] }))

/** What the engine said when a match was asked for on one cut. */
type Check = { state: 'checking' } | { state: 'no'; why: string } | { state: 'yes' }

/** The engine's reason without its measurements, which say nothing to the person. */
const plain = (why: string | undefined): string => (why ?? 'its two sides do not line up').replace(/\s*\([^)]*\)\s*$/, '')

/**
 * Cut > Transitions: how each cut between two kept stretches plays, the joins the AI sets with set_cut. A match is
 * checked with the engine when it is picked, and kept only where the frames on both sides line up
 * (engine/reelengine/match.py), so the drawer never promises a match the version won't have.
 */
export function JoinControls({ d, now, change, placed, next }: TabProps) {
  const [checks, setChecks] = useState<Map<string, Check>>(new Map())
  const asked = useRef(new Map<string, number>())
  // the cut as the next version will have it: the ranges after this session's word changes, with their joins
  const keep = useMemo((): KeepRange[] | null => {
    try {
      return rangesKeepingOrder(d.words, now.p.cut?.keep, now.kept)
    } catch {
      return null // a reel made of clips: cuts there are an editor note's to change
    }
  }, [d.words, now.p.cut?.keep, now.kept])
  const rows = useMemo(() => (keep ? cutRows(d.words, keep) : []), [d.words, keep])

  const mark = (at: string, check: Check | null) =>
    setChecks((m) => {
      const out = new Map(m)
      if (check) out.set(at, check)
      else out.delete(at)
      return out
    })
  const put = (at: string, t: Transition) =>
    change((x) => ({ ...x, p: { ...x.p, cut: { ...(x.p.cut ?? { keep: [] }), keep: withJoin(rangesKeepingOrder(d.words, x.p.cut?.keep, x.kept), at, joinFor(t)) } } }))

  const pick = (at: string, index: number, t: Transition) => {
    const ticket = (asked.current.get(at) ?? 0) + 1
    asked.current.set(at, ticket)
    if (t !== 'match' || !keep) {
      mark(at, null)
      put(at, t)
      return
    }
    mark(at, { state: 'checking' })
    reel.projects
      .matchJoins(d.slug, withJoin(keep, at, joinFor('match')))
      .then((verdicts) => {
        if (asked.current.get(at) !== ticket) return // picked something else meanwhile
        const v = verdicts.find((x) => x.keep === index)
        if (v?.matched) {
          put(at, 'match')
          mark(at, { state: 'yes' })
        } else mark(at, { state: 'no', why: plain(v?.why) })
      })
      .catch((e) => asked.current.get(at) === ticket && mark(at, { state: 'no', why: userMessage(e) }))
  }

  if (!keep) return <p className="edit-hint">This reel is made of clips. Ask the editor in a note to change how its cuts play.</p>

  return (
    <div className="edit-stack" data-testid="joins">
      <p className="edit-hint" data-testid="joins-later">
        The player shows the cuts as made. What you pick here plays in Version {next}.
      </p>
      <div className="edit-field">
        <h3 className="edit-label" id="joins-h">
          Cuts
        </h3>
        {rows.length ? (
          <ul className="edit-list" aria-labelledby="joins-h" data-testid="join-list">
            {rows.map((row) => {
              const at = now.kept.has(row.at) ? placed.get(row.at)?.s : undefined
              const when = at === undefined ? null : clock(at)
              const check = checks.get(row.at)
              const value = check?.state === 'checking' ? 'match' : row.transition
              return (
                <li key={row.at} className="edit-row join-row" data-testid="join-row">
                  <span className="edit-row-main">
                    <span className="edit-row-title">
                      “…{row.before}”{when && <span className="muted tnum"> · {when}</span>}
                    </span>
                    <span className="edit-row-sub">then “{row.after}…”</span>
                    {check && (
                      <span className={`edit-row-sub${check.state === 'no' ? ' warn' : ''}`} role="status" data-testid="join-check">
                        {check.state === 'checking'
                          ? 'Checking the frames on both sides…'
                          : check.state === 'yes'
                            ? 'Lines up, so this cut hides.'
                            : `No match here: ${check.why}.`}
                      </span>
                    )}
                  </span>
                  <Segmented
                    label={`How the cut before “${row.after}”${when ? ` at ${when}` : ''} plays`}
                    value={value}
                    options={OPTIONS}
                    onPick={(t) => pick(row.at, row.index, t)}
                    testid="join-kind"
                    className="zoom-kind"
                  />
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="edit-hint">This version has no cuts between parts yet. Cut some words and they show here.</p>
        )}
        {rows.length > 0 && (
          <p className="edit-hint">
            J lets the next part be heard first, L lets the sound run on, Smash hits the cut with a sound. Match is kept only where both sides line up.
          </p>
        )}
      </div>
    </div>
  )
}
