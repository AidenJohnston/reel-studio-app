import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { clock } from '../../../shared/progress'
import { groupMarks, type NoteMark } from '../../../shared/moments'
import { Icon } from './icons'
import { reel } from '../api'
import { createPlayhead, usePlayhead, type Playhead } from './playhead'
import { NO_LAYERS, layersReducer, type Layer } from './videoLayers'

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

/** The subtitle look, in the engine's own units (1080 x 1920 frame). */
export interface SubtitleLook {
  size: number
  position: number
  color: string
  outlineColor: string
  outline: number
  box: boolean
  upper: boolean
}

export const ENGINE_WIDTH = 1080
const BOX_PAD = 18 // engine captions.BOX_PAD

export function lookFromStyle(st: Record<string, unknown> | undefined): SubtitleLook {
  const s = st ?? {}
  return {
    size: Number(s.size ?? 105),
    position: Number(s.position ?? 0.75),
    color: String(s.color ?? '#FFFFFF'),
    outlineColor: String(s.outlineColor ?? '#000000'),
    outline: Number(s.outline ?? 8),
    box: !!s.box,
    upper: (s.case ?? 'upper') === 'upper'
  }
}

/** The engine's subtitle look drawn in CSS at the size of `width` (the preview's width in px). */
export function SubtitleSample({ look, text, width, testid }: { look: SubtitleLook; text: string; width: number; testid?: string }) {
  const k = width / ENGINE_WIDTH
  const fontSize = look.size * k
  const outline = Math.max(0.6, look.outline * k)
  const style: React.CSSProperties = {
    top: `${look.position * 100}%`,
    fontSize,
    color: look.color,
    textTransform: look.upper ? 'uppercase' : 'none'
  }
  if (look.box) {
    const pad = Math.max(look.outline, BOX_PAD) * k
    Object.assign(style, { background: look.outlineColor, padding: `${pad * 0.35}px ${pad}px` })
  } else {
    // Stroke is centred on the glyph edge, so twice the engine's outline, painted under the fill.
    Object.assign(style, { WebkitTextStroke: `${outline * 2}px ${look.outlineColor}`, paintOrder: 'stroke fill' })
  }
  return (
    <div className="sub-sample" style={style} data-testid={testid} aria-hidden>
      {text}
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
  const cover = new Image()
  cover.src = poster
  return Promise.all([frame, cover.decode().catch(() => {})]).then(() => {})
}

// Matches the opacity transition on .phone-screen > video.layer.
const FADE_MS = 140

/** Follows the playhead every frame, so it re-renders on its own and the player does not. */
function ScrubRange({ playhead, dur, onSeek }: { playhead: Playhead; dur: number; onSeek: (seconds: number) => void }) {
  const t = usePlayhead(playhead, (s) => s)
  return (
    <input
      type="range"
      min={0}
      max={dur || 1}
      step={0.01}
      value={Math.min(t, dur || 1)}
      aria-label="Position in the video"
      aria-keyshortcuts="ArrowLeft ArrowRight"
      style={{ ['--pct' as string]: `${dur ? (t / dur) * 100 : 0}%` }}
      onChange={(e) => onSeek(Number(e.target.value))}
    />
  )
}

/** Time left, which changes once a second. */
function ScrubTime({ playhead, dur }: { playhead: Playhead; dur: number }) {
  return <span className="scrub-time">{usePlayhead(playhead, (s) => clock(dur ? dur - s : 0))}</span>
}

const MARK_STATE: Record<NoteMark['state'], string> = { making: 'Being made', done: 'Done', failed: "Didn't work", stopped: 'Stopped' }

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || el.tagName === 'BUTTON')
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
  subtitle,
  instagram,
  caption,
  original,
  originalAt,
  originalReady = true,
  warmOriginal,
  holdingOriginal,
  still,
  onDuration,
  dragFile,
  marks,
  asking,
  playhead,
  onShown,
  onFailed,
  className,
  testid = 'player',
  children
}: {
  src: string | null
  poster?: string | null
  /** First arrival after Working: start playing, muted, with a "Tap for sound" chip. */
  autoPlayMuted?: boolean
  /** Live preview of the subtitle style (the drawer). */
  subtitle?: { look: SubtitleLook; text: string } | null
  /** Faint Instagram buttons + caption area over the video. */
  instagram?: boolean
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
  className?: string
  /** The video's test id. The Working screen's first look uses its own, so "player" means the Reel screen. */
  testid?: string
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
  const trackRef = useRef<HTMLSpanElement>(null)
  const trackWidth = useWidth(trackRef)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(!!autoPlayMuted)
  const [dur, setDur] = useState(0)
  const [started, setStarted] = useState(false)

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

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // defaultPrevented: the player's own keys already took it
      if (e.code !== 'Space' || e.defaultPrevented || typing(e.target) || document.querySelector('.modal-backdrop')) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [toggle])

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
    if (layers.leaving) els.current.get(layers.leaving.id)?.pause()
    if (!v) return
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

  // While playing, move the playhead every frame (timeupdate fires only about four times a second).
  useEffect(() => {
    const v = video.current
    if (!playing || !v) return
    let frame = 0
    const tick = () => {
      ph.set(v.currentTime)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, shownId, ph])

  useEffect(() => {
    if (asking) video.current?.pause()
  }, [asking])

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

  return (
    <div
      className={`phone${className ? ` ${className}` : ''}`}
      draggable={!!dragFile}
      title={dragFile ? 'Drag me out of the window to put your reel on the desktop or in an upload box' : undefined}
      onDragStart={(e) => {
        e.preventDefault()
        if (!dragFile || (e.target as HTMLElement).closest('.scrub')) return
        markDraggingOut()
        reel.app.startDrag(dragFile)
      }}
      data-testid="phone"
    >
      {/* tabIndex -1: a click on the video focuses the player, so its keys work without a Tab stop of its own */}
      <div className="phone-screen" ref={screenRef} tabIndex={src ? -1 : undefined} onKeyDown={src ? onKey : undefined}>
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
                  {...(on
                    ? {
                        onClick: toggle,
                        onPlay: () => {
                          setPlaying(true)
                          setStarted(true)
                        },
                        onPause: () => setPlaying(false),
                        onEnded: () => setPlaying(false),
                        onTimeUpdate: onTime,
                        onSeeked: onTime,
                        onLoadedMetadata: (e: React.SyntheticEvent<HTMLVideoElement>) => {
                          setDur(e.currentTarget.duration || 0)
                          onDuration?.(e.currentTarget.duration || 0)
                        },
                        'data-testid': testid
                      }
                    : loading && {
                        onLoadedData: (e: React.SyntheticEvent<HTMLVideoElement>) => {
                          void frameReady(e.currentTarget, l.poster).then(() => dispatch({ type: 'ready', id: l.id }))
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
              <Video className="raw-video on" key={still} src={still} preload="auto" muted playsInline disablePictureInPicture aria-hidden />
            )}
            {/* always on the page, so a screen reader announces each change of its words */}
            <div className={holdTag ? 'phone-tag' : undefined} role="status" data-testid="original-tag">
              {holdTag}
            </div>
            {subtitle && !holdingOriginal && <SubtitleSample look={subtitle.look} text={subtitle.text} width={width} testid="sub-preview" />}
            {instagram && !holdingOriginal && <InstagramOverlay caption={caption} />}
            {!playing && !holdingOriginal && !(still && subtitle) && (
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
                <Icon name="mute" size={16} /> Tap for sound
              </button>
            )}
            <div className={`scrub${started || marks?.length ? ' shown' : ''}${asking || marks?.some((m) => m.state === 'making') ? ' pinned' : ''}`}>
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
            </div>
          </>
        ) : (
          children ?? <div className="phone-empty">Your reel will play here.</div>
        )}
      </div>
    </div>
  )
}

/** A faint stand-in for Instagram's buttons and caption, so you can see what they cover. */
export function InstagramOverlay({ caption }: { caption?: string }) {
  return (
    <div className="ig" data-testid="ig-overlay" aria-hidden>
      <div className="ig-side">
        <Icon name="heart" size={22} />
        <Icon name="comment" size={22} />
        <Icon name="send" size={22} />
        <Icon name="bookmark" size={22} />
      </div>
      <div className="ig-bottom">
        <div className="ig-user">
          <span className="ig-avatar" /> yourname
        </div>
        <div className="ig-caption">{caption?.trim() || 'Your post caption shows here'}</div>
      </div>
    </div>
  )
}
