import { useRef, useState, type ReactNode } from 'react'
import type { NoteMoment } from '../../../shared/api'
import { clock } from '../../../shared/progress'
import { momentLabel } from '../../../shared/moments'
import { timeLeftWords, type LiveState } from '../../../shared/live'
import { STEP_LABEL, stepNote, type Step } from '../../../shared/steps'
import { Icon } from './icons'
import { usePlayhead, type Playhead } from './playhead'
import { AttachmentChips, type useNoteAttachments } from './NoteAttachments'
import { PopMenu } from './PopMenu'
import { usePresence } from './motion'
import { Thinking } from './ui'

/** What a note is about: a moment or a range, and a numbered spot on the picture. */
export type Chip = { at: number; to?: number; spot?: { x: number; y: number; n: number } } | null

/** "top left", "the middle"...: where on the picture, in words the editor reads with the note. */
export function region(x: number, y: number): string {
  const v = y < 0.34 ? 'top' : y > 0.66 ? 'bottom' : 'middle'
  const h = x < 0.34 ? ' left' : x > 0.66 ? ' right' : ''
  return v === 'middle' && !h ? 'the middle' : `${v}${h}`
}

export const chipLabel = (c: NonNullable<Chip>): string => `${momentLabel(c)}${c.spot ? ` · ${region(c.spot.x, c.spot.y)}` : ''}`

/**
 * The note box. While a version is being made its top edge is the progress strip (the time left, the step, Steps,
 * Stop) and Steps opens the list upward; after Stop it says the notes are held. The moment chip shows the
 * playhead and attaches it in one click; it is attached already once the person stopped on a moment (`auto`), and its
 * menu points at a spot on the picture.
 */
