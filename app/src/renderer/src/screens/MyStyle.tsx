import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { StyleLesson, StyleRule } from '../../../shared/api'
import { classifyKind, KIND_NAME, newestFirst, shortLine, sourceDetail, sourceLine, type MemoryKind } from '../../../shared/memory'
import { reel, userMessage } from '../api'
import { IS_MAC } from '../components/ui'
import { Icon, type IconName } from '../components/icons'
import { byKeyboard, reducedMotion } from '../components/motion'
import { TitleBarSlot } from '../components/titlebar'
import { LearnSheet } from './LearnSheet'
import { MemorySuggestions } from './MemorySuggestions'
import { styleEmptyLine } from './style-words'
import '../components/library.css'

const KIND_ICON: Record<MemoryKind, IconName> = { captions: 'type', pacing: 'timer', music: 'music', cuts: 'scissors', look: 'aperture' }

const EXAMPLES: { icon: IconName; line: string; from: string }[] = [
  { icon: 'type', line: 'Big subtitles', from: 'from a note on one of your reels' },
  { icon: 'timer', line: 'Cut to a new shot every 3 seconds or so', from: 'from your past edits' },
  { icon: 'music', line: 'Put music under the talking', from: 'added by you' }
]

const UNDO_MS = 8000
const EASE = 'cubic-bezier(.2, .8, .2, 1)'

/** What the open line says under the full sentence: who uses the rule, or that nobody does while it is paused. */
function usedBy(r: StyleRule): string {
  if (r.paused) return 'Paused. Not used on new reels until you resume it.'
  if (r.check) return 'The app checks this on every reel it makes, and your editor fixes a reel that breaks it.'
  return r.payload ? 'The app sets this on every new reel.' : 'Your editor reads this on every new reel.'
}

