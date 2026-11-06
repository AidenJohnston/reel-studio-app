// "Find my niche": a short chat with the editor in a sheet. The app asks what the reels are about, the editor asks at
// most two more questions, then drafts the niche; the person asks for changes or saves it. Nothing is saved before Save.
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { NICHE_OPENER, type Niche, type NicheTurn } from '../../../shared/niche'
import { errorCode, reel, userMessage } from '../api'
import { Modal, Spinner, Thinking } from '../components/ui'
import { reducedMotion } from '../components/motion'
import { NicheList } from './NicheList'
import './style-sections.css'

/** The editor's questions after the app's own (ai niche.ts NICHE_QUESTIONS): with a draft there are none left. */
const QUESTIONS = 2

export function NicheSheet({ start, onClose, onSaved, onWriteYourself }: { start: Niche | null; onClose: () => void; onSaved: () => void; onWriteYourself: () => void }) {
  const titleId = useId()
  const [turns, setTurns] = useState<NicheTurn[]>([])
  const [asked, setAsked] = useState(start ? QUESTIONS : 0)
  const [draft, setDraft] = useState<Niche | null>(start)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<{ text: string; noAI: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => reel.niche.onStatus((s) => setStatus(s.message)), [])
  // the newest line stays in view as the chat grows; no glide under reduced motion
  useLayoutEffect(() => end.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }), [turns, busy, draft])

  const send = async (e: FormEvent) => {
    e.preventDefault()
    const words = text.trim()
    if (!words || busy) return
    const next: NicheTurn[] = [...turns, { from: 'you', text: words }]
    setTurns(next)
    setText('')
    setError(null)
    setBusy(true)
    setStatus('')
    try {
      const r = await reel.niche.say(next, asked, draft)
      if (r.kind === 'question') {
        setTurns([...next, { from: 'editor', text: r.text, kind: 'question' }])
        setAsked((n) => n + 1)
      } else {
        const { kind: _k, say, ...niche } = r
        setTurns([...next, { from: 'editor', text: say, kind: 'niche' }])
        setDraft(niche)
        setAsked(QUESTIONS)
      }
    } catch (x) {
      // the words go back in the box to send again; Stop says nothing more
      setTurns(turns)
      setText(words)
      if (errorCode(x)?.toLowerCase() !== 'cancelled') setError({ text: userMessage(x), noAI: errorCode(x) === 'NO_AI' })
    } finally {
      setBusy(false)
      requestAnimationFrame(() => input.current?.focus())
    }
  }
  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      await reel.niche.save(draft, 'chat')
      onSaved()
    } catch (x) {
      setError({ text: userMessage(x), noAI: false })
      setSaving(false)
    }
  }
  const close = busy ? undefined : onClose

  return (
    <Modal wide onClose={close} testid="niche-sheet" labelledBy={titleId}>
      <header className="ns-head">
        <h2 id={titleId}>{start ? 'Change your niche' : 'Find your niche'}</h2>
        <p className="muted">{start ? 'Say what to change. Your editor drafts it again.' : 'Two or three questions, then a niche you can change before you save it.'}</p>
      </header>

      <div className="ns-chat" aria-live="polite" aria-busy={busy || undefined} data-testid="niche-chat">
        <p className="ns-ed">{start ? 'Here is your niche as it is saved. What would you change?' : NICHE_OPENER}</p>
        {turns.map((t, i) =>
          t.from === 'you' ? (
            <p key={i} className="ns-you selectable">
              {t.text}
            </p>
          ) : (
            <p key={i} className="ns-ed" data-testid="niche-editor-line">
              {t.text}
            </p>
          )
        )}
        {busy && (
          <p className="ns-wait" role="status">
            <Thinking />
            {status || 'Thinking about your niche'}
          </p>
        )}
        {draft && !busy && (
          <section className="ns-draft" aria-label="Your niche" data-testid="niche-draft">
            <NicheList niche={draft} />
          </section>
        )}
        <div ref={end} />
      </div>

      {error && (
        <p className="ss-error" role="alert" data-testid="niche-error">
          {error.text}{' '}
          {error.noAI && (
            <button className="btn small ghost" onClick={onWriteYourself} data-testid="niche-write-instead">
              Write it myself
            </button>
          )}
        </p>
      )}

      <form className="ns-compose" onSubmit={send}>
        <input
          ref={input}
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={draft ? 'Ask for a change' : 'Your answer'}
          aria-label={draft ? 'Ask for a change' : 'Your answer'}
          maxLength={600}
          disabled={busy}
          data-autofocus
          data-testid="niche-input"
        />
        {busy ? (
          <button className="btn small" type="button" onClick={() => void reel.niche.stop()} data-testid="niche-stop">
            Stop
          </button>
        ) : (
          <button className="btn small" type="submit" disabled={!text.trim()} data-testid="niche-send">
            Send
          </button>
        )}
      </form>

      <footer className="ns-foot">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {draft && (
          <button className="btn primary" onClick={() => void save()} disabled={busy || saving} data-testid="niche-save">
            {saving && <Spinner />}
            Save niche
          </button>
        )}
      </footer>
    </Modal>
  )
}
