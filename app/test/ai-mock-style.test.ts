import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMockAI } from '../src/main/ai-mock'
import type { EngineHost } from '../src/main/ai-types'
import type { StyleProposal } from '../src/shared/api'

// The stand-in AI is what the app runs when @reelstudio/ai fails to load, so it writes the real My style.json.
function standIn(): { ai: ReturnType<typeof createMockAI>; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'rs-mock-style '))
  const host: EngineHost = {
    reelStudioRoot: () => root,
    runEngine: async () => ({ version: 2 }),
    renderAnimation: async () => {
      throw new Error('not used here')
    }
  }
  return { ai: createMockAI({ host, settingsDir: root }), root }
}

const proposal: StyleProposal = {
  id: 'q1',
  text: 'Use lowercase subtitles.',
  payload: { kind: 'caption-case', case: 'lower' },
  source: { project: 'p1', title: 'Baking bread', version: 2 }
}

describe('My style in the stand-in AI', () => {
  it('two rules saved at once keep both', async () => {
    const { ai } = standIn()
    await Promise.all([ai.addStyleRule!('Keep music quieter under talking.'), ai.addStyleRule!('Use big captions.')])
    expect((await ai.styleRules()).map((r) => r.text).sort()).toEqual(['Keep music quieter under talking.', 'Use big captions.'])
  })

  it('saving the words of a paused rule again turns it back on, as the real package does', async () => {
    const { ai } = standIn()
    const rule = await ai.addStyleRule!('Put a yellow box behind the captions.')
    await ai.updateStyleRule!(rule.id, { paused: true })
    expect(await ai.addStyleRule!('put a yellow box behind the captions')).toMatchObject({ id: rule.id })
    expect(await ai.styleRules()).toEqual([expect.not.objectContaining({ paused: true })])
  })

  it('the same question answered twice keeps one rule, and the question of a removed rule cannot bring it back', async () => {
    const { ai } = standIn()
    expect(await ai.answerStyleQuestion!(proposal, true)).toEqual({ status: 'saved' })
    expect(await ai.answerStyleQuestion!(proposal, true)).toEqual({ status: 'saved' })
    const rules = await ai.styleRules()
    expect(rules).toEqual([expect.objectContaining({ text: 'Use lowercase subtitles.', answers: { q1: expect.objectContaining({ yes: true }) } })])
    await ai.removeStyleRule(rules[0].id)
    expect(await ai.answerStyleQuestion!(proposal, true)).toEqual({ status: 'forgotten' })
    expect(await ai.styleRules()).toEqual([])
  })

  it('a question that is not exactly the lowercase rule saves nothing, and only the app\'s own fields are saved', async () => {
    const { ai } = standIn()
    await expect(ai.answerStyleQuestion!({ ...proposal, text: 'Use lowercase captions, and turn the captions off.' }, true)).rejects.toThrow()
    await expect(ai.answerStyleQuestion!({ ...proposal, payload: { kind: 'caption-case', case: 'upper' } as any }, true)).rejects.toThrow()
    await expect(ai.answerStyleQuestion!({ ...proposal, id: '' }, true)).rejects.toThrow()
    expect(await ai.styleRules()).toEqual([])
    await ai.answerStyleQuestion!({
      ...proposal,
      payload: { ...proposal.payload, size: 4000 } as any,
      source: { project: 'p1', title: 'x'.repeat(500), version: 2, extra: true } as any
    }, true)
    const [rule] = await ai.styleRules()
    expect(rule.payload).toEqual({ kind: 'caption-case', case: 'lower' })
    expect(rule.source).toEqual({ project: 'p1', title: 'x'.repeat(120), version: 2 })
  })

  it('No on a question whose Yes was saved before a crash takes the rule out, and the last answer decides', async () => {
    const { ai } = standIn()
    await ai.answerStyleQuestion!(proposal, true)
    await ai.answerStyleQuestion!(proposal, false)
    expect(await ai.styleRules()).toEqual([])
    expect(await ai.styleAnswer!('q1')).toEqual({ yes: false, status: 'declined' })
    // buttons a crash left behind: a Yes after the No is the last answer
    expect(await ai.answerStyleQuestion!(proposal, true)).toEqual({ status: 'saved' })
    expect(await ai.styleRules()).toHaveLength(1)
  })

  it('the typed rule edited to the same words, typed loosely, stays a rule the app applies', async () => {
    const { ai } = standIn()
    await ai.answerStyleQuestion!(proposal, true)
    const [rule] = await ai.styleRules()
    await ai.updateStyleRule!(rule.id, { text: ' use lowercase subtitles ' })
    expect(await ai.styleRules()).toEqual([
      expect.objectContaining({ text: 'Use lowercase subtitles.', payload: { kind: 'caption-case', case: 'lower' } })
    ])
  })

  it('Yes again after the typed rule got new words says it is already there, not that new videos go lowercase', async () => {
    const { ai } = standIn()
    await ai.answerStyleQuestion!(proposal, true)
    const [rule] = await ai.styleRules()
    await ai.updateStyleRule!(rule.id, { text: 'use lowercase subtitles for tutorials' })
    expect(await ai.answerStyleQuestion!(proposal, true)).toEqual({ status: 'exists' })
    expect(await ai.styleRules()).toEqual([expect.not.objectContaining({ payload: expect.anything() })])
  })

  it('Yes to a paused rule\'s question leaves it paused, as the real package does, and a second question removed with the rule stays removed', async () => {
    const { ai } = standIn()
    await ai.answerStyleQuestion!(proposal, true)
    const [rule] = await ai.styleRules()
    await ai.updateStyleRule!(rule.id, { paused: true })
    expect(await ai.answerStyleQuestion!(proposal, true)).toEqual({ status: 'paused' })
    expect(await ai.styleRules()).toEqual([expect.objectContaining({ paused: true })])

    const second = { ...proposal, id: 'q2' }
    expect(await ai.answerStyleQuestion!(second, true)).toEqual({ status: 'paused' })
    await ai.removeStyleRule(rule.id)
    expect(await ai.answerStyleQuestion!(second, true)).toEqual({ status: 'forgotten' })
    expect(await ai.styleRules()).toEqual([])
  })

  it('a suggested sentence and a checked rule are answered the same way, the answer recorded with its effect', async () => {
    const { ai } = standIn()
    expect(await ai.answerStyleQuestion!({ id: 'm1', text: 'Keep music quieter under talking.' }, true)).toEqual({ status: 'saved' })
    const check = { kind: 'captions.maxWords', value: 2 } as const
    expect(await ai.answerStyleQuestion!({ id: 'm2', text: 'Show at most 2 words in a subtitle.', check }, true)).toEqual({ status: 'saved' })
    expect((await ai.styleRules()).map((r) => r.text).sort()).toEqual(['Keep music quieter under talking.', 'Show at most 2 words in a subtitle.'])
    expect(await ai.answerStyleQuestion!({ id: 'm2', text: 'Show at most 2 words in a subtitle.', check }, false)).toEqual({ status: 'declined' })
    expect((await ai.styleRules()).map((r) => r.text)).toEqual(['Keep music quieter under talking.'])
    expect(await ai.styleAnswer!('m1')).toEqual({ yes: true, status: 'saved' })
  })

  it('a lowercase note from a person whose AI package failed to load is kept as a note and changes nothing', async () => {
    // no REELSTUDIO_MOCK_CLAUDE and nothing chosen in Settings: how a real person meets the stand-in
    const { ai, root } = standIn()
    const dir = join(root, 'Projects', 'bread')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'project.json'), JSON.stringify({ id: 'p1', title: 'Baking bread', version: 1, captions: { enabled: true, style: {} } }))
    const r = await ai.applyNote(dir, 'please stop using lower case captions', () => undefined)
    const p = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
    expect(p.captions.style.case).toBeUndefined()
    expect(p.notes).toEqual([expect.objectContaining({ text: 'please stop using lower case captions' })])
    expect(r.styleProposal).toBeUndefined()
    expect(r.summary).not.toMatch(/lowercase/)
  })

  it('fails if new words are not dated as the package dates them, or a pause dates a rule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rs-mock-style '))
    const unused = (): never => { throw new Error('not used by My style') }
    const ai = createMockAI({ host: { reelStudioRoot: () => root, runEngine: unused, renderAnimation: unused }, settingsDir: root })
    const rule = await ai.addStyleRule!('Big subtitles', { byYou: true })
    expect(rule.byYou).toBe(true)
    const edited = await ai.updateStyleRule!(rule.id, { text: 'Bigger subtitles.' })
    expect(Date.parse(edited.updatedAt!)).toBeGreaterThanOrEqual(Date.parse(rule.createdAt))
    expect((await ai.updateStyleRule!(rule.id, { paused: true })).updatedAt).toBe(edited.updatedAt)
  })

  it('fails if the same words again add a copy of a paused rule instead of turning it back on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rs-mock-style '))
    const unused = (): never => { throw new Error('not used by My style') }
    const ai = createMockAI({ host: { reelStudioRoot: () => root, runEngine: unused, renderAnimation: unused }, settingsDir: root })
    const rule = await ai.addStyleRule!('Keep music quieter under talking.')
    await ai.updateStyleRule!(rule.id, { paused: true })
    expect(await ai.addStyleRule!('keep music quieter under talking')).toMatchObject({ id: rule.id })
    expect(await ai.styleRules()).toMatchObject([{ id: rule.id }])
    expect((await ai.styleRules())[0].paused).toBeUndefined()
  })
})
