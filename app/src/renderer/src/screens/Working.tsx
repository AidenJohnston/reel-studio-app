import { useEffect, useRef, useState } from 'react'
import { reel, userMessage } from '../api'
import type { Go } from '../nav'
import { Confirm, Progress, Spinner, Thinking } from '../components/ui'
import { Icon } from '../components/icons'
import { PhonePlayer } from '../components/Player'
import { useNotify } from '../App'
import { ModelDownload } from '../components/connect'
import { STAGES, stageIndex } from '../../../shared/progress'
import { EMPTY_LIVE, PREVIEW_LABEL, liveFromDetail, reduceLive, timeLeftWords, type LiveState } from '../../../shared/live'

type State =
  | { kind: 'loading' }
  | { kind: 'running'; jobId: string; message: string; pct: number }
  | { kind: 'stopped' }
  | { kind: 'failed'; message: string; code?: string }

const LISTEN = 1 // index of "Listening to your video"

export function Working({ slug, go }: { slug: string; go: Go }) {
  const notify = useNotify()
  const [title, setTitle] = useState('')
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [stage, setStage] = useState(0)
  const stageRef = useRef(0)
  const [elapsed, setElapsed] = useState(0)
  const started = useRef(Date.now())
  const jobRef = useRef<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  // the take is flipped at render (it was mirrored): its first frame here is shown flipped too
  const [mirrored, setMirrored] = useState(false)
  const [heard, setHeard] = useState<string[]>([])
  // Everything the job flow says while it runs (shared/live.ts): bar, time left, thinking, first look.
  const [live, setLive] = useState<LiveState>(EMPTY_LIVE)
  const [confirmStop, setConfirmStop] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // The raw take's first frame, once it is copied in (the words I heard come as a `heard` event).
  const refresh = useRef<() => void>(() => {})
  refresh.current = () => {
    reel.projects
      .get(slug)
      .then((d) => {
        if (d.sourceVideo) setSource(d.sourceVideo)
        setMirrored(d.project.sources?.[0]?.mirror === true)
        if (d.words.length) setHeard(d.words.map((w) => w.w))
      })
      .catch(() => {})
  }

  useEffect(() => {
    let live = true
    reel.projects
      .get(slug)
      .then((d) => {
        if (!live) return
        setTitle(d.title)
        if (d.sourceVideo) setSource(d.sourceVideo)
        setMirrored(d.project.sources?.[0]?.mirror === true)
        if (d.words.length) setHeard(d.words.map((w) => w.w))
        if (d.job) {
          jobRef.current = d.job.id
          setState({ kind: 'running', jobId: d.job.id, message: d.job.message, pct: d.job.pct })
          stageRef.current = stageIndex(d.job.message, stageRef.current)
          setStage(stageRef.current)
          setLive(liveFromDetail(d.job))
        } else if (d.versions.length) go({ name: 'reel', slug })
        else if (d.status === 'failed')
          setState({ kind: 'failed', message: d.lastError?.userMessage ?? "I couldn't finish this video.", code: d.lastError?.code })
        else setState({ kind: 'stopped' })
      })
      .catch((e) => live && setState({ kind: 'failed', message: userMessage(e) }))

    const off = reel.jobs.onEvent((e) => {
      if (e.slug !== slug) return
      jobRef.current = e.jobId
      setLive((x) => reduceLive(x, e))
      if (e.type === 'heard') setHeard(e.words)
      if (e.type === 'status') {
        setState({ kind: 'running', jobId: e.jobId, message: e.message, pct: e.pct })
        const before = stageRef.current
        stageRef.current = stageIndex(e.message, stageRef.current)
        setStage(stageRef.current)
        // A new step: the copy, then the transcript, are now on disk.
        if (stageRef.current !== before) refresh.current()
      } else if (e.type === 'done') go({ name: 'reel', slug, fresh: true })
      else if (e.type === 'error') setState({ kind: 'failed', message: e.userMessage, code: e.code })
      else if (e.type === 'cancelled') setState({ kind: 'stopped' })
    })
    const tick = setInterval(() => setElapsed((Date.now() - started.current) / 1000), 1000)
    return () => {
      live = false
      off()
      clearInterval(tick)
    }
  }, [slug, go])

  const resume = async () => {
    try {
      setStage(0)
      stageRef.current = 0
      started.current = Date.now()
      setElapsed(0)
      setLive(EMPTY_LIVE)
      setState({ kind: 'running', jobId: '', message: 'Getting started', pct: 0 })
      const r = await reel.projects.resume(slug)
      jobRef.current = r.jobId
    } catch (e) {
      notify(userMessage(e), 'error')
      setState({ kind: 'stopped' })
    }
  }

  const remove = async () => {
    await reel.projects.remove(slug).catch(() => {})
    go({ name: 'home' })
  }

  const running = state.kind === 'running' || state.kind === 'loading'
  const bar = live.overall
  // the job flow's own honest estimate (main/progress.ts): a number, "almost there" when past it, or nothing yet
  const left = timeLeftWords(live)
  const preview = live.preview
  const showWords = heard.length > 0 && stage > LISTEN

  return (
    <div className="page reel-page">
      <div className="reel">
        <div className="reel-left">
          {preview ? (
            <>
              {/* key: a new preview is a new video element (autoplays muted from the start) */}
              <PhonePlayer key={preview.video} src={preview.video} autoPlayMuted testid="first-look-video" />
              <p className="muted-sm center" data-testid="first-look" data-kind={preview.kind}>{PREVIEW_LABEL[preview.kind]}</p>
            </>
          ) : (
            <div className={`phone${running ? ' working' : ''}`}>
              <div className="phone-screen">
                {source ? (
                  <video className={`still${mirrored ? ' mirrored' : ''}`} src={`${source}#t=0.5`} preload="metadata" muted playsInline disablePictureInPicture data-testid="working-frame" />
                ) : (
                  <div className="phone-empty">{running ? <Spinner /> : null}</div>
                )}
                {running && <div className="phone-scan" aria-hidden />}
              </div>
            </div>
          )}
        </div>

        <div className="reel-right working-right">
          <button className="back" onClick={() => go({ name: 'home' })}>
            <Icon name="back" size={16} /> My videos
          </button>
          <h1>{running ? 'Making your reel' : state.kind === 'stopped' ? 'This video is paused' : 'That did not work'}</h1>
          <p className="muted" style={{ marginTop: 4 }}>{title}</p>

          {running && (
            <>
              <div className="progress-block">
                <Progress pct={bar} label="Making your reel" />
                <div className="row" style={{ marginTop: 10 }}>
                  <span className="muted" data-testid="status-message">
                    {state.kind === 'running' ? state.message : 'Getting started'}
                  </span>
                  <span className="spacer" />
                  <span className="time-left" data-testid="time-left">{left ?? 'Working out how long this takes'}</span>
                </div>
              </div>

              <ol className="stages" data-testid="stages">
                {STAGES.map((s, i) => (
                  <li key={s.label} className={`stage${i < stage ? ' done' : i === stage ? ' current' : ''}`}>
                    <span className="dot">{i < stage ? <Icon name="check" size={14} stroke={2.5} /> : i === stage ? (live.thinking ? <Thinking /> : <Spinner />) : null}</span>
                    {s.label}
                  </li>
                ))}
              </ol>

              {(showWords || live.tools.length > 0) && (
                <div className="proof" data-testid="proof">
                  {/* only the latest few, so the box fits the window and "I heard" is never cut off (grandma3 #7) */}
                  {live.tools.slice(-3).map((t, i) => (
                    <p key={i} className="proof-line">{t}</p>
                  ))}
                  {showWords && (
                    <>
                      <p className="muted-sm">I heard:</p>
                      <p className="heard" data-testid="heard">
                        {heard.slice(0, 60).map((w, i) => (
                          <span key={i} style={{ animationDelay: `${Math.min(i, 40) * 35}ms` }}>
                            {w}{' '}
                          </span>
                        ))}
                        {heard.length > 60 ? '…' : ''}
                      </p>
                    </>
                  )}
                </div>
              )}

              <div className="row leave" style={{ marginTop: 18 }}>
                <p className="muted" data-testid="leave-copy">
                  You can use your computer for other things meanwhile. I'll tell you when your reel is ready.
                </p>
                <span className="spacer" />
                <button className="btn ghost small" onClick={() => setConfirmStop(true)} disabled={!jobRef.current} data-testid="stop">
                  Stop
                </button>
              </div>
            </>
          )}

          {state.kind === 'stopped' && (
            <div className="panel" style={{ marginTop: 22 }}>
              <p>I paused before your reel was finished. Nothing is lost.</p>
              <div className="row" style={{ marginTop: 18 }}>
                <button className="btn primary" onClick={resume} data-testid="resume">
                  Pick up where we left off
                </button>
                <button className="btn ghost danger" onClick={() => setConfirmDelete(true)}>
                  Delete this video
                </button>
              </div>
            </div>
          )}

          {state.kind === 'failed' && (
            <div className="panel" style={{ marginTop: 22 }}>
              <div className="banner error">{state.message}</div>
              {state.code === 'MODEL_MISSING' && (
                <div style={{ marginTop: 18 }}>
                  <ModelDownload />
                </div>
              )}
              <div className="row" style={{ marginTop: 18 }}>
                <button className="btn primary" onClick={resume}>
                  Try again
                </button>
                <button className="btn ghost danger" onClick={() => setConfirmDelete(true)}>
                  Delete this video
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {confirmStop && (
        <Confirm
          title="Stop making this reel?"
          body="You can pick up where you left off."
          yes="Stop"
          no="Keep going"
          onNo={() => setConfirmStop(false)}
          onYes={() => {
            setConfirmStop(false)
            if (jobRef.current) void reel.jobs.cancel(jobRef.current)
          }}
        />
      )}
      {confirmDelete && (
        <Confirm
          title="Delete this video?"
          body="This removes it from Reel Studio. Your original file stays where it was."
          yes="Delete"
          no="Keep it"
          danger
          onNo={() => setConfirmDelete(false)}
          onYes={() => void remove()}
        />
      )}
    </div>
  )
}
