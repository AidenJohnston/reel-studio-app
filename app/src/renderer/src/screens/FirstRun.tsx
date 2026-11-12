// The first run. The welcome is where the first reel starts: Choose a video (or a drop anywhere on it) makes that reel
// straight away, the first of the three choices to a first reel (the manifesto, rule 1). Nothing is asked first: a
// first reel needs no AI (docs/architecture.md section 1), the note box offers one when a note needs it, and the Reel
// screen asks about notifications while Version 1 is made. "See how it works" is the tour for those who want it,
// staged in the Reel screen's own layout (ux-foundation-b.md section 4): the sample is made in the player and the notes
// column the way an editor makes Version 1; on a Mac, then, notifications; then the editor; then a new reel.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProviderInfo } from '../../../shared/api'
import { place, type Shape } from '../../../shared/phone-shapes'
import { clock } from '../../../shared/progress'
import type { Step } from '../../../shared/steps'
import { reel, userMessage } from '../api'
import { Icon } from '../components/icons'
import { Logo } from '../components/brand'
import { ConnectAI } from '../components/connect'
import { StepRows } from '../components/Composer'
import { Phone, PhoneViewSwitch, deviceRatio, fitPhone, usePhoneShape, usePhoneView } from '../components/Phone'
import { createPlayhead, followVideo, usePlayhead, type Playhead } from '../components/playhead'
import { useNotify } from '../App'
import { Demo, freshSteps, type View } from '../components/first-run/demo'
import { ModelLine } from '../components/first-run/ModelLine'
import { NotifyRow, markNotifyAsked } from '../components/permissions'
import { EDIT, RAW_LEN, TRANSCRIPT, tokens } from '../components/first-run/sample'
import { sound } from '../components/first-run/sound'
import { byKeyboard, reducedMotion } from '../components/motion'
import { Button, PickFiles, useFileDrop } from '../components/ui'
import rawUrl from '../assets/sample/raw.mp4'
import aiUrl from '../assets/sample/ai.mp4'
import posterUrl from '../assets/sample/raw-poster.jpg'
import coverUrl from '../assets/sample/cover.jpg'
import candWide from '../assets/sample/cand-wide.jpg'
import candMid from '../assets/sample/cand-mid.jpg'
import candClose from '../assets/sample/cand-close.jpg'
import loafUrl from '../assets/sample/v_loaf.jpg'
import kneadUrl from '../assets/sample/v_knead.jpg'
import '../components/reel.css'
import '../components/first-run/first-run.css'

const URLS: Record<View, string> = { raw: rawUrl, v1: aiUrl }
const CAPTION = 'Good bread needs four things and a little time.'
const EASE_IN_OUT = 'cubic-bezier(.77,0,.175,1)'
const canFly = () => !reducedMotion() && !byKeyboard() && window.innerWidth > 860
const LEAVE_MS = 200

const HEADINGS: Record<Pane, string> = { sample: 'How a reel gets made', mac: 'Know when a video is ready', editor: 'Choose your editor' }
const LEADS: Record<Pane, string> = {
  sample: 'A raw take of someone talking, made into Version 1 the way your editor makes yours.',
  mac: 'Your own videos take a few minutes. Your Mac can tell you when each one is ready, so you can leave it running.',
  // true for every way to connect, so it names none of them
  editor: 'Connect an AI once, and it picks your best takes, adds pictures and makes the changes you ask for.'
}

const VIDEO_TYPES = 'video/*,.mov,.mp4,.m4v'

