import { useLayoutEffect, useRef, useState } from 'react'
import type { ProjectJson, Word } from '../../../shared/api'
import { retype, setBreak, wordText } from '../../../shared/subtitle-lines'

type Captions = NonNullable<ProjectJson['captions']>
type Correction = NonNullable<Captions['corrections']>[number]

/** The words a line shows (a word fixed to nothing is off the captions) and where each starts in its text. */
function shown(line: Word[], corrections: Correction[]): { words: Word[]; text: string; starts: number[] } {
  const words: Word[] = []
  const parts: string[] = []
  const starts: number[] = []
  let at = 0
  for (const w of line) {
    const t = wordText(w, corrections)
    if (!t) continue
    words.push(w)
    parts.push(t)
    starts.push(at)
    at += t.length + 1
  }
  return { words, text: parts.join(' '), starts }
}

/** The word the caret is in (or just after), by index into `starts`. */
function wordAt(starts: number[], caret: number): number {
  let k = 0
  while (k + 1 < starts.length && starts[k + 1] <= caret) k++
  return k
}

/** Where Enter breaks the line: the word boundary nearest the caret. */
function breakAt(text: string, starts: number[], caret: number): number {
  const k = wordAt(starts, caret)
  const end = k + 1 < starts.length ? starts[k + 1] - 1 : text.length
  return caret - starts[k] <= end - caret ? k : k + 1
}

/**
 * The subtitle lines, one editable row each. Clicking a word shows that moment on the phone; typing fixes the
 * words of that line only; Enter starts a new line at the caret; Backspace at the start of a line, or Join,
 * puts it onto the line above.
 */
export function SubtitleLines({
  lines,
  corrections,
  onEdit,
  onShow
}: {
  lines: Word[][]
  corrections: Correction[]
  /** One edit to the project's captions, as a function of their current state. */
  onEdit: (edit: (c: Captions) => Captions) => void
  /** The line (as typed so far) and the word the caret is on. */
  onShow: (text: string, word: Word) => void
}) {
  const [draft, setDraft] = useState<{ line: number; text: string } | null>(null)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  // After a split or a join, the caret goes to the start of this word, wherever its line now is.
  const caretTo = useRef<string | null>(null)

  useLayoutEffect(() => {
    const id = caretTo.current
    if (!id) return
    caretTo.current = null
    const i = lines.findIndex((l) => l.some((w) => w.id === id))
    const el = inputs.current[i]
    if (!el) return
    const s = shown(lines[i], corrections)
    const at = s.starts[s.words.findIndex((w) => w.id === id)] ?? 0
    el.focus()
    el.setSelectionRange(at, at)
  })

  /** The corrections with line i's typing in them. */
  const typed = (i: number): Correction[] => (draft?.line === i ? retype(lines[i], corrections, draft.text) : corrections)
  const fixed = (next: Correction[]) => (c: Captions): Captions => ({ ...c, corrections: next })
  const keepTyping = (next: Correction[]) => {
    setDraft(null)
    if (JSON.stringify(next) !== JSON.stringify(corrections)) onEdit(fixed(next))
  }
  const join = (i: number, next: Correction[]) => {
    setDraft(null)
    caretTo.current = lines[i][0].id
    onEdit((c) => setBreak(fixed(next)(c), lines[i][0].id, false))
  }

  const show = (i: number, el: HTMLInputElement) => {
    const s = shown(lines[i], corrections)
    const w = s.words[Math.min(wordAt(s.starts, el.selectionStart ?? 0), s.words.length - 1)] ?? lines[i][0]
    onShow(el.value, w)
  }

  return (
    <div className="sub-lines" data-testid="sub-lines">
      {lines.map((line, i) => {
        const s = shown(line, corrections)
        return (
          <div key={line[0].id} className="sub-line">
            <input
              ref={(el) => {
                inputs.current[i] = el
              }}
              className="sub-line-text"
              aria-label={`Subtitle line ${i + 1}`}
              spellCheck
              value={draft?.line === i ? draft.text : s.text}
              onChange={(e) => {
                setDraft({ line: i, text: e.target.value })
                onShow(e.target.value, s.words[0] ?? line[0])
              }}
              onSelect={(e) => show(i, e.currentTarget)}
              onBlur={() => keepTyping(typed(i))}
              onKeyDown={(e) => {
                const el = e.currentTarget
                if (e.key === 'Escape' && draft?.line === i) {
                  e.stopPropagation()
                  setDraft(null)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const next = typed(i)
                  const after = shown(line, next)
                  const k = breakAt(after.text, after.starts, el.selectionStart ?? 0)
                  if (k <= 0 || k >= after.words.length) return keepTyping(next)
                  setDraft(null)
                  caretTo.current = after.words[k].id
                  onEdit((c) => setBreak(fixed(next)(c), after.words[k].id, true))
                } else if (e.key === 'Backspace' && i > 0 && el.selectionStart === 0 && el.selectionEnd === 0) {
                  e.preventDefault()
                  join(i, typed(i))
                }
              }}
            />
            {i > 0 && (
              <button
                className="btn small ghost sub-join"
                title="Put this line onto the one above"
                aria-label={`Join line ${i + 1} to the line above`}
                onClick={() => join(i, typed(i))}
              >
                Join
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
