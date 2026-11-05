// The Post sheet and Settings > Posting (shared/posting.ts): which screen shows when, what the form accepts, and
// the words, which follow the house style (plain, no em dashes, no jargon). The components have no DOM harness
// here, so the last block checks they really use this copy (a helper with no caller proves nothing).
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONNECT_NOTES,
  DONE_PRIVACY,
  FAILED_BUTTONS,
  FIELD_ERRORS,
  POST_COPY,
  POSTING_ERRORS,
  SETTINGS_COPY,
  defaultDescription,
  defaultTitle,
  descriptionProblem,
  disconnectBody,
  failedAction,
  pct,
  postingError,
  privacyChanged,
  retryLine,
  sheetState,
  signedInLine,
  signedOutCopy,
  titleProblem,
  youtubeLine
} from '../src/shared/posting'
import type { PostingStatus, PostProgress } from '../src/shared/api'

const S = (extra: Partial<PostingStatus> = {}): PostingStatus => ({
  enabled: true,
  hasKey: true,
  signedIn: true,
  signedOutByServer: false,
  otherComputers: 0,
  youtube: { state: 'connected', channelName: 'My channel', channelUrl: null },
  ended: false,
  connecting: false,
  ...extra
})
const P = (step: PostProgress['step']): PostProgress => ({ uploadId: 'u_1', slug: 's', version: 1, step, sent: 0, total: 10 })

describe('sheetState', () => {
  it('walks the person through what is missing, in order', () => {
    expect(sheetState(null, {})).toBe('loading')
    expect(sheetState(S({ hasKey: false, signedIn: false, youtube: null }), {})).toBe('no_key')
    expect(sheetState(S({ signedIn: false, signedOutByServer: true, youtube: null }), {})).toBe('signed_out')
    expect(sheetState(S({ signedIn: false, youtube: null }), {})).toBe('signed_out')
    expect(sheetState(S({ youtube: null }), {})).toBe('not_connected')
    expect(sheetState(S({ youtube: { state: 'reconnect', channelName: null, channelUrl: null } }), {})).toBe('reconnect')
    expect(sheetState(S(), {})).toBe('form')
    expect(sheetState(S(), { pending: { uploadId: 'u', slug: 's', version: 1, sent: 1, total: 2 } })).toBe('resume')
  })
  it('not signed in here: Sign in first, never "not connected" (the connection belongs to the purchase and stays)', () => {
    // after Sign out or Sign out everywhere on this computer, signedOutByServer is false
    const out = S({ signedIn: false, youtube: null })
    expect(sheetState(out, {})).toBe('signed_out')
    expect(signedOutCopy(out)).toBe(POST_COPY.signIn)
    expect(signedOutCopy(S({ signedIn: false, signedOutByServer: true, youtube: null }))).toBe(POST_COPY.signedOut)
    expect(POST_COPY.signIn).not.toMatch(/Sign out everywhere/)
  })
  it('an ended subscription comes before everything but a running post', () => {
    expect(sheetState(S({ ended: true, hasKey: false, signedIn: false }), {})).toBe('ended')
    expect(sheetState(S({ ended: true }), { progress: P('sending') })).toBe('sending')
  })
  it('connecting, from this sheet or from Settings', () => {
    expect(sheetState(S({ youtube: null }), { connecting: true })).toBe('connecting')
    expect(sheetState(S({ youtube: null, connecting: true }), {})).toBe('connecting')
  })
  it('a post shows its progress, until Try again goes back to the form', () => {
    expect(sheetState(S(), { progress: P('starting') })).toBe('sending')
    expect(sheetState(S(), { progress: P('retrying') })).toBe('retrying')
    expect(sheetState(S(), { progress: P('failed') })).toBe('failed')
    expect(sheetState(S(), { progress: P('done') })).toBe('done')
    expect(sheetState(S(), { progress: P('failed'), editing: true })).toBe('form')
    expect(sheetState(S(), { progress: P('cancelled') })).toBe('form')
  })
})

describe('the form', () => {
  it('title: needed, no < or >, at most 100', () => {
    expect(titleProblem('  ')).toBe('Give it a title first.')
    expect(titleProblem('a > b')).toBe("YouTube doesn't allow < or > in a title.")
    expect(titleProblem('x'.repeat(100))).toBeNull()
    expect(titleProblem('x'.repeat(101))).toBe(FIELD_ERRORS.title)
  })
  it('description: at most 5,000 bytes, no < or >', () => {
    expect(descriptionProblem('')).toBeNull()
    expect(descriptionProblem('é'.repeat(2500))).toBeNull()
    expect(descriptionProblem('é'.repeat(2501))).toBe(FIELD_ERRORS.description)
    expect(descriptionProblem('<b>')).toBe(FIELD_ERRORS.description)
  })
  it('prefills from the reel and the caption, made fit for YouTube', () => {
    expect(defaultTitle('  My <first> reel ')).toBe('My first reel')
    expect(defaultTitle('😀'.repeat(60)).length).toBeLessThanOrEqual(100)
    expect(defaultTitle('😀'.repeat(60))).not.toMatch(/[\ud800-\udbff]$/) // never half an emoji
    expect(defaultDescription('Hi <there>\n\n#jobs')).toBe('Hi there\n\n#jobs')
    expect(new TextEncoder().encode(defaultDescription('é'.repeat(4000))).length).toBeLessThanOrEqual(5000)
  })
  it('done: says who can see it, and when YouTube set something else', () => {
    expect(DONE_PRIVACY.private).toContain('Only me')
    expect(privacyChanged('public', 'public')).toBeNull()
    expect(privacyChanged('public', 'private')).toBe('YouTube set it to Only me instead. You can change it in YouTube Studio.')
    expect(pct(5, 10)).toBe(50)
    expect(pct(0, 0)).toBe(0)
  })
  it('Settings > Posting never says "not connected" just because this computer is signed out', () => {
    expect(youtubeLine(S({ signedIn: false, youtube: null }))).toBe('sign in to see your channel')
    expect(youtubeLine(S({ signedIn: false, hasKey: false, youtube: null }))).toBe('not connected')
    expect(youtubeLine(S({ youtube: null }))).toBe('not connected')
    expect(youtubeLine(S())).toBe('My channel')
    expect(youtubeLine(S({ youtube: { state: 'reconnect', channelName: 'My channel', channelUrl: null } }))).toBe('needs connecting again')
  })
  it('Settings lines', () => {
    expect(signedInLine(0)).toBe('Signed in on this computer.')
    expect(signedInLine(1)).toBe('Signed in on this computer. And on 1 other computer.')
    expect(signedInLine(3)).toBe('Signed in on this computer. And on 3 other computers.')
    expect(disconnectBody(null)).toContain('your channel')
  })
  it('ENDED carries the subscribe link', () => {
    expect(postingError('ENDED').link).toBe('https://getreelstudio.com/#pricing')
    expect(postingError('BAD_FIELD', 'privacy')).toMatchObject({ code: 'BAD_FIELD', userMessage: FIELD_ERRORS.privacy })
  })
})

