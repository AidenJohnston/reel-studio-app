// My style only changes when the user says so (grandma 2: "I also saved this to My style" with nobody asking).
// The AI either PROPOSES rules (`styleSuggestions`, stream quality2) or, in older packages, already SAVED them
// (`styleRulesAdded`) and announced it in its reply. Either way the app turns them into a question,
// "Remember this for next time?", undoes any rule saved without asking, and drops the announcement.
// A typed rule (`proposal`, lowercase captions) is asked about the same way and saved with its own consent.
// My style records each answer, with what it did, in one write; the chat question is a view of that record.
// No Electron, no files: main passes in the app state and the AI.
import type { ChatMessage, StyleAnswerStatus, StyleProposal, StyleQuestion } from '../shared/api'

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
  answer?(q: StyleQuestion, yes: boolean): Promise<{ status: StyleAnswerStatus }>
  answerOf?(id: string): Promise<{ yes: boolean; status: StyleAnswerStatus } | null>
  /** Take the buttons off the question and add the editor's reply. */
  settle(slug: string, messageId: string, reply: string): Promise<void>
  serialized<T>(key: string, fn: () => Promise<T>): Promise<T>
}

const NOT_READY = { code: 'NOT_READY', userMessage: 'I could not save that to My style. Try again later.' }
const NOT_SAVED = { code: 'NOT_SAVED', userMessage: 'I could not save that to My style. Try again.' }

/** The question a chat message asks, as My style answers it, or null when it asks none. */
function questionOf(m: ChatMessage | undefined): StyleQuestion | null {
  if (!m?.actions?.includes('remember-yes')) return null
  if (m.proposal) return { id: m.proposal.id, text: m.proposal.text, payload: m.proposal.payload, source: m.proposal.source }
  return m.suggestion ? { id: m.id, text: m.suggestion, ...(m.check ? { check: m.check } : {}) } : null
}

/** What the editor says about an answer. */
function replyFor(q: StyleQuestion, status: StyleAnswerStatus): string {
  switch (status) {
    case 'saved':
      return q.payload
        ? 'Saved. Your next videos will start with lowercase captions. You can change or remove it in My style.'
        : q.check
          ? "Saved. I'll check this on every video from now on. You can pause or remove it in My style."
          : "Saved. I'll do that in your next videos too. You can remove it in My style."
    case 'exists':
      return 'That is already in My style.'
    case 'paused':
      return 'That is in My style, but paused. Turn it back on in My style to use it in your next videos.'
    case 'forgotten':
      return 'You removed that from My style, so it stays with this video only.'
    case 'declined':
      return 'OK, only for this video.'
  }
}

/** "Remember this for next time?" One write to My style records the answer and what it did; then the buttons are
 * replaced with the reply. A crash between the two leaves the answer recorded, and the next look at the chat shows the
 * question answered (showAnswered). One answer at a time per video, so a double click answers and replies once. If
 * My style can't be written, the question stays, with its buttons, to try again. */
export function answerStyleQuestion(d: AnswerDeps, slug: string, messageId: string, yes: boolean): Promise<void> {
  return d.serialized(`style-answer:${slug}`, async () => {
    const q = questionOf((await d.chat(slug)).find((x) => x.id === messageId))
    if (!q) return
    if (!d.answer) throw NOT_READY
    const r = await d.answer(q, yes).catch(() => {
      throw NOT_SAVED
    })
    await d.settle(slug, messageId, replyFor(q, r.status))
  })
}

/** The chat as a view of My style's record: every question still showing its buttons whose answer My style has
 * recorded (its reply was cut off) is shown answered, with the reply for what that answer did. */
export function showAnswered(d: AnswerDeps, slug: string): Promise<void> {
  return d.serialized(`style-answer:${slug}`, async () => {
    if (!d.answerOf) return
    for (const m of await d.chat(slug)) {
      const q = questionOf(m)
      const a = q && (await d.answerOf(q.id))
      if (q && a) await d.settle(slug, m.id, replyFor(q, a.status))
    }
  })
}
