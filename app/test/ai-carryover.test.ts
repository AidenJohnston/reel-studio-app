// 0.1.2: an old local-Claude-Code install keeps using the Claude Code app it used without a saved choice, once.
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aiChoiceSaved, carryOverDecision, type CarryOverFacts } from '../src/main/ai-carryover'

const OLD_INSTALL: CarryOverFacts = { aiAutoPicked: true, carriedOver: false, choiceSaved: false, activeId: 'none', claudeCodeReady: true }

describe('carry-over for old local-Claude-Code installs', () => {
  it('keeps Claude Code for an old install that used it without saving a choice', () => {
    expect(carryOverDecision(OLD_INSTALL)).toBe('use-claude-code')
  })
  it('waits (no change, try next start) while their Claude Code app is not ready', () => {
    expect(carryOverDecision({ ...OLD_INSTALL, claudeCodeReady: false })).toBe('not-ready-yet')
  })
  it('never touches a public install, a saved choice ("No AI" too), another connected AI, or a second start', () => {
    expect(carryOverDecision({ ...OLD_INSTALL, aiAutoPicked: false })).toBe('nothing-to-do')
    expect(carryOverDecision({ ...OLD_INSTALL, choiceSaved: true })).toBe('nothing-to-do')
    expect(carryOverDecision({ ...OLD_INSTALL, activeId: 'chatgpt' })).toBe('nothing-to-do')
    expect(carryOverDecision({ ...OLD_INSTALL, carriedOver: true })).toBe('nothing-to-do')
  })
  it('reads whether ai-settings.json holds a choice', async () => {
    const d = mkdtempSync(join(tmpdir(), 'rs carry ü '))
    expect(await aiChoiceSaved(d)).toBe(false) // no file
    writeFileSync(join(d, 'ai-settings.json'), JSON.stringify({ claudeModel: 'x' }))
    expect(await aiChoiceSaved(d)).toBe(false)
    writeFileSync(join(d, 'ai-settings.json'), JSON.stringify({ active: 'none' }))
    expect(await aiChoiceSaved(d)).toBe(true)
    writeFileSync(join(d, 'ai-settings.json'), '{broken')
    expect(await aiChoiceSaved(d)).toBe(false)
  })
})
