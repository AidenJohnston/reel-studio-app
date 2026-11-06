import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ProjectSummary } from '../../../shared/api'
import { timeLeftWords } from '../../../shared/live'
import { dayLabel, failedByFile } from '../../../shared/notes-log'
import { pauseLine } from '../../../shared/pause'
import { reel, userMessage } from '../api'
import { useNotify } from '../App'
import type { Go } from '../nav'
import { isNew } from '../seen'
import { Icon } from '../components/icons'
import { TitleBarSlot } from '../components/titlebar'
import { byKeyboard, reducedMotion } from '../components/motion'
import { SampleReel } from '../components/SampleReel'
import { Button, IS_MAC, PickFiles, Segmented } from '../components/ui'
import { useModelStatus } from '../components/connect'
import { createFromFiles, newReel } from './create'
import { activity, stateOf, stepWords, type CardState } from './home-state'
import '../components/home.css'

type View = 'activity' | 'all'
const VIEWS = [
  { key: 'activity', label: 'Activity', testid: 'home-activity' },
  { key: 'all', label: 'All reels', testid: 'home-all' }
] as const
const VIEW_KEY = 'rs.home-view'
/** Series chips only help once there are this many reels (spec.md section 4). */
const SERIES_FROM = 12
/** Recent and All reels add a column only once every card can be this wide, so cards grow with the window instead of
 * staying 140 px wide in a third of it (audit-1028 finding 19, the 1600 px shot). */
const CARD_MIN = 168
const GAP = 18

/** A version being made, from the job's own events: how far it is, the time left and the step it is on. */
type Live = { overall: number; secondsLeft: number | null; overdue: boolean; step: string | null }

/** How many card columns fit; Recent and All reels share them. */
function useColumns(ref: React.RefObject<HTMLElement | null>): number {
  const [cols, setCols] = useState(4)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const pad = parseFloat(getComputedStyle(el).paddingLeft) + parseFloat(getComputedStyle(el).paddingRight)
      setCols(Math.max(2, Math.floor((el.clientWidth - pad + GAP) / (CARD_MIN + GAP))))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return cols
}

