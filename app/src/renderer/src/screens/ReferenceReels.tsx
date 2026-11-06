// My style › Reference reels: other creators' reels the person wants theirs to feel like, and what the app measured
// across them (shared/references.ts readout). Files are copied into the library; a link is downloaded only when it
// goes straight to a video file, otherwise it is kept and the row says how to add its file.
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { Readout, ReferenceView } from '../../../shared/references'
import { READOUT_LIMITS, VIDEO_EXTENSIONS } from '../../../shared/references'
import { PACE_LABELS } from '../../../shared/cut-style'
import { reel, userMessage } from '../api'
import { Confirm, FOLDER_APP, MoreMenu, PickFiles, Spinner, useFileDrop } from '../components/ui'
import { Icon } from '../components/icons'
import './style-sections.css'

const ACCEPT = VIDEO_EXTENSIONS.map((x) => `.${x}`).join(',')

/** One decimal, as the readout shows them. */
const one = (x: number): number => Math.round(x * 10) / 10

/** The row's one line of numbers, or what is missing. */
function measuredLine(r: ReferenceView): string {
  const m = r.measure!
  const shot = m.shots.count <= 1 ? 'one shot, no cuts' : `new shot every ${one(m.shots.medianSeconds)} s`
  if (!m.speech) {
    const why = m.speechMissing === 'no-model' ? 'not listened to: the listening model isn’t downloaded yet' : m.speechMissing === 'no-audio' ? 'no sound' : 'no talking heard'
    return `${why} · ${shot}`
  }
  const hook = m.speech.hook ? ` · first sentence ${one(m.speech.hook.seconds)} s` : ''
  return `${one(m.speech.wordsPerSecond)} words a second · ${shot}${hook}`
}

function Stat({ value, unit, label, testid }: { value: number; unit?: string; label: string; testid: string }) {
  return (
    <div className="rr-stat" data-testid={testid}>
      <b>
        {value}
        {unit && <span className="rr-unit">{unit}</span>}
      </b>
      <span>{label}</span>
    </div>
  )
}

