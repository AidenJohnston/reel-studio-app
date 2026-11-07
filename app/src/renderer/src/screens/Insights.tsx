import { useCallback, useEffect, useState } from 'react'
import { failingRows, scoreLine, scoreRows, type EditScore } from '../../../shared/edit-score'
import { TitleBarSlot } from '../components/titlebar'
import { Button, Spinner } from '../components/ui'
import { reel } from '../api'
import type { Go } from '../nav'
import { RecentReels } from '../components/RecentReels'
import type { InsightMetric, InsightPlatform, InsightReel, InsightTrialResult, InsightsSummary, ResultsPlatformState, ResultsStatus, TrialChange } from '../../../shared/insights'
import { ago, audienceLines, bestReel, compact, percent, PLATFORM_NAMES, reelLine, seconds } from '../../../shared/insight-words'
import '../components/library.css'
import '../components/insights.css'

const CHANGE: Record<TrialChange, string> = { video: 'Two versions', hook: 'Hook', caption: 'Caption', cover: 'Cover', brightness: 'Brightness' }
/** The engine's sentences worth showing here: patterns across reels, not the best reel (the readout leads with it). */
const PATTERNS = new Set(['shorter-held', 'weekday-reach', 'most-improved'])
const STALE_MS = 60 * 60_000
const join = (items: string[]) => items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

/**
 * Insights (spec section 9): how each posted reel did, for the person who made it. A sentence first, the numbers
 * after. Each reel opens at the version that was posted. Results are read in the background (main/results-refresh.ts)
 * and on Refresh; the last read's age is always shown, so old numbers never pass for new ones.
 */
export function Insights({ go }: { go: Go }) {
  const [data, setData] = useState<InsightsSummary | null>(null)
  const [status, setStatus] = useState<ResultsStatus | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async (): Promise<ResultsStatus | null> => {
    try {
      const [summary, s] = await Promise.all([reel.insights.get(), reel.insights.status()])
      setData(summary)
      setStatus(s)
      setProblem(null)
      return s
    } catch (e) {
      setProblem((e as { userMessage?: string }).userMessage ?? 'Post results could not be read.')
      return null
    } finally {
      setNow(Date.now())
    }
  }, [])
  // `all`: every post (the Refresh button); otherwise only posts due a read (opening the page)
  const refresh = useCallback(async (all: boolean) => {
    setReading(true)
    try {
      setStatus(await reel.insights.refresh({ all }))
    } catch (e) {
      setProblem((e as { userMessage?: string }).userMessage ?? 'Post results could not be read.')
    }
    setReading(false)
    await load()
  }, [load])
  useEffect(() => {
    void load().then((s) => {
      // Opening the page reads what's due when the last read is over an hour old (or never happened), so the first
      // visit after connecting an account shows numbers without waiting for the hourly read.
      if (!s || s.running || !Object.values(s.platforms).some((p) => p.state !== 'not-connected')) return
      if (!s.checkedAt || Date.now() - Date.parse(s.checkedAt) > STALE_MS) void refresh(false)
    })
    return reel.insights.onChange(() => void load())
  }, [load, refresh])

  const connected = status ? (Object.keys(status.platforms) as InsightPlatform[]).filter((p) => status.platforms[p].state !== 'not-connected') : []
  const actions = (
    <span className="ins-fresh" data-testid="insights-fresh">
      {reading || status?.running ? (
        <span className="faint" role="status"><Spinner /> Reading results</span>
      ) : status?.checkedAt ? (
        <span className="faint">Updated {ago(status.checkedAt, now)}</span>
      ) : null}
      {connected.length > 0 && (
        <Button kind="tertiary" size="small" disabled={reading || status?.running} onClick={() => void refresh(true)} data-testid="insights-refresh">
          Refresh
        </Button>
      )}
    </span>
  )

  const reels = data?.reels ?? []
  return (
    <div className="page insights-page" data-testid="insights">
      <TitleBarSlot title="Insights" actions={actions} />
      {problem && <p className="banner error" role="alert" data-testid="insights-problem"><span>{problem}</span></p>}
      {status && <PlatformNotes status={status} go={go} />}
      {data && !reels.length ? (
        <Empty connected={connected.length > 0} go={go} />
      ) : data ? (
        <>
          <Readout reels={reels} />
          <ReelList reels={reels} go={go} />
          {data.trialResults.length > 0 && <Trials trials={data.trialResults} reels={reels} />}
          <Audience data={data} />
          <p className="faint ins-foot">Read from your connected accounts. Your results stay on this computer.</p>
        </>
      ) : null}
      {/* one edit to try, from these results and the reels' own timing; it also works before any results */}
      {data && <RecentReels go={go} />}
    </div>
  )
}

