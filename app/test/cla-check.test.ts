// The CLA check's decisions (.github/scripts/cla.cjs, run by .github/workflows/cla.yml).
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

interface Comment {
  login: string
  body: string
}
interface Cla {
  PHRASE: string
  MARKER: string
  trustedLogins(vouched: string): Set<string>
  claState(a: { author: { login: string; type: string }; comments: Comment[]; trusted: Set<string> }): { state: 'success' | 'failure'; description: string }
  instructions(login: string, repoUrl: string): string
}
const cla = createRequire(import.meta.url)('../../.github/scripts/cla.cjs') as Cla

const VOUCHED = ['# comment', 'github:Maintainer-A', '-github:Spammer posted malware', '  github:maintainer-b  extra words', 'github:'].join('\n')
const user = (login: string) => ({ login, type: 'User' })

describe('CLA check', () => {
  it('trusts only `github:` lines, lowercased, never a denounced or empty one', () => {
    expect([...cla.trustedLogins(VOUCHED)].sort()).toEqual(['maintainer-a', 'maintainer-b'])
  })

  it('passes a maintainer, a bot, and an author who commented the sentence', () => {
    const trusted = cla.trustedLogins(VOUCHED)
    expect(cla.claState({ author: user('MAINTAINER-B'), comments: [], trusted }).state).toBe('success')
    expect(cla.claState({ author: { login: 'dependabot[bot]', type: 'Bot' }, comments: [], trusted }).state).toBe('success')
    const signed = [{ login: 'NewPerson', body: `  ${cla.PHRASE.toUpperCase().replace(/ /g, '\n ')}  ` }]
    expect(cla.claState({ author: user('newperson'), comments: signed, trusted }).state).toBe('success')
  })

  it("fails an author whose only acceptance is someone else's, partial, or has more words", () => {
    const trusted = cla.trustedLogins(VOUCHED)
    const state = (comments: Comment[]) => cla.claState({ author: user('newperson'), comments, trusted }).state
    expect(state([])).toBe('failure')
    expect(state([{ login: 'someoneelse', body: cla.PHRASE }])).toBe('failure')
    expect(state([{ login: 'newperson', body: cla.PHRASE.slice(0, -1) }])).toBe('failure')
    expect(state([{ login: 'newperson', body: `${cla.PHRASE} Not really.` }])).toBe('failure')
    expect(state([{ login: 'newperson', body: `> ${cla.PHRASE}` }])).toBe('failure')
  })

  it('a denounced author is not a maintainer', () => {
    expect(cla.claState({ author: user('spammer'), comments: [], trusted: cla.trustedLogins(VOUCHED) }).state).toBe('failure')
  })

  it("starts its instructions with its marker and quotes the exact sentence and the CLA's address", () => {
    const text = cla.instructions('newperson', 'https://github.com/o/r')
    expect(text.startsWith(cla.MARKER)).toBe(true)
    expect(text).toContain(`\n${cla.PHRASE}\n`)
    expect(text).toContain('(https://github.com/o/r/blob/HEAD/CLA.md)')
    expect(text).toContain('@newperson')
  })
})