function ReadoutView({ r }: { r: Readout }) {
  const titleId = useId()
  return (
    <section className="rr-readout" aria-labelledby={titleId} data-testid="references-readout">
      <h3 id={titleId}>{r.measured === 1 ? 'What this reel does' : `What these ${r.measured} reels have in common`}</h3>
      <div className="rr-stats">
        {r.pace && <Stat value={r.pace.median} label="words a second" testid="readout-pace" />}
        {r.shot && <Stat value={r.shot.median} unit=" s" label={r.pacePreset ? `per shot · ${PACE_LABELS[r.pacePreset]} pace` : 'one shot'} testid="readout-shot" />}
        {r.hook && <Stat value={r.hook.median} unit=" s" label="first sentence" testid="readout-hook" />}
      </div>
      <ul className="rr-lines">
        {r.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <p className="rr-limits">{READOUT_LIMITS} A note like “make it feel like my references” uses these numbers.</p>
    </section>
  )
}

export function ReferenceReels() {
  const titleId = useId()
  const [list, setList] = useState<{ references: ReferenceView[]; readout: Readout } | null>(null)
  const [link, setLink] = useState('')
  const [linking, setLinking] = useState(false)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState<{ name: string; reason: string }[]>([])
  const [removing, setRemoving] = useState<ReferenceView | null>(null)
  const [said, setSaid] = useState('')
  const states = useRef(new Map<string, ReferenceView['state']>())
  // loads overlap (a reel measured while an add finishes); only the newest one may set the list
  const loads = useRef(0)

  const load = useCallback(async () => {
    const mine = ++loads.current
    try {
      const next = await reel.references.list()
      if (mine !== loads.current) return
      // say out loud when a reel finishes measuring, so a screen reader hears what changed
      const done = next.references.filter((r) => states.current.get(r.id) === 'measuring' && r.state !== 'measuring')
      if (done.length) setSaid(done.map((r) => (r.state === 'measured' ? `Measured ${r.title}.` : `Could not measure ${r.title}.`)).join(' '))
      states.current = new Map(next.references.map((r): [string, ReferenceView['state']] => [r.id, r.state]))
      setList(next)
    } catch (e) {
      setError(userMessage(e))
    }
  }, [])
  useEffect(() => {
    void load()
    return reel.references.onChange(() => void load())
  }, [load])

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
  const addFiles = async (paths: string[]) => {
    setAdding(true)
    setSkipped([])
    await run(async () => setSkipped((await reel.references.add(paths)).skipped))
    setAdding(false)
  }
  const addLink = async (e: FormEvent) => {
    e.preventDefault()
    if (!link.trim() || linking) return
    setLinking(true)
    if (await run(() => reel.references.addLink(link.trim()))) setLink('')
    setLinking(false)
  }
  const drop = useFileDrop((paths) => void addFiles(paths))
  const refs = list?.references ?? []

  return (
    <section className={`ss${drop.over ? ' over' : ''}`} aria-labelledby={titleId} {...drop.props} data-testid="references">
      <header className="ss-h">
        <div className="ss-t">
          <h2 id={titleId}>Reference reels</h2>
          <p>Reels by other creators you want yours to feel like. Your editor can read what they have in common.</p>
        </div>
        <PickFiles
          label={adding ? 'Adding…' : 'Add videos…'}
          size="small"
          accept={ACCEPT}
          icon={adding ? <Spinner /> : <Icon name="plus" size={14} />}
          onFiles={(p) => void addFiles(p)}
          disabled={adding}
          testid="references-add"
        />
      </header>

      <form className="rr-link" onSubmit={addLink}>
        <input
          className="input"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Or paste a link to a reel"
          aria-label="Link to a reel"
          inputMode="url"
          spellCheck={false}
          disabled={linking}
          data-testid="references-link"
        />
        <button className="btn small" type="submit" disabled={!link.trim() || linking} data-testid="references-link-add">
          {linking && <Spinner />}
          {linking ? 'Adding…' : 'Add link'}
        </button>
      </form>

      <p className="sr-only" role="status">
        {said}
      </p>
      {error && (
        <p className="ss-error" role="alert" data-testid="references-error">
          {error}
        </p>
      )}
      {skipped.map((s) => (
        <p key={s.name} className="ss-note" data-testid="references-skipped">
          {s.name}: {s.reason}
        </p>
      ))}

      {list && list.readout.measured > 0 && <ReadoutView r={list.readout} />}

      {list && !refs.length && (
        <p className="ss-empty" data-testid="references-empty">
          None yet. Drop videos here, add them, or paste a link.
        </p>
      )}
      {refs.length > 0 && (
        <ul className="rr-rows" aria-label="Reference reels">
          {refs.map((r) => (
            <li key={r.id} className={`rr-row ${r.state}`} data-testid="reference">
              <span className="rr-poster" aria-hidden>
                {r.posterUrl ? <img src={r.posterUrl} alt="" width={36} height={64} loading="lazy" decoding="async" /> : <Icon name={r.link && !r.file ? 'external' : 'film'} size={16} />}
              </span>
              <span className="rr-t">
                <b title={r.title}>{r.title}</b>
                {r.state === 'measured' && <span data-testid="reference-numbers">{measuredLine(r)}</span>}
                {r.state === 'measuring' && (
                  <span className="rr-busy">
                    <Spinner /> Measuring…
                  </span>
                )}
                {r.state === 'problem' && <span className="rr-problem">{r.problem ?? 'This reel could not be measured.'}</span>}
                {r.state === 'needs-file' && (
                  <span className="rr-needs" data-testid="reference-needs-file">
                    {r.needsFile}
                  </span>
                )}
              </span>
              <span className="rr-acts">
                {r.state === 'needs-file' && (
                  <PickFiles
                    label="Add the file…"
                    size="small"
                    accept={ACCEPT}
                    onFiles={(p) => void run(() => reel.references.attach(r.id, p[0]))}
                    aria-label={`Add the file for ${r.title}`}
                    testid="reference-attach"
                  />
                )}
                <MoreMenu
                  label={`More for ${r.title}`}
                  items={[
                    ...(r.link ? [{ label: `Open on ${r.link.platform}`, run: () => void run(() => reel.references.openLink(r.id)) }] : []),
                    ...(r.file ? [{ label: `Show in ${FOLDER_APP}`, run: () => void run(() => reel.references.reveal(r.id)) }] : []),
                    { label: 'Remove', danger: true, run: () => setRemoving(r), testid: 'reference-remove' }
                  ]}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {removing && (
        <Confirm
          title="Remove this reference?"
          body={`“${removing.title}” leaves the list${removing.file ? ', and Reel Studio deletes its own copy. Your original file stays where it is' : ''}.`}
          yes="Remove"
          no="Keep it"
          danger
          onNo={() => setRemoving(null)}
          onYes={() => {
            const id = removing.id
            setRemoving(null)
            void run(() => reel.references.remove(id))
          }}
        />
      )}
    </section>
  )
}
