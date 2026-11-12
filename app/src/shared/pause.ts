// "Paused without you" (ux-foundation-b.md sections 3.4 and 7): work stopped by something outside the person, a plan
// at its limit, no internet, the computer asleep, or a quit, that continues on its own. How it is said, on a card and
// in the reel's log. Keep free of Node and DOM imports.
import type { PausedFor } from './api'

const clockTime = (d: Date): string => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** "at 3:40 PM" today, "tomorrow", or the weekday: short enough for a card's one line. */
function when(iso: string, now: Date): string {
  const d = new Date(iso)
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(now.toDateString()).getTime()) / 86_400_000)
  if (days <= 0) return `at ${clockTime(d)}`
  return days === 1 ? 'tomorrow' : d.toLocaleDateString([], { weekday: 'long' })
}

/** A card's meta line: when it continues, or what it waits for. */
export function pausedWords(p: PausedFor, now: Date, computer: string): string {
  switch (p.reason) {
    case 'limit':
      return p.until ? `Continues ${when(p.until, now)}` : 'Continues when your plan resets'
    case 'offline':
      return 'Waiting for internet'
    case 'sleep':
      return `Continues when your ${computer} wakes`
    case 'quit':
      return 'Continues when Reel Studio opens'
  }
}

/**
 * A paused reel's card on Reels: why it stopped and what happens next, short enough for two lines of a narrow card.
 * `p` null: the person stopped it, and only Resume continues it.
 */
export function pauseLine(p: PausedFor | null, now: Date, computer: string): { why: string; next: string } {
  if (!p) return { why: 'You paused it', next: 'resumes where it stopped' }
  switch (p.reason) {
    case 'limit':
      return { why: p.editor ? `${p.editor} plan limit` : 'Plan limit', next: p.until ? `continues ${when(p.until, now)}` : 'continues when it resets' }
    case 'offline':
      return { why: 'No internet', next: 'continues once online' }
    case 'sleep':
      return { why: `Your ${computer} slept`, next: 'continues when it wakes' }
    case 'quit':
      return { why: 'Reel Studio closed', next: 'continuing now' }
  }
}

/** The reel's log: why it stopped, and when it goes on. Names the editor's plan when it is known. */
export function pausedSentence(p: PausedFor, now: Date, computer: string): string {
  switch (p.reason) {
    case 'limit': {
      const plan = p.editor ? `Your ${p.editor} plan` : 'Your plan'
      return `${plan} is at its limit, so this continues when it resets${p.until ? ` ${when(p.until, now)}` : ''}.`
    }
    case 'offline':
      return "There's no internet, so this continues when you're back online."
    case 'sleep':
      return `Your ${computer} went to sleep, so this continues when it wakes.`
    case 'quit':
      return 'Reel Studio closed while this was being made, so it continues now.'
  }
}
