// Reference reels (My style): reels by other creators the person wants theirs to feel like. Kept in
// <Reel Studio root>/References, read by the editor's read_references tool (ai/src/tools.ts). This file holds the
// shapes, which links the app downloads, and the readout the app writes from the engine's measurements
// (engine/reelengine/measure.py). No Node or DOM imports: main, the page and the tests share it.
import { CUT_PRESETS, PACE_BANDS, PACE_LABELS, type CutPreset } from './cut-style'

export const REFERENCES_FOLDER = 'References'
export const REFERENCES_FILE = 'references.json'
/** The readout's shape and wording; the editor's tool reads the stored one, so a change here bumps it. */
export const READOUT_VERSION = 1
/** A reel longer than this is not a reel; the engine would spend minutes listening to it. */
export const MAX_REFERENCE_SECONDS = 600
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'] as const

/** engine measure-reel's result (measure.py). */
export interface ReelMeasure {
  version: number
  duration: number
  width: number
  height: number
  hasAudio: boolean
  speech: {
    words: number
    wordsPerSecond: number
    firstWordAt: number
    talkingSeconds: number
    pausesPerMinute: number
    hook: { seconds: number; words: number; text: string } | null
  } | null
  /** why there is no speech: no sound, no listening model yet, or nothing said */
  speechMissing: 'no-audio' | 'no-model' | 'no-speech' | null
  shots: { count: number; medianSeconds: number; perMinute: number; cutsFirst5: number }
  poster?: string | null
}

export interface ReferenceEntry {
  id: string
  /** what the list calls it: the file's name, or the link's site and path */
  title: string
  addedAt: string
  /** the copy the app keeps, relative to References/ */
  file?: string
  /** the file name it was added as */
  original?: string
  link?: { url: string; platform: string }
  /** a link the app would not download: what to do instead (linkPolicy's words) */
  needsFile?: string
  measure?: ReelMeasure
  /** why it could not be measured, in the engine's words */
  problem?: string
}

export interface ReferencesFile {
  version: 1
  references: ReferenceEntry[]
  readout: Readout
}

/** One measurement across the measured reels: the middle value, the range and how many reels had it. */
export interface Stat {
  median: number
  low: number
  high: number
  n: number
}

export interface Readout {
  version: number
  measured: number
  /** words a second while talking */
  pace: Stat | null
  /** seconds per shot */
  shot: Stat | null
  /** seconds of the opening line */
  hook: Stat | null
  /** cuts in the first 5 seconds */
  earlyCuts: Stat | null
  /** seconds long */
  length: Stat | null
  /** the pace band the shot length falls in (shared/cut-style.ts), when one does */
  pacePreset: CutPreset | null
  /** plain sentences the app writes from the numbers above */
  lines: string[]
}

/** What the page shows for one reference. */
export interface ReferenceView extends ReferenceEntry {
  state: 'measuring' | 'measured' | 'needs-file' | 'problem'
  posterUrl?: string
}

// ---- which links the app downloads ----------------------------------------------------------------------------

export type LinkPolicy =
  | { kind: 'download'; url: string; title: string }
  | { kind: 'ask-file'; url: string; title: string; platform: string; why: string }
  | { kind: 'invalid'; why: string }

interface Platform {
  name: string
  hosts: string[]
  /** how to get the file the platform's own way */
  how: string
}

/**
 * Sites whose terms do not let another app download their videos, so the app keeps the link and asks for the file.
 * Each site's terms of service forbid downloading or automated collection except through the site's own download
 * feature (YouTube Terms of Service, "Permissions and Restrictions"; TikTok Terms of Service, "Your Access to and Use
 * of Our Services"; Instagram and Facebook Terms of Use, "What you can't do"; X Terms of Service, section 4; Vimeo
 * Terms of Service, "Restrictions"; Snapchat Terms of Service, section 11; Pinterest Terms of Service, "Using
 * Pinterest"; LinkedIn User Agreement, "Don'ts"). Their video CDN hosts are listed too, so a link copied from the
 * page's source is treated the same as the page.
 */
