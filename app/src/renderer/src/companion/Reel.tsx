// One reel: the 9:16 player, the version strip under it, Save to phone, and the notes (the chat, the running job
// with Stop, and the note box). Picking a version crossfades the player in place; the page never reloads, and the
// version picked stays on screen when the reel is read again.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { NOTE_MAX_CHARS, type AppInfoDto, type JobDto, type MediaRef, type NoteArgs, type ProjectId, type ReelDto, type ReelSummaryDto, type VersionDto } from '../../../shared/contract'
import { clock } from '../../../shared/progress'
import { Icon } from '../components/icons'
import { byKeyboard } from '../components/motion'
import { Button, Progress, Spinner, arrowPick, tabStop } from '../components/ui'
import { CompanionError, call, mediaUrl, requestId } from './client'
import { noun, platform } from './device'
import type { Pulse } from './Shell'
import { jobTimeLeft, jobWords, statusOf } from './words'

/** How long the crossfade runs (companion.css .cp-layer); the old layer is dropped once it has. */
const FADE_MS = 200
/** The longest a version swap waits for the new poster before fading anyway. */
const READY_WAIT_MS = 600

export function ReelScreen({
  id,
  summary,
  info,
  pulse,
  liveJob,
  onBack,
  onOffline
}: {
  id: ProjectId
  /** The list's line for this reel, shown while the reel itself is read. */
  summary: ReelSummaryDto | null
  info: AppInfoDto | null
  pulse: Pulse
  /** From `job` events: undefined when none has come for this reel yet. */
  liveJob: JobDto | null | undefined
  onBack: () => void
  onOffline: () => void
}) {
  const [reel, setReel] = useState<ReelDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [moment, setMoment] = useState<number | null>(null)
  const [fresh, setFresh] = useState<number | null>(null)
  const [said, setSaid] = useState('')
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const r = await call('projects.get', [id])
      if (mine !== seq.current) return
      setReel(r)
      setError(null)
      // the first read picks the newest; after that the pick is the person's, whatever lands
      setPicked((p) => p ?? newestOf(r.versions))
    } catch (e) {
      if (mine !== seq.current) return
      if (e instanceof CompanionError && e.kind === 'offline') onOffline()
      else if (!(e instanceof CompanionError && e.kind === 'unpaired')) setError(e instanceof CompanionError ? e.userMessage : "Couldn't read this reel. Try again.")
    }
  }, [id, onOffline])

  const first = useRef(true)
  useEffect(() => {
    if (first.current || pulse.project === null || pulse.project === id) void load()
    first.current = false
    // read again on a pulse for this reel or for everything; nothing else should start a read
  }, [pulse.n])

  const versions = useMemo(() => [...(reel?.versions ?? [])].sort((a, b) => b.n - a.n), [reel])
  const shown = versions.find((v) => v.n === picked) ?? versions[0] ?? null
  const job = liveJob !== undefined ? liveJob : (reel?.job ?? null)

  // A version that lands while the page is open is said once, and offered if another one is on screen.
  const newest = reel ? (versions[0]?.n ?? 0) : null
  const seen = useRef<number | null>(null)
  useEffect(() => {
    if (newest === null) return
    if (seen.current !== null && newest > seen.current) {
      setFresh(newest)
      setSaid(`Version ${newest} is ready.`)
    }
    seen.current = newest
  }, [newest])

  const pick = (n: number) => {
    setPicked(n)
    setMoment(null)
    if (n === fresh) setFresh(null)
  }

  // a running job's words replace the last "Version N is ready", which must not be read again when the job ends
  const running = job !== null
  useEffect(() => {
    if (running) setSaid('')
  }, [running])

  const title = reel?.title ?? summary?.title ?? ''
  const head = reel ?? summary
  const status = head ? statusOf(head) : null

  // A new screen: its name in the tab, and focus on its heading, so a screen reader starts here and Tab goes on
  // from the top instead of from where the list's card was.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    document.title = title ? `${title} · Reel Studio` : 'Reel Studio'
    return () => {
      document.title = 'Reel Studio'
    }
  }, [title])

  return (
    <>
      <div className="cp-reel-head">
        <button type="button" className="cp-tap cp-back" aria-label="All reels" onClick={onBack} data-testid="cp-back">
          <Icon name="chevron-left" size={22} />
        </button>
        <div className="cp-reel-name">
          <h1 className="cp-title" ref={heading} tabIndex={-1}>
            {title}
          </h1>
          {status && <span className={`badge ${status.tone}`}>{status.words}</span>}
        </div>
      </div>
      {/* job progress and new versions, for screen readers; present from the start so the first words are read */}
      <p className="sr-only" role="status">
        {job ? jobWords(job) : said}
      </p>
      {error && (
        <p className="banner error" role="alert">
          <span>{error}</span>
        </p>
      )}

      <Stage version={shown} cover={summary?.cover ?? reel?.cover ?? null} title={title} waiting={!!reel && versions.length === 0} onMoment={setMoment} />

      {fresh !== null && shown && fresh !== shown.n && (
        <Button kind="tertiary" size="big" className="cp-fresh" onClick={() => pick(fresh)}>
          <span className="badge ready">Version {fresh} is ready</span>
          Watch it
        </Button>
      )}

      {versions.length > 0 && shown && <VersionStrip versions={versions} shown={shown.n} onPick={pick} />}
      {shown && <SaveVideo v={shown} several={versions.length > 1} />}

      {reel && (
        <Notes
          id={id}
          reel={reel}
          info={info}
          job={job}
          version={shown?.n ?? null}
          moment={moment}
          onSent={() => void load()}
          onOffline={onOffline}
        />
      )}
    </>
  )
}

