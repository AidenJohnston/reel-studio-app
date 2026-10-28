import { useEffect, useRef, useState } from 'react'
import type { StyleRule } from '../../../shared/api'
import { reel, userMessage } from '../api'
import { useNotify } from '../App'

/** Where a rule applies and where it came from, in plain words. */
function about(r: StyleRule): string {
  const where = r.payload ? 'On new videos.' : 'On every video.'
  return r.source ? `${where} From "${r.source.title}", version ${r.source.version}.` : where
}

export function MyStyle() {
  const notify = useNotify()
  const [rules, setRules] = useState<StyleRule[] | null>(null)
  const [damaged, setDamaged] = useState(false)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const editButtons = useRef(new Map<string, HTMLButtonElement>())
  const editInput = useRef<HTMLInputElement>(null)
  const load = () => Promise.all([reel.style.rules().then(setRules), reel.style.damaged().then(setDamaged)])
  useEffect(() => {
    void load()
  }, [])
  const run = async (change: () => Promise<unknown>): Promise<boolean> => {
    try {
      await change()
      await load()
      return true
    } catch (e) {
      notify(userMessage(e), 'error')
      // The rule may be gone (removed in another window): show the list as it is now.
      void load()
      return false
    }
  }
  const stopEditing = (id: string) => {
    setEditing(null)
    requestAnimationFrame(() => editButtons.current.get(id)?.focus())
  }
  const save = async () => {
    if (!editing) return
    const { id, text } = editing
    if (await run(() => reel.style.update(id, { text }))) stopEditing(id)
  }
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>My style</h1>
          <p className="muted">Things you told me to always do. I follow these when I edit your videos.</p>
        </div>
      </div>
      {damaged && (
        <div className="banner" role="status" style={{ marginBottom: 16 }} data-testid="style-damaged">
          Your saved style file was damaged, so I started a new one. The old one is kept next to it.
        </div>
      )}
      {rules && rules.length === 0 && (
        <div className="panel">
          <p>Nothing here yet.</p>
          <p className="muted" style={{ marginTop: 6 }}>
            When you write a note like "always use big subtitles", I'll remember it here.
          </p>
        </div>
      )}
      <div className="list">
        {rules?.map((r) =>
          editing?.id === r.id ? (
            <form
              key={r.id}
              className="list-item"
              style={{ flexWrap: 'wrap' }}
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') stopEditing(r.id)
              }}
            >
              <input
                className="input"
                style={{ flex: 1 }}
                value={editing.text}
                onChange={(e) => setEditing({ id: r.id, text: e.target.value })}
                aria-label="Rule"
                aria-describedby={r.payload ? `edit-hint-${r.id}` : undefined}
                ref={editInput}
                autoFocus
                data-testid="style-edit-input"
              />
              <button className="btn small primary" type="submit" disabled={!editing.text.trim()}>
                Save
              </button>
              <button className="btn small ghost" type="button" onClick={() => stopEditing(r.id)}>
                Cancel
              </button>
              {r.payload && (
                <p id={`edit-hint-${r.id}`} className="muted-sm" style={{ flexBasis: '100%' }} data-testid="style-edit-hint">
                  If you change these words, they become a sentence the AI reads, and the app no longer makes new videos
                  lowercase by itself.
                </p>
              )}
            </form>
          ) : (
            <div key={r.id} className="list-item" data-testid="style-rule">
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 16, color: r.paused ? 'var(--ink-3)' : undefined }}>{r.text}</span>
                {r.paused && (
                  <span className="badge" style={{ marginLeft: 8 }}>
                    Paused
                  </span>
                )}
                <p className="muted-sm" style={{ marginTop: 2 }}>
                  {about(r)}
                </p>
              </div>
              <button
                className="btn small ghost"
                ref={(el) => {
                  if (el) editButtons.current.set(r.id, el)
                  else editButtons.current.delete(r.id)
                }}
                onClick={() => {
                  // Another row has typed words that are not saved: keep it open rather than throw them away.
                  const open = editing && rules.find((x) => x.id === editing.id)
                  if (open && open.text !== editing.text) editInput.current?.focus()
                  else setEditing({ id: r.id, text: r.text })
                }}
                aria-label={`Edit "${r.text}"`}
              >
                Edit
              </button>
              <button
                className="btn small ghost"
                onClick={() => void run(() => reel.style.update(r.id, { paused: !r.paused }))}
                aria-label={`${r.paused ? 'Turn back on' : 'Pause'} "${r.text}"`}
              >
                {r.paused ? 'Turn back on' : 'Pause'}
              </button>
              <button
                className="btn small ghost danger"
                onClick={() => void run(() => reel.style.remove(r.id))}
                aria-label={`Remove "${r.text}"`}
              >
                Remove
              </button>
            </div>
          )
        )}
      </div>
    </div>
  )
}
