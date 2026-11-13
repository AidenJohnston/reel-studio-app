// What an IPC handler's failure looks like to the page (index.ts `handle()`): the code and the message to show, plus
// two optional extras a thrown error may carry. `link` is any string (a page to open). `field` names the input to mark
// invalid (aria-invalid), and only names on the allow-list pass, so an error can never put an arbitrary key or value
// into the page's form state.
import { toUserError } from './engine'

/** Field names a handler may point at: "Report a problem" (main/support.ts). Add a form's names here when it needs them. */
export const IPC_ERROR_FIELDS: ReadonlySet<string> = new Set(['what', 'expected', 'email'])

export interface IpcErrorReply {
  code: string
  userMessage: string
  link?: string
  field?: string
}

export function ipcErrorReply(err: unknown): IpcErrorReply & { message?: string } {
  const u = toUserError(err)
  const link = (err as { link?: unknown })?.link
  const field = (err as { field?: unknown })?.field
  return {
    code: u.code,
    userMessage: u.userMessage,
    ...(u.message !== undefined ? { message: u.message } : {}),
    ...(typeof link === 'string' ? { link } : {}),
    ...(typeof field === 'string' && IPC_ERROR_FIELDS.has(field) ? { field } : {})
  }
}
