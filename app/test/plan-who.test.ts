import { describe, expect, it } from 'vitest'
import type { ProviderInfo } from '../src/shared/api'
import { planAnswerer } from '../src/renderer/src/components/plan-who'

const p = (x: Partial<ProviderInfo> & Pick<ProviderInfo, 'id'>): ProviderInfo => ({ connected: true, label: '', ...x })

// Planning runs on the writer role (main/index.ts projects:planSay, ai planTurn). The plan chat names the editor and,
// where the app knows it, that role's model; it never shows a version number or "Auto" as if it were a model.
describe('planAnswerer', () => {
  it('names the Claude Code app and the model picked for writing', () => {
    expect(planAnswerer(p({ id: 'claude-cli', label: 'Claude (your Claude Code app)', detail: '2.1.0' }), 'sonnet')).toEqual({
      mark: 'claude',
      name: 'Claude',
      model: 'Sonnet',
      full: 'Claude (your Claude Code app), Sonnet'
    })
  })

  it("leaves the model out when writing is on Auto and the app doesn't know which one the editor picks", () => {
    const who = planAnswerer(p({ id: 'claude-cli', label: 'Claude (your Claude Code app)', detail: '2.1.0' }), 'auto')
    expect(who).toEqual({ mark: 'claude', name: 'Claude', model: null, full: 'Claude (your Claude Code app)' })
  })

  it("names a server's model: the one picked for writing, else the connection's own", () => {
    const work = p({ id: 'custom', label: 'Work', detail: 'gpt-5.1-mini', connectionId: 'c1' })
    expect(planAnswerer(work, 'auto')).toMatchObject({ mark: 'server', name: 'Work', model: 'gpt-5.1-mini' })
    expect(planAnswerer(work, 'gpt-5.1')).toMatchObject({ name: 'Work', model: 'gpt-5.1' })
  })

  it('names the Anthropic key by its model, and ChatGPT without one', () => {
    expect(planAnswerer(p({ id: 'claude', label: 'Claude', detail: 'claude-sonnet-4-5' }), 'auto')).toMatchObject({ mark: 'claude', name: 'Claude', model: 'claude-sonnet-4-5' })
    expect(planAnswerer(p({ id: 'codex-cli', label: 'ChatGPT (your Codex app)', detail: '0.164.0' }), 'sonnet')).toMatchObject({ mark: 'openai', name: 'ChatGPT', model: null })
  })

  it('is nobody when no editor is connected', () => {
    expect(planAnswerer(null, 'auto')).toBeNull()
    expect(planAnswerer(p({ id: 'none', label: 'No AI' }), 'auto')).toBeNull()
    expect(planAnswerer(p({ id: 'claude-cli', connected: false, label: 'Claude (your Claude Code app)' }), 'auto')).toBeNull()
  })
})
