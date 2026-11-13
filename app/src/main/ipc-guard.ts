import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

function sameRendererPath(actual: string, expected: string): boolean {
  try {
    const windows = process.platform === 'win32'
    const a = fileURLToPath(actual, { windows })
    const e = fileURLToPath(expected, { windows })
    return windows ? a.toLowerCase() === e.toLowerCase() : a === e
  } catch {
    return false
  }
}

export function assertIpcSender(e: IpcMainInvokeEvent | IpcMainEvent, contents: WebContents | undefined, rendererUrl: string): void {
  const denied = { code: 'FORBIDDEN', userMessage: 'This page cannot control Reel Studio.' }
  if (!contents || contents.isDestroyed() || e.sender !== contents || e.senderFrame !== contents.mainFrame) throw denied
  const actual = new URL(e.senderFrame.url)
  const expected = new URL(rendererUrl)
  if (actual.protocol !== expected.protocol || actual.origin !== expected.origin || (expected.protocol === 'file:' && !sameRendererPath(actual.href, expected.href))) throw denied
}

const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0')
const path = (v: unknown): v is string => text(v) && isAbsolute(v)
const paths = (v: unknown): v is string[] => Array.isArray(v) && v.every(path)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text)
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const anchor = (v: unknown): boolean => object(v) && text(v.from) && text(v.to)

function validPatch(patch: unknown): boolean {
  if (!object(patch)) return false
  return Object.entries(patch).every(([key, v]) => {
    switch (key) {
      case 'title': return text(v)
      case 'cut': return object(v) && Array.isArray(v.keep) && v.keep.every(anchor)
      case 'captions': return object(v) && typeof v.enabled === 'boolean' && (v.style === undefined || object(v.style)) &&
        (v.corrections === undefined || (Array.isArray(v.corrections) && v.corrections.every(anchor)))
      case 'music': return object(v) && typeof v.enabled === 'boolean' && (v.track === null || text(v.track)) &&
        (v.startAt === undefined || finite(v.startAt)) && (v.fadeOut === undefined || finite(v.fadeOut))
      // project.schema.json requires only id, anchor and treatment; asset and params are optional.
      case 'broll': return Array.isArray(v) && v.every((b) => object(b) && text(b.id) && anchor(b.anchor) && text(b.treatment) &&
        (b.asset === undefined || b.asset === null || text(b.asset)) && (b.params === undefined || object(b.params)))
      case 'zooms': return Array.isArray(v)
      // The schema permits an absent or null frame until the creator or AI picks one.
      case 'cover': return v === null || (object(v) &&
        (v.atSourceTime === undefined || v.atSourceTime === null || (finite(v.atSourceTime) && v.atSourceTime >= 0)) &&
        (v.source === undefined || v.source === null || text(v.source)) &&
        (v.text === undefined || v.text === null || text(v.text)) &&
        (v.exact === undefined || v.exact === null || typeof v.exact === 'boolean'))
      case 'post': return object(v) && text(v.caption) && strings(v.hashtags) && strings(v.keywords)
      default: return true
    }
  })
}

export function validateIpcArgs(channel: string, args: unknown[]): void {
  const [first, second, third] = args
  const bad = { code: 'BAD_ARGS', userMessage: 'That request was not valid. Try again.' }
  if ((channel.startsWith('projects:') && !['projects:list', 'projects:create'].includes(channel)) || channel.startsWith('notes:') || channel === 'style:answer') {
    if (!text(first) || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(first)) throw bad
  }
  let ok = true
  switch (channel) {
    case 'app:openFolder': case 'app:setRoot': case 'app:startDrag': ok = path(first); break
    case 'projects:create': case 'library:add': ok = paths(first); break
    case 'projects:update': ok = validPatch(second); break
    case 'projects:export': ok = finite(second) && Number.isInteger(second) && second >= 0; break
    case 'projects:note': ok = text(second) && (third === undefined || strings(third)); break
    case 'projects:rerender': ok = (second === undefined || text(second)) && (third === undefined || text(third)); break
    case 'notes:attachFiles': ok = paths(second); break
    case 'notes:attachData': ok = object(second) && text(second.name) && text(second.mime) && second.bytes instanceof Uint8Array; break
    case 'notes:removeAttachment': ok = text(second); break
    case 'library:choose': ok = first === 'music' || first === 'images'; break
    case 'jobs:cancel': case 'style:remove': ok = text(first) && first.length > 0; break
    case 'style:answer': ok = text(second) && typeof third === 'boolean'; break
    case 'dev:renderTestAnimation': ok = path(first) && (second === undefined || typeof second === 'boolean') &&
      (third === undefined || text(third)) && (args[3] === undefined || object(args[3])); break
  }
  if (!ok) throw bad
}
