import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { clock } from '../../../shared/progress'
import { BOX_PAD, SIZE_PER_EM, type Measure } from '../../../shared/caption-fit'
import { fitLook, type SubtitleLook } from '../../../shared/caption-presets'
import { groupMarks, type NoteMark } from '../../../shared/moments'
import { Icon } from './icons'
import { reel } from '../api'
import { FOLDER_APP } from './ui'
import { createPlayhead, followVideo, useFollowPlayhead, type Playhead } from './playhead'
import { NO_LAYERS, layersReducer, type Layer } from './videoLayers'
import { RATES, rateLabel, savedRate, stepRate, type Transport } from './transport'
import { InstagramChrome, PhoneFill, SafeBand, shapeVars } from './Phone'
import { announce } from './announce'
import type { PhoneView } from '../../../shared/api'
import { place, type Shape } from '../../../shared/phone-shapes'
import { PLAYER as PLAYER_TIMING } from '../../../shared/perf-marks'

/**
 * While our own reel is being dragged out, the window must not treat it as a new video dropped in.
 * Cleared on the next drop or once the mouse moves with no button held.
 */
export function markDraggingOut(): void {
  ;(window as { __rsDraggingOut?: boolean }).__rsDraggingOut = true
  const clear = (e: PointerEvent) => {
    if (e.buttons) return
    ;(window as { __rsDraggingOut?: boolean }).__rsDraggingOut = false
    window.removeEventListener('pointermove', clear)
  }
  window.addEventListener('pointermove', clear)
}
export const draggingOut = (): boolean => !!(window as { __rsDraggingOut?: boolean }).__rsDraggingOut

const ENGINE_WIDTH = 1080
const SUB_FONT = "'Reel Subtitles'"
let subFontReady = false
const subFontLoad = document.fonts.load(`600 16px ${SUB_FONT}`).then(() => {
  subFontReady = true
})

/** Widths come from the subtitle face, so the line breaks wait until it has loaded (it loads once). */
function useSubtitleFont(): boolean {
  const [ready, setReady] = useState(subFontReady)
  useEffect(() => {
    if (!ready) void subFontLoad.then(() => setReady(true))
  }, [ready])
  return ready
}

let measureCtx: CanvasRenderingContext2D | null = null
/** The engine's Measurer.width, in the browser: the face at ASS size `size`, plus the outline on both sides. */
const measure: Measure = (text, size, outline) => {
  measureCtx ??= document.createElement('canvas').getContext('2d')!
  measureCtx.font = `600 ${size / SIZE_PER_EM}px ${SUB_FONT}`
  return measureCtx.measureText(text).width + 2 * outline
}

/**
 * The engine's subtitle look drawn in CSS at the size of `width` (the preview's width in px), with the lines
 * broken where the engine breaks them (shared/caption-fit.ts), so a word is never split. The sample shows the
 * moment its first word is spoken, so a highlight lights that word.
 */
export function SubtitleSample({ look, text, width, testid }: { look: SubtitleLook; text: string; width: number; testid?: string }) {
  const fontReady = useSubtitleFont()
  const k = width / ENGINE_WIDTH
  const fit = fitLook(look, text, measure)
  const style: React.CSSProperties = {
    // on a phone shape the reel's box is not the screen's (Phone.tsx shapeVars): place it in the reel
    top: `calc(var(--reel-t, 0%) + ${look.position} * var(--reel-h, 100%))`,
    fontSize: (fit.size / SIZE_PER_EM) * k,
    lineHeight: SIZE_PER_EM,
    color: look.color,
    visibility: fontReady ? undefined : 'hidden'
  }
  if (look.box) {
    // libass draws the box as the outline: that much padding all round each line.
    Object.assign(style, { background: look.outlineColor, padding: Math.max(look.outline, BOX_PAD) * k })
  } else {
    // Stroke is centred on the glyph edge, so twice the engine's outline, painted under the fill.
    Object.assign(style, { WebkitTextStroke: `${Math.max(0.6, look.outline * k) * 2}px ${look.outlineColor}`, paintOrder: 'stroke fill' })
  }
  return (
    <div className={`sub-sample${look.pop ? ' pops-in' : ''}`} style={style} data-testid={testid} data-lines={fit.lines.length} aria-hidden>
      {fit.lines.map((line, i) => {
        if (!look.highlight || i > 0) return <span key={i}>{line}</span>
        const [first, ...rest] = line.split(' ')
        return (
          <span key={i}>
            <span style={{ color: look.highlight }}>{first}</span>
            {rest.length ? ` ${rest.join(' ')}` : ''}
          </span>
        )
      })}
    </div>
  )
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(300)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [ref])
  return w
}