export function Home({ go }: { go: Go }) {
  const notify = useNotify()
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [live, setLive] = useState<Record<string, Live>>({})
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'all' ? 'all' : 'activity'))
  const [series, setSeries] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<Set<string> | null>(null)
  const page = useRef<HTMLDivElement>(null)
  const cols = useColumns(page)
  /** Each listed reel's status, to notice a job running for a reel the list shows as stopped or doesn't show. */
  const known = useRef(new Map<string, ProjectSummary['status']>())

  useEffect(() => {
    let alive = true
    const load = () =>
      reel.projects.list().then((p) => {
        if (!alive) return
        known.current = new Map(p.map((x) => [x.slug, x.status]))
        setProjects(p)
      })
    void load()
    const off = reel.jobs.onEvent((e) => {
      if (e.type !== 'status' || !e.slug) return void load()
      const slug = e.slug
      setLive((m) => ({ ...m, [slug]: { overall: e.overall, secondsLeft: e.secondsLeft, overdue: e.overdue, step: stepWords(e) } }))
      // a reel started somewhere else (a drop, a paste, a file opened with Reel Studio), or a Resume or Try again whose
      // list was read before its job was recorded: the card would keep its stopped state until the job ended
      const was = known.current.get(slug)
      if (was === undefined || was === 'interrupted' || was === 'failed') void load()
    })
    const offQueue = reel.queue.onChange(() => void load())
    return () => {
      alive = false
      off()
      offQueue()
    }
  }, [])

  // Search across titles and what was said, a beat after typing stops.
  useEffect(() => {
    const q = query.trim()
    if (!q) return setFound(null)
    let alive = true
    const t = window.setTimeout(() => {
      reel.projects.search(q).then(
        (slugs) => alive && setFound(new Set(slugs)),
        (e) => notify(userMessage(e), 'error')
      )
    }, 140)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [query, notify])

  const open = (p: ProjectSummary) => go({ name: 'reel', slug: p.slug })
  // Resume and Try again start the job here; the card moves to Making.
  const resume = (p: ProjectSummary): Promise<void> =>
    reel.projects.resume(p.slug).then(
      () => reel.projects.list().then(setProjects),
      (e) => notify(userMessage(e), 'error')
    )
  // a reel whose video failed Version 1 takes another one here; the card moves to Making
  const another = (p: ProjectSummary, files: string[]): Promise<void> =>
    reel.projects.addVideo(p.slug, files).then(
      () => reel.projects.list().then(setProjects),
      (e) => notify(userMessage(e), 'error')
    )
  const pick = (v: View) => {
    localStorage.setItem(VIEW_KEY, v)
    setView(v)
  }

  const list = projects ?? []
  const now = new Date()
  const allSeries = [...new Set(list.map((p) => p.series).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b))
  const chips = list.length >= SERIES_FROM && allSeries.length > 0
  useFlip(page, `${view}|${series}|${found ? [...found].join() : ''}`, list)

  const card = (p: ProjectSummary) => (
    <Card key={p.slug} p={p} live={live[p.slug]} now={now} onOpen={() => open(p)} onAct={() => resume(p)} onVideo={(files) => another(p, files)} />
  )
  const grid = (items: ProjectSummary[], tail?: ReactNode) => (
    <div className="grid">
      {items.map(card)}
      {tail}
    </div>
  )
  const section = (title: string, items: ProjectSummary[], tail?: ReactNode) =>
    items.length > 0 && (
      <section key={title} aria-label={title}>
        <h2 className="sec-h">{title}</h2>
        {grid(items, tail)}
      </section>
    )

  let body: ReactNode = null
  if (projects && list.length === 0) body = <Empty go={go} />
  else if (view === 'activity') {
    const { needs, making, recent } = activity(list, now)
    // Needs you and Making are short rows, side by side when both have reels, so what is stuck takes a few lines and
    // Recent starts above the fold.
    const rows = (title: string, items: ProjectSummary[]) =>
      items.length > 0 && (
        <section key={title} aria-label={title}>
          <h2 className="sec-h">{title}</h2>
          <ul className="rrows">
            {items.map((p) => (
              <li key={p.slug}>
                <Row p={p} live={live[p.slug]} now={now} onOpen={() => open(p)} onAct={() => resume(p)} onVideo={(files) => another(p, files)} />
              </li>
            ))}
          </ul>
        </section>
      )
    body = (
      <>
        {(needs.length > 0 || making.length > 0) && (
          <div className="now">
            {rows('Needs you', needs)}
            {rows('Making', making)}
          </div>
        )}
        {section('Recent', recent, <NewCard onNew={() => void newReel(go, notify)} />)}
        {!needs.length && !making.length && !recent.length && (
          <p className="home-quiet">
            Nothing new in the last two weeks.{' '}
            <button className="link inline" onClick={() => pick('all')}>
              See all reels
            </button>
          </p>
        )}
      </>
    )
  } else {
    const shown = list.filter((p) => (!chips || !series || p.series === series) && (!found || found.has(p.slug)))
    body = (
      <>
        {chips && (
          <div className="series" role="toolbar" aria-label="Series">
            {[null, ...allSeries].map((s) => (
              <button key={s ?? ''} className="schip" aria-pressed={series === s} onClick={() => setSeries(s)} data-testid="series-chip">
                {s ?? 'All'} <span className="n">{s ? list.filter((p) => p.series === s).length : list.length}</span>
              </button>
            ))}
          </div>
        )}
        {shown.length > 0 ? (
          grid(shown)
        ) : (
          <p className="home-quiet" data-testid="search-empty">
            {found ? `No reels say “${query.trim()}”.` : 'No reels in this series.'}{' '}
            <button className="link inline" onClick={() => (found ? setQuery('') : setSeries(null))}>
              {found ? 'Clear search' : 'See all reels'}
            </button>
          </p>
        )}
      </>
    )
  }

  return (
    <div className="page home" ref={page} style={{ '--cols': cols } as React.CSSProperties} data-testid="reels">
      <TitleBarSlot
        title={
          <>
            <h1 className="tb-h">Reels</h1>
            {list.length > 0 && <Segmented className="tb-seg" label="Show" value={view} options={VIEWS} onPick={pick} />}
          </>
        }
        actions={
          view === 'all' && list.length > 0 ? (
            <label className="rsearch">
              <Icon name="search" size={14} />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                placeholder="Search titles and words"
                aria-label="Search reels by title or by what was said"
                spellCheck={false}
                data-testid="reel-search"
              />
            </label>
          ) : undefined
        }
      />
      {body}
    </div>
  )
}

/**
 * Cards that changed place after the reels changed (Resume moved one to Making, a version landed) slide from where they
 * were, 200 ms, transform only; with reduced motion they fade in place. Switching the view, the series or the search
 * re-lays the grid and does not animate.
 */
function useFlip(page: React.RefObject<HTMLElement | null>, layoutKey: string, list: ProjectSummary[]): void {
  const rects = useRef(new Map<string, DOMRect>())
  const lastKey = useRef(layoutKey)
  useLayoutEffect(() => {
    const el = page.current
    if (!el) return
    const cards = Array.from(el.querySelectorAll<HTMLElement>('[data-slug]'))
    const animate = lastKey.current === layoutKey && !byKeyboard()
    lastKey.current = layoutKey
    const next = new Map<string, DOMRect>()
    for (const c of cards) {
      const r = c.getBoundingClientRect()
      next.set(c.dataset.slug!, r)
      const was = rects.current.get(c.dataset.slug!)
      if (!animate || !was) continue
      const dx = was.left - r.left
      const dy = was.top - r.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
      if (reducedMotion()) c.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' })
      else c.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 200, easing: 'cubic-bezier(.2, .8, .2, 1)' })
    }
    rects.current = next
  }, [page, layoutKey, list])
  // a window resize moves every card: take the new places without animating them
  useEffect(() => {
    const el = page.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      for (const c of el.querySelectorAll<HTMLElement>('[data-slug]')) rects.current.set(c.dataset.slug!, c.getBoundingClientRect())
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [page])
}

