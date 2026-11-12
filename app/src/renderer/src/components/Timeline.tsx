import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PlacedWord } from '../../../shared/api'
import { clock } from '../../../shared/progress'
import { momentLabel } from '../../../shared/moments'
import { laneLayout, pictureLabel, videoLabel, type Lanes, type PictureKind, type PicturePart, type VideoPart } from '../../../shared/lanes'
import { leadIn } from '../../../shared/sfx'
import { Icon, type IconName } from './icons'
import { useFollowPlayhead, type Playhead } from './playhead'
import type { Transport } from './transport'

/** A version's note on the timeline (✓, plays that version), or a note still waiting or being made (yellow). */
export interface TimelineMark {
  id: string
  at: number
  /** the version it made; absent while it waits or runs */
  v?: number
  text: string
}

const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
// A press that moves less than this is a seek, more is a range. 4 px is the prototype's number.
const DRAG_PX = 4
// Shorter ranges are a click that wobbled.
const MIN_RANGE_S = 0.6
// Each mark is a 24 px target (WCAG 2.5.8); marks closer than that share one.
const MARK_PX = 24
// The first hover on your video waits this long before it names the part, so sweeping across the timeline to seek
// doesn't flash a tip; moving on to the next part then names it at once.
const VIDEO_TIP_MS = 300

/** Arrow keys, Home and End move between the buttons of one lane: each lane is one stop in the tab order. */
function rove(e: React.KeyboardEvent<HTMLElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(':scope > button')]
  const i = items.indexOf(document.activeElement as HTMLButtonElement)
  const to = ({ ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 } as Partial<Record<string, number>>)[e.key]
  if (i < 0 || to === undefined) return
  e.preventDefault()
  items[clamp(to, 0, items.length - 1)].focus()
}

/**
 * The timeline under the video, as wide as the stage, in three lanes on the version's clock:
 * - above, Pictures: a bar while each picture the editor laid over the video is on screen;
 * - on the rail, Your video: the kept speech, with a tick at each cut, and a clip from another video drawn thicker;
 * - below, Sound: a flag at each sound effect, and the song's fades.
 * On the rail too: a tick where each phrase starts, the notes that made versions and the notes still waiting.
 * Click to seek, drag the head to scrub, drag anywhere else for a range (the composer gets it). The arrows step a
 * second; with Shift they stretch a range from the playhead.
 *
 * The lanes sit beside the slider, not in it: a slider's children are presentational, so a screen reader never
 * reached marks inside it. Each lane is a named group, one stop in the tab order; its arrows move between items.
 */
