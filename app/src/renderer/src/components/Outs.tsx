// Share, the one way out (ux-foundation-b sections 5 and 7): a green pill whose popover holds the caption and every
// destination, each with its own progress, Cancel and failure line. Work keeps going with the popover closed; the
// pill then carries a ring.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { DataSharing, ExportResult, ProjectJson, VersionInfo } from '../../../shared/api'
import { shareOrder } from '../../../shared/share'
import { EXPORT_EVENT } from '../App'
import { errorCode, reel, userMessage } from '../api'
import { BrandMark } from './brand'
import { saveToDrive, useCloudDrives } from './CloudSave'
import { Icon } from './icons'
import { NEVER_SHARED } from './ModelsAndPrivacy'
import { usePresence } from './motion'
import { SendToPhone } from './SendToPhone'
import { SharePlatforms } from './SharePlatforms'
import { Strip, type Work } from './ShareStrip'
import { FOLDER_APP, Modal } from './ui'
import { usePostingStatus } from './posting'
import { PostSheet } from './PostSheet'
import { SocialPostSheet } from './SocialPostSheet'
import { accountName } from './SocialSettings'
import { useSocialStatus } from './social'
import { PLATFORM_NAMES } from '../../../shared/social'
import './share.css'

const LAST = 'rs.share.last'
const INSTAGRAM_LIMIT = 2200

type Done = { kind: 'done'; line: string; path?: string }
/** "Getting Version N ready": exporting, which for a preview is a full-quality render first. */
type Preparing = Extract<Work, { kind: 'working' }> & { prep: true }
type Row = Work | Done | Preparing
const isPrep = (r: Row | undefined): r is Preparing => !!r && 'prep' in r

