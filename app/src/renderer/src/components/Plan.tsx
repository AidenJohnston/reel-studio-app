// Planning a reel before it has a video (a New reel). The stage holds the drop zone and, once there is one, the Plan card
// (a hook to pick, the beats, the shots: a checklist to film from). The notes column is a chat with the editor that
// makes the plan; with no editor it asks to connect one first. The card saves through projects.setPlan; shared/plan.ts
// checks the shape in main, and the plan becomes the first edit's script when the video arrives (main store.ts
// carryScript).
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { PhoneShare, PlanLine, ProviderInfo, ReelPlan } from '../../../shared/api'
import { PLAN_MAX, pickedHook, planCounts, planText } from '../../../shared/plan'
import { droppedPaths, reel, userMessage } from '../api'
import { NOTE_DROP_DONE } from '../App'
import { BrandMark } from './brand'
import { Icon } from './icons'
import { byKeyboard, reducedMotion } from './motion'
import { deviceRatio, usePhoneShape } from './Phone'
import { planAnswerer, type AnswererMark } from './plan-who'
import { Qr } from './SendToPhone'
import { Button, PickFiles, Spinner, useFileDrop } from './ui'
import './plan.css'

type Kind = 'beats' | 'shots'

/**
 * The plan to film from. While the reel waits for its video every line edits in place (Enter keeps it, Escape puts it
 * back, emptying a line takes it out), the picked hook leads, and beats and shots tick off. Once the video is in, it
 * folds to one line above it and opens read-only. Copy and Send to my phone work in both.
 */
export function PlanCard({
  slug,
  title,
  plan,
  folded,
  busy,
  onSaved,
  onCopy,
  onError
}: {
  slug: string
  title: string
  plan: ReelPlan
  /** the reel has its video: one line that opens */
  folded: boolean
  /** the editor is answering: nothing changes under it */
  busy: boolean
  onSaved: () => void
  onCopy: (text: string) => void
  onError: (message: string) => void
}) {
  const [cur, setCur] = useState(plan)
  const [open, setOpen] = useState(false)
  const [phone, setPhone] = useState(false)
  const phoneBtn = useRef<HTMLButtonElement>(null)
  useEffect(() => setCur(plan), [plan])
  const readOnly = folded || busy

  const save = (next: ReelPlan): void => {
    setCur(next)
    reel.projects.setPlan(slug, next).then(onSaved, (e) => {
      setCur(plan)
      onError(userMessage(e))
    })
  }
  /** An emptied line goes, unless it is the last hook or the last beat: then it stays as it was. */
  const setHook = (i: number, text: string): boolean => {
    if (!text && cur.hooks.length < 2) return false
    const hooks = text ? cur.hooks.map((h, k) => (k === i ? text : h)) : cur.hooks.filter((_, k) => k !== i)
    const hook = text || i > cur.hook ? cur.hook : i === cur.hook ? 0 : cur.hook - 1
    save({ ...cur, hooks, hook })
    return true
  }
  const setLine = (kind: Kind, i: number, text: string): boolean => {
    const list = cur[kind]
    if (!text && kind === 'beats' && list.length < 2) return false
    save({ ...cur, [kind]: text ? list.map((l, k) => (k === i ? { ...l, text } : l)) : list.filter((_, k) => k !== i) })
    return true
  }
  const tick = (kind: Kind, i: number): void => save({ ...cur, [kind]: cur[kind].map((l, k): PlanLine => (k === i ? { text: l.text, ...(l.done ? {} : { done: true }) } : l)) })

  const actions = (
    <span className="pl-acts">
      <button className="lk" onClick={() => onCopy(planText(cur, title))} data-testid="plan-copy">
        <Icon name="copy" size={14} /> Copy
      </button>
      <button ref={phoneBtn} className="lk" aria-expanded={phone} onClick={() => setPhone((p) => !p)} data-testid="plan-phone">
        <Icon name="phone" size={14} /> Send to my phone
      </button>
    </span>
  )

  const body = (
    <>
      {phone && (
        <PlanPhone
          slug={slug}
          onDone={() => {
            setPhone(false)
            phoneBtn.current?.focus()
          }}
        />
      )}
      <section className="pl-sec" aria-label="Hook">
        <h4>{cur.hooks.length > 1 ? 'Pick a hook' : 'Hook'}</h4>
        <div role="radiogroup" aria-label="Hook" className="pl-hooks">
          {cur.hooks.map((h, i) => (
            <div key={i} className={`pl-row pl-hook${i === cur.hook ? ' on' : ''}`}>
              {cur.hooks.length > 1 && (
                <label className="pl-pick">
                  <input
                    type="radio"
                    name={`hook-${slug}`}
                    checked={i === cur.hook}
                    disabled={readOnly}
                    onChange={() => save({ ...cur, hook: i })}
                    aria-label={`Use hook ${i + 1}`}
                    data-testid={`plan-hook-${i}`}
                  />
                  <span aria-hidden />
                </label>
              )}
              <PlanField value={h} label={`Hook ${i + 1}`} readOnly={readOnly} onCommit={(t) => setHook(i, t)} />
            </div>
          ))}
        </div>
      </section>
      <Lines kind="beats" title="Beats" lines={cur.beats} readOnly={readOnly} numbered onTick={tick} onCommit={setLine} />
      {cur.shots.length > 0 && <Lines kind="shots" title="Shots" lines={cur.shots} readOnly={readOnly} onTick={tick} onCommit={setLine} />}
    </>
  )

  if (folded)
    return (
      <div className="plan folded" data-testid="plan-card" data-folded>
        <div className="pl-head">
          <button className="pl-fold" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="plan-unfold">
            <Icon name="chevron-down" size={14} className={open ? 'open' : undefined} />
            <b>Plan</b>
            <span className="pl-fold-hook">{pickedHook(cur)}</span>
          </button>
          {!open && <span className="pl-n">{planCounts(cur)}</span>}
        </div>
        <div className={`acc${open ? ' open' : ''}`} inert={!open || undefined}>
          <div>
            <div className="pl-body">
              {actions}
              {body}
            </div>
          </div>
        </div>
      </div>
    )
  return (
    <div className="plan" data-testid="plan-card" aria-busy={busy || undefined}>
      <div className="pl-head">
        {/* the plan chip in the chat brings focus here */}
        <h3 tabIndex={-1} data-plan-head>
          Plan
        </h3>
        {actions}
      </div>
      <div className="pl-body">{body}</div>
    </div>
  )
}

