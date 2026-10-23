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
    expect(rules).toEqual([expect.objectContaining({ text: 'Use lowercase captions.', consent: expect.objectContaining({ proposal: 'q1' }) })])
    await ai.removeStyleRule(rules[0].id)
    expect(await ai.approveStyleProposal!(proposal)).toEqual({ status: 'forgotten' })
    expect(await ai.styleRules()).toEqual([])
  })

  it('No on a question whose Yes was saved before a crash takes the rule out for good', async () => {
    const { ai } = standIn()
    await ai.approveStyleProposal!(proposal)
    await ai.declineStyleProposal!(proposal)
    expect(await ai.styleRules()).toEqual([])
    expect(await ai.approveStyleProposal!(proposal)).toEqual({ status: 'forgotten' })
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
})
