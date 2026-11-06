// The paired page: the header ("Connected to Sam's MacBook" and its menu), the event stream, and which screen shows.
// The stream carries no data, only "read again": each `changed`, each finished job and each reconnect bumps `pulse`,
// and the screen on show reads what it shows again. Job progress rides on the `job` events themselves.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppInfoDto, JobDto, ProjectId, ReelSummaryDto } from '../../../shared/contract'
import { Icon } from '../components/icons'
import { Button } from '../components/ui'
import { CompanionError, OFFLINE_WORDS, call, events, forget, onPairing, pairing, type EventStream } from './client'
import { ReelScreen } from './Reel'
import { ReelsScreen } from './Reels'

/** A request to read again: `project` null means everything (a reconnect, or a change not tied to one reel). */
export interface Pulse {
  n: number
  project: ProjectId | null
}

/** Live jobs from `job` events. A reel missing here has had no event yet; null means its job finished. */
export type LiveJobs = Record<ProjectId, JobDto | null>

export type Connection = 'connecting' | 'live' | 'offline'

const reelInHash = (): ProjectId | null => {
  const m = /^#r=(.+)$/.exec(location.hash)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

export function Shell() {
  const [computer, setComputer] = useState(() => pairing()?.computer ?? '')
  const [info, setInfo] = useState<AppInfoDto | null>(null)
  const [conn, setConn] = useState<Connection>('connecting')
  const [pulse, setPulse] = useState<Pulse>({ n: 0, project: null })
  const [jobs, setJobs] = useState<LiveJobs>({})
  const [reel, setReel] = useState<ProjectId | null>(reelInHash)
  const [reels, setReels] = useState<ReelSummaryDto[] | null>(null)
  const stream = useRef<EventStream | null>(null)
  const listScroll = useRef(0)

  const bump = useCallback((project: ProjectId | null) => setPulse((p) => ({ n: p.n + 1, project })), [])

  const readInfo = useCallback(async (): Promise<boolean> => {
    try {
      setInfo(await call('app.info', []))
      return true
    } catch (e) {
      if (e instanceof CompanionError && e.kind === 'offline') setConn('offline')
      return false
    }
  }, [])

  useEffect(() => onPairing((p) => p && setComputer(p.computer)), [])

  useEffect(() => {
    void readInfo()
    const s = events(
      (e) => {
        if (e.type === 'changed') {
          bump(e.project)
          // app.info changes with the editor connecting or a scope changing; neither names a reel
          if (e.project === null) void readInfo()
        } else if (e.type === 'job') {
          setJobs((j) => ({ ...j, [e.project]: e.done ? null : e.job }))
          if (e.done) bump(e.project)
        }
      },
      (live) => {
        if (live) {
          setConn('live')
          bump(null)
          void readInfo()
        } else {
          // the stream dropped: a call says whether the computer is gone or the stream just needs a moment
          void readInfo()
        }
      }
    )
    stream.current = s
    // A phone puts a background tab's connections to sleep; coming back, reconnect and read again at once.
    const back = () => {
      if (document.visibilityState === 'visible') s.retryNow()
    }
    document.addEventListener('visibilitychange', back)
    return () => {
      document.removeEventListener('visibilitychange', back)
      s.close()
    }
  }, [bump, readInfo])

  useEffect(() => {
    const moved = () => setReel(reelInHash())
    window.addEventListener('popstate', moved)
    window.addEventListener('hashchange', moved)
    return () => {
      window.removeEventListener('popstate', moved)
      window.removeEventListener('hashchange', moved)
    }
  }, [])

  // Back on the list, where it was left; a reel opens at its top.
  useEffect(() => {
    window.scrollTo(0, reel ? 0 : listScroll.current)
  }, [reel])

  const open = (id: ProjectId) => {
    listScroll.current = window.scrollY
    history.pushState({ cpReel: id }, '', `#r=${encodeURIComponent(id)}`)
    setReel(id)
  }
  const close = () => {
    // opened from the list: the phone's own Back and this button do the same thing
    if ((history.state as { cpReel?: string } | null)?.cpReel) history.back()
    else {
      history.replaceState(null, '', location.pathname + location.search)
      setReel(null)
    }
  }

  // A screen whose read found no computer: the one offline message, above whatever it already shows.
  const offline = useCallback(() => setConn('offline'), [])

  const tryAgain = () => {
    setConn('connecting')
    stream.current?.retryNow()
    void readInfo().then((ok) => ok && bump(null))
  }

  const name = info?.computer || computer || 'your computer'
  const summary = reel ? (reels?.find((r) => r.id === reel) ?? null) : null

  return (
    <div className="cp-col">
      <header className="cp-head">
        <p className="cp-who" data-conn={conn}>
          <i aria-hidden />
          <span>
            {conn === 'offline' ? "Can't reach " : conn === 'connecting' ? 'Connecting to ' : 'Connected to '}
            <b>{name}</b>
          </span>
        </p>
        <DeviceMenu computer={name} />
      </header>
      {conn === 'offline' && (
        <div className="cp-offline" role="alert" data-testid="cp-offline">
          <p className="banner">
            <span>{OFFLINE_WORDS}</span>
          </p>
          <Button size="big" className="cp-wide" onClick={tryAgain}>
            <Icon name="retry" size={16} />
            Try again
          </Button>
        </div>
      )}
      <main>
        {reel ? (
          <ReelScreen key={reel} id={reel} summary={summary} info={info} pulse={pulse} liveJob={reel in jobs ? jobs[reel] : undefined} onBack={close} onOffline={offline} />
        ) : (
          <ReelsScreen pulse={pulse} jobs={jobs} reels={reels} onReels={setReels} onOpen={open} onOffline={offline} />
        )}
      </main>
    </div>
  )
}

/** The header's menu: one thing in it, Forget this computer. Undoing it is scanning a new code, which the item says. */
function DeviceMenu({ computer }: { computer: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    box.current?.querySelector<HTMLElement>('.cp-pop button')?.focus()
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        trigger.current?.focus()
      }
    }
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div className="cp-menu" ref={box}>
      <button
        ref={trigger}
        type="button"
        className="cp-tap"
        aria-label="Menu"
        aria-expanded={open}
        aria-controls="cp-menu-pop"
        onClick={() => setOpen((o) => !o)}
        data-testid="cp-menu"
      >
        <Icon name="more" />
      </button>
      {open && (
        <div className="cp-pop" id="cp-menu-pop">
          <button type="button" className="cp-pop-item" onClick={() => forget(null)} data-testid="cp-forget">
            <span className="danger">Forget this computer</span>
            <span className="faint">Unpairs {computer}. To connect again, scan a new code.</span>
          </button>
        </div>
      )}
    </div>
  )
}
