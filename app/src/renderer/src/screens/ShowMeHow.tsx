import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CoverCandidate, LibraryFile, PlacedWord, ProjectDetail, ProjectJson, QueuedNote, VersionInfo, VersionTimeline } from '../../../shared/api'
import { lookFromStyle, sampleLine, sampleLook, type SubtitleLook } from '../../../shared/caption-presets'
import { coverMoments } from '../../../shared/cover'
import { describeChange } from '../../../shared/describe'
import { errorCode, reel, userMessage } from '../api'
import { useNotify } from '../App'
import { Icon } from '../components/icons'
import { byKeyboard, reducedMotion } from '../components/motion'
import { SafeBand } from '../components/Phone'
import { Button, IS_MAC } from '../components/ui'
import { CoverTab } from './edit/CoverTab'
import { CutTab, type CutMode } from './edit/CutTab'
import { PicturesTab, pictureUrl } from './edit/PicturesTab'
import { During, OnPhone, SkipRanges, SoundCues, type PlayerHandle } from './edit/preview'
import { useEditSession } from './edit/session'
import { soundPack, SoundTab } from './edit/SoundTab'
import { SubtitlesTab } from './edit/SubtitlesTab'
import type { RenderSegment } from '../../../shared/moments'
import { joinsOf, musicFades, newToTheEar, sfxVolume, soundRows, soundTime, type SoundEffect, type VersionClock } from '../../../shared/sfx'
import { clipsOf, pictureParts, pictureWhy, soundParts, videoParts, type Lanes } from '../../../shared/lanes'
import './edit/edit.css'

export type { PlayerHandle } from './edit/preview'
export type Tab = 'cut' | 'captions' | 'music' | 'broll' | 'cover'
const TABS: { key: Tab; label: string }[] = [
  { key: 'cut', label: 'Cut' },
  { key: 'captions', label: 'Subtitles' },
  { key: 'music', label: 'Sound' },
  { key: 'broll', label: 'Pictures' },
  { key: 'cover', label: 'Cover' }
]
// The parts of the project a hand edit can change, for the plain-words summary.
const PARTS = ['sources', 'captions', 'music', 'broll', 'cover', 'sfx', 'cutStyle', 'beatAccents', 'zooms', 'cut'] as const
// Matches the .edit enter animation (edit.css): the notes column and this panel swap in a 150 ms crossfade.
const LEAVE_MS = 150

/**
 * Edit it myself: in the notes column's place, it changes the newest version by hand. The reel's player shows
 * each change as it is made, and "Make Version N" makes it, now or, while the editor is busy, after the notes
 * ahead of it (main/note-queue.ts). Closing keeps the changes for next time.
 */
