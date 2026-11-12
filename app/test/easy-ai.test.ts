// The easy-AI flag (main/easy-ai.ts): off by default, and off means none of the guided setup runs. The Connect
// screen's flag-off rendering is the e2e connect suite's (unchanged) and e2e/easy-ai.spec.ts's first test.
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { easyAiOn, easyAiTest, setupEasyAi, type EasyAiDeps } from '../src/main/easy-ai'
import { credentialStore } from '../src/main/publik'
import { CODEX_PACKAGES, CODEX_VERSION, codexBinIn } from '../src/main/codex-fetch'
import type { VendorConnect } from '../src/main/vendor-connect'

function setup(saved: boolean, env: NodeJS.ProcessEnv = {}, over: Partial<EasyAiDeps> = {}) {
  const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
  const userData = mkdtempSync(join(tmpdir(), 'easy-'))
  const calls: string[] = []
  const deps: EasyAiDeps = {
    handle: (c, fn) => void handlers.set(c, fn),
    env,
    test: {},
    saved: async () => saved,
    save: async (on) => void calls.push(`save ${on}`),
    userData,
    settingsDir: userData,
    tokenDirs: [],
    secrets: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() },
    appVersion: '0.4.0',
    platform: process.platform,
    arch: process.arch,
    vendors: () => {
      calls.push('vendors')
      return {} as VendorConnect
    },
    codexStatus: async () => (calls.push('codexStatus'), { state: 'missing' }),
    ai: {
      saveConnection: async () => (calls.push('saveConnection'), { status: { connected: false } }),
      removeConnection: async () => void calls.push('removeConnection'),
      active: async () => ({ id: 'none', connected: true })
    },
    usageAllowed: async () => true,
    openExternal: (u) => void calls.push(`open ${u}`),
    broadcast: () => {},
    aiChanged: () => {},
    log: () => {},
    ...over
  }
  const easy = setupEasyAi(deps)
  const call = (c: string, ...a: unknown[]) => Promise.resolve(handlers.get(c)!(null, ...a))
  return { easy, call, calls, userData }
}

// a stand-in for safeStorage that can encrypt, so the credential is kept in its file
const BOX = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(Buffer.from(s).map((b) => b ^ 0x33)), decryptString: (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x33)).toString() }

describe('signing out of Reel Studio’s AI', () => {
  it('fails if Sign out says it worked when the saved connection could not be removed, or loses what to remove', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'easy-out-'))
    await credentialStore(join(dir, 'publik.bin'), BOX).save({ key: 'pk_live_x', install_id: 'i1', claim_url: null, connection_id: 'c_publik' })
    const t = setup(true, {}, { settingsDir: dir, secrets: BOX, ai: { saveConnection: async () => ({ status: { connected: false } }), removeConnection: async () => Promise.reject({ code: 'locked', userMessage: 'Close other apps, then try again.' }), active: async () => ({ id: 'custom', connected: true, connectionId: 'c_publik' }) } })
    await expect(t.call('ai:guidedSignOut', 'publik')).rejects.toMatchObject({ userMessage: 'Close other apps, then try again.' })
    expect(await credentialStore(join(dir, 'publik.bin'), BOX).load()).toMatchObject({ connection_id: 'c_publik' })
  })
})

describe('the easy-AI flag', () => {
  it('fails if the guided setup can run, or the app’s own Codex is found, while the flag is off', async () => {
    const t = setup(false)
    // a Codex package fetched while the flag was on, still on disk
    const pkg = CODEX_PACKAGES[`${process.platform}-${process.arch}`]
    const release = pkg ? join(t.userData, 'codex', `${CODEX_VERSION}-${pkg.sha256.slice(0, 12)}`) : null
    const bin = release ? codexBinIn(release, process.platform) : null
    if (release && pkg && bin) {
      mkdirSync(join(release, 'bin'), { recursive: true })
      writeFileSync(bin, 'MZ')
      writeFileSync(join(release, '.complete'), pkg.sha256)
    }
    expect(await t.call('ai:easyStatus')).toEqual({ on: false, publik: false })
    for (const route of ['chatgpt', 'publik']) {
      await expect(t.call('ai:guidedStart', route)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' })
      await expect(t.call('ai:guidedSignOut', route)).rejects.toMatchObject({ code: 'NOT_AVAILABLE' })
    }
    expect(t.easy.managedCodex()).toBeNull()
    expect(t.calls).toEqual([]) // nothing asked Codex, the vendor connect, the AI or the browser
    // turned on in Settings, the same copy is found
    expect(await t.call('ai:setEasyAi', true)).toMatchObject({ on: true })
    expect(t.easy.managedCodex()).toBe(bin) // null where the pin has no package (Linux)
    expect(await t.call('ai:setEasyAi', false)).toMatchObject({ on: false })
    expect(t.easy.managedCodex()).toBeNull()
  })

  it('fails if the setting and REELSTUDIO_EASY_AI do not decide it the documented way', () => {
    expect([easyAiOn(false, {}), easyAiOn(undefined, {}), easyAiOn(true, {}), easyAiOn(false, { REELSTUDIO_EASY_AI: '1' }), easyAiOn(true, { REELSTUDIO_EASY_AI: '0' })]).toEqual([false, false, true, true, false])
  })

  it('fails if Reel Studio’s AI is offered by a build that has no publik app token', async () => {
    const t = setup(true)
    expect(await t.call('ai:easyStatus')).toEqual({ on: true, publik: false })
    await expect(t.call('ai:guidedStart', 'publik')).rejects.toMatchObject({ code: 'NOT_AVAILABLE' })
  })

  it('fails if a test switch can point a real run at another server or another Codex', () => {
    const env = { REELSTUDIO_TEST_PUBLIK_ORIGIN: 'http://127.0.0.1:4000', REELSTUDIO_TEST_PUBLIK_TOKEN: 'pat_t', REELSTUDIO_TEST_CODEX_PACKAGE: JSON.stringify({ url: 'http://127.0.0.1:4000/c.tar.gz', sha256: 'a'.repeat(64) }) }
    expect(easyAiTest(env, false)).toEqual({})
    expect(Object.keys(easyAiTest(env, true)).sort()).toEqual(['codexPackage', 'publikOrigin', 'publikToken'])
    expect(easyAiTest({ REELSTUDIO_TEST_PUBLIK_ORIGIN: 'https://elsewhere.example' }, true)).toEqual({})
  })
})
