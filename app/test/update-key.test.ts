// The download key for automatic updates (main/update-key.ts): which links and pasted text give a key, that
// nothing else does, and that the key is stored, reported and cleared without ever reaching the page or the log.
import { describe, expect, it } from 'vitest'
import { createUpdateKeyService, keyFromArgv, keyFromProtocolUrl, keyFromText, planOf, type UpdateKeyState } from '../src/main/update-key'
import { loadSettings, saveSettings } from '../src/main/settings'
import type { UpdateKeyStatus } from '../src/shared/api'
import { setupPaths } from './helpers'

const b64url = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** Shaped like the server's tokens; the signature is not checked here (the server does that). */
const key = (p = 'monthly') => `v1.${b64url(JSON.stringify({ s: 'cs_live_abc123', p, e: 1830000000 }))}.${'s'.repeat(43)}`
const K = key()

describe('keyFromProtocolUrl', () => {
  it('takes the key from reelstudio://updates?key=…', () => {
    expect(keyFromProtocolUrl(`reelstudio://updates?key=${K}`)).toBe(K)
    expect(keyFromProtocolUrl(`reelstudio://updates/?key=${encodeURIComponent(K)}`)).toBe(K)
  })
  it('ignores any other scheme, host or path, and malformed keys', () => {
    for (const bad of [
      `https://updates?key=${K}`,
      `reelstudio://other?key=${K}`,
      `reelstudio://updates/x?key=${K}`,
      'reelstudio://updates?key=v1.only-two',
      `reelstudio://updates?key=${K}%20`,
      `reelstudio://updates?key=v1.${'a'.repeat(600)}.b`,
      'reelstudio://updates',
      'not a url',
      42
    ])
      expect(keyFromProtocolUrl(bad)).toBeNull()
  })
})

describe('keyFromArgv (Windows passes the link on the command line)', () => {
  it('finds the link among the other arguments', () => {
    expect(keyFromArgv(['C:\\Program Files\\Reel Studio\\Reel Studio.exe', '--allow-file-access', `reelstudio://updates?key=${K}`])).toBe(K)
    expect(keyFromArgv(['Reel Studio.exe', `REELSTUDIO://updates?key=${K}`])).toBe(K)
    expect(keyFromArgv(['Reel Studio.exe', '.'])).toBeNull()
  })
})

describe('keyFromText (Settings > Paste my download link)', () => {
  it('accepts every link the buyer has, and the bare key', () => {
    expect(keyFromText(K)).toBe(K)
    expect(keyFromText(`  ${K}\n`)).toBe(K)
    expect(keyFromText(`https://getreelstudio.com/updates.html#key=${K}`)).toBe(K)
    expect(keyFromText(`https://dl.getreelstudio.com/d/${K}/Reel-Studio-Setup-0.1.5-x64.exe`)).toBe(K)
    expect(keyFromText(`https://getreelstudio.com/update.html?token=${K}`)).toBe(K)
    expect(keyFromText(`reelstudio://updates?key=${K}`)).toBe(K)
  })
  it('refuses links on other sites, plain http, and text with no key', () => {
    for (const bad of [
      `https://evil.example/updates.html#key=${K}`,
      `https://getreelstudio.com.evil.example/d/${K}/x.exe`,
      `http://getreelstudio.com/updates.html#key=${K}`,
      'https://getreelstudio.com/updates.html',
      'hello',
      '',
      null
    ])
      expect(keyFromText(bad)).toBeNull()
  })
})

describe('planOf', () => {
  it('reads the plan inside the key', () => {
    expect(planOf(key('monthly'))).toBe('monthly')
    expect(planOf(key('once'))).toBe('once')
    expect(planOf(key('other'))).toBeNull()
    expect(planOf('v1.!!!.x')).toBeNull()
    expect(planOf(null)).toBeNull()
  })
})

function fakes(start: UpdateKeyState = { updateKey: null }, yes = true) {
  let state = { ...start }
  const logs: string[] = []
  const sent: UpdateKeyStatus[] = []
  const asked: { replacing: boolean }[] = []
  const svc = createUpdateKeyService({
    load: async () => state,
    save: async (p) => (state = { ...state, ...p }),
    log: (l) => logs.push(l),
    send: (s) => sent.push(s),
    confirmLink: async (o) => (asked.push(o), yes)
  })
  return { svc, logs, sent, asked, state: () => state }
}

