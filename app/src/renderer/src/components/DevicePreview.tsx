// "See it on": the Reel screen's phone in the shape of a real phone (shared/devices.ts), with the reel placed
// the way Instagram places it there and, with Instagram view on, the parts Instagram's buttons, caption and
// top bar cover. "Any phone" is the plain phone the app always had; it is the default.
import { useState, type CSSProperties, type ReactNode } from 'react'
import { DEVICES, coveredZones, fitWords, menuBar, placeReel, type Device, type Rect } from '../../../shared/devices'
import './DevicePreview.css'

// Lucide "smartphone" (ISC), like components/icons.tsx; kept here so the shared icon set stays as it is.
function PhoneIcon() {
  return (
    <svg className="icon" width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </svg>
  )
}

const KEY = 'rs.device'
const ANY = 'any'

function remembered(): string {
  const id = localStorage.getItem(KEY)
  return id && DEVICES.some((d) => d.id === id) ? id : ANY
}

const pct = (n: number): string => `${+(n * 100).toFixed(3)}%`

/** A rectangle in screen points as CSS percentages of the screen. */
function box(r: Rect, d: Device): CSSProperties {
  return { left: pct(r.x / d.screen.w), top: pct(r.y / d.screen.h), width: pct(r.w / d.screen.w), height: pct(r.h / d.screen.h) }
}

/** The phone's numbers for DevicePreview.css: everything is a fraction of the screen, so it draws at any size. */
function frameVars(d: Device): CSSProperties {
  // The video element is the viewer; object-fit: cover trims the reel exactly as placeReel() works it out.
  const { viewer, video } = placeReel(d)
  return {
    '--dev-ratio': d.screen.w / d.screen.h,
    '--dev-radius': d.radius / d.screen.h,
    '--dev-chin': d.chin,
    '--dev-viewer-left': pct(viewer.x / d.screen.w),
    '--dev-viewer-top': pct(viewer.y / d.screen.h),
    '--dev-viewer-w': pct(viewer.w / d.screen.w),
    '--dev-viewer-h': pct(viewer.h / d.screen.h),
    // how much bigger the reel is drawn than the screen is wide, when Instagram trims its sides
    '--dev-reel-scale': video.w / d.screen.w
  } as CSSProperties
}

const ZONE_LABEL = { top: 'Top bar', buttons: 'Buttons', caption: 'Name and caption' } as const

export function DevicePreview({ instagram, caption, children }: { instagram?: boolean; caption?: string; children: ReactNode }) {
  const [id, setId] = useState(remembered)
  const device = DEVICES.find((d) => d.id === id)

  return (
    <>
      <div className="device-frame" data-device={id} style={device ? frameVars(device) : undefined} data-testid="device-frame">
        {children}
        {device && (
          <div className="device-layer" data-testid="device-layer" aria-hidden>
            <div className="ig-menu" style={box(menuBar(device), device)}>
              {[0, 1, 2, 3, 4].map((i) => (
                <i key={i} />
              ))}
            </div>
            {instagram && (
              <div className="device-covered" data-testid="device-covered">
                {coveredZones(device).map((z) => (
                  <div key={z.kind} className={`zone zone-${z.kind}`} style={box(z.rect, device)} data-testid={`zone-${z.kind}`}>
                    <span>{ZONE_LABEL[z.kind]}</span>
                    {z.kind === 'caption' && caption?.trim() && <em>{caption.trim()}</em>}
                  </div>
                ))}
              </div>
            )}
            {device.island && <div className="island" style={box(device.island, device)} />}
          </div>
        )}
        {device?.homeButton && <div className="home-button" aria-hidden />}
      </div>
      <div className="device-pick">
        <div className="device-select">
          <PhoneIcon />
          <span aria-hidden>
            See it on <b>{device?.label ?? 'Any phone'}</b>
          </span>
          <select
            aria-label="See it on"
            value={id}
            onChange={(e) => {
              localStorage.setItem(KEY, e.target.value)
              setId(e.target.value)
            }}
            aria-describedby={device ? 'device-fit' : undefined}
            data-testid="device-pick"
          >
            <option value={ANY}>Any phone</option>
            {DEVICES.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        {device && (
          <p className="device-fit" id="device-fit" data-testid="device-fit">
            {fitWords(device)}
          </p>
        )}
      </div>
    </>
  )
}
