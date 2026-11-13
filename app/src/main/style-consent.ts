// My style only changes when the user says so (grandma 2: "I also saved this to My style" with nobody asking).
// The AI either PROPOSES rules (`styleSuggestions`, stream quality2) or, in older packages, already SAVED them
// (`styleRulesAdded`) and announced it in its reply. Either way the app turns them into a question,
// "Remember this for next time?", undoes any rule saved without asking, and drops the announcement.
// Pure: no Electron, no files.
import type { ChatMessage } from '../shared/api'

/** A chat message before it gets its id and time (store.ts). */
export type ChatLine = Omit<ChatMessage, 'id' | 'at'>

export interface StyleConsent {
  /** The reply without "I also saved this to My style ..." / "I'll remember that for next time." */
  summary: string
  /** Ask about each of these. */
  suggestions: string[]
  /** Rules the AI saved without asking: remove them from My style now. */
  undo: string[]
}

const ECHO = /\s*I also saved (?:this|these) to My style for your future videos:[\s\S]*?You can remove (?:it|them) in Settings\./
const REMEMBER = /\s*I(?:'| wi)ll remember (?:that|this) (?:for next time|for your next videos?|next time)\./gi

export function styleConsent(summary: string, saved: string[] = [], suggested?: string[]): StyleConsent {
  // anything already saved is undone (asked instead); proposals are only asked
  const undo = [...new Set(saved.filter((t) => t && t.trim()))]
  const suggestions = [...new Set([...(suggested ?? []), ...saved].map((t) => t.trim()).filter(Boolean))]
  if (!suggestions.length && !undo.length) return { summary, suggestions, undo }
  const text = summary.replace(ECHO, '').replace(REMEMBER, '').replace(/\s{2,}/g, ' ').trim()
  return { summary: text || summary, suggestions, undo }
}

export const rememberQuestion = (rule: string): string => `Remember this for next time? "${rule.replace(/^"|"$/g, '')}"`

/** The editor's reply into the chat, then one "Remember this for next time?" per rule. */
export function replyChat(c: StyleConsent, version: number): ChatLine[] {
  return [
    { from: 'editor', text: c.summary, version },
    ...c.suggestions.map((rule): ChatLine => ({ from: 'editor', text: rememberQuestion(rule), actions: ['remember-yes', 'remember-no'], suggestion: rule }))
  ]
}
