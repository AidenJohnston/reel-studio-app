// The two menus in the Reel screen's transport row, also in the full-screen stage: the playback speed and the
// phone shape the preview takes. Each is a pill that opens a small menu of choices and gives focus back to its pill,
// whose name then says the new choice. The shape also says aloud what Instagram may trim on that phone.
import { useRef, useState, type CSSProperties } from 'react'
import { SHAPES, fitWords } from '../../../shared/phone-shapes'
import { Icon } from './icons'
import { PopMenu } from './PopMenu'
import { usePhoneShape } from './Phone'
import { RATES, rateLabel, useTransport, type Transport } from './transport'
import { announce } from './announce'
import './preview.css'

/** Where a menu opens: up and to the left of its pill under the phone, up and to the right in the stage's dock. */
type Side = 'left' | 'right'
const above = (side: Side, width: number | string): { style: CSSProperties; origin: string } =>
  side === 'left' ? { style: { right: 0, bottom: 'calc(100% + 6px)', width }, origin: 'bottom right' } : { style: { left: 0, bottom: 'calc(100% + 6px)', width }, origin: 'bottom left' }

/** The preferred side, unless the menu would run past the edge of the column it opens in (the main column, or the
 * window in the full-screen stage): then the other side. At 1100x720 the 300 px shape menu ran 73 px past the
 * page's left edge. */
function roomFor(pill: HTMLElement | null, side: Side, width: number): Side {
  if (!pill) return side
  const r = pill.getBoundingClientRect()
  const col = pill.closest('.main')?.getBoundingClientRect() ?? { left: 0, right: window.innerWidth }
  if (side === 'left' && r.right - width < col.left + 8 && r.left + width <= col.right - 8) return 'right'
  if (side === 'right' && r.left + width > col.right - 8 && r.right - width >= col.left + 8) return 'left'
  return side
}

export function SpeedMenu({ transport, side = 'left' }: { transport: Transport; side?: Side }) {
  const { rate } = useTransport(transport)
  const [open, setOpen] = useState(false)
  const pill = useRef<HTMLButtonElement>(null)
  const pick = (r: number) => {
    transport.setRate(r)
    setOpen(false)
    pill.current?.focus({ preventScroll: true })
  }
  return (
    <span className="tmenu">
      <button
        ref={pill}
        type="button"
        className={`speed${rate !== 1 ? ' on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Playback speed, ${rateLabel(rate)}`}
        title="Playback speed (< slower, > faster)"
        onClick={() => setOpen((o) => !o)}
        data-testid="speed"
      >
        {rateLabel(rate)}
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} anchor={pill} label="Playback speed" {...above(side, 140)} testid="speed-menu">
        {RATES.map((r) => (
          <button key={r} type="button" className="mi" role="menuitemradio" aria-checked={r === rate} onClick={() => pick(r)} data-testid={`speed-${r}`}>
            {r === rate ? <Icon name="check" size={16} /> : <span className="mi-sp" />}
            {rateLabel(r)}
            {r === 1 && <span className="r">Normal</span>}
          </button>
        ))}
      </PopMenu>
    </span>
  )
}

const SHAPE_MENU_W = 300

