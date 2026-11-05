// A change coming into focus on the phone, before its draft is made (engine `moments`, shared/live.ts): each still
// of a moment the note changed as it is drawn, then the 2 s around the first one, playing. The phone is where the
// person already watches the reel, and where the first look, the Quick preview and the new version all arrive, so
// the change develops in that one place. The draft then takes over as the Quick preview (reduceLive drops these).
// The timeline is not used: it runs on the clock of the version on screen, and a note that cut words moves every
// later second, so the edit's own times could point at the wrong words there.
import { useEffect, useRef, useState } from 'react'
import type { Moment } from '../../../shared/live'
import { clock } from '../../../shared/progress'

/**
 * Each picture stays at least this long before the next replaces it, so stills drawn in quick succession read as
 * separate moments rather than a flicker. About one glance; no measurement is behind the number.
 */
export const DWELL_MS = 700

const NONE: Moment[] = []

/**
 * Which of a run's pictures the phone shows. It follows the newest, one step per DWELL_MS; a dot the person picks
 * holds there until the next run (a newer edit) arrives. `job` names the job, whose runs count from 1.
 */
export function useChangeMoment(moments: Moment[] | null, job: string | null): { list: Moment[]; index: number; pick: (i: number) => void } {
  const list = moments ?? NONE
  const run = list.length ? `${job}:${list[0].run}` : null
  const [at, setAt] = useState<{ run: string | null; index: number; picked: boolean }>({ run, index: 0, picked: false })
  const shownAt = useRef(0)
  const cur = at.run === run ? at : { run, index: 0, picked: false }
  useEffect(() => {
    if (at.run !== run) {
      shownAt.current = performance.now()
      setAt({ run, index: 0, picked: false })
    }
  }, [run, at.run])
  const behind = !cur.picked && cur.index < list.length - 1
  useEffect(() => {
    if (!behind) return
    const t = window.setTimeout(() => {
      shownAt.current = performance.now()
      setAt((a) => (a.run === run && !a.picked ? { ...a, index: a.index + 1 } : a))
    }, Math.max(0, DWELL_MS - (performance.now() - shownAt.current)))
    return () => window.clearTimeout(t)
  }, [behind, cur.index, run])
  return {
    list,
    index: list.length ? Math.min(cur.index, list.length - 1) : -1,
    pick: (i) => setAt({ run, index: i, picked: true })
  }
}

/** "0:06", or "0:05–0:07" for the window: seconds of the edited video. */
export function momentTime(m: Moment): string {
  return m.kind === 'still' ? clock(m.t) : `${clock(m.from)}–${clock(m.to)}`
}

/**
 * The pictures, drawn on the reel under Instagram's screen like the video itself. Every picture up to the one shown
 * stays mounted, so a new one fades in over the last instead of over black. The layer takes no clicks: a click on the
 * picture still plays the reel, which puts the reel back on screen.
 */
export function ChangePicture({ list, index }: { list: Moment[]; index: number }) {
  return (
    <div className="change-pic" aria-hidden data-testid="change-picture" data-shown={index}>
      {list.slice(0, index + 1).map((m) =>
        m.kind === 'still' ? (
          <img key={m.image} src={m.image} alt="" draggable={false} data-testid="change-still" />
        ) : (
          <video key={m.video} src={m.video} muted autoPlay loop playsInline disablePictureInPicture data-testid="change-window" />
        )
      )}
    </div>
  )
}

/**
 * What the picture is ("Your change · 0:06") where the Quick preview and First look tags sit, and, when the run drew
 * more than one picture, a dot for each: Instagram's own way of saying "more than one picture here". Each dot shows
 * its picture and holds it there.
 */
export function ChangeTag({ list, index, pick }: { list: Moment[]; index: number; pick: (i: number) => void }) {
  const shown = list[index]
  if (!shown) return null
  const label = (m: Moment): string => (m.kind === 'still' ? `Your change at ${momentTime(m)}` : `Your change, ${momentTime(m)}, playing`)
  return (
    <div className="change-tag" data-testid="change-tag">
      <span className="change-label">
        Your change · <span className="tnum">{momentTime(shown)}</span>
      </span>
      {/* each picture as it is shown, once */}
      <span className="sr-only" role="status">
        {label(shown)}
      </span>
      {list.length > 1 && (
        <span className="change-dots" role="group" aria-label="Pictures of your change">
          {list.map((m, i) => (
            <button
              key={m.kind === 'still' ? m.image : m.video}
              aria-label={label(m)}
              aria-pressed={i === index}
              onClick={() => pick(i)}
              data-testid="change-dot"
            >
              <i />
            </button>
          ))}
        </span>
      )}
    </div>
  )
}
