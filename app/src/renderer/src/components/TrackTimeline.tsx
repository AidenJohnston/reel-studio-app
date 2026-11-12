import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { VersionTimeline, Word } from '../../../shared/api'
import { pictureLabel, pictureParts, videoLabel, type PicturePart } from '../../../shared/lanes'
import { clock } from '../../../shared/progress'
import { leadIn } from '../../../shared/sfx'
import type { CaptionPart, TrackLanes } from '../../../shared/track-lanes'
import {
  brollFixed,
  brollGesture,
  captionGesture,
  draggedAnchor,
  nearestStop,
  songGesture,
  trimGesture,
  trimStops,
  usableWords,
  wordStep,
  type Broll,
  type BrollDrag,
  type Draft,
  type Gesture,
  type TrimStop
} from '../../../shared/timeline-edit'
import { Filmstrip } from './Filmstrip'
import { Icon, type IconName } from './icons'
import { textField } from './Player'
import { useFollowPlayhead, type Playhead } from './playhead'
import { stepRate, type Transport } from './transport'
import './track-timeline.css'

// A press that moves less than this is a click.
const DRAG_PX = 3
// The widest zoom: about a word every 150 px.
const MAX_PPS = 400
// Ruler steps, in seconds: the smallest whose labels stay this far apart is used.
const STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60]
const LABEL_PX = 64
// Arrow-key nudges of a picture in a row land as one change once the keys rest this long.
const NUDGE_MS = 600
// J skips back this far each press.
const J_STEP = 1

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const tenths = (t: number): string => `${clock(Math.floor(t))}.${Math.floor((t % 1) * 10)}`

type Drag =
  | { kind: 'scrub' }
  | { kind: 'trim'; part: number; side: 'start' | 'end'; stop: TrimStop | null }
  | { kind: 'broll'; id: string; how: BrollDrag; anchor: Broll['anchor'] | null; ghost: { t0: number; t1: number } | null }
  | { kind: 'song'; startAt: number }

export interface TrackTimelineProps {
  playhead: Playhead
  transport: Transport
  duration: number
  /** the version on screen: its clock, its words and render */
  version: VersionTimeline
  /** its video, for the pictures along your video's lane */
  video: string | null
  /** what the next version will be (the newest project, the changes in Edit it myself, and the edits waiting), drawn */
  draft: Draft
  lanes: TrackLanes
  words: Word[]
  /** the captions as the newest render drew them, so a subtitle typed back as it was drops its fix */
  savedCorrections: NonNullable<NonNullable<Draft['p']['captions']>['corrections']>
  heard: Map<string, string>
  /** why the timeline can't be changed now, or null */
  locked: string | null
  selectedPicture: string | null
  onPicture: (id: string | null) => void
  selectedSound: string | null
  onSound: (key: string) => void
  /** one gesture: one change to the project */
  onGesture: (g: Gesture) => void
  /** a picture's file to swap for one picked on this computer */
  onSwap: (id: string) => void
  /** Cmd/Ctrl+Z: the project's last change taken back, once an undo exists for it */
  onUndo?: () => void
}

/**
 * The editing timeline under the reel while Edit it myself is open, as in a video editor: a ruler, and one labelled
 * lane each for your video, the pictures, the subtitles, the song and the sound effects, on the clock of the version on
 * screen. Zoom with the buttons or Ctrl/⌘ and the wheel; drag the ruler to scrub.
 *
 * Drag a cut's edge to trim it (it stops on the edge of each word; past the edge it brings back the words cut there),
 * drag a picture to move it or its ends to resize it (on words too), pick one to swap or delete it, drag the song to
 * start it elsewhere, and click a subtitle to retype it. Each gesture is one change (onGesture), on word ids.
 *
 * Keys: Space plays (the player), J back a second, K stops, L plays and then faster, the arrows a word back or on (a
 * picked picture moves by a word), Delete removes a picked picture, Ctrl/⌘+Z undoes (onUndo).
 */
