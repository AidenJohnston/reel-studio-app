import { describe, expect, it } from 'vitest'
import type { ChatMessage, StyleProposal } from '../src/shared/api'
import { serialized } from '../src/main/store'
import { answerStyleQuestion, rememberQuestion, replyChat, styleConsent, type AnswerDeps } from '../src/main/style-consent'

describe('My style consent (grandma 2: saved without asking)', () => {
  it('an AI that already saved a rule: undo it, drop the announcement, ask instead', () => {
    const summary =
      'I turned the music down at the start so your voice comes through clearly. I\'ll remember that for next time. I also saved this to My style for your future reels: "Keep music quieter under talking." You can remove it in Settings.'
    const c = styleConsent(summary, ['Keep music quieter under talking.'])
    expect(c.summary).toBe('I turned the music down at the start so your voice comes through clearly.')
    expect(c.undo).toEqual(['Keep music quieter under talking.'])
    expect(c.suggestions).toEqual(['Keep music quieter under talking.'])
    expect(rememberQuestion(c.suggestions[0])).toBe('Remember this for next time? "Keep music quieter under talking."')
  })

  it("fails if the AI package's current saved-rule sentence stays in the reply while the rule is asked about instead", () => {
    // the sentence ai/src/editor.ts withStyleEcho adds since My style has Pause and Forget
    const one = 'I lowered the music. I also saved this to My style for your future reels: "Keep music quieter under talking." You can pause or forget it there.'
    expect(styleConsent(one, ['Keep music quieter under talking.']).summary).toBe('I lowered the music.')
    const two = 'I lowered the music. I also saved these to My style for your future reels: "A." and "B." You can pause or forget them there.'
    expect(styleConsent(two, ['A.', 'B.']).summary).toBe('I lowered the music.')
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
    text: 'Use lowercase subtitles.',
    payload: { kind: 'caption-case', case: 'lower' },
    source: { project: 'p1', title: 'Baking bread', version: 3 }
  }
  function app(approve: (p: StyleProposal) => Promise<{ status: 'saved' | 'exists' | 'forgotten' }>) {
    const chat: ChatMessage[] = [
      { id: 'm1', from: 'editor', text: rememberQuestion(proposal.text), at: '', actions: ['remember-yes', 'remember-no'], proposal }
    ]
    const deps: AnswerDeps = {
      chat: async () => structuredClone(chat),
      title: async () => 'Baking bread',
      approveStyleProposal: approve,
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
    const c = styleConsent('I made the captions lowercase.', ['Use lowercase subtitles.', 'Keep hashtags lowercase in the post.'], undefined, proposal)
    expect(c.suggestions).toEqual(['Keep hashtags lowercase in the post.'])
    expect(c.undo).toEqual(['Use lowercase subtitles.', 'Keep hashtags lowercase in the post.'])
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
    await expect(answer()).rejects.toMatchObject({ userMessage: 'That could not be saved to My style. Try again.' })
    expect(chat).toHaveLength(1)
    expect(chat[0].actions).toEqual(['remember-yes', 'remember-no'])
    fail = false
    await answer()
    expect(chat.at(-1)?.text).toBe('Saved. Your next reels will start with lowercase subtitles. You can pause or forget it in My style.')
  })

  it('No on a question whose Yes was saved just before a crash takes the rule back out', async () => {
    const saved: string[] = []
    let crash = true
    const chat: ChatMessage[] = [
      { id: 'm1', from: 'editor', text: rememberQuestion(proposal.text), at: '', actions: ['remember-yes', 'remember-no'], proposal }
    ]
    const deps: AnswerDeps = {
      chat: async () => structuredClone(chat),
      title: async () => 'Baking bread',
      approveStyleProposal: async (p) => {
        saved.push(p.id)
        return { status: 'saved' }
      },
      declineStyleProposal: async (p) => {
        saved.splice(saved.indexOf(p.id), 1)
      },
      settle: async (_slug, id, reply) => {
        if (crash) throw new Error('the app quit')
        delete chat.find((m) => m.id === id)!.actions
        chat.push({ id: 'r', from: 'editor', text: reply, at: '' })
      },
      serialized
    }
    await expect(answerStyleQuestion(deps, 'bread', 'm1', true)).rejects.toThrow()
    crash = false
    await answerStyleQuestion(deps, 'bread', 'm1', false)
    expect(saved).toEqual([])
    expect(chat.at(-1)?.text).toBe('OK, only for this reel.')
  })
})

describe('a rule kept from a note', () => {
  it('fails if My style does not remember which note, reel and version it was learned from', async () => {
    const chat: ChatMessage[] = [
      { id: 'n1', from: 'you', text: 'make the subtitles bigger', at: '' },
      { id: 'e1', from: 'editor', text: 'Bigger subtitles.', at: '', version: 2 },
      { id: 'n2', from: 'you', text: 'always use big subtitles', at: '' },
      { id: 'e2', from: 'editor', text: 'Made them big.', at: '', version: 3 },
      { id: 'q', from: 'editor', text: rememberQuestion('Use big subtitles.'), at: '', actions: ['remember-yes', 'remember-no'], suggestion: 'Use big subtitles.' }
    ]
    const added: unknown[] = []
    const deps: AnswerDeps = {
      chat: async () => structuredClone(chat),
      title: async () => 'Baking bread',
      addStyleRule: async (text, from) => added.push({ text, ...from }),
      settle: async () => {},
      serialized
    }
    await answerStyleQuestion(deps, 'bread', 'q', true)
    expect(added).toEqual([{ text: 'Use big subtitles.', source: { project: 'bread', title: 'Baking bread', version: 3, note: 'always use big subtitles' } }])
  })
})

describe('a checked My style question', () => {
  const check = { kind: 'captions.maxWords', value: 2 } as const
  const text = 'Show at most 2 words in a subtitle.'

  it('fails if Yes drops the check, or the reply does not say the rule is checked on every reel', async () => {
    const chat: ChatMessage[] = [
      { id: 'm1', from: 'editor', text: rememberQuestion(text), at: '', actions: ['remember-yes', 'remember-no'], suggestion: text, check }
    ]
    const saved: unknown[][] = []
    const deps: AnswerDeps = {
      chat: async () => structuredClone(chat),
      title: async () => 'Baking bread',
      addStyleRule: async (...args) => {
        saved.push(args)
      },
      settle: async (_slug, id, reply) => {
        delete chat.find((m) => m.id === id)!.actions
        chat.push({ id: 'r', from: 'editor', text: reply, at: '' })
      },
      serialized
    }
    await answerStyleQuestion(deps, 'bread', 'm1', true)
    expect(saved).toEqual([[text, { source: { project: 'bread', title: 'Baking bread', version: 0 } }, check]])
    expect(chat.at(-1)?.text).toBe("Saved. I'll check this on every new reel. You can pause or forget it in My style.")
  })

  it('fails if the same rule is asked twice, once plain and once checked', () => {
    const lines = replyChat(styleConsent('Two words now.', [], [text]), 2, undefined, [{ text, check }])
    expect(lines.map((l) => [l.text, l.check ?? null])).toEqual([
      ['Two words now.', null],
      [rememberQuestion(text), check]
    ])
  })
})