export function Composer({
  draft,
  onDraft,
  chip,
  onChip,
  auto,
  onDropAuto,
  onPoint,
  plain,
  playhead,
  att,
  checking,
  waitToSend,
  placeholder,
  job,
  making,
  firstSteps,
  steps,
  stepsOpenFirst,
  noSteps,
  stepNote: running,
  under,
  held,
  heldWhy,
  alert,
  connect,
  onSend,
  onAdd,
  base,
  onStop,
  onRunNext,
  onClear,
  inputRef
}: {
  draft: string
  onDraft: (t: string) => void
  chip: Chip
  onChip: (c: Chip) => void
  /** the playhead is attached as the moment: the person paused, scrubbed or pressed C since their last note */
  auto: boolean
  /** × on the moment attached by itself */
  onDropAuto: () => void
  onPoint: () => void
  /** words only: no moment chip and no paperclip (planning, or before Version 1 exists to point at) */
  plain: boolean
  playhead: Playhead
  att: ReturnType<typeof useNoteAttachments>
  checking: boolean
  /** the editor is answering a planning turn: the words can be written, and sent once it has answered */
  waitToSend: boolean
  placeholder: string
  job: LiveState | null
  /** the version the running job will make */
  making: number | null
  /** Version 1's rows, from main */
  firstSteps: Step[] | null
  /** what a note's job has said it was doing, in order */
  steps: string[]
  /** Version 1 opens with its steps showing */
  stepsOpenFirst: boolean
  /** a planning turn has one step, which the strip already names: no Steps list */
  noSteps?: boolean
  /** the running note, so a step that quotes it shows its moment the way the log does */
  stepNote?: { text: string; moment?: NoteMoment } | null
  /** under the steps (asking about notifications during Version 1) */
  under?: ReactNode
  /** notes held after Stop or a failed note */
  held: number
  /** held by a pause that ends by itself ("Continues at 3:40 PM"), not by the person */
  heldWhy?: string | null
  alert: string | null
  /** the editor picker, in place of the box, when no editor is connected */
  connect: ReactNode
  onSend: () => void
  /** ⌘/Ctrl+Enter: into the version being made now (Add now); absent when nothing can take it */
  onAdd?: () => void
  /** the older version the next note changes (Versions > Change this one), and how to go back to the newest */
  base?: { n: number; onClear: () => void } | null
  onStop: () => void
  onRunNext: () => void
  onClear: () => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
}) {
  const second = usePlayhead(playhead, Math.floor)
  const [stepsToggled, setStepsToggled] = useState<string | null>(null)
  const [focus, setFocus] = useState(false)
  const [menu, setMenu] = useState(false)
  const caret = useRef<HTMLButtonElement>(null)
  const strip = job ? 'job' : held ? 'held' : null
  const { mounted: stripShown } = usePresence(!!strip, 200)
  const canSend = (!!draft.trim() || att.chips.length > 0) && !att.busy && !checking && !waitToSend
  // Steps opens per job: Version 1 starts open, a note starts closed
  const stepsOpen = job ? (stepsToggled === job.jobId ? !stepsOpenFirst : stepsOpenFirst) : false
  const now = firstSteps?.find((s) => s.state === 'now')
  // Version 1 names its step, unless the step is waiting on the editor: then the wait is what is happening
  const current = firstSteps && !job?.waiting ? (now ? STEP_LABEL[now.id] : null) : job?.message
  const pct = job ? Math.min(1, job.overall / 100) : 0
  const left = job ? timeLeftWords(job) : null

  return (
    <div className={`cbox${focus ? ' focus' : ''}${connect ? ' bare' : ''}`} data-note-drop={!connect || undefined} data-testid={connect ? undefined : 'note-drop'}>
      <div className={`stripwrap${strip ? ' on' : ''}`}>
        <div>
          {stripShown && strip === 'job' && job && (
            <>
              <div className={`steps${stepsOpen ? ' on' : ''}`} inert={!stepsOpen || undefined}>
                <div>
                  <ul aria-label="Steps" data-testid="steps-list">
                    {firstSteps
                      ? <StepRows steps={firstSteps} />
                      : steps.map((s, i) => (
                          <li key={`${i}-${s}`} className={i === steps.length - 1 ? 'st-now' : 'st-done'}>
                            <StepMark state={i === steps.length - 1 ? 'now' : 'done'} />
                            <span className="sl">
                              <StepText s={s} note={running} />
                            </span>
                          </li>
                        ))}
                  </ul>
                  {under}
                </div>
              </div>
              <div className="strip" data-testid="note-progress">
                {/* announced once per step, not on every tick of the time left */}
                <span className="sr-only" role="status">
                  {making ? `Making Version ${making}` : job.message}
                  {making && current ? `, ${current}` : ''}
                </span>
                <span className="bar" aria-hidden>
                  <i style={{ transform: `scaleX(${pct})` }} />
                </span>
                {job.thinking ? <Thinking /> : <span className="spin light" aria-hidden />}
                {/* The time left is the one number a waiting person wants, so it leads and is never cut short. The line
                    above the box already says "Making Version N", which needs no repeating here: the column has no room
                    for both beside Steps and Stop. Before there is an estimate, the version leads. */}
                {/* the version is in the status above for screen readers; the time left is only here */}
                {making ? (
                  left ? (
                    <b className="time" data-testid="note-time-left">
                      {left}
                    </b>
                  ) : (
                    <b aria-hidden>Version {making}</b>
                  )
                ) : (
                  <>
                    <b aria-hidden>{job.message}</b>
                    {left && (
                      <span className="time" data-testid="note-time-left">
                        · {left}
                      </span>
                    )}
                  </>
                )}
                {/* the open list above names the step; the strip says it only when the list is shut, or when it is a wait,
                    and only before the time left leads: beside it there is room for a stub of the words, not the words */}
                {making && current && !left && (!stepsOpen || job.waiting) && <span className="m">· {current}</span>}
                <span className="sp" />
                {!noSteps && (
                  <button className="sbtn" aria-expanded={stepsOpen} onClick={() => setStepsToggled((t) => (t === job.jobId ? null : job.jobId))} data-testid="steps">
                    Steps <Icon name={stepsOpen ? 'chevron-down' : 'up'} size={12} stroke={2} />
                  </button>
                )}
                <button className="sbtn" onClick={onStop} data-testid="stop">
                  Stop
                </button>
              </div>
            </>
          )}
          {stripShown && strip === 'held' && (
            <div className="strip wait" role="status" data-testid="queue-held">
              <b data-testid="queue-count">{held === 1 ? '1 note held' : `${held} notes held`}</b>
              <span className="m">· {heldWhy ?? 'waiting for you to send'}</span>
              <span className="sp" />
              <button className="sbtn" onClick={onClear} data-testid="queue-clear">
                Clear
              </button>
              <button className="sbtn" onClick={onRunNext} data-testid="queue-run-next">
                Send now
              </button>
            </div>
          )}
        </div>
      </div>
      {connect ?? (
        <>
          {base && (
            <span className="base-chip" data-testid="note-base">
              New version from Version {base.n}
              <button
                className="x"
                aria-label={`Change the newest version instead of Version ${base.n}`}
                onClick={() => {
                  base.onClear()
                  inputRef.current?.focus()
                }}
                data-testid="note-base-clear"
              >
                <Icon name="x" size={12} stroke={2} />
              </button>
            </span>
          )}
          <AttachmentChips chips={att.chips} busy={att.busy} onRemove={(a) => void att.remove(a)} />
          {alert && (
            <p className="cin-alert" role="alert" data-testid="change-alert">
              {alert}
            </p>
          )}
          <div className="cin">
            {!plain && <button className="att" onClick={att.choose} disabled={checking} aria-label="Attach a picture or a clip" title="Attach a picture or a clip" data-testid="note-attach">
              <Icon name="paperclip" size={17} />
            </button>}
            <div className="cfield">
              {plain ? null : chip || auto ? (
                <span className="tchip" data-auto={chip ? undefined : true} data-testid="moment-chip">
                  {chip?.spot && <span className="spot-n">{chip.spot.n}</span>}
                  {chip ? chipLabel(chip) : clock(second)}
                  <button
                    className="x"
                    aria-label="Remove the moment"
                    onClick={() => {
                      if (chip) onChip(null)
                      else onDropAuto()
                      inputRef.current?.focus()
                    }}
                    data-testid="moment-remove"
                  >
                    <Icon name="x" size={12} stroke={2} />
                  </button>
                </span>
              ) : (
                <span className="tchip-split">
                  <button
                    className="tchip suggest"
                    onClick={() => {
                      onChip({ at: playhead.get() })
                      inputRef.current?.focus()
                    }}
                    aria-label={`Attach the moment on screen, ${clock(second)}`}
                    title="About this moment"
                    disabled={checking}
                    data-testid="moment-suggest"
                  >
                    <Icon name="plus" size={12} stroke={2} />
                    {clock(second)}
                  </button>
                  <button
                    ref={caret}
                    className="tchip suggest caret"
                    aria-label="More ways to say where"
                    aria-haspopup="menu"
                    aria-expanded={menu}
                    disabled={checking}
                    onClick={() => setMenu((m) => !m)}
                    data-testid="moment-menu"
                  >
                    <Icon name="chevron-down" size={12} stroke={2} />
                  </button>
                  <PopMenu open={menu} onClose={() => setMenu(false)} anchor={caret} label="Say where" style={{ left: 0, bottom: 'calc(100% + 6px)', width: 220 }} origin="bottom left">
                    <button
                      className="mi"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false)
                        onPoint()
                      }}
                      data-testid="point-at-spot"
                    >
                      <Icon name="comment-plus" size={16} /> Point at a spot
                      <span className="r">
                        <kbd className="kbd">C</kbd>
                      </span>
                    </button>
                  </PopMenu>
                </span>
              )}
              <textarea
                ref={inputRef}
                rows={1}
                value={draft}
                onChange={(e) => onDraft(e.target.value)}
                onPaste={checking ? undefined : att.onPaste}
                onFocus={() => setFocus(true)}
                onBlur={() => setFocus(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (!canSend) return
                    if ((e.metaKey || e.ctrlKey) && onAdd) onAdd()
                    else onSend()
                  }
                }}
                disabled={checking}
                aria-label={placeholder}
                placeholder={checking ? 'Checking for your editor…' : placeholder}
                data-testid="note-input"
              />
            </div>
            <button className={`send${canSend ? ' ready' : ''}`} onClick={onSend} disabled={!canSend} aria-label="Send" data-testid="send">
              <Icon name="arrow-up" size={16} stroke={2} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Version 1's rows as main sends them; the first run's sample draws the same rows. */
