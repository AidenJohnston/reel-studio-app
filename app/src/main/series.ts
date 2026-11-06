// Series (tracker series-grouping, ux-foundation-b.md glossary: "an automatic group of reels"). When a reel's Version 1
// is made, it joins the series of the reel that talks most like it, or the two start one named after the older reel's
// title, as More reels names its series (propose-reels.ts). It needs no editor: the words said are compared on this
// computer. A series the person picks, or "no series", is theirs: grouping never moves that reel again.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ProjectJson } from '../shared/api'
import type { AppState } from './store'
import { listProjects, projectDir, readAppState, readProject, serialized, spokenWords, updateAppState, writeJson } from './store'

/** Two reels join when the cosine of their word weights reaches this. There is no measurement on real reels behind
 * it: two short reels on one topic that share three words score about 0.28 (series.test.ts), and reels sharing only
 * words in COMMON score 0. Measure it on real reels before trusting it. */
export const SAME_SERIES = 0.2

// Words too common to say what a reel is about; anything shorter than four letters is dropped as well.
const COMMON = new Set(('about after again also because been before being both could does doing down each even ever every from going gonna have here into just know like little look made make many more most much need only other over really right said same some still such take than that their them then there these they thing things think this those through time today very want well were what when where which while will with would your yeah okay actually basically literally').split(' '))

export interface SeriesReel {
  slug: string
  title: string
  createdAt: string
  series: string | null
  /** the person chose this reel's series: it is never moved, and a new series is never started from it */
  chosen: boolean
  /** what was said, lower case words */
  words: string
}

function terms(words: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const w of words.split(' ')) if (w.length >= 4 && !COMMON.has(w)) out.set(w, (out.get(w) ?? 0) + 1)
  return out
}

/**
 * The series `reel` belongs in among `others`, with the other reel to put in it when a new one starts, or null when
 * nothing talks enough like it. Words are weighted by how rare they are across these reels (tf-idf), so a word every
 * reel says counts for less.
 */
export function pickSeries(reel: SeriesReel, others: SeriesReel[]): { series: string; alsoSet: string | null } | null {
  const all = [reel, ...others.filter((o) => o.slug !== reel.slug)]
  const tf = all.map((r) => terms(r.words))
  const df = new Map<string, number>()
  for (const t of tf) for (const w of t.keys()) df.set(w, (df.get(w) ?? 0) + 1)
  const weigh = (t: Map<string, number>) => {
    const v = new Map<string, number>()
    // log(1 + N/df), not log(N/df): with two reels a word both say must still count
    for (const [w, n] of t) v.set(w, n * Math.log(1 + all.length / df.get(w)!))
    return v
  }
  const vec = tf.map(weigh)
  const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0))
  const cos = (a: Map<string, number>, b: Map<string, number>) => {
    const na = norm(a), nb = norm(b)
    if (!na || !nb) return 0
    let dot = 0
    for (const [w, x] of a) dot += x * (b.get(w) ?? 0)
    return dot / (na * nb)
  }
  let best: { r: SeriesReel; score: number } | null = null
  for (let i = 1; i < all.length; i++) {
    const r = all[i]
    // a chosen "no series" reel is not a series to join, and is never pulled into one
    if (r.chosen && !r.series) continue
    const score = cos(vec[0], vec[i])
    if (score >= SAME_SERIES && (!best || score > best.score)) best = { r, score }
  }
  if (!best) return null
  if (best.r.series) return { series: best.r.series, alsoSet: null }
  const [older] = [reel, best.r].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return { series: older.title, alsoSet: best.r.slug }
}

async function setSeriesFile(slug: string, series: string | null): Promise<void> {
  const file = join(projectDir(slug), 'project.json')
  await serialized(file, async () => {
    // read here, not with readProject: it takes the same per-file queue and would wait on this call for ever
    const p = JSON.parse(await fs.readFile(file, 'utf8')) as ProjectJson
    if (series) p.series = series
    else delete p.series
    // updatedAt stays: a series is not an edit, and the reel keeps its place on Reels
    await writeJson(file, p)
  })
}

async function seriesReels(): Promise<SeriesReel[]> {
  const out: SeriesReel[] = []
  for (const s of await listProjects()) {
    const p = await readProject(s.slug).catch(() => null)
    if (!p) continue
    const st: AppState = await readAppState(s.slug)
    out.push({ slug: s.slug, title: s.title, createdAt: st.createdAt ?? s.updatedAt ?? '', series: s.series, chosen: !!st.seriesChosen, words: await spokenWords(s.slug, p) })
  }
  return out
}

/** After a reel's Version 1: put it in a series if one fits. A reel with a series already (More reels) or one the
 * person chose keeps it. */
export async function groupReel(slug: string): Promise<string | null> {
  const reels = await seriesReels()
  const reel = reels.find((r) => r.slug === slug)
  if (!reel || reel.series || reel.chosen) return reel?.series ?? null
  const pick = pickSeries(reel, reels)
  if (!pick) return null
  await setSeriesFile(slug, pick.series)
  if (pick.alsoSet) await setSeriesFile(pick.alsoSet, pick.series)
  return pick.series
}

/** The person's own choice: a series by name, or none. Automatic grouping never changes it afterwards. */
export async function chooseSeries(slug: string, series: string | null): Promise<void> {
  const name = series?.trim().slice(0, 80) || null
  await setSeriesFile(slug, name)
  await updateAppState(slug, (s) => void (s.seriesChosen = true))
}
