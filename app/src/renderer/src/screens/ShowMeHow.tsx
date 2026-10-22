import { useEffect, useMemo, useRef, useState } from 'react'
import type { LibraryFile, ProjectDetail, ProjectJson, VersionInfo, Word } from '../../../shared/api'
import { rangesKeepingOrder } from '../../../shared/cut'
import { describeChange } from '../../../shared/describe'
import { isMirrored, withMirror } from '../../../shared/mirror'
import { reel, userMessage } from '../api'
import { useNotify } from '../App'
import { IS_MAC } from '../components/ui'
import { Icon } from '../components/icons'
import { SubtitleSample } from '../components/Player'
import { CAPTION_PRESETS, applyPreset, lookFromStyle, presetOf, type SubtitleLook } from '../../../shared/caption-presets'

export type Tab = 'cut' | 'captions' | 'music' | 'broll' | 'cover' | 'post'
const TABS: { key: Tab; label: string }[] = [
  { key: 'cut', label: 'Cut' },
  { key: 'captions', label: 'Subtitles' },
  { key: 'music', label: 'Music' },
  { key: 'broll', label: 'Pictures' },
  { key: 'cover', label: 'Cover' },
  { key: 'post', label: 'Post caption' }
]

const TREATMENTS: Record<string, string> = {
  'card-above-head': 'Picture above your head',
  'full-frame': 'Full screen',
  'phone-card': 'In a phone',
  'side-card': 'Picture beside you',
  'text-pop': 'Big words on the screen',
  'post-wall': 'Wall of pictures',
  'icon-wall': 'Wall of icons',
  'split-top': 'Top half'
}

/** "anim-big-quote-2.mov" -> "Moving big quote"; never a computer file name (grandma 2). */
function animationName(asset: string): string | null {
  const m = /(?:^|[\/])anim-([a-z0-9-]+?)(?:-\d+)?\.(?:mov|webm|mp4)$/i.exec(asset)
  if (!m) return null
  return `Moving ${m[1].replace(/-/g, ' ')}`
}

function brollDetail(b: NonNullable<ProjectJson['broll']>[number]): string {
  const asset = typeof b.asset === 'string' ? b.asset : ''
  const kind = animationName(asset) ?? TREATMENTS[b.treatment] ?? 'Picture'
  const text = typeof b.params?.text === 'string' && b.params.text ? `"${b.params.text}"` : ''
  return [kind, text].filter(Boolean).join(' · ')
}

// Caption fine-tuning in plain words, on top of the look picked (shared/caption-presets.ts).
type CapStyle = Record<string, unknown>
const SIZES = [
  { key: 'small', label: 'Small', size: 84 },
  { key: 'medium', label: 'Medium', size: 105 },
  { key: 'big', label: 'Big', size: 126 }
]
const POSITIONS = [
  { key: 'higher', label: 'Higher', position: 0.66 },
  { key: 'lower', label: 'Lower', position: 0.75 }
]
const COLORS = [
  { key: 'white', label: 'White', color: '#FFFFFF' },
  { key: 'yellow', label: 'Yellow', color: '#FFD60A' }
]
const HIGHLIGHTS = [
  { key: 'yellow', label: 'Yellow', color: '#FFD60A' },
  { key: 'green', label: 'Green', color: '#30D158' }
]
function sizeKey(st: CapStyle): string {
  const n = Number(st.size ?? 105)
  return n < 95 ? 'small' : n > 115 ? 'big' : 'medium'
}
function positionKey(st: CapStyle): string {
  return Number(st.position ?? 0.75) < 0.69 ? 'higher' : 'lower'
}
function colorKey(st: CapStyle): string {
  return String(st.color ?? '#FFFFFF').toUpperCase() === '#FFFFFF' ? 'white' : 'yellow'
}
function highlightKey(st: CapStyle): string {
  return HIGHLIGHTS.find((x) => x.color === String(st.highlight).toUpperCase())?.key ?? ''
}

