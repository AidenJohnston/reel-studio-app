import { describe, expect, it } from 'vitest'
import type { ChatMessage, StyleProposal } from '../src/shared/api'
import { serialized } from '../src/main/store'
import { answerStyleQuestion, rememberQuestion, styleConsent, type AnswerDeps } from '../src/main/style-consent'

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
  function app(approve: (p: StyleProposal) => Promise<{ status: 'saved' | 'exists' | 'forgotten' }>) {
    const chat: ChatMessage[] = [
      { id: 'm1', from: 'editor', text: rememberQuestion(proposal.text), at: '', actions: ['remember-yes', 'remember-no'], proposal }
    ]
    const deps: AnswerDeps = {
      chat: async () => structuredClone(chat),
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
    const c = styleConsent('I made the captions lowercase.', ['Use lowercase captions.', 'Keep hashtags lowercase in the post.'], undefined, proposal)
    expect(c.suggestions).toEqual(['Keep hashtags lowercase in the post.'])
    expect(c.undo).toEqual(['Use lowercase captions.', 'Keep hashtags lowercase in the post.'])
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

  it('No on a question whose Yes was saved just before a crash takes the rule back out', async () => {
    const saved: string[] = []
    let crash = true
    const chat: ChatMessage[] = [
      { id: 'm1', from: 'editor', text: rememberQuestion(proposal.text), at: '', actions: ['remember-yes', 'remember-no'], proposal }
    ]
    const deps: AnswerDeps = {
      chat: async () => structuredClone(chat),
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
    expect(chat.at(-1)?.text).toBe('OK, only for this video.')
  })
})
