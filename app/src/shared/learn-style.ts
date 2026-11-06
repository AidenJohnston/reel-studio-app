// "Learn from my past edits" (My style): reads habits out of the timelines the engine's import-reference
// returns for Final Cut Pro, Premiere Pro and DaVinci Resolve exports and CapCut projects
// (engine/reelengine/reference_import.py). Each rule says what it was read from, and a habit is only stated when
// the timelines show it. Keep free of Node and DOM imports.
import type { EditorName, LearnedRule } from './api'

type Time = { value: number; rate: number } | null
type Range = { start: Time; duration: Time } | null
export interface RefItem {
  type: 'clip' | 'stack' | 'transition'
  name?: string | null
  trackRange?: Range
  media?: { kind: 'file' | 'generator' | 'missing'; url?: string | null; name?: string | null; generator?: string | null }
}
export interface RefTrack {
  name: string
  kind: string
  items: RefItem[]
}
export interface RefTimeline {
  name: string
  tracks: RefTrack[]
}
/** The engine's readers: OpenTimelineIO's FCPXML and FCP7 XML adapters, CapCut's draft, a CMX 3600 EDL. */
export const ADAPTERS = ['fcpx_xml', 'fcp_xml', 'capcut', 'cmx_3600'] as const
/** The parts of an import record this reads. `writer` names the app when the format alone doesn't: DaVinci Resolve
 * for its FCPXML, CapCut or JianYing (CapCut's Chinese edition) for a draft. */
export interface ImportRecord {
  source: { adapter: (typeof ADAPTERS)[number]; writer?: string | null }
  timelines: RefTimeline[]
}

const secs = (t: Time): number => (t && t.rate > 0 ? t.value / t.rate : 0)
const AUDIO_FILE = /\.(mp3|m4a|wav|aiff?|aac|flac|ogg|caf)$/i
const TEXT = /text|title/i
// shots this short or long are habits worth stating; between them, pacing is unremarkable
const QUICK = 4
const SLOW = 7

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const one = (n: number): string => (Math.round(n * 10) / 10).toString()
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The primary storyline: Final Cut's lane 0, otherwise the first video track. */
function mainTrack(tl: RefTimeline): RefTrack | undefined {
  const video = tl.tracks.filter((t) => t.kind === 'Video')
  return video.find((t) => t.name === '0') ?? video[0]
}

interface Read {
  length: number
  shots: number[]
  cuts: number
  transitions: number
  overlays: number
  opensWithText: boolean
  music: boolean
}

function read(tl: RefTimeline): Read {
  const main = mainTrack(tl)
  const placed = tl.tracks.flatMap((t) => t.items.filter((i) => i.type !== 'transition'))
  // times from the timeline's first clip: DaVinci Resolve starts a timeline at 01:00:00:00 and its FCPXML says so
  const origin = placed.length ? Math.min(...placed.map((i) => secs(i.trackRange?.start ?? null))) : 0
  const length = Math.max(0, ...placed.map((i) => secs(i.trackRange?.start ?? null) + secs(i.trackRange?.duration ?? null) - origin))
  const mainItems = main?.items ?? []
  const shots = mainItems.filter((i) => i.type !== 'transition' && i.media?.kind !== 'generator').map((i) => secs(i.trackRange?.duration ?? null)).filter((d) => d > 0)
  const others = tl.tracks.filter((t) => t !== main && t.kind === 'Video').flatMap((t) => t.items)
  return {
    length,
    shots,
    cuts: Math.max(0, shots.length - 1),
    transitions: mainItems.filter((i) => i.type === 'transition').length,
    overlays: others.filter((i) => i.type === 'stack' || i.media?.kind === 'file').length,
    opensWithText: tl.tracks.some((t) => t.items.some((i) => i.media?.kind === 'generator' && TEXT.test(`${i.media.generator ?? ''} ${i.name ?? ''}`) && secs(i.trackRange?.start ?? null) - origin < 3)),
    // an EDL names the clip, not its file
    music: tl.tracks.some((t) => t.kind === 'Audio' && t.items.some((i) => i.media?.kind === 'file' && AUDIO_FILE.test(i.media.url ?? i.media.name ?? i.name ?? '')))
  }
}

