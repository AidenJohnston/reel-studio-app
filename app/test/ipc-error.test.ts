// What a failed IPC call hands the page (main/ipc-error.ts, used by index.ts handle()): the code and message, a link,
// and a field name only from the allow-list, so "Report a problem" can mark the input the error is about.
import { describe, expect, it } from 'vitest'
import { IPC_ERROR_FIELDS, ipcErrorReply } from '../src/main/ipc-error'

describe('ipcErrorReply', () => {
  it('passes an allow-listed field through, so the form can set aria-invalid', () => {
    for (const field of IPC_ERROR_FIELDS) {
      expect(ipcErrorReply({ code: 'SUPPORT_FIELD', userMessage: 'Fix this.', field })).toEqual({ code: 'SUPPORT_FIELD', userMessage: 'Fix this.', field })
    }
    expect(ipcErrorReply({ code: 'SUPPORT_FIELD', userMessage: 'Say what happened first.', field: 'what' }).field).toBe('what')
  })
  it('drops any other field name or type', () => {
    for (const field of ['__proto__', 'constructor', 'screenshot', 'appVersion', 'WHAT', '', 42, { name: 'what' }, ['what']]) {
      expect(ipcErrorReply({ code: 'SUPPORT_FIELD', userMessage: 'x', field })).not.toHaveProperty('field')
    }
  })
  it('keeps the link as before, and turns anything unexpected into the generic message', () => {
    expect(ipcErrorReply({ code: 'NEEDS_PLAN', userMessage: 'Upgrade.', link: 'https://claude.ai/upgrade' })).toMatchObject({ link: 'https://claude.ai/upgrade' })
    expect(ipcErrorReply({ code: 'X', userMessage: 'y', link: 7 })).not.toHaveProperty('link')
    const r = ipcErrorReply(new Error('boom at C:\\somewhere'))
    expect(r.code).toBe('UNEXPECTED')
    expect(r.userMessage).not.toContain('boom')
    expect(r.message).toContain('boom') // for the log only: handle() leaves it out of the reply
  })
})
