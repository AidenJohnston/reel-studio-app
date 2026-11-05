// The reel's pace (project.json cutStyle) and each zoom-in's kind, as "Edit it myself" shows and changes them.
// The values mirror ai/src/cut-style.ts and engine/reelengine/cut_style.py; app/test/cut-style.test.ts fails when
// they drift, and checks these problems against the AI's own validateProject. No Node or DOM imports.

/** The engine's preset names, in the order the drawer lists them. */
export const CUT_PRESETS = ['clean', 'standard', 'hyper', 'punchline'] as const
export type CutPreset = (typeof CUT_PRESETS)[number]
export interface CutStyle { preset: CutPreset; seed: number }

/** Seconds between changes of picture (null: the punchline style keeps one framing), and whether accents land on the
 * music's beats: the two numbers of ai/src/cut-style.ts the drawer puts into words. */
export const PACE_BANDS: Record<CutPreset, { secondsPerVisualChange: readonly [number, number] | null; beatAccents: boolean }> = {
  clean: { secondsPerVisualChange: [6, 10], beatAccents: false },
  standard: { secondsPerVisualChange: [3, 5], beatAccents: false },
  hyper: { secondsPerVisualChange: [1.5, 3], beatAccents: true },
  punchline: { secondsPerVisualChange: null, beatAccents: false }
}

// "Clean" already names a subtitle look and the player's plain view, so the paces have names of their own.
export const PACE_LABELS: Record<CutPreset, string> = { clean: 'Calm', standard: 'Steady', hyper: 'Fast', punchline: 'Punchline' }

export const ZOOM_KINDS = ['punch', 'snap', 'drift'] as const
export type ZoomKind = (typeof ZOOM_KINDS)[number]
export const ZOOM_KIND_LABELS: Record<ZoomKind, string> = { punch: 'Instant', snap: 'Quick', drift: 'Slow' }

export interface Zoom {
  anchor: { from: string; to: string }
  scale?: number
  kind?: ZoomKind
  /** legacy alias of kind snap (engine/reelengine/zoom.py) */
  style?: 'snap'
  accentGroup?: string
  [k: string]: unknown
}

/** The engine's scale for a zoom with neither a kind nor a scale (zoom.py DEFAULT_SCALE). A named kind defaults to
 * the style's scale instead, so giving such a zoom a kind keeps the scale it had. */
const UNNAMED_SCALE = 1.12

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k)

/** Why `v` is not a cutStyle, in ai/src/project.ts validateProject's words; null when it is one. */
export function cutStyleProblem(v: unknown): string | null {
  if (!v || typeof v !== 'object' || !has(v, 'preset') || !has(v, 'seed')) return 'cutStyle needs preset and seed'
  const s = v as Record<string, unknown>
  if (typeof s.preset !== 'string' || !(CUT_PRESETS as readonly string[]).includes(s.preset)) return 'cutStyle.preset must be clean, standard, hyper, or punchline'
  if (!Number.isInteger(s.seed)) return 'cutStyle.seed must be an integer'
  return null
}

/** Why `z` is not a zoom-in change "Edit it myself" can send: the drawer only changes how a zoom-in moves, so the
 * item names its words and a kind the AI's set_zoom takes (hand-edit.ts applies nothing else from it). */
export function zoomKindProblem(z: unknown): string | null {
  if (!z || typeof z !== 'object' || Array.isArray(z)) return 'a zoom-in can only change its kind'
  const { anchor, kind } = z as Record<string, unknown>
  const a = anchor as Record<string, unknown> | null
  if (!a || typeof a !== 'object' || typeof a.from !== 'string' || typeof a.to !== 'string') return 'a zoom-in needs its words'
  if (!(ZOOM_KINDS as readonly unknown[]).includes(kind)) return 'zoom kind must be punch, snap or drift'
  return null
}

/** The kind the engine plays for `z` (zoom.py build_zooms): its kind, else snap for the legacy style, else punch. */
export const kindOf = (z: Zoom): ZoomKind => z.kind ?? (z.style === 'snap' ? 'snap' : 'punch')

/** `z` played as `kind`. The legacy style goes, since kind decides; a zoom that had no kind keeps its scale. */
export function withKind(z: Zoom, kind: ZoomKind): Zoom {
  const { style: _alias, ...rest } = z
  return { ...rest, ...(z.kind === undefined && z.scale === undefined ? { scale: UNNAMED_SCALE } : {}), kind }
}

/** A zoom's key in a hand edit: its words. The engine plays one zoom per stretch of words (zooms never overlap). */
export const zoomKey = (z: unknown): string => {
  const a = (z as Zoom | null)?.anchor
  return `${a?.from}>${a?.to}`
}

/** A new seed in the engine's range (variation.py seed trials), never `old`: "Try other moments". */
export function nextSeed(old: number | undefined, random: () => number = Math.random): number {
  for (;;) {
    const seed = Math.floor(random() * 2 ** 31)
    if (seed !== old) return seed
  }
}

/** What a pace does to the picture, for its row: the style's framing cadence (engine/reelengine/variation.py resolve
 * alternates a wide and a close framing at that rhythm; with no rhythm it keeps one). */
export function paceLine(preset: CutPreset): string {
  const { secondsPerVisualChange: band, beatAccents } = PACE_BANDS[preset]
  if (!band) return 'Holds one framing, so only the zoom-ins move.'
  const line = `Switches between a wide and a close framing every ${band[0]} to ${band[1]} seconds`
  return beatAccents ? `${line}. With a song, sound effects and pictures land on its beat.` : `${line}.`
}