const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p
/** The caption as it is posted: the editor's words, then its hashtags (main's exportVersion joins them the same way). */
const posted = (post: ProjectJson['post']): string =>
  [post?.caption ?? '', (post?.hashtags ?? []).map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')].filter(Boolean).join('\n\n')

export function Outs({
  slug,
  title,
  version,
  post,
  disabled,
  quiet,
  why,
  onSaveCaption
}: {
  slug: string
  /** The reel's name: Post to YouTube starts its title from it. */
  title: string
  /** The version on screen: the one Share sends. */
  version: VersionInfo | undefined
  post: ProjectJson['post']
  /** A version is being made: nothing new can start. */
  disabled: boolean
  /** Another action is this screen's one green button (Done comparing, Make Version N, connecting an editor). */
  quiet?: boolean
  why?: string
  /** Saves the caption as typed (hashtags included) and reloads the reel. */
  onSaveCaption: (caption: string) => Promise<boolean>
}) {
  const [open, setOpen] = useState(false)
  const [instant, setInstant] = useState(false)
  const { mounted, leaving } = usePresence(open, 120)
  const [ever, setEver] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const helpRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<{ phone: string } | null>(null)
  // Keyed by version and destination ("3|instagram"): a line belongs to the version it was for.
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [platformWork, setPlatformWork] = useState<Work | null>(null)
  const [platformsOpen, setPlatformsOpen] = useState(false)
  const [unseen, setUnseen] = useState<'done' | 'failed' | null>(null)
  const [prepJob, setPrepJob] = useState<string | null>(null)
  // The order is set when Share opens: a row never jumps under the pointer while Share is open.
  const [last, setLast] = useState(() => localStorage.getItem(LAST))
  const [ask, setAsk] = useState<'ask' | 'answered' | null>(null)
  const sharing = useRef<DataSharing | null>(null)
  const cancels = useRef(new Map<string, () => void>())
  const pending = useRef<{ key: string; files: Promise<ExportResult> } | null>(null)
  const saving = useRef<Promise<boolean> | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const { drives, label: driveName } = useCloudDrives()
  // Post to YouTube (main/posting.ts): a destination unless posting is turned off (REELSTUDIO_POSTING=0)
  const [posting] = usePostingStatus()
  const [postSheet, setPostSheet] = useState<{ video: string; version: number; durationSec: number | null } | null>(null)
  // Post to Instagram and Post to TikTok (SocialPostSheet): rows only while the sign-in service can connect them
  const [social, reloadSocial] = useSocialStatus()
  const [socialSheet, setSocialSheet] = useState<{ platform: 'instagram' | 'tiktok' | 'facebook' | 'threads' | 'x' | 'linkedin'; version: number; hasCover: boolean; durationSec: number | null } | null>(null)
  // a post is being sent: Stop is the way out, not Esc or a click outside. A ref read when Esc comes, set in the
  // sheet's layout effect: state passed up through a passive effect let an Esc pressed just as Sending showed close it
  const postBusy = useRef(false)
  const setPostBusy = useCallback((busy: boolean) => {
    postBusy.current = busy
  }, [])

  const [caption, setCaption] = useState(() => posted(post))
  const savedCaption = useRef(posted(post))
  useEffect(() => {
    const next = posted(post)
    if (next === savedCaption.current) return
    savedCaption.current = next
    setCaption(next)
  }, [post])

  useEffect(() => {
    void reel.app.info().then((i) => { sharing.current = i.sharing }).catch(() => {})
  }, [])

  const show = useCallback((fromKeys = false) => {
    if (!version) return
    setInstant(fromKeys)
    setEver(true)
    setUnseen(null)
    setLast(localStorage.getItem(LAST))
    setAsk((a) => (a === 'answered' ? null : a))
    setOpen(true)
  }, [version])
  const close = useCallback((refocus = true) => {
    setOpen(false)
    setView(null)
    if (refocus) button.current?.focus({ preventScroll: true })
  }, [])

  // File › Share… (Cmd+E) and Ctrl+E: a keyboard action, so it opens and closes at once.
  useEffect(() => {
    const fn = () => {
      if (!openRef.current) return show(true)
      setInstant(true)
      close()
    }
    window.addEventListener(EXPORT_EVENT, fn)
    return () => window.removeEventListener(EXPORT_EVENT, fn)
  }, [show, close])

  // As tall as the window allows below the button, so the last row and Help improve are never cut off.
  useLayoutEffect(() => {
    if (!open) return
    const fit = () => {
      if (box.current && button.current) box.current.style.maxHeight = `${Math.min(660, window.innerHeight - button.current.getBoundingClientRect().bottom - 20)}px`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [open])
  useEffect(() => {
    if (ask === 'ask') helpRef.current?.scrollIntoView({ block: 'nearest' })
  }, [ask])

  // Focus follows the view: the first destination that can start, the phone panel's Back, then Send to my phone again.
  const shownView = open ? (view ? 'phone' : 'list') : null
  const lastView = useRef<string | null>(null)
  useEffect(() => {
    const from = lastView.current
    lastView.current = shownView
    if (!shownView || !box.current) return
    const target =
      shownView === 'phone' ? box.current.querySelector<HTMLElement>('[data-testid="phone-back"]')
        : from === 'phone' ? box.current.querySelector<HTMLElement>('[data-testid="share-phone"]')
        : box.current.querySelector<HTMLElement>('.sp-go:not(:disabled)')
    requestAnimationFrame(() => target?.focus({ preventScroll: true }))
  }, [shownView])

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const t = e.target as Node
      if (!box.current?.contains(t) && !button.current?.contains(t)) close(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      close()
    }
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('keydown', esc)
    }
  }, [open, close])

  // A preview is made full quality before it is exported, as this reel's job: its progress fills "Getting Version N ready".
  const preparing = Object.values(rows).some(isPrep)
  useEffect(() => {
    if (!preparing) {
      setPrepJob(null)
      return
    }
    return reel.jobs.onEvent((e) => {
      if (e.slug !== slug || e.type !== 'status') return
      setPrepJob(e.jobId)
      setRows((all) => Object.fromEntries(Object.entries(all).map(([key, r]) => [key, isPrep(r) ? { ...r, pct: e.overall } : r])))
    })
  }, [preparing, slug])

  const set = (key: string, row: Row | null) => {
    setRows((all) => {
      const next = { ...all }
      if (row) next[key] = row
      else delete next[key]
      return next
    })
    if (row && row.kind !== 'working' && !openRef.current) setUnseen(row.kind === 'done' ? 'done' : 'failed')
  }

  // After the first share that worked, ever: Help improve, asked once. It counts as asked the moment it shows.
  const shared = () => {
    const s = sharing.current
    if (!s || s.asked) return
    sharing.current = { ...s, asked: true }
    setAsk('ask')
    void reel.app.setSharing(sharing.current).catch(() => {})
  }
  const answer = (on: boolean) => {
    const s = sharing.current
    if (!s) return
    sharing.current = { ...s, asked: true, on, ...(on ? { usage: true, quality: true, posts: true } : {}) }
    setAsk('answered')
    void reel.app.setSharing(sharing.current).catch(() => {})
  }

  /** Saves the caption if it changed, after any save already on its way. Rejects when it couldn't be saved: nothing is shared then. */
  const saveCaption = async () => {
    if (saving.current) await saving.current
    if (caption === savedCaption.current) return
    const before = savedCaption.current
    savedCaption.current = caption
    const write = onSaveCaption(caption)
    saving.current = write
    const ok = await write
    if (saving.current === write) saving.current = null
    if (ok) return
    savedCaption.current = before
    throw { code: 'CAPTION', userMessage: "The caption wasn't saved, so nothing was shared. Try again." }
  }

  /** One export per version and caption: the caption file beside the video always holds the words that were copied. */
  const exported = (n: number): Promise<ExportResult> => {
    const key = `${n}|${savedCaption.current}`
    if (pending.current?.key === key) return pending.current.files
    const files = reel.projects.exportVersion(slug, n)
    pending.current = { key, files }
    files.catch(() => {
      if (pending.current?.files === files) pending.current = null
    })
    return files
  }

  /** Runs one destination: the caption saved, the version exported (once), then `go`. `go` returns the done line, or null for nothing to show. */
  const run = async (id: string, go: (files: ExportResult, progress: (row: Row) => void, key: string) => Promise<Done | null>) => {
    if (!version || disabled) return
    const key = `${version.n}|${id}`
    if (rows[key]?.kind === 'working') return
    localStorage.setItem(LAST, id)
    set(key, { kind: 'working', label: version.draft ? 'Making the full-quality version' : `Getting Version ${version.n} ready`, pct: null, prep: true })
    try {
      await saveCaption()
      const end = await go(await exported(version.n), (row) => set(key, row), key)
      set(key, end)
      if (end) shared()
    } catch (e) {
      set(key, errorCode(e) === 'CANCELLED' ? null : { kind: 'failed', message: userMessage(e) })
    } finally {
      cancels.current.delete(key)
    }
  }

  /** Opens a platform's post sheet for the exported version; Share steps aside for it, and Back returns to it. */
  const openSocial = (platform: 'instagram' | 'tiktok' | 'facebook' | 'threads' | 'x' | 'linkedin') =>
    void run(platform, async (files) => {
      const n = files.version
      const timeline = await reel.projects.timeline(slug, n).catch(() => null)
      close(false)
      setSocialSheet({ platform, version: n, hasCover: !!files.cover, durationSec: timeline?.duration ?? null })
      return null
    })
  const socialRow = (platform: 'instagram' | 'tiktok' | 'facebook' | 'threads' | 'x' | 'linkedin') => {
    const who = social && accountName(social, platform)
    return {
      id: platform,
      icon: platform === 'instagram' ? <Icon name="instagram" size={16} /> : <BrandMark name={platform} size={16} />,
      label: `Post to ${PLATFORM_NAMES[platform]}`,
      hint: who ? `To ${platform === 'instagram' || platform === 'threads' || platform === 'x' ? `@${who}` : who}` : 'Connect your account once',
      testid: `share-post-${platform}`,
      go: () => openSocial(platform)
    }
  }

  const destinations: { id: string; icon: ReactNode; label: string; hint: string; testid: string; go: () => void }[] = [
    social?.instagram.availability.open ? socialRow('instagram') : {
      id: 'instagram',
      icon: <Icon name="instagram" size={16} />,
      label: 'Save for Instagram',
      // Instagram can't be connected right now (the sign-in service can't be reached, or has no app for it), so the
      // row does what it can: the reel saved and its caption copied.
      hint: 'Saves the reel and copies the caption',
      testid: 'share-instagram',
      go: () =>
        void run('instagram', async (files) => {
          await reel.app.copyText(caption)
          return { kind: 'done', line: 'Ready for Instagram, caption copied', path: files.video }
        })
    },
    ...(posting?.enabled
      ? [{
          id: 'youtube',
          icon: <BrandMark name="youtube" size={16} />,
          label: 'Post to YouTube',
          hint: posting.youtube?.state === 'connected' && posting.youtube.channelName ? `To ${posting.youtube.channelName}` : 'Connect your channel once',
          testid: 'share-youtube',
          go: () =>
            void run('youtube', async (files) => {
              // the exported version: sharing the preview made it the next version, and a post is kept under that one
              const n = files.version
              const timeline = await reel.projects.timeline(slug, n).catch(() => null)
              // the sheet takes the window's middle: Share steps aside for it, and Back returns to it
              close(false)
              setPostSheet({ video: files.video, version: n, durationSec: timeline?.duration ?? null })
              return null
            })
        }]
      : []),
    ...(social?.tiktok.availability.open ? [socialRow('tiktok')] : []),
    ...(social?.facebook.availability.open ? [socialRow('facebook')] : []),
    ...(social?.threads.availability.open ? [socialRow('threads')] : []),
    ...(social?.x.availability.open ? [socialRow('x')] : []),
    ...(social?.linkedin.availability.open ? [socialRow('linkedin')] : []),
    {
      id: 'phone',
      icon: <Icon name="phone" size={16} />,
      label: 'Send to my phone',
      hint: "A code for your phone's camera",
      testid: 'share-phone',
      go: () =>
        void run('phone', async (files) => {
          // The link opens only while you can see the code; Share closed while the video got ready means not now.
          if (openRef.current) setView({ phone: files.video })
          return null
        })
    },
    ...(drives ?? []).map((drive) => {
      const name = driveName(drive)
      const id = `drive:${drive.folder}`
      return {
        id,
        icon: <BrandMark name={drive.label === 'iCloud Drive' ? 'icloud' : 'gdrive'} size={16} />,
        label: `Save to ${name}`,
        hint: 'Into a Reel Studio folder',
        testid: drive.label === 'iCloud Drive' ? 'save-icloud' : 'save-gdrive',
        go: () =>
          void run(id, async (files, progress, key) => {
            const job = saveToDrive(files.video, drive, (pct) => progress({ kind: 'working', label: `Saving to ${name} · ${pct}%`, pct }))
            cancels.current.set(key, job.cancel)
            progress({ kind: 'working', label: `Saving to ${name}`, pct: 0 })
            const path = await job.done
            return path ? { kind: 'done', line: `Saved to ${name}`, path } : null
          })
      }
    }),
    {
      id: 'finder',
      icon: <Icon name="folder" size={16} />,
      label: `Show in ${FOLDER_APP}`,
      hint: 'The reel, its cover and its caption',
      testid: 'share-finder',
      go: () =>
        void run('finder', async (files) => {
          await reel.app.openFolder(files.video)
          return { kind: 'done', line: `Saved as ${fileName(files.video)}`, path: files.video }
        })
    },
    {
      id: 'platforms',
      icon: <Icon name="layers" size={16} />,
      label: 'Other platforms',
      hint: 'TikTok, YouTube Shorts and 5 more, with Try 2',
      testid: 'share-platforms-toggle',
      go: () => setPlatformsOpen((o) => !o)
    }
  ]
  const ordered = shareOrder(destinations.map((d) => d.id), last).map((id) => destinations.find((d) => d.id === id)!)

  const working = [...Object.values(rows), ...(platformWork ? [platformWork] : [])].find((r): r is Extract<Work, { kind: 'working' }> => r.kind === 'working')
  const ring = !open && working
  // Share's own work (a preview made full quality first) also counts as a job; it must not lock Share out of its progress.
  const mine = Object.keys(rows).length > 0 || platformWork !== null
  const over = caption.length > INSTAGRAM_LIMIT

  return (
    <div className="share">
      <button
        ref={button}
        type="button"
        className={`btn${quiet ? '' : ' primary'} share-btn${ring || unseen ? ' busy' : ''}`}
        onClick={() => (open ? close() : show())}
        disabled={!version || (disabled && !open && !mine)}
        title={disabled && !mine ? why : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={ring || unseen ? 'share-busy' : undefined}
        data-testid="share"
      >
        {ring && <ProgressRing pct={ring.pct} />}
        {!ring && unseen && <span className={`share-dot ${unseen}`} aria-hidden />}
        Share
      </button>
      {(ring || unseen) && (
        <span id="share-busy" className="sr-only" role="status">
          {ring ? ring.label : unseen === 'done' ? 'Share finished' : 'Share stopped. Open Share to see why.'}
        </span>
      )}
      {ever && version && (
        <div
          ref={box}
          className={`pop share-pop${leaving ? ' leave' : ''}${instant ? ' instant' : ''}`}
          role="dialog"
          aria-labelledby={view ? undefined : 'share-h'}
          aria-label={view ? 'Send to my phone' : undefined}
          hidden={!mounted}
          inert={leaving || undefined}
          data-testid="share-pop"
        >
          {view && (
            <SendToPhone
              video={view.phone}
              caption={caption}
              onBack={() => setView(null)}
              onSent={() => {
                set(`${version.n}|phone`, { kind: 'done', line: 'Sent to your phone' })
                shared()
              }}
            />
          )}
          {/* Kept mounted under the phone panel, so Other platforms' work keeps its progress and Cancel. */}
          <div className="sp-main" hidden={!!view}>
            <h2 id="share-h" className="sp-h">{version.n ? `Share Version ${version.n}` : 'Share the preview'}</h2>
            {why && <p className="muted-sm sp-why">{why}</p>}
            {version.draft && !why && <p className="muted-sm sp-why">This is a preview. Sharing makes the full-quality version first.</p>}
            <div className="sp-cap">
              <label htmlFor="share-caption">Caption</label>
              <span className={`tnum${over ? ' sp-over' : ''}`}>{caption.length.toLocaleString()}/{INSTAGRAM_LIMIT.toLocaleString()}</span>
            </div>
            <textarea
              id="share-caption"
              className="textarea sp-caption"
              rows={3}
              value={caption}
              placeholder="A line or two to post under the reel"
              onChange={(e) => setCaption(e.target.value)}
              onBlur={() => void saveCaption().catch(() => {})}
              data-testid="share-caption"
            />
            <ul className="sp-list">
              {ordered.map((d, i) => {
                const key = `${version.n}|${d.id}`
                const row = rows[key]
                const isPlatforms = d.id === 'platforms'
                return (
                  <li key={d.id} className="sp-row">
                    <button
                      type="button"
                      className="sp-go"
                      onClick={d.go}
                      disabled={!isPlatforms && (disabled || row?.kind === 'working')}
                      aria-expanded={isPlatforms ? platformsOpen : undefined}
                      data-testid={d.testid}
                    >
                      <span className="sp-ic">{d.icon}</span>
                      <span className="sp-l">
                        <b>{d.label}</b>
                        <small>{d.hint}</small>
                      </span>
                      {i === 0 && last === d.id && <span className="sp-last">Last used</span>}
                      {isPlatforms && <Icon name="chevron-down" size={14} className={`sp-chev${platformsOpen ? ' open' : ''}`} />}
                    </button>
                    {row?.kind === 'done' && (
                      <p className="sp-done" role="status">
                        <Icon name="check" size={14} />
                        <span>
                          {row.line}
                          {row.path && (
                            <>
                              {' · '}
                              <button type="button" className="link inline" onClick={() => void reel.app.openFolder(row.path!)} aria-label={`Show in ${FOLDER_APP}`}>
                                Show
                              </button>
                            </>
                          )}
                        </span>
                      </p>
                    )}
                    {row && row.kind !== 'done' && (
                      <Strip
                        work={row}
                        onCancel={cancels.current.get(key) ?? (isPrep(row) && prepJob ? () => void reel.jobs.cancel(prepJob) : undefined)}
                        onRetry={disabled ? undefined : d.go}
                      />
                    )}
                    {isPlatforms && (
                      <div hidden={!platformsOpen}>
                        <SharePlatforms
                          slug={slug}
                          version={version}
                          caption={caption}
                          open={open && platformsOpen && !view}
                          disabled={disabled}
                          onWork={(w) => {
                            setPlatformWork(w)
                            if (w?.kind === 'failed' && !openRef.current) setUnseen('failed')
                          }}
                          beforeSave={saveCaption}
                          onSaved={() => {
                            localStorage.setItem(LAST, 'platforms')
                            if (!openRef.current) setUnseen('done')
                            shared()
                          }}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            {ask === 'ask' && (
              <div ref={helpRef} className="sp-help" data-testid="help-improve">
                <p>
                  <b>Help improve Reel Studio?</b> Share anonymous data: the features you use, a score for each edit and your posts’ view counts.
                </p>
                <p className="muted-sm">{NEVER_SHARED}</p>
                <div className="sp-help-b">
                  {/* "data", not "Share": inside Share's popover a bare Share reads as sharing the reel */}
                  <button type="button" className="btn small" onClick={() => answer(false)} data-testid="help-no">Don’t share data</button>
                  <button type="button" className="btn small" onClick={() => answer(true)} data-testid="help-yes">Share data</button>
                </div>
              </div>
            )}
            {ask === 'answered' && <p className="muted-sm sp-help-done" role="status">Saved. Change it any time in Settings › Privacy.</p>}
          </div>
        </div>
      )}
      {socialSheet && social && (
        <Modal onClose={() => !postBusy.current && setSocialSheet(null)} wide testid="social-dialog">
          <SocialPostSheet
            platform={socialSheet.platform}
            slug={slug}
            version={socialSheet.version}
            caption={caption}
            hasCover={socialSheet.hasCover}
            durationSec={socialSheet.durationSec}
            status={social}
            reload={reloadSocial}
            onBack={() => {
              setSocialSheet(null)
              show()
            }}
            onClose={() => setSocialSheet(null)}
            onBusy={setPostBusy}
          />
        </Modal>
      )}
      {postSheet && (
        <Modal onClose={() => !postBusy.current && setPostSheet(null)} wide testid="post-dialog">
          <PostSheet
            video={postSheet.video}
            slug={slug}
            version={postSheet.version}
            title={title}
            caption={caption}
            durationSec={postSheet.durationSec}
            onBack={() => {
              setPostSheet(null)
              show()
            }}
            onClose={() => setPostSheet(null)}
            onBusy={setPostBusy}
          />
        </Modal>
      )}
    </div>
  )
}

/** On the Share pill while Share is closed: how far the running destination has got, or a turning arc until it knows. */
function ProgressRing({ pct }: { pct: number | null }) {
  return (
    <svg className={`share-ring${pct === null ? ' run' : ''}`} viewBox="0 0 16 16" width={14} height={14} aria-hidden>
      <circle cx="8" cy="8" r="6.5" className="track" />
      <circle cx="8" cy="8" r="6.5" className="fill" pathLength={100} strokeDasharray={`${pct === null ? 28 : Math.max(4, pct)} 100`} />
    </svg>
  )
}
