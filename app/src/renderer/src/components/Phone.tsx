// The phone preview, wherever a reel is shown: the reel inside a phone's body, under Instagram's Reels screen
// ("Instagram") or alone ("Clean"). The person's choice is an app setting (main/settings.ts).
// The phone takes a real phone's shape (shared/phone-shapes.ts), remembered per person; the whole reel's own frame is
// one of the shapes.
import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import type { PhoneView } from '../../../shared/api'
import type { InstagramSession } from '../../../shared/instagram'
import { DEFAULT_SHAPE, clearBand, place, shapeById, type Shape } from '../../../shared/phone-shapes'
import { reel } from '../api'
import { Icon } from './icons'
import { Segmented } from './ui'
import './Phone.css'

let view: PhoneView = 'instagram'
let chosen = false
const listeners = new Set<() => void>()
const emit = (next: PhoneView): void => {
  view = next
  for (const l of listeners) l()
}
// Read once at start-up, long before a reel opens. A choice made before it answers wins.
void reel.app.info().then((i) => {
  if (!chosen) emit(i.phoneView)
})

/** The view and a setter that saves it. The setter's promise rejects when the setting could not be saved. */
export function usePhoneView(): [PhoneView, (next: PhoneView) => Promise<unknown>] {
  const v = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => view
  )
  return [
    v,
    (next) => {
      chosen = true
      emit(next)
      return reel.app.setPhoneView(next)
    }
  ]
}

const SHAPE_KEY = 'rs.phone-shape'
let shape: Shape = shapeById(localStorage.getItem(SHAPE_KEY) ?? DEFAULT_SHAPE)
const shapeListeners = new Set<() => void>()

/** The phone shape the preview takes, and a setter that remembers it on this computer. */
export function usePhoneShape(): [Shape, (next: Shape) => void] {
  const s = useSyncExternalStore(
    (l) => (shapeListeners.add(l), () => shapeListeners.delete(l)),
    () => shape
  )
  return [
    s,
    (next) => {
      shape = next
      localStorage.setItem(SHAPE_KEY, next.id)
      for (const l of shapeListeners) l()
    }
  ]
}

const pct = (n: number): string => `${+(n * 100).toFixed(4)}%`

/**
 * The body around a shape's screen, in fractions of the screen's width: the border on each side and the body's corner
 * radius. From Apple's specs: the iPhone 17 (apple.com/iphone-17/specs) is 71.5 x 149.6 mm around a 1206 x 2622 px
 * screen at 460 ppi, so 2.45 mm at the sides and 2.41 mm above and below; the iPhone SE (3rd generation,
 * support.apple.com/111866) is 67.3 x 138.4 mm around 750 x 1334 px at 326 ppi. The Pro Max is assumed to have the
 * iPhone 17's border in millimetres, and the SE's 9.6 mm body corner is an estimate (its screen corners are square).
 * A Face ID body's corners are concentric with its screen's. The whole reel borrows the iPhone 17's border.
 */
interface Body {
  side: number
  top: number
  bottom: number
  /** The body's corner radius, across and down. */
  corner: [number, number]
}

const FACE_ID_MM = { side: 2.454, ends: 2.41 }
/** A screen's width in millimetres: @3x points at 460 ppi (iPhone 17, Pro Max). */
const faceIdWidthMm = (s: Shape): number => ((s.w * 3) / 460) * 25.4
const SE_MM = { width: (750 / 326) * 25.4, side: 4.432, ends: 17.23, corner: 9.6 }

function body(s: Shape): Body {
  if (s.id === 'iphone-se') {
    const k = 1 / SE_MM.width
    return { side: SE_MM.side * k, top: SE_MM.ends * k, bottom: SE_MM.ends * k, corner: [SE_MM.corner * k, SE_MM.corner * k] }
  }
  const mm = faceIdWidthMm(s.id === 'reel' ? shapeById('iphone-17') : s)
  const side = FACE_ID_MM.side / mm
  const ends = FACE_ID_MM.ends / mm
  const r = s.radius / s.w
  return { side, top: ends, bottom: ends, corner: [r + side, r + ends] }
}

/** The whole phone's proportion, body included (width over height): what its slot sizes it by. */
export function deviceRatio(s: Shape): number {
  const b = body(s)
  return (1 + 2 * b.side) / (s.h / s.w + b.top + b.bottom)
}

