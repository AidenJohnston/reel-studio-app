import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRODUCTION_FEED, feedFromConfig } from '../src/main/update-feed'

describe('update feed', () => {
  it('is production unless app-update.yml names the staging feed exactly', () => {
    expect(feedFromConfig(null)).toEqual(PRODUCTION_FEED)
    expect(feedFromConfig('provider: generic\nurl: https://dl.getreelstudio.com/u/\n')).toEqual(PRODUCTION_FEED)
    for (const bad of ['https://dl-staging.getreelstudio.com.evil.example/u/', 'http://dl-staging.getreelstudio.com/u/', 'https://dl-staging.getreelstudio.com/x/', 'https://evil.example/u/']) {
      expect(feedFromConfig(`provider: generic\nurl: ${bad}\n`)).toEqual(PRODUCTION_FEED)
    }
    expect(feedFromConfig('provider: generic\r\nurl: https://dl-staging.getreelstudio.com/u/\r\n')).toEqual({
      latestUrl: 'https://dl-staging.getreelstudio.com/latest.json',
      feedUrl: 'https://dl-staging.getreelstudio.com/u/',
      staging: true
    })
  })

  it('make-config points the publish url at RS_UPDATE_HOST and refuses other hosts', () => {
    const script = join(__dirname, '..', '..', 'packaging', 'make-config.js')
    const env = { ...process.env, RS_REPO_ROOT: '/r', RS_APP_DIR: '/a', RS_ENGINE_DIR: '/e', RS_RUNTIME_DIR: '/rt', RS_TEMPLATES_DIR: '/t', RS_WIN_SIGN: '', RS_UPDATE_HOST: '' }
    const fill = (extra: Record<string, string>): string => execFileSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8' }).trim()
    const yml = (extra: Record<string, string>): string => readFileSync(fill(extra), 'utf8')
    expect(yml({})).toMatch(/^ {2}url: https:\/\/dl\.getreelstudio\.com\/u\/$/m)
    expect(yml({ RS_UPDATE_HOST: 'dl-staging.getreelstudio.com' })).toMatch(/^ {2}url: https:\/\/dl-staging\.getreelstudio\.com\/u\/$/m)
    expect(() => fill({ RS_UPDATE_HOST: 'evil.example' })).toThrow()
    fill({}) // leave the production config behind for whatever builds next
  })
})
