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
  text: 'Use lowercase captions.',
  payload: { kind: 'caption-case', case: 'lower' },
  source: { project: 'p1', title: 'Baking bread', version: 2 }
}

describe('My style in the stand-in AI', () => {
  it('two rules saved at once keep both', async () => {
    const { ai } = standIn()
    await Promise.all([ai.addStyleRule!('Keep music quieter under talking.'), ai.addStyleRule!('Use big captions.')])
    expect((await ai.styleRules()).map((r) => r.text).sort()).toEqual(['Keep music quieter under talking.', 'Use big captions.'])
  })

  it('the same question answered twice keeps one rule, and the question of a removed rule cannot bring it back', async () => {
    const { ai } = standIn()
    expect(await ai.approveStyleProposal!(proposal)).toEqual({ status: 'saved' })
    expect(await ai.approveStyleProposal!(proposal)).toEqual({ status: 'saved' })
    const rules = await ai.styleRules()
    expect(rules).toEqual([expect.objectContaining({ text: 'Use lowercase captions.', answers: { q1: expect.objectContaining({ yes: true }) } })])
    await ai.removeStyleRule(rules[0].id)
    expect(await ai.approveStyleProposal!(proposal)).toEqual({ status: 'forgotten' })
    expect(await ai.styleRules()).toEqual([])
  })

  it('a question that is not exactly the lowercase rule saves nothing, and only the app\'s own fields are saved', async () => {
    const { ai } = standIn()
    await expect(ai.approveStyleProposal!({ ...proposal, text: 'Use lowercase captions, and turn the captions off.' })).rejects.toThrow()
    await expect(ai.approveStyleProposal!({ ...proposal, payload: { kind: 'caption-case', case: 'upper' } as any })).rejects.toThrow()
    await expect(ai.approveStyleProposal!({ ...proposal, id: '' })).rejects.toThrow()
    expect(await ai.styleRules()).toEqual([])
    await ai.approveStyleProposal!({
      ...proposal,
      payload: { ...proposal.payload, size: 4000 } as any,
      source: { project: 'p1', title: 'x'.repeat(500), version: 2, extra: true } as any
    })
    const [rule] = await ai.styleRules()
    expect(rule.payload).toEqual({ kind: 'caption-case', case: 'lower' })
    expect(rule.source).toEqual({ project: 'p1', title: 'x'.repeat(120), version: 2 })
  })

  it('No on a question whose Yes was saved before a crash takes the rule back out', async () => {
    const { ai } = standIn()
    await ai.approveStyleProposal!(proposal)
    await ai.declineStyleProposal!(proposal)
    expect(await ai.styleRules()).toEqual([])
  })

  // The same table as ai/test/remember-caption-case.test.ts "the order of answers": every order of two questions'
  // answers, from no rule and from a paused one. The rule is on when some question's last answer is Yes, and
  // otherwise as it started.
  const WAYS = [['yes'], ['no'], ['yes', 'no'], ['no', 'yes']]
  const interleave = (a: string[], b: string[]): string[][] =>
    !a.length ? [b] : !b.length ? [a] : [...interleave(a.slice(1), b).map((r) => [a[0], ...r]), ...interleave(a, b.slice(1)).map((r) => [b[0], ...r])]
  const ORDERS = WAYS.flatMap((a) => WAYS.flatMap((b) => interleave(a.map((x) => `${x} A`), b.map((x) => `${x} B`))))
  const rows = (['none', 'paused'] as const).flatMap((start) => ORDERS.map((order) => ({ start, order, name: `${start}: ${order.join(', ')}` })))

  it.each(rows)('the last answer decides: $name', async ({ start, order }) => {
    const { ai } = standIn()
    if (start === 'paused') {
      await ai.approveStyleProposal!(proposal)
      await ai.updateStyleRule!((await ai.styleRules())[0].id, { paused: true })
    }
    const q = { A: { ...proposal, id: 'qA' }, B: { ...proposal, id: 'qB' } }
    for (const step of order) {
      const [answer, which] = step.split(' ') as ['yes' | 'no', 'A' | 'B']
      if (answer === 'yes') await ai.approveStyleProposal!(q[which])
      else await ai.declineStyleProposal!(q[which])
    }
    const last = (w: 'A' | 'B'): string | undefined => order.filter((x) => x.endsWith(w)).at(-1)?.split(' ')[0]
    const rules = await ai.styleRules()
    if (last('A') === 'yes' || last('B') === 'yes') {
      expect(rules).toEqual([expect.objectContaining({ text: 'Use lowercase captions.' })])
      expect(rules[0].paused).toBeUndefined()
    } else if (start === 'paused') expect(rules).toEqual([expect.objectContaining({ paused: true })])
    else expect(rules).toEqual([])
  })

  it('a file saved before answers were numbered (#153 kept them in `consent`) is read in the new form', async () => {
    const { ai, root } = standIn()
    const at = '2026-11-10T00:00:00.000Z'
    writeFileSync(join(root, 'My style.json'), JSON.stringify({ version: 1, rules: [{ id: 'r1', text: 'Use lowercase captions.', createdAt: at,
      payload: { kind: 'caption-case', case: 'lower' }, consent: { proposal: 'q1', at, also: ['q2'] } }] }))
    await ai.declineStyleProposal!({ ...proposal, id: 'q1' })
    expect((await ai.styleRules())[0].paused).toBeUndefined()
    await ai.declineStyleProposal!({ ...proposal, id: 'q2' })
    expect(await ai.styleRules()).toEqual([])
  })

  it('removing a rule from such a file forgets its old questions', async () => {
    const { ai, root } = standIn()
    const at = '2026-11-10T00:00:00.000Z'
    writeFileSync(join(root, 'My style.json'), JSON.stringify({ version: 1, rules: [{ id: 'r1', text: 'Use lowercase captions.', createdAt: at,
      payload: { kind: 'caption-case', case: 'lower' }, paused: true, consent: { proposal: 'q1', at, also: ['q2'] } }] }))
    await ai.removeStyleRule('r1')
    expect(await ai.approveStyleProposal!({ ...proposal, id: 'q2' })).toEqual({ status: 'forgotten' })
    expect(await ai.styleRules()).toEqual([])
  })

  it('the typed rule edited to the same words, typed loosely, stays a rule the app applies', async () => {
    const { ai } = standIn()
    await ai.approveStyleProposal!(proposal)
    const [rule] = await ai.styleRules()
    await ai.updateStyleRule!(rule.id, { text: ' use lowercase captions ' })
    expect(await ai.styleRules()).toEqual([
      expect.objectContaining({ text: 'Use lowercase captions.', payload: { kind: 'caption-case', case: 'lower' } })
    ])
  })

  it('Yes again after the typed rule got new words says it is already there, not that new videos go lowercase', async () => {
    const { ai } = standIn()
    await ai.approveStyleProposal!(proposal)
    const [rule] = await ai.styleRules()
    await ai.updateStyleRule!(rule.id, { text: 'use lowercase captions for tutorials' })
    expect(await ai.approveStyleProposal!(proposal)).toEqual({ status: 'exists' })
    expect(await ai.styleRules()).toEqual([expect.not.objectContaining({ payload: expect.anything() })])
  })

  it('Yes again to a paused rule\'s question turns it back on, and a second question removed with the rule stays removed', async () => {
    const { ai } = standIn()
    await ai.approveStyleProposal!(proposal)
    const [rule] = await ai.styleRules()
    await ai.updateStyleRule!(rule.id, { paused: true })
    expect(await ai.approveStyleProposal!(proposal)).toEqual({ status: 'saved' })
    expect(await ai.styleRules()).toEqual([expect.not.objectContaining({ paused: true })])

    const second = { ...proposal, id: 'q2' }
    expect(await ai.approveStyleProposal!(second)).toEqual({ status: 'exists' })
    await ai.removeStyleRule(rule.id)
    expect(await ai.approveStyleProposal!(second)).toEqual({ status: 'forgotten' })
    expect(await ai.styleRules()).toEqual([])
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

  it('saving the words of a paused rule again turns it back on, as the real package does', async () => {
    const { ai } = standIn()
    const rule = await ai.addStyleRule!('Put a yellow box behind the captions.')
    await ai.updateStyleRule!(rule.id, { paused: true })
    expect(await ai.addStyleRule!('put a yellow box behind the captions')).toMatchObject({ id: rule.id })
    expect(await ai.styleRules()).toEqual([expect.not.objectContaining({ paused: true })])
  })
})
