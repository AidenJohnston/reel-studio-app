import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { DropResult, LibraryBin, LibraryFile, LibraryPreview } from '../../../shared/api'
import { describeSorted } from '../../../shared/describe'
import { reel, userMessage } from '../api'
import { Button, FOLDER_APP, PickFiles, Spinner } from '../components/ui'
import { Icon } from '../components/icons'
import { FootageFolders } from '../components/FootageFolders'
import { TitleBarSlot } from '../components/titlebar'
import '../components/library.css'
import '../components/fonts.css'

type Tab = 'images' | 'videos' | 'music' | 'sfx' | 'fonts'
const TABS: { key: Tab; label: string; bins: LibraryBin['key'][]; empty: [string, string] }[] = [
  { key: 'images', label: 'Pictures', bins: ['images'], empty: ['No pictures yet', 'Drop pictures, logos or screenshots on this window, or use Add files.'] },
  { key: 'videos', label: 'Videos', bins: ['broll', 'raw'], empty: ['No videos yet', 'Drop clips your editor can show while you talk, or use Add files.'] },
  { key: 'music', label: 'Music', bins: ['music'], empty: ['No music yet', 'Drop songs on this window, or use Add files.'] },
  { key: 'sfx', label: 'Sound effects', bins: ['sfx'], empty: ['No sound effects', 'The sounds that come with Reel Studio are missing. Reinstall it to bring them back.'] },
  { key: 'fonts', label: 'Fonts', bins: ['fonts', 'fontpack'], empty: ['No fonts', 'The fonts that come with Reel Studio are missing. Reinstall it to bring them back.'] }
]
const TAB_OF: Partial<Record<NonNullable<DropResult['bin']>, Tab>> = { images: 'images', broll: 'videos', raw: 'videos', music: 'music', fonts: 'fonts' }
const ABOUT: Record<Tab, string> = {
  images: 'Pictures your editor can put in a reel.',
  videos: 'Clips your editor can show while you talk.',
  music: 'Songs your editor can put under your voice.',
  sfx: 'Come with Reel Studio, free to use (CC0). Your editor places them on cuts and words.',
  fonts: 'Faces your editor can set your subtitles in. Drop .ttf or .otf files to add your own.'
}
const SFX_GROUP: Record<string, string> = { whoosh: 'Whooshes', pop: 'Pops', click: 'Clicks', ding: 'Dings', impact: 'Hits', riser: 'Risers', typing: 'Typing' }