export function ShowMeHow({
  d,
  version,
  initialTab = 'cut',
  player,
  queued = null,
  onClose,
  onPreview,
  onTab,
  sound = null,
  reveal = 0,
  onSound,
  picture = null,
  pictureReveal = 0,
  onPicture,
  onLanes
}: {
  d: ProjectDetail
  /** The version the player shows: the newest. */
  version: VersionInfo | null
  initialTab?: Tab
  player: PlayerHandle
  /** A waiting hand edit to change (its Edit in the notes log). */
  queued?: QueuedNote | null
  onClose: () => void
  /** The subtitle look to preview on the phone, on a still of the original at `at`, or null. */
  onPreview: (p: { look: SubtitleLook; text: string; at: number } | null) => void
  onTab?: (t: Tab) => void
  /** The sound picked here or on the timeline (its moment), and a pick from either. */
  sound?: string | null
  /** Counts picks on the timeline (Reel.tsx). */
  reveal?: number
  onSound?: (key: string | null) => void
  /** The picture picked here or on the timeline (its b-roll id), and how many times the timeline picked one. */
  picture?: string | null
  pictureReveal?: number
  onPicture?: (id: string | null) => void
  /** What the timeline draws while this is open: the version's video, and the pictures and sounds as changed here. */
  onLanes?: (l: Lanes | null) => void
}) {
  const notify = useNotify()
  const s = useEditSession(d, queued)
  const { base, now } = s
  const [tab, setTabState] = useState<Tab>(initialTab)
  const [cutMode, setCutMode] = useState<CutMode>('cut')
  const [line, setLine] = useState<{ text: string; at: number } | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [making, setMaking] = useState(false)
  const [placed, setPlaced] = useState(() => new Map<string, PlacedWord>())
  const [segments, setSegments] = useState<RenderSegment[]>([])
  const [shown, setShown] = useState<VersionTimeline | null>(null)
  const [images, setImages] = useState<LibraryFile[]>([])
  const [pack, setPack] = useState<SoundEffect[]>([])
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})

  const setTab = (t: Tab) => {
    setTabState(t)
    onTab?.(t)
    // leaving Sound drops the pick, so picking the same sound on the timeline again comes back to it
    if (t !== 'music' && sound) onSound?.(null)
    if (t !== 'broll' && picture) onPicture?.(null)
  }
  const leaveTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(leaveTimer.current), [])
  const close = useCallback(() => {
    if (byKeyboard() || reducedMotion()) return onClose()
    if (leaveTimer.current !== undefined) return
    setLeaving(true)
    leaveTimer.current = window.setTimeout(onClose, LEAVE_MS)
  }, [onClose])

  // where each word plays in the version on the player, for times and the live previews
  useEffect(() => {
    if (!version) return
    let live = true
    reel.projects
      .timeline(d.slug, version.n)
      .then((t) => {
        if (!live) return
        setPlaced(new Map((t?.words ?? []).map((w) => [w.id, w])))
        setSegments(t?.segments ?? [])
        setShown(t)
      })
      .catch((e) => notify(userMessage(e), 'error'))
    return () => {
      live = false
    }
  }, [d.slug, version?.n, notify])

  const reloadImages = useCallback(
    () =>
      reel.library
        .list()
        .then((bins) => setImages(bins.find((b) => b.key === 'images')?.files ?? []))
        .catch((e) => notify(userMessage(e), 'error')),
    [notify]
  )
  useEffect(() => {
    void reloadImages()
    soundPack().then(setPack, () => undefined)
  }, [reloadImages])

  // Focus the open tab, not Close (an auto-focused Close looked like the main button); back to the opener after.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    tabRefs.current[tab]?.focus()
    return () => {
      if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc closes; Cmd/Ctrl+Z undoes (in a text box it undoes the typing).
  const keys = useRef({ close, undo: s.undo })
  keys.current = { close, undo: s.undo }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop')) return
      // Share's popover or the ⋯ menu took this Escape for itself
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        keys.current.close()
        return
      }
      const t = e.target as HTMLElement | null
      const inBox = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox'
      if (!inBox && (IS_MAC ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault()
        keys.current.undo()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  // The subtitle look on the phone, on a line of the reel: in Subtitles, and while fixing words in Cut.
  const captions = now.p.captions
  const style = (captions?.style ?? {}) as Record<string, unknown>
  const sample = useMemo(() => sampleLine(d.words, now.kept, Number(style.maxWords ?? 3)), [d.words, now.kept, style.maxWords])
  const subsShown = (tab === 'captions' || (tab === 'cut' && cutMode === 'fix')) && captions?.enabled !== false
  const lookJson = JSON.stringify(style)
  useEffect(() => {
    const shown = line ?? sample
    onPreview(subsShown ? { look: line ? { ...lookFromStyle(style), highlight: null } : sampleLook(style, sample), text: shown.text, at: shown.at } : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsShown, lookJson, line, sample])
  useEffect(() => () => onPreview(null), [onPreview])
  useEffect(() => setLine(null), [tab, cutMode])

  // Live previews on the player: the cut words skipped, new sounds heard, new pictures shown, all on its clock.
  const skip = useMemo(() => {
    const ranges: [number, number][] = []
    for (const id of base.kept) {
      const w = !now.kept.has(id) && placed.get(id)
      if (!w) continue
      const last = ranges[ranges.length - 1]
      if (last && w.s - last[1] < 0.15) last[1] = Math.max(last[1], w.e)
      else ranges.push([w.s, w.e])
    }
    return ranges.sort((a, b) => a[0] - b[0])
  }, [base.kept, now.kept, placed])
  const vclock = useMemo((): VersionClock => ({ placed, segments, words: d.words, kept: base.kept }), [placed, segments, d.words, base.kept])
  const joins = useMemo(() => joinsOf(vclock), [vclock])
  const cues = useMemo(() => {
    const byId = new Map(pack.map((p) => [p.id, p]))
    return newToTheEar(base.p.sfx ?? [], now.p.sfx ?? []).flatMap((x) => {
      const sound = byId.get(x.sound)
      const at = soundTime(x, vclock, joins, now.p.broll)
      if (!sound || at === null) return []
      return [{ at: Math.max(0, at - sound.onsetMs / 1000), url: sound.url, volume: sfxVolume(x) }]
    })
  }, [base.p.sfx, now.p.sfx, now.p.broll, pack, vclock, joins])

  // a sound picked on the timeline opens this tab on it
  useEffect(() => {
    if (sound && tab !== 'music') setTab('music')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sound])
  const newPictures = useMemo(() => {
    const had = new Set((base.p.broll ?? []).map((b) => b.id))
    return (now.p.broll ?? []).flatMap((b) => {
      const from = placed.get(b.anchor.from)
      const to = placed.get(b.anchor.to)
      const url = pictureUrl(b, d.brollThumbs, images)
      return had.has(b.id) || !from || !url ? [] : [{ id: b.id, url, from: from.s, to: Math.max(to?.e ?? 0, from.s + 2) }]
    })
  }, [base.p.broll, now.p.broll, placed, d.brollThumbs, images])

  // One look for cover frames per opening, over the words kept when the Cover tab first opens.
  const picks = useRef<Promise<CoverCandidate[]> | null>(null)
  const nowRef = useRef(now)
  nowRef.current = now
  const loadPicks = useCallback(() => {
    if (!picks.current) {
      const source = nowRef.current.p.cover?.source ?? d.project.sources?.[0]?.id ?? 's1'
      const moments = coverMoments(d.words, nowRef.current.kept, source)
      picks.current = moments.length ? reel.projects.coverCandidates(d.slug, moments, source) : Promise.resolve([])
    }
    return picks.current
  }, [d.slug, d.words, d.project.sources])
  useEffect(
    () => () => {
      if (picks.current) void reel.projects.stopCoverCandidates(d.slug)
    },
    [d.slug]
  )

  // Version numbers: the one being made now, then each waiting note or edit in turn.
  const latest = d.versions[d.versions.length - 1]?.n ?? 0
  const busy = !!d.job && d.job.kind !== 'export'
  const waiting = d.queue.filter((q) => !q.attempt)
  const mine = queued ? waiting.findIndex((q) => q.id === queued.id) : -1
  const ahead = mine >= 0 ? mine : waiting.length
  const next = latest + (busy ? 1 : 0) + ahead + 1

  // The timeline under the phone shows what this changes: each picture while it shows, each sound at its moment, the
  // music's fades and the cuts, on the clock of the version on screen. The render's own picture times hold for the
  // pictures unchanged since it; the rest are placed by its rules.
  const said = useCallback((id: string) => d.words.find((w) => w.id === id)?.w, [d.words])
  const music = now.p.music
  // each lane from what it depends on, so dragging a fade or a level works out only the sounds again
  const sounds = useMemo(
    () => soundParts(soundRows(now.p.sfx ?? [], vclock, joins, now.p.broll, now.kept, said, new Map(pack.map((p) => [p.id, p])))),
    [now.p.sfx, now.p.broll, now.kept, vclock, joins, said, pack]
  )
  const fades = useMemo(() => (music?.enabled !== false && music?.track ? musicFades(music) : null), [music])
  const videoLane = useMemo(
    () => videoParts(segments, clipsOf(shown?.project.cut?.keep), shown?.words ?? [], joins.filter((j) => j.cut !== null).map((j) => j.t), shown?.project.sources ?? []),
    [segments, shown, joins]
  )
  const pictures = useMemo(() => {
    const before = new Map((shown?.project.broll ?? []).map((b) => [b.id, JSON.stringify(b)]))
    const unchanged = new Set((now.p.broll ?? []).filter((b) => before.get(b.id) === JSON.stringify(b)).map((b) => b.id))
    const layers = new Map((shown?.layers ?? []).flatMap((l) => (l.id && unchanged.has(l.id) ? [[l.id, l] as const] : [])))
    const had = new Set((base.p.broll ?? []).map((b) => b.id))
    const why = (id: string) => (had.has(id) ? pictureWhy(id, d.versions, d.project.notes ?? [], version?.n ?? 0) : `New: in Version ${next} once you make it`)
    return pictureParts(now.p.broll ?? [], { placed: shown?.words ?? [], segments }, layers, shown?.duration ?? 0, why, (b) => pictureUrl(b, d.brollThumbs, images))
  }, [now.p.broll, shown, segments, base.p.broll, d.versions, d.project.notes, d.brollThumbs, images, version?.n, next])
  const lanes = useMemo(
    (): Lanes => ({ video: videoLane, pictures, sounds, music: fades, joins: joins.map(({ t, bridge }) => ({ t, bridge })) }),
    [videoLane, pictures, sounds, fades, joins]
  )
  // a level or a fade being dragged changes the project, not always what the timeline draws: Reel re-renders only
  // when it does
  const lanesKey = JSON.stringify(lanes)
  useEffect(() => onLanes?.(lanes), [lanesKey, onLanes]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onLanes?.(null), [onLanes])
  // a picture picked on the timeline opens its tab on it
  useEffect(() => {
    if (picture && tab !== 'broll') setTab('broll')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picture, pictureReveal])

  const make = async () => {
    const patch: Partial<ProjectJson> = {}
    // a pace taken off stays absent: describeChange reads that as turning it off
    for (const k of PARTS) if (JSON.stringify(now.p[k]) !== JSON.stringify(base.p[k])) Object.assign(patch, { [k]: k === 'cutStyle' || k === 'beatAccents' ? now.p[k] : (now.p[k] ?? []) })
    // said after "You" in the notes (shared/notes-log.ts handLine)
    const summary = describeChange(base.p, patch, now.kept.size - base.kept.size) || 'made a change'
    setMaking(true)
    try {
      await reel.projects.handEdit(d.slug, s.edit, summary, s.changes, s.queued?.id).catch((e) => {
        // it started before this change reached it: this change goes after it instead
        if (s.queued && errorCode(e) === 'NOT_QUEUED') return reel.projects.handEdit(d.slug, s.onTopOfQueued(), summary, s.changes)
        throw e
      })
      s.finish()
      close()
    } catch (e) {
      setMaking(false)
      notify(userMessage(e), 'error')
    }
  }

  const tabProps = { d, base, now, change: s.change, settle: s.settle, player, placed, version, next }
  const n = s.changes
  return (
    <section className={`edit${leaving ? ' leaving' : ''}`} aria-label="Edit it myself" data-testid="drawer">
      <div className="edit-h">
        <h2>Edit it myself</h2>
        <button className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc). Your changes stay." data-testid="drawer-close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <p className="edit-sub">{s.queued ? `Your waiting edit. What you change here replaces it.` : 'Nothing changes until you make a new version.'}</p>
      <div
        className="tabs edit-tabs"
        role="tablist"
        aria-label="What to change"
        onKeyDown={(e) => {
          const i = TABS.findIndex((t) => t.key === tab)
          const to = ({ ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 } as Partial<Record<string, number>>)[e.key]
          if (to === undefined) return
          e.preventDefault()
          const k = TABS[(to + TABS.length) % TABS.length].key
          setTab(k)
          tabRefs.current[k]?.focus()
        }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[t.key] = el
            }}
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls="edit-panel"
            tabIndex={tab === t.key ? 0 : -1}
            className={`tab${tab === t.key ? ' active' : ''}`}
            onClick={() => setTab(t.key)}
            data-testid={`tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="edit-b" role="tabpanel" id="edit-panel" aria-labelledby={`tab-${tab}`}>
        {tab === 'cut' && <CutTab {...tabProps} mode={cutMode} onMode={setCutMode} onLine={setLine} />}
        {tab === 'captions' && <SubtitlesTab {...tabProps} />}
        {tab === 'music' && <SoundTab {...tabProps} vclock={vclock} joins={joins} selected={sound} onSelect={(k) => onSound?.(k)} reveal={reveal} />}
        {tab === 'broll' && <PicturesTab {...tabProps} images={images} reloadImages={reloadImages} selected={picture} reveal={pictureReveal} onSelect={(id) => onPicture?.(id)} />}
        {tab === 'cover' && <CoverTab {...tabProps} loadPicks={loadPicks} segments={segments} />}
      </div>
      {(busy || ahead > 0) && (
        <p className="edit-wait" role="status" data-testid="edit-wait">
          {busy ? `Version ${latest + 1} is being made now.` : `${ahead} ${ahead === 1 ? 'note waits' : 'notes wait'} ahead.`} Yours waits its turn.
        </p>
      )}
      <div className="edit-f">
        <span className="edit-count tnum" data-testid="change-count">
          {n ? `${n} ${n === 1 ? 'change' : 'changes'}` : 'Nothing changed yet'}
        </span>
        {s.canUndo && (
          <Button kind="tertiary" size="small" onClick={s.undo} title={IS_MAC ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)'} data-testid="drawer-undo">
            <Icon name="undo" size={14} /> Undo
          </Button>
        )}
        <span className="spacer" />
        <Button kind="primary" disabled={!n || making} onClick={() => void make()} data-testid="make-version">
          Make Version {next}
        </Button>
      </div>

      <SkipRanges player={player} ranges={skip} />
      <SoundCues player={player} cues={cues} />
      {tab === 'captions' && captions?.enabled === false && (
        <OnPhone player={player}>
          <SafeBand />
        </OnPhone>
      )}
      {newPictures.length > 0 && (
        <OnPhone player={player}>
          {newPictures.map((p) => (
            <During key={p.id} player={player} from={p.from} to={p.to}>
              <img className="edit-picture" src={p.url} alt="" />
            </During>
          ))}
        </OnPhone>
      )}
    </section>
  )
}