export function FirstRun({ onDone, onVideo, platform }: { onDone: () => Promise<void>; onVideo: (paths: string[]) => Promise<boolean>; platform: string }) {
  const computer = platform === 'darwin' ? 'Mac' : 'PC'
  // A video picked or dropped on the welcome makes the first reel; false (not a video) leaves the welcome as it was.
  const [making, setMaking] = useState(false)
  const take = async (paths: string[]) => {
    if (making || !paths.length) return
    setMaking(true)
    if (!(await onVideo(paths).catch(() => false))) setMaking(false)
  }
  const drop = useFileDrop((paths) => void take(paths))
  // The listening download starts with the welcome, so a video picked at once is heard as soon as it can be; a first
  // edit that starts before it is in waits for it (main index.ts startFirstEdit).
  useEffect(() => {
    void reel.model.download().catch(() => {})
  }, [])
  const [start, setStart] = useState<Start | null>(null)
  const [welcomeGone, setWelcomeGone] = useState(false)
  const [shape] = usePhoneShape()
  const center = useRef<HTMLImageElement>(null)
  const player = useRef<HTMLVideoElement>(null)
  const stage = !!start
  // Both places are read on the click, before anything moves: the stage has been laid out under the welcome.
  const begin = () => setStart({ flight: canFly() && center.current ? { from: center.current.getBoundingClientRect(), ...landing(player.current!, shape) } : null })

  return (
    <div className="fr" data-testid="first-run">
      {/* mounted under the welcome, so Get started only starts things: its frame is not the stage's mount */}
      <Stage computer={computer} shape={shape} start={start} video={player} onLanded={() => setWelcomeGone(true)} onDone={onDone} />
      {!welcomeGone && (
        <main
          className={`fr-welcome${stage || making ? ' leaving' : ''}${start?.flight ? ' flying' : ''}${drop.over ? ' over' : ''}`}
          aria-hidden={stage || undefined}
          inert={stage || making || undefined}
          {...(!stage && drop.props)}
          data-testid="welcome"
        >
          <span className="w-logo" aria-hidden>
            <Logo size={36} />
          </span>
          <h1>Welcome to Reel Studio</h1>
          <p className="w-lead">Pick a video of you talking. Reel Studio cuts out the pauses and retakes, and adds subtitles and a cover.</p>
          <div className="reels" aria-hidden>
            <img src={loafUrl} alt="" />
            <img src={posterUrl} alt="" ref={center} />
            <img src={kneadUrl} alt="" />
          </div>
          <PickFiles kind="primary" size="big" label="Choose a video" accept={VIDEO_TYPES} onFiles={(paths) => void take(paths)} disabled={making} testid="welcome-choose" />
          <p className="w-drop">or drop it anywhere here</p>
          {/* no promises here: what is free and what stays on this computer differ by what a person turns on (posting,
              an AI that looks at stills), so the welcome makes none */}
          <p className="w-foot">
            <button className="w-how" onClick={begin} data-testid="get-started">
              See how it works
            </button>
          </p>
        </main>
      )}
    </div>
  )
}

/** The welcome's reels have 14 px corners (first-run.css .reels img). */
const THUMB_RADIUS = 14

/**
 * Where the flight lands: the reel's own box on the phone (9:16, as the welcome's reel is), and the part of it the
 * screen shows, as a clip in the box's own pixels with the screen's corners where it meets them.
 */
function landing(video: HTMLVideoElement, s: Shape): { to: DOMRect; clip: string } {
  const to = video.parentElement!.getBoundingClientRect()
  const { viewer, reel } = place(s)
  const k = to.width / reel.w
  const top = Math.max(0, viewer.y - reel.y) * k
  const bottom = Math.max(0, reel.y + reel.h - viewer.y - viewer.h) * k
  const side = Math.max(0, viewer.x - reel.x) * k
  const r = s.radius * k
  const foot = viewer.y + viewer.h >= s.h ? r : 0
  return { to, clip: `inset(${top}px ${side}px ${bottom}px ${side}px round ${r}px ${r}px ${foot}px ${foot}px)` }
}

/**
 * The middle reel moving from the welcome into the player. Both are 9:16, so one translate and scale carries it,
 * while its clip goes from the welcome's rounded corners to what the phone's screen shows of the reel. The flyer is
 * the reel's own box, scaled down at the start. Resolves when it lands; it then fades over the player's own first
 * frame, so the Instagram screen under it comes in rather than popping.
 */