const exact = (iso: string | undefined): string | null => {
  const t = Date.parse(iso ?? '')
  return Number.isNaN(t) ? null : new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** The open line's "which note, and when": the note or files, then the exact time it was saved and last edited. */
function learnedWhen(r: StyleRule): string | null {
  const saved = exact(r.createdAt)
  const edited = exact(r.updatedAt)
  const parts = [sourceDetail(r), saved && `${r.byYou ? 'Added' : 'Saved'} ${saved}`, edited && `edited ${edited}`]
  return parts.filter(Boolean).join(' · ') || null
}

/** My style: every saved rule as one short line, newest first. */
export function MyStyle() {
  const [rules, setRules] = useState<StyleRule[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [forgot, setForgot] = useState<{ rule: StyleRule; at: number } | null>(null)
  const [refocus, setRefocus] = useState<string | null>(null)
  const [lesson, setLesson] = useState<(StyleLesson & { keep: boolean[] }) | null>(null)
  const [sheet, setSheet] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [damaged, setDamaged] = useState(false)
  // suggestions waiting above the list: the empty page's "Nothing learned yet" would contradict them
  const [suggested, setSuggested] = useState(0)
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  const forgetButtons = useRef(new Map<string, HTMLButtonElement>())
  const addButton = useRef<HTMLButtonElement>(null)
  // Undo's countdown: `due` while it runs, `left` while the pointer or keyboard focus holds it
  const expiry = useRef<{ timer?: number; due: number; left: number; hover: boolean; focus: boolean } | null>(null)
  const undoButton = useRef<HTMLButtonElement>(null)
  const forgotRow = useRef<HTMLLIElement>(null)
  const fade = useRef<Animation | null>(null)
  // the rows below a lapsed Undo, and how far they move up when it goes
  const slide = useRef<{ rows: Element[]; by: number } | null>(null)
  const [said, setSaid] = useState('')
  const list = useRef<HTMLUListElement>(null)
  const load = () => Promise.all([reel.style.rules().then(setRules), reel.style.damaged().then(setDamaged)])
  useEffect(() => {
    void load()
    return () => window.clearTimeout(expiry.current?.timer)
  }, [])
  useLayoutEffect(() => {
    const s = slide.current
    if (forgot || !s) return
    slide.current = null
    for (const row of s.rows) row.animate([{ transform: `translateY(${s.by}px)` }, { transform: 'none' }], { duration: 200, easing: EASE })
  }, [forgot])

  // the forgotten row's Undo takes the focus its Forget button had, and Undo gives it back
  useEffect(() => {
    if (forgot) undoButton.current?.focus()
  }, [forgot])
  useEffect(() => {
    const el = refocus && forgetButtons.current.get(refocus)
    if (!el) return
    el.focus()
    setRefocus(null)
  }, [refocus, rules])

  const run = async (change: () => Promise<unknown>): Promise<boolean> => {
    setError(null)
    try {
      await change()
      await load()
      return true
    } catch (e) {
      setError(userMessage(e))
      return false
    }
  }
  const stopEditing = (id: string) => {
    setEditing(null)
    requestAnimationFrame(() => editButtons.current.get(id)?.focus())
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!editing) return
    const { id, text } = editing
    if (await run(() => reel.style.update(id, { text }))) stopEditing(id)
  }
  const addRule = async (e: FormEvent) => {
    e.preventDefault()
    if (!adding?.trim()) return
    if (await run(() => reel.style.add(adding))) setAdding(null)
  }
  const settle = () => {
    window.clearTimeout(expiry.current?.timer)
    expiry.current = null
    fade.current?.cancel()
    fade.current = null
  }
  // The Undo row leaves in one step. If it had the focus, the next row's first control gets it, else the row
  // before, else Add a rule, so the keyboard is not sent back to the top of the window. The rows below move up
  // by its height, which they cover with a transform (not in keyboard mode, and not under reduced motion).
  const gone = (el: HTMLLIElement | null) => {
    fade.current = null
    const near = el && (el.nextElementSibling ?? el.previousElementSibling)
    const target = el?.contains(document.activeElement) ? (near?.querySelector<HTMLElement>('button, input') ?? addButton.current) : null
    const rows: Element[] = []
    for (let n = el?.nextElementSibling; n; n = n.nextElementSibling) rows.push(n)
    slide.current = el && rows.length && !byKeyboard() && !reducedMotion() ? { rows, by: el.offsetHeight } : null
    setForgot(null)
    setSaid('')
    if (target) requestAnimationFrame(() => target.focus())
  }
  // When Undo runs out, its row fades and goes; in keyboard mode it goes at once (keyboard actions never animate)
  const lapse = () => {
    expiry.current = null
    const el = forgotRow.current
    if (!el || byKeyboard()) return gone(el)
    fade.current = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: EASE, fill: 'forwards' })
    fade.current.finished.then(() => gone(el), () => undefined)
  }
  const countdown = (ms: number) => {
    const x = expiry.current
    if (!x) return
    x.due = Date.now() + ms
    x.timer = window.setTimeout(lapse, ms)
  }
  // Undo waits while the pointer rests on its row or keyboard focus is in it, and the time left runs on after
  // (WCAG 2.2.1). Focus put there by the app after a click does not hold it, or Undo would stay until the next click.
  const hold = (part: 'hover' | 'focus', on: boolean) => {
    const x = expiry.current
    if (!x) return
    x[part] = on
    if (x.hover || x.focus) {
      if (x.timer === undefined) return
      window.clearTimeout(x.timer)
      x.timer = undefined
      x.left = Math.max(0, x.due - Date.now())
    } else if (x.timer === undefined) countdown(x.left)
  }
  const forget = async (r: StyleRule, at: number) => {
    if (!(await run(() => reel.style.remove(r.id)))) return
    settle()
    if (open === r.id) setOpen(null)
    setForgot({ rule: r, at })
    setSaid(`Forgot “${shortLine(r.text)}”.`)
    expiry.current = { due: 0, left: UNDO_MS, hover: false, focus: false }
    countdown(UNDO_MS)
  }
  const undo = async () => {
    if (!forgot) return
    settle()
    const id = forgot.rule.id
    if (await run(() => reel.style.restore(id))) {
      setForgot(null)
      setSaid('')
      setRefocus(id)
    }
  }
  const learned = (l: StyleLesson) => {
    setError(null)
    setLesson({ ...l, keep: l.rules.map(() => true) })
    setSheet(false)
  }
  const closeAdding = () => {
    setAdding(null)
    addButton.current?.focus()
  }
  const keep = async () => {
    if (!lesson) return
    const chosen = lesson.rules.filter((_, i) => lesson.keep[i])
    if (await run(() => reel.style.keepLearned(chosen, lesson.files.map((f) => f.name).join(', ')))) setLesson(null)
  }

  const kept = lesson?.keep.filter(Boolean).length ?? 0
  const now = Date.now()
  const shown: (StyleRule | 'forgot')[] = newestFirst(rules ?? [])
  if (forgot) shown.splice(Math.min(forgot.at, shown.length), 0, 'forgot')

  return (
    <div className="page style-page">
      <TitleBarSlot
        title="My style"
        actions={
          <>
            <button className="btn" onClick={() => setSheet(true)} data-testid="style-learn">
              Learn from my past edits
            </button>
            <button
              ref={addButton}
              className={lesson ? 'btn' : 'btn primary'}
              onClick={() => setAdding((a) => a ?? '')}
              data-testid="style-add"
            >
              <Icon name="plus" />
              Add a rule
            </button>
          </>
        }
      />
      {shown.length > 0 && (
        <p className="style-intro">Your editor follows these on every new reel, newest first. A note that starts with “always” can add one.</p>
      )}
      {/* Forget's message, read out by screen readers; always mounted so a change to its text is announced */}
      <p className="sr-only" role="status" data-testid="style-said">
        {said}
      </p>
      {/* the status region is there before the line is, so a screen reader announces the line when it arrives */}
      <div role="status" className="style-status">
        {damaged && (
          <p className="banner" data-testid="style-damaged">
            Your saved style file was damaged, so a new one was started. The old one is kept next to it.
          </p>
        )}
      </div>
      {error && (
        <p className="style-note" role="alert">
          {error}
        </p>
      )}

      <MemorySuggestions onKept={() => void load()} onCount={setSuggested} />

      {lesson && (
        <section className="lesson" aria-labelledby="lesson-h" data-testid="style-lesson">
          <div className="lesson-h">
            <b id="lesson-h">
              {lesson.rules.length ? 'What your past edits show' : 'Nothing stood out in these edits'}
            </b>
            <span>
              {lesson.files.map((f) => `${f.name} (${f.editor})`).join(', ') || 'No export could be read'}
              {lesson.timelines ? ` · ${lesson.timelines} timeline${lesson.timelines === 1 ? '' : 's'}, ${lesson.shots} shots` : ''}. Nothing is
              saved until you keep it.
            </span>
          </div>
          {lesson.rules.length > 0 && (
            <ul className="lesson-rules">
              {lesson.rules.map((r, i) => (
                <li key={r.text}>
                  <label className="lesson-rule" data-testid="style-lesson-rule">
                    <input
                      type="checkbox"
                      checked={lesson.keep[i]}
                      onChange={(e) => setLesson({ ...lesson, keep: lesson.keep.map((k, j) => (j === i ? e.target.checked : k)) })}
                    />
                    <span className="style-t">
                      <b>{r.text}</b>
                      <span>{r.evidence}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {lesson.skipped.map((s) => (
            <p key={s.name} className="lesson-skip">
              {s.name}: {s.reason}
            </p>
          ))}
          <div className="lesson-foot">
            {lesson.rules.length > 0 && (
              <button className="btn primary" onClick={() => void keep()} disabled={!kept} data-testid="style-lesson-keep">
                {kept === 1 ? 'Keep 1 rule' : `Keep ${kept} rules`}
              </button>
            )}
            <button className="btn ghost" onClick={() => setLesson(null)}>
              {lesson.rules.length ? 'Cancel' : 'Close'}
            </button>
          </div>
        </section>
      )}

      {adding !== null && (
        <form className="style-form" onSubmit={addRule} onKeyDown={(e) => e.key === 'Escape' && closeAdding()}>
          <input
            className="input"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            placeholder="Always use big subtitles"
            aria-label="New rule"
            autoFocus
            data-testid="style-add-input"
          />
          <button className="btn small" type="submit" disabled={!adding.trim()}>
            Save
          </button>
          <button className="btn small ghost" type="button" onClick={closeAdding}>
            Cancel
          </button>
        </form>
      )}

      {rules && !rules.length && !forgot && adding === null && !lesson && !suggested && (
        <div className="style-empty" data-testid="style-empty">
          <h2>Nothing learned yet</h2>
          <p>{styleEmptyLine(IS_MAC)}</p>
          {/* what the page fills with, so the person knows what a rule is before they make one */}
          <figure className="style-example">
            <figcaption>For example</figcaption>
            <ul>
              {EXAMPLES.map((x) => (
                <li key={x.line}>
                  <Icon name={x.icon} size={16} />
                  <span>
                    <b>{x.line}</b>
                    <span>{x.from}</span>
                  </span>
                </li>
              ))}
            </ul>
          </figure>
        </div>
      )}

      {shown.length > 0 && (
        <ul ref={list} className="mem-rows">
          {shown.map((r, at) => {
            if (r === 'forgot') {
              return (
                <li
                  key="forgot"
                  ref={forgotRow}
                  className="mem forgot"
                  onPointerEnter={() => hold('hover', true)}
                  onPointerLeave={() => hold('hover', false)}
                  onFocus={() => hold('focus', byKeyboard())}
                  onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && hold('focus', false)}
                >
                  <span className="mem-said">Forgot “{shortLine(forgot!.rule.text)}”.</span>
                  <button ref={undoButton} className="btn small" onClick={() => void undo()} data-testid="style-undo">
                    <Icon name="undo" size={14} />
                    Undo
                  </button>
                </li>
              )
            }
            if (editing?.id === r.id) {
              return (
                <li key={r.id}>
                  <form className="style-form" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && stopEditing(r.id)}>
                    <input
                      className="input"
                      value={editing.text}
                      onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                      aria-label="Rule"
                      aria-describedby={r.payload || r.check ? `edit-hint-${r.id}` : undefined}
                      autoFocus
                      data-testid="style-edit-input"
                    />
                    <button className="btn small" type="submit" disabled={!editing.text.trim()}>
                      Save
                    </button>
                    <button className="btn small ghost" type="button" onClick={() => stopEditing(r.id)}>
                      Cancel
                    </button>
                  </form>
                  {(r.payload || r.check) && (
                    <p id={`edit-hint-${r.id}`} className="muted-sm style-edit-hint" data-testid="style-edit-hint">
                      {r.check
                        ? 'If you change these words, they become a sentence the AI reads, and the app no longer checks every reel for it.'
                        : 'If you change these words, they become a sentence the AI reads, and the app no longer makes new reels lowercase by itself.'}
                    </p>
                  )}
                </li>
              )
            }
            const kind = classifyKind(r.text)
            const line = shortLine(r.text)
            const isOpen = open === r.id
            const from = isOpen ? learnedWhen(r) : null
            // the forgotten row sits among these, so a rule's place is counted without it
            const place = forgot && at > forgot.at ? at - 1 : at
            return (
              <li key={r.id} className={`mem${r.paused ? ' paused' : ''}${isOpen ? ' open' : ''}`} data-testid="style-rule">
                <span className="mem-kind">{kind && <Icon name={KIND_ICON[kind]} size={16} />}</span>
                <button
                  className="mem-line"
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? `mem-more-${r.id}` : undefined}
                  onClick={() => setOpen(isOpen ? null : r.id)}
                >
                  {kind && <span className="sr-only">{KIND_NAME[kind]}: </span>}
                  {line}
                </button>
                <span className="mem-state">{r.paused ? 'Paused' : r.check ? 'Checked' : null}</span>
                <span className="mem-acts">
                  <button
                    className="btn small ghost"
                    onClick={() => void run(() => reel.style.update(r.id, { paused: !r.paused }))}
                    aria-label={`${r.paused ? 'Resume' : 'Pause'} "${line}"`}
                  >
                    {r.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    className="btn small ghost"
                    ref={(el) => {
                      if (el) forgetButtons.current.set(r.id, el)
                      else forgetButtons.current.delete(r.id)
                    }}
                    onClick={() => void forget(r, place)}
                    aria-label={`Forget "${line}"`}
                  >
                    Forget
                  </button>
                </span>
                <span className="mem-src">{sourceLine(r, now)}</span>
                {isOpen && (
                  <div className="mem-more" id={`mem-more-${r.id}`}>
                    <p className="mem-full">“{r.text}”</p>
                    {from && <p className="mem-from">{from}</p>}
                    <p className="mem-use">
                      {usedBy(r)}
                      <button
                        className="btn small ghost"
                        ref={(el) => {
                          if (el) editButtons.current.set(r.id, el)
                          else editButtons.current.delete(r.id)
                        }}
                        onClick={() => setEditing({ id: r.id, text: r.text })}
                        aria-label={`Edit "${line}"`}
                      >
                        <Icon name="pencil" size={14} />
                        Edit
                      </button>
                    </p>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {sheet && <LearnSheet onClose={() => setSheet(false)} onLearned={learned} />}
    </div>
  )
}
