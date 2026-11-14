// Full screen on the Reel screen: the phone leaves the page for a dark stage over the whole window, as tall as the
// window leaves once its controls sit under it: play, the scrub bar and the time, then speed, the view, the phone
// shape and Exit (brief rule 1: controls sit with what they control). F or the transport row's button opens it;
// F, Esc or Exit closes it, and focus goes back to what had it.
//
// It is the window, not the display: macOS full screen opens a new Space with a slow slide, and the page Fullscreen
// API hung on Electron 44 after the window had been full screen (fullscreen-preview, a85966c). The window's own full
// screen (Ctrl+Cmd+F, the green button) still works with the stage open, and the stage then fills the display.
//
// The phone is the same element in both places: the stage restyles its slot (preview.css), so the video keeps
// playing, at its speed and moment, with nothing handed over and nothing re-rendered per frame.
import { useEffect, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { clock } from '../../../shared/progress'
import type { Shape } from '../../../shared/phone-shapes'
import { EXPORT_EVENT } from '../App'
import { reel } from '../api'
import { Icon } from './icons'
import { IconButton } from './ui'
import { byKeyboard, reducedMotion, usePresence } from './motion'
import { deviceRatio, fitPhone } from './Phone'
import { ScrubRange, textField } from './Player'
import { usePlayhead, type Playhead } from './playhead'
import { ShapeMenu, SpeedMenu } from './PreviewControls'
import { useTransport, type Transport } from './transport'
import './preview.css'

// Entering moves the phone from its place to the stage; leaving is a little quicker, as the system answering.
const ENTER_MS = 220
const LEAVE_MS = 180

/** Makes every element outside `inside` inert, a toast and the status line excepted (data-over-dialogs). Returns the undo. */
function inertOutside(inside: HTMLElement): () => void {
  const made: HTMLElement[] = []
  for (let branch: HTMLElement | null = inside; branch?.parentElement; branch = branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling instanceof HTMLElement && sibling !== branch && !sibling.inert && !sibling.hasAttribute('data-over-dialogs')) {
        sibling.inert = true
        made.push(sibling)
      }
    }
  }
  return () => {
    for (const el of made) el.inert = false
  }
}

