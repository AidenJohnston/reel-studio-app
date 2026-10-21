import { useEffect, useRef, useState } from 'react'
import { clock } from '../../../shared/progress'
import { momentNote, typedMoment, wordsAt } from '../../../shared/moments'
import type { MomentWord } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { NOTE_DROP_DONE, useNotify } from '../App'
import { Icon } from './icons'
import { AttachmentChips, useNoteAttachments } from './NoteAttachments'

type Scope = 'here' | 'whole'
type Lookup = { duration: number; words: MomentWord[] } | null

// Things the AI editor does well from one line (ai/src/tools.ts: set_cut, set_zoom,
// set_music_automation, set_caption_style). Subtitle size is a whole-reel setting, so it says so.
const QUICK: { label: string; text: string; scope: Scope }[] = [
  { label: 'Cut this part', text: 'Cut this part', scope: 'here' },
  { label: 'Zoom in here', text: 'Zoom in here', scope: 'here' },
  { label: 'Quieter music here', text: 'Make the music quieter here', scope: 'here' },
  { label: 'Bigger subtitles', text: 'Make the subtitles bigger', scope: 'whole' }
]

// Matches the .change-pop exit transition, after which the closed pop-up leaves the page.
const EXIT_MS = 140

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  if (!el) return false
  if (el.tagName === 'INPUT') return !['range', 'checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type)
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

/**
 * The one way to ask for a change: a button under the player that names the playhead time, and a
 * small pop-up next to it. With no AI editor it is the one "connect" prompt on the Reel screen.
 */
export function ChangeAt({
  slug,
  at,
  shown,
  aiOn,
  busy,
  onConnect,
  onOpenChange,
  onSent
}: {
  slug: string
  /** the playhead, in seconds */
  at: number
  /** the version on screen (0 = the Preview), and whether it is the newest */
  shown: { n: number; latest: boolean } | null
  aiOn: boolean
  /** a change is being made: wait for it */
  busy: boolean
  onConnect: () => void
  onOpenChange: (open: boolean) => void
  onSent: (jobId: string | null) => void
}) {
  const notify = useNotify()
  const att = useNoteAttachments(slug, notify)
  // 'open' | 'closing' while on the page; `instant` when the N key opened it (no motion on a shortcut)
  const [phase, setPhase] = useState<'closed' | 'open' | 'closing'>('closed')
  const [instant, setInstant] = useState(false)
  const [moment, setMoment] = useState(0)
  // the words on screen at `moment` in version `n`, read from that render when the pop-up opened
  // (undefined while asking main)
  const [found, setFound] = useState<{ n: number; at: number; lookup: Lookup } | undefined>(undefined)
  const [alert, setAlert] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [scope, setScope] = useState<Scope>('here')
  const [sending, setSending] = useState(false)
  const [dropOver, setDropOver] = useState(false)
  const dropDepth = useRef(0)
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const exitTimer = useRef<number>(0)
  const request = useRef(0)
  const mounted = phase !== 'closed'
  const isOpen = phase === 'open'
  // nothing to anchor "here" to in this render: the change can only be for the whole reel
  const noWords = !!found && found.n === shown?.n && (!found.lookup || !found.lookup.words.length)

  // Read fresh every time: a note can replace the Preview's render without changing its number.
  const lookup = async (seconds: number): Promise<Lookup> => {
    const tl = shown ? await reel.projects.timeline(slug, shown.n) : null
    return tl && { duration: tl.duration, words: wordsAt(tl.words, seconds) }
  }

  // Motion only for the pointer: opened or closed from the keyboard (N, Enter, Escape, Tab) it is instant.
  const open = (byKey: boolean) => {
    if (busy || !aiOn || !shown) return
    window.clearTimeout(exitTimer.current)
    setInstant(byKey)
    const n = shown.n
    if (phase === 'closed') {
      if (found?.n !== n || moment !== at) setScope('here') // a new moment: Just here again
      setMoment(at)
      setFound(undefined)
      const mine = ++request.current
      lookup(at)
        .then((r) => {
          if (request.current !== mine) return // opened again since
          setFound({ n, at, lookup: r })
          if (!r || !r.words.length) setScope('whole')
        })
        .catch((e) => notify(userMessage(e), 'error'))
    }
    setAlert(null)
    setPhase('open')
    onOpenChange(true)
  }
  const close = (byKey: boolean, refocus = true) => {
    if (phase !== 'open') return
    setInstant(byKey)
    setPhase('closing')
    onOpenChange(false)
    window.clearTimeout(exitTimer.current)
    exitTimer.current = window.setTimeout(() => setPhase('closed'), byKey ? 0 : EXIT_MS)
    if (refocus) trigger.current?.focus()
  }

  useEffect(() => () => window.clearTimeout(exitTimer.current), [])
  useEffect(() => {
    if (isOpen) field.current?.focus()
  }, [isOpen])

  // N opens it when nothing is being typed and no dialog or drawer is over the screen.
  useEffect(() => {
    if (!aiOn) return
    const key = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'n' || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
      if (typing(e.target) || document.querySelector('.modal-backdrop, .drawer')) return
      e.preventDefault()
      open(true)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  // Escape puts it away wherever focus is (a dialog over the screen handles its own Escape).
  useEffect(() => {
    if (!isOpen) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal-backdrop')) return
      e.stopPropagation()
      close(true)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  })

  // A click or focus anywhere else puts it away (the words typed stay for next time). Closing an error
  // toast about an attached file is not "anywhere else".
  const elsewhere = (el: Element) => !wrap.current?.contains(el) && !el.closest('.toast')
  useEffect(() => {
    if (!isOpen) return
    const down = (e: PointerEvent) => {
      if (e.target instanceof Element && elsewhere(e.target)) close(false, false)
    }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  })

  if (!aiOn)
    return (
      <button className="btn change-btn" onClick={onConnect} data-testid="change-connect">
        <Icon name="sparkles" size={18} /> Connect an editor to make changes
      </button>
    )

  const quickText = QUICK.some((q) => q.text === text.trim())
  const pick = (q: (typeof QUICK)[number]) => {
    const cur = text.trim()
    setText(!cur || quickText ? q.text : `${cur.replace(/[.!]?$/, '.')} ${q.text}`)
    setScope(noWords ? 'whole' : q.scope)
    field.current?.focus()
  }
  const canSend = (!!text.trim() || att.chips.length > 0) && !att.busy && !sending
  // "At 1:00: zoom in" typed with Just here: that time, not the playhead's
  const typed = scope === 'here' ? typedMoment(text) : null
  const when = typed?.at ?? moment
  const send = async (byKey: boolean) => {
    if (!canSend) return
    const asked = (typed ? typed.rest : text.trim()) || 'Put this here'
    const files = att.chips
    setSending(true)
    try {
      let note = asked
      if (scope === 'here') {
        const r = found && found.n === shown?.n && found.at === when ? found.lookup : await lookup(when)
        if (r && when > r.duration) {
          setAlert(`There's no ${clock(when)} in this video. It's ${clock(r.duration)} long.`)
          return
        }
        if (!r || !r.words.length) {
          setAlert(`I can't tell which words play at ${clock(when)}. Pick a moment where you're talking, or choose Whole reel.`)
          return
        }
        note = momentNote(when, r.words, asked)
      }
      const r = await reel.projects.note(slug, note, files.length ? files.map((f) => f.asset) : undefined)
      setText('')
      att.clear()
      close(byKey)
      onSent(r.jobId)
    } catch (e) {
      notify(userMessage(e), 'error')
    } finally {
      setSending(false)
    }
  }

  // A picture or clip dropped here goes with the note; the window's own drop (a new reel) must not see it.
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files')
  const dropProps = {
    'data-note-drop': true,
    onDragEnter: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dropDepth.current++
      setDropOver(true)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: () => {
      dropDepth.current = Math.max(0, dropDepth.current - 1)
      if (!dropDepth.current) setDropOver(false)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dropDepth.current = 0
      setDropOver(false)
      window.dispatchEvent(new Event(NOTE_DROP_DONE))
      att.onDropFiles(e.dataTransfer)
    }
  }

  const time = clock(mounted ? when : at)
  const heard = scope === 'here' && !typed && found?.n === shown?.n && found?.at === moment ? found.lookup?.words : undefined
  const title = scope === 'here' ? `What should change at ${time}?` : 'What should change in your reel?'
  return (
    <div className="change-at" ref={wrap}>
      <button
        ref={trigger}
        className={`btn change-btn${isOpen ? ' on' : ''}`}
        // detail 0: pressed with Enter or Space, not clicked
        onClick={(e) => (isOpen ? close(e.detail === 0) : open(e.detail === 0))}
        disabled={busy || !shown}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-keyshortcuts="N"
        title={busy ? 'Wait for this change to finish' : 'Or press N'}
        data-testid="change-at"
      >
        <Icon name="pencil" size={16} />
        <span>
          Change something at <span className="change-time">{time}</span>
        </span>
      </button>
      {mounted && (
        <div
          className={`change-pop${isOpen ? '' : ' closing'}${instant ? ' instant' : ''}${dropOver ? ' over' : ''}`}
          role="dialog"
          aria-label={title}
          onBlur={(e) => {
            // tabbing out closes it; a native file picker taking focus (no next element) does not
            if (e.relatedTarget && elsewhere(e.relatedTarget)) close(true, false)
          }}
          {...dropProps}
          data-testid="change-pop"
        >
          {dropOver && <div className="note-drop-hint">Drop to put it in your note</div>}
          <h3 className="change-title">{title}</h3>
          {(heard?.length || noWords || (shown && !shown.latest)) && (
            <div className="change-context" data-testid="change-context">
              {!!heard?.length && <p className="change-heard">Around "{heard.map((x) => x.w).join(' ')}"</p>}
              {noWords && !typed && <p>I can't tell which words play at {clock(moment)} in this video, so this change is for the whole reel.</p>}
              {shown && !shown.latest && (
                <p>
                  You're watching {shown.n === 0 ? 'the Preview' : `Version ${shown.n}`}. I'll make the change in your newest version
                  {scope === 'here' ? ', at these same words.' : '.'}
                </p>
              )}
            </div>
          )}
          <AttachmentChips chips={att.chips} busy={att.busy} onRemove={(a) => void att.remove(a)} />
          <textarea
            ref={field}
            className="input change-input"
            rows={2}
            placeholder="For example: make this part faster"
            aria-label={title}
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setAlert(null)
            }}
            onPaste={att.onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(true)
              }
            }}
            data-testid="change-input"
          />
          <div className="change-quick" aria-label="Quick changes" role="group">
            {QUICK.map((q) => (
              <button key={q.label} className="pill" aria-pressed={text.trim() === q.text} onClick={() => pick(q)} data-testid="change-quick">
                {q.label}
              </button>
            ))}
            <button className="pill" onClick={att.choose} title="Attach a picture or a clip of your own" data-testid="note-attach">
              <Icon name="paperclip" size={14} stroke={2} /> Attach a file
            </button>
          </div>
          {alert && (
            <p className="change-alert" role="alert" data-testid="change-alert">
              {alert}
            </p>
          )}
          <div className="change-foot">
            <div className="scope" role="radiogroup" aria-label="Where">
              {(
                [
                  ['here', 'Just here'],
                  ['whole', 'Whole reel']
                ] as const
              ).map(([v, label]) => (
                <label key={v} className="scope-opt">
                  <input
                    type="radio"
                    name={`change-scope-${slug}`}
                    checked={scope === v}
                    disabled={v === 'here' && noWords}
                    onChange={() => {
                      setScope(v)
                      setAlert(null)
                    }}
                    data-testid={`scope-${v}`}
                  />
                  {label}
                </label>
              ))}
            </div>
            <span className="spacer" />
            <button className="btn primary small" onClick={(e) => void send(e.detail === 0)} disabled={!canSend} data-testid="change-send">
              Make this change
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
