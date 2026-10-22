import { useLayoutEffect, useRef, useState } from 'react'
import type { ProjectJson } from '../../../shared/api'
import { canJoin, retype, setBreak, shownAs, type LineToken } from '../../../shared/subtitle-lines'

type Captions = NonNullable<ProjectJson['captions']>
type Correction = NonNullable<Captions['corrections']>[number]

const lineText = (line: LineToken[]): string => line.map((t) => t.shown).join(' ')

/** Where each word of a line starts in its text. */
function starts(line: LineToken[]): number[] {
  const out: number[] = []
  let at = 0
  for (const t of line) {
    out.push(at)
    at += t.shown.length + 1
  }
  return out
}

/** The word the caret is in (or just after). */
function wordAt(line: LineToken[], caret: number): number {
  const s = starts(line)
  let k = 0
  while (k + 1 < s.length && s[k + 1] <= caret) k++
  return k
}

/** Where Enter breaks the line: the word boundary nearest the caret. */
function breakAt(line: LineToken[], caret: number): number {
  const k = wordAt(line, caret)
  const s = starts(line)
  return caret - s[k] <= s[k] + line[k].shown.length - caret ? k : k + 1
}

/**
 * The subtitle lines, one editable row each. Clicking a word shows that moment on the phone; typing fixes the
 * words of that line only; Enter starts a new line at the caret; Backspace at the start of a line, or Join,
 * puts it onto the line above.
 */
export function SubtitleLines({
  lines,
  saved,
  corrections,
  onEdit,
  onShow
}: {
  lines: LineToken[][]
  /** The corrections as saved (the render drew these), and with the edits not yet made into a version. */
  saved: Correction[]
  corrections: Correction[]
  /** One edit to the project's captions, as a function of their current state. */
  onEdit: (edit: (c: Captions) => Captions) => void
  /** The line (as typed so far) and the word the caret is on. */
  onShow: (text: string, word: LineToken) => void
}) {
  const [draft, setDraft] = useState<{ line: number; text: string } | null>(null)
  const inputs = useRef<(HTMLInputElement | null)[]>([])
  // After a split or a join, the caret goes to the start of this word, wherever its line now is.
  const caretTo = useRef<string | null>(null)

  useLayoutEffect(() => {
    const id = caretTo.current
    if (!id) return
    caretTo.current = null
    const i = lines.findIndex((l) => l.some((t) => t.ids[0] === id))
    const el = inputs.current[i]
    if (!el) return
    const at = starts(lines[i])[lines[i].findIndex((t) => t.ids[0] === id)]
    el.focus()
    el.setSelectionRange(at, at)
  })

  /** The corrections with line i's typing in them. */
  const typed = (i: number): Correction[] => (draft?.line === i ? retype(lines[i], corrections, saved, draft.text) : corrections)
  const fixed = (next: Correction[]) => (c: Captions): Captions => ({ ...c, corrections: next })
  const keepTyping = (next: Correction[]) => {
    setDraft(null)
    if (JSON.stringify(next) !== JSON.stringify(corrections)) onEdit(fixed(next))
  }
  const join = (i: number, next: Correction[]) => {
    setDraft(null)
    caretTo.current = lines[i][0].ids[0]
    onEdit((c) => setBreak(fixed(next)(c), lines[i][0].ids[0], false))
  }

  return (
    <div className="sub-lines" data-testid="sub-lines">
      {lines.map((line, i) => {
        const joinable = i > 0 && canJoin(lines[i - 1], line)
        return (
          <div key={line[0].ids[0]} className="sub-line">
            <input
              ref={(el) => {
                inputs.current[i] = el
              }}
              className="sub-line-text"
              aria-label={`Subtitle line ${i + 1}`}
              spellCheck
              value={draft?.line === i ? draft.text : lineText(line)}
              onChange={(e) => {
                setDraft({ line: i, text: e.target.value })
                onShow(e.target.value, line[0])
              }}
              onSelect={(e) => onShow(e.currentTarget.value, line[wordAt(line, e.currentTarget.selectionStart ?? 0)])}
              onBlur={() => keepTyping(typed(i))}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return
                const el = e.currentTarget
                if (e.key === 'Escape' && draft?.line === i) {
                  e.stopPropagation()
                  setDraft(null)
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  const next = typed(i)
                  const after = line.map((t) => ({ ...t, shown: shownAs(t, saved, next) })).filter((t) => t.shown)
                  const k = breakAt(after, el.selectionStart ?? 0)
                  if (k <= 0 || k >= after.length) return keepTyping(next)
                  setDraft(null)
                  caretTo.current = after[k].ids[0]
                  onEdit((c) => setBreak(fixed(next)(c), after[k].ids[0], true))
                } else if (e.key === 'Backspace' && joinable && el.selectionStart === 0 && el.selectionEnd === 0) {
                  e.preventDefault()
                  join(i, typed(i))
                }
              }}
            />
            {joinable && (
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
