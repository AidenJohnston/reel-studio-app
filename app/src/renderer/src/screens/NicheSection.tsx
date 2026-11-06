// My style › Your niche: who the reels are for, what viewers get, the kinds of reel the person makes and words to
// keep out. The editor reads it on every new reel (ai niche.ts). Found in a short chat (NicheSheet), or written here.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { splitWords, type Niche, type SavedNiche } from '../../../shared/niche'
import { reel, userMessage } from '../api'
import { NicheSheet } from './NicheSheet'
import { NicheList } from './NicheList'
import './style-sections.css'

interface Form {
  who: string
  promise: string
  angles: string
  avoid: string
}
const toForm = (n: Niche | null): Form => ({ who: n?.who ?? '', promise: n?.promise ?? '', angles: n?.angles.join('\n') ?? '', avoid: n?.avoid.join(', ') ?? '' })
const fromForm = (f: Form): Niche => ({ who: f.who, promise: f.promise, angles: f.angles.split('\n').map((a) => a.trim()).filter(Boolean), avoid: splitWords(f.avoid) })

export function NicheSection() {
  const titleId = useId()
  const formId = useId()
  const [state, setState] = useState<{ niche: SavedNiche | null; damaged: boolean } | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [sheet, setSheet] = useState<'new' | 'change' | null>(null)
  const [removed, setRemoved] = useState<SavedNiche | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [said, setSaid] = useState('')
  const editButton = useRef<HTMLButtonElement>(null)
  const writeButton = useRef<HTMLButtonElement>(null)
  const undoButton = useRef<HTMLButtonElement>(null)

  const load = () => reel.niche.get().then(setState, (e) => setError(userMessage(e)))
  useEffect(() => void load(), [])
  useEffect(() => {
    if (removed) undoButton.current?.focus()
  }, [removed])

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
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!form) return
    if (await run(() => reel.niche.save(fromForm(form), 'typed'))) {
      setForm(null)
      setSaid('Saved your niche.')
      requestAnimationFrame(() => editButton.current?.focus())
    }
  }
  const remove = async () => {
    const was = state?.niche
    if (!was || !(await run(() => reel.niche.remove()))) return
    setRemoved(was)
    setSaid('Removed your niche.')
  }
  const undo = async () => {
    if (!removed) return
    if (await run(() => reel.niche.save(removed, removed.from))) {
      setRemoved(null)
      setSaid('Your niche is back.')
      requestAnimationFrame(() => editButton.current?.focus())
    }
  }
  // Cancel and Escape give the keyboard back to the button that opened the form
  const closeForm = () => {
    setForm(null)
    requestAnimationFrame(() => (editButton.current ?? writeButton.current)?.focus())
  }
  const startForm = (n: Niche | null) => {
    setRemoved(null)
    setForm(toForm(n))
  }
  const niche = state?.niche ?? null
  const field = (k: keyof Form) => ({ value: form?.[k] ?? '', onChange: (e: { target: { value: string } }) => setForm((f) => (f ? { ...f, [k]: e.target.value } : f)) })

  return (
    <section className="ss" aria-labelledby={titleId} data-testid="niche-section">
      <header className="ss-h">
        <div className="ss-t">
          <h2 id={titleId}>Your niche</h2>
          <p>Who your reels are for. Your editor aims every new reel at them.</p>
        </div>
        {!form && (
          <div className="ss-acts">
            {niche ? (
              <>
                <button className="btn small" onClick={() => setSheet('change')} data-testid="niche-talk">
                  Talk it through
                </button>
                <button ref={editButton} className="btn small ghost" onClick={() => startForm(niche)} data-testid="niche-edit">
                  Edit
                </button>
                <button className="btn small ghost" onClick={() => void remove()} data-testid="niche-remove">
                  Remove
                </button>
              </>
            ) : (
              <>
                <button className="btn small" onClick={() => setSheet('new')} data-testid="niche-find">
                  Find my niche
                </button>
                <button ref={writeButton} className="btn small ghost" onClick={() => startForm(null)} data-testid="niche-write">
                  Write it myself
                </button>
              </>
            )}
          </div>
        )}
      </header>

      <p className="sr-only" role="status">
        {said}
      </p>
      {error && (
        <p className="ss-error" role="alert">
          {error}
        </p>
      )}
      {state?.damaged && !form && (
        <p className="banner" data-testid="niche-damaged">
          Your saved niche could not be read. Find it again or write it, and the new one replaces it.
        </p>
      )}

      {form ? (
        <form className="nf" onSubmit={save} onKeyDown={(e) => e.key === 'Escape' && closeForm()} aria-label="Your niche" data-testid="niche-form">
          <label htmlFor={`${formId}-who`}>Who your reels are for</label>
          <input id={`${formId}-who`} className="input" placeholder="Nurses who work night shifts" maxLength={160} autoFocus {...field('who')} />
          <label htmlFor={`${formId}-promise`}>What they get from watching</label>
          <input id={`${formId}-promise`} className="input" placeholder="Meals that survive a 3am break" maxLength={160} {...field('promise')} />
          <label htmlFor={`${formId}-angles`}>Kinds of reel you make, one per line (up to 5)</label>
          <textarea id={`${formId}-angles`} className="textarea" rows={4} placeholder={'A meal I made on shift\nThe snack mistake everyone makes'} {...field('angles')} />
          <label htmlFor={`${formId}-avoid`}>Words to keep out, with commas between</label>
          <input id={`${formId}-avoid`} className="input" placeholder="hack, game-changer" {...field('avoid')} />
          <div className="nf-acts">
            <button className="btn small" type="submit" disabled={!form.who.trim() || !form.promise.trim() || !form.angles.trim()} data-testid="niche-form-save">
              Save
            </button>
            <button className="btn small ghost" type="button" onClick={closeForm}>
              Cancel
            </button>
          </div>
        </form>
      ) : removed ? (
        <p className="ns-removed" data-testid="niche-removed">
          Removed your niche. Your editor no longer reads it.
          <button ref={undoButton} className="btn small" onClick={() => void undo()} data-testid="niche-undo">
            Undo
          </button>
        </p>
      ) : niche ? (
        <NicheList niche={niche} />
      ) : (
        state && (
          <p className="ss-empty" data-testid="niche-empty">
            Not set yet. Answer two or three questions and your editor drafts one: who it is for, what they get, the kinds of reel to make and words to keep out.
          </p>
        )
      )}

      {sheet && (
        <NicheSheet
          start={sheet === 'change' ? niche : null}
          onClose={() => setSheet(null)}
          onSaved={() => {
            setSheet(null)
            setRemoved(null)
            setSaid('Saved your niche.')
            // the sheet's Save is gone with it: the keyboard lands on Edit, which the saved niche brings
            void load().then(() => requestAnimationFrame(() => editButton.current?.focus()))
          }}
          onWriteYourself={() => {
            setSheet(null)
            startForm(niche)
          }}
        />
      )}
    </section>
  )
}
