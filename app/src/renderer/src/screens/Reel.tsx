import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatAction, NoteMoment, PlacedWord, ProjectDetail, ProviderInfo, VersionInfo, VersionTimeline } from '../../../shared/api'
import { versionTitle } from '../../../shared/describe'
import { clock } from '../../../shared/progress'
import { EMPTY_LIVE, liveFromDetail, reduceLive, type LiveState } from '../../../shared/live'
import { NO_TIMELINE, noSpeech, noteMarks, noteMoment, sourceAt, wordsAt, wordsBetween, type RenderSegment } from '../../../shared/moments'
import { failedByFile, noteToRetry, notesLog, waitingRows, type LogEntry } from '../../../shared/notes-log'
import { momentToSend, notePlaceholder } from '../../../shared/composer'
import { pausedSentence, pausedWords } from '../../../shared/pause'
import type { Step } from '../../../shared/steps'
import { droppedPaths, reel, userMessage } from '../api'
import type { Go } from '../nav'
import { Button, Confirm, IS_MAC, IconButton, PickFiles, Spinner } from '../components/ui'
import { NOTIFY_ASKED, markNotifyAsked } from '../components/permissions'
import { Icon } from '../components/icons'
import { SeriesPicker } from '../components/SeriesPicker'
import { PhonePlayer } from '../components/Player'
import type { SubtitleLook } from '../../../shared/caption-presets'
import { PhoneViewSwitch, usePhoneShape, usePhoneView } from '../components/Phone'
import { FullStage } from '../components/FullStage'
import { ShapeMenu, SpeedMenu } from '../components/PreviewControls'
import { createPlayhead, usePlayhead, type Playhead } from '../components/playhead'
import { createTransport, useTransport, type Transport } from '../components/transport'
import { versionOnScreen, versionsShown } from '../components/videoLayers'
import { EXPORT_EVENT, NOTE_DROP_DONE, useNotify } from '../App'
import { ShowMeHow, type Tab } from './ShowMeHow'
import { useNoteAttachments } from '../components/NoteAttachments'
import { NotesLog, useVersionRows, type FirstState } from '../components/NotesLog'
import { Composer, region, type Chip } from '../components/Composer'
import { Timeline, type TimelineMark } from '../components/Timeline'
import { lanesOf, pictureWhy, type Lanes } from '../../../shared/lanes'
import { TIMELINE_SHORTCUT, useTimelineShown } from '../components/timelineShown'
import { keptIds } from '../../../shared/cut'
import type { SoundEffect } from '../../../shared/sfx'
import { soundPack } from './edit/SoundTab'
import { Outs } from '../components/Outs'
import { PopMenu } from '../components/PopMenu'
import { TitleBarSlot } from '../components/titlebar'
import { ConnectAI, ModelDownload } from '../components/connect'
import { PlanCard, PlanChip, PlanEmpty, PlannedStage, PlanWho, columnVideoDrop, markPlanConnect, usePlanAfterConnect } from '../components/Plan'
import { ReelsFound } from '../components/ReelsFound'
import { ChangePicture, ChangeTag, useChangeMoment } from '../components/ChangeMoments'
import { byKeyboard, reducedMotion } from '../components/motion'
import '../components/reel.css'

const ACTION_TAB: Partial<Record<ChatAction, Tab>> = {
  'open-cut': 'cut',
  'open-captions': 'captions',
  'open-music': 'music',
  'open-broll': 'broll',
  'open-cover': 'cover',
  'open-editor': 'cut'
}

const pinsKey = (slug: string): string => `rs.pins.${slug}`
/** After closing something from the keyboard, focus lands on the timeline rather than the page, or on the button that
 * shows it when it is hidden. */
const keyboardBackToTimeline = (): void => {
  if (byKeyboard())
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="timeline"], [data-testid="timeline-toggle"]')?.focus())
}
const typing = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null
  return !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
}
// How long a landed version's line keeps its entering state, so a re-render soon after does not replay it.
const LANDED_MS = 1500
// The landing crossfade (reel.css, 200 ms) stays armed until the new version is on screen, plus the fade.
const FADE_DONE_MS = 300
// Within this many seconds of the end, a pause is the video ending, not the person stopping on a moment.
const END_SLACK = 0.3

/** A spot someone pointed at on the picture, kept on this computer with its note. */
interface Pin {
  n: number
  at: number
  x: number
  y: number
  text: string
}

/**
 * The reel: the video at full height on the stage with its timeline and transport under it, and the notes for the
 * editor in a column on the right. Version 1 is made here, a reel with no video is planned here, and Edit it myself
 * takes the column's place.
 */
