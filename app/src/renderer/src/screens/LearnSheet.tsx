// "Learn from my past edits": the edits found on this computer, by app, ticked and read in one click.
// A Final Cut Pro library or a Premiere Pro project can't be read as it is; each app says once how to export one
// (a CapCut project is read as it is, and DaVinci Resolve's exports are FCPXML, listed with Final Cut Pro's),
// and the list looks again whenever the window comes back into focus, so a new export appears by itself.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { PastEdit, PastEditCounts, StyleLesson } from '../../../shared/api'
import { styleEditors } from '../../../shared/style-editors'
import { reel, userMessage } from '../api'
import { FOLDER_APP, IS_MAC, Modal, Spinner } from '../components/ui'
import { Icon } from '../components/icons'
import '../components/learn.css'

const APPS: PastEdit['app'][] = ['Final Cut Pro', 'Premiere Pro', 'CapCut']
/** Ticked when the list opens: the newest readable edits. More can be ticked; each takes a moment to read. */
const TICKED = 8
const KIND_WORD: Record<PastEdit['kind'], string> = {
  fcpxml: 'XML export',
  fcpxmld: 'XML export',
  'premiere-xml': 'XML export',
  fcpbundle: 'Library',
  prproj: 'Project',
  capcut: 'Project'
}
const EXPORT_HOW: Record<PastEdit['app'], string> = {
  'Final Cut Pro': 'In Final Cut Pro, select the project, then choose File › Export XML…',
  'Premiere Pro': 'In Premiere Pro, open the project, then choose File › Export › Final Cut Pro XML…',
  // never shown: every CapCut project found is readable
  CapCut: 'CapCut projects are read as they are.'
}
const RESOLVE_HOW = 'In DaVinci Resolve, choose File › Export › Timeline… and save it as FCPXML.'
const EDITORS = styleEditors(IS_MAC)
const COMPUTER = IS_MAC ? 'Mac' : 'PC'