export function TrackTimeline(props: TrackTimelineProps) {
  const { playhead, transport, duration, version, draft, lanes, words, locked, selectedPicture, onPicture, onGesture } = props
  const root = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const ruler = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ width: 0, left: 0 })
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setView((v) => ({ ...v, width: el.clientWidth })))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  // zoom: 1 fits the reel to the lanes' width
  const [zoom, setZoom] = useState(1)
  const fit = duration > 0 && view.width > 0 ? view.width / duration : 0
  const maxZoom = fit ? Math.max(1, MAX_PPS / fit) : 1
  const pps = fit * clamp(zoom, 1, maxZoom)
  const ppsNow = useRef(pps)
  ppsNow.current = pps
  const x = (t: number): number => t * pps
  const contentW = Math.max(view.width, duration * pps)

  // the playhead follows the video outside React; while playing, the view keeps it in sight
  const follow = useCallback((t: number) => {
    const px = t * ppsNow.current
    if (head.current) head.current.style.transform = `translateX(${px}px)`
    ruler.current?.setAttribute('aria-valuenow', String(Math.round(t)))
    ruler.current?.setAttribute('aria-valuetext', clock(t))
    const s = scroller.current
    if (s && transport.get().playing && (px < s.scrollLeft || px > s.scrollLeft + s.clientWidth - 24)) s.scrollLeft = px - 24
  }, [transport])
  useFollowPlayhead(playhead, follow)
  useLayoutEffect(() => follow(playhead.get()), [pps, follow, playhead])

  /** Zoom by `f` keeping the time under `atX` (px from the lanes' left edge) where it is. */
  const zoomBy = (f: number, atX = view.width / 2) => {
    const s = scroller.current
    if (!s || !fit) return
    const t = (s.scrollLeft + atX) / pps
    const z = clamp(zoom * f, 1, maxZoom)
    setZoom(z)
    requestAnimationFrame(() => (s.scrollLeft = t * fit * z - atX))
  }
  // Ctrl/⌘ and the wheel zoom; the wheel alone scrolls the lanes sideways once zoomed in
  useEffect(() => {
    const s = scroller.current
    if (!s) return
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomRef.current(Math.exp(-e.deltaY / 300), e.clientX - s.getBoundingClientRect().left)
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && s.scrollWidth > s.clientWidth) {
        e.preventDefault()
        s.scrollLeft += e.deltaY
      }
    }
    s.addEventListener('wheel', wheel, { passive: false })
    return () => s.removeEventListener('wheel', wheel)
  }, [])
  const zoomRef = useRef(zoomBy)
  zoomRef.current = zoomBy

  const tAt = (clientX: number): number => {
    const s = scroller.current!
    return clamp((clientX - s.getBoundingClientRect().left + s.scrollLeft) / pps, 0, duration)
  }

  const usable = useMemo(() => usableWords(version.words, draft.kept), [version.words, draft.kept])
  const said = useCallback((id: string) => words.find((w) => w.id === id)?.w ?? '', [words])
  const brollById = useMemo(() => new Map((draft.p.broll ?? []).map((b) => [b.id, b])), [draft.p.broll])
  // a cut with clips from other videos is the editor's to change (shared/cut.ts assertWordCutEditable)
  const clipCut = (draft.p.cut?.keep ?? []).some((k) => 'clip' in (k as object))

  const [drag, setDrag] = useState<Drag | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  /** Follows one press: `move` with the time under the pointer and how far it went; `up` once, with whether it moved. */
  const press = (ev: React.PointerEvent, move: (t: number, dx: number) => void, up: (t: number, moved: boolean) => void) => {
    if (ev.button !== 0) return
    ev.stopPropagation()
    const el = ev.currentTarget as HTMLElement
    el.setPointerCapture(ev.pointerId)
    const x0 = ev.clientX
    let moved = false
    const onMove = (e: PointerEvent) => {
      if (!moved && Math.abs(e.clientX - x0) <= DRAG_PX) return
      moved = true
      move(tAt(e.clientX), (e.clientX - x0) / ppsNow.current)
    }
    const end = (e: PointerEvent, cancelled: boolean) => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      setDrag(null)
      if (!cancelled) up(tAt(e.clientX), moved)
    }
    const onUp = (e: PointerEvent) => end(e, false)
    const onCancel = (e: PointerEvent) => end(e, true)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
  }

  const send = (g: Gesture | null) => {
    if (g && !locked) onGesture(g)
  }

  const scrub = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return
    const wasPlaying = transport.get().playing
    if (wasPlaying) transport.toggle()
    transport.seek(tAt(ev.clientX))
    setDrag({ kind: 'scrub' })
    press(
      ev,
      (t) => transport.seek(t),
      () => {
        if (wasPlaying) transport.toggle()
      }
    )
  }

  const rulerKey = (e: React.KeyboardEvent) => {
    const to = ({ Home: 0, End: duration, ArrowLeft: playhead.get() - 1, ArrowDown: playhead.get() - 1, ArrowRight: playhead.get() + 1, ArrowUp: playhead.get() + 1 } as Partial<Record<string, number>>)[e.key]
    if (to === undefined) return
    e.preventDefault()
    transport.seek(clamp(to, 0, duration))
  }

  const trim = (ev: React.PointerEvent, part: number, side: 'start' | 'end') => {
    const p = lanes.video[part]
    const stops = trimStops(p, side, version.words, words, draft.kept)
    const at = side === 'start' ? p.t0 : p.t1
    let stop = nearestStop(stops, at)
    setDrag({ kind: 'trim', part, side, stop })
    press(
      ev,
      (t) => {
        stop = nearestStop(stops, t)
        setDrag({ kind: 'trim', part, side, stop })
      },
      () => send(stop && trimGesture(stop, said))
    )
  }

  const pictureDrag = (ev: React.PointerEvent, part: PicturePart, how: BrollDrag) => {
    const b = brollById.get(part.id)
    if (!b) return
    const t0 = tAt(ev.clientX)
    const from = usable.find((w) => w.id === b.anchor.from)
    const fixed = brollFixed(b)
    let anchor: Broll['anchor'] | null = null
    press(
      ev,
      (t, dt) => {
        if (fixed || locked || !from) return
        // a move puts the first word where it was plus the drag; an edge goes on the word under it, the start a
        // little before it as the picture comes in before its word
        const want = how === 'move' ? from.s + dt : how === 'start' ? t + (b.leadIn ?? 0.13) : t
        anchor = draggedAnchor(b, usable, how, want)
        const ghost = anchor && pictureParts([{ ...b, anchor }], { placed: version.words, segments: version.segments }, new Map(), duration)[0]
        setDrag({ kind: 'broll', id: b.id, how, anchor, ghost: ghost ? { t0: ghost.t0, t1: ghost.t1 } : null })
      },
      (_t, moved) => {
        if (!moved) {
          onPicture(part.id === selectedPicture ? null : part.id)
          // on the picture, not before it, so a paused player shows it
          if (part.id !== selectedPicture) transport.seek(clamp(t0, part.t0 + 0.05, part.t1 - 0.05))
          return
        }
        if (anchor && JSON.stringify(anchor) !== JSON.stringify(b.anchor)) send(brollGesture(draft.p, draft.kept, b.id, { ...b, anchor }, usable))
      }
    )
  }

  const songDrag = (ev: React.PointerEvent) => {
    const m = lanes.music
    if (!m) return
    let startAt = m.startAt
    press(
      ev,
      (_t, dt) => {
        if (locked) return
        // dragging the song right brings in an earlier part of it
        startAt = Math.max(0, Math.round((m.startAt - dt) * 10) / 10)
        setDrag({ kind: 'song', startAt })
      },
      (t, moved) => {
        if (!moved) return transport.seek(t)
        send(songGesture(draft.p, draft.kept, startAt))
      }
    )
  }

  const removePicture = (id: string) => {
    onPicture(null)
    send(brollGesture(draft.p, draft.kept, id, null, usable))
  }

  // a picked picture nudged by the arrows: one change once the keys rest
  const nudge = useRef<{ id: string; anchor: Broll['anchor']; timer: number } | null>(null)
  const nudgePicture = (id: string, dir: 1 | -1) => {
    const b = brollById.get(id)
    if (!b || brollFixed(b) || locked) return
    const cur = nudge.current?.id === id ? nudge.current.anchor : b.anchor
    const i = usable.findIndex((w) => w.id === cur.from)
    const j = usable.findIndex((w) => w.id === cur.to)
    if (i < 0 || j < i || i + dir < 0 || j + dir >= usable.length) return
    const anchor = { from: usable[i + dir].id, to: usable[j + dir].id }
    window.clearTimeout(nudge.current?.timer)
    const timer = window.setTimeout(() => {
      nudge.current = null
      setDrag(null)
      send(brollGesture(draft.p, draft.kept, id, { ...b, anchor }, usable))
    }, NUDGE_MS)
    nudge.current = { id, anchor, timer }
    const ghost = pictureParts([{ ...b, anchor }], { placed: version.words, segments: version.segments }, new Map(), duration)[0]
    setDrag({ kind: 'broll', id, how: 'move', anchor, ghost: ghost ? { t0: ghost.t0, t1: ghost.t1 } : null })
    transport.seek(usable[i + dir].s)
  }
  useEffect(() => () => window.clearTimeout(nudge.current?.timer), [])

  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keys.current = (e) => {
    const t = e.target as HTMLElement | null
    // the timeline's keys work from the page or the timeline itself; in Edit it myself's lists and boxes the keys are theirs
    if (e.defaultPrevented || textField(t) || document.querySelector('.modal-backdrop')) return
    if (t && t !== document.body && !root.current?.contains(t)) return
    // the ruler is a slider: its arrows, Home and End move by seconds (rulerKey)
    if (t === ruler.current && /^(Arrow|Home$|End$)/.test(e.key)) return
    const mod = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()
    if (mod && k === 'z' && !e.shiftKey) {
      if (!props.onUndo) return
      props.onUndo()
    } else if (mod || e.altKey) return
    else if (k === 'k') {
      if (transport.get().playing) transport.toggle()
      transport.setRate(1)
    } else if (k === 'l') {
      if (!transport.get().playing) transport.toggle()
      else transport.setRate(stepRate(transport.get().rate, 1))
    } else if (k === 'j') transport.seek(Math.max(0, playhead.get() - J_STEP))
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      if (selectedPicture) nudgePicture(selectedPicture, dir)
      else {
        const to = wordStep(usable, playhead.get(), dir)
        if (to !== null) transport.seek(to)
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPicture) removePicture(selectedPicture)
    else if (e.key === 'Escape' && selectedPicture) onPicture(null)
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  useEffect(() => {
    const down = (e: KeyboardEvent) => keys.current(e)
    // capture: before Edit it myself's own Escape (it closes the panel) and the player's arrows
    window.addEventListener('keydown', down, true)
    return () => window.removeEventListener('keydown', down, true)
  }, [])

  const step = STEPS.find((s) => s * pps >= LABEL_PX) ?? STEPS[STEPS.length - 1]
  const ticks = useMemo(() => {
    if (!pps) return []
    const out: number[] = []
    for (let t = 0; t <= duration + 1e-6; t += step) out.push(Math.round(t * 1000) / 1000)
    return out
  }, [duration, step, pps])

  const picked = selectedPicture ? brollById.get(selectedPicture) : undefined
  const pickedPart = lanes.pictures.find((p) => p.id === selectedPicture)
  const tip = dragTip(drag, said)
  const rows: { key: string; label: string; icon: IconName; show: boolean }[] = [
    { key: 'video', label: 'Your video', icon: 'film', show: true },
    { key: 'pictures', label: 'Pictures', icon: 'image', show: true },
    { key: 'captions', label: 'Subtitles', icon: 'type', show: true },
    { key: 'music', label: 'Song', icon: 'music', show: true },
    { key: 'sounds', label: 'Sounds', icon: 'volume', show: lanes.sounds.length > 0 }
  ]
  const tipX = (t: number): number => clamp(x(t), 60, Math.max(60, contentW - 60))

  return (
    <div className="trk" ref={root} data-testid="track-timeline">
      <div className="trk-bar">
        <div className="trk-pick" aria-live="polite">
          {picked && pickedPart ? (
            <>
              <span className="trk-pick-name" data-testid="track-picked">
                {pickedPart.what} · {tenths(pickedPart.t0)}–{tenths(pickedPart.t1)}
              </span>
              {picked.asset && pickedPart.kind === 'picture' && (
                <button className="trk-btn" disabled={!!locked} onClick={() => props.onSwap(picked.id)} data-testid="track-swap">
                  <Icon name="restart" size={14} /> Swap
                </button>
              )}
              <button className="trk-btn danger" disabled={!!locked} onClick={() => removePicture(picked.id)} data-testid="track-delete">
                <Icon name="trash" size={14} /> Delete
              </button>
            </>
          ) : (
            <span className="trk-hint">{locked ?? (clipCut ? 'Drag pictures, the song and subtitles. Your editor changes the cuts of a reel with clips.' : 'Drag an edge to trim, a picture to move it. Click a subtitle to fix it.')}</span>
          )}
        </div>
        <div className="trk-zoom" role="group" aria-label="Zoom">
          <button className="trk-icon" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => zoomBy(1 / 1.5)} data-testid="track-zoom-out">
            <Icon name="zoom-out" size={16} />
          </button>
          <input
            type="range"
            className="trk-zoom-range"
            aria-label="Zoom"
            min={0}
            max={1}
            step={0.01}
            value={maxZoom > 1 ? Math.log(zoom) / Math.log(maxZoom) : 0}
            onChange={(e) => zoomBy(Math.pow(maxZoom, Number(e.target.value)) / zoom)}
          />
          <button className="trk-icon" aria-label="Zoom in" disabled={zoom >= maxZoom} onClick={() => zoomBy(1.5)} data-testid="track-zoom-in">
            <Icon name="zoom-in" size={16} />
          </button>
          <button className="trk-btn" disabled={zoom === 1} onClick={() => setZoom(1)} data-testid="track-fit">
            Fit
          </button>
        </div>
      </div>
      <div className="trk-body">
        <div className="trk-labels" aria-hidden>
          <span className="trk-label ruler" />
          {rows.map((r) =>
            r.show ? (
              <span key={r.key} className={`trk-label ${r.key}`}>
                <Icon name={r.icon} size={14} /> {r.label}
              </span>
            ) : null
          )}
        </div>
        <div className="trk-scroll" ref={scroller} onScroll={(e) => setView((v) => ({ ...v, left: e.currentTarget.scrollLeft }))}>
          {/* a press that no block took for itself (each stops its own) puts the playhead there and drops the pick */}
          <div
            className={`trk-content${drag ? ' dragging' : ''}`}
            style={{ width: contentW }}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              onPicture(null)
              scrub(e)
            }}
          >
            <div
              ref={ruler}
              className="trk-ruler"
              role="slider"
              tabIndex={0}
              aria-label="Time in your reel"
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              onPointerDown={scrub}
              onKeyDown={rulerKey}
              data-testid="track-ruler"
            >
              {ticks.map((t) => (
                <span key={t} className="trk-tick" style={{ left: x(t) }}>
                  {Number.isInteger(t) ? clock(t) : ''}
                </span>
              ))}
            </div>

            <div className="trk-row video" role="group" aria-label="Your video, its cuts" data-testid="track-video">
              {props.video && <Filmstrip src={props.video} duration={duration} pps={pps} left={view.left} width={view.width} />}
              {lanes.video.map((p, i) => {
                const trimming = drag?.kind === 'trim' && drag.part === i ? drag : null
                const t0 = trimming?.side === 'start' && trimming.stop ? trimming.stop.at : p.t0
                const t1 = trimming?.side === 'end' && trimming.stop ? trimming.stop.at : p.t1
                const trimmable = p.kind === 'speech' && !clipCut && !locked
                return (
                  <div
                    key={p.t0}
                    className={`trk-part ${p.kind}${trimming ? ' trimming' : ''}`}
                    style={{ left: x(t0), width: Math.max(2, x(t1) - x(t0)) }}
                    role="img"
                    aria-label={videoLabel(p, 1)}
                    data-testid="track-part"
                  >
                    {p.said && <span className="trk-part-said">{p.said}</span>}
                    {trimmable && (
                      <>
                        <span className="trk-edge start" onPointerDown={(e) => trim(e, i, 'start')} title="Drag to trim this cut" data-testid="track-trim-start" />
                        <span className="trk-edge end" onPointerDown={(e) => trim(e, i, 'end')} title="Drag to trim this cut" data-testid="track-trim-end" />
                      </>
                    )}
                  </div>
                )
              })}
              {lanes.joins.map((j) => (
                <span key={j.t} className="trk-cut" style={{ left: x(j.t) }} aria-hidden data-testid="track-cut" />
              ))}
              {lanes.struck.map(([a, b]) => (
                <span key={a} className="trk-struck" style={{ left: x(a), width: Math.max(2, x(b) - x(a)) }} title="Cut in the next version" data-testid="track-struck" />
              ))}
              {lanes.back.map((b) => (
                <span key={b.at} className="trk-back" style={{ left: x(b.at) }} title={`${b.n} ${b.n === 1 ? 'word' : 'words'} back in the next version`} data-testid="track-back">
                  +{b.n}
                </span>
              ))}
            </div>

            <div className="trk-row pictures" role="group" aria-label="Pictures" data-testid="track-pictures">
              {lanes.pictures.map((p) => {
                const b = brollById.get(p.id)
                const moving = drag?.kind === 'broll' && drag.id === p.id && drag.ghost ? drag.ghost : null
                const t0 = moving?.t0 ?? p.t0
                const t1 = moving?.t1 ?? p.t1
                const fixed = b ? brollFixed(b) : null
                const on = p.id === selectedPicture
                return (
                  <div
                    key={p.id}
                    className={`trk-pic kind-${p.kind}${on ? ' on' : ''}${moving ? ' moving' : ''}${p.skipped ? ' off' : ''}${fixed ? ' fixed' : ''}`}
                    style={{ left: x(t0), width: Math.max(4, x(t1) - x(t0)) }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={on}
                    aria-label={pictureLabel(p)}
                    title={fixed ?? undefined}
                    onPointerDown={(e) => pictureDrag(e, p, 'move')}
                    onKeyDown={(e) => e.key === 'Enter' && onPicture(on ? null : p.id)}
                    data-testid="track-picture"
                    data-id={p.id}
                  >
                    {p.thumb ? <img src={p.thumb} alt="" draggable={false} /> : <Icon name={p.kind === 'words' ? 'type' : p.kind === 'animation' ? 'sparkles' : 'image'} size={12} />}
                    <span className="trk-pic-what">{p.what}</span>
                    {!fixed && !locked && (
                      <>
                        <span className="trk-edge start" onPointerDown={(e) => pictureDrag(e, p, 'start')} data-testid="track-picture-start" />
                        <span className="trk-edge end" onPointerDown={(e) => pictureDrag(e, p, 'end')} data-testid="track-picture-end" />
                      </>
                    )}
                  </div>
                )
              })}
            </div>

            <div className="trk-row captions" role="group" aria-label="Subtitles" data-testid="track-captions">
              {lanes.captions.map((c) => (
                <CaptionBlock
                  key={c.id}
                  c={c}
                  left={x(c.t0)}
                  width={Math.max(4, x(c.t1) - x(c.t0))}
                  editing={editing === c.id}
                  locked={!!locked}
                  onOpen={() => {
                    setEditing(c.id)
                    if (transport.get().playing) transport.toggle()
                    transport.seek(c.t0 + 0.02)
                  }}
                  onDone={(typed) => {
                    setEditing(null)
                    if (typed !== null) send(captionGesture(draft.p, draft.kept, c.line, props.savedCorrections, typed, props.heard))
                  }}
                />
              ))}
            </div>

            <div className="trk-row music" role="group" aria-label="Song" data-testid="track-music">
              {lanes.music && (
                <SongBlock
                  song={lanes.music}
                  startAt={drag?.kind === 'song' ? drag.startAt : lanes.music.startAt}
                  width={x(duration)}
                  pps={pps}
                  duration={duration}
                  locked={!!locked}
                  onPointerDown={songDrag}
                />
              )}
            </div>

            {lanes.sounds.length > 0 && (
              <div className="trk-row sounds" role="group" aria-label="Sound effects" data-testid="track-sounds">
                {lanes.sounds.map((s) => (
                  <button
                    key={s.key}
                    className={`trk-sound${s.key === props.selectedSound ? ' on' : ''}${s.off ? ' off' : ''}`}
                    style={{ left: x(s.at) }}
                    aria-label={`${s.label.replace(' · ', ', ')}${s.off ? ", won't play" : ''}`}
                    aria-current={s.key === props.selectedSound || undefined}
                    title={s.label}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      props.onSound(s.key)
                      transport.seek(leadIn(s.at))
                    }}
                    data-testid="track-sound"
                  >
                    {s.kind}
                  </button>
                ))}
              </div>
            )}

            <div className="trk-head" ref={head} aria-hidden data-testid="track-playhead">
              <i />
            </div>
            {tip && (
              <span className="trk-tip" style={{ left: tipX(tip.at) }} data-testid="track-tip">
                {tip.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** What a drag will do, in words, at the time it is about. */
function dragTip(drag: Drag | null, said: (id: string) => string): { at: number; text: string } | null {
  if (!drag) return null
  if (drag.kind === 'trim' && drag.stop) {
    const s = drag.stop
    const n = s.cut.length || s.keep.length
    const what = s.cut.length ? `Cut ${n === 1 ? `“${said(s.cut[0])}”` : `${n} words`}` : s.keep.length ? `Bring back ${n === 1 ? `“${said(s.keep[0])}”` : `${n} words`}` : 'No change'
    return { at: s.at, text: what }
  }
  if (drag.kind === 'broll' && drag.ghost && drag.anchor) return { at: drag.ghost.t0, text: `On “${said(drag.anchor.from)}” · ${tenths(drag.ghost.t0)}` }
  if (drag.kind === 'song') return { at: 0, text: `Song from ${tenths(drag.startAt)}` }
  return null
}

function CaptionBlock({
  c,
  left,
  width,
  editing,
  locked,
  onOpen,
  onDone
}: {
  c: CaptionPart
  left: number
  width: number
  editing: boolean
  locked: boolean
  onOpen: () => void
  /** the typed line, or null when left as it was */
  onDone: (typed: string | null) => void
}) {
  const [text, setText] = useState(c.text)
  useEffect(() => setText(c.text), [c.text, editing])
  if (editing)
    return (
      <input
        className="trk-cap-input"
        style={{ left, minWidth: Math.max(width, 160) }}
        autoFocus
        value={text}
        aria-label="Subtitle line"
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onPointerDown={(e) => e.stopPropagation()}
        onBlur={() => onDone(text.trim() === c.text ? null : text)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            e.preventDefault()
            setText(c.text)
            onDone(null)
          }
        }}
        data-testid="track-caption-input"
      />
    )
  return (
    <div
      className="trk-cap"
      style={{ left, width }}
      role="button"
      tabIndex={0}
      aria-label={`Subtitle ${clock(c.t0)}: ${c.text}${locked ? '' : '. Press Enter to fix it.'}`}
      title={c.text}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => !locked && onOpen()}
      onKeyDown={(e) => e.key === 'Enter' && !locked && onOpen()}
      data-testid="track-caption"
    >
      {c.text}
    </div>
  )
}