const newestOf = (versions: VersionDto[]): number | null => (versions.length ? Math.max(...versions.map((v) => v.n)) : null)

// ---- the player ----------------------------------------------------------------------------------

/**
 * The 9:16 player. Each version is its own layer: the new one sits over the old at opacity 0 and fades in once its
 * poster has loaded (or after READY_WAIT_MS), then the old one goes. From the keyboard the
 * swap is instant (companion.css).
 */
function Stage({
  version,
  cover,
  title,
  waiting,
  onMoment
}: {
  version: VersionDto | null
  cover: MediaRef | null
  title: string
  /** Read, and no Version 1 yet. */
  waiting: boolean
  onMoment: (seconds: number | null) => void
}) {
  // the newest layer is last; at most two
  const [layers, setLayers] = useState<VersionDto[]>(() => (version ? [version] : []))
  const [shown, setShown] = useState(false)
  // the front layer's fade has finished (shown only says it started)
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (!version) return
    setLayers((ls) => {
      if (ls.at(-1)?.n === version.n) return ls
      // switching again mid-fade keeps the layer that was fully on screen under the new one, so the stage never
      // shows through a half-faded layer
      const under = settled ? ls.at(-1) : (ls.at(-2) ?? ls.at(-1))
      return under ? [under, version] : [version]
    })
    if (layers.at(-1)?.n !== version.n) {
      setShown(false)
      setSettled(false)
    }
    // follows the version number: a re-read hands over a new object for the same version
  }, [version?.n])

  // the list's cover, under the first version until that has faded in over it
  const [bare, setBare] = useState(true)
  const ready = useCallback(() => setShown(true), [])
  useEffect(() => {
    if (!shown || (layers.length < 2 && !bare)) return
    const drop = () => {
      setLayers((ls) => ls.slice(-1))
      setBare(false)
      setSettled(true)
    }
    if (byKeyboard()) {
      drop()
      return
    }
    const t = setTimeout(drop, FADE_MS + 20)
    return () => clearTimeout(t)
  }, [shown, layers.length, bare])

  const poster = useMemo(() => (cover ? mediaUrl(cover) : null), [cover])

  return (
    <div className="cp-stage">
      {(bare || layers.length === 0) && (
        <div className="cp-layer" data-shown="true">
          {poster && <img className="cp-still" src={poster} alt="" />}
          {waiting && <p className="cp-stage-note">Version 1 isn't ready yet. It plays here as soon as it is.</p>}
        </div>
      )}
      {layers.map((v, i) => {
        const front = i === layers.length - 1
        return <Layer key={v.n} v={v} front={front} shown={!front || shown} title={title} onReady={front ? ready : noop} onMoment={onMoment} />
      })}
    </div>
  )
}

