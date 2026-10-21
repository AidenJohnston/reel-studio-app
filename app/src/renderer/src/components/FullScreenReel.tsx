import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clock } from '../../../shared/progress'
import { reel } from '../api'
import { EXPORT_EVENT } from '../App'
import { Icon } from './icons'
import { applyPlay, handOff, readPlay } from './handoff'

/**
 * The reel full screen, at its real 9:16 shape and the full height of the screen, on the phone's
 * dark bezel colour. It plays its own copy of the video: the position, play/pause and sound come
 * over from the phone's video on open and go back on close, so only one of them ever plays.
 *
 * It covers the window and the window goes full screen (main/viewer-fullscreen.ts says why not the
 * page's Fullscreen API). A window already in macOS full screen stays there on close.
 */
export function FullScreenReel({
  src,
  poster,
  from,
  overlay,
  onClosed
}: {
  src: string
  poster?: string | null
  /** The phone's video: where playback comes from and goes back to. */
  from: HTMLVideoElement
  /** Drawn over the video (the Instagram view). */
  overlay?: ReactNode
  /** The exit motion has finished: unmount. */
  onClosed: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  // Read once, before any effect: React's dev double-run of effects must not read the phone after
  // this view has already paused it.
  const [start] = useState(() => readPlay(from, { at: 0, playing: false, muted: from.muted }))
  const [closing, setClosing] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(start.muted)
  const [t, setT] = useState(start.at)
  const [dur, setDur] = useState(from.duration || 0)

  const closingRef = useRef(false)
  useEffect(() => {
    from.pause()
    applyPlay(video.current!, start)
    // The page behind goes inert so Tab and screen readers stay in here.
    const app = document.getElementById('root')
    const prev = document.activeElement as HTMLElement | null
    if (app) app.inert = true
    root.current!.focus()
    void reel.app.fullScreen(true).catch(() => {}) // refused: the view still covers the window
    return () => {
      // Unmounted without closing (the phone was replaced by a new version): leave full screen too.
      if (!closingRef.current) void reel.app.fullScreen(false).catch(() => {})
      if (app) app.inert = false
      // An export started from the menu closes this view and opens its dialog while the page is
      // still inert, so the dialog could not take focus: give it focus the way Modal does, and never
      // to the opener behind it. Otherwise back to the opener, or to the new opener if a new version
      // replaced the phone while open.
      const dialog = app?.querySelector<HTMLElement>('[role="dialog"]')
      const back = dialog
        ? (dialog.querySelector<HTMLElement>('[data-autofocus]') ?? dialog.querySelector<HTMLElement>('button'))
        : prev?.isConnected
          ? prev
          : document.querySelector<HTMLElement>('.fs-open')
      back?.focus()
    }
  }, [from, start])

  const toggle = useCallback(() => {
    const v = video.current
    if (!v || closingRef.current) return // playback has already gone back to the phone
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }, [])

  const close = useCallback(() => {
    if (closingRef.current) return
    closingRef.current = true
    handOff(video.current!, from, start)
    void reel.app.fullScreen(false).catch(() => {})
    setClosing(true)
  }, [from, start])

  // Unmount once the exit transitions finish (reduced motion has none). A transition cut short by
  // another one settles too, so Esc halfway through opening still closes.
  useEffect(() => {
    if (!closing) return
    const running = root.current!.getAnimations({ subtree: true }).map((a) => a.finished)
    void Promise.allSettled(running).then(onClosed)
  }, [closing, onClosed])

  // Export (Cmd/Ctrl+E, File > Export) shows its dialog on the page behind: step out of the way.
  useEffect(() => {
    window.addEventListener(EXPORT_EVENT, close)
    return () => window.removeEventListener(EXPORT_EVENT, close)
  }, [close])

  // Window capture phase: this runs before the page's bubble-phase handlers (the phone's Space, the
  // drawer's Esc), so those never see these keys. While closing, Space is the phone's again.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      } else if (e.code === 'Space' && !closingRef.current) {
        e.stopImmediatePropagation()
        if ((e.target as HTMLElement | null)?.tagName === 'BUTTON') return // Space presses that button
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [close, toggle])

  return createPortal(
    <div
      ref={root}
      className={`fs${closing ? ' closing' : ''}`}
      role="dialog"
      aria-modal
      aria-label="Your reel, full screen"
      tabIndex={-1}
      data-testid="fullscreen"
    >
      <div className={`fs-frame${playing ? '' : ' paused'}`}>
        <video
          ref={video}
          src={src}
          poster={poster ?? undefined}
          preload="auto"
          playsInline
          disablePictureInPicture
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
          onVolumeChange={(e) => setMuted(e.currentTarget.muted)}
          data-testid="fullscreen-video"
        />
        {overlay}
        {!playing && (
          <button className="big-play" onClick={toggle} aria-label="Play">
            <Icon name="play" size={34} stroke={1.5} />
          </button>
        )}
        {muted && playing && (
          <button className="sound-chip" onClick={() => (video.current!.muted = false)}>
            <Icon name="mute" size={16} /> Tap for sound
          </button>
        )}
        <div className="scrub shown">
          <button className="scrub-btn" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
            <Icon name={playing ? 'pause' : 'play'} size={18} stroke={2} />
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
              video.current!.currentTime = Number(e.target.value)
              setT(Number(e.target.value))
            }}
          />
          <span className="scrub-time">{clock(dur ? dur - t : 0)}</span>
          <button
            className="scrub-btn"
            onClick={() => (video.current!.muted = !video.current!.muted)}
            aria-label={muted ? 'Sound on' : 'Sound off'}
          >
            <Icon name={muted ? 'mute' : 'volume'} size={18} stroke={2} />
          </button>
        </div>
      </div>
      <button className="fs-exit" onClick={close} data-testid="exit-fullscreen">
        <Icon name="minimize" size={16} stroke={2} /> Exit full screen
      </button>
    </div>,
    document.body
  )
}