function Empty({ connected, go }: { connected: boolean; go: Go }) {
  return (
    <div className="insights-empty" data-testid="insights-empty">
      <h2>No post results yet</h2>
      <p>When you post a reel, this page shows how it did: its views, how long people watched and where they swiped away.</p>
      {connected ? (
        <p>Post a reel from Share. Its first numbers show up here about an hour later.</p>
      ) : (
        <>
          <p>Connect Instagram, TikTok or Facebook first.</p>
          <Button className="ins-connect" onClick={() => go({ name: 'settings', section: 'posting' })} data-testid="insights-connect">
            Open Settings › Posting
          </Button>
        </>
      )}
    </div>
  )
}

/** A platform that needs the person (connect again) or is waiting out a limit says so, once, above everything. */
function PlatformNotes({ status, go }: { status: ResultsStatus; go: Go }) {
  const notes = (Object.entries(status.platforms) as [InsightPlatform, ResultsPlatformState][]).flatMap(([p, s]) => {
    const name = PLATFORM_NAMES[p]
    if (s.state === 'reconnect') return [{ p, kind: 'amber', text: `${name}: ${s.message}`, act: true }]
    if (s.state === 'failed') return [{ p, kind: 'error', text: `${name}: ${s.message}`, act: false }]
    if (s.state === 'waiting') {
      const at = new Date(s.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      return [{ p, kind: 'faint', text: `${name} asked to slow down. Reading again after ${at}.`, act: false }]
    }
    return []
  })
  if (!notes.length) return null
  return (
    <div className="ins-notes">
      {notes.map((n) => (
        <p key={n.p} className={n.kind === 'faint' ? 'faint' : `banner${n.kind === 'error' ? ' error' : ''}`} data-testid={`insights-note-${n.p}`}>
          <span>{n.text}</span>
          {n.act && <Button size="small" onClick={() => go({ name: 'settings', section: 'posting' })}>Open Settings</Button>}
        </p>
      ))}
    </div>
  )
}

const versionName = (r: InsightReel) => `${r.title ?? r.project} · Version ${r.version}`

/** The one sentence a creator reads first: the reel that did best and why, or why there's nothing to say yet. */
function Readout({ reels }: { reels: InsightReel[] }) {
  const best = bestReel(reels)
  if (best) {
    const views = best.totals.metrics.plays ?? 0
    return (
      <section className="ins-lead" data-testid="insights-readout">
        <h2><b>{best.title ?? best.project}</b> did best, with {compact(views)} {views === 1 ? 'view' : 'views'}.</h2>
        <p>{reelLine(best, reels)}.</p>
      </section>
    )
  }
  const counting = reels.some((r) => r.posts.some((p) => p.status === 'still counting'))
  return (
    <section className="ins-lead" data-testid="insights-readout">
      <h2>{counting ? 'Your newest posts are still counting.' : 'Post one more reel to see which does best.'}</h2>
      <p>{counting ? 'Platforms keep adding views for about two days, so results settle then.' : 'With two posted reels, this compares them for you.'}</p>
    </section>
  )
}

function ReelList({ reels, go }: { reels: InsightReel[]; go: Go }) {
  const sorted = [...reels].sort((a, b) => latest(b) - latest(a))
  return (
    <section className="ins-sec" aria-labelledby="ins-reels-h">
      <div className="ins-cols">
        <h2 id="ins-reels-h" className="sec-h">Posted reels</h2>
        {/* each number carries its own label for screen readers */}
        {['Views', 'Watched', 'Skipped', 'Shares', 'Saves'].map((c) => <span key={c} aria-hidden>{c}</span>)}
      </div>
      <ul className="ins-reels" data-testid="insights-reels">
        {sorted.map((r) => <ReelRow key={`${r.project}/${r.version}`} r={r} all={reels} go={go} />)}
      </ul>
    </section>
  )
}
const latest = (r: InsightReel) => Math.max(...r.posts.map((p) => Date.parse(p.publishedAt)))

/** The posted version's edit checks (engine `score`), so a reel's results sit beside how its edit checked out. Null
 * while they load, and for a version the engine can't score (an older or damaged folder): the row then says nothing. */
function useEditScore(project: string, version: number): EditScore | null {
  const [score, setScore] = useState<EditScore | null>(null)
  useEffect(() => {
    let live = true
    reel.projects.score(project, version).then(
      (s) => live && setScore(scoreRows(s).length ? s : null),
      () => live && setScore(null)
    )
    return () => {
      live = false
    }
  }, [project, version])
  return score
}

function ReelRow({ r, all, go }: { r: InsightReel; all: InsightReel[]; go: Go }) {
  const t = r.totals.metrics
  const counting = r.posts.some((p) => p.status === 'still counting')
  const where = join([...new Set(r.posts.map((p) => PLATFORM_NAMES[p.platform]))])
  const watched = t.completionEstimate ?? null
  const missing = (what: string) => `${where} ${r.posts.length > 1 ? 'don’t' : 'doesn’t'} report ${what}`
  // A number that rests on some of the reel's posts (TikTok gives no watch time) says which: "from Instagram only".
  const partial = (m: InsightMetric): string | null => r.totals.coverage[m] > 0 && r.totals.coverage[m] < r.posts.length
    ? `from ${join([...new Set(r.posts.filter((p) => p.metrics[m] !== null).map((p) => PLATFORM_NAMES[p.platform]))])} only` : null
  // The column heads are hidden from screen readers, so each number says what it is.
  const cell = (label: string, value: string | null, what: string, m?: InsightMetric) => {
    const only = m ? partial(m) : null
    return (
      <span className="ins-n" title={value === null ? missing(what) : only ? `${label} ${only}` : undefined}>
        <span className="sr-only">{label}: </span>
        {value ?? <><span aria-hidden>–</span><span className="sr-only">not reported</span></>}
        {value !== null && only && <span className="sr-only">, {only}</span>}
      </span>
    )
  }
  const watchedOnly = partial(watched !== null ? 'completionEstimate' : 'averageWatchTimeMs')
  const watchedText = watched !== null ? percent(watched) : t.averageWatchTimeMs !== null ? seconds(t.averageWatchTimeMs) : null
  const line = reelLine(r, all)
  const score = useEditScore(r.project, r.version)
  // what to fix in the edit, beside what the reel did: the failing checks, by name and value
  const off = score ? failingRows(score) : []
  return (
    <li className={`ins-reel${counting ? ' counting' : ''}`} data-testid="insights-reel" data-project={r.project} data-version={r.version}>
      <button className="hit" onClick={() => go({ name: 'reel', slug: r.project, version: r.version })} aria-label={`Open ${versionName(r)}`} data-testid="insights-open" />
      <div className="rthumb" aria-hidden>{r.cover && <img src={r.cover} alt="" loading="lazy" decoding="async" />}</div>
      <div className="rtext">
        <div className="ttl">{r.title ?? r.project}</div>
        <div className="cm">
          Version {r.version} · {where} · {ago(r.posts[0].publishedAt, Date.now())}
          {score && <span data-testid="insights-checks"> · {scoreLine(score)}</span>}
        </div>
        <div className={`ins-why${counting ? ' faint' : ''}`} data-testid="insights-why">{line}</div>
        {off.length > 0 && (
          <div className="ins-why faint" data-testid="insights-checks-off">
            In the edit: {off.map((row) => `${row.label.toLowerCase()} ${row.after}`).join('; ')}.
          </div>
        )}
      </div>
      {cell('Views', t.plays === null ? null : compact(t.plays), 'views')}
      <span className="ins-n ins-watch" title={watchedText === null ? missing('watch time') : watchedOnly ? `Watched ${watchedOnly}` : undefined}>
        <span><span className="sr-only">Watched on average: </span>{watchedText ?? <><span aria-hidden>–</span><span className="sr-only">not reported</span></>}
          {watchedText !== null && watchedOnly && <span className="sr-only">, {watchedOnly}</span>}</span>
        {watched !== null && <i className="ins-bar" aria-hidden><i style={{ transform: `scaleX(${Math.min(1, watched)})` }} /></i>}
      </span>
      {cell('Skipped in the first 3 seconds', t.skipRatePercent === null ? null : `${Math.round(t.skipRatePercent)}%`, 'skips', 'skipRatePercent')}
      {cell('Shares', t.shares === null ? null : compact(t.shares), 'shares')}
      {cell('Saves', t.saves === null ? null : compact(t.saves), 'saves')}
    </li>
  )
}

function Trials({ trials, reels }: { trials: InsightTrialResult[]; reels: InsightReel[] }) {
  const title = (t: InsightTrialResult) => reels.find((r) => r.project === t.project)?.title ?? t.project
  return (
    <section className="ins-sec" aria-labelledby="ins-trials-h">
      <h2 id="ins-trials-h" className="sec-h">Try 1 and Try 2</h2>
      <ul className="ins-trials" data-testid="insights-trials">
        {trials.map((t) => {
          const [a, b] = t.tries.map((p) => p.metrics.plays)
          const v = t.verdict
          const total = (a ?? 0) + (b ?? 0)
          return (
            <li key={t.id} className="ins-trial" data-testid="insights-trial" data-verdict={v.kind}>
              <div className="ins-trial-h">
                <span className="ttl">{title(t)}</span>
                <span className="faint">{t.change ? `${CHANGE[t.change]} test` : 'Trial'} on {PLATFORM_NAMES[t.platform]}</span>
                <span className={`ins-verdict ${v.kind}`} data-testid="insights-verdict">
                  {v.kind === 'winner' ? `Try ${v.winner} won` : v.kind === 'too-close' ? 'Too close to call' : v.kind === 'too-few' ? 'Too few views yet' : 'Waiting'}
                </span>
              </div>
              {total > 0 && (
                <div className="ins-split" aria-hidden>
                  <span className={v.kind === 'winner' && v.winner === 1 ? 'won' : ''} style={{ flexGrow: a ?? 0 }}>Try 1 · {compact(a ?? 0)}</span>
                  <span className={v.kind === 'winner' && v.winner === 2 ? 'won' : ''} style={{ flexGrow: b ?? 0 }}>Try 2 · {compact(b ?? 0)}</span>
                </div>
              )}
              <p className="ins-reason">{v.reason}</p>
              {v.kind === 'winner' && t.platform === 'instagram' && (
                <p className="faint">Instagram only lets you share a trial reel with your followers in its app: open Try {v.winner} there and tap Share to everyone.</p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Audience({ data }: { data: InsightsSummary }) {
  const lines = [
    ...data.audience.flatMap(audienceLines),
    ...data.sentences.filter((s) => PATTERNS.has(s.template)).map((s) => `${s.text}.`)
  ]
  if (!lines.length) return null
  return (
    <section className="ins-sec" aria-labelledby="ins-aud-h" data-testid="insights-audience">
      <h2 id="ins-aud-h" className="sec-h">Who's watching</h2>
      <ul className="ins-lines">{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </section>
  )
}