function Lines({
  kind,
  title,
  lines,
  readOnly,
  numbered,
  onTick,
  onCommit
}: {
  kind: Kind
  title: string
  lines: PlanLine[]
  readOnly: boolean
  numbered?: boolean
  onTick: (kind: Kind, i: number) => void
  onCommit: (kind: Kind, i: number, text: string) => boolean
}) {
  const one = kind === 'beats' ? 'Beat' : 'Shot'
  const done = lines.filter((l) => l.done).length
  return (
    <section className="pl-sec" aria-label={title}>
      <h4>
        {title}
        {done > 0 ? (
          <span className="pl-done-n">
            {done} of {lines.length} done
          </span>
        ) : (
          // the boxes are ticks, not list markers: say so until the first one is ticked
          !readOnly && <span className="pl-done-n">Tick as you film</span>
        )}
      </h4>
      <ol className="pl-lines">
        {lines.map((l, i) => (
          <li key={i} className={`pl-row${l.done ? ' done' : ''}`}>
            <label className="pl-tick">
              <input type="checkbox" checked={!!l.done} disabled={readOnly} onChange={() => onTick(kind, i)} aria-label={`${one} ${i + 1} done`} data-testid={`plan-${kind}-tick-${i}`} />
              <span aria-hidden>{l.done ? <Icon name="check" size={11} stroke={2.6} /> : numbered ? i + 1 : null}</span>
            </label>
            <PlanField value={l.text} label={`${one} ${i + 1}`} readOnly={readOnly} onCommit={(t) => onCommit(kind, i, t)} />
          </li>
        ))}
      </ol>
    </section>
  )
}

/** One line of the plan, edited where it stands. `onCommit` false: the line could not go, so it is put back. */
function PlanField({ value, label, readOnly, onCommit }: { value: string; label: string; readOnly: boolean; onCommit: (text: string) => boolean }) {
  const [v, setV] = useState(value)
  const cancelled = useRef(false)
  useEffect(() => setV(value), [value])
  const keys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelled.current = true
      e.currentTarget.blur()
    }
  }
  return (
    <textarea
      className="pl-field selectable"
      rows={1}
      value={v}
      maxLength={PLAN_MAX.line}
      readOnly={readOnly}
      aria-label={label}
      spellCheck
      onChange={(e) => setV(e.target.value.replace(/\n/g, ' '))}
      onKeyDown={keys}
      onBlur={() => {
        const t = v.replace(/\s+/g, ' ').trim()
        if (cancelled.current || t === value) {
          cancelled.current = false
          return setV(value)
        }
        if (!onCommit(t)) setV(value)
      }}
    />
  )
}

/** Send to my phone for the plan: the same temporary home-Wi-Fi link as a video's (main/phone-share.ts), open while
 * this shows. The phone gets the plan with boxes to tick while filming. */
