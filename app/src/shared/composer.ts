// What the note box says and which moment a note carries. Keep free of Node and DOM imports.

/** "here", "this", "now": the note means what is on screen. "This reel" or "this video" means the whole reel. */
const ON_SCREEN = /\b(?:here|now|this(?!\s+(?:reel|video|version|whole)\b))\b/i

export const pointsAtScreen = (text: string): boolean => ON_SCREEN.test(text)

/**
 * The moment a note goes out with. One the person set (a range, a spot, a click on the offer) wins. Otherwise the
 * playhead, when the moment was attached by itself (`auto`: they paused, scrubbed or pressed C since their last
 * note) or the note says "here", "this" or "now". null: the note is about the whole reel.
 */
export function momentToSend<C extends { at: number }>(chip: C | null, o: { auto: boolean; text: string; at: number }): C | { at: number } | null {
  if (chip) return chip
  return o.auto || pointsAtScreen(o.text) ? { at: o.at } : null
}

/** The note box's placeholder. Short enough for one line beside the moment chip at the narrowest column. */
export function notePlaceholder(s: {
  /** a reel with no video yet: the planning chat */
  planned: boolean
  hasPlan: boolean
  /** planning: the editor is answering now */
  answering: boolean
  /** planning: the editor's last turn was a question */
  asking: boolean
  hasVersions: boolean
  /** a version is being made */
  making: boolean
  /** something else runs on the reel (Share's export, a look for more reels): notes wait for it too */
  busy: boolean
  /** the keys that add a note to the version being made instead (Add now), while a note makes it */
  addKeys?: string
  /** the older version the next note changes (Versions > Change this one) */
  base?: number
}): string {
  if (s.planned) return s.answering ? 'Your editor is answering…' : s.asking ? 'Answer, or tell your editor more…' : s.hasPlan ? 'Ask your editor for a change…' : "What's this reel about?"
  if (!s.hasVersions) return 'Notes you send now wait for Version 1…'
  if (s.making) return s.addKeys ? `Waits for this version, or ${s.addKeys} adds it now…` : 'Waits for this version…'
  if (s.busy) return 'Waits for this to finish…'
  return s.base !== undefined ? `Tell your editor what to change in Version ${s.base}…` : 'Tell your editor…'
}