export function Reel({ slug, at, go }: { slug: string; at?: number; go: Go }) {
  const notify = useNotify()
  const [d, setD] = useState<ProjectDetail | null>(null)
  // `at`: the version to show first; the newest when it's gone or not given (line ~234 keeps a version that exists)
  const [selected, setSelected] = useState<number | null>(at ?? null)
  // A version picked to watch plays with sound. The player clears the request once it has started.
  const [playRequest, setPlayRequest] = useState<{ n: number; ask: number } | null>(null)
  const playAsks = useRef(0)
  // The running job, folded from its events (shared/live.ts). null = nothing running.
  const [job, setJob] = useState<LiveState | null>(null)
  const [firstSteps, setFirstSteps] = useState<Step[] | null>(null)
  const [heard, setHeard] = useState<string[]>([])
  // what a note's job has said it was doing, in order, for Steps
  const [steps, setSteps] = useState<string[]>([])
  const [drawer, setDrawer] = useState<Tab | null>(null)
  // while Edit it myself is open: the lanes as its changes make them, and the sound or picture picked there or on
  // the timeline
  const [editLanes, setEditLanes] = useState<Lanes | null>(null)
  const [sound, setSound] = useState<string | null>(null)
  const [reveal, setReveal] = useState(0)
  const [picture, setPicture] = useState<string | null>(null)
  const [pictureReveal, setPictureReveal] = useState(0)
  // each sound's onset and length, so the timeline hollows the flags that won't play as the Sound tab does
  const [pack, setPack] = useState<Map<string, SoundEffect>>(() => new Map())
  useEffect(() => {
    soundPack().then((p) => setPack(new Map(p.map((x) => [x.id, x]))), () => undefined)
  }, [])
  // the waiting hand edit Edit it myself is changing (its Edit in the log), or null for a new one
  const [handId, setHandId] = useState<string | null>(null)
  const [stage, setStage] = useState<HTMLElement | null>(null)
  const [stageBox, setStageBox] = useState<HTMLElement | null>(null)
  usePhoneWidth(stageBox)
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  const [providerChecked, setProviderChecked] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [pickingSeries, setPickingSeries] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [more, setMore] = useState(false)
  const moreBtn = useRef<HTMLButtonElement>(null)
  const [phoneView, setPhoneView] = usePhoneView()
  const [timelineShown, setTimelineShown] = useTimelineShown()
  const [shape] = usePhoneShape()
  const [full, setFull] = useState(false)
  const [holding, setHolding] = useState(false)
  const [warmOriginal, setWarmOriginal] = useState(false)
  const [preview, setPreview] = useState<{ look: SubtitleLook; text: string; at: number } | null>(null)
  const [compare, setCompare] = useState<{ a: number; b: number } | null>(null)
  const [landed, setLanded] = useState<number | null>(null)
  const [unwatched, setUnwatched] = useState<number | null>(null)
  // the version whose arrival crosses over the one on screen
  const [landing, setLanding] = useState<number | null>(null)
  const [pointing, setPointing] = useState(false)
  const [pins, setPins] = useState<Pin[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(pinsKey(slug)) ?? '[]') as Pin[]
    } catch {
      return []
    }
  })
  const [playhead] = useState(createPlayhead)
  const [transport] = useState(createTransport)
  const { duration, playing } = useTransport(transport)
  const player = useMemo(
    () => ({
      playhead,
      seek: (t: number, play?: boolean) => {
        transport.seek(t)
        if (play && !transport.get().playing) transport.toggle()
      },
      playing: () => transport.get().playing,
      stage
    }),
    [playhead, transport, stage]
  )
  // The person stopped on a moment (paused, scrubbed or pressed C) and hasn't played on or sent a note since: while
  // the video stays paused there, the note box attaches that moment by itself (Sam, D21 T20:14 #7).
  const [stoppedOn, setStoppedOn] = useState(false)
  // A pause anywhere but the very end, or the playhead moving while paused (a scrub, an arrow key, a click on the
  // timeline), counts as stopping on a moment; playing on leaves it, so a video that later ends by itself attaches
  // nothing.
  useEffect(() => {
    let was = transport.get().playing
    let at = playhead.get()
    const offT = transport.subscribe(() => {
      const now = transport.get()
      if (was && !now.playing && playhead.get() < now.duration - END_SLACK) setStoppedOn(true)
      else if (!was && now.playing) setStoppedOn(false)
      if (!now.playing) at = playhead.get()
      was = now.playing
    })
    // the playhead moves every frame while playing: only a move while paused is looked at
    const offP = playhead.subscribe(() => {
      if (was) return
      const t = playhead.get()
      if (Math.abs(t - at) > 0.05) setStoppedOn(true)
      at = t
    })
    return () => {
      offT()
      offP()
    }
  }, [transport, playhead])
  const [shownSrc, setShownSrc] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [chip, setChip] = useState<Chip>(null)
  const [alert, setAlert] = useState<string | null>(null)
  const [notifyAsk, setNotifyAsk] = useState(false)
  const noteField = useRef<HTMLTextAreaElement>(null)
  const [answerError, setAnswerError] = useState<{ id: string; text: string } | null>(null)
  // the look for more reels started on this screen: its card enters when it arrives
  const [askedReels, setAskedReels] = useState<string | null>(null)
  const att = useNoteAttachments(slug, notify)
  // Files dropped on the note box before the editor check answers: attached once it does, as any drop is.
  const heldDrops = useRef<{ files: File[]; types: string[] }[]>([])
  const [heldN, setHeldN] = useState(0)
  useEffect(() => {
    if (!providerChecked || !heldDrops.current.length) return
    for (const drop of heldDrops.current) att.onDropFiles(drop)
    heldDrops.current = []
    setHeldN(0)
  }, [providerChecked, att.onDropFiles])
  const versionRows = useVersionRows(slug)
  const lastJob = useRef<string | null>(null)
  const nowStep = useRef(-1)
  // read in the job listener, which is set up once
  const watching = useRef({ compare: false, drawer: false })
  watching.current = { compare: !!compare, drawer: !!drawer }

  // Reads overlap (a job's first status and its end each ask): only the newest read may land, and a read
  // that asked to show the newest version passes that on to whichever read lands.
  const loads = useRef(0)
  const wantLatest = useRef(false)
  const load = useCallback(
    async (selectLatest = false) => {
      const n = ++loads.current
      if (selectLatest) wantLatest.current = true
      try {
        const got = await reel.projects.get(slug)
        if (n !== loads.current) return null
        // a preview is a first look until the first edit is done, and the reel's version during any other job
        const next = { ...got, versions: versionsShown(got) }
        selectLatest = wantLatest.current
        wantLatest.current = false
        setD(next)
        if (next.job) {
          setJob((cur) => (cur?.jobId === next.job!.id ? cur : liveFromDetail(next.job!)))
          if (next.job.steps) setFirstSteps(next.job.steps)
        } else setJob(null)
        if (next.words.length) setHeard((h) => (h.length ? h : next.words.map((w) => w.w)))
        const latest = next.versions[next.versions.length - 1]?.n ?? null
        setSelected((cur) => (selectLatest || cur === null || !next.versions.some((v) => v.n === cur) ? latest : cur))
        return next
      } catch (e) {
        if (n !== loads.current) return null
        notify(userMessage(e), 'error')
        go({ name: 'home' })
        return null
      }
    },
    [slug, go, notify]
  )

  const play = useCallback((n: number) => setPlayRequest({ n, ask: ++playAsks.current }), [])

  /** A version landed: it takes the screen and plays, unless the person is comparing or editing by hand. */
  const land = useCallback(
    async (n: number | undefined) => {
      const busyElsewhere = watching.current.compare || watching.current.drawer
      const next = await load(!busyElsewhere)
      const v = n ?? next?.versions[next.versions.length - 1]?.n
      if (v === undefined) return
      setLanded(v)
      window.setTimeout(() => setLanded((l) => (l === v ? null : l)), LANDED_MS)
      if (busyElsewhere) return setUnwatched(v)
      if (!byKeyboard() && !reducedMotion()) {
        setLanding(v)
        // a version that never takes the screen (it was already on it) must not leave the crossfade armed
        window.setTimeout(() => setLanding((l) => (l === v ? null : l)), 10_000)
      }
      play(v)
    },
    [load, play]
  )

  // a New reel left untouched goes (main/store.ts isUntouchedPlanned), but not while Choose your editor is open on top
  // of it: that screen comes back here
  const toConnect = useRef(false)
  useEffect(() => () => void (toConnect.current || reel.projects.leave(slug).catch(() => {})), [slug])

  useEffect(() => {
    // opened at a version (from Insights): keep it rather than jump to the newest
    void load(at === undefined)
    reel.ai
      .active()
      .then(setProvider)
      .catch(() => {})
      .finally(() => setProviderChecked(true))
    const offAi = reel.ai.onChange(setProvider)
    const offQueue = reel.queue.onChange((s) => s === slug && void load())
    const offJobs = reel.jobs.onEvent((e) => {
      if (e.slug !== slug) return
      // a waiting note just started: its words move from the queue into the notes
      if (e.type === 'status' && lastJob.current !== e.jobId) {
        lastJob.current = e.jobId
        nowStep.current = -1
        void load()
      }
      if (e.type === 'status' || e.type === 'reply' || e.type === 'tool' || e.type === 'moment') setJob((cur) => reduceLive(cur ?? EMPTY_LIVE, e))
      if (e.type === 'status' && e.steps) {
        setFirstSteps(e.steps)
        // a new step: the copy, then the transcript, are on disk now
        const at = e.steps.findIndex((s) => s.state === 'now')
        if (at !== nowStep.current) {
          nowStep.current = at
          void load()
        }
      } else if (e.type === 'heard') setHeard(e.words)
      else if (e.type === 'render' && e.draft) {
        setJob((cur) => reduceLive(cur ?? EMPTY_LIVE, e))
        void load()
      } else if (e.type === 'done') {
        setJob(null)
        setFirstSteps(null)
        // an export or a script ends with no new version
        void (e.version === undefined ? load() : land(e.version))
      } else if (e.type === 'error' || e.type === 'cancelled' || e.type === 'paused') {
        setJob(null)
        setFirstSteps(null)
        void load()
      }
    })
    return () => {
      offAi()
      offQueue()
      offJobs()
    }
  }, [slug, load, land])

  useEffect(() => {
    if (!job?.jobId) {
      setSteps([])
      return
    }
    const m = job.message
    if (m === EMPTY_LIVE.message) return
    setSteps((s) => (s[s.length - 1] === m ? s : [...s, m]))
  }, [job?.jobId, job?.message])

  const firstEditRunning = d?.job?.kind === 'first-edit'
  useEffect(() => {
    if (!firstEditRunning || localStorage.getItem(NOTIFY_ASKED)) return
    let live = true
    reel.perm
      .status()
      .then((s) => live && setNotifyAsk(s.notifications === 'off'))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [firstEditRunning])

  const version = d ? (d.versions.find((v) => v.n === selected) ?? d.versions[d.versions.length - 1]) : undefined
  const changePreview = job?.preview && d?.versions.length ? job.preview.video : null
  // A running job's pictures of the change it is making, before its draft (none while comparing or in Edit it
  // myself, where a preview waits too).
  const change = useChangeMoment(job && !compare && !drawer ? job.moments : null, job?.jobId ?? null)
  // a job's runs count from 1, so a run is named by its job too
  const changeRun = change.index >= 0 && job ? `${job.jobId}:${change.list[0].run}` : null
  // the run the person played the reel over: its pictures step aside for the reel until a newer run's arrive
  const [playedOver, setPlayedOver] = useState<string | null>(null)
  const runNow = useRef(changeRun)
  runNow.current = changeRun
  useEffect(() => {
    let was = transport.get().playing
    return transport.subscribe(() => {
      const now = transport.get().playing
      if (now && !was && runNow.current !== null) setPlayedOver(runNow.current)
      was = now
    })
  }, [transport])
  // a new run's pictures take the phone: a playing reel stops under them, so its sound does not go on behind a still
  useEffect(() => {
    if (changeRun !== null && transport.get().playing) transport.toggle()
  }, [changeRun, transport])
  const [timeline, setTimeline] = useState<{ video: string; words: PlacedWord[]; segments: RenderSegment[] | null; version: VersionTimeline | null } | null>(null)
  const onScreen = d ? versionOnScreen(d.versions, shownSrc) : null
  const shownN = onScreen?.n
  const shownVideo = onScreen?.video
  useEffect(() => {
    if (shownN === undefined || !shownVideo) return
    let live = true
    reel.projects
      .timeline(slug, shownN)
      .then((t) => {
        if (live) setTimeline({ video: shownVideo, words: t?.words ?? [], segments: t?.segments ?? null, version: t })
      })
      .catch((e) => {
        if (live) setTimeline({ video: shownVideo, words: [], segments: null, version: null })
        notify(userMessage(e), 'error')
      })
    return () => {
      live = false
    }
  }, [slug, shownN, shownVideo, notify])

  const latestN = d?.versions[d.versions.length - 1]?.n
  const older = version && version.n !== latestN ? version : null

  const aiOff = providerChecked && (!provider || !provider.connected || provider.id === 'none')
  const canPoint = !!version && !aiOff && !compare && !drawer && !full

  // Hold O for the original; C points at a spot; Esc stops pointing, then comparing.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector('.modal-backdrop')) return
      const k = e.key.toLowerCase()
      if (k === 'o' && !e.repeat) setHolding(true)
      else if (k === 'c' && !e.repeat && canPoint) (setStoppedOn(true), setPointing((p) => !p))
      else if (e.key === 'Escape' && pointing) (setPointing(false), keyboardBackToTimeline())
      else if (e.key === 'Escape' && compare) (setCompare(null), keyboardBackToTimeline())
      else return
      e.preventDefault()
    }
    const up = (e: KeyboardEvent) => e.key.toLowerCase() === 'o' && setHolding(false)
    const away = () => setHolding(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', away)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', away)
    }
  }, [canPoint, pointing, compare])

  const entries = useMemo(
    () =>
      d
        ? notesLog({
            chat: d.chat,
            made: d.versionsMade,
            versions: d.versions,
            running: d.job
              ? d.job.kind === 'export' || d.job.kind === 'propose'
                ? null
                : { id: d.job.id, kind: d.job.kind === 'rerender' ? 'hand' : d.job.kind === 'first-edit' ? 'first-edit' : d.job.kind === 'script' ? 'script' : 'note' }
              : null,
            planned: d.status === 'planned',
            plan: d.plan,
            source: d.project.sources?.[0] ?? null,
            now: new Date()
          })
        : [],
    [d]
  )

  const marks = useMemo((): TimelineMark[] => {
    if (!d || !timeline || timeline.video !== shownVideo) return []
    const made = new Map(entries.flatMap((e) => (e.result?.kind === 'version' ? [[e.key, e.result.v] as const] : [])))
    const out: TimelineMark[] = noteMarks(d.chat, job?.jobId ?? null, timeline.words)
      .filter((m) => m.state === 'making' || (m.state === 'done' && made.has(m.id)))
      .map((m) => ({ id: m.id, at: m.at, text: m.text, ...(m.state === 'done' ? { v: made.get(m.id) } : {}) }))
    for (const q of d.queue) if (!q.attempt && q.moment && q.moment.version === shownN) out.push({ id: q.id, at: q.moment.at, text: q.text })
    return out
  }, [d, timeline, shownVideo, shownN, entries, job?.jobId])

  // The lanes of the version on screen, from its own project and render: worked out again only when either changes.
  const shownLanes = useMemo((): Lanes | null => {
    const v = timeline?.version
    if (!d || !v || timeline.video !== shownVideo || shownN === undefined) return null
    const why = (id: string) => pictureWhy(id, d.versions, d.project.notes ?? [], shownN)
    const kept = new Set(keptIds(d.words, v.project.cut?.keep))
    const thumb = (b: { id: string }) => d.brollThumbs[b.id] ?? null
    return lanesOf(v.project, { placed: v.words, segments: v.segments, words: d.words, kept, duration: v.duration, layers: new Map(v.layers.map((l) => [l.id!, l])) }, pack, why, thumb)
  }, [timeline, shownVideo, shownN, d?.versions, d?.project.notes, d?.words, d?.brollThumbs, pack]) // eslint-disable-line react-hooks/exhaustive-deps

  usePlanAfterConnect(slug, providerChecked && !!d, d?.status === 'planned' && !aiOff, noteField)

  // a planning turn holds the send button; whatever the box said while it ran is stale once the editor answers
  const planAnswering = d?.status === 'planned' && !!job
  const wasAnswering = useRef(false)
  useEffect(() => {
    if (wasAnswering.current && !planAnswering) setAlert(null)
    wasAnswering.current = planAnswering
  }, [planAnswering])

  if (!d)
    return (
      <div className="page">
        <Spinner />
      </div>
    )

  const planned = d.status === 'planned'
  const hasVersions = d.versions.length > 0
  const computer = IS_MAC ? 'Mac' : 'PC'
  // paused without you (shared/pause.ts): why, and when it goes on by itself
  const pausedWhy = d.pausedFor ? pausedSentence(d.pausedFor, new Date(), computer) : null
  const heldWords = d.pausedFor ? pausedWords(d.pausedFor, new Date(), computer) : null
  const heldWhy = heldWords && heldWords[0].toLowerCase() + heldWords.slice(1)
  const connect = () => {
    toConnect.current = true
    go({ name: 'connect', back: { name: 'reel', slug } })
  }
  const making = job && d.job && d.job.kind !== 'export' && d.job.kind !== 'script' && d.job.kind !== 'propose' ? (latestN ?? 0) + 1 : null
  const first: FirstState | null =
    hasVersions || planned
      ? null
      : d.job?.kind === 'first-edit' || d.status === 'new'
        ? { kind: 'making', heard: firstSteps?.some((s) => s.id === 'listen' && s.state === 'done') ? heard : [], editor: !aiOff }
        : d.status === 'failed'
          ? {
              kind: 'failed',
              why: d.lastError?.userMessage ?? 'This version could not be made.',
              extra: d.lastError?.code === 'MODEL_MISSING' ? <ModelDownload secondary /> : undefined,
              // the file itself, or a video that was never copied in: trying again fails the same way. With no copy the
              // stage says so with the primary button, and the log's is secondary.
              another: failedByFile(d.lastError?.code) || !d.sourceVideo ? (d.sourceVideo ? 'primary' : 'secondary') : undefined
            }
          : { kind: 'paused', why: pausedWhy }
  const firstLook = first?.kind === 'making' ? (job?.preview?.video ?? null) : null
  // the moment attached by itself: the person stopped on it, and the video is still there
  const autoMoment = stoppedOn && !playing && hasVersions && !chip

  const note = async (text: string, files: string[] | undefined, moment: NoteMoment | undefined) => {
    const r = await reel.projects.note(slug, text, files, moment, version?.n)
    if (r.jobId) setJob((cur) => (cur?.jobId === r.jobId ? cur : { ...EMPTY_LIVE, jobId: r.jobId, message: 'Reading your note' }))
    await load()
  }

  /** The words on screen at the chip's moment or range in the version shown, or why a note can't point there. */
  const momentFor = async (c: NonNullable<Chip>): Promise<NoteMoment | string> => {
    const n = onScreen?.n ?? version?.n
    const tl = n !== undefined ? await reel.projects.timeline(slug, n).catch(() => null) : null
    if (!tl || n === undefined) return NO_TIMELINE
    if (c.at > tl.duration) return `There's no ${clock(c.at)} in this reel. It's ${clock(tl.duration)} long.`
    const words = c.to !== undefined ? wordsBetween(tl.words, c.at, c.to) : wordsAt(tl.words, c.at)
    return words.length ? noteMoment(c.at, n, words, c.to) : noSpeech(c.at)
  }

  const send = async () => {
    const text = draft.trim()
    const files = att.chips
    if ((!text && !files.length) || att.busy || !providerChecked) return
    setAlert(null)
    if (planned) {
      setDraft('')
      try {
        const r = await reel.projects.planSay(slug, text)
        setJob({ ...EMPTY_LIVE, jobId: r.jobId, message: 'Planning your reel' })
        await load()
      } catch (e) {
        setDraft(text)
        setAlert(userMessage(e))
      }
      return
    }
    // the moment set by hand, the one attached by itself, or the playhead for a note that says "here"
    let moment: NoteMoment | undefined
    const pointed = momentToSend(chip, { auto: autoMoment, text, at: playhead.get() })
    if (pointed) {
      const m = await momentFor(pointed)
      // a moment the person can see in the box is checked; "here" with no words playing goes about the whole reel
      if (typeof m === 'string' && (chip || autoMoment)) return setAlert(m)
      if (typeof m !== 'string') moment = m
    }
    const spot = chip?.spot
    // the editor reads where the spot is in words; the note says it the way a person would
    const where = spot && (region(spot.x, spot.y) === 'the middle' ? 'in the middle of the picture' : `at the ${region(spot.x, spot.y)} of the picture`)
    const words = where ? `${(text || 'Change this').replace(/[.!?]+$/, '')}, ${where}.` : text
    setDraft('')
    setChip(null)
    setStoppedOn(false)
    att.clear()
    try {
      await note(words || 'Put this here', files.length ? files.map((f) => f.asset) : undefined, moment)
      if (spot && chip) {
        const next = [...pins, { n: spot.n, at: chip.at, x: spot.x, y: spot.y, text: text || 'Change this' }]
        localStorage.setItem(pinsKey(slug), JSON.stringify(next))
        setPins(next)
      }
    } catch (e) {
      setDraft(text)
      setChip(chip)
      att.restore(files)
      setAlert(userMessage(e))
    }
  }

  const retry = (e: LogEntry) => {
    if (e.ask.kind !== 'note') return
    // a note that didn't finish waits at the head of the queue, with its moment and files: run it again
    const kept = d.queue.some((q) => q.id === e.key)
    let text: string
    try {
      text = noteToRetry(d.chat, e.key)
    } catch (err) {
      setAlert(userMessage(err))
      return
    }
    const r = planned
      ? reel.projects.planSay(slug, text).then(() => load())
      : kept
        ? reel.queue.runNext(slug)
        : note(text, undefined, e.ask.moment ?? undefined)
    void r.catch((err) => setAlert(userMessage(err)))
  }

  const rename = async () => {
    const t = (renaming ?? '').trim()
    setRenaming(null)
    if (!t || t === d.title) return
    try {
      await reel.projects.update(slug, { title: t })
      await load()
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  const resume = async (basic = false) => {
    try {
      const r = await reel.projects.resume(slug, basic)
      setJob({ ...EMPTY_LIVE, jobId: r.jobId })
      await load()
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  const addVideo = async (paths: string[]) => {
    try {
      const r = await reel.projects.addVideo(slug, paths)
      // a video chosen after Version 1 failed starts over: nothing heard from the last one stays
      setHeard([])
      setJob({ ...EMPTY_LIVE, jobId: r.jobId, message: 'Copying your video' })
      await load()
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  // More reels from this video: a proposal already found opens again; otherwise the editor looks (a job)
  const oneVideo = d.project.sources?.length === 1
  // the card waits while the editor looks again, from the moment it is asked
  const looking = d.job?.kind === 'propose' || (!!job && job.jobId === askedReels)
  const findReels = async (again = false) => {
    try {
      if (d.proposal && !again) {
        if (d.proposal.folded) await reel.projects.foldReels(slug, false)
        await load()
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="reels-found"] :is(input, button):not(:disabled)')?.focus())
        return
      }
      const r = await reel.projects.proposeReels(slug)
      setAskedReels(r.jobId)
      setJob({ ...EMPTY_LIVE, jobId: r.jobId, message: 'Finding the reels in your video' })
      await load()
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }
  const openReel = (child: string) =>
    void reel.projects.get(child).then(() => go({ name: 'reel', slug: child }), (e) => notify(userMessage(e), 'error'))

  const savePost = async (text: string): Promise<boolean> => {
    const caption = text.trim()
    if (caption === (d.project.post?.caption ?? '').trim()) return true
    try {
      await reel.projects.update(slug, { post: { keywords: [], ...(d.project.post ?? {}), caption, hashtags: [] } })
      await load()
      return true
    } catch (e) {
      notify(userMessage(e), 'error')
      return false
    }
  }

  const originalReady = !shownVideo || timeline?.video === shownVideo
  const originalAt = (t: number) => {
    if (!shownVideo) return 'start' as const
    if (timeline?.video !== shownVideo) return null
    if (!timeline.segments) return 'start' as const
    const at = sourceAt(timeline.segments, t)
    const src = at && d.sourceVideos[at.source]
    return src ? { src, at: at.at } : null
  }

  const runAction = (a: ChatAction, messageId: string) => {
    if (a === 'remember-yes' || a === 'remember-no') {
      reel.style
        .answer(slug, messageId, a === 'remember-yes')
        .then(async () => {
          setAnswerError(null)
          await load()
          // the buttons are gone: keep focus on the answered question, not lost to the page
          document.getElementById(`msg-${messageId}`)?.focus()
        })
        .catch((e) => setAnswerError({ id: messageId, text: userMessage(e) }))
    } else if (a === 'connect') connect()
    else if (a === 'open-post') window.dispatchEvent(new Event(EXPORT_EVENT))
    else openDrawer(ACTION_TAB[a] ?? 'cut')
  }
  // "Edit it myself" changes the newest version: with an older one on screen, show the newest first.
  const openDrawer = (t: Tab, hand: string | null = null) => {
    if (older && latestN !== undefined) setSelected(latestN)
    setCompare(null)
    setPointing(false)
    setHandId(hand)
    setDrawer(t)
  }
  const watch = (n: number) => {
    setCompare(null)
    setSelected(n)
    if (unwatched === n) setUnwatched(null)
    if (!changePreview) play(n)
  }
  const startCompare = (b: number) => {
    const i = d.versions.findIndex((v) => v.n === b)
    if (i < 1) return
    setPointing(false)
    setCompare({ a: d.versions[i - 1].n, b })
    setSelected(b)
  }

  // Share's own work (a preview made full quality, other platforms) shows on the Share button, not in the note box
  const shareWork = d.job?.kind === 'export' && d.job.id === job?.jobId
  // comparing and Edit it myself stay on the versions they show; a running job's preview waits (B section 5, step 3)
  const jobPreview = compare || drawer ? null : changePreview
  const src = planned ? null : hasVersions ? (jobPreview ?? version?.video ?? null) : (firstLook ?? d.sourceVideo)
  // before its draft, the pictures of the change take the phone (ChangeMoments.tsx), until the person plays the reel
  const changing = changeRun !== null && playedOver !== changeRun
  const tag = changing ? null : jobPreview ? 'Quick preview' : !hasVersions && !planned && src ? (firstLook ? 'First look' : 'Original') : null
  // the strip counts only notes still waiting: one that stopped or failed is its own line in the log, with Send again
  const held = d.queueHeld ? waitingRows(d.queue, entries).length : 0
  const nextSpot = Math.max(0, ...pins.map((p) => p.n)) + 1
  const lastResult = entries[entries.length - 1]?.result?.kind
  const placeholder = notePlaceholder({
    planned,
    hasPlan: !!d.plan,
    answering: planAnswering,
    asking: lastResult === 'question',
    hasVersions,
    making: making !== null,
    busy: !!job
  })
  const showComposer = (planned && !aiOff) || hasVersions || first?.kind === 'making'
  const planCard = d.plan && (
    <PlanCard
      slug={slug}
      title={d.title}
      plan={d.plan}
      folded={!planned}
      busy={d.job?.kind === 'script'}
      onSaved={() => void load()}
      onCopy={(t) => void reel.app.copyText(t).then(() => notify('Copied.'))}
      onError={(m) => notify(m, 'error')}
    />
  )

  // A version's name: the AI's rewording when it passed the check against what changed, else the app's own (#60).
  const nameOf = (v: VersionInfo): string => v.wording?.title ?? (v.facts ? versionTitle(v.facts, d.words) : '')
  const tagged = onScreen ?? version
  const taggedName = tagged ? nameOf(tagged) : ''

  const title = (
    <span className="rt-title">
      {renaming === null ? (
        <h1
          className="tb-h reel-title"
          title="Click to rename"
          role="button"
          tabIndex={0}
          onClick={() => setRenaming(d.title)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setRenaming(d.title))}
          data-testid="title"
        >
          {d.title}
        </h1>
      ) : (
        <input
          className="input reel-title-input"
          autoFocus
          value={renaming}
          aria-label="Reel name"
          onChange={(e) => setRenaming(e.target.value)}
          onBlur={() => void rename()}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void rename()
            if (e.key === 'Escape') setRenaming(null)
          }}
          data-testid="title-input"
        />
      )}
      {tagged && (
        <span className={`rt-ver${older ? ' older' : ''}`} data-testid="version-on-screen">
          Version {tagged.n}
        </span>
      )}
      {taggedName && (
        <span className="rt-ver-name" title={taggedName} data-testid="version-title">
          {taggedName}
        </span>
      )}
      {older && !compare && (
        <Button kind="tertiary" size="small" onClick={() => watch(latestN!)} data-testid="version-latest">
          Back to latest
        </Button>
      )}
    </span>
  )

  const actions = (
    <>
      {hasVersions && (
        <Button kind="tertiary" className={drawer ? 'on' : undefined} aria-pressed={!!drawer} onClick={() => (drawer ? (setDrawer(null), setHandId(null), setPreview(null), setSound(null), setPicture(null)) : openDrawer('cut'))} data-testid="edit-myself">
          <Icon name="sliders" size={16} /> Edit it myself
        </Button>
      )}
      {hasVersions && (
        <Outs
          slug={slug}
          title={d.title}
          version={version}
          post={d.project.post}
          disabled={!version || (!!job && !shareWork)}
          quiet={!!compare || !!drawer || aiOff}
          why={job ? (d.job?.kind === 'propose' ? 'Wait for your editor to finish looking.' : 'Wait for this version to finish.') : undefined}
          onSaveCaption={savePost}
        />
      )}
      <span className="rt-more">
        <button
          ref={moreBtn}
          className="icon-btn"
          aria-label="More for this reel"
          aria-haspopup="menu"
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
          data-testid="more"
        >
          <Icon name="more" />
        </button>
        <PopMenu open={more} onClose={() => setMore(false)} anchor={moreBtn} label="More for this reel" style={{ right: 0, top: 'calc(100% + 6px)', width: 244 }} origin="top right">
          <button className="mi" role="menuitem" onClick={() => (setMore(false), setRenaming(d.title))} data-testid="rename">
            <Icon name="pencil" size={16} /> Rename
          </button>
          <button
            className="mi"
            role="menuitem"
            disabled={!hasVersions || !oneVideo || !!job}
            title={!hasVersions ? 'Wait for Version 1.' : !oneVideo ? 'This works on a reel made from one video.' : job ? 'Wait for this to finish.' : undefined}
            onClick={() => (setMore(false), void findReels())}
            data-testid="more-reels"
          >
            <Icon name="scissors" size={16} /> More reels from this video
          </button>
          <button
            className="mi"
            role="menuitem"
            disabled={!hasVersions}
            title={!hasVersions ? 'Wait for Version 1.' : undefined}
            onClick={() => (setMore(false), setPickingSeries(true))}
            data-testid="series"
          >
            <Icon name="folder" size={16} /> {d.series ? `Series: ${d.series}` : 'Series…'}
          </button>
          <button className="mi danger" role="menuitem" disabled={!!job} onClick={() => (setMore(false), setConfirmDelete(true))} data-testid="delete">
            <Icon name="trash" size={16} /> Delete…
          </button>
        </PopMenu>
      </span>
    </>
  )

  const over = (
    <div className="reel-over">
      {drawer && <div className="edit-stage" ref={setStage} />}
      {changing && <ChangeTag {...change} />}
      {tag && (
        <span className="reel-tag" data-testid={jobPreview ? 'change-preview' : 'first-tag'}>
          {tag}
        </span>
      )}
      {compare && (
        <div className="cmp" role="group" aria-label="Compare versions" data-testid="compare">
          <div className="abswitch">
            {[compare.a, compare.b].map((n) => (
              <button key={n} className={selected === n ? 'on' : undefined} aria-pressed={selected === n} onClick={() => setSelected(n)} data-testid={`compare-pick-${n}`}>
                Version {n}
              </button>
            ))}
          </div>
          <button className="cmp-done" onClick={() => (setCompare(null), keyboardBackToTimeline())} data-testid="done-compare">
            Done comparing
          </button>
        </div>
      )}
      {!compare && <Spots pins={pins} playhead={playhead} />}
      {chip?.spot && (
        <span className="spot pending" style={{ left: `${chip.spot.x * 100}%`, top: `${chip.spot.y * 100}%` }} aria-hidden>
          {chip.spot.n}
        </span>
      )}
      {pointing && (
        <Pointer
          playhead={playhead}
          onCancel={() => (setPointing(false), keyboardBackToTimeline())}
          onDrop={(x, y) => {
            if (transport.get().playing) transport.toggle()
            setPointing(false)
            setChip({ at: Math.floor(playhead.get()), spot: { x, y, n: nextSpot } })
            noteField.current?.focus()
          }}
        />
      )}
    </div>
  )

  // Comparing shows the reel without Instagram's header and buttons: the switch sits on the top edge of the picture,
  // and at 1100 × 720 the full-height phone leaves no room above it. The person's own view comes back on Done.
  const shownView = compare ? 'clean' : phoneView
  const viewSwitch = compare ? (
    <span className="view-held" data-testid="phone-view-held">
      <span inert>
        <PhoneViewSwitch value={shownView} onChange={() => undefined} />
      </span>
      <span className="sr-only">Comparing shows the reel without Instagram. Your view comes back on Done comparing.</span>
    </span>
  ) : (
    <PhoneViewSwitch value={phoneView} onChange={(v) => void setPhoneView(v).catch((e) => notify(userMessage(e), 'error'))} />
  )

  return (
    <div className="reel-page" data-slug={slug}>
      <TitleBarSlot title={title} actions={actions} />
      <div className="reel-b">
        <section ref={setStageBox} className="stage" aria-label="Video" data-toast-column onPointerEnter={() => setWarmOriginal(true)}>
          {planned ? (
            <PlannedStage plan={planCard} onFiles={(p) => void addVideo(p)} />
          ) : (
            <>
              <FullStage open={full} onOpenChange={(o) => (setPointing(false), setFull(o))} enabled={!!src} shape={shape} transport={transport} playhead={playhead} view={viewSwitch}>
                <PhonePlayer
                  src={src}
                  poster={hasVersions ? version?.cover : null}
                  className={[landing !== null && 'landing', tag === 'Original' && d.project.sources?.[0]?.mirror === true && 'mirrored-original'].filter(Boolean).join(' ') || undefined}
                  autoPlayMuted={!!changePreview || !hasVersions}
                  playRequest={!changePreview && playRequest?.n === version?.n ? playRequest?.ask : undefined}
                  onPlayRequestHandled={() => setPlayRequest(null)}
                  subtitle={drawer && preview ? preview : null}
                  still={drawer && preview && d.sourceVideo ? `${d.sourceVideo}#t=${preview.at.toFixed(2)}` : null}
                  stillMirrored={d.project.sources?.[0]?.mirror === true}
                  view={shownView}
                  caption={d.project.post?.caption}
                  original={hasVersions ? d.sourceVideo : null}
                  originalAt={originalAt}
                  originalReady={originalReady}
                  warmOriginal={warmOriginal}
                  holdingOriginal={holding}
                  onHold={hasVersions && d.sourceVideo ? setHolding : undefined}
                  dragFile={version && !version.draft ? version.videoPath : null}
                  playhead={playhead}
                  transport={transport}
                  shape={shape}
                  bare
                  onShown={(shown) => {
                    setShownSrc(shown)
                    if (landing !== null && shown && shown === d.versions.find((v) => v.n === landing)?.video)
                      window.setTimeout(() => setLanding((l) => (l === landing ? null : l)), FADE_DONE_MS)
                  }}
                  keepTime={!!compare || !!drawer}
                  onFailed={() => {
                    notify('That version could not be found. It may have been moved or deleted.', 'error')
                    if (onScreen) setSelected(onScreen.n)
                  }}
                  change={changing ? <ChangePicture list={change.list} index={change.index} /> : null}
                  over={over}
                >
                  {first?.kind === 'failed' ? (
                    <FailedStage why={first.why} onFiles={(p) => void addVideo(p)} />
                  ) : (
                    <div className="phone-empty" data-testid="copying">
                      <Spinner /> Copying your video
                    </div>
                  )}
                </PhonePlayer>
              </FullStage>
              {src && (
                <>
                  {timelineShown && <Timeline
                    playhead={playhead}
                    transport={transport}
                    duration={duration}
                    words={timeline && timeline.video === shownVideo ? timeline.words : []}
                    marks={drawer ? [] : marks}
                    lanes={drawer ? editLanes : shownLanes}
                    selectedSound={sound}
                    onSound={(k) => {
                      setSound(k)
                      setReveal((n) => n + 1)
                      if (!drawer) openDrawer('music')
                    }}
                    selectedPicture={picture}
                    onPicture={(id) => {
                      setPicture(id)
                      setPictureReveal((n) => n + 1)
                      if (!drawer) openDrawer('broll')
                    }}
                    onRange={(r) => {
                      if (!hasVersions || aiOff) return
                      setChip(r)
                      // from the keyboard the range keeps growing with Shift and the arrows, so focus stays put
                      if (!byKeyboard()) noteField.current?.focus()
                    }}
                    onPlay={(n) => !drawer && watch(n)}
                  />}
                  <TransportRow transport={transport} playhead={playhead}>
                    <ShapeMenu />
                    {viewSwitch}
                    <IconButton
                      icon="timeline"
                      label="Show timeline"
                      shortcut={TIMELINE_SHORTCUT}
                      className="tl-toggle"
                      aria-pressed={timelineShown}
                      onClick={() => void setTimelineShown(!timelineShown).catch((e) => notify(userMessage(e), 'error'))}
                      data-testid="timeline-toggle"
                    />
                    <IconButton icon="fullscreen" label="Full screen" shortcut="F" aria-keyshortcuts="F" onClick={() => setFull(true)} data-testid="full-screen" />
                  </TransportRow>
                </>
              )}
            </>
          )}
        </section>

        <div className={`ncol${planned && !drawer ? ' planning' : ''}`} {...(planned && !drawer && columnVideoDrop((p) => void addVideo(p)))}>
          {drawer ? (
            <ShowMeHow
              key={handId ?? 'new'}
              d={d}
              initialTab={drawer}
              version={version ?? null}
              player={player}
              queued={handId ? (d.queue.find((q) => q.id === handId) ?? null) : null}
              onClose={() => {
                setDrawer(null)
                setHandId(null)
                setPreview(null)
                setSound(null)
                setPicture(null)
              }}
              onPreview={setPreview}
              onTab={(t) => setDrawer(t)}
              sound={sound}
              reveal={reveal}
              onSound={setSound}
              picture={picture}
              pictureReveal={pictureReveal}
              onPicture={setPicture}
              onLanes={setEditLanes}
            />
          ) : (
            <>
              <div className="notes-h">
                <h2>{planned ? 'Plan with your editor' : 'Notes for your editor'}</h2>
                {planned && !aiOff && <PlanWho provider={provider} />}
              </div>
              {planned && !providerChecked ? null : planned && aiOff ? (
                <PlanEmpty
                  provider={null}
                  hasPlan={!!d.plan}
                  onConnect={() => {
                    markPlanConnect(slug)
                    connect()
                  }}
                />
              ) : (
                <NotesLog
                  slug={slug}
                  madeWith={Object.fromEntries(d.versions.flatMap((v) => (v.madeWith ? [[v.n, v.madeWith]] : [])))}
                  entries={entries}
                  queue={d.queue}
                  held={d.queueHeld}
                  latest={latestN ?? 0}
                  first={first}
                  shown={onScreen?.n ?? null}
                  making={making}
                  busy={!!job}
                  aiOn={!aiOff}
                  basic={!d.aiEdited}
                  landed={landed}
                  unwatched={unwatched}
                  empty={planned && <PlanEmpty provider={provider} hasPlan={false} />}
                  label={planned ? 'Plan with your editor' : undefined}
                  plan={planned ? d.plan && <PlanChip plan={d.plan} /> : planCard}
                  versionRows={versionRows}
                  onPlay={watch}
                  onCompare={startCompare}
                  onAction={runAction}
                  onRetry={retry}
                  onEditHand={(id) => openDrawer('cut', id)}
                  onResume={() => void resume()}
                  onBasic={() => void resume(true)}
                  onAnotherVideo={(p) => void addVideo(p)}
                  onCopy={(t) => void reel.app.copyText(t).then(() => notify('Copied.'))}
                  onError={(m) => notify(m, 'error')}
                  answerError={answerError}
                  pausedWhy={pausedWhy}
                />
              )}
              {d.proposal && !looking && (
                <ReelsFound
                  key={d.proposal.jobId}
                  slug={slug}
                  proposal={d.proposal}
                  busy={!!job}
                  enter={d.proposal.jobId === askedReels}
                  onLookAgain={() => void findReels(true)}
                  onChanged={load}
                  onOpen={openReel}
                  onError={(m) => notify(m, 'error')}
                />
              )}
              {showComposer && (
                <div
                  className="cwrap"
                  data-testid="composer-wrap"
                  onDragOver={(e) => {
                    if (!Array.from(e.dataTransfer.types).includes('Files')) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                  }}
                  {...(planned && { 'data-video-drop': true })}
                  onDrop={(e) => {
                    if (!Array.from(e.dataTransfer.types).includes('Files')) return
                    if (planned) {
                      e.preventDefault()
                      e.stopPropagation()
                      window.dispatchEvent(new Event(NOTE_DROP_DONE))
                      const paths = droppedPaths(e)
                      if (paths.length) void addVideo(paths)
                      return
                    }
                    if (aiOff) return
                    e.preventDefault()
                    e.stopPropagation()
                    window.dispatchEvent(new Event(NOTE_DROP_DONE))
                    if (!providerChecked) {
                      heldDrops.current.push({ files: Array.from(e.dataTransfer.files), types: Array.from(e.dataTransfer.types) })
                      setHeldN(heldDrops.current.length)
                      return
                    }
                    att.onDropFiles(e.dataTransfer)
                  }}
                >
                  <Composer
                    draft={draft}
                    onDraft={setDraft}
                    chip={chip}
                    onChip={setChip}
                    auto={autoMoment}
                    onDropAuto={() => setStoppedOn(false)}
                    onPoint={() => canPoint && setPointing(true)}
                    plain={!hasVersions}
                    playhead={playhead}
                    att={heldN ? { ...att, busy: att.busy + heldN } : att}
                    checking={!providerChecked}
                    waitToSend={planAnswering}
                    placeholder={placeholder}
                    job={shareWork ? null : job}
                    making={making}
                    firstSteps={first?.kind === 'making' ? firstSteps : null}
                    steps={steps}
                    stepsOpenFirst={first?.kind === 'making'}
                    noSteps={d.job?.kind === 'script' || d.job?.kind === 'propose'}
                    stepNote={job ? d.chat.find((m) => m.from === 'you' && m.jobId === job.jobId) : null}
                    under={
                      first?.kind === 'making' &&
                      notifyAsk && (
                        <p className="notify-ask" data-testid="notify-ask">
                          This takes a few minutes.{' '}
                          <button
                            onClick={() => {
                              markNotifyAsked()
                              setNotifyAsk(false)
                              void reel.perm.setNotifications(true).catch((e) => notify(userMessage(e), 'error'))
                            }}
                            data-testid="notify-me"
                          >
                            Notify me when it's ready
                          </button>
                        </p>
                      )
                    }
                    held={held}
                    heldWhy={heldWhy}
                    alert={alert}
                    connect={
                      aiOff ? (
                        <div className="connect-cin" data-testid="composer-connect">
                          <p>Connect an editor to leave notes</p>
                          <ConnectAI onConnected={setProvider} />
                        </div>
                      ) : null
                    }
                    onSend={() => void send()}
                    onStop={() => job?.jobId && void reel.jobs.cancel(job.jobId)}
                    onRunNext={() => void reel.queue.runNext(slug).catch((e) => notify(userMessage(e), 'error'))}
                    onClear={() => void reel.queue.clear(slug).catch((e) => notify(userMessage(e), 'error'))}
                    inputRef={noteField}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {pickingSeries && (
        <SeriesPicker
          slug={slug}
          current={d.series}
          onClose={() => setPickingSeries(false)}
          onSaved={() => {
            setPickingSeries(false)
            void load()
          }}
        />
      )}
      {confirmDelete && (
        <Confirm
          title="Delete this reel?"
          body="This removes the reel and all its versions from Reel Studio. Anything you shared stays where you put it."
          yes="Delete"
          no="Keep it"
          danger
          onNo={() => setConfirmDelete(false)}
          onYes={async () => {
            await reel.projects.remove(slug).catch((e) => notify(userMessage(e), 'error'))
            go({ name: 'home' })
          }}
        />
      )}

    </div>
  )
}

/** Play, the time, speed, then whatever sits at the row's end (the phone shape, Instagram or Clean, full screen). */
/**
 * The phone's width on the stage, as --phone-px on it: reel.css gives the timeline and the transport row that width,
 * centred on the phone, so the controls sit under what they control instead of in the stage's corners. The phone sizes
 * itself from its slot's height (Phone.tsx), which its siblings can't read in CSS.
 */
function usePhoneWidth(stage: HTMLElement | null): void {
  useEffect(() => {
    if (!stage) return
    let phone: Element | null = null
    const measure = (): void => {
      const p = stage.querySelector('.stage-v .phone')
      if (p !== phone) {
        if (phone) sizes.unobserve(phone)
        phone = p
        if (p) sizes.observe(p)
      }
      const w = p?.getBoundingClientRect().width
      if (w) stage.style.setProperty('--phone-px', `${Math.round(w)}px`)
      else stage.style.removeProperty('--phone-px')
    }
    const sizes = new ResizeObserver(measure)
    // the phone arrives with the video, after the stage
    const children = new MutationObserver(measure)
    sizes.observe(stage)
    children.observe(stage, { childList: true, subtree: true })
    return () => {
      sizes.disconnect()
      children.disconnect()
    }
  }, [stage])
}

function TransportRow({ transport, playhead, children }: { transport: Transport; playhead: Playhead; children: React.ReactNode }) {
  const { playing, duration } = useTransport(transport)
  const second = usePlayhead(playhead, Math.floor)
  return (
    <div className="transport">
      <div className="tr-row">
        <button className="pp" onClick={() => transport.toggle()} aria-label={playing ? 'Pause' : 'Play'} data-testid="play">
          <Icon name={playing ? 'pause' : 'play'} size={14} stroke={2} />
        </button>
        <span className="tc" data-testid="time">
          {clock(second)} <span>/ {clock(duration)}</span>
        </span>
        <span className="sp" />
        <SpeedMenu transport={transport} />
        {children}
      </div>
    </div>
  )
}

/** Spots on the picture show again within 1.5 s of their moment. */
function Spots({ pins, playhead }: { pins: Pin[]; playhead: Playhead }) {
  const t = usePlayhead(playhead, (s) => Math.round(s * 4) / 4)
  if (!pins.length) return null
  return (
    <>
      {pins.map((p) => {
        const near = Math.abs(t - p.at) <= 1.5
        return (
          <span key={p.n} className={`spot${near ? '' : ' away'}${p.x > 0.55 ? ' flip' : ''}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, '--room': p.x > 0.55 ? p.x : 1 - p.x } as React.CSSProperties} aria-hidden>
            {p.n}
            {near && <span className="spot-lab">{p.text}</span>}
          </span>
        )
      })}
    </>
  )
}

/** Point at a spot (C): a ring follows the pointer and a click drops the numbered spot. Arrows and Enter do the same. */
function Pointer({ playhead, onDrop, onCancel }: { playhead: Playhead; onDrop: (x: number, y: number) => void; onCancel: () => void }) {
  const layer = useRef<HTMLDivElement>(null)
  const [ring, setRing] = useState<{ x: number; y: number } | null>(() => (byKeyboard() ? { x: 0.5, y: 0.4 } : null))
  const second = usePlayhead(playhead, Math.floor)
  useEffect(() => layer.current?.focus({ preventScroll: true }), [])
  const at = (e: React.PointerEvent | React.MouseEvent) => {
    const r = layer.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  return (
    <div
      ref={layer}
      className="pointer"
      tabIndex={0}
      role="application"
      aria-label="Point at the spot you mean. The arrow keys move, Enter drops the spot, Escape stops."
      onPointerMove={(e) => setRing(at(e))}
      onClick={(e) => {
        e.stopPropagation()
        const p = at(e)
        onDrop(p.x, p.y)
      }}
      onKeyDown={(e) => {
        const d = ({ ArrowLeft: [-0.04, 0], ArrowRight: [0.04, 0], ArrowUp: [0, -0.04], ArrowDown: [0, 0.04] } as Record<string, number[]>)[e.key]
        const r = ring ?? { x: 0.5, y: 0.4 }
        if (d) setRing({ x: Math.min(0.96, Math.max(0.04, r.x + d[0])), y: Math.min(0.96, Math.max(0.04, r.y + d[1])) })
        else if (e.key === 'Enter') onDrop(r.x, r.y)
        else if (e.key === 'Escape') onCancel()
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
      data-testid="pointer"
    >
      <span className="pointer-hint">Click the spot you mean</span>
      {ring && (
        <span className="ring" style={{ left: `${ring.x * 100}%`, top: `${ring.y * 100}%` }} aria-hidden>
          <span className="rt">{clock(second)}</span>
        </span>
      )}
    </div>
  )
}

/** Version 1 didn't finish before its video was copied in: in place of the video, why, and the one way on. */
function FailedStage({ why, onFiles }: { why: string; onFiles: (paths: string[]) => void }) {
  // the button says what to do, so the reason's first sentence is enough ("This video has no sound.")
  const reason = why.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? why
  return (
    <div className="phone-failed" data-testid="stage-failed">
      <p>{reason}</p>
      <PickFiles kind="primary" label="Choose another video" accept="video/*,.mov,.mp4,.m4v" onFiles={onFiles} testid="stage-another-video" />
    </div>
  )
}