function PlanPhone({ slug, onDone }: { slug: string; onDone: () => void }) {
  const [share, setShare] = useState<PhoneShare | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [stopped, setStopped] = useState(false)
  useEffect(() => {
    let live = true
    reel.phone
      .startPlan(slug)
      .then((s) => live && setShare(s))
      .catch((e) => live && setError(userMessage(e)))
    return () => {
      live = false
      void reel.phone.stop()
    }
  }, [slug])
  useEffect(
    () =>
      reel.phone.onEvent((e) => {
        if (e.kind === 'page') setSent(true)
        else if (e.kind === 'stopped' && e.reason === 'timeout') setStopped(true)
      }),
    []
  )
  return (
    <div className="pl-phone" role="group" aria-label="Send the plan to your phone" data-testid="plan-phone-panel">
      {error ? (
        <p className="pl-phone-err" role="alert">
          {error} Copy works too: paste the plan into a note on your phone.
        </p>
      ) : (
        <>
          <div className="pl-qr">{share && !stopped ? <Qr url={share.url} /> : stopped ? null : <Spinner />}</div>
          <div className="pl-phone-t">
            <p>Point your phone's camera at this code. The plan opens there, ready to tick off while you film.</p>
            <p className="muted-sm">Your phone needs to be on the same Wi-Fi as this computer.</p>
            <p className={`pl-phone-s${sent ? ' sent' : ''}`} role="status" data-testid="plan-phone-status">
              {sent ? (
                <>
                  <Icon name="check" size={14} /> Sent. Check your phone.
                </>
              ) : stopped ? (
                'This code stopped after 15 minutes, to keep it private.'
              ) : share ? (
                'Waiting for your phone…'
              ) : (
                'Getting the code ready…'
              )}
            </p>
          </div>
        </>
      )}
      <button className="lk pl-phone-done" onClick={onDone} data-testid="plan-phone-done">
        Done
      </button>
    </div>
  )
}

const VIDEO_TYPES = 'video/*,.mov,.mp4,.m4v'

/**
 * The plan column of a reel with no video yet takes a dropped video for this reel, as the stage does. Without it the
 * window took the drop and started another reel. The note box inside handles its own drops first (Reel.tsx .cwrap).
 */
export function columnVideoDrop(onFiles: (paths: string[]) => void) {
  const files = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  return {
    'data-video-drop': true,
    onDragOver: (e: DragEvent) => {
      if (!files(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDrop: (e: DragEvent) => {
      if (!files(e)) return
      e.preventDefault()
      e.stopPropagation()
      window.dispatchEvent(new Event(NOTE_DROP_DONE))
      const paths = droppedPaths(e)
      if (paths.length) onFiles(paths)
    }
  }
}

/**
 * The stage of a reel with no video yet. The drop zone is what it is for; once there is a plan, the Plan card stands
 * beside it (above it on a narrow stage), so the person films from what they see. The whole stage takes a dropped
 * video, and so does the window (App.tsx, `data-video-drop`).
 */
export function PlannedStage({ plan, onFiles }: { plan: ReactNode; onFiles: (paths: string[]) => void }) {
  const drop = useFileDrop((paths) => {
    window.dispatchEvent(new Event(NOTE_DROP_DONE))
    onFiles(paths)
  })
  // with no plan yet, the zone is the phone's own slot: its shape and height, where the video will play
  const [shape] = usePhoneShape()
  return (
    <div
      className={`planned${drop.over ? ' over' : ''}${plan ? ' with-plan' : ''}`}
      style={{ '--slot-ratio': deviceRatio(shape) } as React.CSSProperties}
      {...drop.props}
      data-video-drop
      data-testid="planned-stage"
    >
      <div className="pd">
        {plan && (
          <div className="pd-plan" data-plan-main>
            {plan}
            <span className="pd-ring" aria-hidden />
          </div>
        )}
        {/* remounts when the plan comes or goes, so the zone fades in at its new place instead of jumping there */}
        <div key={plan ? 'beside' : 'alone'} className="pd-drop" data-testid="drop-zone">
          <Icon name="video" size={24} />
          <div className="pd-words">
            <h2>Drop the video you filmed</h2>
            <p>A few takes are fine. Retakes and pauses come out.</p>
          </div>
          <PickFiles kind="primary" label="Choose video" accept={VIDEO_TYPES} onFiles={onFiles} />
        </div>
      </div>
    </div>
  )
}

/**
 * In the chat, under the editor's newest plan: the way to the card on the stage, and the plan's size. Pressing it
 * scrolls the card into view and moves focus to it; with a pointer, a ring around the card says which one.
 */
export function PlanChip({ plan }: { plan: ReelPlan }) {
  const show = () => {
    const at = document.querySelector<HTMLElement>('[data-plan-main]')
    if (!at) return
    // from the keyboard the card is just there, focused: nothing moves
    const still = byKeyboard()
    at.scrollIntoView({ block: 'nearest', behavior: still || reducedMotion() ? 'auto' : 'smooth' })
    at.querySelector<HTMLElement>('[data-plan-head]')?.focus({ preventScroll: true })
    // the ring holds long enough to be seen, then fades in 200 ms
    if (!still) at.querySelector('.pd-ring')?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.64 }, { opacity: 0 }], { duration: 560, easing: 'ease-out' })
  }
  return (
    <button className="pl-chip" onClick={show} data-testid="plan-chip">
      <b>Show the plan</b>{' '}
      <span className="pl-chip-n">{planCounts(plan)}</span>
    </button>
  )
}

