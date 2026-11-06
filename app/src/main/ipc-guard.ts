import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRY_VARIABLES } from '../shared/platforms'

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
/** A reference reel's id (main references.ts: a UUID). */
const referenceId = (v: unknown): v is string => text(v) && /^[0-9a-f-]{8,64}$/.test(v)
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
  if ((channel.startsWith('projects:') && !['projects:list', 'projects:create', 'projects:search', 'projects:plan'].includes(channel)) || channel.startsWith('notes:') || channel === 'style:answer' || channel === 'style:rememberLowercase' || channel === 'phone:startPlan') {
    if (!text(first) || !/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(first)) throw bad
  }
  let ok = true
  switch (channel) {
    case 'app:openFolder': case 'app:setRoot': case 'app:startDrag': ok = path(first); break
    case 'projects:create': case 'library:add': ok = paths(first); break
    case 'projects:search': ok = text(first) && first.length <= 200; break
    case 'projects:addVideo': ok = paths(second); break
    case 'projects:planSay': ok = text(second); break
    case 'projects:resume': ok = second === undefined || typeof second === 'boolean'; break
    case 'projects:update': ok = validPatch(second); break
    case 'projects:export': ok = finite(second) && Number.isInteger(second) && second >= 0; break
    // args[5]: the saved version a branched note changes (note-intake.ts checks it against project.json)
    case 'projects:note': ok = text(second) && (third === undefined || strings(third)) && (args[5] === undefined || (finite(args[5]) && Number.isInteger(args[5]) && args[5] >= 1)); break
    case 'projects:mergeVersions': ok = object(second) && [second.ours, second.theirs].every((n) => finite(n) && Number.isInteger(n) && n >= 1) &&
      object(second.take) && Object.values(second.take).every((v) => v === 'ours' || v === 'theirs'); break
    case 'projects:handEdit': ok = object(second) && text(third) && finite(args[3]) && (args[4] === undefined || text(args[4])); break
    case 'notes:attachFiles': ok = paths(second); break
    case 'notes:attachData': ok = object(second) && text(second.name) && text(second.mime) && second.bytes instanceof Uint8Array; break
    case 'notes:removeAttachment': ok = text(second); break
    case 'library:choose': ok = first === 'music' || first === 'images'; break
    case 'jobs:cancel': case 'cloud:cancel': case 'style:remove': case 'style:restore': case 'style:add': ok = text(first) && first.length > 0; break
    case 'style:update': ok = text(first) && first.length > 0 && object(second) && (second.text === undefined || text(second.text)) && (second.paused === undefined || typeof second.paused === 'boolean'); break
    case 'app:setPhoneView': ok = first === 'instagram' || first === 'clean'; break
    case 'app:setTimeline': case 'outside:setEnabled': ok = typeof first === 'boolean'; break
    case 'ai:setNoteRunner': ok = first === 'reelstudio' || first === 'app'; break
    case 'devices:setOn': case 'devices:openInBrowser': ok = typeof first === 'boolean'; break
    case 'devices:pair': ok = (first === 'phone' || first === 'browser') && typeof second === 'boolean'; break
    case 'devices:remove': ok = text(first) && /^[0-9a-f]{32}$/.test(first); break
    case 'projects:exportPlatforms': ok = finite(second) && Number.isInteger(second) && second >= 0 && object(third); break
    case 'projects:proposeTry': ok = finite(second) && Number.isInteger(second) && second >= 0 && object(third) && text(third.caption) &&
      third.caption.length <= 100_000 && (third.variable === undefined || (TRY_VARIABLES as readonly unknown[]).includes(third.variable)); break
    // a pick names 1 to 5 of the proposal's candidates (ai propose.ts REEL_LIMIT), each once
    case 'projects:makeReels': ok = Array.isArray(second) && second.length >= 1 && second.length <= 5 && new Set(second).size === second.length &&
      second.every((id) => text(id) && /^r\d+$/.test(id)); break
    case 'projects:foldReels': ok = typeof second === 'boolean'; break
    // found edits by id (style:find); the paths stay in main
    case 'style:learn': ok = first === undefined || (Array.isArray(first) && first.length > 0 && first.every((id) => text(id) && /^[0-9a-f]{16}$/.test(id))); break
    case 'style:reveal': ok = text(first) && /^[0-9a-f]{16}$/.test(first); break
    case 'style:keepLearned': ok = Array.isArray(first) && first.every((r) => object(r) && text(r.text) && text(r.evidence)) && text(second); break
    case 'library:preview': ok = path(first); break
    case 'cloud:save': ok = path(first) && path(second) && text(third) && third.length > 0; break
    case 'style:answer': ok = text(second) && typeof third === 'boolean'; break
    case 'ai:vendorStatus': case 'ai:vendorConnect': case 'ai:vendorCancel': case 'ai:vendorSignInAgain': case 'ai:vendorSignInWithCode': case 'ai:vendorSignIn': ok = first === 'claude' || first === 'chatgpt'; break
    case 'ai:setStockKey': ok = (first === 'pexels' || first === 'pixabay') && (second === null || text(second)); break
    // My style › Reference reels (references-ipc.ts) and Your niche (niche-ipc.ts)
    case 'refs:add': ok = paths(first) && first.length > 0; break
    case 'refs:addLink': ok = text(first) && first.length > 0 && first.length <= 4000; break
    case 'refs:attach': ok = referenceId(first) && path(second); break
    case 'refs:remove': case 'refs:openLink': case 'refs:reveal': ok = referenceId(first); break
    case 'niche:save': ok = object(first) && (second === 'chat' || second === 'typed'); break
    case 'niche:say': ok = Array.isArray(first) && first.length > 0 && first.length <= 24 && finite(second) && Number.isInteger(second) && second >= 0 &&
      (third === null || third === undefined || object(third)); break
    case 'dev:renderTestAnimation': ok = path(first) && (second === undefined || typeof second === 'boolean') &&
      (third === undefined || text(third)) && (args[3] === undefined || object(args[3])); break
  }
  if (!ok) throw bad
}
