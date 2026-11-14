import { useEffect, useMemo, useState } from 'react'
import type { ProjectJson, StyleRule } from '../../../../shared/api'
import { drawnWords, previewText, subtitleLines } from '../../../../shared/subtitle-lines'
import { reel, userMessage } from '../../api'
import { useNotify } from '../../App'
import { SubtitleLines } from '../../components/SubtitleLines'
import { Button, Segmented } from '../../components/ui'
import { pressKeys, setP, takes, wordKeys, type TabProps } from './controls'
import { JoinControls } from './JoinControls'
import { PaceControls } from './PaceControls'

type Captions = NonNullable<ProjectJson['captions']>
export type CutMode = 'cut' | 'fix' | 'pace' | 'joins'

const MODES = [
  { key: 'cut', label: 'Cut words' },
  { key: 'fix', label: 'Fix words' },
  { key: 'pace', label: 'Pace' },
  { key: 'joins', label: 'Transitions' }
] as const
const CASES = [
  { key: 'upper', label: 'CAPITALS' },
  { key: 'as-is', label: 'As said' },
  { key: 'lower', label: 'lowercase' }
] as const

const caseOf = (c: Captions | undefined): string => String((c?.style as Record<string, unknown> | undefined)?.case ?? 'upper')

export function CutTab(props: TabProps & {
  mode: CutMode
  onMode: (m: CutMode) => void
  /** Shows a subtitle line on the phone, at the moment its first word is said (seconds into the original). */
  onLine: (line: { text: string; at: number } | null) => void
}) {
  // one selector above both, so the arrow keys keep focus on it when the content under it changes
  return (
    <div className="edit-stack">
      <Segmented className="fill" testid="cut-mode" label="What to change in the cut" value={props.mode} options={MODES} onPick={props.onMode} />
      {props.mode === 'pace' ? <PaceControls {...props} /> : props.mode === 'joins' ? <JoinControls {...props} /> : <Words {...props} />}
    </div>
  )
}

