// Caption looks offered as starting points in "Edit it myself". Picking one writes exactly its style fields
// (engine/reelengine/captions.py draws them); Size, Position and Colour, or a note to the AI editor, fine-tune
// from there. All of them use the one subtitle face the engine ships and the preview loads.
import type { Word } from './api'
import { BOX_PAD, SAFE_WIDTH, fitCaption, type Measure } from './caption-fit'

type CaptionStyle = Record<string, unknown>

const BASE = { font: 'Montserrat SemiBold', outlineColor: '#000000', shadow: 0, position: 0.75 }

export const CAPTION_PRESETS: { key: string; label: string; style: CaptionStyle }[] = [
  // engine/reelengine/project.py DEFAULT_CAPTION_STYLE
  { key: 'clean', label: 'Clean', style: { ...BASE, size: 105, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8 } },
  { key: 'bold-pop', label: 'Bold pop', style: { ...BASE, size: 126, maxWords: 2, case: 'upper', color: '#FFFFFF', outline: 12, pop: true } },
  { key: 'karaoke', label: 'Karaoke', style: { ...BASE, size: 105, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8, highlight: '#FFD60A' } },
  { key: 'boxed', label: 'Boxed', style: { ...BASE, size: 96, maxWords: 3, case: 'upper', color: '#FFFFFF', outline: 8, box: true } },
  { key: 'minimal', label: 'Minimal', style: { ...BASE, size: 84, maxWords: 4, case: 'lower', color: '#FFFFFF', outline: 5 } }
]

/**
 * The style after picking look `key` over `current`. Position always carries over; so does a Size the person
 * set themselves, one that differs from the size of the look the reel was drawn as.
 */
export function applyPreset(key: string, current: CaptionStyle = {}): CaptionStyle {
  const preset = CAPTION_PRESETS.find((p) => p.key === key)
  if (!preset) throw new Error(`no caption preset "${key}"`)
  const style: CaptionStyle = { ...preset.style, preset: key }
  if (current.position != null) style.position = current.position
  const lookSize = CAPTION_PRESETS.find((p) => p.key === presetOf(current))?.style.size ?? DRAWN_AS.size
  if (current.size != null && current.size !== lookSize) style.size = current.size
  return style
}

// What a style left out, the engine draws as (captions.render_ass, project.DEFAULT_CAPTION_STYLE).
const DRAWN_AS: CaptionStyle = { ...CAPTION_PRESETS[0].style, box: false, pop: false, highlight: null }
const LOOK_KEYS = Object.keys(DRAWN_AS).filter((k) => k !== 'size' && k !== 'position')
const drawn = (st: CaptionStyle, k: string): unknown => {
  const v = st[k] ?? DRAWN_AS[k]
  return typeof v === 'string' ? v.toUpperCase() : v
}

/**
 * The look a reel's subtitles started from: the name the picker saved, or else (a reel made before
 * presets, or styled by the AI editor) the preset it is drawn like, Size and Position aside. Null when
 * it matches none.
 */
export function presetOf(st: CaptionStyle): string | null {
  if (CAPTION_PRESETS.some((p) => p.key === st.preset)) return st.preset as string
  const like = CAPTION_PRESETS.find((p) => LOOK_KEYS.every((k) => drawn(st, k) === drawn(p.style, k)))
  return like?.key ?? null
}

/** The subtitle look, in the engine's own units (1080 x 1920 frame). */
export interface SubtitleLook {
  size: number
  position: number
  color: string
  outlineColor: string
  outline: number
  box: boolean
  case: string
  highlight: string | null
  pop: boolean
}

export function lookFromStyle(st: CaptionStyle | undefined): SubtitleLook {
  const s = st ?? {}
  return {
    size: Number(s.size ?? 105),
    position: Number(s.position ?? 0.75),
    color: String(s.color ?? '#FFFFFF'),
    outlineColor: String(s.outlineColor ?? '#000000'),
    outline: Number(s.outline ?? 8),
    box: !!s.box,
    case: String(s.case ?? 'upper'),
    highlight: typeof s.highlight === 'string' ? s.highlight : null,
    pop: !!s.pop
  }
}

/** captions.apply_case */
function applyCase(text: string, c: string): string {
  if (c === 'upper') return text.toUpperCase()
  if (c === 'lower') return text.toLowerCase()
  if (c === 'title') return text.split(' ').map((t) => t.slice(0, 1).toUpperCase() + t.slice(1)).join(' ')
  return text
}

/** The size and lines the engine gives `text` in this look (captions.render_ass at 1080 wide). */
export function fitLook(look: SubtitleLook, text: string, measure: Measure): { size: number; lines: string[] } {
  const outline = look.box ? Math.max(look.outline, BOX_PAD) : look.outline
  return fitCaption(applyCase(text, look.case), look.size, SAFE_WIDTH, outline, measure)
}

/**
 * A sample line for the subtitle preview: kept words as the engine groups them (captions.chunk), up to
 * `maxWords` and never past a sentence end, shown at the moment its first word is spoken. A word that is only
 * punctuation stays in the line, as it does in the export.
 */
export function sampleLine(words: Word[], kept: Set<string>, maxWords: number): { text: string; at: number; words: number } {
  const k = words.filter((w) => kept.has(w.id))
  const spoken = k.filter((w) => /\w/.test(w.w))
  const first = spoken[spoken.length > 6 ? 2 : 0]
  const pick: Word[] = []
  for (const w of first ? k.slice(k.indexOf(first)) : []) {
    pick.push(w)
    if (pick.length >= maxWords || /[.!?…]["')\]]*$/.test(w.w.trim())) break
  }
  if (!pick.length) return { text: 'Your words here', at: 0.5, words: 3 }
  const text = pick.map((w) => w.w.trim()).join(' ').replace(/^[(\[{"¿¡]+/, '').replace(/[.,!?;:)\]}"…]+$/, '')
  return { text, at: pick[0].s + 0.15, words: pick.length }
}

/** The look the preview draws for a sample line: like captions.word_spans, no highlight unless each token is one spoken word. */
export function sampleLook(style: CaptionStyle, sample: { text: string; words: number }): SubtitleLook {
  const look = lookFromStyle(style)
  const tokens = sample.text.split(' ')
  if (tokens.length !== sample.words || !tokens.every((t) => /\w/.test(t))) look.highlight = null
  return look
}
