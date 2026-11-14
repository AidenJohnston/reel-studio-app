import { describe, expect, it } from 'vitest'
import { findSettings, matchedSynonym, matchRanges, SECTIONS, SETTING_IDS, SETTINGS, type SettingId } from '../src/renderer/src/components/settings-index'

const finds = (query: string, id: SettingId): void => {
  expect(findSettings(query), `"${query}" should find ${id}`).toContain(id)
}

describe('Settings search', () => {
  it('fails if a setting cannot be found by its label or by one of its synonyms', () => {
    for (const id of SETTING_IDS) {
      finds(SETTINGS[id].label, id)
      finds(SETTINGS[id].label.slice(0, 4), id)
      for (const word of SETTINGS[id].synonyms) finds(word, id)
    }
  })

  it('fails if the words people use for a setting miss it', () => {
    finds('telemetry', 'sharing')
    finds('captions', 'listening-model')
    finds('folder', 'library-folder')
    finds('Claude', 'editor')
    finds('30fps', 'faster-exports')
    finds('licence', 'licence')
    finds("what's new", 'whats-new')
    finds('ÉDITOR', 'editor')
    // what other apps call the way in: Vyra and Eddie AI both sell it as an "MCP server" or "connector"
    finds('MCP', 'outside-apps')
    finds('connector', 'outside-apps')
    finds('MCP', 'note-runner')
  })

  it('fails if a search shows settings that do not match, or an empty search hides everything', () => {
    expect(findSettings('folder')).toEqual(new Set(['library-folder']))
    expect(findSettings('qwertyuiop')).toEqual(new Set())
    expect(findSettings('   ')).toBeNull()
  })

  it('fails if a found setting shows without the switch it needs to be usable', () => {
    expect(findSettings('quality scores')).toEqual(new Set(['sharing', 'sharing-quality']))
  })
})

describe('Settings sections', () => {
  it("fails if the sections leave spec section 8's order, or Editor or Advanced loses a row it holds", () => {
    expect(Object.keys(SECTIONS)).toEqual(['editor', 'privacy', 'reels', 'posting', 'devices', 'about', 'advanced'])
    // the editor component holds the models for each stage, your own server and an API key (r12: one component), with
    // Double-check, Look things up in parallel, How notes run and Let other AI apps use Reel Studio beside it
    expect(SETTING_IDS.filter((id) => SETTINGS[id].section === 'editor')).toEqual(['editor', 'check-edits', 'look-ups', 'note-runner', 'outside-apps', 'models', 'own-server', 'api-key'])
    const advanced = SETTING_IDS.filter((id) => SETTINGS[id].section === 'advanced')
    expect(advanced).toEqual(['stock-keys', 'easy-ai', 'engine-cache', 'logs', 'report-problem', 'diagnostics', 'first-run'])
  })

  it('fails if the Advanced rows are missed by the words people use for them', () => {
    expect(findSettings('cache')).toEqual(new Set(['engine-cache']))
    finds('logs', 'logs')
    finds('bug report', 'diagnostics')
    finds('feedback', 'report-problem')
    finds('onboarding', 'first-run')
    finds('reset', 'first-run')
  })
})

describe('Settings search highlight', () => {
  const marked = (text: string, q: string): string[] => matchRanges(text, q).map(([a, b]) => text.slice(a, b))

  it('fails if it marks anything but the start of each word a typed word begins', () => {
    expect(marked('Clear cache', 'cac')).toEqual(['cac'])
    expect(marked('Notify when a reel is ready', 're')).toEqual(['re', 're'])
    expect(marked('Library folder', 'fold lib')).toEqual(['Lib', 'fold'])
    expect(marked('What’s new', "what's")).toEqual(['What', 's'])
    expect(marked('Écran', 'ecr')).toEqual(['Écr'])
    expect(marked('Library folder', 'older')).toEqual([])
    expect(marked('Library folder', '  ')).toEqual([])
  })

  it('fails if a row found by a synonym does not say which, or one its label explains says one anyway', () => {
    expect(matchedSynonym('sharing', 'telemetry')).toBe('telemetry')
    expect(matchedSynonym('faster-exports', '30fps')).toBe('30fps')
    expect(matchedSynonym('engine-cache', 'clear')).toBe('clear cache')
    expect(matchedSynonym('engine-cache', 'cache')).toBeNull()
    expect(matchedSynonym('own-server', 'editor')).toBeNull()
  })
})