/** Lets go of the decoder and the open file now. Chromium otherwise holds both until the element is garbage collected. */
function release(v: HTMLVideoElement): void {
  v.pause()
  v.removeAttribute('src')
  v.load()
}

/** A <video> that releases its decoder when it leaves the page. `el` hears it arrive and leave. */
function Video({ el, ...props }: ComponentProps<'video'> & { el?: (v: HTMLVideoElement | null) => void }) {
  const own = useRef<HTMLVideoElement>(null)
  const onEl = useRef(el)
  onEl.current = el
  useLayoutEffect(() => {
    const v = own.current!
    // StrictMode's rehearsal unmount released it in development: give it its source back
    if (props.src && !v.hasAttribute('src')) v.src = props.src
    onEl.current?.(v)
    return () => {
      onEl.current?.(null)
      release(v)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per element; a new source is a new element
  }, [])
  return <video ref={own} {...props} />
}

/**
 * Resolves when a loaded, still hidden video can show a frame: its cover decoded, and its next frame
 * presented where Chromium reports frames. The wait is capped because a paused video showing its
 * cover presents no frame. The 100 ms cap is a guess with no measurement behind it.
 */
function frameReady(v: HTMLVideoElement, poster: string | null): Promise<void> {
  const frame = new Promise<void>((done) => {
    window.setTimeout(done, 100)
    if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(() => done())
    else requestAnimationFrame(() => done())
  })
  if (!poster) return frame
  return Promise.all([frame, decodedCover(poster)]).then(() => {})
}

/**
 * Each cover is decoded once. A full-size cover is about 8 MiB of pixels, and a new Image().decode() per version
 * switch kept about 2 MiB more each time (notes/perf/player-audit.md finding 2). The images stay referenced so
 * their decoded pixels can be reused; the oldest is dropped past COVERS_KEPT.
 */
const covers = new Map<string, { img: HTMLImageElement; ready: Promise<void> }>()
const COVERS_KEPT = 8
function decodedCover(url: string): Promise<void> {
  const hit = covers.get(url)
  if (hit) {
    covers.delete(url)
    covers.set(url, hit)
    return hit.ready
  }
  const img = new Image()
  img.src = url
  const ready = img.decode().catch(() => {})
  covers.set(url, { img, ready })
  if (covers.size > COVERS_KEPT) covers.delete(covers.keys().next().value!)
  return ready
}

// Matches the opacity transition on .phone-screen > video.layer.
const FADE_MS = 140

/**
 * Follows the playhead by writing to its own input, so playing the video renders nothing. A write restyles,
 * lays out and repaints the bar, so it happens only when the thumb would move at least one device pixel.
 */
export function ScrubRange({ playhead, dur, onSeek }: { playhead: Playhead; dur: number; onSeek: (seconds: number) => void }) {
  const input = useRef<HTMLInputElement>(null)
  const width = useRef(0)
  const lastPx = useRef<number | null>(null)
  const write = useCallback(
    (t: number) => {
      const el = input.current
      if (!el) return
      const frac = dur ? Math.min(1, Math.max(0, t / dur)) : 0
      const px = Math.round(frac * width.current * window.devicePixelRatio)
      if (px === lastPx.current) return
      lastPx.current = px
      el.value = String(Math.min(t, dur || 1))
      el.style.setProperty('--pct', `${frac * 100}%`)
    },
    [dur]
  )
  // a new length or a new width moves every pixel: the next write always lands
  useLayoutEffect(() => {
    lastPx.current = null
    const el = input.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      width.current = el.clientWidth
      lastPx.current = null
      write(playhead.get())
    })
    ro.observe(el)
    width.current = el.clientWidth
    return () => ro.disconnect()
  }, [write, playhead])
  useFollowPlayhead(playhead, write)
  return (
    <input
      ref={input}
      type="range"
      min={0}
      max={dur || 1}
      step={0.01}
      defaultValue={0}
      aria-label="Position in the reel"
      aria-keyshortcuts="ArrowLeft ArrowRight"
      onChange={(e) => onSeek(Number(e.target.value))}
      // a second a press, as on the player; the range's own step would move 0.01 s
      onKeyDown={(e) => {
        if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.metaKey || e.ctrlKey || e.altKey) return
        e.preventDefault()
        e.stopPropagation()
        onSeek(Math.max(0, Math.min(dur || 0, playhead.get() + (e.key === 'ArrowLeft' ? -1 : 1))))
      }}
    />
  )
}