function SongBlock({
  song,
  startAt,
  width,
  pps,
  duration,
  locked,
  onPointerDown
}: {
  song: NonNullable<TrackLanes['music']>
  startAt: number
  width: number
  pps: number
  duration: number
  locked: boolean
  onPointerDown: (e: React.PointerEvent) => void
}) {
  // a mark at each second of the song, so dragging it shows the song sliding under the reel
  const marks: number[] = []
  const every = pps >= 30 ? 1 : pps >= 8 ? 5 : 15
  for (let s = Math.ceil(startAt / every) * every; s - startAt <= duration; s += every) marks.push(s)
  return (
    <div
      className={`trk-song${locked ? ' fixed' : ''}`}
      style={{ width }}
      role="img"
      aria-label={`Song: ${song.name}, from ${tenths(startAt)} into it`}
      onPointerDown={onPointerDown}
      data-testid="track-song"
    >
      <span className="trk-fade in" style={{ width: song.fadeIn * pps }} />
      <span className="trk-fade out" style={{ width: song.fadeOut * pps }} />
      {marks.map((s) => (
        <span key={s} className={`trk-song-mark${s % (every * 5) === 0 ? ' big' : ''}`} style={{ left: (s - startAt) * pps }} />
      ))}
      <span className="trk-song-name">
        <Icon name="music" size={12} /> {song.name} · from {tenths(startAt)}
      </span>
    </div>
  )
}