/**
 * A shape as the CSS variables Phone.css and reel.css read on `.phone` and inherit below it: the screen's
 * proportion and corners, the body around it, the reel's box on the screen (it overhangs where Instagram trims it),
 * what of that box shows, and Instagram's insets in points. The body's borders are fractions of the body's width,
 * so the screen's margins (percentages of the same width) draw them at any size. The whole reel sets the same values
 * the stylesheet falls back to.
 */
export function shapeVars(s: Shape): CSSProperties {
  const { viewer, reel } = place(s)
  const clip = [viewer.y - reel.y, reel.x + reel.w - viewer.x - viewer.w, reel.y + reel.h - viewer.y - viewer.h, viewer.x - reel.x]
  const b = body(s)
  const w = 1 + 2 * b.side
  const h = s.h / s.w + b.top + b.bottom
  return {
    '--ratio': `${s.w} / ${s.h}`,
    '--radius': `${pct(s.radius / s.w)} / ${pct(s.radius / s.h)}`,
    '--bz-side': pct(b.side / w),
    '--bz-top': pct(b.top / w),
    '--bz-bottom': pct(b.bottom / w),
    '--radius-o': `${pct(b.corner[0] / w)} / ${pct(b.corner[1] / h)}`,
    '--sw': s.w,
    '--ig-top': s.top,
    '--ig-home': s.home,
    '--reel-l': pct(reel.x / s.w),
    '--reel-t': pct(reel.y / s.h),
    '--reel-w': pct(reel.w / s.w),
    '--reel-h': pct(reel.h / s.h),
    '--reel-clip': `inset(${clip.map((c, i) => pct(Math.max(0, c) / (i % 2 ? reel.w : reel.h))).join(' ')})`,
    // how far the reel's top sits above the screen's (Instagram trims it), for what is drawn from the reel's top edge
    '--reel-dip': `calc(${+Math.max(0, -reel.y).toFixed(3)} * 100cqw / ${s.w})`
  } as CSSProperties
}

/** Sizes the phone in `slot` to `height` (the slot's own, unless given) at `ratio`, the whole phone's width over height. */
export function fitPhone(slot: HTMLElement, ratio: number, height = slot.clientHeight): void {
  slot.style.setProperty('--phone-w', `${height * ratio}px`)
}

/**
 * Gives the phone inside it the full height it has, at its shape's proportion, body included. Its column takes its
 * width from the phone, so the width can only come from the height; a ResizeObserver writes it, on resize only,
 * without rendering. Without a shape, the whole reel's frame, which is what Phone.css draws without shapeVars.
 */