/** A stopped reel's one action; `pick` opens a file picker for another video instead of calling onAct. */
type Act = { label: string; testid: string; pick?: true }

/** What a stopped reel's card says and offers: why it stopped, what happens next, and the one action that moves it. */
function stopped(p: ProjectSummary, now: Date): { why: string; next: string; act: Act | null } | null {
  const state = stateOf(p)
  if (state === 'failed') {
    // the file itself (no sound, not a video), or a video never copied in: trying again fails the same way
    const act = failedByFile(p.failedCode) || !p.take ? { label: 'Choose another video', testid: 'card-another', pick: true as const } : { label: 'Try again', testid: 'card-retry' }
    return { why: 'Didn’t finish', next: p.failedWhy ?? 'open it to see why', act }
  }
  if (state !== 'paused') return null
  const line = pauseLine(p.pausedFor, now, IS_MAC ? 'Mac' : 'PC')
  // a pause that continues on its own offers Resume now only where trying early can help: a plan that may have reset
  const act = !p.pausedFor ? { label: 'Resume', testid: 'card-resume' } : p.pausedFor.reason === 'limit' ? { label: 'Resume now', testid: 'card-resume' } : null
  return { ...line, act }
}

/** What a reel says wherever it is listed: its state, why it stopped, its one line, and the name a screen reader hears. */
function lineOf(p: ProjectSummary, live: Live | undefined, now: Date) {
  const state = stateOf(p)
  const making = state === 'making'
  const left = making && live ? timeLeftWords(live) : null
  const step = making ? (live?.step ?? null) : null
  const fresh = state === 'ready' && isNew(p.slug, p.versionAt)
  const stop = stopped(p, now)
  let meta: ReactNode
  let label = p.title
  if (stop) {
    meta = (
      <>
        <b className={state === 'failed' ? 'red' : 'amber'}>{stop.why}</b> · {stop.next}
      </>
    )
    label += `. ${stop.why}, ${stop.next}`
  } else if (state === 'novideo') {
    meta = 'Waiting for your video'
    label += ', waiting for your video'
  } else if (making) {
    meta = `Making Version ${p.version + 1}`
    label += `, making Version ${p.version + 1}${[left, step].map((w) => (w ? `, ${w.toLowerCase()}` : '')).join('')}`
  } else {
    meta = fresh ? (
      <>
        <i className="dot" aria-hidden />
        Version {p.version} · New
      </>
    ) : (
      `Version ${p.version} · ${dayLabel(p.versionAt ?? p.updatedAt, now)}`
    )
    if (fresh) label += `, Version ${p.version} is new`
  }
  // the tooltip carries a stopped reel's whole line: a long reason is cut at two lines
  const tip = stop ? `${p.title}\n${stop.why} · ${stop.next}` : p.title
  return { state, left, step, stop, meta, label, tip }
}

/** The picture: the cover, else the take's first second; a reel with no video yet is paper. */
function Picture({ p, state, title }: { p: ProjectSummary; state: CardState; title: boolean }) {
  if (state === 'novideo') return title ? <span className="paper-t">{p.title}</span> : null
  if (p.thumbnail) return <img src={p.thumbnail} alt="" loading="lazy" decoding="async" />
  return p.take ? <video src={`${p.take}#t=1`} muted playsInline preload="metadata" /> : null
}