/** Cut words and Fix words. */
function Words({
  d,
  base,
  now,
  change,
  settle,
  player,
  placed,
  next,
  mode,
  onLine
}: TabProps & {
  mode: CutMode
  /** Shows a subtitle line on the phone, at the moment its first word is said (seconds into the original). */
  onLine: (line: { text: string; at: number } | null) => void
}) {
  const notify = useNotify()
  const [focusWord, setFocusWord] = useState<string | null>(null)
  const [fix, setFix] = useState({ from: '', to: '' })
  const [rules, setRules] = useState<StyleRule[] | null>(null)
  const { kept } = now
  const captions: Captions = now.p.captions ?? { enabled: true }
  const setCaptions = (fn: (c: Captions) => Captions, key?: string) => change(setP((p) => ({ captions: fn(p.captions ?? { enabled: true }) })), key)

  const groups = useMemo(() => takes(d.words), [d.words])
  const heard = useMemo(() => new Map(d.words.map((w) => [w.id, w.w])), [d.words])
  const byId = useMemo(() => new Map(d.words.map((w) => [w.id, w])), [d.words])
  // a word shown without a fix is the one the subtitles draw: the script's, while they follow it
  const following = !!d.scriptWords && captions.followScript !== false
  const drawn = useMemo(() => drawnWords(heard, following ? d.scriptWords : null), [heard, following, d.scriptWords])
  const lines = useMemo(() => subtitleLines(d.captionLines, kept, base.p.captions, captions, drawn), [d.captionLines, kept, base.p.captions, captions, drawn])
  const firstSource = d.project.sources?.[0]?.id
  const cutNow = [...base.kept].some((id) => !kept.has(id))
  // words cut in the version on screen that this edit brings back: named, so a click on a crossed-out filler by
  // mistake shows, and Cut them again undoes them all at once (the runner's J2 by hand brought back two fillers unseen)
  const broughtBack = d.words.filter((w) => kept.has(w.id) && !base.kept.has(w.id))
  const back = broughtBack.length > 0
  const lower = caseOf(captions) === 'lower'
  const remembered = rules?.find((r) => r.payload?.kind === 'caption-case' && !r.paused)

  useEffect(() => {
    if (mode !== 'fix' || rules) return
    reel.style.rules().then(setRules, () => setRules([]))
  }, [mode, rules])

  const toggle = (id: string) => {
    change((x) => {
      const k = new Set(x.kept)
      if (k.has(id)) k.delete(id)
      else k.add(id)
      return { ...x, kept: k }
    })
    // paused, the player shows the moment just before the word, so Play hears the change
    const at = placed.get(id)
    if (at && !player.playing()) player.seek(Math.max(0, at.s - 1))
  }

  const remember = async (on: boolean) => {
    try {
      if (on) await reel.style.rememberLowercase(d.slug)
      else if (remembered) await reel.style.remove(remembered.id)
      setRules(await reel.style.rules())
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  return (
    <>
      {mode === 'cut' ? (
        <>
          <p className="edit-hint">Click a word to cut it, or a crossed-out word to bring it back.</p>
          {d.words.length === 0 ? (
            <p className="edit-hint">No words yet.</p>
          ) : (
            <div className="words" data-testid="words" onKeyDown={wordKeys}>
              {groups.map((take, ti) => {
                const k = take.filter((w) => kept.has(w.id)).length
                const state = k === 0 ? 'cut' : k === take.length ? 'kept' : 'partly kept'
                return (
                  <div key={take[0].id} className={`take${k === 0 ? ' gone' : ''}`}>
                    <div className="take-label">
                      Take {ti + 1} · {state}
                    </div>
                    <p>
                      {take
                        .map((w) => {
                          const on = kept.has(w.id)
                          const changed = on !== base.kept.has(w.id)
                          return (
                            <span
                              key={w.id}
                              role="button"
                              tabIndex={w.id === (focusWord ?? d.words[0]?.id) ? 0 : -1}
                              onFocus={() => setFocusWord(w.id)}
                              aria-pressed={!on}
                              className={`word${on ? '' : ' cut'}${changed ? ' changed' : ''}`}
                              onClick={() => toggle(w.id)}
                              onKeyDown={pressKeys}
                            >
                              {w.w}
                            </span>
                          )
                        })
                        .reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ' ', el] : [el]), [])}
                    </p>
                  </div>
                )
              })}
            </div>
          )}
          {cutNow && (
            <p className="edit-hint" role="status" data-testid="cut-preview">
              The player skips the words you cut.
            </p>
          )}
          {back && (
            <div className="edit-back" role="status" data-testid="brought-back">
              <p className="edit-hint">
                {broughtBack.length <= 4
                  ? `You brought back ${broughtBack.map((w) => `“${w.w.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')}”`).join(', ')}.`
                  : `You brought back ${broughtBack.length} words.`}{' '}
                {broughtBack.length === 1 ? 'It is' : 'They are'} heard in Version {next}.
              </p>
              <Button
                size="small"
                kind="tertiary"
                data-testid="cut-again"
                onClick={() =>
                  change((x) => {
                    const k = new Set(x.kept)
                    for (const w of broughtBack) k.delete(w.id)
                    return { ...x, kept: k }
                  })
                }
              >
                {broughtBack.length === 1 ? 'Cut it again' : 'Cut them again'}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="edit-hint">
            {following ? 'These lines follow your script. ' : ''}Click into a line to fix its words. Enter starts a new line; Backspace at the start of a line joins it to the one before.
          </p>
          {lines.length ? (
            <SubtitleLines
              lines={lines}
              saved={base.p.captions?.corrections ?? []}
              corrections={captions.corrections ?? []}
              heard={heard}
              drawn={drawn}
              onEdit={(edit) => setCaptions(edit)}
              onShow={(text, token) => {
                const w = byId.get(token.ids[0])
                if (w && (!w.source || w.source === firstSource)) onLine({ text: previewText(text), at: w.s + 0.05 })
              }}
            />
          ) : (
            <p className="edit-hint">The subtitle lines show here once a version with subtitles is made.</p>
          )}
          <div className="edit-field">
            <span className="edit-label">Letters</span>
            <Segmented
              testid="cap-case"
              label="Letters"
              value={caseOf(captions)}
              options={CASES}
              onPick={(k) => setCaptions((c) => ({ ...c, style: { ...(c.style ?? {}), case: k } }))}
            />
          </div>
          {lower && rules && (
            <label className="toggle quiet">
              <input type="checkbox" checked={!!remembered} onChange={(e) => void remember(e.target.checked)} data-testid="remember-lowercase" />
              Start my new reels in lowercase too
            </label>
          )}
          {(captions.corrections ?? []).length > 0 && (
            <div className="edit-field">
              <span className="edit-label">Fixed words</span>
              <ul className="edit-list">
                {(captions.corrections ?? []).map((c) => (
                  <li key={c.at ?? `~${c.from}`} className="edit-row">
                    {/* a fix from the lines is for one place; Remove brings the word back as heard */}
                    <span className="edit-row-main">
                      {!c.at ? `“${c.from}” reads “${c.to}” everywhere` : c.to ? `“${c.from}” reads “${c.to}” in one place` : `“${c.from}” is off the subtitles in one place`}
                    </span>
                    <Button size="small" kind="tertiary" onClick={() => setCaptions((x) => ({ ...x, corrections: (x.corrections ?? []).filter((y) => y.at !== c.at || y.from !== c.from) }))}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="edit-field">
            <span className="edit-label">A word heard wrong everywhere</span>
            <form
              className="edit-fix"
              onSubmit={(e) => {
                e.preventDefault()
                const from = fix.from.trim()
                const to = fix.to.trim()
                if (!from || !to) return
                setCaptions((c) => ({ ...c, corrections: [...(c.corrections ?? []).filter((y) => y.at || y.from !== from), { from, to }] }))
                setFix({ from: '', to: '' })
                settle()
              }}
            >
              <input className="input" aria-label="As heard" placeholder="As heard" value={fix.from} onChange={(e) => setFix({ ...fix, from: e.target.value })} />
              <input className="input" aria-label="Should read" placeholder="Should read" value={fix.to} onChange={(e) => setFix({ ...fix, to: e.target.value })} />
              <Button type="submit" size="small" disabled={!fix.from.trim() || !fix.to.trim()}>
                Fix
              </Button>
            </form>
          </div>
        </>
      )}
    </>
  )
}
