// A change made in "Edit it myself", kept as what changed rather than as a copy of the project, so it can wait
// behind a running note and then land on whatever version is newest when its turn comes: the note's own
// changes stay, and only what the person touched is changed on top. No Node or DOM imports.
import type { ProjectJson, Word } from './api'
import { keptIds, rangesKeepingOrder } from './cut'
import { cutStyleProblem, zoomKey, zoomProblem } from './cut-style'

/** A list whose items are told apart by a key, so an item is added, replaced or removed on its own. */
export type ListName = 'broll' | 'sfx' | 'zooms' | 'captions.corrections' | 'captions.split' | 'captions.join'

export interface HandEdit {
  /** Values set inside `captions`, `music` or `cover`, or the whole `cutStyle`; `unset` removes the key. */
  set: { path: string[]; value?: unknown; unset?: true }[]
  /** List items put (`item`) or removed (`item: null`) by key. */
  items: { list: ListName; key: string; item: unknown }[]
  /** Transcript words cut, and words brought back. */
  words: { cut: string[]; keep: string[] }
  /** Takes flipped (`on`) or shown as filmed. */
  mirror: { source: string; on: boolean }[]
}

const SET_ROOTS = ['captions', 'music', 'cover']
// Set or removed whole: a pace is its preset and seed together, and a seed kept from one pace onto another the
// person never picked would be a choice nobody made.
const WHOLE = ['cutStyle']
const LISTS: Record<ListName, (x: any) => string> = {
  broll: (b) => String(b?.id),
  // the engine plays one effect per moment, so the moment names the effect
  sfx: (s) => JSON.stringify(s?.at),
  zooms: zoomKey,
  'captions.corrections': (c) => (c?.at ? `at:${c.at}` : `from:${c?.from}`),
  'captions.split': (id) => String(id),
  'captions.join': (j) => `${j?.from}>${j?.to}`
}
const LIST_NAMES = Object.keys(LISTS) as ListName[]

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function walk(a: unknown, b: unknown, path: string[], out: HandEdit): void {
  const list = LIST_NAMES.find((l) => l === path.join('.'))
  if (list) {
    const key = LISTS[list]
    const before = new Map((Array.isArray(a) ? a : []).map((x) => [key(x), x]))
    const after = new Map((Array.isArray(b) ? b : []).map((x) => [key(x), x]))
    for (const [k, x] of after) if (!same(before.get(k), x)) out.items.push({ list, key: k, item: x })
    for (const k of before.keys()) if (!after.has(k)) out.items.push({ list, key: k, item: null })
    return
  }
  if (isObject(a) && isObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], [...path, k], out)
    return
  }
  if (same(a, b)) return
  if (b === undefined) out.set.push({ path, unset: true })
  else if (isObject(b) && (a === undefined || a === null)) {
    // a part the project did not have yet: each of its values is set on its own, so a part a later note
    // added there keeps the values this edit did not touch
    for (const k of Object.keys(b)) walk(undefined, b[k], [...path, k], out)
  } else out.set.push({ path, value: b })
}

/** What changed from `base` to `edited`, with the words kept before and after. */
export function diffProject(base: ProjectJson, edited: ProjectJson, keptBefore: Set<string>, keptAfter: Set<string>): HandEdit {
  const out: HandEdit = { set: [], items: [], words: { cut: [], keep: [] }, mirror: [] }
  for (const root of SET_ROOTS) walk(base[root], edited[root], [root], out)
  for (const root of WHOLE) {
    if (same(base[root], edited[root])) continue
    out.set.push(edited[root] === undefined ? { path: [root], unset: true } : { path: [root], value: edited[root] })
  }
  for (const list of ['broll', 'sfx', 'zooms']) walk(base[list], edited[list], [list], out)
  for (const id of keptBefore) if (!keptAfter.has(id)) out.words.cut.push(id)
  for (const id of keptAfter) if (!keptBefore.has(id)) out.words.keep.push(id)
  const was = new Map((base.sources ?? []).map((s) => [s.id, s.mirror === true]))
  for (const s of edited.sources ?? []) if (was.has(s.id) && was.get(s.id) !== (s.mirror === true)) out.mirror.push({ source: s.id, on: s.mirror === true })
  return out
}

export const isEmpty = (e: HandEdit): boolean => !e.set.length && !e.items.length && !e.words.cut.length && !e.words.keep.length && !e.mirror.length

/** The project with the edit on top. A value the edit set wins over what the project has there; everything
 * else is the project's own. Applying the same edit twice gives the same project. */
