import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, StyleAnswerStatus, StyleProposal, StyleQuestion } from '../src/shared/api'
import { createMockAI } from '../src/main/ai-mock'
import { serialized } from '../src/main/store'
import { answerStyleQuestion, rememberQuestion, showAnswered, styleConsent, type AnswerDeps } from '../src/main/style-consent'

describe('My style consent (grandma 2: saved without asking)', () => {
  it('an AI that already saved a rule: undo it, drop the announcement, ask instead', () => {
    const summary =
      'I turned the music down at the start so your voice comes through clearly. I\'ll remember that for next time. I also saved this to My style for your future videos: "Keep music quieter under talking." You can remove it in Settings.'
    const c = styleConsent(summary, ['Keep music quieter under talking.'])
    expect(c.summary).toBe('I turned the music down at the start so your voice comes through clearly.')
    expect(c.undo).toEqual(['Keep music quieter under talking.'])
    expect(c.suggestions).toEqual(['Keep music quieter under talking.'])
    expect(rememberQuestion(c.suggestions[0])).toBe('Remember this for next time? "Keep music quieter under talking."')
  })

  it('an AI that only proposes (styleSuggestions): nothing to undo', () => {
    const c = styleConsent('I made the captions smaller.', [], ['Smaller captions'])
    expect(c).toEqual({ summary: 'I made the captions smaller.', suggestions: ['Smaller captions'], undo: [] })
  })

  it('the quality2 shape: styleSuggestions always present (often []), nothing saved', () => {
    expect(styleConsent('I made the captions a bit smaller.', [], [])).toEqual({ summary: 'I made the captions a bit smaller.', suggestions: [], undo: [] })
    // mixed (a rule saved anyway): still undone and asked, once
    expect(styleConsent('x', ['A'], ['A', 'B'])).toEqual({ summary: 'x', suggestions: ['A', 'B'], undo: ['A'] })
  })

  it('no rules: the reply is untouched', () => {
    expect(styleConsent('I made the captions a bit smaller.')).toEqual({ summary: 'I made the captions a bit smaller.', suggestions: [], undo: [] })
  })
})

describe('answering a typed My style question (lowercase captions)', () => {
  const proposal: StyleProposal = {
    id: 'q-1',
    text: 'Use lowercase captions.',
    payload: { kind: 'caption-case', case: 'lower' },
    source: { project: 'p1', title: 'Baking bread', version: 3 }
  }
  function app(approve: (q: StyleQuestion) => Promise<{ status: StyleAnswerStatus }>) {
    const chat: ChatMessage[] = [
      { id: 'm1', from: 'editor', text: rememberQuestion(proposal.text), at: '', actions: ['remember-yes', 'remember-no'], proposal }
    ]
    const deps: AnswerDeps = {
      chat: async () => structuredClone(chat),
      answer: (q, yes) => (yes ? approve(q) : Promise.resolve({ status: 'declined' as const })),
      settle: async (_slug, id, reply) => {
        await new Promise((r) => setTimeout(r, 5))
        delete chat.find((m) => m.id === id)!.actions
        chat.push({ id: `r${chat.length}`, from: 'editor', text: reply, at: '' })
      },
      serialized
    }
    return { chat, answer: (yes = true) => answerStyleQuestion(deps, 'bread', 'm1', yes) }
  }

  it("the AI's own copy of the typed rule is asked once, and its other lowercase rules are still asked", () => {
    // "make the captions lowercase and remember to keep hashtags lowercase in the post", with an AI that saved both
    const c = styleConsent('I made the captions lowercase.', ['Use lowercase captions.', 'Keep hashtags lowercase in the post.'], undefined, proposal)
    expect(c.suggestions).toEqual(['Keep hashtags lowercase in the post.'])
    expect(c.undo).toEqual(['Use lowercase captions.', 'Keep hashtags lowercase in the post.'])
  })

  it('Yes on a rule paused in My style says it stays paused there', async () => {
    const { chat, answer } = app(async () => ({ status: 'paused' }))
    await answer()
    expect(chat.at(-1)?.text).toBe('That is in My style, but paused. Turn it back on in My style to use it in your next videos.')
  })

  it('a double click on Yes saves and replies once', async () => {
    const { chat, answer } = app(async () => ({ status: 'saved' }))
    await Promise.all([answer(), answer()])
    expect(chat.filter((m) => m.text.startsWith('Saved.'))).toHaveLength(1)
  })

  it('a save that fails keeps the question and its buttons, says nothing was saved, and Yes again works', async () => {
    let fail = true
    const { chat, answer } = app(async () => {
      if (fail) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      return { status: 'saved' }
    })
    await expect(answer()).rejects.toMatchObject({ userMessage: 'I could not save that to My style. Try again.' })
    expect(chat).toHaveLength(1)
    expect(chat[0].actions).toEqual(['remember-yes', 'remember-no'])
    fail = false
    await answer()
    expect(chat.at(-1)?.text).toBe('Saved. Your next videos will start with lowercase captions. You can change or remove it in My style.')
  })

})