export function ShapeMenu({ side = 'left' }: { side?: Side }) {
  const [shape, setShape] = usePhoneShape()
  const [open, setOpen] = useState(false)
  const [opensTo, setOpensTo] = useState<Side>(side)
  const pill = useRef<HTMLButtonElement>(null)
  return (
    <span className="tmenu shape">
      <button
        ref={pill}
        type="button"
        className="tpill shape-pick"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Phone shape, ${shape.label}`}
        title={`${shape.label}. ${fitWords(shape)}`}
        onClick={() => {
          if (!open) setOpensTo(roomFor(pill.current, side, SHAPE_MENU_W))
          setOpen((o) => !o)
        }}
        data-testid="shape"
      >
        <Icon name="phone" size={16} stroke={1.75} />
        <span className="lbl">{shape.label}</span>
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} anchor={pill} label="Phone shape" {...above(opensTo, SHAPE_MENU_W)} testid="shape-menu">
        {SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            className="mi shape-mi"
            role="menuitemradio"
            aria-checked={s.id === shape.id}
            onClick={() => {
              setShape(s)
              setOpen(false)
              pill.current?.focus({ preventScroll: true })
              announce(fitWords(s))
            }}
            data-testid={`shape-${s.id}`}
          >
            {s.id === shape.id ? <Icon name="check" size={16} /> : <span className="mi-sp" />}
            <span className="shape-mi-text">
              <span>
                {s.label}
                <span className="r">{s.ratio}</span>
              </span>
              <span className="shape-mi-fit">{fitWords(s)}</span>
            </span>
          </button>
        ))}
      </PopMenu>
    </span>
  )
}

const VIEW_MENU_W = 300
const VIEWS = [
  { key: 'instagram', label: 'Instagram', fit: 'Your reel under Instagram’s buttons and caption', testid: 'view-instagram' },
  { key: 'clean', label: 'Clean', fit: 'Your reel alone', testid: 'view-clean' }
] as const

/**
 * How the preview looks, in one menu under the phone: Instagram or Clean, the phone's shape, and the timeline. One
 * pill instead of three keeps the transport row as wide as the phone at every window size (reel.css). While two
 * versions are compared the view is held at Clean, and the menu says why.
 */
export function ViewMenu({
  view,
  onView,
  held,
  timeline,
  onTimeline,
  timelineShortcut,
  side = 'left'
}: {
  view: 'instagram' | 'clean'
  onView: (v: 'instagram' | 'clean') => void
  /** comparing versions: the preview stays Clean until Done comparing */
  held: boolean
  timeline: boolean
  onTimeline: (shown: boolean) => void
  timelineShortcut: string
  side?: Side
}) {
  const [shape, setShape] = usePhoneShape()
  const [open, setOpen] = useState(false)
  const [opensTo, setOpensTo] = useState<Side>(side)
  const pill = useRef<HTMLButtonElement>(null)
  const done = (words?: string) => {
    setOpen(false)
    pill.current?.focus({ preventScroll: true })
    if (words) announce(words)
  }
  const shown = VIEWS.find((v) => v.key === view) ?? VIEWS[0]
  return (
    <span className="tmenu">
      <button
        ref={pill}
        type="button"
        className="icon-btn view-pick"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`View: ${shown.label}, ${shape.label}${timeline ? '' : ', timeline hidden'}`}
        title={`View: ${shown.label}, ${shape.label}`}
        onClick={() => {
          if (!open) setOpensTo(roomFor(pill.current, side, VIEW_MENU_W))
          setOpen((o) => !o)
        }}
        data-testid="view-menu"
      >
        <Icon name="eye" size={18} />
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} anchor={pill} label="View" {...above(opensTo, VIEW_MENU_W)} testid="view-menu-list">
        <p className="mi-head" aria-hidden>
          On the phone
        </p>
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className="mi shape-mi"
            role="menuitemradio"
            aria-checked={v.key === view}
            disabled={held}
            onClick={() => (onView(v.key), done())}
            data-testid={v.testid}
          >
            {v.key === view ? <Icon name="check" size={16} /> : <span className="mi-sp" />}
            <span className="shape-mi-text">
              <span>{v.label}</span>
              <span className="shape-mi-fit">{held ? 'Comparing shows the reel without Instagram. Your view comes back on Done comparing.' : v.fit}</span>
            </span>
          </button>
        ))}
        <hr />
        <p className="mi-head" aria-hidden>
          Phone
        </p>
        {SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            className="mi shape-mi"
            role="menuitemradio"
            aria-checked={s.id === shape.id}
            onClick={() => (setShape(s), done(fitWords(s)))}
            data-testid={`shape-${s.id}`}
          >
            {s.id === shape.id ? <Icon name="check" size={16} /> : <span className="mi-sp" />}
            <span className="shape-mi-text">
              <span>
                {s.label}
                <span className="r">{s.ratio}</span>
              </span>
              <span className="shape-mi-fit">{fitWords(s)}</span>
            </span>
          </button>
        ))}
        <hr />
        <button type="button" className="mi" role="menuitemcheckbox" aria-checked={timeline} onClick={() => (onTimeline(!timeline), done())} data-testid="timeline-toggle">
          {timeline ? <Icon name="check" size={16} /> : <span className="mi-sp" />}
          Timeline
          <span className="r">
            <kbd className="kbd">{timelineShortcut}</kbd>
          </span>
        </button>
      </PopMenu>
    </span>
  )
}