async function fly(src: string, { from, to, clip }: Flight): Promise<void> {
  const k = from.width / to.width
  const dx = from.left + from.width / 2 - (to.left + to.width / 2)
  const dy = from.top + from.height / 2 - (to.top + to.height / 2)
  const start = `translate(${dx}px, ${dy}px) scale(${k})`
  const round = THUMB_RADIUS / k
  const clip0 = `inset(0px 0px 0px 0px round ${round}px ${round}px ${round}px ${round}px)`
  const node = document.createElement('div')
  node.className = 'fr-flyer'
  Object.assign(node.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px`, transform: start, clipPath: clip0 })
  const img = document.createElement('img')
  img.src = src
  img.alt = ''
  node.append(img)
  document.body.append(node)
  await img.decode().catch(() => {})
  const move = node.animate(
    [
      { transform: start, clipPath: clip0 },
      { transform: 'none', clipPath: clip }
    ],
    { duration: 360, easing: EASE_IN_OUT, fill: 'forwards' }
  )
  const gone = () => node.remove()
  return move.finished.then(
    () => void node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' }).finished.then(gone, gone),
    gone
  )
}

/**
 * The first run's parts, named at the top of the notes column. Your Mac comes only where something needs asking: a Mac
 * that has not chosen about notifications. The folder is never asked: a new install keeps its videos in Movies,
 * which macOS does not guard, and an install that kept Documents already has access (main/paths.ts defaultRoot).
 */
const PANES = { sample: 'The sample', mac: 'Your Mac', editor: 'Your editor' } as const

type Flight = { from: DOMRect; to: DOMRect; clip: string }
/** Get started: where the welcome's middle reel and the player were, or no flight (reduced motion, keyboard, narrow). */
type Start = { flight: Flight | null }
type Pane = keyof typeof PANES

function Stage({
  computer,
  shape,
  start,
  video,
  onLanded,
  onDone
}: {
  computer: string
  shape: Shape
  /** null until Get started */
  start: Start | null
  video: React.RefObject<HTMLVideoElement | null>
  onLanded: () => void
  onDone: () => Promise<void>
}) {
  const notify = useNotify()
  const toks = useMemo(tokens, [])
  const segs = useMemo(() => TRANSCRIPT.map((s) => ({ id: s.id, toks: toks.flatMap((t, i) => (t.seg === s.id ? [{ t, i }] : [])) })), [toks])
  // the two pictures Version 1 adds: the loaf after "bread.", the hands after the kept take's "hands,"
  const picAt = useMemo(
    () =>
      new Map([
        [toks.findIndex((t) => t.seg === 'r3' && t.text === 'bread.'), { src: loafUrl, label: 'Picture: the loaf' }],
        [toks.findIndex((t) => t.seg === 'r5' && t.text === 'hands,'), { src: kneadUrl, label: 'Picture: hands kneading' }]
      ]),
    [toks]
  )
  const [pane, setPane] = useState<Pane>('sample')
  // Whether this computer asks about notifications (a Mac that has not chosen): read once, long before Continue.
  const [askMac, setAskMac] = useState(false)
  const [notifyOn, setNotifyOn] = useState(false)
  useEffect(() => {
    let live = true
    reel.perm
      .status()
      .then((s) => live && setAskMac(s.notifications === 'off'))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  const where: Pane[] = askMac ? ['sample', 'mac', 'editor'] : ['sample', 'editor']
  const at = where.indexOf(pane)
  const [steps, setSteps] = useState<Step[]>(freshSteps)
  const [finished, setFinished] = useState(false)
  const [paused, setPaused] = useState(false)
  const [held, setHeld] = useState(false)
  const [view, setView] = useState<View>('raw')
  const [ai, setAi] = useState<ProviderInfo | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [soundOn, setSoundOn] = useState(sound.on)
  const [phoneView, setPhoneView] = usePhoneView()
  const [playhead] = useState(createPlayhead)
  const demo = useRef<Demo | null>(null)
  const next = useRef<HTMLButtonElement>(null)
  const still = useRef<HTMLCanvasElement>(null)
  const r = {
    subs: useRef<HTMLDivElement>(null),
    tag: useRef<HTMLSpanElement>(null),
    scrim: useRef<HTMLDivElement>(null),
    cands: useRef<HTMLDivElement>(null),
    cover: useRef<HTMLDivElement>(null)
  }
  const chips = useRef<HTMLElement[]>([])
  const segEls = useRef(new Map<string, HTMLElement>())
  const pics = useRef<HTMLElement[]>([])
  const heading = useRef<HTMLHeadingElement>(null)
  const [landed, setLanded] = useState(false)
  const landing = !!start?.flight && !landed
  const box = useRef<HTMLDivElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const ratio = deviceRatio(shape)

  // The phone takes the slot's full height; the transport under it takes the phone's width, so both read --phone-w
  // from the box around them. Written on resize only, without rendering.
  useLayoutEffect(() => {
    const at = box.current!
    const el = slot.current!
    fitPhone(at, ratio, el.clientHeight)
    const ro = new ResizeObserver(([e]) => fitPhone(at, ratio, e.contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ratio])

  useEffect(() => followVideo(() => video.current, playhead), [playhead])
  // The cover, its candidates and the editor's pictures start hidden; decoded now, their first frame on screen is not a decode.
  useEffect(() => {
    for (const im of document.querySelectorAll<HTMLImageElement>('.fr-cover img, .fr-cands img, .fr-words .pic img')) void im.decode().catch(() => {})
  }, [])

  useEffect(() => {
    const d = new Demo(
      {
        video: video.current!,
        still: still.current!,
        subs: r.subs.current!,
        tag: r.tag.current!,
        scrim: r.scrim.current!,
        cands: r.cands.current!,
        cover: r.cover.current!,
        chips: chips.current,
        segs: segEls.current,
        pics: pics.current
      },
      toks,
      URLS,
      {
        steps: setSteps,
        view: setView,
        held: setHeld,
        finished: () => setFinished(true),
        paused: setPaused
      }
    )
    demo.current = d
    const blur = () => d.holdEnd()
    const hidden = () => document.hidden && d.holdEnd()
    const keyup = (e: KeyboardEvent) => (e.key === ' ' || e.key === 'Enter') && d.holdEnd()
    window.addEventListener('blur', blur)
    document.addEventListener('visibilitychange', hidden)
    document.addEventListener('keyup', keyup)
    return () => {
      d.destroy()
      window.removeEventListener('blur', blur)
      document.removeEventListener('visibilitychange', hidden)
      document.removeEventListener('keyup', keyup)
    }
    // built once for this stage
  }, [])

  useEffect(() => {
    if (!start) return
    setSoundOn(sound.on)
    let alive = true
    void (async () => {
      if (start.flight) await fly(posterUrl, start.flight)
      else if (!byKeyboard()) await new Promise((r) => window.setTimeout(r, LEAVE_MS)) // the welcome fades out first
      if (!alive) return
      setLanded(true)
      onLanded()
      // focus was on Get started, now gone: a screen reader starts at the column
      heading.current?.focus({ preventScroll: true })
      // Skip can land during the flight: the demo is then already finished.
      if (!demo.current!.finished) void demo.current!.start()
    })()
    return () => {
      alive = false
    }
    // once, on Get started
  }, [start])

  // Skip, which had focus, is gone once the sample is done: focus moves to Continue in its place
  useEffect(() => {
    if (finished && (document.activeElement === document.body || document.activeElement === null)) next.current?.focus({ preventScroll: true })
  }, [finished])

  // a step change moves a screen reader to its heading
  useEffect(() => {
    if (pane !== 'sample') heading.current?.focus({ preventScroll: true })
  }, [pane])
  // Allow pressed and done: its pill is gone, so focus goes to Continue, in its place in the footer
  useEffect(() => {
    if (notifyOn && (document.activeElement === document.body || document.activeElement === null)) next.current?.focus({ preventScroll: true })
  }, [notifyOn])

  const connected = (p: ProviderInfo) => setAi(p)
  // An editor already on from before counts as connected; one switched off while here does not.
  useEffect(() => {
    if (pane !== 'editor') return
    reel.ai
      .active()
      .then((p) => p.connected && p.id !== 'none' && connected(p))
      .catch(() => {})
    return reel.ai.onChange((p) => (p.connected && p.id !== 'none' ? connected(p) : setAi(null)))
  }, [pane])

  const finish = async () => {
    demo.current?.holdEnd()
    demo.current?.setPaused(true)
    setLeaving(true)
    // the stage fades out (reduced motion too: a fade is not movement); from the keyboard it just goes
    if (!byKeyboard()) await new Promise((r) => window.setTimeout(r, LEAVE_MS))
    try {
      await onDone()
    } catch (e) {
      // still here: the sample comes back, and the button works again
      setLeaving(false)
      notify(userMessage(e), 'error')
    }
  }

  const toggleSound = () => {
    const next = !soundOn
    setSoundOn(next)
    sound.set(next).catch((e) => notify(userMessage(e), 'error'))
  }

  const current = steps.find((s) => s.state === 'now')
  const doneCount = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length
  const version = finished ? 1 : null
  const hold = (on: boolean) => (on ? demo.current?.holdStart() : demo.current?.holdEnd())

  return (
    <div className={`fr-stage${start ? ' on' : ''}${leaving ? ' leaving' : ''}`} inert={!start || undefined}>
      {/* the sample's name, centred over the phone it names */}
      <header className="fr-tb">
        <span className="fr-title">
          <h1 className="tb-h">The sample</h1>
          {version && (
            <span className="rt-ver" data-testid="version-on-screen">
              Version {version}
            </span>
          )}
        </span>
      </header>
      <div className="reel-b">
        <section className="stage" aria-label="The sample reel">
          <div className="fr-player" ref={box}>
            <div className={`stage-v fr-slot${landing ? ' fr-landing' : ''}`} ref={slot}>
              <Phone
                shape={shape}
                view={phoneView}
                caption={CAPTION}
                className={held ? 'fr-held' : undefined}
                testid="sample-phone"
                over={
                  <>
                    <span className="reel-tag fr-tag" ref={r.tag} aria-hidden />
                    <div className="fr-scrim" ref={r.scrim} />
                    <div className="phone-reel fr-over" aria-hidden>
                      <div className="fr-cands" ref={r.cands}>
                        <img src={candWide} alt="" />
                        <img src={candMid} alt="" />
                        <img src={candClose} alt="" data-pick />
                      </div>
                      <div className="fr-cover" ref={r.cover}>
                        <img src={coverUrl} alt="" />
                        <div className="cover-t">
                          You don’t need a <em>mixer</em>
                        </div>
                      </div>
                    </div>
                    {finished && (
                      <button
                        className="fr-hold"
                        aria-label="The sample reel. Press and hold, or hold Space, to see what you filmed."
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          e.currentTarget.setPointerCapture(e.pointerId)
                          hold(true)
                        }}
                        onPointerUp={() => hold(false)}
                        onPointerCancel={() => hold(false)}
                        onLostPointerCapture={() => hold(false)}
                        onKeyDown={(e) => {
                          if (e.key !== ' ' && e.key !== 'Enter') return
                          e.preventDefault()
                          if (!e.repeat) hold(true)
                        }}
                        onContextMenu={(e) => e.preventDefault()}
                        data-testid="sample-hold"
                      />
                    )}
                  </>
                }
              >
                <video ref={video} className="fr-v" poster={posterUrl} muted playsInline preload="auto" aria-hidden />
                <canvas ref={still} className="fr-still" aria-hidden />
                <div className="fr-subs" ref={r.subs} aria-hidden />
              </Phone>
            </div>
            {/* under the phone and no wider than it: play, the time and the view, then how to see the raw take */}
            <div className="fr-transport">
              <div className="fr-tr-row">
                <button
                  className="pp"
                  style={finished ? undefined : { visibility: 'hidden' }}
                  onClick={() => demo.current?.setPaused(!paused)}
                  aria-label={paused ? 'Play the sample' : 'Pause the sample'}
                  data-testid="play"
                >
                  <Icon name={paused ? 'play' : 'pause'} size={14} stroke={2} />
                </button>
                <Clock playhead={playhead} view={view} />
                <span className="sp" />
                <PhoneViewSwitch value={phoneView} onChange={(v) => void setPhoneView(v).catch((e) => notify(userMessage(e), 'error'))} />
              </div>
              <p className={`fr-hint${finished ? ' show' : ''}`} data-testid="hold-hint">
                Hold the video to see what you filmed.
              </p>
            </div>
          </div>
        </section>

        <div className="ncol fr-col">
          {/* where in the first run this is and what the column shows; one scroll area under it, the progress in it
              under the words; the step's button pinned at the foot */}
          <div className="notes-h fr-h">
            <ol className="fr-where" aria-label="Getting started" data-testid="first-run-where">
              {[...where.map((p) => PANES[p]), 'Your reel'].map((w, i) => (
                <li key={w} aria-current={i === at ? 'step' : undefined} className={i < at ? 'done' : undefined}>
                  {w}
                </li>
              ))}
            </ol>
            <h2 ref={heading} tabIndex={-1} id="fr-h">
              {HEADINGS[pane]}
            </h2>
            <p className="fr-lead" data-testid="first-run-lead">
              {LEADS[pane]}
            </p>
          </div>
          <div className={`fr-body${pane === 'sample' ? ' fr-log' : ''}`}>
            {/* kept on the page in the editor step: the sample still plays and marks its words. The progress sits
                right under the words it is working on. */}
            <div className="fr-log-in" hidden={pane !== 'sample'}>
              <div role="log" aria-labelledby="fr-h">
                <article className="nt">
                  <div className="nt-ask">
                    <p className="bubble">
                      <Icon name="video" size={14} stroke={1.75} />
                      Raw take · 0:24
                    </p>
                  </div>
                  {finished ? (
                    <div className="nt-res enter" data-testid="sample-v1">
                      <span className="nk ok">
                        <Icon name="check" size={12} stroke={2.4} />
                      </span>
                      <b className="v">Version 1</b>
                      <span className="sep" aria-hidden>
                        ·
                      </span>
                      <span className="t">0:24 down to {EDIT.len}</span>
                    </div>
                  ) : (
                    <div className="nt-res quiet" aria-busy>
                      <span className="nk">
                        <span className="spin" />
                      </span>
                      <span className="t">Making Version 1</span>
                    </div>
                  )}
                  <p className="fr-words" data-testid="sample-words">
                    <b>Heard</b>{' '}
                    {segs.map((s) => (
                      <span
                        key={s.id}
                        className="fr-seg"
                        ref={(el) => {
                          if (el) segEls.current.set(s.id, el)
                        }}
                      >
                        {s.toks.map(({ t, i }) => {
                          const pic = picAt.get(i)
                          return (
                            <Fragment key={i}>
                              <span
                                ref={(el) => {
                                  if (el) chips.current[i] = el
                                }}
                                className={`tk${t.text ? '' : ' pz'}`}
                                aria-label={t.text ? undefined : `pause, ${t.pause}`}
                              >
                                {t.text ?? t.pause}
                              </span>{' '}
                              {pic && (
                                <>
                                  <span
                                    className="tk in pic gone"
                                    role="img"
                                    aria-label={pic.label}
                                    ref={(el) => {
                                      if (el && !pics.current.includes(el)) pics.current.push(el)
                                    }}
                                  >
                                    <img src={pic.src} alt="" />
                                  </span>{' '}
                                </>
                              )}
                            </Fragment>
                          )
                        })}
                      </span>
                    ))}
                  </p>
                  {!finished && (
                    <p className="fr-key" data-testid="pause-key">
                      <span className="tk pz in" aria-hidden>
                        1.0 s
                      </span>{' '}
                      is a pause. Red is what comes out.
                    </p>
                  )}
                </article>
              </div>
              <div className="cbox bare">
                <div className={`stripwrap${!finished ? ' on' : ''}`}>
                  <div>
                    {!finished && (
                      <>
                        {/* the tray as the Reel screen draws it (Composer.tsx): its row, the open steps under it, and the
                            hairline that is the progress bar. The open list's current row has the spinner, so the row
                            has none. The sample's sounds play on its cuts and its cover, so their switch sits on its row. */}
                        <div className="strip" data-testid="note-progress">
                          <span className="fr-strip-t" role="status">
                            <b>Making Version 1</b>
                            {/* the list under it names the step; the row says how far along */}
                            <span className="m">{current ? ` · Step ${steps.indexOf(current) + 1} of ${steps.length}` : ''}</span>
                          </span>
                          <span className="sp" />
                          <button className="sbtn fr-snd" aria-pressed={soundOn} onClick={toggleSound} title={`Sound effects: ${soundOn ? 'on' : 'off'}`} data-testid="sound-effects">
                            <Icon name={soundOn ? 'volume' : 'mute'} size={16} stroke={2} />
                            <span className="sr-only">Sound effects: {soundOn ? 'on' : 'off'}</span>
                          </button>
                        </div>
                        <div className="steps on">
                          <div>
                            <ul aria-label="Steps" data-testid="steps-list">
                              <StepRows steps={steps} />
                            </ul>
                          </div>
                        </div>
                        <span className="tray-bar" aria-hidden>
                          <i style={{ transform: `scaleX(${(doneCount + (current ? 0.5 : 0)) / steps.length})` }} />
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
            {pane === 'mac' && (
              <div className="fr-pick" data-testid="first-run-mac">
                <NotifyRow onOn={() => setNotifyOn(true)} />
              </div>
            )}
            {pane === 'editor' && (
              <div className="fr-pick" data-testid="composer-connect">
                <ConnectAI onConnected={connected} />
              </div>
            )}
          </div>

          <footer className="fr-foot">
            <ModelLine active={!!start} computer={computer} />
            <span className="sp" />
            {pane === 'sample' && !finished && (
              <Button kind="tertiary" onClick={() => demo.current?.skip()} data-testid="demo-skip">
                Skip
              </Button>
            )}
            {pane === 'sample' && finished && (
              <Button ref={next} kind="primary" onClick={() => setPane(where[1])} data-testid="demo-next">
                Continue
              </Button>
            )}
            {/* Not now is the skip: Settings keeps the switch, and the first Version 1 does not ask again */}
            {pane === 'mac' && (
              <Button
                ref={next}
                kind={notifyOn ? 'primary' : 'secondary'}
                onClick={() => {
                  markNotifyAsked()
                  setPane('editor')
                }}
                data-testid={notifyOn ? 'mac-continue' : 'mac-skip'}
              >
                {notifyOn ? 'Continue' : 'Not now'}
              </Button>
            )}
            {pane === 'editor' && (
              <Button kind={ai ? 'primary' : 'secondary'} onClick={() => void finish()} disabled={leaving} data-testid={ai ? 'editor-continue' : 'not-now'}>
                {/* short: it shares the footer with the speech model's download line, which a longer label cut at
                    1100 px (layout-audit); the line above says what a reel is without an editor */}
                {ai ? 'Continue' : 'Not now'}
              </Button>
            )}
          </footer>
        </div>
      </div>
    </div>
  )
}

/** The time on the sample and its length, as the log states it: one render a second while it plays. */
function Clock({ playhead, view }: { playhead: Playhead; view: View }) {
  const second = usePlayhead(playhead, Math.floor)
  const dur = view === 'raw' ? RAW_LEN : EDIT.dur
  return (
    <span className="tc" data-testid="time">
      {clock(Math.min(second, Math.floor(dur)))} <span>/ {view === 'raw' ? clock(RAW_LEN) : EDIT.len}</span>
    </span>
  )
}