describe('createUpdateKeyService', () => {
  it('a link turns updates on: stored, reported (plan, never the key), logged without the key', async () => {
    const f = fakes()
    expect(await f.svc.status()).toEqual({ on: false, plan: null })
    expect(await f.svc.fromLink(`reelstudio://updates?key=${K}`)).toEqual({ on: true, plan: 'monthly', asked: true })
    expect(f.asked).toEqual([{ replacing: false }])
    expect(f.state().updateKey).toBe(K)
    expect(await f.svc.get()).toBe(K)
    expect(f.sent).toEqual([{ on: true, plan: 'monthly' }])
    expect(f.logs.join('\n')).not.toContain(K.split('.')[2])
    expect(JSON.stringify(f.sent)).not.toContain('v1.')
  })
  it('a key from a link is saved only after a yes: any web page can open a reelstudio:// link', async () => {
    const f = fakes({ updateKey: null }, false)
    expect(await f.svc.fromLink(`reelstudio://updates?key=${K}`)).toBeNull()
    expect(f.state().updateKey).toBeNull()
    expect(f.sent).toEqual([])
    expect(f.logs.join(' ')).toContain('not saved')
  })
  it('a link never swaps the saved key for another without asking, and says it would replace it', async () => {
    const mine = key('once')
    const no = fakes({ updateKey: mine }, false)
    expect(await no.svc.fromLink(`reelstudio://updates?key=${K}`)).toBeNull()
    expect(no.asked).toEqual([{ replacing: true }])
    expect(no.state().updateKey).toBe(mine)
    const yes = fakes({ updateKey: mine }, true)
    expect(await yes.svc.fromLink(`reelstudio://updates?key=${K}`)).toMatchObject({ on: true, plan: 'monthly', asked: true })
    expect(yes.state().updateKey).toBe(K)
  })
  it('the same key again asks nothing', async () => {
    const f = fakes({ updateKey: K }, false)
    expect(await f.svc.fromLink(`reelstudio://updates?key=${K}`)).toEqual({ on: true, plan: 'monthly', asked: false })
    expect(f.asked).toEqual([])
  })
  it('pasting asks nothing: the person copied the key themselves', async () => {
    const f = fakes({ updateKey: key('once') }, false)
    expect(await f.svc.fromText(K)).toEqual({ on: true, plan: 'monthly' })
    expect(f.asked).toEqual([])
  })
  it('a link that is not ours changes nothing', async () => {
    const f = fakes({ updateKey: K })
    expect(await f.svc.fromLink('reelstudio://updates?key=nope')).toBeNull()
    expect(f.state().updateKey).toBe(K)
    expect(f.sent).toEqual([])
  })
  it('pasting a receipt link turns updates on; pasting junk does not', async () => {
    const f = fakes()
    expect(await f.svc.fromText('random words')).toBeNull()
    expect(f.state().updateKey).toBeNull()
    const once = key('once')
    expect(await f.svc.fromText(`https://dl.getreelstudio.com/d/${once}/Reel-Studio-0.1.5-arm64.dmg`)).toEqual({ on: true, plan: 'once' })
    expect(await f.svc.get()).toBe(once)
  })
  it('clear turns updates off and tells the page', async () => {
    const f = fakes({ updateKey: K })
    expect(await f.svc.clear()).toEqual({ on: false, plan: null })
    expect(await f.svc.get()).toBeNull()
    expect(f.sent).toEqual([{ on: false, plan: null }])
  })
  it('fails if the updater, refused for the old key, erases a key saved while that answer was on its way', async () => {
    // The save of the new key is still being written when the refusal for the old key arrives.
    let state: UpdateKeyState = { updateKey: K }
    let finishWrite!: () => void
    const svc = createUpdateKeyService({
      load: async () => state,
      save: (p) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            state = { ...state, ...p }
            resolve()
          }
        }),
      log: () => {},
      send: () => {},
      confirmLink: async () => true
    })
    const other = key('once')
    const pasting = svc.fromText(other)
    const clearing = svc.clearIfCurrent(K)
    await new Promise((r) => setTimeout(r, 0))
    finishWrite()
    await pasting
    expect(await clearing).toBe(false)
    expect(await svc.get()).toBe(other)
    expect(await svc.isCurrent(K)).toBe(false)
  })
  it('a damaged stored value counts as off', async () => {
    const f = fakes({ updateKey: 'garbage' })
    expect(await f.svc.get()).toBeNull()
    expect(await f.svc.status()).toEqual({ on: false, plan: null })
  })
})

describe('settings', () => {
  it('a settings file from before this version has automatic updates off; the key survives a save of other fields', async () => {
    setupPaths()
    expect((await loadSettings()).updateKey).toBeNull()
    await saveSettings({ updateKey: K })
    await saveSettings({ firstRunDone: true })
    expect((await loadSettings()).updateKey).toBe(K)
  })
})