/** The one pill a stopped reel offers (Resume, Try again, Choose another video), above the hit area that opens the reel. */
function ActPill({ p, act, onAct, onVideo }: { p: ProjectSummary; act: Act; onAct: () => Promise<void>; onVideo: (files: string[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const run = (work: Promise<void>) => {
    setBusy(true)
    void work.finally(() => setBusy(false))
  }
  if (act.pick)
    return (
      <PickFiles
        size="small"
        className="card-act"
        label={act.label}
        accept="video/*,.mov,.mp4,.m4v"
        disabled={busy}
        aria-label={`${act.label}: ${p.title}`}
        testid={act.testid}
        onFiles={(files) => run(onVideo(files))}
      />
    )
  return (
    <Button size="small" className="card-act" onClick={() => run(onAct())} disabled={busy} aria-label={`${act.label}: ${p.title}`} data-testid={act.testid}>
      {act.label}
    </Button>
  )
}

type Props = { p: ProjectSummary; live?: Live; now: Date; onOpen: () => void; onAct: () => Promise<void>; onVideo: (files: string[]) => Promise<void> }

/** The bar a Making reel's picture carries, moved by the job's own events. */
const Progress = ({ live }: { live?: Live }) => (
  <span className="pb">
    <i style={{ transform: `scaleX(${Math.max(0.03, (live?.overall ?? 0) / 100)})` }} />
  </span>
)

/**
 * A reel: its picture, a title on up to two lines, and one line saying where it is (ux-foundation-b.md section 3.4).
 * Only a state that isn't Ready changes the picture. A reel that stopped says why and what happens next, and its one
 * action is a pill under that line; the rest of the card opens the reel.
 */
function Card({ p, live, now, onOpen, onAct, onVideo }: Props) {
  const l = lineOf(p, live, now)
  return (
    <div className={`rcard st-${l.state}`} data-slug={p.slug}>
      <button className="hit" onClick={onOpen} title={l.tip} aria-label={l.label} data-testid="project-card" data-state={l.state} />
      <div className="im" aria-hidden>
        <Picture p={p} state={l.state} title />
        {l.state === 'paused' && <Icon name="pause" size={30} stroke={0} className="pause-glyph" />}
        {/* the step and the time left sit on the picture, over the bar (spec.md section 4): the line below has no room */}
        {(l.step || l.left) && (
          <span className="left">
            {l.step && <span>{l.step}</span>}
            {l.left && <span>{l.left}</span>}
          </span>
        )}
        {l.state === 'making' && <Progress live={live} />}
      </div>
      <div className="ttl">{p.title}</div>
      <div className={`cm${l.stop ? ' why' : ''}`} data-testid="card-status">
        {l.meta}
      </div>
      {l.stop?.act && <ActPill p={p} act={l.stop.act} onAct={onAct} onVideo={onVideo} />}
    </div>
  )
}

/**
 * A reel in Needs you or Making: a 40 px picture, the title, one status line and its one pill, about a fifth of a
 * card's height, so a few stuck reels don't push Recent below the fold (audit-1028 finding 19). Making names the
 * time left and the step, in the progress strip's words and order (Composer.tsx).
 */
function Row({ p, live, now, onOpen, onAct, onVideo }: Props) {
  const l = lineOf(p, live, now)
  return (
    <div className={`rrow st-${l.state}`} data-slug={p.slug}>
      <button className="hit" onClick={onOpen} title={l.tip} aria-label={l.label} data-testid="project-card" data-state={l.state} />
      <div className="rthumb" aria-hidden>
        <Picture p={p} state={l.state} title={false} />
        {l.state === 'paused' && <Icon name="pause" size={14} stroke={0} className="pause-glyph" />}
        {l.state === 'making' && <Progress live={live} />}
      </div>
      <div className="rtext">
        <div className="ttl">{p.title}</div>
        <div className={`cm${l.stop || l.state === 'making' ? ' why' : ''}`} data-testid="card-status">
          {l.meta}
          {[l.left, l.step].map((w) => (w ? ` · ${w}` : '')).join('')}
        </div>
      </div>
      {l.stop?.act && <ActPill p={p} act={l.stop.act} onAct={onAct} onVideo={onVideo} />}
    </div>
  )
}

/** No reels yet: the sample, and one invitation with its two ways in (spec.md section 4). */
/**
 * The last place in Recent: a reel's own shape, holding nothing yet, that starts a new one (as the sidebar's New reel
 * does). A few reels then fill their row with something to do instead of trailing off into canvas.
 */
function NewCard({ onNew }: { onNew: () => void }) {
  return (
    <div className="rcard new-card">
      <button className="im" onClick={onNew} data-testid="recent-new-reel">
        <Icon name="plus" size={20} />
        <span>New reel</span>
      </button>
    </div>
  )
}

function Empty({ go }: { go: Go }) {
  const notify = useNotify()
  const { s: model } = useModelStatus()
  const mb = (n: number) => Math.round(n / 1e6)
  return (
    <div className="home-empty" data-testid="reels-empty">
      <SampleReel />
      <h2>Drop a video of you talking anywhere in this window, or start with an idea.</h2>
      <div className="row">
        <PickFiles label="Choose video" accept="video/*" kind="primary" onFiles={(paths) => void createFromFiles(paths, go, notify)} />
        <Button onClick={() => void newReel(go, notify)} data-testid="plan-reel">
          Plan a reel
        </Button>
      </div>
      {model && !model.installed && model.downloading && model.total > 0 && (
        <p className="faint tnum" data-testid="empty-model">
          Getting the listening model · {mb(model.bytes)} of {mb(model.total)} MB
        </p>
      )}
    </div>
  )
}