const noop = (): void => {}

function Layer({
  v,
  front,
  shown,
  title,
  onReady,
  onMoment
}: {
  v: VersionDto
  front: boolean
  shown: boolean
  title: string
  onReady: () => void
  onMoment: (seconds: number | null) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  // Signed once per layer: a re-render must never change a playing video's src (client.ts mediaUrl).
  const [src, setSrc] = useState(() => mediaUrl(v.video))
  const [poster] = useState(() => (v.cover ? mediaUrl(v.cover) : undefined))
  const [broken, setBroken] = useState(false)
  const resumeAt = useRef(0)
  const isFront = useRef(front)
  isFront.current = front
  const readyRef = useRef(onReady)
  readyRef.current = onReady
  // the first frame decoded is as good as the poster; both go through the same once-only, frame-late call
  const firstFrame = useRef<() => void>(noop)

  useEffect(() => {
    let done = false
    let frame = 0
    // two frames on: a cached poster can load before the layer was ever drawn at opacity 0, which skips the fade
    const ready = () => {
      if (done) return
      done = true
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => readyRef.current())))
    }
    firstFrame.current = ready
    const t = setTimeout(ready, READY_WAIT_MS)
    if (poster) {
      const img = new Image()
      img.onload = ready
      img.onerror = ready
      img.src = poster
    }
    return () => {
      done = true
      clearTimeout(t)
      cancelAnimationFrame(frame)
    }
  }, [poster])

  useEffect(() => {
    if (!front) video.current?.pause()
  }, [front])

  // a moment > 0 the video was paused or scrubbed to, for "Note here"
  const report = (el: HTMLVideoElement) => {
    if (!isFront.current) return
    onMoment(!el.paused || el.ended || el.currentTime < 0.05 ? null : el.currentTime)
  }

  return (
    <div className="cp-layer" data-shown={shown} inert={!front}>
      <video
        ref={video}
        className="cp-video"
        data-testid={front ? 'cp-player' : undefined}
        src={src}
        poster={poster}
        controls={front}
        playsInline
        preload="metadata"
        onLoadedData={() => firstFrame.current()}
        aria-label={`${title}, Version ${v.n}`}
        onLoadedMetadata={(e) => {
          if (resumeAt.current) e.currentTarget.currentTime = resumeAt.current
          resumeAt.current = 0
        }}
        onPause={(e) => report(e.currentTarget)}
        onSeeked={(e) => report(e.currentTarget)}
        onPlay={() => isFront.current && onMoment(null)}
        onEnded={() => isFront.current && onMoment(null)}
        onError={(e) => {
          // a link older than its signature: sign again and carry on from the same place
          const again = mediaUrl(v.video)
          if (again !== src) {
            resumeAt.current = e.currentTarget.currentTime
            setSrc(again)
          } else setBroken(true)
        }}
      />
      {broken && <p className="cp-stage-note">Version {v.n} didn't load. Go back and open the reel again.</p>}
    </div>
  )
}

// ---- versions and saving -------------------------------------------------------------------------

