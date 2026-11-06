import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NICHE_OPENER, checkNiche, readNicheFile, splitWords } from '../src/shared/niche'
import { registerNicheIpc } from '../src/main/niche-ipc'

const NICHE = { who: 'Nurses on night shifts', promise: 'Meals that survive a 3am break', angles: ['A meal I made at work'], avoid: ['hack'] }

describe('checkNiche', () => {
  // fails if a niche the editor can't use is saved, or the person is not told which part to fix
  it('saves cleaned lines and says which part is missing', () => {
    expect(checkNiche({ ...NICHE, who: '  Nurses —  on nights ', avoid: ['hack', 'Hack', ' "clean eating" '] })).toEqual({ ...NICHE, who: 'Nurses, on nights', avoid: ['hack', 'clean eating'] })
    expect(() => checkNiche({ ...NICHE, who: ' ' })).toThrow(expect.objectContaining({ userMessage: 'Say who your reels are for.' }))
    expect(() => checkNiche({ ...NICHE, angles: [] })).toThrow(expect.objectContaining({ userMessage: 'Add at least one kind of reel you make.' }))
    expect(() => checkNiche({ ...NICHE, angles: ['1', '2', '3', '4', '5', '6'] })).toThrow(expect.objectContaining({ code: 'BAD_NICHE' }))
  })

  it('splits words to avoid on commas, semicolons and lines', () => {
    expect(splitWords('hack, game-changer;insane\n\n “literally” ,')).toEqual(['hack', 'game-changer', 'insane', 'literally'])
  })

  // fails if a hand-broken file reads as a niche, or a good one loses where it came from
  it('reads My niche.json, and calls a broken one damaged', () => {
    expect(readNicheFile(JSON.stringify({ version: 1, niche: { ...NICHE, savedAt: 'then', from: 'chat' } }))).toEqual({ ...NICHE, savedAt: 'then', from: 'chat' })
    expect(readNicheFile('{"niche":')).toBe('damaged')
    expect(readNicheFile('{"niche":{"who":"x"}}')).toBe('damaged')
  })
})

describe('the niche handlers', () => {
  const setup = (ai: { connected: boolean; reply?: unknown }) => {
    const root = mkdtempSync(join(tmpdir(), 'rs-niche-'))
    const handlers = new Map<string, (e: unknown, ...a: any[]) => any>()
    const asked: any[] = []
    registerNicheIpc({
      handle: (c, fn) => handlers.set(c, fn),
      root: () => root,
      log: () => undefined,
      status: () => undefined,
      ai: () => ({
        active: async () => (ai.connected ? { id: 'claude-cli', connected: true, label: 'Claude' } : { id: 'none', connected: true, label: 'No AI' }) as any,
        nicheTurn: async (input) => {
          asked.push(input)
          return ai.reply as any
        }
      })
    })
    const call = (c: string, ...a: unknown[]) => handlers.get(c)!(null, ...a)
    return { root, call, asked }
  }

  // fails if Save, Edit and Remove don't reach the file the editor reads
  it('saves, reads back and removes the niche', async () => {
    const { root, call } = setup({ connected: false })
    expect(await call('niche:get')).toEqual({ niche: null, damaged: false })
    await call('niche:save', NICHE, 'typed')
    expect(JSON.parse(readFileSync(join(root, 'My niche.json'), 'utf8')).niche).toMatchObject({ ...NICHE, from: 'typed' })
    expect((await call('niche:get')).niche).toMatchObject(NICHE)
    await call('niche:remove')
    expect(await call('niche:get')).toEqual({ niche: null, damaged: false })
    writeFileSync(join(root, 'My niche.json'), 'not json')
    expect(await call('niche:get')).toEqual({ niche: null, damaged: true })
  })

  // fails if the editor never hears the app's own first question, or the chat runs with no editor connected
  it('sends the chat with the app’s opening question, and refuses without an editor', async () => {
    const reply = { kind: 'question', text: 'Who do you picture watching?' }
    const { call, asked } = setup({ connected: true, reply })
    expect(await call('niche:say', [{ from: 'you', text: 'quick meals' }], 0, null)).toEqual(reply)
    expect(asked[0].turns).toEqual([{ from: 'editor', text: NICHE_OPENER, kind: 'question' }, { from: 'you', text: 'quick meals' }])
    await expect(call('niche:say', [{ from: 'editor', text: 'hi' }], 0, null)).rejects.toMatchObject({ code: 'BAD_ARGS' })
    const off = setup({ connected: false })
    await expect(off.call('niche:say', [{ from: 'you', text: 'quick meals' }], 0, null)).rejects.toMatchObject({ code: 'NO_AI' })
  })
})