/** Moves `el` from where it was (`from`) to where it is now, transform only, on the app's --ease-out. */
function glide(el: HTMLElement, from: DOMRect, ms: number): void {
  // a glide still running (opened and closed within its time) would skew where the phone now is
  for (const a of el.getAnimations()) a.cancel()
  const to = el.getBoundingClientRect()
  if (!to.width || !from.width) return
  const dx = from.left + from.width / 2 - (to.left + to.width / 2)
  const dy = from.top + from.height / 2 - (to.top + to.height / 2)
  const easing = getComputedStyle(document.documentElement).getPropertyValue('--ease-out').trim() || 'ease-out'
  el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width})` }, { transform: 'none' }], { duration: ms, easing })
}

export function FullStage({
  open,
  onOpenChange,
  enabled,
  shape,
  transport,
  playhead,
  view,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** F does nothing while false (no video yet). */
  enabled: boolean
  shape: Shape
  transport: Transport
  playhead: Playhead
  /** Instagram or Clean, the same switch as under the phone. */
  view: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const from = useRef<HTMLElement | null>(null)
  // the backdrop stays for its fade out, and the phone stays above it while it glides back
  const { mounted } = usePresence(open, LEAVE_MS)
  const leaving = !open && mounted
  const shown = useRef(false)
  // the caller's handler may be a new function each render; the listeners below read the latest
  const change = useRef(onOpenChange)
  change.current = onOpenChange
  const giveBack = useRef<(() => void) | null>(null)

  // F toggles; Esc leaves, before anything else on the page hears it (an open menu in the stage keeps its own Esc).
  // Cmd/Ctrl+Z stops here too: the edit panel behind the stage is out of sight, and its undo would drop edits nobody
  // sees go (#133, c8c003c4). Share's Cmd/Ctrl+E still gets through, and the stage steps aside for it.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop')) return
      if (e.key === 'Escape' && open) {
        if ((e.target as HTMLElement | null)?.closest?.('[role=menu]')) return
        e.preventDefault()
        e.stopPropagation()
        change.current(false)
      } else if (open && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        e.stopPropagation()
      } else if (e.key.toLowerCase() === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && !textField(e.target) && (enabled || open)) {
        e.preventDefault()
        change.current(!open)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [open, enabled])

  // Windows and Linux draw the window buttons over the page in one colour, dark by default: white on the stage's dark
  // while it is open, then dark again (macOS ignores it: its traffic lights have their own colours).
  useEffect(() => {
    if (!open) return
    void reel.app.titleBarOnStage(true).catch(() => undefined)
    return () => void reel.app.titleBarOnStage(false).catch(() => undefined)
  }, [open])

  // Saving or exporting shows its own sheet on the page: the stage steps aside for it.
  useEffect(() => {
    if (!open) return
    const away = () => change.current(false)
    window.addEventListener(EXPORT_EVENT, away)
    return () => window.removeEventListener(EXPORT_EVENT, away)
  }, [open])

  // The switch itself, before paint: where the phone was, the restyle, where it is now, then the glide between.
  useLayoutEffect(() => {
    const stage = ref.current
    const phone = stage?.querySelector<HTMLElement>('.phone')
    if (!stage || open === shown.current) return
    shown.current = open
    const before = phone?.getBoundingClientRect()
    const still = byKeyboard() || reducedMotion()
    if (open) {
      from.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
      stage.dataset.full = ''
      giveBack.current = inertOutside(stage)
      stage.querySelector<HTMLElement>('.stage-dock .pp')?.focus({ preventScroll: true })
      if (phone && before && !still) glide(phone, before, ENTER_MS)
      return
    }
    delete stage.dataset.full
    // the page comes back before focus returns to it: an inert element cannot take focus
    giveBack.current?.()
    giveBack.current = null
    // the slot's width was last written for the stage; size it for the page now, as its observer will after paint
    const slot = phone?.parentElement
    if (slot) fitPhone(slot, deviceRatio(shape))
    const back = from.current?.isConnected ? from.current : stage.closest('.stage')?.querySelector<HTMLElement>('[data-testid="full-screen"]')
    back?.focus({ preventScroll: true })
    from.current = null
    if (phone && before && !still) glide(phone, before, LEAVE_MS)
  }, [open, shape])

  // leaving the Reel screen with the stage open
  useEffect(() => () => giveBack.current?.(), [])

  return (
    <>
    {/* keeps the phone's place on the page while it is on the stage, so the timeline under it does not jump up */}
    {open && <div className="stage-hold" aria-hidden />}
    <div
      ref={ref}
      className="stage-v"
      style={{ '--ratio-n': deviceRatio(shape) } as CSSProperties}
      data-leaving={leaving || undefined}
      role={open ? 'dialog' : undefined}
      aria-modal={open || undefined}
      aria-label={open ? 'Your reel, full screen' : undefined}
      data-testid={open ? 'full-stage' : undefined}
    >
      {(open || mounted) && <div className={`stage-backdrop${open ? '' : ' leave'}`} aria-hidden />}
      {children}
      {open && <Dock transport={transport} playhead={playhead} view={view} onExit={() => onOpenChange(false)} />}
    </div>
    </>
  )
}

/**
 * Under the phone, centred and no wider: play, the scrub bar and the time on one row, then speed, the view, the phone
 * shape and Exit, which sits where the full-screen button was in the transport row.
 */
function Dock({ transport, playhead, view, onExit }: { transport: Transport; playhead: Playhead; view: ReactNode; onExit: () => void }) {
  const { playing, duration } = useTransport(transport)
  const second = usePlayhead(playhead, Math.floor)
  return (
    <div className="stage-dock" data-testid="stage-dock">
      <div className="stage-row">
        <button type="button" className="pp" onClick={() => transport.toggle()} aria-label={playing ? 'Pause' : 'Play'} data-testid="stage-play">
          <Icon name={playing ? 'pause' : 'play'} size={14} stroke={2} />
        </button>
        <div className="stage-scrub">
          <ScrubRange playhead={playhead} dur={duration} onSeek={(t) => transport.seek(t)} />
        </div>
        <span className="tc">
          {clock(second)} <span>/ {clock(duration)}</span>
        </span>
      </div>
      <div className="stage-row view">
        <SpeedMenu transport={transport} side="right" />
        {view}
        <ShapeMenu side="right" />
        <IconButton icon="exit-fullscreen" label="Exit full screen" shortcut="Esc" aria-keyshortcuts="Escape" onDark onClick={onExit} data-testid="exit-full-screen" />
      </div>
    </div>
  )
}