export function PhoneFill({ children, shape: s = shapeById('reel') }: { children: ReactNode; shape?: Shape }) {
  const slot = useRef<HTMLDivElement>(null)
  const ratio = deviceRatio(s)
  useLayoutEffect(() => {
    const el = slot.current!
    fitPhone(el, ratio)
    const ro = new ResizeObserver(([e]) => fitPhone(el, ratio, e.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ratio])
  return (
    <div className="phone-fill" ref={slot}>
      {children}
    </div>
  )
}

/**
 * A reel with no player controls (the onboarding sample), sized by its parent through `--phone-w`. `children` sit in
 * the reel's own box, under Instagram's screen; `over` sits on the whole screen, over it.
 */
export function Phone({
  shape: s,
  view,
  caption,
  className,
  children,
  over,
  testid
}: {
  shape: Shape
  view: PhoneView
  caption?: string
  className?: string
  children: ReactNode
  over?: ReactNode
  testid?: string
}) {
  return (
    <div className={`phone${className ? ` ${className}` : ''}`} style={shapeVars(s)} data-shape={s.id} data-testid="phone">
      <div className="phone-screen" data-testid={testid} data-lands>
        <div className="phone-reel">{children}</div>
        <InstagramChrome on={view === 'instagram'} caption={caption} />
        {over}
      </div>
    </div>
  )
}

/** Instagram or Clean, under the phone. */
const PHONE_VIEWS = [
  { key: 'instagram', label: 'Instagram', title: 'Your reel under Instagram’s buttons and caption', testid: 'view-instagram' },
  { key: 'clean', label: 'Clean', title: 'Your reel alone', testid: 'view-clean' }
] as const satisfies readonly { key: PhoneView; label: string; title: string; testid: string }[]

export function PhoneViewSwitch({ value, onChange }: { value: PhoneView; onChange: (v: PhoneView) => void }) {
  return <Segmented label="Phone view" testid="phone-view" value={value} options={PHONE_VIEWS} onPick={onChange} />
}

/**
 * Where subtitles stay clear of Instagram, shown while the person sets them up. On the whole reel these are the
 * edges the engine's own check uses (engine/reelengine/verify.py IG_TOP_FRAC, IG_BOTTOM_FRAC, IG_RIGHT_FRAC) and the
 * subtitle margin on the left (shared/caption-fit.ts MARGIN_FRAC), which Phone.css also falls back to. On a phone
 * shape it is what that phone leaves clear (phone-shapes.ts clearBand), which can be smaller.
 */
export function SafeBand({ shape: s }: { shape?: Shape }) {
  const band = s && clearBand(s)
  const style = s && band ? { left: pct(band.x / s.w), top: pct(band.y / s.h), width: pct(band.w / s.w), height: pct(band.h / s.h), right: 'auto', bottom: 'auto' } : undefined
  return (
    <div className="safe-band" style={style} data-testid="safe-band" aria-hidden>
      <span>Clear of Instagram</span>
    </div>
  )
}

// Lucide geometry (ISC), like components/icons.tsx, for the parts of Instagram's screen the shared set lacks.
function G({ size, children, fill }: { size: number; children: ReactNode; fill?: boolean }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  )
}
const camera = (
  <>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </>
)
const repost = (
  <>
    <path d="m2 9 3-3 3 3" />
    <path d="M13 18H7a2 2 0 0 1-2-2V6" />
    <path d="m22 15-3 3-3-3" />
    <path d="M11 6h6a2 2 0 0 1 2 2v10" />
  </>
)
const house = (
  <>
    <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
    <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </>
)
const search = (
  <>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </>
)

/** Instagram's Reels icon, selected (filled), as the tab bar shows it on the Reels screen. */
function ReelsTab() {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden>
      <rect x="2.5" y="2.5" width="19" height="19" rx="5.5" fill="currentColor" />
      <path d="M2.5 8.5h19M8 2.5l3 6M14 2.5l3 6" stroke="#000" strokeWidth={1.6} strokeLinecap="round" />
      <path d="M10 12.2v5.6l4.8-2.8z" fill="#000" />
    </svg>
  )
}

// The status bar's three glyphs, drawn in points (Phone.css sizes them): signal, Wi-Fi and a full battery.
const signal = (
  <svg className="sb-sig" viewBox="0 0 18 12" aria-hidden>
    <rect x="0" y="7.5" width="3.2" height="4.5" rx="1" />
    <rect x="4.9" y="5.2" width="3.2" height="6.8" rx="1" />
    <rect x="9.8" y="2.7" width="3.2" height="9.3" rx="1" />
    <rect x="14.7" y="0" width="3.2" height="12" rx="1" />
  </svg>
)
const wifi = (
  <svg className="sb-wifi" viewBox="0 0 16 11.6" aria-hidden>
    <g stroke="currentColor" strokeWidth=".6" strokeLinejoin="round">
      <path d="M.3 3.3A11 11 0 0 1 15.7 3.3L13.9 5.1A8.4 8.4 0 0 0 2.1 5.1Z" />
      <path d="M2.9 5.9A7.2 7.2 0 0 1 13.1 5.9L11.3 7.7A4.6 4.6 0 0 0 4.7 7.7Z" />
      <path d="M8 11.1 5.6 8.6A3.4 3.4 0 0 1 10.4 8.6Z" />
    </g>
  </svg>
)
const battery = (
  <svg className="sb-bat" viewBox="0 0 27 13" aria-hidden>
    <rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="currentColor" strokeOpacity=".4" />
    <rect x="2" y="2" width="20" height="9" rx="2.4" />
    <path d="M25 4.4c.9.3 1.5 1.1 1.5 2.1s-.6 1.8-1.5 2.1Z" fillOpacity=".4" />
  </svg>
)