/** Newest first. One Tab stop; the arrow keys move along it (ui.tsx arrowPick). */
function VersionStrip({ versions, shown, onPick }: { versions: VersionDto[]; shown: number; onPick: (n: number) => void }) {
  const keys = versions.map((v) => String(v.n))
  return (
    <div className="cp-strip" role="radiogroup" aria-label="Versions" onKeyDown={(e) => arrowPick(e, keys, String(shown), (k) => onPick(Number(k)))}>
      {versions.map((v) => (
        <button
          key={v.n}
          type="button"
          role="radio"
          aria-checked={v.n === shown}
          tabIndex={tabStop(String(v.n), String(shown), keys)}
          data-key={String(v.n)}
          data-n={v.n}
          data-testid="cp-version"
          className="cp-ver"
          onClick={() => onPick(v.n)}
        >
          <span className="cp-ver-pic">{v.cover && <img src={mediaUrl(v.cover)} alt="" loading="lazy" decoding="async" />}</span>
          <span className="cp-ver-text">
            <span className="cp-ver-name">
              Version {v.n}
              {v.draft && <span className="cp-ver-tag"> · Quick look</span>}
            </span>
            {v.change && <span className="cp-ver-change">{v.change}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

/** A download link for the version on screen, with the steps that get it from Downloads into Photos. */
function SaveVideo({ v, several }: { v: VersionDto; several: boolean }) {
  const where = platform()
  const which = several ? ` Version ${v.n}` : ''
  const label = where === 'other' ? `Download${which}` : `Save${which} to ${where === 'ipad' ? 'iPad' : 'phone'}`
  return (
    <div className="cp-save">
      <a
        className="btn big cp-wide"
        data-testid="cp-save"
        href={mediaUrl(v.video, { save: true })}
        download
        // signed again at the tap: the page may have sat open longer than the link's hour
        onClick={(e) => (e.currentTarget.href = mediaUrl(v.video, { save: true }))}
      >
        <Icon name="download" size={18} />
        {label}
      </a>
      {(where === 'iphone' || where === 'ipad') && (
        <details className="cp-hint">
          <summary>How to get it into Photos</summary>
          <ol>
            <li>
              Tap <b>{label}</b>, then <b>Download</b>.
            </li>
            <li>
              Tap the download arrow in Safari's address bar (or <b>aA</b> › <b>Downloads</b>), then tap the video.
            </li>
            <li>
              Tap <b>Share</b>, then <b>Save Video</b>. It's in Photos, ready for Instagram.
            </li>
          </ol>
        </details>
      )}
      {where === 'android' && <p className="cp-hint faint">It goes to Downloads, and shows up in your Gallery or Photos app.</p>}
    </div>
  )
}

// ---- notes ---------------------------------------------------------------------------------------

function Notes({
  id,
  reel,
  info,
  job,
  version,
  moment,
  onSent,
  onOffline
}: {
  id: ProjectId
  reel: ReelDto
  info: AppInfoDto | null
  job: JobDto | null
  version: number | null
  moment: number | null
  onSent: () => void
  onOffline: () => void
}) {
  const canNote = info?.scopes.includes('note') ?? false
  return (
    <section className="cp-notes" aria-labelledby="cp-notes-h">
      <h2 id="cp-notes-h">Notes</h2>
      {reel.chat.length > 0 ? (
        <ol className="cp-chat" data-testid="cp-chat">
          {reel.chat.map((l) => (
            <li key={l.id} className={`cp-line ${l.from}`}>
              {l.from === 'editor' && <span className="cp-line-who">Editor</span>}
              <p className="cp-line-text">{l.text}</p>
              {l.version !== null && (
                <span className="cp-line-meta">
                  Version {l.version}
                  {l.moment !== null && ` at ${clock(l.moment)}`}
                </span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="faint">{canNote ? 'No notes yet. Pause on a moment and say what should change there.' : 'No notes on this reel yet.'}</p>
      )}
      {reel.error && !job && (
        <p className="banner error">
          <span>{reel.error}</span>
        </p>
      )}
      {job && <JobStrip id={id} job={job} canStop={canNote} />}
      {info &&
        (canNote ? (
          <NoteBox id={id} version={version} moment={moment} editor={info.editor} onSent={onSent} onOffline={onOffline} />
        ) : (
          <p className="faint" data-testid="cp-watch-only">
            This {noun()} can watch and save, but not send notes. To send notes, pair it again in Reel Studio with notes allowed.
          </p>
        ))}
    </section>
  )
}

function JobStrip({ id, job, canStop }: { id: ProjectId; job: JobDto; canStop: boolean }) {
  const [stopping, setStopping] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const left = jobTimeLeft(job)
  const stop = async () => {
    setStopping(true)
    setProblem(null)
    try {
      await call('jobs.cancel', [id, job.id])
    } catch (e) {
      if (!(e instanceof CompanionError && e.kind === 'unpaired')) setProblem(e instanceof CompanionError ? e.userMessage : "Couldn't stop it. Try again.")
    } finally {
      setStopping(false)
    }
  }
  return (
    <div className="cp-job" data-testid="cp-job">
      <div className="cp-job-top">
        <Spinner />
        <span className="cp-job-words">{jobWords(job)}</span>
        {canStop && (
          <Button size="big" onClick={() => void stop()} disabled={stopping} data-testid="cp-stop">
            <Icon name="stop" size={14} />
            Stop
          </Button>
        )}
      </div>
      <Progress pct={job.overall} label="Edit progress" />
      {left && <span className="faint">{left}</span>}
      {problem && (
        <p className="banner error" role="alert">
          <span>{problem}</span>
        </p>
      )}
    </div>
  )
}

function NoteBox({
  id,
  version,
  moment,
  editor,
  onSent,
  onOffline
}: {
  id: ProjectId
  version: number | null
  moment: number | null
  editor: boolean
  onSent: () => void
  onOffline: () => void
}) {
  const field = useId()
  const [text, setText] = useState('')
  const [here, setHere] = useState(true)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // One id per submission until a reply comes back: a retry after a lost reply reuses it, so it can't land twice.
  // A changed note is a new submission.
  const pending = useRef<{ key: string; requestId: string } | null>(null)

  // each new pause or scrub turns Note here on again
  useEffect(() => setHere(true), [moment])

  const at = here && moment !== null && version !== null ? Math.round(moment * 10) / 10 : null

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const body = text.trim()
    if (sending) return
    if (!body) {
      setProblem('Write a note first.')
      return
    }
    const key = JSON.stringify([body, version, at])
    if (pending.current?.key !== key) pending.current = { key, requestId: requestId() }
    const args: NoteArgs = { requestId: pending.current.requestId, text: body }
    if (version !== null) args.version = version
    if (version !== null && at !== null) args.at = at
    setSending(true)
    setProblem(null)
    setNotice(null)
    try {
      const r = await call('projects.note', [id, args])
      pending.current = null
      // only what was sent: words typed while it was on its way stay
      setText((t) => (t.trim() === body ? '' : t))
      setNotice(r.queued ? "Sent. It's next, after the edit that's running now." : null)
      onSent()
    } catch (err) {
      if (err instanceof CompanionError && err.kind === 'offline') {
        setProblem("Your computer didn't answer, so the note may not have arrived. Send it again; it won't be sent twice.")
        onOffline()
      } else if (!(err instanceof CompanionError && err.kind === 'unpaired')) {
        // the computer answered: whatever it said, this submission is over
        pending.current = null
        setProblem(err instanceof CompanionError ? err.userMessage : 'Not sent. Try again.')
      }
    } finally {
      setSending(false)
    }
  }

  const key = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
  }

  return (
    <form className="cp-note" onSubmit={(e) => void send(e)}>
      {!editor && <p className="cp-note-why" data-testid="cp-no-editor">Notes go to the chat on your computer, but nothing edits them until an AI editor is connected there.</p>}
      <label className="sr-only" htmlFor={field}>
        Note for the editor
      </label>
      <textarea
        id={field}
        className="textarea cp-note-text"
        data-testid="cp-note-input"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setNotice(null)
          if (problem === 'Write a note first.') setProblem(null)
        }}
        onKeyDown={key}
        rows={3}
        maxLength={NOTE_MAX_CHARS}
        placeholder="What should change?"
      />
      <div className="cp-note-foot">
        {moment !== null && version !== null && (
          <label className="cp-here" data-testid="cp-note-here">
            <input type="checkbox" checked={here} onChange={(e) => setHere(e.target.checked)} />
            <span>Note here at {clock(moment)}</span>
          </label>
        )}
        <Button kind="primary" size="big" type="submit" className="cp-send" disabled={sending} data-testid="cp-note-send">
          {sending && <Spinner />}
          Send
        </Button>
      </div>
      {problem && (
        <p className="banner error" role="alert">
          <span>{problem}</span>
        </p>
      )}
      {notice && (
        <p className="banner good" role="status">
          <span>{notice}</span>
        </p>
      )}
    </form>
  )
}