const PLATFORMS: Platform[] = [
  { name: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com'], how: 'If it is your video, download it from YouTube Studio, then add the file here.' },
  { name: 'TikTok', hosts: ['tiktok.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'tiktokv.com'], how: 'If the creator allows it, use Save video in TikTok’s Share menu, then add the file here.' },
  { name: 'Instagram', hosts: ['instagram.com', 'cdninstagram.com', 'instagr.am'], how: 'If Instagram offers Download for this reel, use it, then add the file here.' },
  { name: 'Facebook', hosts: ['facebook.com', 'fb.watch', 'fbcdn.net', 'fb.com'], how: 'If it is your video, download it from Facebook, then add the file here.' },
  { name: 'Threads', hosts: ['threads.net', 'threads.com'], how: 'If it is your video, save it from Threads, then add the file here.' },
  { name: 'X', hosts: ['x.com', 'twitter.com', 'twimg.com', 't.co'], how: 'If it is your video, save your own copy, then add the file here.' },
  { name: 'Vimeo', hosts: ['vimeo.com', 'vimeocdn.com'], how: 'If the owner turned on downloads, use Download on Vimeo, then add the file here.' },
  { name: 'Snapchat', hosts: ['snapchat.com'], how: 'If it is your Snap, save it in Snapchat, then add the file here.' },
  { name: 'Pinterest', hosts: ['pinterest.com', 'pin.it', 'pinimg.com'], how: 'Save the video yourself if the owner allows it, then add the file here.' },
  { name: 'LinkedIn', hosts: ['linkedin.com', 'licdn.com'], how: 'If it is your video, save your own copy, then add the file here.' }
]

/** A path with a broken %-escape stays as typed instead of throwing. */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

const onHost = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

/**
 * What the app does with a pasted link. A known video site: keep the link and ask for the file, saying why. A link
 * straight to a video file on any other site: download it, since the site is serving the file itself. Any other
 * page: ask for the file, because the app cannot tell what that site's terms allow.
 */
export function linkPolicy(raw: string): LinkPolicy {
  const text = String(raw ?? '').trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { kind: 'invalid', why: 'That is not a link. Copy the whole address, starting with https://, and paste it again.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'invalid', why: 'Only web links (https://…) can be added.' }
  if (url.username || url.password) return { kind: 'invalid', why: 'That link has a sign-in in it. Paste the plain link to the video.' }
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  const href = url.toString()
  const file = decoded(url.pathname.split('/').pop() ?? '')
  const platform = PLATFORMS.find((p) => p.hosts.some((d) => onHost(host, d)))
  const title = platform ? [platform.name, shortPath(url)].filter(Boolean).join(' · ') : file || host
  if (platform) {
    return { kind: 'ask-file', url: href, title, platform: platform.name, why: `${platform.name}’s terms don’t let other apps download its videos, so Reel Studio keeps the link instead. ${platform.how}` }
  }
  const ext = file.includes('.') ? file.split('.').pop()!.toLowerCase() : ''
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(ext)) return { kind: 'download', url: href, title: file }
  return { kind: 'ask-file', url: href, title, platform: host, why: 'Reel Studio only downloads links that go straight to a video file, because it can’t tell what other sites allow. Save the video yourself, then add the file here.' }
}

/** The link's path, cut to 40 characters: enough to tell two links to one site apart in the list. */
function shortPath(url: URL): string {
  const path = decoded(url.pathname).replace(/^\/+|\/+$/g, '')
  return path.length > 40 ? `${path.slice(0, 39)}…` : path
}

// ---- the readout ------------------------------------------------------------------------------------------------

const round1 = (x: number): number => Math.round(x * 10) / 10

function stat(values: number[]): Stat | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const mid = v.length >> 1
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
  return { median: round1(median), low: round1(v[0]), high: round1(v[v.length - 1]), n: v.length }
}

/** The pace band whose seconds-per-change range holds `seconds`, else the nearest one by range edge. */
export function paceFor(seconds: number): CutPreset {
  let best: CutPreset = 'standard'
  let gap = Infinity
  for (const preset of CUT_PRESETS) {
    const band = PACE_BANDS[preset].secondsPerVisualChange
    if (!band) continue
    const d = seconds < band[0] ? band[0] - seconds : seconds > band[1] ? seconds - band[1] : 0
    if (d < gap) [best, gap] = [preset, d]
  }
  return best
}

const secs = (x: number): string => `${x} second${x === 1 ? '' : 's'}`
const range = (s: Stat, unit: (x: number) => string): string => (s.n > 1 && s.low !== s.high ? ` (${s.low} to ${unit(s.high)} across ${s.n} reels)` : '')

/**
 * How fast people talk on camera. Conversational English runs about 150 words a minute (2.5 a second), the usual
 * figure for speech rate; these two edges sit either side of it. Not measured on reels.
 */
const PACE_WORDS: [number, string][] = [[2.2, 'an unhurried pace'], [3.0, 'an everyday talking pace'], [Infinity, 'fast, faster than everyday talk']]

/** The readout of the measured references: numbers first, then sentences built only from them. */
export function readout(entries: ReferenceEntry[]): Readout {
  const measured = entries.map((e) => e.measure).filter((m): m is ReelMeasure => !!m)
  const pace = stat(measured.flatMap((m) => (m.speech ? [m.speech.wordsPerSecond] : [])))
  const shot = stat(measured.map((m) => m.shots.medianSeconds))
  const hook = stat(measured.flatMap((m) => (m.speech?.hook ? [m.speech.hook.seconds] : [])))
  const hookWords = stat(measured.flatMap((m) => (m.speech?.hook ? [m.speech.hook.words] : [])))
  const earlyCuts = stat(measured.map((m) => m.shots.cutsFirst5))
  const length = stat(measured.map((m) => m.duration))
  const oneShot = measured.length > 0 && measured.every((m) => m.shots.count <= 1)
  const pacePreset = shot && !oneShot ? paceFor(shot.median) : null
  const lines: string[] = []
  if (pace) lines.push(`They talk at about ${pace.median} words a second${range(pace, (x) => String(x))}, ${PACE_WORDS.find(([edge]) => pace.median < edge)![1]}.`)
  if (oneShot) lines.push('They hold one shot the whole way through, with no cuts.')
  else if (shot && pacePreset) {
    const band = PACE_BANDS[pacePreset].secondsPerVisualChange!
    lines.push(`The picture changes about every ${secs(shot.median)}${range(shot, secs)}, close to the ${PACE_LABELS[pacePreset]} pace (${band[0]} to ${band[1]} seconds).`)
  }
  if (hook && hookWords) lines.push(`The first sentence is over in about ${secs(hook.median)}, around ${Math.round(hookWords.median)} words.`)
  const early = earlyCuts ? Math.round(earlyCuts.median) : 0
  if (earlyCuts && !oneShot) lines.push(early >= 1 ? `They cut about ${early} time${early === 1 ? '' : 's'} in the first 5 seconds.` : 'They usually hold the first shot for the whole first 5 seconds.')
  if (length) lines.push(length.n > 1 && length.low !== length.high ? `They run ${Math.round(length.low)} to ${secs(Math.round(length.high))}.` : `It runs ${secs(Math.round(length.median))}.`)
  return { version: READOUT_VERSION, measured: measured.length, pace, shot, hook, earlyCuts, length, pacePreset, lines }
}

/** What the measurement can and can't see, said once beside the numbers. */
export const READOUT_LIMITS =
  'Measured by listening to the words and spotting where the picture changes. Zoom-ins, captions, music and anything written on screen are not measured.'

// ---- reading references.json ------------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The engine's measurement, checked where it comes in: another shape is a bug on one of the two sides. */
export function checkMeasure(v: unknown): ReelMeasure {
  const bad = (what: string): never => {
    throw new Error(`measure-reel returned ${what}`)
  }
  if (!isObj(v) || !num(v.duration) || !isObj(v.shots)) bad('no duration or shots')
  const m = v as Record<string, any>
  if (![m.shots.count, m.shots.medianSeconds, m.shots.perMinute, m.shots.cutsFirst5].every(num)) bad('bad shot numbers')
  if (m.speech !== null && !(isObj(m.speech) && [m.speech.words, m.speech.wordsPerSecond, m.speech.firstWordAt, m.speech.talkingSeconds, m.speech.pausesPerMinute].every(num))) bad('bad speech numbers')
  if (m.speech?.hook != null && !(isObj(m.speech.hook) && num(m.speech.hook.seconds) && num(m.speech.hook.words) && typeof m.speech.hook.text === 'string')) bad('a bad opening line')
  if (![null, 'no-audio', 'no-model', 'no-speech'].includes(m.speechMissing)) bad('an unknown speechMissing')
  return {
    version: num(m.version) ? m.version : 0, duration: m.duration, width: num(m.width) ? m.width : 0, height: num(m.height) ? m.height : 0,
    hasAudio: m.hasAudio === true, speech: m.speech ?? null, speechMissing: m.speechMissing, shots: m.shots,
    ...(typeof m.poster === 'string' ? { poster: m.poster } : {})
  }
}

/** One stored entry, or null when it is not one (a hand edit, an older app): the list skips it instead of failing. */
export function readEntry(v: unknown): ReferenceEntry | null {
  if (!isObj(v) || typeof v.id !== 'string' || !/^[0-9a-f-]{8,64}$/.test(v.id) || typeof v.title !== 'string' || typeof v.addedAt !== 'string') return null
  const e: ReferenceEntry = { id: v.id, title: v.title, addedAt: v.addedAt }
  if (typeof v.file === 'string' && /^files\/[^/\\]+$/.test(v.file)) e.file = v.file
  if (typeof v.original === 'string') e.original = v.original
  if (isObj(v.link) && typeof v.link.url === 'string' && typeof v.link.platform === 'string') e.link = { url: v.link.url, platform: v.link.platform }
  if (typeof v.needsFile === 'string') e.needsFile = v.needsFile
  if (typeof v.problem === 'string') e.problem = v.problem
  if (v.measure !== undefined) {
    try {
      e.measure = checkMeasure(v.measure)
    } catch {
      // measured again on the next look
    }
  }
  if (!e.file && !e.link) return null
  return e
}

export function stateOf(e: ReferenceEntry): ReferenceView['state'] {
  if (e.measure) return 'measured'
  if (e.problem) return 'problem'
  if (!e.file) return 'needs-file'
  return 'measuring'
}
