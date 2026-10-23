// My style only changes when the user says so (grandma 2: "I also saved this to My style" with nobody asking).
// The AI either PROPOSES rules (`styleSuggestions`, stream quality2) or, in older packages, already SAVED them
// (`styleRulesAdded`) and announced it in its reply. Either way the app turns them into a question,
// "Remember this for next time?", undoes any rule saved without asking, and drops the announcement.
// A typed rule (`proposal`, lowercase captions) is asked about the same way and saved with its own consent.
// No Electron, no files: main passes in the app state and the AI.
import type { ChatMessage, StyleProposal } from '../shared/api'

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

/** The comparison StyleStore.approve uses (ai/src/style.ts) to tell that two rules say the same thing. */
const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

/** `typed`: the note also gets a typed question. The AI's own sentence with the same words is not asked twice;
 * any other sentence, even one about lowercase, is asked as usual. */
export function styleConsent(summary: string, saved: string[] = [], suggested?: string[], typed?: StyleProposal): StyleConsent {
  // anything already saved is undone (asked instead); proposals are only asked
  const undo = [...new Set(saved.filter((t) => t && t.trim()))]
  const same = (t: string): boolean => !!typed && normalize(t) === normalize(typed.text)
  const suggestions = [...new Set([...(suggested ?? []), ...saved].map((t) => t.trim()).filter((t) => t && !same(t)))]
  if (!suggestions.length && !undo.length && !typed) return { summary, suggestions, undo }
  const text = summary.replace(ECHO, '').replace(REMEMBER, '').replace(/\s{2,}/g, ' ').trim()
  return { summary: text || summary, suggestions, undo }
}

export const rememberQuestion = (rule: string): string => `Remember this for next time? "${rule.replace(/^"|"$/g, '')}"`

export interface AnswerDeps {
  chat(slug: string): Promise<ChatMessage[]>
  addStyleRule?(text: string): Promise<unknown>
  approveStyleProposal?(p: StyleProposal): Promise<{ status: 'saved' | 'exists' | 'forgotten' }>
  declineStyleProposal?(p: StyleProposal): Promise<void>
  /** Take the buttons off the question and add the editor's reply. */
  settle(slug: string, messageId: string, reply: string): Promise<void>
  serialized<T>(key: string, fn: () => Promise<T>): Promise<T>
}

const NOT_READY = { code: 'NOT_READY', userMessage: 'I could not save that to My style. Try again later.' }
const NOT_SAVED = { code: 'NOT_SAVED', userMessage: 'I could not save that to My style. Try again.' }
const TYPED_REPLY = {
  saved: 'Saved. Your next videos will start with lowercase captions. You can change or remove it in My style.',
  exists: 'That is already in My style.',
  forgotten: 'You removed that from My style, so it stays with this video only.'
}

/** "Remember this for next time?" Yes saves the rule; either answer replaces the buttons with a plain reply.
 * One answer at a time per video, so a double click saves and replies once. The reply comes only after the
 * rule is safely saved; if saving fails the question stays, with its buttons, to try again. */
export function answerStyleQuestion(d: AnswerDeps, slug: string, messageId: string, yes: boolean): Promise<void> {
  return d.serialized(`style-answer:${slug}`, async () => {
    const m = (await d.chat(slug)).find((x) => x.id === messageId)
    if (!(m?.suggestion || m?.proposal) || !m.actions?.includes('remember-yes')) return
    let reply = yes ? "Saved. I'll do that in your next videos too. You can remove it in My style." : 'OK, only for this video.'
    if (yes && m.proposal) {
      if (!d.approveStyleProposal) throw NOT_READY
      const r = await d.approveStyleProposal(m.proposal).catch(() => {
        throw NOT_SAVED
      })
      reply = TYPED_REPLY[r.status]
    } else if (yes) {
      if (!d.addStyleRule) throw NOT_READY
      await d.addStyleRule(m.suggestion!)
    } else if (m.proposal && d.declineStyleProposal) {
      // a Yes saved just before a crash, then No: the No wins
      await d.declineStyleProposal(m.proposal).catch(() => {
        throw NOT_SAVED
      })
    }
    await d.settle(slug, messageId, reply)
  })
}
