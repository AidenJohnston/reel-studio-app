import { useEffect, useRef, useState } from 'react'
import type { LibraryFile, ProjectJson } from '../../../../shared/api'
import { clock } from '../../../../shared/progress'
import { reel, userMessage } from '../../api'
import { useNotify } from '../../App'
import { Icon } from '../../components/icons'
import { byKeyboard, reducedMotion } from '../../components/motion'
import { Button, IS_MAC } from '../../components/ui'
import { animationName } from '../../../../shared/lanes'
import { fileTitle, pressKeys, setP, Slider, wordKeys, type TabProps } from './controls'
import { focusOf, framed, framingOf, SCALE_MAX, SCALE_MIN } from '../../../../shared/timeline-edit'

type Broll = NonNullable<ProjectJson['broll']>[number]

const TREATMENTS: Record<string, string> = {
  'card-above-head': 'Above your head',
  'full-frame': 'Full screen',
  'phone-card': 'In a phone',
  'side-card': 'Beside you',
  'text-pop': 'Big words on the screen',
  'text-behind': 'Big words behind you',
  'post-wall': 'Wall of pictures',
  'icon-wall': 'Wall of icons',
  'split-top': 'Top half'
}

function kindOf(b: Broll): string {
  const asset = typeof b.asset === 'string' ? b.asset : ''
  const kind = animationName(asset) ?? TREATMENTS[b.treatment] ?? 'Picture'
  const text = typeof b.params?.text === 'string' && b.params.text ? `“${b.params.text}”` : ''
  return [kind, text].filter(Boolean).join(' · ')
}

/** A picture's thumbnail: from main (saved items), or the Library file picked here (not saved yet). */
export function pictureUrl(b: Broll, thumbs: Record<string, string>, images: LibraryFile[]): string | null {
  return thumbs[b.id] ?? images.find((f) => b.asset === `Library/Images/${f.name}`)?.url ?? null
}

