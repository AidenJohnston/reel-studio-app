// Finding CLIProxyAPI on this computer (main/vendor-hub.ts): its config in either layout, a running copy's --config,
// and the probe of /v1/models against a fake hub on a random port. No real config or key is read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeHub } from '../../ai/test/fakeHub'
import { configsOfRunning, confirmHub, detectHub, hubConfigCandidates, localAddress, parseHubConfig, type Lookup } from '../src/main/vendor-hub'

// The test folder is a real folder on the computer running the tests, so a path found in it is joined the way this
// computer joins paths: on Windows a macOS platform would give `C:\...\rs-hub-x/config.yaml`.
const HOST = process.platform

describe('reading CLIProxyAPI’s config', () => {
  it('the older layout: an empty host is this computer, and the api-keys list holds the client keys', () => {
    const c = parseHubConfig('host: ""\nport: 8411\napi-keys:\n  - "k-one"\n  - "k-two"\n', '/x/config.yaml')
    expect(c).toEqual({ file: '/x/config.yaml', host: '127.0.0.1', port: 8411, tls: false, keys: ['k-one', 'k-two'] })
  })

  it('the v8 layout: server and access sections, TLS, and the top-level api-keys map of upstream keys left out', () => {
    const yaml = 'server:\n  host: 0.0.0.0\n  port: 9443\n  tls:\n    enable: true\naccess:\n  api-keys:\n    - client-key\napi-keys:\n  claude:\n    - api-key: upstream-secret\n'
    expect(parseHubConfig(yaml, '/y')).toEqual({ file: '/y', host: '127.0.0.1', port: 9443, tls: true, keys: ['client-key'] })
  })

  it('not YAML, or a port that is not one: nothing', () => {
    expect(parseHubConfig('port: [', '/z')).toBeNull()
    expect(parseHubConfig('port: 70000', '/z')).toBeNull()
  })

  it('looks where Homebrew and the auth folder keep it, or only in the test folder', () => {
    expect(hubConfigCandidates({}, 'darwin', '/Users/p').slice(0, 3)).toEqual(['/opt/homebrew/etc/cliproxyapi.conf', '/usr/local/etc/cliproxyapi.conf', '/Users/p/.cli-proxy-api/config.yaml'])
    expect(hubConfigCandidates({ REELSTUDIO_TEST_HUB_CONFIG: '/t' }, 'darwin', '/Users/p')).toEqual(['/t/config.yaml', '/t/cliproxyapi.conf'])
    expect(hubConfigCandidates({ LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' }, 'win32', 'C:\\Users\\p')).toContain('C:\\Users\\p\\.cli-proxy-api\\config.yaml')
  })

  it('a running copy’s --config, in either spelling; other programs are ignored', () => {
    const ps = ['/Users/p/build/bin/cliproxyapi-current --config /opt/homebrew/etc/cliproxyapi.conf', '/opt/homebrew/opt/cliproxyapi/bin/cliproxyapi -config=/srv/hub.yaml', 'vim --config /etc/not-this.yaml', 'cliproxyapi --config relative.yaml'].join('\n')
    expect(configsOfRunning(ps)).toEqual(['/opt/homebrew/etc/cliproxyapi.conf', '/srv/hub.yaml'])
  })
})

describe('finding the hub', () => {
  let hub: FakeHub
  let dir: string
  const asked: string[] = []
  const f = (u: string, i?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    asked.push(u)
    return fetch(u, i)
  }
  beforeEach(async () => {
    hub = new FakeHub()
    await hub.start()
    dir = mkdtempSync(join(tmpdir(), 'rs-hub-'))
    asked.length = 0
  })
  afterEach(async () => {
    await hub.stop()
  })

  it('ready with the config’s key: the count of models the picker will list, the file it came from, and the key kept for Use it', async () => {
    writeFileSync(join(dir, 'config.yaml'), `port: ${hub.port}\napi-keys:\n  - stale\n  - ${hub.key}\n`)
    const found = await detectHub({ env: { REELSTUDIO_TEST_HUB_CONFIG: dir }, platform: HOST, fetch: f, home: '/nobody' })
    expect(found).toEqual({ state: 'ready', origin: hub.origin, models: 5, keySource: join(dir, 'config.yaml'), key: hub.key, file: join(dir, 'config.yaml') })
  })

  it('answers but refuses every key in the config: asks for one, and says the config’s keys were refused', async () => {
    writeFileSync(join(dir, 'cliproxyapi.conf'), `port: ${hub.port}\napi-keys: [old-key]\n`)
    const found = await detectHub({ env: { REELSTUDIO_TEST_HUB_CONFIG: dir }, platform: HOST, fetch: f, home: '/nobody' })
    expect(found).toEqual({ state: 'needs-key', origin: hub.origin, keySource: join(dir, 'cliproxyapi.conf'), file: join(dir, 'cliproxyapi.conf'), keyRefused: true })
  })

  it('no config in the test folder: none, and the real default port is never asked', async () => {
    const found = await detectHub({ env: { REELSTUDIO_TEST_HUB_CONFIG: dir }, platform: 'darwin', fetch: f, home: '/nobody', running: async () => ['/should/not/be/read'] })
    expect(found).toEqual({ state: 'none' })
    expect(asked).toEqual([])
  })

  it('nothing anywhere: none, naming the address it looked at', async () => {
    // no file is read for real: the usual places include this computer's own config
    const read: string[] = []
    const tried: string[] = []
    const found = await detectHub({
      env: {}, platform: 'darwin', home: '/nobody', running: async () => [],
      readFile: async (p: string) => { read.push(p); throw Object.assign(new Error('no such file'), { code: 'ENOENT' }) },
      fetch: async (u: string) => { tried.push(u); throw new Error('connect ECONNREFUSED') }
    })
    expect(found).toEqual({ state: 'none', looked: '127.0.0.1:8317' })
    expect(read).toContain('/opt/homebrew/etc/cliproxyapi.conf')
    expect(tried.length).toBeGreaterThan(0)
    expect(tried.every((u) => u.startsWith('http://127.0.0.1:8317/'))).toBe(true)
  })
})

describe('only this computer gets the key (r12 review)', () => {
  let hub: FakeHub
  let dir: string
  const asked: string[] = []
  const f = (u: string, i?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: 'error' }) => {
    asked.push(u)
    return fetch(u, i)
  }
  const resolvesTo = (...addresses: string[]): Lookup => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  beforeEach(async () => {
    hub = new FakeHub()
    await hub.start()
    dir = mkdtempSync(join(tmpdir(), 'rs-hub-'))
    asked.length = 0
  })
  afterEach(async () => {
    await hub.stop()
  })
  const env = () => ({ REELSTUDIO_TEST_HUB_CONFIG: dir })

  it('a config naming another computer is shown as elsewhere and is never asked anything', async () => {
    writeFileSync(join(dir, 'config.yaml'), `host: hub.example.com\nport: ${hub.port}\napi-keys: [${hub.key}]\n`)
    const found = await detectHub({ env: env(), platform: HOST, fetch: f, home: '/nobody', lookup: resolvesTo('203.0.113.7') })
    expect(found).toEqual({ state: 'elsewhere', host: 'hub.example.com', keySource: join(dir, 'config.yaml') })
    expect(asked).toEqual([])
    expect(hub.requests).toEqual([])
  })

  it('a name is resolved once, every address must be loopback, and requests go to the address itself', async () => {
    expect(await localAddress('hub.local', resolvesTo('127.0.0.1', '10.0.0.5'))).toBeNull()
    expect(await localAddress('hub.local', resolvesTo('::1'))).toBe('::1')
    expect(await localAddress('192.168.1.4')).toBeNull()
    writeFileSync(join(dir, 'config.yaml'), `host: hub.local\nport: ${hub.port}\napi-keys: [${hub.key}]\n`)
    const found = await detectHub({ env: env(), platform: 'darwin', fetch: f, home: '/nobody', lookup: resolvesTo('127.0.0.1') })
    expect(found).toMatchObject({ state: 'ready', origin: `http://127.0.0.1:${hub.port}` })
    expect(asked.every((u) => u.startsWith(`http://127.0.0.1:${hub.port}/`))).toBe(true)
  })

  it('a redirect is refused, so the key never leaves the address that was checked', async () => {
    const other = new FakeHub()
    await other.start()
    const bounce = http.createServer((_q, r) => r.writeHead(302, { location: `${other.origin}/v1/models` }).end())
    await new Promise<void>((r) => bounce.listen(0, '127.0.0.1', r))
    try {
      writeFileSync(join(dir, 'config.yaml'), `port: ${(bounce.address() as { port: number }).port}\napi-keys: [${hub.key}]\n`)
      const found = await detectHub({ env: env(), platform: 'darwin', fetch: f, home: '/nobody' })
      expect(found.state).toBe('none')
      expect(other.requests).toEqual([])
    } finally {
      bounce.close()
      await other.stop()
    }
  })

  it('right before Use it the config is read again: another host, or a key no longer in it, is refused', async () => {
    const file = join(dir, 'config.yaml')
    writeFileSync(file, `port: ${hub.port}\napi-keys: [${hub.key}]\n`)
    const deps = { env: env(), platform: HOST, fetch: f, home: '/nobody', lookup: resolvesTo('203.0.113.7') }
    const found = await detectHub(deps)
    expect(await confirmHub(deps, found)).toEqual({ origin: hub.origin, key: hub.key, keySource: file })
    writeFileSync(file, `host: hub.example.com\nport: ${hub.port}\napi-keys: [${hub.key}]\n`)
    asked.length = 0
    await expect(confirmHub(deps, found)).rejects.toMatchObject({ code: 'HUB_NOT_LOCAL' })
    await expect(confirmHub(deps, found, 'typed-key')).rejects.toMatchObject({ code: 'HUB_NOT_LOCAL' })
    expect(asked).toEqual([])
    writeFileSync(file, `port: ${hub.port}\napi-keys: [another-key]\n`)
    await expect(confirmHub(deps, found)).rejects.toMatchObject({ code: 'HUB_CHANGED' })
  })
})
