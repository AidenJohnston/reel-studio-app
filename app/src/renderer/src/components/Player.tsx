import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { clock } from '../../../shared/progress'
import { Icon } from './icons'
import { reel } from '../api'

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

const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || el.tagName === 'BUTTON')
}

/**
 * The phone-shaped player: a cover frame until you press play, one big play button and a thin
 * scrub bar instead of the browser's controls (no download, speed or picture-in-picture menu).
 * Space plays and pauses (when you are not typing).
 */
export function PhonePlayer({
  src,
  poster,
  autoPlayMuted,
  playRequest,
  subtitle,
  instagram,
  caption,
  original,
  holdingOriginal,
  still,
  onDuration,
  dragFile,
  className,
  testid = 'player',
  children
}: {
  src: string | null
  poster?: string | null
  /** First arrival after Working: start playing, muted, with a "Tap for sound" chip. */
  autoPlayMuted?: boolean
  /** Each new number starts playing, with sound (the person just picked this version). */
  playRequest?: number
  /** Live preview of the subtitle style (the drawer). */
  subtitle?: { look: SubtitleLook; text: string } | null
  /** Faint Instagram buttons + caption area over the video. */
  instagram?: boolean
  caption?: string
  /** The raw footage, shown while "Original" is held down. */
  original?: string | null
  holdingOriginal?: boolean
  /** A still frame (the raw take, no subtitles burned in) under the subtitle preview. */
  still?: string | null
  onDuration?: (seconds: number) => void
  /** The file on disk: drag the phone out of the window to put the reel on the desktop or in an upload box. */
  dragFile?: string | null
  className?: string
  /** The video's test id. The Working screen's first look uses its own, so "player" means the Reel screen. */
  testid?: string
  children?: ReactNode
}) {
  const screenRef = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const raw = useRef<HTMLVideoElement>(null)
  const width = useWidth(screenRef)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(!!autoPlayMuted)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(0)
  const [started, setStarted] = useState(false)

  const toggle = useCallback(() => {
    const v = video.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }, [])

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || typing(e.target) || document.querySelector('.modal-backdrop')) return
      e.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [toggle])

  useEffect(() => {
    if (!autoPlayMuted || !video.current) return
    video.current.muted = true
    void video.current.play().catch(() => {})
  }, [autoPlayMuted, src])

  useEffect(() => {
    if (playRequest) void video.current?.play().catch(() => {})
  }, [playRequest, src])

  // Hold "Original": play the raw footage from the start over the reel, then go back.
  useEffect(() => {
    const r = raw.current
    if (!r) return
    if (holdingOriginal) {
      video.current?.pause()
      r.currentTime = 0
      void r.play().catch(() => {})
    } else r.pause()
  }, [holdingOriginal])

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
      <div className="phone-screen" ref={screenRef}>
        {src ? (
          <>
            <video
              ref={video}
              key={src}
              src={src}
              poster={poster ?? undefined}
              preload="metadata"
              playsInline
              disablePictureInPicture
              controlsList="nodownload noplaybackrate noremoteplayback nofullscreen"
              muted={muted}
              onClick={toggle}
              onPlay={() => {
                setPlaying(true)
                setStarted(true)
              }}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
              onLoadedMetadata={(e) => {
                setDur(e.currentTarget.duration || 0)
                onDuration?.(e.currentTarget.duration || 0)
              }}
              data-testid={testid}
            />
            {original && (
              <video
                ref={raw}
                className={`raw-video${holdingOriginal ? ' on' : ''}`}
                src={original}
                preload="metadata"
                playsInline
                muted={muted}
                disablePictureInPicture
                data-testid="original-video"
              />
            )}
            {still && subtitle && !holdingOriginal && (
              <video className="raw-video on" key={still} src={still} preload="auto" muted playsInline disablePictureInPicture aria-hidden />
            )}
            {holdingOriginal && <div className="phone-tag">Original</div>}
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
            <div className={`scrub${started ? ' shown' : ''}`}>
              <button className="scrub-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
                <Icon name={playing ? 'pause' : 'play'} size={16} stroke={2} />
              </button>
              <input
                type="range"
                min={0}
                max={dur || 1}
                step={0.01}
                value={Math.min(t, dur || 1)}
                aria-label="Position in the video"
                style={{ ['--pct' as string]: `${dur ? (t / dur) * 100 : 0}%` }}
                onChange={(e) => {
                  const v = video.current
                  if (v) v.currentTime = Number(e.target.value)
                  setT(Number(e.target.value))
                }}
              />
              <span className="scrub-time">{clock(dur ? dur - t : 0)}</span>
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