export function Timeline({
  playhead,
  transport,
  duration,
  words,
  marks,
  onRange,
  onPlay,
  lanes = null,
  selectedSound = null,
  onSound,
  selectedPicture = null,
  onPicture
}: {
  playhead: Playhead
  transport: Transport
  duration: number
  words: PlacedWord[]
  marks: TimelineMark[]
  onRange: (r: { at: number; to: number }) => void
  onPlay: (v: number) => void
  /** the version's lanes; null until they are known (Edit it myself has its own timeline, TrackTimeline.tsx) */
  lanes?: Lanes | null
  selectedSound?: string | null
  onSound?: (key: string) => void
  selectedPicture?: string | null
  /** a picture picked on the timeline: Reel opens it in Edit it myself */
  onPicture?: (id: string) => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = track.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const fill = useRef<HTMLSpanElement>(null)
  const head = useRef<HTMLSpanElement>(null)
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null)
  const [lit, setLit] = useState<string | null>(null)
  const keyRange = useRef<{ at: number; to: number } | null>(null)
  // the item of each lane that takes the tab stop: the last one focused while it is still there, else the first
  const [stop, setStop] = useState<Record<string, string>>({})
  const stopAt = (lane: string, key: string, keys: string[]): 0 | -1 => ((keys.includes(stop[lane]) ? stop[lane] : keys[0]) === key ? 0 : -1)
  const focusIn = (lane: string, key: string): void => {
    setLit(key)
    setStop((s) => (s[lane] === key ? s : { ...s, [lane]: key }))
  }
  // what the pointer is over on the rail (a part of your video, by index) or the song's line, named after VIDEO_TIP_MS
  const [hoverPart, setHoverPart] = useState<number | 'song' | null>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  // what is under the pointer now, which the delayed tip names when it fires
  const hoverNow = useRef<number | 'song' | null>(null)
  useLayoutEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const follow = useCallback(
    (t: number) => {
      const f = duration ? clamp(t / duration, 0, 1) : 0
      fill.current?.style.setProperty('transform', `scaleX(${f})`)
      if (head.current) head.current.style.transform = `translateX(${f * 100}%)`
      track.current?.setAttribute('aria-valuenow', String(Math.round(t)))
      track.current?.setAttribute('aria-valuetext', clock(t))
    },
    [duration]
  )
  useFollowPlayhead(playhead, follow)

  // one tick per phrase: a word after a pause of 0.4 s or more
  const ticks = useMemo(() => {
    if (!duration) return ''
    let d = ''
    let prev = -Infinity
    for (const w of words) {
      if (w.s - prev >= 0.4 && w.s <= duration) d += `M${((w.s / duration) * 1000).toFixed(1)} 0V6`
      prev = w.e
    }
    return d
  }, [words, duration])

  const tAt = (x: number): number => {
    const b = track.current!.getBoundingClientRect()
    return clamp(((x - b.left) / b.width) * duration, 0, duration)
  }

  const down = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!duration || ev.button !== 0 || (ev.target as HTMLElement).closest('.tl-mark, .tl-sound, .tl-pic, .tl-gutter')) return
    clearHover()
    const el = ev.currentTarget
    el.setPointerCapture(ev.pointerId)
    const t0 = tAt(ev.clientX)
    const x0 = ev.clientX
    const wasPlaying = transport.get().playing
    let mode: 'press' | 'scrub' | 'range' = (ev.target as HTMLElement).closest('.tl-head') ? 'scrub' : 'press'
    if (mode === 'scrub' && wasPlaying) transport.toggle()
    const move = (e: PointerEvent) => {
      const t = tAt(e.clientX)
      if (mode === 'press' && Math.abs(e.clientX - x0) > DRAG_PX) {
        mode = 'range'
        if (transport.get().playing) transport.toggle()
      }
      if (mode === 'scrub') transport.seek(t)
      if (mode === 'range') {
        setSel({ a: Math.min(t0, t), b: Math.max(t0, t) })
        transport.seek(t)
      }
    }
    const stop = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
    }
    const cancel = () => {
      stop()
      setSel(null)
      if (mode === 'scrub' && wasPlaying) transport.toggle()
    }
    const up = (e: PointerEvent) => {
      stop()
      const t = tAt(e.clientX)
      setSel(null)
      if (mode === 'press') transport.seek(t)
      if (mode === 'range') {
        const a = Math.min(t0, t)
        const b = Math.max(t0, t)
        if (b - a >= MIN_RANGE_S) onRange({ at: Math.floor(a), to: Math.ceil(b) })
      }
      if (mode === 'scrub' && wasPlaying) transport.toggle()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
  }

  const video = lanes?.video ?? []
  const clearHover = (): void => {
    window.clearTimeout(hoverTimer.current)
    hoverTimer.current = undefined
    setHoverPart(null)
  }
  // the rail names the part of your video under the pointer, and the song's line names the song; the items above
  // and below have their own tips
  const hover = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!duration || ev.buttons || ev.pointerType !== 'mouse') return
    const b = track.current!.getBoundingClientRect()
    const y = ev.clientY - b.top
    const t = tAt(ev.clientX)
    const free = !(ev.target as HTMLElement).closest('.tl-mark, .tl-sound, .tl-pic, .tl-gutter')
    const part = free && y >= RAIL_BAND[0] && y <= RAIL_BAND[1] ? video.findIndex((p) => t >= p.t0 && t <= p.t1) : -1
    const i = part >= 0 ? part : free && lanes?.music && y >= SONG_BAND[0] && y <= SONG_BAND[1] ? 'song' : null
    if (i === null) return clearHover()
    hoverNow.current = i
    if (hoverPart !== null) return setHoverPart(i)
    if (hoverTimer.current === undefined) hoverTimer.current = window.setTimeout(() => setHoverPart(hoverNow.current), VIDEO_TIP_MS)
  }

  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      return transport.seek(e.key === 'Home' ? 0 : duration)
    }
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0
    if (!d) {
      if (e.key === 'Shift') keyRange.current = null
      return
    }
    e.preventDefault()
    if (!e.shiftKey) return transport.seek(clamp(playhead.get() + d, 0, duration))
    // the range grows either way from where Shift was first held with an arrow
    const r = keyRange.current ?? { at: Math.floor(playhead.get()), to: Math.floor(playhead.get()) }
    const to = clamp(r.to + d, 0, duration)
    keyRange.current = { at: r.at, to }
    transport.seek(to)
    if (to !== r.at) onRange({ at: Math.min(r.at, to), to: Math.max(r.at, to) })
  }

  const pct = (t: number): string => `${(clamp(t, 0, duration) / (duration || 1)) * 100}%`
  const groups = markGroups(marks, duration, width)
  const sounds = lanes ? markGroups(lanes.sounds, duration, width) : []
  const pictures = lanes?.pictures ?? []
  const bars = useMemo(() => laneLayout(pictures, duration, width), [pictures, duration, width])
  const videos = Math.max(1, ...video.map((p) => p.video))
  const litPart = video.find((p) => lit === `v${p.t0}`)
  const pictureKeys = pictures.map((p) => p.id)
  const videoKeys = video.map((p) => `v${p.t0}`)
  const soundKeys = sounds.map((g) => g.items[0].key)
  const tipSide = (at: number): string => (at / duration < 0.2 ? ' start' : at / duration > 0.8 ? ' end' : '')
  // the song's loudness under the flags: it rises over its fade-in, holds, and falls over its fade-out. A fade is drawn
  // at least FADE_PX wide, so a short one on a long reel still slopes.
  const song = (() => {
    if (!lanes?.music || !duration || !width) return null
    const min = FADE_PX / width
    const fi = (Math.min(Math.max(lanes.music.fadeIn / duration, min), 0.5) * 1000).toFixed(1)
    const fo = (1000 - Math.min(Math.max(lanes.music.fadeOut / duration, min), 0.5) * 1000).toFixed(1)
    return `M0 9L${fi} 1H${fo}L1000 9`
  })()
  // a sound's kind word sits beside its flag where it fits before the next one
  const soundWords = sounds.map(({ at, items }, i) => {
    const word = items.length > 1 ? `${items.length} sounds` : items[0].kind
    const next = sounds[i + 1]
    const room = ((next ? next.at : duration) - at) / (duration || 1) * width - WORD_GAP
    return room >= textWidth(word) ? word : null
  })
  const laneFull = { pictures: pictures.length > 0, video: video.length > 0, sound: sounds.length > 0 || !!lanes?.music }
  return (
    <div className="tl" onPointerDown={down} onPointerMove={hover} onPointerLeave={clearHover}>
      {/* a lane's icon only beside a lane with something on it: three icons by one drawn lane read as a puzzle. Each
          keeps its own row (reel.css), so nothing moves when a lane fills. The rail is always your video, so its icon
          always shows: the gutter is never empty, and the rail never looks indented from the phone above it. */}
      <span className="tl-gutter" aria-hidden data-testid="lane-gutter">
        {laneFull.pictures && (
          <span className="tl-lane-icon pics" title="Pictures">
            <Icon name="image" size={16} stroke={1.5} />
          </span>
        )}
        <span className="tl-lane-icon video" title="Your video">
          <Icon name="film" size={16} stroke={1.5} />
        </span>
        {laneFull.sound && (
          <span className="tl-lane-icon sound" title="Sound">
            <Icon name="music" size={16} stroke={1.5} />
          </span>
        )}
      </span>
      <div
        ref={track}
        className="tl-track"
        role="slider"
        tabIndex={0}
        aria-label="Time in your reel. Drag to mark a range; Shift and the arrow keys do the same."
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        onKeyDown={key}
        data-testid="timeline"
      >
        <svg className="tl-ticks" viewBox="0 0 1000 6" preserveAspectRatio="none" aria-hidden>
          <path d={ticks} />
        </svg>
        <span className="tl-rail" aria-hidden />
        {duration > 0 &&
          video.map((p) =>
            p.kind === 'clip' ? <span key={p.t0} className="tl-clip" style={{ left: pct(p.t0), width: `calc(${pct(p.t1)} - ${pct(p.t0)})` }} aria-hidden data-testid="timeline-clip" /> : null
          )}
        <span className="tl-fill" ref={fill} aria-hidden />
        {song && (
          <svg className="tl-music" viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden data-testid="timeline-music">
            <path d={song} />
          </svg>
        )}
        {duration > 0 &&
          lanes?.joins.map(({ t, bridge }) => (
            <span key={t} className="tl-join" style={{ left: pct(t) }} aria-hidden data-testid="timeline-join" data-bridge={bridge?.kind}>
              {bridge && <i className={bridge.kind} style={{ width: `max(6px, ${(bridge.seconds / duration) * (width || 0)}px)` }} />}
            </span>
          ))}
        {sel && (
          <>
            <span className="tl-sel" style={{ left: pct(sel.a), width: `calc(${pct(sel.b)} - ${pct(sel.a)})` }} aria-hidden />
            <span className="tl-tip dark" style={{ left: pct(sel.b) }} aria-hidden>
              {momentLabel({ at: Math.floor(sel.a), to: Math.ceil(sel.b) })}
            </span>
          </>
        )}
        <span className="tl-heads" aria-hidden>
          <span className="tl-head" ref={head}>
            <i />
          </span>
        </span>
        {typeof hoverPart === 'number' && video[hoverPart] && !sel && <VideoTip part={video[hoverPart]} videos={videos} side={tipSide(mid(video[hoverPart]))} left={pct(mid(video[hoverPart]))} />}
        {hoverPart === 'song' && lanes?.music && !sel && <SongTip fadeIn={lanes.music.fadeIn} fadeOut={lanes.music.fadeOut} />}
      </div>
      {duration > 0 && groups.length > 0 && (
        <div className="tl-marks" role="group" aria-label="Notes on the timeline">
          {groups.map(({ at, items }) => {
            const id = items[0].id
            const v = Math.max(0, ...items.map((m) => m.v ?? 0))
            return (
              <button
                key={id}
                className={`tl-mark${v ? ' made' : ' waiting'}`}
                style={{ left: pct(at) }}
                aria-label={markLabel(items)}
                onPointerEnter={() => setLit(id)}
                onPointerLeave={() => setLit(null)}
                onFocus={() => setLit(id)}
                onBlur={() => setLit(null)}
                onClick={() => (v ? onPlay(v) : transport.seek(at))}
                data-testid="timeline-mark"
              >
                {v ? <Icon name="check" size={10} stroke={3} /> : null}
                {items.length > 1 && <span className="n">{items.length}</span>}
                {lit === id && (
                  <span className={`tl-tip${tipSide(at)}`}>
                    {items.map((m) => (
                      <span key={m.id}>
                        <b>{m.v ? `Version ${m.v}` : 'Waiting'}</b> {m.text}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      {duration > 0 && bars.length > 0 && (
        <div className="tl-lane tl-pics" role="group" aria-label="Pictures on the timeline" onKeyDown={rove}>
          {pictures.map((p, i) => {
            const bar = bars[i]
            const on = p.id === selectedPicture
            return (
              <button
                key={p.id}
                className={`tl-pic${on ? ' on' : ''}${p.skipped ? ' off' : ''}`}
                style={{ left: bar.hitX, width: bar.hitW }}
                tabIndex={stopAt('pictures', p.id, pictureKeys)}
                aria-label={pictureLabel(p)}
                aria-current={on || undefined}
                onPointerEnter={() => setLit(p.id)}
                onPointerLeave={() => setLit(null)}
                onFocus={() => focusIn('pictures', p.id)}
                onBlur={() => setLit(null)}
                onClick={() => {
                  // on the picture, not before it, so a paused player shows it
                  transport.seek(p.t0 + Math.min(0.5, (p.t1 - p.t0) / 2))
                  onPicture?.(p.id)
                }}
                data-testid="timeline-picture"
              >
                {bar.thumb && (
                  <span className="tl-thumb" style={{ left: bar.x - bar.hitX }} data-testid="timeline-thumb">
                    {p.thumb ? <img src={p.thumb} alt="" draggable={false} /> : <Icon name={GLYPHS[p.kind]} size={12} stroke={1.75} />}
                  </span>
                )}
                {(!bar.thumb || bar.w > THUMB_W + THUMB_GAP) && (
                  <i style={bar.thumb ? { left: bar.x - bar.hitX + THUMB_W + THUMB_GAP, width: bar.w - THUMB_W - THUMB_GAP } : { left: bar.x - bar.hitX, width: bar.w }} />
                )}
                {lit === p.id && <PictureTip part={p} side={tipSide(p.t0)} />}
              </button>
            )
          })}
        </div>
      )}
      {duration > 0 && video.length > 0 && (
        <div className="tl-lane tl-video" role="group" aria-label="Your video on the timeline" onKeyDown={rove}>
          {video.map((p) => {
            const k = `v${p.t0}`
            return (
              <button
                key={k}
                className="tl-part"
                style={{ left: pct(p.t0), width: `calc(${pct(p.t1)} - ${pct(p.t0)})` }}
                tabIndex={stopAt('video', k, videoKeys)}
                aria-label={videoLabel(p, videos)}
                onFocus={() => focusIn('video', k)}
                onBlur={() => setLit(null)}
                onClick={() => transport.seek(p.t0)}
                data-testid="timeline-part"
              />
            )
          })}
          {litPart && (
            <span className="tl-part-ring" style={{ left: pct(litPart.t0), width: `calc(${pct(litPart.t1)} - ${pct(litPart.t0)})` }} aria-hidden>
              <VideoTip part={litPart} videos={videos} side={tipSide(mid(litPart))} />
            </span>
          )}
        </div>
      )}
      {duration > 0 && sounds.length > 0 && (
        <div className="tl-lane tl-sounds" role="group" aria-label="Sound effects on the timeline" onKeyDown={rove}>
          {sounds.map(({ at, items }, i) => {
            const key = items[0].key
            const word = soundWords[i]
            const on = items.some((m) => m.key === selectedSound)
            const off = items.every((m) => m.off)
            return (
              <button
                key={key}
                className={`tl-sound${on ? ' on' : ''}${off ? ' off' : ''}`}
                style={{ left: pct(at) }}
                aria-label={items.map((m) => `${m.label.replace(' · ', ', ')}${m.off ? ", won't play" : ''}`).join('; ')}
                aria-current={on || undefined}
                tabIndex={stopAt('sounds', key, soundKeys)}
                onPointerEnter={() => setLit(key)}
                onPointerLeave={() => setLit(null)}
                onFocus={() => focusIn('sounds', key)}
                onBlur={() => setLit(null)}
                onClick={() => {
                  onSound?.(on ? selectedSound! : key)
                  transport.seek(leadIn(at))
                }}
                data-testid="timeline-sound"
              >
                <svg viewBox="0 0 10 12" aria-hidden>
                  <path d="M5 1l4 4v5.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5V5z" />
                </svg>
                {word && (
                  <span className="tl-sound-word" aria-hidden>
                    {word}
                  </span>
                )}
                {lit === key && (
                  <span className={`tl-tip below${tipSide(at)}`}>
                    {items.map((m) => {
                      const [what, why] = m.label.split(' · ')
                      return (
                        <span key={m.key}>
                          <b>{what}</b> {why}
                          {m.off && " · won't play"}
                        </span>
                      )
                    })}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      {duration > 0 && lanes?.music && (
        <div className="tl-lane tl-songs" role="group" aria-label="Song on the timeline">
          <button
            className="tl-song"
            aria-label={`Song: fades in over ${secs(lanes.music.fadeIn)}, out over ${secs(lanes.music.fadeOut)}`}
            onFocus={() => setLit('song')}
            onBlur={() => setLit(null)}
            onClick={() => transport.seek(0)}
            data-testid="timeline-song"
          />
          {lit === 'song' && (
            <span className="tl-song-ring" aria-hidden>
              <SongTip fadeIn={lanes.music.fadeIn} fadeOut={lanes.music.fadeOut} />
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function SongTip({ fadeIn, fadeOut }: { fadeIn: number; fadeOut: number }) {
  return (
    <span className="tl-tip start song" aria-hidden data-testid="timeline-song-tip">
      <span>
        <b>Song</b> fades in over {secs(fadeIn)}, out over {secs(fadeOut)}
      </span>
    </span>
  )
}

/** Marks closer than one target's width share it; the target plays the newest version among them. */
export function markGroups<T extends { at: number }>(marks: T[], duration: number, width: number): { at: number; items: T[] }[] {
  const groups: { at: number; items: T[] }[] = []
  for (const m of [...marks].sort((a, b) => a.at - b.at)) {
    const last = groups[groups.length - 1]
    if (last && duration && width && ((m.at - last.at) / duration) * width < MARK_PX) last.items.push(m)
    else groups.push({ at: m.at, items: [m] })
  }
  return groups
}

/** What a screen reader hears on a mark: what each note there made, or that it waits, and when. */
export function markLabel(items: TimelineMark[]): string {
  return items.map((m) => (m.v ? `Version ${m.v}, at ${clock(m.at)}: ${m.text}` : `Waiting, at ${clock(m.at)}: ${m.text}`)).join('; ')
}

// Where the rail is in the track (reel.css .tl-rail and .tl-clip), give or take a few pixels: a hover there names
// the part of your video under it.
const RAIL_BAND = [22, 38] as const
// The song's line under the flags (reel.css .tl-music), the same way.
const SONG_BAND = [46, 60] as const
const FADE_PX = 6
// A sound's button starts 12 px left of its moment and holds 21 px before its word and 4 after, so with a word it
// ends at moment + word + 13 px; the next one starts 12 px before its own moment. A word shows only when that fits.
const WORD_GAP = 25
// A picture's thumbnail, then paper before the rest of its bar (shared/lanes.ts THUMB_MIN is their sum).
const THUMB_W = 16
const THUMB_GAP = 4
const GLYPHS: Record<PictureKind, IconName> = { picture: 'image', clip: 'video', words: 'type', animation: 'sparkles', wall: 'layers' }
const secs = (s: number): string => `${Number(s.toFixed(1))} s`

// Measured once per word in the timeline's own type (reel.css .tl-sound-word), so a word is shown only where it fits.
const widths = new Map<string, number>()
let measure: CanvasRenderingContext2D | null = null
function textWidth(word: string): number {
  const known = widths.get(word)
  if (known !== undefined) return known
  measure ??= document.createElement('canvas').getContext('2d')
  if (!measure) return Infinity
  measure.font = `600 11px ${getComputedStyle(document.documentElement).getPropertyValue('--font-ui') || 'sans-serif'}`
  const w = measure.measureText(word).width
  widths.set(word, w)
  return w
}
const mid = (p: { t0: number; t1: number }): number => (p.t0 + p.t1) / 2

function VideoTip({ part, videos, side, left }: { part: VideoPart; videos: number; side: string; left?: string }) {
  const name = part.kind === 'clip' ? `Video ${part.video}, played whole` : videos > 1 ? `Your video ${part.video}` : 'Your video'
  return (
    <span className={`tl-tip${side}`} style={left === undefined ? undefined : { left }} aria-hidden data-testid="timeline-part-tip">
      <span>
        <b>{name}</b> <span className="tnum">{clock(part.t0)}–{clock(part.t1)}</span>
      </span>
      {part.said && <span>“{part.said}”</span>}
    </span>
  )
}

function PictureTip({ part, side }: { part: PicturePart; side: string }) {
  return (
    <span className={`tl-tip${side}`}>
      <span>
        <b>{part.what}</b> <span className="tnum">{clock(part.t0)}–{clock(part.t1)}</span>
      </span>
      {part.line && <span>For “{part.line}”</span>}
      {part.why && <span>{part.why}</span>}
      {part.skipped && <span className="warn">Left out: {part.skipped}</span>}
    </span>
  )
}
