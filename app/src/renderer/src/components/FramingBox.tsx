import { useState } from 'react'
import { focusOf, framed, framingOf, SCALE_MAX, SCALE_MIN, type Broll } from '../../../shared/timeline-edit'

// Where each kind of picture sits on the reel, as shares of it (engine broll.py zones, near enough to aim by).
const ZONES: Record<string, { x: number; y: number; w: number; h: number }> = {
  'full-frame': { x: 0, y: 0, w: 1, h: 1 },
  'split-top': { x: 0, y: 0, w: 1, h: 0.5 },
  'phone-card': { x: 0.08, y: 0.1, w: 0.42, h: 0.5 },
  'card-above-head': { x: 0.12, y: 0.06, w: 0.76, h: 0.34 },
  'side-card': { x: 0.52, y: 0.3, w: 0.42, h: 0.3 }
}

/**
 * The picked picture's frame, drawn over the reel while Edit it myself is open: drag inside it to move the picture
 * in its frame (a full-screen or top-half picture is cropped to fill it), drag the corner to make a card bigger or
 * smaller. The picture is shown as it will be framed while dragging; letting go makes it one change (`onFrame`).
 */
export function FramingBox({ b, thumb, onFrame }: { b: Broll; thumb: string | null; onFrame: (next: Broll) => void }) {
  const how = framingOf(b)
  const [live, setLive] = useState<Broll | null>(null)
  const zone = ZONES[b.treatment]
  if (!zone || (!how.pan && !how.scale)) return null
  const shown = live ?? b
  const f = focusOf(shown)
  const scale = how.scale ? f.scale : 1
  const w = zone.w * scale
  const h = zone.h * scale
  const box = { left: `${(zone.x + (zone.w - w) / 2) * 100}%`, top: `${(zone.y + (zone.h - h) / 2) * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }

  const drag = (ev: React.PointerEvent<HTMLElement>, what: 'pan' | 'scale') => {
    if (ev.button !== 0) return
    ev.preventDefault()
    ev.stopPropagation()
    const el = ev.currentTarget
    el.setPointerCapture(ev.pointerId)
    const reel = (el.closest('.frame-over') as HTMLElement).getBoundingClientRect()
    const [x0, y0] = [ev.clientX, ev.clientY]
    let next: Broll | null = null
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - x0) / (reel.width * zone.w)
      const dy = (e.clientY - y0) / (reel.height * zone.h)
      // the corner: its distance from the box's centre against where it started
      next = what === 'pan' ? framed(b, { dx, dy }) : framed(b, { scale: focusOf(b).scale * (1 + Math.max(dx, dy)) })
      setLive(next)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', cancel)
      setLive(null)
      if (next && JSON.stringify(next.params) !== JSON.stringify(b.params)) onFrame(next)
    }
    const cancel = () => {
      next = null
      up()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', cancel)
  }

  return (
    <div className="frame-over" data-testid="framing">
      <div
        className={`frame-box${how.pan ? ' pans' : ''}${live ? ' live' : ''}`}
        style={box}
        role="img"
        aria-label={`The picture's frame${how.pan ? ', drag to move the picture in it' : ''}${how.scale ? `, ${Math.round(scale * 100)}% of its usual size` : ''}`}
        onPointerDown={how.pan ? (e) => drag(e, 'pan') : undefined}
        data-testid="framing-box"
      >
        {thumb && <img src={thumb} alt="" draggable={false} style={{ objectPosition: `${f.x * 100}% ${f.y * 100}%` }} />}
        <span className="frame-label">{how.pan ? 'Drag to frame' : `${Math.round(scale * 100)}%`}</span>
        {how.scale && (
          <span
            className="frame-corner"
            onPointerDown={(e) => drag(e, 'scale')}
            title={`Drag to resize (${Math.round(SCALE_MIN * 100)}% to ${Math.round(SCALE_MAX * 100)}%)`}
            data-testid="framing-corner"
          />
        )}
      </div>
    </div>
  )
}
