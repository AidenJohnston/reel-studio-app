import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import type { VersionInfo } from '../../../shared/api'
import { clock } from '../../../shared/progress'
import { Icon } from './icons'
import { Button, Modal, Segmented } from './ui'
import './side-by-side.css'

/** How Compare shows two versions: one player that switches between them, or both at once. Remembered per computer. */
export type CompareLayout = 'one' | 'side'
const KEY = 'rs.compareLayout'
export function savedLayout(): CompareLayout {
  try {
    return localStorage.getItem(KEY) === 'side' ? 'side' : 'one'
  } catch {
    return 'one'
  }
}
export function saveLayout(l: CompareLayout): void {
  try {
    localStorage.setItem(KEY, l)
  } catch {
    // a private window: the choice lasts until the app closes
  }
}

/** a picture that drifts more than this behind the one with the sound is moved back in step */
const DRIFT_S = 0.12

/**
 * Compare › Side by side: both versions play at once, in step, from where the player was. The sound comes from one
 * of them (the person picks which); one Play and one scrubber drive both. Done hands the time back to the player.
 */
export function SideBySide({ a, b, nameOf, at, onOpen, onDone, onOne }: { a: VersionInfo; b: VersionInfo; nameOf: (v: VersionInfo) => string; at: number; onOpen: () => void; onDone: (seconds: number) => void; onOne: (seconds: number) => void }) {
  const titleId = useId()
  const refs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)]
  const [sound, setSound] = useState<'a' | 'b'>('a')
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(at)
  // both play only as long as the shorter one
  const [durations, setDurations] = useState<[number, number]>([0, 0])
  const duration = Math.min(...durations.filter((d) => d > 0), Infinity)
  const end = Number.isFinite(duration) ? duration : 0
  const lead = () => refs[sound === 'a' ? 0 : 1].current
  const other = () => refs[sound === 'a' ? 1 : 0].current
  // no time past the shorter version's end: not on the clock, not handed back to the player
  const clamp = (t: number) => (end ? Math.min(t, end) : t)

  useEffect(() => {
    // the player under the dialog stops: one picture with sound at a time
    onOpen()
    for (const r of refs) if (r.current) r.current.currentTime = at
    // once: where the player was when Side by side opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // opened past the shorter one's end (the player was further into the longer version): both wait at that end
  useEffect(() => {
    if (!end) return
    for (const r of refs) if (r.current && r.current.currentTime > end) r.current.currentTime = end
    setTime((t) => Math.min(t, end))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [end])

  // the one with the sound leads; the other follows it each frame it shows
  useEffect(() => {
    const v = lead()
    if (!v) return
    const tick = () => {
      setTime(clamp(v.currentTime))
      if (end && v.currentTime >= end) stop()
      const o = other()
      if (o && Math.abs(o.currentTime - v.currentTime) > DRIFT_S) o.currentTime = v.currentTime
    }
    v.addEventListener('timeupdate', tick)
    v.addEventListener('seeked', tick)
    return () => {
      v.removeEventListener('timeupdate', tick)
      v.removeEventListener('seeked', tick)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sound, end])

  const stop = () => {
    for (const r of refs) r.current?.pause()
    setPlaying(false)
  }
  const toggle = () => {
    const vs = refs.map((r) => r.current).filter((v): v is HTMLVideoElement => !!v)
    if (playing) return stop()
    // from the start again once the shorter one has ended
    const t = end && (lead()?.currentTime ?? 0) >= end - 0.05 ? 0 : (lead()?.currentTime ?? time)
    for (const v of vs) v.currentTime = t
    void Promise.all(vs.map((v) => v.play().catch(() => undefined))).then(() => setPlaying(true))
  }
  const seek = (to: number) => {
    const s = clamp(to)
    for (const r of refs) if (r.current) r.current.currentTime = s
    setTime(s)
  }
  const leave = (then: (seconds: number) => void) => () => {
    for (const r of refs) r.current?.pause()
    then(clamp(lead()?.currentTime ?? time))
  }
  const done = leave(onDone)

  return (
    <Modal onClose={done} wide testid="side-by-side" labelledBy={titleId}>
      <h2 id={titleId}>Version {a.n} and Version {b.n}</h2>
      <div className="sbs">
        {[a, b].map((v, i) => (
          <figure key={v.n} className="sbs-phone">
            <video
              ref={refs[i]}
              src={v.video}
              poster={v.cover ?? undefined}
              playsInline
              preload="auto"
              muted={(i === 0 ? 'a' : 'b') !== sound}
              aria-label={`Version ${v.n}`}
              onLoadedMetadata={(e) => {
                const d = e.currentTarget.duration
                setDurations((ds) => (i === 0 ? [d, ds[1]] : [ds[0], d]))
              }}
              onEnded={stop}
              data-testid={`sbs-video-${v.n}`}
            />
            <figcaption>
              <b>Version {v.n}</b>
              {nameOf(v) && <span>{nameOf(v)}</span>}
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="sbs-bar">
        <button className="sbs-pp" onClick={toggle} aria-label={playing ? 'Pause both' : 'Play both'} data-testid="sbs-play">
          <Icon name={playing ? 'pause' : 'play'} size={14} stroke={2} />
        </button>
        <input
          className="sbs-scrub"
          type="range"
          min={0}
          max={end}
          step={0.01}
          value={Math.min(time, end || time)}
          style={{ '--pct': `${end ? (Math.min(time, end) / end) * 100 : 0}%` } as CSSProperties}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Where both versions are"
          aria-valuetext={clock(Math.floor(time))}
          data-testid="sbs-scrub"
        />
        {/* whole seconds passed, as the player's clock counts them (Reel.tsx): at 7.5 s both say 0:07 */}
        <span className="sbs-time">{clock(Math.floor(time))}</span>
        <Segmented
          label="Sound from"
          value={sound}
          options={[
            { key: 'a', label: `Sound ${a.n}`, title: `Hear Version ${a.n}` },
            { key: 'b', label: `Sound ${b.n}`, title: `Hear Version ${b.n}` }
          ]}
          onPick={setSound}
          testid="sbs-sound"
        />
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <Button kind="tertiary" onClick={leave(onOne)} data-testid="sbs-one">
          Compare in one player
        </Button>
        <Button kind="primary" onClick={done} data-testid="sbs-done">
          Done comparing
        </Button>
      </div>
    </Modal>
  )
}