export function applyHandEdit(project: ProjectJson, e: HandEdit, words: Word[]): ProjectJson {
  const p = structuredClone(project) as ProjectJson & Record<string, any>
  for (const s of e.set) {
    let o: Record<string, any> = p
    for (const k of s.path.slice(0, -1)) o = isObject(o[k]) ? o[k] : (o[k] = {})
    const last = s.path[s.path.length - 1]
    if (s.unset) delete o[last]
    else o[last] = structuredClone(s.value)
  }
  for (const it of e.items) {
    const path = it.list.split('.')
    const key = LISTS[it.list]
    const parent = path.length === 1 ? p : (p[path[0]] ??= {})
    const name = path[path.length - 1]
    const list: unknown[] = Array.isArray(parent[name]) ? parent[name] : []
    const at = list.findIndex((x) => key(x) === it.key)
    if (it.item === null) {
      if (at >= 0) list.splice(at, 1)
    } else if (at >= 0) list[at] = structuredClone(it.item)
    else list.push(structuredClone(it.item))
    if (list.length) parent[name] = list
    else delete parent[name]
  }
  if (e.words.cut.length || e.words.keep.length) {
    const kept = new Set(keptIds(words, p.cut?.keep))
    for (const id of e.words.cut) kept.delete(id)
    const known = new Set(words.map((w) => w.id))
    for (const id of e.words.keep) if (known.has(id)) kept.add(id)
    p.cut = { ...(p.cut ?? { keep: [] }), keep: rangesKeepingOrder(words, p.cut?.keep, kept) }
  }
  if (e.mirror.length) {
    const want = new Map(e.mirror.map((m) => [m.source, m.on]))
    p.sources = (p.sources ?? []).map((s) => {
      if (!want.has(s.id)) return s
      const { mirror: _old, ...rest } = s
      return want.get(s.id) ? { ...rest, mirror: true } : rest
    })
  }
  return p
}

/** The edit as the page sent it, or why not. Main never applies anything else: only the parts of the
 * project "Edit it myself" changes, as plain JSON. */
export function parseHandEdit(v: unknown): HandEdit {
  const bad = (why: string): never => {
    throw { code: 'BAD_EDIT', message: why, userMessage: 'That change could not be read. Open Edit it myself and make it again.' }
  }
  if (!isObject(v)) return bad('not an object')
  const strings = (x: unknown): string[] => (Array.isArray(x) && x.every((s) => typeof s === 'string') ? (x as string[]) : bad('word ids'))
  const json = (x: unknown): unknown => JSON.parse(JSON.stringify(x ?? null))
  const set = Array.isArray(v.set) ? v.set : bad('set')
  const items = Array.isArray(v.items) ? v.items : bad('items')
  const mirror = Array.isArray(v.mirror) ? v.mirror : bad('mirror')
  const words = isObject(v.words) ? v.words : bad('words')
  return {
    set: set.map((s) => {
      if (!isObject(s)) return bad('set entry')
      const path = strings(s.path)
      if (path.length === 1 && WHOLE.includes(path[0])) {
        if (s.unset === true) return { path, unset: true as const }
        const value = json(s.value)
        const problem = cutStyleProblem(value)
        return problem ? bad(problem) : { path, value }
      }
      if (path.length < 2 || !SET_ROOTS.includes(path[0]) || path.some((k) => !k || k === '__proto__' || k === 'constructor' || k === 'prototype')) bad(`path ${path.join('.')}`)
      if (LIST_NAMES.some((l) => `${path.join('.')}.`.startsWith(`${l}.`))) bad(`list path ${path.join('.')}`)
      return s.unset === true ? { path, unset: true as const } : { path, value: json(s.value) }
    }),
    items: items.map((it) => {
      if (!isObject(it) || !LIST_NAMES.includes(it.list as ListName) || typeof it.key !== 'string') return bad('item')
      const item = json(it.item)
      if (item !== null && LISTS[it.list as ListName](item) !== it.key) bad(`item key ${it.key}`)
      // the AI's set_zoom takes only these kinds; the engine would refuse the version after the queue's wait
      const problem = item !== null && it.list === 'zooms' ? zoomProblem(item) : null
      if (problem) bad(problem)
      return { list: it.list as ListName, key: it.key, item }
    }),
    words: { cut: strings(words.cut), keep: strings(words.keep) },
    mirror: mirror.map((m) => (isObject(m) && typeof m.source === 'string' && typeof m.on === 'boolean' ? { source: m.source, on: m.on } : bad('mirror entry')))
  }
}

/** Runs of neighbouring words, in transcript order: cutting "my cat Biscuit" is one change. */
function runs(ids: Set<string>, words: Word[]): number {
  let n = 0
  let inRun = false
  for (const w of words) {
    const on = ids.has(w.id)
    if (on && !inRun) n++
    inRun = on
  }
  return n
}

const STYLE_ON_ITS_OWN = ['size', 'position', 'case']

/** How many things the person changed, counted the way they would count them: each stretch of words cut
 * or brought back, each subtitle setting, each sound, picture, zoom-in and word fix, the cover frame and its words,
 * the pace. */
export function countChanges(e: HandEdit, words: Word[]): number {
  const keys = new Set<string>()
  for (const s of e.set) {
    const [root, k, sub] = s.path
    if (root === 'captions' && k === 'style') keys.add(STYLE_ON_ITS_OWN.includes(sub) ? `style.${sub}` : 'style.look')
    else if (root === 'cover') keys.add(k === 'text' ? 'cover.text' : 'cover.frame')
    else if (root === 'music') keys.add(k === 'level' || k === 'fadeIn' || k === 'fadeOut' ? `music.${k}` : 'music.track')
    // the whole cutStyle is one key: a pace and its moments are one choice, so "Try other moments" after picking Fast
    // is still one change
    else keys.add(s.path.join('.'))
  }
  for (const it of e.items) keys.add(`${it.list}:${it.key}`)
  for (const m of e.mirror) keys.add(`mirror:${m.source}`)
  return keys.size + runs(new Set(e.words.cut), words) + runs(new Set(e.words.keep), words)
}