/** A radio group is one Tab stop; the arrow keys move the choice (WAI-ARIA radio group). */
function arrowPick(e: React.KeyboardEvent<HTMLElement>, keys: string[], value: string | null, onPick: (k: string) => void) {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
  if (!step) return
  e.preventDefault()
  const next = keys[(keys.indexOf(value ?? keys[0]) + step + keys.length) % keys.length]
  onPick(next)
  e.currentTarget.querySelector<HTMLElement>(`[data-key="${next}"]`)?.focus()
}
const tabStop = (key: string, value: string | null, keys: string[]): number => (key === (value ?? keys[0]) ? 0 : -1)

function Seg({ value, options, onPick, testid, label }: { value: string; options: { key: string; label: string }[]; onPick: (k: string) => void; testid: string; label: string }) {
  const keys = options.map((o) => o.key)
  return (
    <div className="seg" role="radiogroup" aria-label={label} data-testid={testid} onKeyDown={(e) => arrowPick(e, keys, value, onPick)}>
      {options.map((o) => (
        <button
          key={o.key}
          role="radio"
          aria-checked={o.key === value}
          tabIndex={tabStop(o.key, value, keys)}
          data-key={o.key}
          className={o.key === value ? 'on' : ''}
          onClick={() => onPick(o.key)}
          data-testid={`${testid}-${o.key}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const SWATCH_WIDTH = 74
const LOOK_KEYS = CAPTION_PRESETS.map((p) => p.key)

/** The looks to start from, each drawn on a tiny phone frame with the sample line (delight 3). */
function Swatches({ value, text, onPick }: { value: string | null; text: string; onPick: (k: string) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Subtitle look" data-testid="cap-look" onKeyDown={(e) => arrowPick(e, LOOK_KEYS, value, onPick)}>
      {CAPTION_PRESETS.map((o) => (
        <button
          key={o.key}
          role="radio"
          aria-checked={o.key === value}
          tabIndex={tabStop(o.key, value, LOOK_KEYS)}
          data-key={o.key}
          className={`swatch${o.key === value ? ' on' : ''}`}
          onClick={() => onPick(o.key)}
          data-testid={`cap-look-${o.key}`}
        >
          {/* the name first: under the picture it fell below the drawer's footer (grandma3 #15) */}
          <span className="swatch-label">{o.label}</span>
          <span className="swatch-frame">
            <SubtitleSample look={{ ...lookFromStyle(o.style), position: 0.5 }} text={text} width={SWATCH_WIDTH} />
          </span>
        </button>
      ))}
    </div>
  )
}

/** The transcript in takes: a new paragraph where the speaker paused or the file changes. */
function takes(words: Word[]): Word[][] {
  const out: Word[][] = []
  let cur: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const prev = words[i - 1]
    if (prev && (prev.source !== w.source || w.s - prev.e > 1.0)) {
      out.push(cur)
      cur = []
    }
    cur.push(w)
  }
  if (cur.length) out.push(cur)
  return out
}

/** A sample line for the subtitle preview: kept words as the engine groups them (captions.chunk), up to
 * `maxWords` and never past a sentence end, shown at the moment its first word is spoken. */
export function sampleLine(words: Word[], kept: Set<string>, maxWords: number): { text: string; at: number; words: number } {
  const k = words.filter((w) => kept.has(w.id) && /\w/.test(w.w))
  const start = k.length > 6 ? 2 : 0
  const pick: Word[] = []
  for (const w of k.slice(start)) {
    pick.push(w)
    if (pick.length >= maxWords || /[.!?…]["')\]]*$/.test(w.w.trim())) break
  }
  if (!pick.length) return { text: 'Your words here', at: 0.5, words: 3 }
  const text = pick.map((w) => w.w.trim()).join(' ').replace(/^[(\[{"¿¡]+/, '').replace(/[.,!?;:)\]}"…]+$/, '')
  return { text, at: pick[0].s + 0.15, words: pick.length }
}

const LEVELS: { key: string; label: string }[] = [
  { key: 'under-voice', label: 'Under my voice' },
  { key: 'quiet', label: 'Quiet' },
  { key: 'loud-intro', label: 'Loud at the start, then under my voice' }
]

export function ShowMeHow({
  d,
  version,
  initialTab = 'cut',
  onClose,
  onChanged,
  onRerender,
  onPreview,
  onTab
}: {
  d: ProjectDetail
  version: VersionInfo | null
  initialTab?: Tab
  onClose: () => void
  onChanged: () => void
  /** `change`: what changed, in plain words, for the chat and the version button. `label`: what the
   * progress bar says, when the open tab's own words would be wrong (a flip from the Cut tab). */
  onRerender: (change: string, label?: string) => void
  /** The subtitle look to preview on the phone (Subtitles tab), or null. */
  onPreview?: (p: { look: SubtitleLook; text: string; at: number } | null) => void
  onTab?: (t: Tab) => void
}) {
  const notify = useNotify()
  const [tab, setTabState] = useState<Tab>(initialTab)
  const setTab = (t: Tab) => {
    setTabState(t)
    onTab?.(t)
  }
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})
  const [patch, setPatch] = useState<Partial<ProjectJson>>({})
  const [kept, setKept] = useState(() => new Set(d.keptIds))
  const [cutDirty, setCutDirty] = useState(false)
  const [music, setMusic] = useState<LibraryFile[]>([])
  const [newFix, setNewFix] = useState({ from: '', to: '' })
  const [images, setImages] = useState<LibraryFile[]>([])
  // Adding a picture: which Library picture, then the word where it pops up.
  const [picking, setPicking] = useState<string | null>(null)
  const p = { ...d.project, ...patch } as ProjectJson
  const dirty = cutDirty || Object.keys(patch).length > 0

  const loadLibrary = () =>
    reel.library.list().then((bins) => {
      setMusic(bins.find((b) => b.key === 'music')?.files ?? [])
      setImages(bins.find((b) => b.key === 'images')?.files ?? [])
    })
  useEffect(() => {
    void loadLibrary()
  }, [])

  /** Pick files on this computer into the Library. Returns Library-relative paths (project.json refuses absolute ones). */
  // a picture's thumbnail: from main (saved items), or the Library file just picked here (not saved yet)
  const thumbFor = (b: NonNullable<ProjectJson['broll']>[number]): string | null =>
    d.brollThumbs?.[b.id] ?? images.find((f) => b.asset === `Library/Images/${f.name}`)?.url ?? null
  const chooseInto = async (kind: 'music' | 'images'): Promise<string[]> => {
    try {
      const r = await reel.library.choose(kind)
      await loadLibrary()
      const folder = kind === 'music' ? 'Music' : 'Images'
      return r.filter((x) => x.bin === kind && x.dest).map((x) => `Library/${folder}/${x.dest!.split(/[\\/]/).pop()}`)
    } catch (e) {
      notify(userMessage(e), 'error')
      return []
    }
  }

  const capStyle: CapStyle = (p.captions?.style as CapStyle) ?? {}
  const setCapStyle = (extra: CapStyle) =>
    set('captions', { ...(p.captions ?? { enabled: true }), style: { ...capStyle, ...extra } })

  const keptWords = d.words.filter((w) => kept.has(w.id))
  const addPictureAt = (wordId: string) => {
    if (!picking) return
    const i = keptWords.findIndex((w) => w.id === wordId)
    // About two seconds of kept speech from the clicked word (anchors are word ids, never seconds).
    let j = i
    while (j + 1 < keptWords.length && keptWords[j + 1].source === keptWords[i].source && keptWords[j + 1].e - keptWords[i].s < 2.2) j++
    const id = `b${Date.now().toString(36)}`
    set('broll', [...(p.broll ?? []), { id, anchor: { from: wordId, to: keptWords[j].id }, treatment: 'card-above-head', asset: picking }])
    setPicking(null)
  }

  const wordText = useMemo(() => new Map(d.words.map((w) => [w.id, w.w])), [d.words])
  const anchorText = (a: { from: string; to: string } | undefined) => {
    if (!a) return ''
    const i = d.words.findIndex((w) => w.id === a.from)
    const j = d.words.findIndex((w) => w.id === a.to)
    if (i < 0 || j < 0) return wordText.get(a.from) ?? ''
    return d.words.slice(i, Math.min(j + 1, i + 8)).map((w) => w.w).join(' ')
  }

  const set = <K extends keyof ProjectJson>(k: K, v: ProjectJson[K]) => setPatch((x) => ({ ...x, [k]: v }))

  const undo = () => {
    setPatch({})
    setKept(new Set(d.keptIds))
    setCutDirty(false)
  }

  // Focus the open tab, not Close (an auto-focused Close looked like the main button).
  useEffect(() => {
    tabRefs.current[tab]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc closes; Cmd/Ctrl+Z undoes (when not typing in a box, where it undoes the typing).
  const undoRef = useRef(undo)
  undoRef.current = undo
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      const t = e.target as HTMLElement | null
      const inBox = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')
      if (!inBox && (IS_MAC ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        undoRef.current()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const save = async () => {
    try {
      const full: Partial<ProjectJson> = { ...patch }
      if (cutDirty) full.cut = { ...(d.project.cut ?? { keep: [] }), keep: rangesKeepingOrder(d.words, d.project.cut?.keep, kept) }
      await reel.projects.update(d.slug, full)
      onChanged()
      const onlyPost = Object.keys(full).every((k) => k === 'post')
      if (onlyPost) {
        setPatch({})
        notify('Saved. Copy it when you post.')
      } else {
        const onlyFlip = !cutDirty && Object.keys(full).every((k) => k === 'sources' || k === 'post')
        onRerender(describeChange(d.project, patch, kept.size - d.keptIds.length), onlyFlip ? 'Flipping your video' : undefined)
      }
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  const copy = async (text: string, what: string) => {
    await reel.app.copyText(text)
    notify(`${what} copied.`)
  }

  const maxWords = Number(capStyle.maxWords ?? 3)
  const sample = useMemo(() => sampleLine(d.words, kept, maxWords), [d.words, kept, maxWords])
  const subsOn = p.captions?.enabled !== false
  const lookJson = JSON.stringify(capStyle)
  useEffect(() => {
    if (!onPreview) return
    // captions.word_spans: a line whose words don't match its tokens one to one gets no highlight
    const look = lookFromStyle(capStyle)
    if (sample.text.split(' ').length !== sample.words) look.highlight = null
    onPreview(tab === 'captions' && subsOn ? { look, text: sample.text, at: sample.at } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, subsOn, lookJson, sample.text, sample.at, sample.words])

  const coverTime = Number(p.cover?.atSourceTime ?? 0) || 0
  const sourceDuration = d.project.sources?.[0]?.duration ?? 60
  const hashtags = (Array.isArray(p.post?.hashtags) ? p.post!.hashtags : [])
    .map((h) => String(h))
    .map((h) => (h.startsWith('#') ? h : `#${h}`))
    .join(' ')

  return (
    <>
      <aside className="drawer" data-testid="drawer" aria-label="Edit it myself">
        <div className="drawer-head">
          <div>
            <h2>Edit it myself</h2>
            <p className="muted-sm">Change anything you like, then press "Make a new version". Or leave it as it is.</p>
          </div>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)" data-testid="drawer-close">
            <Icon name="x" />
          </button>
        </div>
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[t.key] = el
              }}
              role="tab"
              aria-selected={tab === t.key}
              className={`tab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
              data-testid={`tab-${t.key}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="drawer-body">
          {tab === 'cut' && (
            <div className="stack">
              {/* a front-camera take often comes out mirrored: writing behind you reads backwards */}
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={isMirrored(p)}
                  onChange={(e) => set('sources', withMirror(p.sources, e.target.checked))}
                  data-testid="mirror-on"
                />
                Flip picture (it's mirrored)
              </label>
              <p className="muted-sm" style={{ marginTop: -6 }}>Turn this on if writing behind you reads backwards. Your subtitles and pictures stay the right way round.</p>
              <p className="muted" style={{ fontSize: 16 }}>
                <b>Crossed-out words are cut.</b> Click a word to bring it back, or click a kept word to cut it.
              </p>
              {d.words.length === 0 ? (
                <p className="faint">No words yet.</p>
              ) : (
                <div className="words" data-testid="words">
                  {takes(d.words).map((take, ti) => {
                    const k = take.filter((w) => kept.has(w.id)).length
                    const state = k === 0 ? 'cut' : k === take.length ? 'kept' : 'trimmed'
                    return (
                      <div key={ti} className={`take ${state}`}>
                        <div className="take-label">
                          Take {ti + 1} · {state === 'trimmed' ? 'partly kept' : state}
                        </div>
                        <p>
                          {take
                            .map((w) => (
                              <span
                                key={w.id}
                                role="button"
                                tabIndex={0}
                                className={`word${kept.has(w.id) ? '' : ' cut'}`}
                                title={kept.has(w.id) ? 'Click to cut' : 'Click to bring back'}
                                onClick={() => {
                                  const next = new Set(kept)
                                  if (next.has(w.id)) next.delete(w.id)
                                  else next.add(w.id)
                                  setKept(next)
                                  setCutDirty(true)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault()
                                    ;(e.currentTarget as HTMLElement).click()
                                  }
                                }}
                              >
                                {w.w}
                              </span>
                            ))
                            .reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ' ', el] : [el]), [])}
                        </p>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'captions' && (
            <div className="stack">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={p.captions?.enabled !== false}
                  onChange={(e) => set('captions', { ...(p.captions ?? { enabled: true }), enabled: e.target.checked })}
                  data-testid="subs-on"
                />
                Show subtitles
              </label>
              {p.captions?.enabled !== false && (
                <div className="stack" data-testid="caption-controls">
                  <h3 style={{ marginTop: 6 }}>Look</h3>
                  {/* two words: a whole line shrinks to fit 74 px and can't be read */}
                  <Swatches value={presetOf(capStyle)} text={sample.text.split(' ').slice(0, 2).join(' ')} onPick={(k) => set('captions', { ...(p.captions ?? { enabled: true }), style: applyPreset(k) })} />
                  <h3>Size</h3>
                  <Seg
                    testid="cap-size"
                    label="Size"
                    value={sizeKey(capStyle)}
                    options={SIZES}
                    onPick={(k) => setCapStyle({ size: SIZES.find((x) => x.key === k)!.size })}
                  />
                  <h3>Position</h3>
                  <Seg
                    testid="cap-pos"
                    label="Position"
                    value={positionKey(capStyle)}
                    options={POSITIONS}
                    onPick={(k) => setCapStyle({ position: POSITIONS.find((x) => x.key === k)!.position })}
                  />
                  {capStyle.highlight ? (
                    <>
                      <h3>Spoken word</h3>
                      <Seg
                        testid="cap-highlight"
                        label="Spoken word colour"
                        value={highlightKey(capStyle)}
                        options={HIGHLIGHTS}
                        onPick={(k) => setCapStyle({ highlight: HIGHLIGHTS.find((x) => x.key === k)!.color })}
                      />
                    </>
                  ) : (
                    <>
                      <h3>Colour</h3>
                      <Seg testid="cap-color" label="Colour" value={colorKey(capStyle)} options={COLORS} onPick={(k) => setCapStyle({ color: COLORS.find((x) => x.key === k)!.color })} />
                    </>
                  )}
                  <p className="muted-sm">The phone on the left shows the new look. Press "Make a new version" to use it.</p>
                </div>
              )}
              <h3 style={{ marginTop: 10 }}>Fix a word</h3>
              <p className="muted-sm">If I spelled something wrong, tell me the right spelling.</p>
              <div className="list">
                {(p.captions?.corrections ?? []).map((c, i) => (
                  <div key={i} className="list-item">
                    <span>"{c.from}" becomes "{c.to}"</span>
                    <span className="spacer" />
                    <button
                      className="btn small ghost"
                      onClick={() =>
                        set('captions', {
                          ...(p.captions ?? { enabled: true }),
                          corrections: (p.captions?.corrections ?? []).filter((_, j) => j !== i)
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              <div className="row">
                <input className="input" aria-label="Wrong word" placeholder="Wrong word" value={newFix.from} onChange={(e) => setNewFix({ ...newFix, from: e.target.value })} />
                <input className="input" aria-label="Right word" placeholder="Right word" value={newFix.to} onChange={(e) => setNewFix({ ...newFix, to: e.target.value })} />
                <button
                  className="btn"
                  disabled={!newFix.from.trim() || !newFix.to.trim()}
                  onClick={() => {
                    set('captions', {
                      ...(p.captions ?? { enabled: true }),
                      corrections: [...(p.captions?.corrections ?? []), { from: newFix.from.trim(), to: newFix.to.trim() }]
                    })
                    setNewFix({ from: '', to: '' })
                  }}
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {tab === 'music' && (
            <div className="stack">
              <div className="row">
                <p className="muted" style={{ flex: 1 }}>Pick a song for under your voice.</p>
                <button
                  className="btn small"
                  data-testid="music-add"
                  onClick={async () => {
                    const [track] = await chooseInto('music')
                    if (track) set('music', { ...(p.music ?? {}), enabled: true, track, startAt: 0, level: p.music?.level ?? 'under-voice' })
                  }}
                >
                  Add a song from my computer
                </button>
              </div>
              <div className="list">
                <label className={`radio${!p.music?.track || p.music?.enabled === false ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="track"
                    checked={!p.music?.track || p.music?.enabled === false}
                    onChange={() => set('music', { ...(p.music ?? { track: null }), enabled: false, track: null })}
                  />
                  No music
                </label>
                {music.map((m) => {
                  const rel = `Library/Music/${m.name}`
                  const on = p.music?.enabled !== false && p.music?.track === rel
                  return (
                    <label key={m.path} className={`radio${on ? ' on' : ''}`}>
                      <input type="radio" name="track" checked={on} onChange={() => set('music', { ...(p.music ?? {}), enabled: true, track: rel, startAt: 0 })} />
                      {m.name.replace(/\.[^.]+$/, '')}
                    </label>
                  )
                })}
              </div>
              {music.length === 0 && <p className="muted-sm">No songs yet. Add one from your computer.</p>}
              {p.music?.track && p.music.enabled !== false && (
                <>
                  <h3 style={{ marginTop: 10 }}>How loud</h3>
                  <select className="input select" aria-label="How loud" value={p.music.level ?? 'under-voice'} onChange={(e) => set('music', { ...p.music!, level: e.target.value })}>
                    {LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                  </select>
                </>
              )}
            </div>
          )}

          {tab === 'broll' && (
            <div className="stack">
              {picking ? (
                <div className="stack" data-testid="pick-word">
                  <p className="muted">
                    <b>Click the word where the picture should pop up.</b> It shows above your head for about two seconds.
                  </p>
                  <div className="pick-words">
                    {keptWords.map((w) => (
                      <span key={w.id} className="word" onClick={() => addPictureAt(w.id)}>
                        {w.w}{' '}
                      </span>
                    ))}
                  </div>
                  <div className="row">
                    <button className="btn ghost small" onClick={() => setPicking(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="stack">
                  <div className="row">
                    <p className="muted" style={{ flex: 1 }}>Add a picture, then pick the word where it pops up.</p>
                    <button
                      className="btn small primary"
                      data-testid="picture-add"
                      onClick={async () => {
                        const [asset] = await chooseInto('images')
                        if (asset) setPicking(asset)
                      }}
                    >
                      Add a picture
                    </button>
                  </div>
                  {images.length > 0 && (
                    <div className="row wrap" data-testid="library-pictures">
                      <span className="muted-sm">Or use one from your Library:</span>
                      {images.slice(0, 8).map((f) => (
                        <button key={f.path} className="btn small" title={f.name} onClick={() => setPicking(`Library/Images/${f.name}`)}>
                          <img src={f.url} alt="" style={{ width: 22, height: 22, objectFit: 'cover', borderRadius: 4 }} /> {f.name.replace(/\.[^.]+$/, '').slice(0, 18)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {(p.broll ?? []).length === 0 ? (
                <p className="muted-sm">No pictures yet.</p>
              ) : (
                <div className="list">
                  {(p.broll ?? []).map((b) => (
                    <div key={b.id} className="list-item">
                      {thumbFor(b) ? (
                        <img className="broll-thumb" src={thumbFor(b)!} alt="" data-testid="broll-thumb" />
                      ) : (
                        <span className="broll-thumb none" aria-hidden>
                          <Icon name={b.asset ? 'film' : 'type'} size={18} />
                        </span>
                      )}
                      <div>
                        <div style={{ fontWeight: 600 }}>{anchorText(b.anchor) ? `On "${anchorText(b.anchor)}"` : 'Picture'}</div>
                        <div className="muted-sm">{brollDetail(b)}</div>
                      </div>
                      <span className="spacer" />
                      <button className="btn small ghost danger" onClick={() => set('broll', (p.broll ?? []).filter((x) => x.id !== b.id))}>
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'cover' && (
            <div className="stack">
              {version?.cover ? <img className="cover-img" src={version.cover} alt="Cover" /> : <p className="muted-sm">No cover yet.</p>}
              <h3 style={{ marginTop: 6 }}>Pick the moment for your cover</h3>
              <input
                type="range"
                className="slider"
                aria-label="Moment for your cover"
                min={0}
                max={Math.max(1, Math.floor(sourceDuration))}
                step={0.5}
                value={coverTime}
                onChange={(e) =>
                  set('cover', { ...(p.cover ?? { source: 's1', text: null }), atSourceTime: Number(e.target.value) } as ProjectJson['cover'])
                }
              />
              <p className="muted-sm">At {coverTime.toFixed(1)} seconds into your video.</p>
              <h3 style={{ marginTop: 6 }}>Words on the cover</h3>
              <input
                className="input"
                placeholder="Leave empty for no words"
                value={p.cover?.text ?? ''}
                onChange={(e) => set('cover', { ...(p.cover ?? { source: 's1', atSourceTime: 0 }), text: e.target.value || null } as ProjectJson['cover'])}
              />
            </div>
          )}

          {tab === 'post' && (
            <div className="stack">
              <h3>Post caption</h3>
              <p className="muted-sm">The text under your post on Instagram. It is not in the video.</p>
              <textarea
                className="textarea"
                value={p.post?.caption ?? ''}
                onChange={(e) => set('post', { ...(p.post ?? { hashtags: [], keywords: [] }), caption: e.target.value } as ProjectJson['post'])}
              />
              <div className="row">
                <button className="btn small" onClick={() => copy(p.post?.caption ?? '', 'Post caption')}>Copy post caption</button>
              </div>
              <h3 style={{ marginTop: 8 }}>Hashtags</h3>
              <input
                className="input"
                value={hashtags}
                placeholder="#reels #tips"
                onChange={(e) =>
                  set('post', {
                    ...(p.post ?? { caption: '', keywords: [] }),
                    hashtags: e.target.value.split(/[\s,]+/).filter(Boolean).map((h) => h.replace(/^#*/, ''))
                  } as ProjectJson['post'])
                }
              />
              <div className="row">
                <button className="btn small" onClick={() => copy(hashtags, 'Hashtags')}>Copy hashtags</button>
                <button className="btn small" onClick={() => copy([p.post?.caption ?? '', hashtags].filter(Boolean).join('\n\n'), 'Post caption and hashtags')}>
                  Copy both
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="drawer-foot">
          <span className="muted-sm">{dirty ? 'You changed something.' : 'Nothing changed yet.'}</span>
          <span className="spacer" />
          {dirty && (
            <button className="btn ghost" onClick={undo} title={IS_MAC ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)'} data-testid="drawer-undo">
              Undo
            </button>
          )}
          <button className="btn primary" disabled={!dirty} onClick={save} data-testid="make-version">
            {Object.keys(patch).every((k) => k === 'post') && !cutDirty && dirty ? 'Save' : 'Make a new version'}
          </button>
        </div>
      </aside>
    </>
  )
}
