// My style only changes when the user says so (grandma 2: "I also saved this to My style" with nobody asking).
// The AI either PROPOSES rules (`styleSuggestions`, stream quality2) or, in older packages, already SAVED them
// (`styleRulesAdded`) and announced it in its reply. Either way the app turns them into a question,
// "Remember this for next time?", undoes any rule saved without asking, and drops the announcement.
// A typed rule (`proposal`, lowercase subtitles) is asked about the same way.
// My style records each answer, with what it did, in one write; the chat question is a view of that record.
// No Electron, no files: main passes in the app state and the AI.
import type { ChatMessage, RuleCheck, StyleAnswerStatus, StyleProposal, StyleQuestion, StyleRule } from '../shared/api'

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

// The AI package's sentence (ai/src/editor.ts withStyleEcho): "pause or forget ... there" now, "remove ... in Settings"
// from packages before My style had Pause and Forget.
const ECHO = /\s*I also saved (?:this|these) to My style for your future reels:[\s\S]*?You can (?:remove (?:it|them) in Settings|pause or forget (?:it|them) there)\./
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

/** The editor's reply into the chat, then one "Remember this for next time?" per rule, one per checked rule (`checks`,
 * whose words and number the app took from the finished reel), and one for a typed rule (`proposal`) the note's
 * change suggests. */
export function replyChat(c: StyleConsent, version?: number, proposal?: StyleProposal, checks: { text: string; check: RuleCheck }[] = []): ChatLine[] {
  const asked = new Set(checks.map((x) => normalize(x.text)))
  return [
    { from: 'editor', text: c.summary, version },
    ...c.suggestions
      .filter((rule) => !asked.has(normalize(rule)))
      .map((rule): ChatLine => ({ from: 'editor', text: rememberQuestion(rule), actions: ['remember-yes', 'remember-no'], suggestion: rule })),
    ...checks.map((x): ChatLine => ({ from: 'editor', text: rememberQuestion(x.text), actions: ['remember-yes', 'remember-no'], suggestion: x.text, check: x.check })),
    ...(proposal ? [{ from: 'editor', text: rememberQuestion(proposal.text), actions: ['remember-yes', 'remember-no'], proposal } satisfies ChatLine] : [])
  ]
}

/**
 * The editor's reply into the chat, then one "Remember this for next time?" per My style rule the AI proposed or saved.
 * A sentence the AI saved on its own is taken out again until the person says Yes; a typed rule was saved with their
 * Yes and stays. Taking one back is not the person refusing it, so learning may still suggest it (learning-loop).
 */
export async function askAboutStyle(
  d: { styleRules(): Promise<StyleRule[]>; removeStyleRule(id: string, options?: { forget?: boolean }): Promise<unknown> },
  r: { summary: string; version?: number; styleRulesAdded?: string[]; styleSuggestions?: string[]; styleProposal?: StyleProposal; styleChecks?: { text: string; check: RuleCheck }[] },
  summary: string
): Promise<{ summary: string; version?: number; chat: ChatLine[] }> {
  const c = styleConsent(summary, r.styleRulesAdded, r.styleSuggestions, r.styleProposal)
  if (c.undo.length) {
    const rules = await d.styleRules().catch((): StyleRule[] => [])
    for (const rule of rules) if (c.undo.includes(rule.text) && !rule.payload) await d.removeStyleRule(rule.id, { forget: false }).catch(() => undefined)
  }
  return { summary: c.summary, version: r.version, chat: replyChat(c, r.version, r.styleProposal, r.styleChecks) }
}

export interface AnswerDeps {
  chat(slug: string): Promise<ChatMessage[]>
  /** The reel's title, for where a rule was learned. */
  title(slug: string): Promise<string>
  answer?(q: StyleQuestion, yes: boolean): Promise<{ status: StyleAnswerStatus }>
  answerOf?(id: string): Promise<{ yes: boolean; status: StyleAnswerStatus } | null>
  /** Take the buttons off the question and add the editor's reply. */
  settle(slug: string, messageId: string, reply: string): Promise<void>
  serialized<T>(key: string, fn: () => Promise<T>): Promise<T>
}

const NOT_READY = { code: 'NOT_READY', userMessage: 'That could not be saved to My style. Try again later.' }
const NOT_SAVED = { code: 'NOT_SAVED', userMessage: 'That could not be saved to My style. Try again.' }

/** The note a question answers (the last one you sent before it) and the version it made, for My style's "Learned from". */
async function learnedFrom(d: AnswerDeps, slug: string, messageId: string): Promise<NonNullable<StyleRule['source']>> {
  const chat = await d.chat(slug)
  const before = chat.slice(0, chat.findIndex((x) => x.id === messageId))
  const note = before.filter((x) => x.from === 'you').pop()?.text
  const version = before.filter((x) => x.from === 'editor' && x.version !== undefined).pop()?.version ?? 0
  return { project: slug, title: await d.title(slug), version, ...(note ? { note } : {}) }
}

/** The question a chat message asks, as My style answers it, or null when it asks none. */
async function questionOf(d: AnswerDeps, slug: string, m: ChatMessage | undefined): Promise<StyleQuestion | null> {
  if (!m?.actions?.includes('remember-yes')) return null
  if (m.proposal) return { id: m.proposal.id, text: m.proposal.text, payload: m.proposal.payload, source: m.proposal.source }
  return m.suggestion ? { id: m.id, text: m.suggestion, source: await learnedFrom(d, slug, m.id), ...(m.check ? { check: m.check } : {}) } : null
}

/** What the editor says about an answer. */
function replyFor(q: StyleQuestion, status: StyleAnswerStatus): string {
  switch (status) {
    case 'saved':
      return q.payload
        ? 'Saved. Your next reels will start with lowercase subtitles. You can pause or forget it in My style.'
        : q.check
          ? "Saved. I'll check this on every new reel. You can pause or forget it in My style."
          : 'Saved. Your next reels get this too. You can pause or forget it in My style.'
    case 'exists':
      return 'That is already in My style.'
    case 'paused':
      return 'That is in My style, but paused. Turn it back on in My style to use it in your next reels.'
    case 'forgotten':
      return 'That was forgotten in My style, so it stays with this reel only.'
    case 'declined':
      return 'OK, only for this reel.'
  }
}

/** "Remember this for next time?" One write to My style records the answer and what it did; then the buttons are
 * replaced with the reply. A crash between the two leaves the answer recorded, and the next look at the chat shows the
 * question answered (showAnswered). One answer at a time per reel, so a double click answers and replies once. If
 * My style can't be written, the question stays, with its buttons, to try again. */
export function answerStyleQuestion(d: AnswerDeps, slug: string, messageId: string, yes: boolean): Promise<void> {
  return d.serialized(`style-answer:${slug}`, async () => {
    const q = await questionOf(d, slug, (await d.chat(slug)).find((x) => x.id === messageId))
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
      if (!m.actions?.includes('remember-yes')) continue
      const a = await d.answerOf(m.proposal?.id ?? m.id)
      const q = a && (await questionOf(d, slug, m))
      if (q && a) await d.settle(slug, m.id, replyFor(q, a.status))
    }
  })
}