export function PicturesTab({
  d,
  base,
  now,
  change,
  settle,
  player,
  placed,
  images,
  reloadImages,
  selected = null,
  reveal = 0,
  onSelect
}: TabProps & {
  images: LibraryFile[]
  reloadImages: () => Promise<void>
  /** the picture picked here or on the timeline (its b-roll id) */
  selected?: string | null
  /** counts picks on the timeline, so picking the picked picture again still brings its row into view */
  reveal?: number
  onSelect?: (id: string | null) => void
}) {
  const notify = useNotify()
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!selected) return
    list.current?.querySelector(`[data-key="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() || byKeyboard() ? 'auto' : 'smooth' })
  }, [selected, reveal])
  // adding: which picture, then the word where it pops up
  const [picking, setPicking] = useState<string | null>(null)
  const [pickFocus, setPickFocus] = useState<string | null>(null)
  const broll = now.p.broll ?? []
  const keptWords = d.words.filter((w) => now.kept.has(w.id))
  const pickStop = keptWords.some((w) => w.id === pickFocus) ? pickFocus : keptWords[0]?.id
  const wordText = (a: Broll['anchor']) => {
    const i = d.words.findIndex((w) => w.id === a.from)
    const j = d.words.findIndex((w) => w.id === a.to)
    return i < 0 ? '' : d.words.slice(i, Math.min(Math.max(j, i) + 1, i + 6)).map((w) => w.w).join(' ')
  }
  const isNew = (b: Broll) => !(base.p.broll ?? []).some((x) => x.id === b.id)
  const setPicture = (id: string, next: (b: Broll) => Broll, key: string) =>
    change(setP((p) => ({ broll: (p.broll ?? []).map((x) => (x.id === id ? next(x) : x)) })), `${key}-${id}`)

  const choose = async () => {
    try {
      const r = await reel.library.choose('images')
      await reloadImages()
      const name = r.find((x) => x.bin === 'images' && x.dest)?.dest?.split(/[\\/]/).pop()
      if (name) setPicking(`Library/Images/${name}`)
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  const addAt = (wordId: string) => {
    if (!picking) return
    const i = keptWords.findIndex((w) => w.id === wordId)
    // about two seconds of kept speech from the clicked word (anchors are word ids, never seconds)
    let j = i
    while (j + 1 < keptWords.length && keptWords[j + 1].source === keptWords[i].source && keptWords[j + 1].e - keptWords[i].s < 2.2) j++
    const id = `b${Date.now().toString(36)}`
    change(setP((p) => ({ broll: [...(p.broll ?? []), { id, anchor: { from: wordId, to: keptWords[j].id }, treatment: 'card-above-head', asset: picking }] })))
    setPicking(null)
    const at = placed.get(wordId)
    if (at) player.seek(Math.max(0, at.s - 0.5), true)
  }

  if (picking)
    return (
      <div className="edit-stack" data-testid="pick-word">
        <p className="edit-hint">
          <b>Click the word where the picture pops up.</b> It shows above your head for about two seconds.
        </p>
        <p className="pick-words" onKeyDown={wordKeys}>
          {keptWords.map((w) => (
            <span key={w.id}>
              <span className="word" role="button" tabIndex={w.id === pickStop ? 0 : -1} onFocus={() => setPickFocus(w.id)} onClick={() => addAt(w.id)} onKeyDown={pressKeys}>
                {w.w}
              </span>{' '}
            </span>
          ))}
        </p>
        <div className="edit-actions">
          <Button size="small" kind="tertiary" onClick={() => setPicking(null)}>
            Cancel
          </Button>
        </div>
      </div>
    )

  return (
    <div className="edit-stack">
      {broll.length === 0 ? (
        <p className="edit-hint">No pictures in this reel yet.</p>
      ) : (
        <ul className="edit-list" ref={list}>
          {broll.map((b) => {
            const url = pictureUrl(b, d.brollThumbs, images)
            const at = placed.get(b.anchor.from)
            const credit = d.brollCredits[b.id] ?? (b.asset?.startsWith('Library/') ? 'Yours, from your Library' : null)
            return (
              <li key={b.id} data-key={b.id} className={`edit-row picture-row${selected === b.id ? ' on' : ''}`} aria-current={selected === b.id || undefined} data-testid="picture-row">
                <button
                  className="picture-thumb"
                  onClick={() => {
                    onSelect?.(b.id)
                    if (at) player.seek(Math.max(0, at.s - 0.5), true)
                  }} disabled={!at} aria-label={at ? `Play from ${clock(at.s)}` : 'Not in this version'}>
                  {url ? <img src={url} alt="" data-testid="broll-thumb" /> : <Icon name={b.asset ? 'film' : 'type'} size={16} />}
                </button>
                <div className="edit-row-main">
                  <span className="edit-row-title">
                    On “{wordText(b.anchor)}”{at && <span className="tnum muted"> · {clock(at.s)}</span>}
                    {isNew(b) && <span className="edit-new"> · new</span>}
                  </span>
                  <span className="edit-row-sub">{kindOf(b)}</span>
                  {credit && (
                    <span className="edit-row-sub credit" data-testid="picture-credit">
                      {credit}
                    </span>
                  )}
                </div>
                <Button
                  size="small"
                  kind="tertiary"
                  danger
                  onClick={() => {
                    if (selected === b.id) onSelect?.(null)
                    change(setP((p) => ({ broll: (p.broll ?? []).filter((x) => x.id !== b.id) })))
                  }}
                >
                  Remove
                </Button>
                {selected === b.id && <PictureDetails b={b} words={keptWords} set={setPicture} settle={settle} />}
              </li>
            )
          })}
        </ul>
      )}
      <div className="edit-field">
        <span className="edit-label">Add a picture</span>
        {images.length > 0 && (
          <div className="library-picks" data-testid="library-pictures">
            {images.slice(0, 8).map((f) => (
              <button key={f.path} className="library-pick" title={fileTitle(f.name)} aria-label={`Use ${fileTitle(f.name)}`} onClick={() => setPicking(`Library/Images/${f.name}`)}>
                <img src={f.url} alt="" />
              </button>
            ))}
          </div>
        )}
        <div className="edit-actions">
          <Button size="small" onClick={() => void choose()} data-testid="picture-add">
            <Icon name="plus" size={14} /> Choose a picture on this {IS_MAC ? 'Mac' : 'PC'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The picked picture's timing and framing, which the timeline and the frame on the reel change by dragging: here they
 * are labelled controls a keyboard reaches. Each is a change in this panel, so it goes out as the panel's next version,
 * through the same queue as every other hand edit.
 */
function PictureDetails({
  b,
  words,
  set,
  settle
}: {
  b: Broll
  /** the words kept: a picture's start and end are word ids, never seconds */
  words: { id: string; w: string }[]
  set: (id: string, next: (b: Broll) => Broll, key: string) => void
  settle: () => void
}) {
  const i = words.findIndex((w) => w.id === b.anchor.from)
  const j = words.findIndex((w) => w.id === b.anchor.to)
  const how = framingOf(b)
  const f = focusOf(b)
  const moveEnd = (end: 'from' | 'to', by: -1 | 1) => {
    const at = (end === 'from' ? i : j) + by
    set(b.id, (x) => ({ ...x, anchor: { ...x.anchor, [end]: words[at].id } }), `pic-${end}`)
  }
  const step = (end: 'from' | 'to', label: string, at: number, earlier: boolean, later: boolean) => (
    <div className="pic-end">
      <span className="edit-slider-label">{label}</span>
      <span className="pic-end-word" aria-live="polite">
        “{words[at]?.w ?? ''}”
      </span>
      <span className="pic-end-steps">
        <button type="button" className="icon-btn small" aria-label={`${label} one word earlier`} disabled={!earlier} onClick={() => moveEnd(end, -1)} data-testid={`pic-${end}-earlier`}>
          <Icon name="chevron-left" size={14} stroke={2} />
        </button>
        <button type="button" className="icon-btn small" aria-label={`${label} one word later`} disabled={!later} onClick={() => moveEnd(end, 1)} data-testid={`pic-${end}-later`}>
          <Icon name="chevron-right" size={14} stroke={2} />
        </button>
      </span>
    </div>
  )
  const pct = (v: number) => `${Math.round(v * 100)}%`
  return (
    <div className="pic-details" data-testid="picture-details">
      {i >= 0 && j >= i ? (
        <>
          {step('from', 'Starts on', i, i > 0, i < j)}
          {step('to', 'Ends on', j, j > i, j < words.length - 1)}
        </>
      ) : (
        <p className="edit-hint">Its words are cut from this version, so it doesn't show.</p>
      )}
      {how.scale && (
        <Slider
          label="Size"
          value={f.scale}
          shown={pct(f.scale)}
          spoken={`${pct(f.scale)} of its usual size`}
          min={SCALE_MIN}
          max={SCALE_MAX}
          step={0.05}
          onChange={(v) => set(b.id, (x) => framed(x, { scale: v }), 'pic-scale')}
          onDone={settle}
          testid="pic-scale"
        />
      )}
      {how.pan === 'xy' && (
        <Slider
          label="Left or right"
          aria="Picture position, left to right"
          value={f.x}
          shown={f.x < 0.4 ? 'Left' : f.x > 0.6 ? 'Right' : 'Middle'}
          spoken={`${pct(f.x)} from its left edge`}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => set(b.id, (x) => framed(x, { dx: focusOf(x).x - v }), 'pic-pan-x')}
          onDone={settle}
          testid="pic-pan-x"
        />
      )}
      {how.pan && (
        <Slider
          label="Up or down"
          aria="Picture position, top to bottom"
          value={f.y}
          shown={f.y < 0.4 ? 'Top' : f.y > 0.6 ? 'Bottom' : 'Middle'}
          spoken={`${pct(f.y)} from its top edge`}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => set(b.id, (x) => framed(x, { dy: focusOf(x).y - v }), 'pic-pan-y')}
          onDone={settle}
          testid="pic-pan-y"
        />
      )}
    </div>
  )
}