describe('a failed post', () => {
  const F = (code: string, extra: Partial<PostProgress> = {}): PostProgress => ({ ...P('failed'), error: { code, userMessage: 'x' }, ...extra })
  it('offers the button its message names', () => {
    expect(failedAction(F('OFFLINE', { canResume: true }))).toBe('finish')
    expect(failedAction(F('SERVER', { canResume: true }))).toBe('finish')
    expect(failedAction(F('OFFLINE'))).toBe('try_again')
    expect(failedAction(F('SIGNED_OUT'))).toBe('sign_in')
    for (const c of ['RECONNECT', 'NOT_CONNECTED', 'NO_CHANNEL']) expect(failedAction(F(c)), c).toBe('connect')
    expect(failedAction(F('EXPIRED'))).toBe('post_again')
    expect(failedAction(F('FILE_CHANGED'))).toBe('start_over')
    expect(failedAction(F('ENDED'))).toBeNull()
    expect(failedAction(F('QUOTA'))).toBe('try_again')
  })
  it('every message that names a button is shown above that button', () => {
    const named: [string, string][] = [
      ['SIGNED_OUT', FAILED_BUTTONS.sign_in],
      ['EXPIRED', FAILED_BUTTONS.post_again],
      ['FILE_CHANGED', FAILED_BUTTONS.start_over]
    ]
    for (const [code, button] of named) {
      expect(POSTING_ERRORS[code as keyof typeof POSTING_ERRORS], code).toContain(`Click ${button}`)
      expect(FAILED_BUTTONS[failedAction(F(code))!]).toBe(button)
    }
    // OFFLINE shows in Settings and before an upload exists too, where there is no Finish posting
    expect(POSTING_ERRORS.OFFLINE).not.toMatch(/Finish posting/)
  })
  it('the retry line says whose trouble it is', () => {
    expect(retryLine('offline', 8)).toBe('The connection dropped. Trying again in 8 seconds…')
    expect(retryLine(undefined, 2)).toBe('The connection dropped. Trying again in 2 seconds…')
    expect(retryLine('youtube', 4)).toBe('YouTube is busy. Trying again in 4 seconds…')
    expect(retryLine('server', 1)).toBe('The posting server is having trouble. Trying again in 1 second…')
  })
})

describe('copy', () => {
  const all = [
    ...Object.values(POSTING_ERRORS),
    ...Object.values(FIELD_ERRORS),
    ...Object.values(POST_COPY),
    ...Object.values(CONNECT_NOTES).filter(Boolean),
    ...Object.values(DONE_PRIVACY),
    ...Object.values(SETTINGS_COPY),
    ...Object.values(FAILED_BUTTONS),
    retryLine('youtube', 2),
    retryLine('server', 2)
  ].join(' ')
  it('no em dashes, no jargon', () => {
    expect(all).not.toMatch(/[–—]/)
    expect(all).not.toMatch(/\b(token|OAuth|session|API|quota|scope|refresh|credential|authori[sz]e|endpoint|upload ID|HTTP)\b/i)
  })
  it('the components use it', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'components', f), 'utf8')
    const sheet = src('PostSheet.tsx')
    for (const k of ['noKey', 'ended', 'notConnected', 'reconnect', 'connecting', 'privacyHelp', 'kidsHelp', 'notAShort', 'keepOpen', 'doneHeading'])
      expect(sheet, k).toContain(`POST_COPY.${k}`)
    for (const f of ['signedOutCopy(', 'failedAction(', 'FAILED_BUTTONS[', 'retryLine(']) expect(sheet, f).toContain(f)
    expect(sheet).toContain('CONNECT_NOTES')
    expect(sheet).toContain('TERMS_URL')
    const settings = src('PostingSettings.tsx')
    for (const k of ['intro', 'coming', 'privacy', 'everywhereBody']) expect(settings, k).toContain(`SETTINGS_COPY.${k}`)
    expect(settings).toContain('youtubeLine(s)')
    expect(src('PostButton.tsx')).toContain('enabled')
  })
})