describe('a question killed between the My style write and the chat write', () => {
  // One question of each kind: the typed lowercase rule, a sentence the AI reads, and a rule the app measures (which
  // replaces the saved rule checking the same kind: "at most 2 words" gives way to "at most 3").
  const proposal: StyleProposal = { id: 'q-typed', text: 'Use lowercase captions.', payload: { kind: 'caption-case', case: 'lower' }, source: { project: 'p1', title: 'Baking bread', version: 3 } }
  const kinds = [
    { kind: 'typed', message: { proposal }, saved: 'Saved. Your next videos will start with lowercase captions. You can change or remove it in My style.' },
    { kind: 'sentence', message: { suggestion: 'Keep music quieter under talking.' }, saved: "Saved. I'll do that in your next videos too. You can remove it in My style." },
    { kind: 'checked', message: { suggestion: 'Show at most 3 words in a caption.', check: { kind: 'captions.maxWords', value: 3 } as const },
      saved: "Saved. I'll check this on every video from now on. You can pause or remove it in My style." }
  ]

  /** The stand-in AI as My style (it writes the real My style.json), a chat with the question, and a chat write
   * that dies the first time: the app quitting after My style saved the answer. */
  async function killed(message: Partial<ChatMessage>) {
    const root = mkdtempSync(join(tmpdir(), 'rs-consent '))
    const ai = createMockAI({ host: { reelStudioRoot: () => root, runEngine: async () => ({}), renderAnimation: async () => ({}) } as any, settingsDir: root })
    const before = await ai.addStyleRule!('Show at most 2 words in a caption.', { kind: 'captions.maxWords', value: 2 })
    const chat: ChatMessage[] = [{ id: 'm1', from: 'editor', text: 'Remember this for next time?', at: '', actions: ['remember-yes', 'remember-no'], ...message }]
    let dies = true
    const deps: AnswerDeps = {
      chat: async () => structuredClone(chat),
      answer: ai.answerStyleQuestion!.bind(ai),
      answerOf: ai.styleAnswer!.bind(ai),
      settle: async (_slug, id, reply) => {
        if (dies) {
          dies = false
          throw new Error('the app quit')
        }
        const m = chat.find((x) => x.id === id)!
        if (!m.actions) return
        delete m.actions
        chat.push({ id: `r${chat.length}`, from: 'editor', text: reply, at: '' })
      },
      serialized
    }
    await expect(answerStyleQuestion(deps, 'bread', 'm1', true)).rejects.toThrow('the app quit')
    return { ai, chat, deps, before }
  }

  it.each(kinds)('$kind: after a restart the question shows answered, with the reply for what the Yes did', async ({ message, saved }) => {
    const { ai, chat, deps } = await killed(message)
    expect(chat[0].actions).toEqual(['remember-yes', 'remember-no'])
    await showAnswered(deps, 'bread')
    expect(chat[0].actions).toBeUndefined()
    expect(chat.map((m) => m.text)).toEqual(['Remember this for next time?', saved])
    // and the rule the Yes saved is in My style, once
    const text = message.proposal?.text ?? message.suggestion
    expect((await ai.styleRules()).filter((r) => r.text === text)).toHaveLength(1)
    await showAnswered(deps, 'bread')
    expect(chat).toHaveLength(2)
  })

  it.each(kinds)('$kind: No from a window that still shows the buttons takes back only what that Yes did', async ({ kind, message }) => {
    const { ai, chat, deps, before } = await killed(message)
    await answerStyleQuestion(deps, 'bread', 'm1', false)
    expect(chat.at(-1)?.text).toBe('OK, only for this video.')
    // My style is as it was before the question: the checked rule it replaced is back
    expect((await ai.styleRules()).map((r) => r.text)).toEqual([before.text])
    if (kind === 'checked') expect((await ai.styleRules())[0].check).toEqual({ kind: 'captions.maxWords', value: 2 })
  })
})