const clock = (s: number): string => (s < 10 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`)
const licence = (f: LibraryFile): string => f.licence ?? 'Yours'
/** "whoosh-quick.opus" -> "Whoosh quick" */
const soundName = (file: string): string => {
  const s = file.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Previews are made in main (library-preview.ts) and asked for once per file while the screen is open. */
function usePreviews(files: LibraryFile[]): Record<string, LibraryPreview | 'none'> {
  const [got, setGot] = useState<Record<string, LibraryPreview | 'none'>>({})
  const asked = useRef(new Set<string>())
  useEffect(() => {
    for (const f of files) {
      if (asked.current.has(f.path)) continue
      asked.current.add(f.path)
      reel.library.preview(f.path).then(
        (p) => setGot((g) => ({ ...g, [f.path]: p })),
        () => setGot((g) => ({ ...g, [f.path]: 'none' }))
      )
    }
  }, [files])
  return got
}

/**
 * One audio element for the whole screen: a song or a sound plays while you rest the pointer on its row or reach it
 * with the keyboard, and stops when you leave; the play button keeps it going. Its time drives the played part
 * of the waveform, written straight to the row's style so nothing re-renders while it plays.
 */
function useAudition() {
  const audio = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const pinned = useRef(false)
  const dwell = useRef<number | undefined>(undefined)
  const raf = useRef(0)
  const rows = useRef(new Map<string, HTMLElement>())

  const paint = useCallback((path: string) => {
    const a = audio.current
    const row = rows.current.get(path)
    if (!a || !row) return
    const p = a.duration > 0 ? a.currentTime / a.duration : 0
    row.style.setProperty('--played', `${(1 - p) * 100}%`)
    raf.current = requestAnimationFrame(() => paint(path))
  }, [])

  const stop = useCallback(() => {
    window.clearTimeout(dwell.current)
    cancelAnimationFrame(raf.current)
    audio.current?.pause()
    for (const row of rows.current.values()) row.style.removeProperty('--played')
    pinned.current = false
    setPlaying(null)
  }, [])

  const play = useCallback(
    (f: LibraryFile, pin: boolean) => {
      stop()
      const a = audio.current ?? (audio.current = new Audio())
      a.src = f.url
      a.onended = stop
      pinned.current = pin
      setPlaying(f.path)
      void a.play().then(() => paint(f.path), stop)
    },
    [paint, stop]
  )

  useEffect(() => () => {
    stop()
    audio.current?.removeAttribute('src')
  }, [stop])

  return {
    playing,
    stop,
    row: (f: LibraryFile) => ({
      ref: (el: HTMLElement | null) => {
        if (el) rows.current.set(f.path, el)
        else rows.current.delete(f.path)
      },
      onPointerEnter: () => {
        window.clearTimeout(dwell.current)
        if (!pinned.current) dwell.current = window.setTimeout(() => play(f, false), 320)
      },
      onPointerLeave: () => {
        window.clearTimeout(dwell.current)
        if (!pinned.current && playing === f.path) stop()
      },
      onBlur: () => {
        window.clearTimeout(dwell.current)
        if (!pinned.current && playing === f.path) stop()
      }
    }),
    toggle: (f: LibraryFile) => (playing === f.path && pinned.current ? stop() : play(f, true))
  }
}

function Waveform({ peaks }: { peaks?: number[] }) {
  if (!peaks) return <span className="lib-wave pending" aria-hidden />
  const w = 2
  const gap = 1.5
  const bars = peaks.map((p, i) => {
    const h = Math.max(1.5, p * 26)
    return <rect key={i} x={i * (w + gap)} y={(28 - h) / 2} width={w} height={h} rx={1} />
  })
  const width = peaks.length * (w + gap) - gap
  return (
    <span className="lib-wave" aria-hidden>
      <svg viewBox={`0 0 ${width} 28`} preserveAspectRatio="none">{bars}</svg>
      <svg className="played" viewBox={`0 0 ${width} 28`} preserveAspectRatio="none">{bars}</svg>
    </span>
  )
}

function Sounds({ files, previews, audition }: { files: LibraryFile[]; previews: Record<string, LibraryPreview | 'none'>; audition: ReturnType<typeof useAudition> }) {
  return (
    <ul className="lib-rows">
      {files.map((f) => {
        const p = previews[f.path]
        const peaks = p && p !== 'none' ? p.peaks : undefined
        const seconds = f.durationSec ?? (p && p !== 'none' ? p.durationSec : undefined)
        const name = f.group ? soundName(f.name) : f.name.replace(/\.[^.]+$/, '')
        const on = audition.playing === f.path
        return (
          <li key={f.path} className={`lib-row${on ? ' on' : ''}`} {...audition.row(f)} data-testid="library-sound">
            <button
              type="button"
              className="icon-btn lib-play"
              aria-label={`${on ? 'Stop' : 'Play'} ${name}`}
              aria-pressed={on}
              onClick={() => audition.toggle(f)}
            >
              <Icon name={on ? 'pause' : 'play'} size={14} />
            </button>
            <span className="lib-row-t" title={f.name}>
              <b>{name}</b>
              <span>{licence(f)}</span>
            </span>
            {p === 'none' ? <span className="lib-wave none">No preview</span> : <Waveform peaks={peaks} />}
            <span className="lib-dur">{seconds !== undefined ? clock(seconds) : ''}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** Each font file as a face the page can draw with, so a row shows the font itself. Faces stay loaded while the app
 * runs: the same file is asked for once. */
const faces = new Map<string, string>()
function faceOf(f: LibraryFile): string {
  let family = faces.get(f.url)
  if (!family) {
    family = `rs-lib-font-${faces.size}`
    faces.set(f.url, family)
    const face = new FontFace(family, `url("${f.url}")`)
    void face.load().then((loaded) => document.fonts.add(loaded), () => undefined)
  }
  return family
}

function Fonts({ groups }: { groups: LibraryBin[] }) {
  return (
    <>
      {groups
        .filter((b) => b.files.length)
        .map((b) => (
          <section key={b.key} className="lib-group" data-testid={`bin-${b.key}`}>
            <h2>
              {b.label} <span className="n">{b.files.length}</span>
            </h2>
            <ul className="lib-rows">
              {b.files.map((f) => (
                <li key={f.path} className="lib-font" data-testid="library-font">
                  <span className="lib-font-sample" style={{ fontFamily: `"${faceOf(f)}", var(--font-ui)` }} aria-hidden>
                    Your words, on screen
                  </span>
                  <span className="lib-row-t" title={f.name}>
                    <b>{f.font?.full ?? f.name}</b>
                    <span>{licence(f)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </>
  )
}

function Pictures({ files }: { files: LibraryFile[] }) {
  return (
    <ul className="lib-grid lib-pics">
      {files.map((f) => (
        <li key={f.path} className="lib-item" title={f.name} data-testid="library-picture">
          <img className="lib-thumb" src={f.url} alt="" loading="lazy" decoding="async" />
          <b>{f.name}</b>
          <span>{licence(f)}</span>
        </li>
      ))}
    </ul>
  )
}

function Clips({ files, previews }: { files: LibraryFile[]; previews: Record<string, LibraryPreview | 'none'> }) {
  return (
    <ul className="lib-grid lib-clips">
      {files.map((f) => {
        const p = previews[f.path]
        return (
          <li key={f.path} className="lib-item" title={f.name} data-testid="library-clip">
            {p && p !== 'none' && p.sheet ? (
              <img className="lib-thumb lib-sheet" src={p.sheet} alt="" decoding="async" />
            ) : (
              <span className={`lib-thumb lib-sheet${p === 'none' ? ' none' : ' pending'}`}>{p === 'none' ? 'No preview' : ''}</span>
            )}
            <b>{f.name}</b>
            <span>
              {p && p !== 'none' ? `${clock(p.durationSec)} · ` : ''}
              {licence(f)}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** Drops anywhere on the window land here while this screen is open (App passes what they were sorted into). */
export function Library({ added }: { added?: { results: DropResult[]; at: number } }) {
  const [bins, setBins] = useState<LibraryBin[] | null>(null)
  const [tab, setTab] = useState<Tab>('images')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ text: string; error?: boolean } | null>(null)
  const audition = useAudition()
  const tabs = useRef(new Map<Tab, HTMLButtonElement>())
  const load = useCallback(() => reel.library.list().then(setBins), [])

  const landed = useCallback((r: DropResult[]) => {
    setResult({ text: describeSorted(r) || 'Nothing was added.' })
    const to = r.map((x) => x.bin && TAB_OF[x.bin]).find(Boolean)
    if (to) setTab(to)
  }, [])

  const add = async (paths: string[]) => {
    setBusy(true)
    try {
      landed(await reel.library.add(paths))
      await load()
    } catch (e) {
      setResult({ text: userMessage(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
  }, [load])
  // a drop from before this screen opened was already said where it was made
  const openedAt = useRef(Date.now())
  useEffect(() => {
    if (!added || added.at < openedAt.current) return
    landed(added.results)
    void load()
  }, [added, landed, load])

  const current = TABS.find((t) => t.key === tab)!
  const groups = (bins ?? []).filter((b) => current.bins.includes(b.key))
  const files = groups.flatMap((b) => b.files)
  const previews = usePreviews(tab === 'images' ? [] : files)
  const count = (t: (typeof TABS)[number]) => (bins ?? []).filter((b) => t.bins.includes(b.key)).reduce((n, b) => n + b.files.length, 0)
  // where Add files and drops put this tab's files (Videos: Extra clips)
  const folder = groups.find((b) => b.key !== 'sfx' && b.key !== 'fontpack')

  const choose = (t: Tab) => {
    audition.stop()
    setTab(t)
  }
  const arrows = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.key === tab)
    const next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1
    if (next < 0) return
    e.preventDefault()
    choose(TABS[next].key)
    tabs.current.get(TABS[next].key)?.focus()
  }

  return (
    <div className="page lib-page">
      <TitleBarSlot
        title="Library"
        actions={
          <>
            {busy && <Spinner />}
            <PickFiles kind="primary" label="Add files" icon={<Icon name="plus" />} onFiles={add} />
          </>
        }
      />
      <div className="lib-tabs" role="tablist" aria-label="Library" onKeyDown={arrows}>
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              if (el) tabs.current.set(t.key, el)
            }}
            role="tab"
            id={`lib-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="lib-panel"
            tabIndex={tab === t.key ? 0 : -1}
            className="lib-tab"
            onClick={() => choose(t.key)}
            data-testid={`library-tab-${t.key}`}
          >
            {t.label}
            {bins && <span className="n">{count(t)}</span>}
          </button>
        ))}
      </div>
      <div className="lib-sub">
        <span>{ABOUT[tab]}</span>
        {folder && (
          <Button kind="tertiary" size="small" onClick={() => reel.app.openFolder(folder.dir)}>
            Show in {FOLDER_APP}
          </Button>
        )}
      </div>
      {result && (
        <p className={`lib-result${result.error ? ' error' : ''}`} role="status" data-testid="library-result">
          {!result.error && <Icon name="check" size={14} />}
          <span>{result.text}</span>
          <button className="icon-btn" aria-label="Hide this" onClick={() => setResult(null)}>
            <Icon name="x" size={14} />
          </button>
        </p>
      )}
      <div id="lib-panel" role="tabpanel" aria-labelledby={`lib-tab-${tab}`} className="lib-panel" data-testid={`library-panel-${tab}`}>
        {tab === 'videos' && <FootageFolders say={setResult} />}
        {bins && !files.length && (
          <div className="lib-empty" data-testid="library-empty">
            <h2>{current.empty[0]}</h2>
            <p>{current.empty[1]}</p>
          </div>
        )}
        {tab === 'images' && files.length > 0 && <Pictures files={files} />}
        {tab === 'videos' &&
          groups
            .filter((b) => b.files.length)
            .map((b) => (
              <section key={b.key} className="lib-group" data-testid={`bin-${b.key}`}>
                {groups.filter((g) => g.files.length).length > 1 && (
                  <h2>
                    {b.label} <span className="n">{b.files.length}</span>
                  </h2>
                )}
                <Clips files={b.files} previews={previews} />
              </section>
            ))}
        {tab === 'music' && files.length > 0 && (
          <div data-testid="bin-music">
            <Sounds files={files} previews={previews} audition={audition} />
          </div>
        )}
        {tab === 'fonts' && files.length > 0 && <Fonts groups={groups} />}
        {tab === 'sfx' &&
          [...new Set(files.map((f) => f.group ?? ''))].map((job) => {
            const set = files.filter((f) => (f.group ?? '') === job)
            return (
              <section key={job} className="lib-group">
                <h2>
                  {SFX_GROUP[job] ?? job} <span className="n">{set.length}</span>
                </h2>
                <Sounds files={set} previews={previews} audition={audition} />
              </section>
            )
          })}
      </div>
    </div>
  )
}
