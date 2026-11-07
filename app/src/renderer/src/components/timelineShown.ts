// Whether the Reel screen shows its timeline: an app setting on this computer (main/settings.ts `timeline`), on until
// the person hides it with the Reel screen's button or View › Show Timeline (Shift+Cmd+T; Ctrl+Shift+T on Windows,
// which has no menu bar). Main saves every change, then tells each window (main/index.ts setTimeline); a change made
// here shows at once and goes back if the save fails. Read once at start-up, as the phone view is (Phone.tsx).
import { useSyncExternalStore } from 'react'
import { reel } from '../api'
import { IS_MAC } from './ui'

let shown = true
// what main last said is saved
let saved = true
let chosen = false
const listeners = new Set<() => void>()

function emit(next: boolean): void {
  if (next === shown) return
  // focus in the timeline would fall to the page as it goes: it lands on the button whose menu brings it back
  const inside = !next && !!(document.activeElement as HTMLElement | null)?.closest('.tl')
  // showing or hiding is instant: the phone changes size at once, and a fade on the items would lag behind it
  document.documentElement.classList.add('tl-instant')
  shown = next
  for (const l of listeners) l()
  requestAnimationFrame(() => {
    document.documentElement.classList.remove('tl-instant')
    // the timeline's own switch lives in the View menu under the phone: focus waits on that menu's button
    if (inside) document.querySelector<HTMLElement>('[data-testid="view-menu"]')?.focus()
  })
}

function choose(next: boolean): Promise<unknown> {
  chosen = true
  emit(next)
  return reel.app.setTimeline(next).catch((e) => {
    emit(saved)
    throw e
  })
}

// A choice made before the setting answers wins.
void reel.app.info().then((i) => {
  saved = i.timeline
  if (!chosen) emit(i.timeline)
})
reel.app.onCommand((c) => {
  if (c.type !== 'timeline') return
  saved = c.shown
  chosen = true
  emit(c.shown)
})
if (!IS_MAC)
  window.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 't') return
    // typing keeps its own keys
    const t = e.target as HTMLElement | null
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
    e.preventDefault()
    // a failed save has already put it back; there is no screen of its own to say so on
    void choose(!shown).catch(() => undefined)
  })

export const TIMELINE_SHORTCUT = IS_MAC ? '⇧⌘T' : 'Ctrl+Shift+T'

/** Shown or not, and a setter that saves it. The setter's promise rejects when the setting could not be saved. */
export function useTimelineShown(): [boolean, (next: boolean) => Promise<unknown>] {
  const v = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => shown
  )
  return [v, choose]
}
