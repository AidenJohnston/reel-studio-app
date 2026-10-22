import { useEffect, useRef, useState } from 'react'
import type { QueuedNote } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { Icon } from './icons'

const waitingWords = (n: number): string => `${n} ${n === 1 ? 'note' : 'notes'} waiting`

/** Notes waiting their turn on this reel, under the running note. Held (after Stop, a failed note or a
 * restart) they wait for "Run next". `head`: the newest version, the one the next note runs on. */
export function NoteQueue({ slug, queue, held, head, onError }: { slug: string; queue: QueuedNote[]; held: boolean; head: number; onError: (msg: string) => void }) {
  const waiting = queue.filter((q) => !q.attempt)
  const act = (p: Promise<unknown>): void => void p.catch((e) => onError(userMessage(e)))
  return (
    <>
      {/* stays mounted, so screen readers hear the count change as notes come and go */}
      <p className="sr-only" role="status">
        {waiting.length ? waitingWords(waiting.length) : ''}
      </p>
      {waiting.length > 0 && (
        <div className={`note-queue${held ? ' held' : ''}`} data-testid="note-queue">
          {held && (
            <div className="row note-queue-head">
              <span className="note-queue-count" data-testid="queue-count">{waitingWords(waiting.length)}</span>
              <span className="spacer" />
              <button className="link" onClick={() => act(reel.queue.clear(slug))} data-testid="queue-clear">
                Clear
              </button>
              <button className="btn small primary" onClick={() => act(reel.queue.runNext(slug))} data-testid="queue-run-next">
                Run next
              </button>
            </div>
          )}
          <ol className="note-queue-list" aria-label="Notes waiting">
            {waiting.map((q, i) => (
              <Row key={q.id} q={q} first={i === 0} last={i === waiting.length - 1} head={head} slug={slug} act={act} />
            ))}
          </ol>
        </div>
      )}
    </>
  )
}

function Row({ q, first, last, head, slug, act }: { q: QueuedNote; first: boolean; last: boolean; head: number; slug: string; act: (p: Promise<unknown>) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  // after Enter or Escape the input goes away: put the keyboard back on Edit, never after a click elsewhere
  const editButton = useRef<HTMLButtonElement>(null)
  const refocus = useRef(false)
  const dropped = useRef(false)
  useEffect(() => {
    if (draft === null && refocus.current) {
      refocus.current = false
      editButton.current?.focus()
    }
  }, [draft])
  const save = (): void => {
    if (dropped.current) return
    const t = (draft ?? '').trim()
    setDraft(null)
    if (t && t !== q.text) act(reel.queue.edit(slug, q.id, t))
  }
  return (
    <li className="note-queue-row" data-testid="queue-row">
      <span className="note-queue-label">{first ? 'Next' : 'Then'}</span>
      <div className="note-queue-body">
        {draft === null ? (
          <span className="note-queue-text">{q.text}</span>
        ) : (
          <input
            className="input note-queue-input"
            autoFocus
            value={draft}
            aria-label="Change this note"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== 'Escape') return
              // else this key's keypress lands on Edit, focused by then, and opens it again
              e.preventDefault()
              refocus.current = true
              if (e.key === 'Enter') save()
              else {
                dropped.current = true
                setDraft(null)
              }
            }}
            data-testid="queue-edit-input"
          />
        )}
        {q.seenVersion !== head && head > 0 && (
          <span className="muted-sm" data-testid="queue-versions">Written on Version {q.seenVersion} · runs on Version {head}</span>
        )}
      </div>
      {draft === null && (
        <div className="note-queue-actions">
          <button
            ref={editButton}
            className="link inline"
            onClick={() => {
              dropped.current = false
              setDraft(q.text)
            }}
            data-testid="queue-edit"
          >
            Edit
          </button>
          <button className="link inline" onClick={() => act(reel.queue.cancel(slug, q.id))} data-testid="queue-cancel">Cancel</button>
          <button className="icon-btn small" disabled={first} aria-label="Run earlier" title="Run earlier" onClick={() => act(reel.queue.move(slug, q.id, -1))} data-testid="queue-up">
            <Icon name="up" size={16} />
          </button>
          <button className="icon-btn small" disabled={last} aria-label="Run later" title="Run later" onClick={() => act(reel.queue.move(slug, q.id, 1))} data-testid="queue-down">
            <Icon name="down" size={16} />
          </button>
        </div>
      )}
    </li>
  )
}