/** Time left. Written to its own span when the shown second changes, without rendering. */
function ScrubTime({ playhead, dur }: { playhead: Playhead; dur: number }) {
  const span = useRef<HTMLSpanElement>(null)
  const write = useCallback(
    (t: number) => {
      const text = clock(dur ? dur - t : 0)
      if (span.current && span.current.textContent !== text) span.current.textContent = text
    },
    [dur]
  )
  useFollowPlayhead(playhead, write)
  return <span className="scrub-time" ref={span} />
}

const RATE_KEY = 'rs.speed'

const MARK_STATE: Record<NoteMark['state'], string> = { making: 'Being made', done: 'Done', failed: "Didn't work", stopped: 'Stopped', paused: 'Paused' }

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || el.tagName === 'BUTTON')
}
/** Somewhere text goes: a key there is a character, not a shortcut. A button or the scrub bar is not. */
export const textField = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || (el instanceof HTMLInputElement && el.type !== 'range'))
}

/**
 * The phone-shaped player: a cover frame until you press play, one big play button and a thin
 * scrub bar instead of the browser's controls (no download, speed or picture-in-picture menu).
 * Space plays and pauses (when you are not typing). With the player or its controls focused, the left
 * and right arrows skip 1 s.
 */
export function PhonePlayer({
  src,
  poster,
  autoPlayMuted,
  playRequest,
  onPlayRequestHandled,
  subtitle,
  view,
  caption,
  original,
  originalAt,
  originalReady = true,
  warmOriginal,
  holdingOriginal,
  still,
  stillMirrored,
  onDuration,
  dragFile,
  marks,
  asking,
  playhead,
  onShown,
  onFailed,
  keepTime,
  bare,
  transport,
  onHold,
  className,
  change,
  over,
  testid = 'player',
  shape,
  children
}: {
  src: string | null
  poster?: string | null
  /** A version arriving on screen starts playing, muted, with a "Turn on sound" chip. */
  autoPlayMuted?: boolean
  /** Each new number starts playing, with sound (the person just picked this version). */
  playRequest?: number
  /** Called once a play request has started, so the caller can drop it. */
  onPlayRequestHandled?: () => void
  /** Live preview of the subtitle style (the drawer). */
  subtitle?: { look: SubtitleLook; text: string } | null
  /** Instagram's Reels screen over the reel, or the reel alone. */
  view: PhoneView
  /** The post's caption, on Instagram's caption line. */
  caption?: string
  /** The raw footage, shown while "Original" is held down. */
  original?: string | null
  /** Where Hold for original starts for the reel's `seconds`: a take and the time in it, 'start' for the first take
   * from 0:00 (labeled so), or null when it cannot be found. Without it, the first take from 0:00. */
  originalAt?: (seconds: number) => { src: string; at: number } | 'start' | null
  /** False while what `originalAt` needs is still loading: a hold waits, saying so, instead of guessing. */
  originalReady?: boolean
  /** The pointer or focus is on the hold button: load the raw footage now, so the hold is instant. */
  warmOriginal?: boolean
  holdingOriginal?: boolean
  /** A still frame (the raw take, no subtitles burned in) under the subtitle preview. */
  still?: string | null
  /** The take is mirrored and the video flips it: show the still flipped too, so it matches. */
  stillMirrored?: boolean
  onDuration?: (seconds: number) => void
  /** The file on disk: drag the phone out of the window to put the reel on the desktop or in an upload box. */
  dragFile?: string | null
  /** Notes asked at a moment (the change button), drawn on the scrub bar. */
  marks?: NoteMark[]
  /** A change is being asked for at the playhead: hold the frame there and keep the scrub bar in sight. */
  asking?: boolean
  /** Where the video is, for whoever else shows it. The player keeps its own when not given. */
  playhead?: Playhead
  /** The source actually on screen. A new `src` plays only once it has loaded, so this lags it during a switch. */
  onShown?: (src: string | null) => void
  /** A new `src` would not play. The video before it stays on screen and stays the one reported. */
  onFailed?: () => void
  /** A new `src` takes over at the same moment and keeps playing (comparing two versions). */
  keepTime?: boolean
  /** No play button or scrub row on the picture: `transport` drives it from outside. */
  bare?: boolean
  transport?: Transport
  /** Pressing and holding the picture (a click still plays and pauses): show the original while it is held. */
  onHold?: (holding: boolean) => void
  className?: string
  /** Drawn on the reel under Instagram's screen, as the video is (a change's pictures before its draft, ChangeMoments). */
  change?: ReactNode
  /** Drawn on the screen over the reel and Instagram's screen (the compare switch). */
  over?: ReactNode
  /** The video's test id. The Working screen's first look uses its own, so "player" means the Reel screen. */
  testid?: string
  /** A real phone's screen to show the reel on, as Instagram would place it there. Without it, the reel's own frame. */
  shape?: Shape
  children?: ReactNode
}) {
  const screenRef = useRef<HTMLDivElement>(null)
  // the video on screen; a new source loads invisible over it and fades in once it has a frame
  const video = useRef<HTMLVideoElement | null>(null)
  const raw = useRef<HTMLVideoElement | null>(null)
  const els = useRef(new Map<number, HTMLVideoElement>())
  const [layers, dispatch] = useReducer(layersReducer, null, () => layersReducer(NO_LAYERS, { type: 'want', src, poster: poster ?? null }))
  const [ownPlayhead] = useState(createPlayhead)
  const ph = playhead ?? ownPlayhead
  const width = useWidth(screenRef)
  // the reel's own width: wider than the screen where a phone shape trims its sides
  const reelWidth = shape ? (width * place(shape).reel.w) / shape.w : width
  const trackRef = useRef<HTMLSpanElement>(null)
  const trackWidth = useWidth(trackRef)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(!!autoPlayMuted)
  const [dur, setDur] = useState(0)
  const [started, setStarted] = useState(false)
  const dragOrigin = useRef<EventTarget | null>(null)
  const [rate, setRateState] = useState(() => savedRate(localStorage.getItem(RATE_KEY)))
  const setRate = useCallback((r: number) => {
    localStorage.setItem(RATE_KEY, String(r))
    setRateState(r)
  }, [])

  const toggle = useCallback(() => {
    const v = video.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }, [])

  const seek = useCallback(
    (seconds: number) => {
      const v = video.current
      if (!v) return
      v.currentTime = Math.max(0, Math.min(seconds, v.duration || seconds))
      ph.set(v.currentTime)
    },
    [ph]
  )

  // < and > step the speed down and up, as in YouTube; they are Shift with comma and period, so they never
  // collide with Cmd+, (Settings) or the Reel screen's letter keys.
  const rateNow = useRef(rate)
  rateNow.current = rate
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // defaultPrevented: the player's own keys already took it
      if (e.defaultPrevented || document.querySelector('.modal-backdrop')) return
      if (e.code === 'Space' && !typing(e.target)) {
        e.preventDefault()
        toggle()
      } else if ((e.key === '<' || e.key === '>') && !e.metaKey && !e.ctrlKey && !e.altKey && !textField(e.target)) {
        e.preventDefault()
        const next = stepRate(rateNow.current, e.key === '>' ? 1 : -1)
        setRate(next)
        announce(`Speed ${rateLabel(next)}`)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [toggle, setRate])

  // Keys while the player or one of its controls has focus: Space (buttons keep it for themselves) and the
  // arrows, which on the scrub bar would otherwise move 0.01 s. The version chips sit outside the player.
  const onKey = (e: React.KeyboardEvent) => {
    const v = video.current
    const el = e.target as HTMLElement
    const field = el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== 'range')
    if (!v || field || holdingOriginal || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === ' ' && el.tagName !== 'BUTTON') {
      if (!e.repeat) toggle()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') seek(v.currentTime + (e.key === 'ArrowLeft' ? -1 : 1))
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  useEffect(() => {
    dispatch({ type: 'want', src, poster: poster ?? null })
  }, [src, poster])

  // A new video took the screen: start it over like a fresh player, and let the old one fade out under it.
  const shownId = layers.shown?.id ?? 0
  const firstShown = useRef(true)
  useLayoutEffect(() => {
    const v = (video.current = layers.shown ? (els.current.get(layers.shown.id) ?? null) : null)
    onShown?.(layers.shown?.src ?? null)
    const before = layers.leaving ? els.current.get(layers.leaving.id) : undefined
    const wasPlaying = !!before && !before.paused
    before?.pause()
    if (!v) return
    applyRate(v, rate)
    if (keepTime && before) {
      // the old layer kept playing while this one loaded at the moment it started from: catch up to where it is
      if (Math.abs(v.currentTime - before.currentTime) > 0.05) v.currentTime = before.currentTime
      v.muted = before.muted
      if (wasPlaying) void v.play().catch(() => {})
      return
    }
    ph.set(v.currentTime)
    if (v.readyState >= HTMLMediaElement.HAVE_METADATA) {
      setDur(v.duration || 0)
      onDuration?.(v.duration || 0)
    }
    if (firstShown.current) {
      firstShown.current = false
      return
    }
    setPlaying(false)
    setStarted(false)
    setMuted(!!autoPlayMuted)
    v.muted = !!autoPlayMuted
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a different video takes the screen
  }, [shownId])

  const leavingId = layers.leaving?.id
  useEffect(() => {
    if (!leavingId) return
    const timer = window.setTimeout(() => dispatch({ type: 'gone', id: leavingId }), FADE_MS + 60)
    return () => window.clearTimeout(timer)
  }, [leavingId])

  useEffect(() => {
    if (!autoPlayMuted || !video.current) return
    video.current.muted = true
    void video.current.play().catch(() => {})
  }, [autoPlayMuted, shownId])

  // While playing, move the playhead with each presented video frame (timeupdate fires only about four times a second).
  useEffect(() => {
    const v = video.current
    if (!playing || !v) return
    return followVideo(() => v, ph)
  }, [playing, shownId, ph])

  useEffect(() => {
    if (asking) video.current?.pause()
  }, [asking])

  useEffect(() => {
    if (video.current) applyRate(video.current, rate)
    if (raw.current) applyRate(raw.current, rate)
  }, [rate, shownId])
  // the speed button on a player with its own controls goes round the speeds
  const nextRate = () => setRate(RATES[(RATES.findIndex((r) => r === rate) + 1) % RATES.length])
  useEffect(() => transport?.attach({ toggle, seek, setRate }), [transport, toggle, seek, setRate])
  useEffect(() => transport?.report({ playing, duration: dur, rate }), [transport, playing, dur, rate])

  // Press and hold the picture for the original. 250 ms tells a hold from a click (no measurement behind it:
  // about when a press stops feeling like a tap); the click that ends a hold does not also play or pause.
  const holdTimer = useRef(0)
  const held = useRef(false)
  const holdOff = () => {
    window.clearTimeout(holdTimer.current)
    if (!held.current) return
    onHold?.(false)
    window.setTimeout(() => (held.current = false), 0)
  }
  const holdProps = onHold
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
          holdTimer.current = window.setTimeout(() => {
            held.current = true
            onHold(true)
          }, 250)
        },
        onPointerUp: holdOff,
        onPointerLeave: holdOff,
        onPointerCancel: holdOff,
        onClickCapture: (e: React.MouseEvent) => {
          if (!held.current) return
          e.stopPropagation()
          held.current = false
        }
      }
    : {}

  // A picked version plays with sound once its own video is on screen (it loads under the old one first).
  useEffect(() => {
    if (!playRequest || layers.shown?.src !== src) return
    const v = video.current
    setMuted(false)
    if (v) {
      v.muted = false
      void v.play().catch(() => {})
    }
    onPlayRequestHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per request, not per callback identity
  }, [playRequest, shownId])

  // Hold "Original": play the raw footage from the moment on screen, over the reel, then go back to the reel
  // where it was. Both are stacked, so only opacity changes; only the one on screen plays. The raw footage
  // and its "Original" tag show once its seek lands, so the reel is never labeled as the original.
  const resumeAfterHold = useRef(false)
  const holdStarted = useRef(false)
  // 'start': the first take from 0:00, not the moment on screen, and labeled so
  const [hold, setHold] = useState<'off' | 'loading' | 'slow' | 'on' | 'start' | 'failed'>('off')
  const backToReel = () => {
    if (resumeAfterHold.current) void video.current?.play().catch(() => {})
    resumeAfterHold.current = false
  }
  useEffect(() => {
    const r = raw.current
    const v = video.current
    if (!r) return
    if (!holdingOriginal) {
      holdStarted.current = false
      r.pause()
      setHold((h) => (h === 'failed' ? h : 'off'))
      backToReel()
      return
    }
    // runs again when what the mapping needs arrives during the hold: the reel was paused the first time
    if (!holdStarted.current) {
      holdStarted.current = true
      resumeAfterHold.current = !!v && !v.paused
      v?.pause()
    }
    if (!originalReady) {
      setHold('loading')
      return
    }
    const fail = () => {
      setHold('failed')
      backToReel()
    }
    const at = originalAt && v ? originalAt(v.currentTime) : 'start'
    if (!at) {
      fail()
      return
    }
    const synced = at !== 'start'
    const src = synced ? at.src : original
    const moved = !!src && r.getAttribute('src') !== src
    if (moved) r.src = src
    if (r.error && !moved) {
      fail()
      return
    }
    r.currentTime = synced ? at.at : 0
    applyRate(r, rateNow.current)
    void r.play().catch(() => {})
    const show = () => setHold(synced ? 'on' : 'start')
    r.addEventListener('error', fail, { once: true })
    if (r.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !r.seeking) show()
    else {
      setHold('loading')
      // a different take's file: before its metadata the time waits, and it shows once it plays
      r.addEventListener('seeked', show, { once: true })
      r.addEventListener('playing', show, { once: true })
    }
    return () => {
      r.removeEventListener('seeked', show)
      r.removeEventListener('playing', show)
      r.removeEventListener('error', fail)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read at the press (or once ready), not followed while held
  }, [holdingOriginal, originalReady])
  // Say it is loading only when that is noticeable, so a quick hold never flashes the words. Neither
  // delay was measured: 250 ms is about when a wait starts to feel like nothing happened, and 2 s is
  // long enough to read the failure line.
  useEffect(() => {
    if (hold !== 'loading' && hold !== 'failed') return
    const timer = window.setTimeout(() => setHold(hold === 'loading' ? 'slow' : 'off'), hold === 'loading' ? 250 : 2000)
    return () => window.clearTimeout(timer)
  }, [hold])

  const holdTag = { off: null, loading: null, slow: 'Loading the original', on: 'Original', start: 'Original (from the start)', failed: "Couldn't load the original" }[hold]

  const phone = (
    <div
      className={`phone${className ? ` ${className}` : ''}`}
      style={shape ? shapeVars(shape) : undefined}
      data-shape={shape?.id}
      draggable={!!dragFile}
      onPointerDown={(e) => {
        dragOrigin.current = e.target
      }}
      onDragStart={(e) => {
        e.preventDefault()
        const origin = dragOrigin.current
        dragOrigin.current = null
        if (!dragFile || !(origin instanceof HTMLElement) || origin.closest('.scrub, button')) return
        markDraggingOut()
        reel.app.startDrag(dragFile)
      }}
      data-testid="phone"
    >
      {/* tabIndex -1: a click on the video focuses the player, so its keys work without a Tab stop of its own */}
      {dragFile && (
        <button
          className="draghandle"
          // no Tab stop: Share › Show in Finder does this from the keyboard
          tabIndex={-1}
          draggable
          aria-label={`Drag the reel out, or press to show it in ${FOLDER_APP}`}
          // dragging needs a pointer: from the keyboard (or a click) the file is shown in Finder, to take from there
          onClick={() => void reel.app.openFolder(dragFile)}
          onDragStart={(e) => {
            e.preventDefault()
            e.stopPropagation()
            markDraggingOut()
            reel.app.startDrag(dragFile)
          }}
          data-testid="drag-handle"
        >
          <Icon name="grip" size={16} stroke={2} />
          <span className="draghandle-tip" aria-hidden>Drag the reel into any app</span>
        </button>
      )}
      <div className="phone-screen" data-lands ref={screenRef} tabIndex={src ? -1 : undefined} onKeyDown={src ? onKey : undefined} {...holdProps}>
        {src ? (
          <>
            {[layers.leaving, layers.shown, layers.next].map((l: Layer | null) => {
              if (!l) return null
              const on = l === layers.shown
              const loading = l === layers.next
              const onTime = (e: React.SyntheticEvent<HTMLVideoElement>) => {
                if (e.currentTarget.paused) ph.set(e.currentTarget.currentTime)
              }
              return (
                <Video
                  key={l.id}
                  el={(v) => (v ? els.current.set(l.id, v) : els.current.delete(l.id))}
                  className={`layer${loading ? ' loading' : ''}`}
                  src={l.src}
                  poster={l.poster ?? undefined}
                  preload="auto"
                  playsInline
                  disablePictureInPicture
                  controlsList="nodownload noplaybackrate noremoteplayback nofullscreen"
                  muted={muted}
                  aria-hidden={on ? undefined : true}
                  elementtiming={PLAYER_TIMING}
                  {...(on
                    ? {
                        onClick: toggle,
                        onPlay: () => {
                          setPlaying(true)
                          setStarted(true)
                        },
                        onPause: (e: React.SyntheticEvent<HTMLVideoElement>) => {
                          setPlaying(false)
                          onTime(e)
                        },
                        onEnded: () => setPlaying(false),
                        onTimeUpdate: onTime,
                        onSeeked: onTime,
                        onVolumeChange: (e: React.SyntheticEvent<HTMLVideoElement>) => setMuted(e.currentTarget.muted),
                        onLoadedMetadata: (e: React.SyntheticEvent<HTMLVideoElement>) => {
                          setDur(e.currentTarget.duration || 0)
                          onDuration?.(e.currentTarget.duration || 0)
                        },
                        'data-testid': testid
                      }
                    : loading && {
                        onLoadedData: (e: React.SyntheticEvent<HTMLVideoElement>) => {
                          const v = e.currentTarget
                          const show = () => void frameReady(v, l.poster).then(() => dispatch({ type: 'ready', id: l.id }))
                          // the moment on screen now, from the element showing it (the playhead can trail it by a frame or two)
                          const at = video.current?.currentTime ?? ph.get()
                          if (!keepTime || at <= 0) return show()
                          v.addEventListener('seeked', show, { once: true })
                          v.currentTime = Math.min(at, v.duration || at)
                        },
                        onError: () => {
                          dispatch({ type: 'failed', id: l.id })
                          onFailed?.()
                        }
                      })}
                />
              )
            })}
            {original && (
              <Video
                el={(v) => (raw.current = v)}
                className={`raw-video${hold === 'on' || hold === 'start' ? ' on' : ''}`}
                src={original}
                preload={warmOriginal || holdingOriginal ? 'auto' : 'metadata'}
                playsInline
                muted={muted}
                disablePictureInPicture
                data-testid="original-video"
              />
            )}
            {still && subtitle && !holdingOriginal && (
              <Video className={`raw-video on${stillMirrored ? ' mirrored' : ''}`} key={still} src={still} preload="auto" muted playsInline disablePictureInPicture aria-hidden />
            )}
            {/* always on the page, so a screen reader announces each change of its words */}
            <div className={holdTag ? 'phone-tag' : undefined} role="status" data-testid="original-tag">
              {holdTag}
            </div>
            {subtitle && !holdingOriginal && <SubtitleSample look={subtitle.look} text={subtitle.text} width={reelWidth} testid="sub-preview" />}
            {!holdingOriginal && change}
            <InstagramChrome on={view === 'instagram' && !holdingOriginal} caption={caption} playing={playing} />
            {subtitle && !holdingOriginal && <SafeBand shape={shape} />}
            {over}
            {!bare && !playing && !holdingOriginal && !(still && subtitle) && (
              <button className="big-play" onClick={toggle} aria-label="Play" data-testid="play">
                <Icon name="play" size={30} stroke={1.5} />
              </button>
            )}
            {muted && playing && (
              <button
                className="sound-chip"
                onClick={() => {
                  setMuted(false)
                  if (video.current) video.current.muted = false
                }}
                data-testid="tap-for-sound"
              >
                <Icon name="mute" size={16} /> Turn on sound
              </button>
            )}
            {!bare && <div className={`scrub${started || marks?.length ? ' shown' : ''}${asking || marks?.some((m) => m.state === 'making') ? ' pinned' : ''}`}>
              <button className="scrub-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
                <Icon name={playing ? 'pause' : 'play'} size={16} stroke={2} />
              </button>
              <span className="scrub-track" ref={trackRef}>
              <ScrubRange playhead={ph} dur={dur} onSeek={seek} />
              {dur > 0 &&
                !!marks?.length &&
                groupMarks(marks, dur, trackWidth).map((g) => {
                  const pct = Math.min(g.at, dur) / dur
                  return (
                    <button
                      key={g.items[0].id}
                      className={`scrub-mark ${g.state}${pct < 0.3 ? ' tip-start' : pct > 0.7 ? ' tip-end' : ''}`}
                      style={{ left: `calc(6px + (100% - 12px) * ${pct})` }}
                      // "Stopped, 0:11: cut this part; Done, 0:12: zoom in here": state, then time and request
                      aria-label={g.items.map((m) => `${MARK_STATE[m.state]}, ${clock(m.at)}: ${m.text}`).join('; ')}
                      onClick={() => seek(Math.min(g.at, dur))}
                      data-testid="scrub-mark"
                      data-state={g.state}
                    >
                      <span className="scrub-mark-tip" aria-hidden>
                        {g.items.map((m) => (
                          <span key={m.id}>
                            <b>{MARK_STATE[m.state]}</b> {m.text}
                          </span>
                        ))}
                      </span>
                    </button>
                  )
                })}
              </span>
              <ScrubTime playhead={ph} dur={dur} />
              {view === 'clean' && (
                <button className={`scrub-speed${rate !== 1 ? ' on' : ''}`} onClick={nextRate} aria-label={`Playback speed ${rateLabel(rate)}`} title="Playback speed" data-testid="speed">
                  {rateLabel(rate)}
                </button>
              )}
              <button
                className="scrub-btn"
                onClick={() => {
                  setMuted((m) => !m)
                  if (video.current) video.current.muted = !muted
                }}
                aria-label={muted ? 'Sound on' : 'Sound off'}
              >
                <Icon name={muted ? 'mute' : 'volume'} size={16} stroke={2} />
              </button>
            </div>}
          </>
        ) : (
          children ?? <div className="phone-empty">Your reel will play here.</div>
        )}
      </div>
    </div>
  )
  return <PhoneFill shape={shape}>{phone}</PhoneFill>
}

/** Sets the speed and keeps the voice at its own pitch (Chromium's default, set so it never depends on that). */
function applyRate(v: HTMLVideoElement, rate: number): void {
  v.preservesPitch = true
  v.playbackRate = rate
}