export interface Lesson {
  timelines: number
  shots: number
  rules: LearnedRule[]
}

/** The rules a set of exported timelines show, in the order a person would check them. */
export function learnStyle(records: ImportRecord[]): Lesson {
  const reads = records.flatMap((r) => r.timelines).map(read).filter((r) => r.length > 0)
  const n = reads.length
  const shots = reads.flatMap((r) => r.shots)
  const rules: LearnedRule[] = []
  const across = plural(n, 'timeline')
  if (!n) return { timelines: 0, shots: 0, rules }

  const lengths = reads.map((r) => r.length)
  const typical = Math.max(5, Math.round(median(lengths) / 5) * 5)
  const lo = Math.round(Math.min(...lengths))
  const hi = Math.round(Math.max(...lengths))
  rules.push({
    text: `Keep reels around ${typical} seconds.`,
    evidence: n === 1 ? `Your timeline runs ${lo} seconds.` : `Your ${n} timelines run ${lo} to ${hi} seconds.`
  })

  if (shots.length >= 4) {
    const m = median(shots)
    const evidence = `${plural(shots.length, 'shot')} across ${across}, ${one(m)} seconds each on average.`
    if (m <= QUICK) rules.push({ text: `Cut to a new shot every ${one(m)} seconds or so.`, evidence })
    else if (m >= SLOW) rules.push({ text: `Let shots run long, about ${Math.round(m)} seconds each.`, evidence })
  }

  const cuts = reads.reduce((a, r) => a + r.cuts, 0)
  const transitions = reads.reduce((a, r) => a + r.transitions, 0)
  if (cuts >= 4 && transitions / cuts < 0.1) {
    rules.push({ text: 'Use straight cuts between shots, no transitions.', evidence: `${plural(transitions, 'transition')} in ${plural(cuts, 'cut')}.` })
  } else if (cuts >= 4 && transitions / cuts >= 0.5) {
    rules.push({ text: 'Use a quick dissolve between shots.', evidence: `${plural(transitions, 'transition')} in ${plural(cuts, 'cut')}.` })
  }

  const minutes = lengths.reduce((a, b) => a + b, 0) / 60
  const overlays = reads.reduce((a, r) => a + r.overlays, 0)
  if (overlays >= 2 && overlays / minutes >= 2) {
    rules.push({
      text: `Show an extra clip or picture about ${Math.round(overlays / minutes)} times a minute.`,
      evidence: `${plural(overlays, 'clip')} above the main shots across ${across}.`
    })
  }

  const titled = reads.filter((r) => r.opensWithText).length
  if (titled * 2 >= n && titled) {
    rules.push({ text: 'Open with a title on screen in the first few seconds.', evidence: n === 1 ? 'Your timeline starts with a title.' : `${titled} of your ${n} timelines start with a title.` })
  }

  const scored = reads.filter((r) => r.music).length
  if (scored * 2 >= n && scored) {
    rules.push({ text: 'Put music under the talking.', evidence: n === 1 ? 'Your timeline has a song under it.' : `${scored} of your ${n} timelines have a song under them.` })
  }

  return { timelines: n, shots: shots.length, rules }
}

/** Which editor made it, as the lesson names it. FCP7 XML is taken as Premiere Pro's, though Resolve writes it too. */
export function editorOf(r: ImportRecord): EditorName {
  if (r.source.writer === 'DaVinci Resolve') return 'DaVinci Resolve'
  switch (r.source.adapter) {
    case 'fcpx_xml':
      return 'Final Cut Pro'
    case 'capcut':
      return 'CapCut'
    case 'cmx_3600':
      return 'EDL'
    default:
      return 'Premiere Pro'
  }
}