/**
 * The phone's own status bar, which Instagram's Reels screen shows: 9:41, signal, Wi-Fi and battery, in white. On a
 * Face ID phone they sit either side of the Dynamic Island; on the SE the time is centred. Phone.css shows it only on
 * a phone shape, so the whole reel's frame stays the reel alone.
 */
function StatusBar() {
  return (
    <div className="igc-status">
      <span className="sb-l">
        {signal}
        {wifi}
      </span>
      <b className="sb-time">9:41</b>
      <span className="sb-r">
        {signal}
        {wifi}
        {battery}
      </span>
    </div>
  )
}

function CaptionLine({ text }: { text: string }) {
  const span = useRef<HTMLSpanElement>(null)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const el = span.current!
    const ro = new ResizeObserver(() => setCut(el.scrollWidth > el.clientWidth + 1))
    ro.observe(el)
    return () => ro.disconnect()
  }, [text])
  return (
    <div className="igc-cap">
      <span ref={span}>{text}</span>
      {cut && <em>more</em>}
    </div>
  )
}

/** Who posted the reel, on the preview: the connected Instagram account, else a label that is plainly not a handle. */
export interface PreviewAccount {
  handle: string
  picture?: string
}
export const NO_ACCOUNT: PreviewAccount = { handle: 'Your account' }

export function previewAccount(s: InstagramSession | null): PreviewAccount {
  return s?.connected ? { handle: s.username, ...(s.picture ? { picture: s.picture } : {}) } : NO_ACCOUNT
}

/** The connected account as this computer saved it: a local read, no request to Instagram. */
function usePreviewAccount(): PreviewAccount {
  const [account, setAccount] = useState(NO_ACCOUNT)
  useEffect(() => {
    let live = true
    reel.instagram
      .session()
      .then((s) => live && setAccount(previewAccount(s)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return account
}

/**
 * Instagram's Reels screen over the reel, in iOS points (Phone.css), with the phone's status bar and Home indicator
 * that show over it. Always on the page so switching views fades it rather than popping it; hidden from screen
 * readers, it is a picture of another app. `playing` runs the audio ticker, as Instagram does only while the reel plays.
 * It is the reel as the people who see it get it: posted by the connected account (or a placeholder), with Follow, and
 * the viewer's own profile in the tab bar. No counts: a reel has none before it is posted.
 */
export const InstagramChrome = memo(function InstagramChrome({ on, caption, playing }: { on: boolean; caption?: string; playing?: boolean }) {
  const text = caption?.trim()
  const account = usePreviewAccount()
  return (
    <div className={`igc${on ? '' : ' off'}`} data-playing={playing || undefined} data-testid="ig-overlay" aria-hidden>
      <StatusBar />
      <div className="igc-top">
        <b>Reels</b>
        <Icon name="chevron-down" size={16} stroke={2.5} />
        <span className="igc-cam">
          <G size={26}>{camera}</G>
        </span>
      </div>
      <div className="igc-rail">
        <span>
          <Icon name="heart" size={27} stroke={2} />
        </span>
        <span>
          <Icon name="comment" size={27} stroke={2} />
        </span>
        <span>
          <G size={27}>{repost}</G>
        </span>
        <span>
          <Icon name="send" size={27} stroke={2} />
        </span>
        <span>
          <Icon name="more" size={24} stroke={2.5} />
        </span>
        <i className="igc-disc" />
      </div>
      <div className="igc-meta">
        <div className="igc-who">
          {account.picture ? <img className="igc-avatar" src={account.picture} alt="" /> : <i className="igc-avatar" />}
          <b data-testid="ig-handle">{account.handle}</b>
          <span className="igc-follow">Follow</span>
        </div>
        {text && <CaptionLine text={text} />}
        <div className="igc-audio">
          <Icon name="music" size={12} stroke={2.5} />
          <div className="igc-tick">
            <div>
              <span>{account.handle} · Original audio</span>
              <span>{account.handle} · Original audio</span>
            </div>
          </div>
        </div>
      </div>
      <div className="igc-tabs">
        <G size={26}>{house}</G>
        <ReelsTab />
        <Icon name="send" size={26} stroke={2} />
        <G size={26}>{search}</G>
        <i className="igc-avatar" />
      </div>
      <i className="igc-home" />
    </div>
  )
})
