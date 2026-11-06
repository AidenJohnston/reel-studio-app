import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { MemorySuggestion } from '../../../shared/api'
import { reel, userMessage } from '../api'
import './memory-suggestions.css'

/** Where a suggestion was read from, in a line: the post results or hand edits that back it. */
function evidence(s: MemorySuggestion): string {
  if (s.from.kind === 'note') return `From your note on “${s.from.title}”.`
  if (s.from.kind === 'results') return `From your post results: ${s.from.evidence}.`
  return s.from.evidence
}

/**
 * The learning loop's suggestions, at the top of My style: memories read from post results and from what the person
 * changed by hand in several reels. Nothing is a rule until they keep it; Edit keeps it in their own words, and
 * No thanks means it, and its words, are never suggested again. Opening My style looks again (main memory-loop.ts).
 */
export function MemorySuggestions({ onKept, onCount }: { onKept: () => void; onCount: (n: number) => void }) {
  const [list, setList] = useState<MemorySuggestion[]>([])
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const load = () =>
    reel.style.suggestions().then(
      (l) => (setList(l), onCount(l.length)),
      () => (setList([]), onCount(0))
    )
  useEffect(() => {
    void load()
  }, [])

  const act = async (change: () => Promise<unknown>, done: string) => {
    setError(null)
    try {
      await change()
      setEditing(null)
      setSaid(done)
      await load()
      onKept()
      // the row the focus was on is gone: the section heading takes it, so the keyboard stays here
      requestAnimationFrame(() => heading.current?.focus())
    } catch (e) {
      setError(userMessage(e))
    }
  }
  const keep = (s: MemorySuggestion, text?: string) => act(() => reel.style.keepSuggestion(s.id, text), `Kept “${text ?? s.line}” in My style.`)
  const saveEdit = (e: FormEvent, s: MemorySuggestion) => {
    e.preventDefault()
    if (editing?.text.trim()) void keep(s, editing.text.trim())
  }

  return (
    <>
      <p className="sr-only" role="status">
        {said}
      </p>
      {list.length > 0 && (
        <section className="lesson sugg" aria-labelledby="sugg-h" data-testid="style-suggestions">
          <div className="lesson-h">
            <h2 id="sugg-h" ref={heading} tabIndex={-1}>
              {list.length === 1 ? 'A habit worth keeping?' : 'Habits worth keeping?'}
            </h2>
            <span>Read from your reels. Nothing changes until you keep one.</span>
          </div>
          {error && (
            <p className="style-note" role="alert">
              {error}
            </p>
          )}
          <ul className="sugg-rows">
            {list.map((s) =>
              editing?.id === s.id ? (
                <li key={s.id}>
                  <form className="style-form" onSubmit={(e) => saveEdit(e, s)} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)}>
                    <input
                      className="input"
                      value={editing.text}
                      onChange={(e) => setEditing({ id: s.id, text: e.target.value })}
                      aria-label="Rule"
                      autoFocus
                      data-testid="suggestion-edit-input"
                    />
                    <button className="btn small primary" type="submit" disabled={!editing.text.trim()}>
                      Keep
                    </button>
                    <button className="btn small ghost" type="button" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </form>
                </li>
              ) : (
                <li key={s.id} className="sugg-row" data-testid="style-suggestion">
                  <span className="style-t">
                    <b>{s.text}</b>
                    <span>{evidence(s)}</span>
                  </span>
                  <span className="sugg-acts">
                    <button className="btn small primary" onClick={() => void keep(s)} aria-label={`Keep "${s.line}"`}>
                      Keep
                    </button>
                    <button className="btn small ghost" onClick={() => setEditing({ id: s.id, text: s.text })} aria-label={`Edit "${s.line}" before keeping it`}>
                      Edit
                    </button>
                    <button
                      className="btn small ghost"
                      onClick={() => void act(() => reel.style.dismissSuggestion(s.id), `I won’t suggest “${s.line}” again.`)}
                      aria-label={`No thanks to "${s.line}"`}
                    >
                      No thanks
                    </button>
                  </span>
                </li>
              )
            )}
          </ul>
        </section>
      )}
    </>
  )
}