/**
 * An empty plan chat: what planning does, in the middle of the chat area, the way a chat app greets you. Connected, the
 * note box waits at the bottom. With no editor there is nothing to type into yet: the greeting's one button opens
 * Choose your editor (screens/Connect.tsx), which comes back here with the note box focused.
 */
export function PlanEmpty({ provider, hasPlan, onConnect }: { provider: ProviderInfo | null; hasPlan: boolean; onConnect?: () => void }) {
  // with no editor, the two it can be; connected, the one that answers, by name (PlanWho)
  const marks: AnswererMark[] = onConnect ? ['claude', 'openai'] : []
  const line = onConnect
    ? hasPlan
      ? 'Connect your editor to change the plan in a chat.'
      : 'Your editor plans it with you: a question or two, then hooks to pick from, the beats and the shots.'
    : 'Plan it first: say what it’s about, and your editor asks a question or two, then gives you hooks to pick from, the beats and the shots.'
  return (
    <div className="pl-empty" data-testid={onConnect ? 'plan-connect-step' : 'plan-greeting'}>
      {marks.length > 0 && (
        <span className="pl-empty-marks" aria-hidden>
          {marks.map((m) => (m === 'server' ? <Icon key={m} name="server" size={20} /> : <BrandMark key={m} name={m} size={20} />))}
        </span>
      )}
      {!onConnect && <PlanWho provider={provider} />}
      {/* beside "Drop the video you filmed", the other way in: planning reads as the choice for a video not filmed yet */}
      <h3>{hasPlan ? 'Change the plan together' : onConnect ? 'Plan it before you film' : 'Not filmed yet?'}</h3>
      <p {...(!hasPlan && { 'data-testid': 'plan-empty' })}>{line}</p>
      {onConnect && (
        <Button onClick={onConnect} data-testid="plan-connect">
          Connect your editor
        </Button>
      )}
    </div>
  )
}

/**
 * Who answers in the plan chat, in the column's title row: the editor and, where the app knows it, the model it plans
 * with (plan-who.ts). The whole line is in the tooltip when it is cut short.
 */
export function PlanWho({ provider }: { provider: ProviderInfo | null }) {
  const [writer, setWriter] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    reel.app
      .info()
      .then((i) => live && setWriter(i.models.writer))
      .catch(() => live && setWriter('auto'))
    return () => {
      live = false
    }
  }, [provider])
  const who = writer === null ? null : planAnswerer(provider, writer)
  if (!who) return null
  return (
    <span className="pl-who" title={who.full} data-testid="plan-who">
      <span className="sr-only">Answering: {who.full}</span>
      <span className="pl-who-mark" aria-hidden>
        {who.mark === 'server' ? <Icon name="server" size={14} /> : who.mark ? <BrandMark name={who.mark} size={14} /> : null}
      </span>
      <span className="pl-who-t" aria-hidden>
        {who.name}
        {who.model && <span className="pl-who-m"> · {who.model}</span>}
      </span>
    </span>
  )
}

const AFTER_CONNECT = 'rs.plan-after-connect'

/** Connect your editor was pressed on this reel: once it comes back connected, the chat is ready to type in. */
export const markPlanConnect = (slug: string): void => sessionStorage.setItem(AFTER_CONNECT, slug)

/**
 * Back from Choose your editor with an editor connected, the plan chat starts without another click: focus goes to its
 * note box. `checked`: the editor check has answered; `ready`: the chat is showing.
 */
export function usePlanAfterConnect(slug: string, checked: boolean, ready: boolean, input: RefObject<HTMLTextAreaElement | null>): void {
  useEffect(() => {
    if (!checked || sessionStorage.getItem(AFTER_CONNECT) !== slug) return
    sessionStorage.removeItem(AFTER_CONNECT)
    if (ready) input.current?.focus()
  }, [slug, checked, ready, input])
}