function day(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

/** An id part from an app's name: aria-labelledby splits on spaces. */
const slug = (app: string): string => app.toLowerCase().replace(/\s+/g, '-')

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The editor's own icon from the system when it is installed, else a neutral one; its name sits beside it. */
function AppMark({ icon }: { icon?: string }) {
  if (icon) return <img className="learn-mark" src={icon} width={20} height={20} alt="" data-testid="learn-app-icon" />
  return (
    <span className="learn-mark neutral" data-testid="learn-app-neutral">
      <Icon name="film" size={16} />
    </span>
  )
}

export function LearnSheet({ onClose, onLearned }: { onClose: () => void; onLearned: (l: StyleLesson) => void }) {
  const titleId = useId()
  const [edits, setEdits] = useState<PastEdit[] | null>(null)
  // a limit stopped the look before it had looked everywhere (main past-edits.ts LIMITS)
  const [cut, setCut] = useState(false)
  const [counts, setCounts] = useState<PastEditCounts>({})
  const [icons, setIcons] = useState<Partial<Record<PastEdit['app'], string>>>({})
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [reading, setReading] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // every id the list has shown, so a refresh ticks only an edit that is new since the sheet opened
  const shown = useRef<Set<string> | null>(null)
  // edits a refresh added, which fade in; the first list arrives with the sheet's own entrance
  const [added, setAdded] = useState<Set<string>>(new Set())
  const busy = reading !== null
  const sheetRef = useRef<HTMLDivElement>(null)
  const goRef = useRef<HTMLButtonElement>(null)

  const look = useCallback(async () => {
    try {
      const { edits: found, cut: stopped } = await reel.style.find()
      const first = shown.current === null
      const before = shown.current ?? new Set<string>()
      const readable = found.filter((e) => e.readable)
      setTicked((t) => {
        const next = new Set([...t].filter((id) => found.some((e) => e.id === id)))
        const fresh = first ? readable.slice(0, TICKED) : readable.filter((e) => !before.has(e.id))
        for (const e of fresh) next.add(e.id)
        return next
      })
      if (!first) setAdded(new Set(found.filter((e) => !before.has(e.id)).map((e) => e.id)))
      shown.current = new Set([...before, ...found.map((e) => e.id)])
      setEdits(found)
      setCut(stopped)
      if (readable.length) {
        const c = await reel.style.count()
        setCounts(c)
        // an edit the engine can't read is never ticked
        setTicked((t) => new Set([...t].filter((id) => !(c[id] && 'problem' in c[id]))))
      }
    } catch (e) {
      setError(userMessage(e))
      setEdits((x) => x ?? [])
    }
  }, [])

  useEffect(() => {
    void look()
    // an icon that can't be read leaves the neutral one; nothing to tell the person
    reel.style.appIcons().then(setIcons, () => undefined)
  }, [look])
  // back from Final Cut Pro or Premiere Pro with a new export: look again
  useEffect(() => {
    if (busy) return
    const again = () => void look()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [busy, look])
  useEffect(() => reel.style.onLearnProgress((p) => setReading((r) => (r ? p : r))), [])

  const learn = async (ids?: string[]) => {
    setError(null)
    if (ids) setReading({ done: 0, total: ids.length })
    try {
      const lesson = await reel.style.learn(ids)
      if (lesson) onLearned(lesson)
    } catch (e) {
      setError(userMessage(e))
    } finally {
      setReading(null)
    }
  }

  const chosen = (edits ?? []).filter((e) => ticked.has(e.id)).map((e) => e.id)
  // once the list is there, Learn takes the focus, so Return learns from what is ticked; unless focus has moved on
  const listed = edits !== null && chosen.length > 0
  useEffect(() => {
    if (listed && document.activeElement === sheetRef.current) goRef.current?.focus()
  }, [listed])
  const groups = APPS.map((app) => ({ app, items: (edits ?? []).filter((e) => e.app === app) })).filter((g) => g.items.length)
  const none = edits !== null && !edits.length
  const toggle = (id: string, on: boolean) =>
    setTicked((t) => {
      const next = new Set(t)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const meta = (e: PastEdit): string => {
    const c = counts[e.id]
    const parts = [KIND_WORD[e.kind], day(e.modified), c && 'timelines' in c ? plural(c.timelines, 'timeline') : null, e.where]
    return parts.filter(Boolean).join(' · ')
  }

  return (
    <Modal wide onClose={busy ? undefined : onClose} testid="learn-sheet" labelledBy={titleId}>
      {/* the sheet takes focus while it looks, since every button is still disabled then */}
      <div className="learn" ref={sheetRef} tabIndex={-1} data-autofocus>
        <header className="learn-head">
          <h2 id={titleId}>Learn from my past edits</h2>
          {!none && (
            <p className="muted">
              Tick the edits that look the way you want your reels to look. Nothing is saved until you keep what Reel Studio learns.
            </p>
          )}
        </header>

        {error && (
          <p className="learn-error" role="alert">
            {error}
          </p>
        )}

        {edits === null && (
          <p className="learn-looking" role="status">
            <Spinner /> Looking on this {COMPUTER}…
          </p>
        )}

        {none && (
          <div className="learn-none" data-testid="learn-none">
            <p className="learn-none-h">
              {cut ? `No edits from ${EDITORS} among the newest files on this ${COMPUTER}.` : `No edits from ${EDITORS} on this ${COMPUTER} yet.`}
            </p>
            <ul className="learn-ways">
              <li>
                <b>Export one from your editor.</b>
                <span>
                  {IS_MAC && <>{EXPORT_HOW['Final Cut Pro']} </>}
                  {EXPORT_HOW['Premiere Pro']} {RESOLVE_HOW} Save it anywhere in your home folder and it appears here. CapCut
                  projects appear by themselves.
                </span>
              </li>
              <li>
                <b>Have an export on a drive or in a folder already?</b>
                <span>
                  <button className="btn small learn-inline" onClick={() => void learn()} disabled={busy} data-testid="learn-choose">
                    Choose files…
                  </button>
                </span>
              </li>
            </ul>
          </div>
        )}

        {groups.length > 0 && (
          <div className="learn-list" aria-busy={busy || undefined}>
            {groups.map(({ app, items }) => {
              const readable = items.filter((e) => e.readable)
              const waiting = items.filter((e) => !e.readable)
              return (
                <section key={app} className="learn-group" aria-labelledby={`${titleId}-${slug(app)}`} data-testid="learn-group">
                  <h3 id={`${titleId}-${slug(app)}`} className="learn-app">
                    <AppMark icon={icons[app]} />
                    {app}
                  </h3>
                  {readable.length > 0 && (
                    <ul className="learn-items">
                      {readable.map((e) => {
                        const c = counts[e.id]
                        const problem = c && 'problem' in c ? c.problem : null
                        return (
                          <li key={e.id} className={added.has(e.id) ? 'fresh' : undefined} data-testid="learn-item">
                            <label className={`learn-item${problem ? ' off' : ''}`}>
                              <input type="checkbox" checked={ticked.has(e.id)} disabled={busy || !!problem} onChange={(ev) => toggle(e.id, ev.target.checked)} />
                              <span className="learn-t">
                                <b title={e.file}>{e.name}</b>
                                <span title={meta(e)}>{meta(e)}</span>
                                {problem && <span className="learn-problem">{problem}</span>}
                              </span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  {waiting.length > 0 && (
                    // after the tickable rows and apart from them: these can't be ticked until they are exported
                    <div className="learn-waiting" role="group" aria-labelledby={`${titleId}-${slug(app)}-export`} data-testid="learn-needs-export">
                      <h4 id={`${titleId}-${slug(app)}-export`} className="learn-waiting-h">
                        Needs an export first
                      </h4>
                      <p className="learn-how">{EXPORT_HOW[app]}</p>
                      <ul className="learn-still">
                        {waiting.map((e) => (
                          <li key={e.id} className={`learn-item still${added.has(e.id) ? ' fresh' : ''}`} data-testid="learn-item-waiting">
                            <span className="learn-t">
                              <b title={e.file}>{e.name}</b>
                              <span title={meta(e)}>{meta(e)}</span>
                            </span>
                            <button className="btn small ghost" onClick={() => void reel.style.reveal(e.id).catch((x) => setError(userMessage(x)))} aria-label={`Show ${e.name} in ${FOLDER_APP}`}>
                              Show in {FOLDER_APP}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )}

        {cut && !none && (
          <p className="learn-cut" data-testid="learn-cut">
            This {COMPUTER} has too many files to look through them all, so older edits may be missing. Use Choose files… for those.
          </p>
        )}

        <footer className="learn-foot">
          {!none && (
            <button className="btn ghost learn-choose" onClick={() => void learn()} disabled={busy || edits === null} data-testid="learn-choose">
              Choose files…
            </button>
          )}
          <span className="learn-foot-acts">
            <button className={none ? 'btn' : 'btn ghost'} onClick={onClose} disabled={busy}>
              {none ? 'Close' : 'Cancel'}
            </button>
            {!none && (
              <button ref={goRef} className="btn primary" onClick={() => void learn(chosen)} disabled={busy || !chosen.length} data-testid="learn-go">
                {reading && <Spinner />}
                {reading
                  ? `Reading ${Math.min(reading.done + 1, reading.total)} of ${reading.total}…`
                  : chosen.length
                    ? `Learn from ${plural(chosen.length, 'edit')}`
                    : 'Tick an edit to learn from'}
              </button>
            )}
          </span>
        </footer>
      </div>
    </Modal>
  )
}