export function StepRows({ steps }: { steps: Step[] }) {
  return steps.map((s) => (
    <li key={s.id} className={`st-${s.state}`} data-state={s.state}>
      <StepMark state={s.state} />
      <span className="sl">{STEP_LABEL[s.id]}</span>
      {stepNote(s) ? <span className={`sr${s.state === 'skipped' ? ' amber' : ''}`}>{stepNote(s)}</span> : s.result && <span className="sr">{s.result}</span>}
    </li>
  ))
}

function StepMark({ state }: { state: Step['state'] }) {
  if (state === 'done')
    return (
      <span className="ok" aria-label="Done">
        <Icon name="check" size={8} stroke={3} />
      </span>
    )
  if (state === 'now') return <span className="spin light" aria-label="Now" />
  return <span className={`todo${state === 'todo' ? '' : ' passed'}`} aria-label={state === 'todo' ? 'To do' : state === 'skipped' ? 'Skipped' : 'Stopped'} />
}

/** A step line; where it quotes the running note, the note's moment sits before its words. */
function StepText({ s, note }: { s: string; note?: { text: string; moment?: NoteMoment } | null }) {
  const at = note?.moment && note.text ? s.indexOf(`"${note.text}"`) : -1
  if (at < 0 || !note?.moment) return <>{s}</>
  return (
    <>
      {s.slice(0, at)}
      <span className="tm">{momentLabel(note.moment)}</span> {s.slice(at)}
    </>
  )
}
