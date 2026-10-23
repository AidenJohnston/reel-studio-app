import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatAction, ChecklistItem, ExportResult, ProjectDetail, ProviderInfo } from '../../../shared/api'
import { ACTION_LABELS } from '../../../shared/notes'
import { clock } from '../../../shared/progress'
import { EMPTY_LIVE, liveFromDetail, reduceLive, timeLeftWords, type LiveState } from '../../../shared/live'
import { reel, userMessage } from '../api'
import type { Go } from '../nav'
import { Check, Confirm, FOLDER_APP, Modal, MoreMenu, Progress, Spinner, Thinking } from '../components/ui'
import { SendToPhone } from '../components/SendToPhone'
import { PlatformExportDialog } from '../components/PlatformExportDialog'
import { Icon } from '../components/icons'
import { PhonePlayer, type SubtitleLook } from '../components/Player'
import { EXPORT_EVENT, NOTE_DROP_DONE, useNotify } from '../App'
import { ShowMeHow, type Tab } from './ShowMeHow'
import { AttachmentChips, AttachmentThumb, useNoteAttachments } from '../components/NoteAttachments'

const ACTION_TAB: Partial<Record<ChatAction, Tab>> = {
  'open-cut': 'cut',
  'open-captions': 'captions',
  'open-music': 'music',
  'open-broll': 'broll',
  'open-cover': 'cover',
  'open-post': 'post',
  'open-editor': 'cut'
}

// What a manual change is called while it is being made (grandma 2: a colour change said "Adding pictures").
const CHANGE_LABEL: Record<Tab, string> = {
  cut: 'Updating your cut',
  captions: 'Updating your subtitles',
  music: 'Updating your music',
  broll: 'Updating your pictures',
  cover: 'Updating your cover',
  post: 'Updating your video'
}

const INSTAGRAM_URL = 'https://www.instagram.com/'
const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const bannerKey = (slug: string): string => `rs.banner-dismissed.${slug}`
const IG_KEY = 'rs.instagram-overlay'

export function Reel({ slug, go, fresh }: { slug: string; go: Go; fresh?: boolean }) {
  const notify = useNotify()
  const [d, setD] = useState<ProjectDetail | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [note, setNote] = useState('')
  // The running job (a note, a re-render), folded from its events (shared/live.ts). null = nothing running.
  const [job, setJob] = useState<LiveState | null>(null)
  const [drawer, setDrawer] = useState<Tab | null>(null)
  const [exporting, setExporting] = useState<'busy' | ExportResult | null>(null)
  const [platformPicker, setPlatformPicker] = useState(false)
  const [phoneFirst, setPhoneFirst] = useState(false) // export straight into "Send to my phone"
  const [postDraft, setPostDraft] = useState<string | null>(null)
  const [provider, setProvider] = useState<ProviderInfo | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [bannerHidden, setBannerHidden] = useState(() => localStorage.getItem(bannerKey(slug)) === '1')
  const [igOverlay, setIgOverlay] = useState(() => localStorage.getItem(IG_KEY) === '1')
  const [holding, setHolding] = useState(false)
  const [duration, setDuration] = useState<number | null>(null)
  // Live subtitle preview from the drawer's Subtitles tab.
  const [preview, setPreview] = useState<{ look: SubtitleLook; text: string; at: number } | null>(null)
  const chatEnd = useRef<HTMLDivElement>(null)
  // pictures, GIFs and clips on the note being written (components/NoteAttachments.tsx)
  const att = useNoteAttachments(slug, notify)
  const [noteDrop, setNoteDrop] = useState(false)
  const noteDropDepth = useRef(0)

  const load = useCallback(
    async (selectLatest = false) => {
      try {
        const next = await reel.projects.get(slug)
        setD(next)
        if (next.job) setJob((cur) => (cur?.jobId === next.job!.id ? cur : liveFromDetail(next.job!)))
        const latest = next.versions[next.versions.length - 1]?.n ?? null
        setSelected((cur) => (selectLatest || cur === null || !next.versions.some((v) => v.n === cur) ? latest : cur))
      } catch (e) {
        notify(userMessage(e), 'error')
        go({ name: 'home' })
      }
    },
    [slug, go, notify]
  )

  useEffect(() => {
    void load(true)
    reel.ai.active().then(setProvider).catch(() => {})
    return reel.jobs.onEvent((e) => {
      if (e.slug !== slug) return
      if (e.type === 'status' || e.type === 'reply' || e.type === 'tool') setJob((cur) => reduceLive(cur ?? EMPTY_LIVE, e))
      // a quick preview of the change: play it in the phone until the full-quality version is done
      else if (e.type === 'render' && e.draft) {
        setJob((cur) => reduceLive(cur ?? EMPTY_LIVE, e))
        void load()
      }
      else if (e.type === 'done' || e.type === 'error' || e.type === 'cancelled') {
        setJob(null)
        void load(e.type === 'done' && e.version !== undefined)
      }
    })
  }, [slug, load])

  // Scroll only the chat box to its last message. scrollIntoView would also scroll the page and
  // push the progress and the note box below the fold (grandma3 #10).
  useEffect(() => {
    const box = chatEnd.current?.parentElement
    if (box) box.scrollTop = box.scrollHeight
  }, [d?.chat.length, job])
  // While a version is being made, keep its progress and the note box in view, where the person
  // just typed (the page scrolls on small windows).
  const progressRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!job?.jobId) return
    composerRef.current?.scrollIntoView({ block: 'nearest' })
    progressRef.current?.scrollIntoView({ block: 'nearest' })
  }, [job?.jobId, d?.chat.length])

  const version = d ? (d.versions.find((v) => v.n === selected) ?? d.versions[d.versions.length - 1]) : undefined
  // while a change is being made: its quick preview (a draft render), until the new version is done
  const changePreview = job?.preview?.video ?? null

  const doExport = useCallback(async (toPhone = false) => {
    if (!version || job || exporting) return
    setPhoneFirst(toPhone)
    setExporting('busy')
    try {
      setExporting(await reel.projects.exportVersion(slug, version.n))
    } catch (e) {
      setExporting(null)
      notify(userMessage(e), 'error')
    }
  }, [version, job, exporting, slug, notify])

  // Cmd/Ctrl+E and File > Export.
  useEffect(() => {
    const fn = () => { if (!platformPicker) void doExport() }
    window.addEventListener(EXPORT_EVENT, fn)
    return () => window.removeEventListener(EXPORT_EVENT, fn)
  }, [doExport, platformPicker])

  if (!d) return <div className="page"><Spinner /></div>

  const aiOff = !provider || !provider.connected || provider.id === 'none'
  const connect = () => go({ name: 'connect', back: { name: 'reel', slug } })
  // What each version changed, from the chat ("Version 3: bigger yellow subtitles."), for the button tooltips.
  const versionNote = new Map<number, string>()
  for (const m of d.chat) if (m.from === 'editor' && m.version) versionNote.set(m.version, m.text)

  const send = async () => {
    const text = note.trim()
    const files = att.chips
    if ((!text && !files.length) || att.busy) return
    setNote('')
    att.clear()
    try {
      const r = await reel.projects.note(slug, text, files.length ? files.map((f) => f.asset) : undefined)
      // null = no AI editor: the note and a plain answer are in the chat, nothing is running.
      if (r.jobId) setJob((cur) => (cur?.jobId === r.jobId ? cur : { ...EMPTY_LIVE, jobId: r.jobId, message: 'Reading your note' }))
      await load()
    } catch (e) {
      setNote(text)
      att.restore(files)
      notify(userMessage(e), 'error')
    }
  }
  const canSend = (!!note.trim() || att.chips.length > 0) && !job && !att.busy
  // Files dropped on the note box are attached to the note. The window-wide drop (App.tsx: a video makes
  // a new reel) must not see them, so the drop stops here; App clears its overlay on NOTE_DROP_DONE.
  const noteDropProps = {
    'data-note-drop': true,
    onDragEnter: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
      noteDropDepth.current++
      setNoteDrop(true)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = job ? 'none' : 'copy'
    },
    onDragLeave: () => {
      noteDropDepth.current = Math.max(0, noteDropDepth.current - 1)
      if (!noteDropDepth.current) setNoteDrop(false)
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      noteDropDepth.current = 0
      setNoteDrop(false)
      window.dispatchEvent(new Event(NOTE_DROP_DONE))
      if (job) return
      att.onDropFiles(e.dataTransfer)
    }
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

  const rerender = async (change = '', message = 'Making a new version with your changes') => {
    try {
      const r = await reel.projects.rerender(slug, change, message)
      setJob((cur) => (cur?.jobId === r.jobId ? cur : { ...EMPTY_LIVE, jobId: r.jobId, message }))
      setDrawer(null)
      setPreview(null)
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  /** "Add a song": pick a song on this computer, use it, make a new version. */
  const addSong = async () => {
    try {
      const added = (await reel.library.choose('music')).find((r) => r.bin === 'music' && r.dest)
      if (!added) return
      // project.json only takes Library-relative paths (secfix), never the absolute dest.
      const name = fileName(added.dest!)
      const track = `Library/Music/${name}`
      await reel.projects.update(slug, { music: { ...(d.project.music ?? {}), enabled: true, track, startAt: 0, level: 'under-voice' } })
      await rerender(`new song "${name.replace(/\.[^.]+$/, '')}"`, 'Adding your song')
    } catch (e) {
      notify(userMessage(e), 'error')
    }
  }

  const savePost = async (text: string, quiet = false): Promise<boolean> => {
    const caption = text.trim()
    if (caption === (d.project.post?.caption ?? '').trim()) return true
    try {
      await reel.projects.update(slug, { post: { hashtags: [], keywords: [], ...(d.project.post ?? {}), caption } })
      await load()
      if (!quiet) notify(caption ? 'Saved. Copy it when you post.' : 'Post caption cleared.')
      return true
    } catch (e) {
      notify(userMessage(e), 'error')
      return false
    }
  }

  const runAction = (a: ChatAction, messageId: string) => {
    if (a === 'remember-yes' || a === 'remember-no') {
      reel.style
        .answer(slug, messageId, a === 'remember-yes')
        .then(() => load())
        .catch((e) => notify(userMessage(e), 'error'))
    } else if (a === 'connect') connect()
    else setDrawer(ACTION_TAB[a] ?? 'cut')
  }

  // "What I did": what is done (filled checks, each with a way to change it), then optional extras
  // as plain links. No empty circles that read like unfinished homework (critique 1.3).
  const doneLine = (c: ChecklistItem): { label: string; detail?: string; act?: { label: string; run: () => void; testid: string } } => {
    switch (c.key) {
      case 'cut':
        return {
          label: d.aiEdited ? 'Kept your best takes' : 'Cut the pauses and repeated starts',
          detail: duration ? `${clock(duration)} long` : undefined,
          act: { label: 'See what I cut', run: () => setDrawer('cut'), testid: 'check-cut' }
        }
      case 'captions':
        return { label: c.label, act: { label: 'Change', run: () => setDrawer('captions'), testid: 'change-captions' } }
      case 'music':
        return { label: c.label, detail: c.detail, act: { label: 'Change', run: () => setDrawer('music'), testid: 'change-music' } }
      case 'broll':
        return { label: c.label, act: { label: 'Change', run: () => setDrawer('broll'), testid: 'change-pictures' } }
      case 'cover':
        return { label: c.label, act: { label: 'Change', run: () => setDrawer('cover'), testid: 'change-cover' } }
      case 'post':
        return { label: c.label, act: { label: 'Edit', run: () => setPostDraft(d.project.post?.caption ?? ''), testid: 'write-post' } }
      default:
        return { label: c.label, detail: c.detail }
    }
  }
  const extras: { key: string; label: string; run: () => void; testid: string }[] = []
  for (const c of d.checklist) {
    if (c.done) continue
    if (c.key === 'music') extras.push({ key: c.key, label: 'Add a song', run: () => void addSong(), testid: 'add-song' })
    if (c.key === 'broll') extras.push({ key: c.key, label: 'Add pictures', run: () => setDrawer('broll'), testid: 'add-pictures' })
    if (c.key === 'post') extras.push({ key: c.key, label: 'Write a post caption', run: () => setPostDraft(d.project.post?.caption ?? ''), testid: 'write-post' })
    if (c.key === 'captions') extras.push({ key: c.key, label: 'Turn subtitles on', run: () => setDrawer('captions'), testid: 'change-captions' })
  }
  const done = d.checklist.filter((c) => c.done)

  const many = d.versions.length > 1
  const exportLabel = version && many ? `Export Version ${version.n}` : 'Export for Instagram'

  return (
    <div className={`page reel-page${fresh ? ' fresh' : ''}`}>
      <div className="reel">
        <div className="reel-left">
          <PhonePlayer
            key={changePreview ?? version?.video ?? 'none'}
            src={changePreview ?? version?.video ?? null}
            poster={version?.cover}
            autoPlayMuted={!!changePreview || (fresh && version?.n === d.versions[d.versions.length - 1]?.n)}
            subtitle={drawer === 'captions' && preview ? preview : null}
            still={drawer === 'captions' && preview && d.sourceVideo ? `${d.sourceVideo}#t=${preview.at.toFixed(2)}` : null}
            stillMirrored={d.project.sources?.[0]?.mirror === true}
            instagram={igOverlay}
            caption={d.project.post?.caption}
            original={d.sourceVideo}
            holdingOriginal={holding}
            onDuration={setDuration}
            dragFile={version && !version.draft ? version.videoPath : null}
          />
          {changePreview && (
            <p className="muted-sm center" data-testid="change-preview">Here's your change. I'm making the full-quality version.</p>
          )}
          <div className="phone-tools">
            <button
              className={`tool${igOverlay ? ' on' : ''}`}
              aria-pressed={igOverlay}
              onClick={() => {
                localStorage.setItem(IG_KEY, igOverlay ? '0' : '1')
                setIgOverlay(!igOverlay)
              }}
              title="See where Instagram's buttons and caption will sit"
              data-testid="ig-toggle"
            >
              <Icon name="instagram" size={16} /> Instagram view
            </button>
            {d.sourceVideo && (
              <button
                className={`tool${holding ? ' on' : ''}`}
                onPointerDown={() => setHolding(true)}
                onPointerUp={() => setHolding(false)}
                onPointerLeave={() => setHolding(false)}
                onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && setHolding(true)}
                onKeyUp={() => setHolding(false)}
                title="Press and hold to see your video before I edited it"
                data-testid="hold-original"
              >
                <Icon name="original" size={16} /> Hold for original
              </button>
            )}
          </div>
          {d.versions.length > 0 && (
            <div className="chips" data-testid="versions" role="radiogroup" aria-label="Versions">
              {d.versions.map((v) => (
                <button
                  key={v.n}
                  role="radio"
                  aria-checked={v.n === version?.n}
                  className={`chip${v.n === version?.n ? ' active' : ''}`}
                  onClick={() => setSelected(v.n)}
                  title={versionNote.get(v.n)}
                >
                  {v.n === 0 ? 'Preview' : `Version ${v.n}`}
                </button>
              ))}
            </div>
          )}
          {job && (
            // Right above the greyed buttons, so the reason is next to what it explains (grandma3 #10).
            <p className="export-wait" data-testid="export-wait">
              <Spinner /> Wait for this version to finish
            </p>
          )}
          <div className="split-btn export-btn">
            <button className="btn primary big" onClick={() => void doExport()} disabled={!version || !!job} data-testid="export" title={job ? 'Wait for this version to finish' : undefined}>
              <Icon name="upload" /> {exportLabel}
            </button>
            <MoreMenu
              label="More ways to export"
              icon="chevron-down"
              triggerClassName="btn primary big"
              testid="export-more"
              disabled={!version || !!job}
              up
              items={[{ label: 'Other platforms…', run: () => setPlatformPicker(true), testid: 'export-platforms' }]}
            />
          </div>
          <button className="btn export-btn" onClick={() => void doExport(true)} disabled={!version || !!job} data-testid="send-to-phone-reel" title={job ? 'Wait for this version to finish' : undefined}>
            <Icon name="send" /> Send to my phone
          </button>
        </div>

        <div className="reel-right">
          <div className="reel-head">
            <div style={{ minWidth: 0, flex: 1 }}>
              <button className="back" style={{ marginBottom: 2 }} onClick={() => go({ name: 'home' })}>
                <Icon name="back" size={16} /> My videos
              </button>
              {renaming === null ? (
                <div className="row" style={{ gap: 4 }}>
                  <h1 className="reel-title" title="Click to rename" onClick={() => setRenaming(d.title)} data-testid="title">
                    {d.title}
                  </h1>
                  <button className="btn small ghost" onClick={() => setRenaming(d.title)} data-testid="rename">
                    Rename
                  </button>
                </div>
              ) : (
                <input
                  className="input"
                  autoFocus
                  value={renaming}
                  aria-label="Video name"
                  style={{ fontSize: 20, fontWeight: 700 }}
                  onChange={(e) => setRenaming(e.target.value)}
                  onBlur={() => void rename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void rename()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  data-testid="title-input"
                />
              )}
            </div>
            <button className="btn" onClick={() => setDrawer('cut')} data-testid="edit-myself">
              <Icon name="pencil" size={16} /> Edit it myself
            </button>
            <MoreMenu
              label="More for this video"
              items={[
                { label: 'Rename', run: () => setRenaming(d.title) },
                { label: 'Delete this video…', run: () => setConfirmDelete(true), danger: true, disabled: !!job, testid: 'delete' }
              ]}
            />
          </div>

          {aiOff && !bannerHidden && (
            <div className="banner" data-testid="ai-banner">
              <span>No AI editor yet, so I made a simple cut. Connect one and I can pick your best takes, add pictures and change the video from your notes.</span>
              <button className="btn small" onClick={connect} data-testid="banner-connect">
                Connect
              </button>
              <button
                className="icon-btn"
                aria-label="Hide this"
                title="Hide this"
                onClick={() => {
                  localStorage.setItem(bannerKey(slug), '1')
                  setBannerHidden(true)
                }}
                data-testid="banner-close"
              >
                <Icon name="x" />
              </button>
            </div>
          )}

          <section className="panel did" data-testid="what-i-did">
            <h2>What I did</h2>
            <ul className="checklist two">
              {done.map((c) => {
                const line = doneLine(c)
                return (
                  <li key={c.key} data-testid={`did-${c.key}`}>
                    <Check done />
                    <div style={{ minWidth: 0 }}>
                      <span className="did-label">{line.label}</span>
                      {line.detail && <span className="muted-sm"> · {line.detail}</span>}
                      {line.act && !job && (
                        <button className="item-action" onClick={line.act.run} data-testid={line.act.testid}>
                          {line.act.label}
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
            {extras.length > 0 && !job && (
              <div className="extras" data-testid="extras">
                <span className="muted-sm">Optional extras:</span>
                {extras.map((x) => (
                  <button key={x.key} className="extra" onClick={x.run} data-testid={x.testid}>
                    <Icon name="plus" size={14} stroke={2} /> {x.label}
                  </button>
                ))}
              </div>
            )}
            {postDraft !== null && (
              <div className="stack" style={{ marginTop: 14 }} data-testid="post-editor">
                <label className="muted-sm" htmlFor="post-draft">
                  The caption under your post on Instagram. It is not in the video.
                </label>
                <textarea
                  id="post-draft"
                  className="textarea"
                  style={{ minHeight: 80 }}
                  autoFocus
                  value={postDraft}
                  placeholder={`For example: ${d.title}. Say in a line or two what the video is about.`}
                  onChange={(e) => setPostDraft(e.target.value)}
                  data-testid="post-input"
                />
                <div className="row">
                  <button
                    className="btn primary small"
                    onClick={async () => {
                      if (await savePost(postDraft ?? '')) setPostDraft(null)
                    }}
                    data-testid="post-save"
                  >
                    Save post caption
                  </button>
                  <button className="btn ghost small" onClick={() => setPostDraft(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="panel notes-panel">
            <h2>Notes for your editor</h2>
            <div className="chat" data-testid="chat">
              {d.chat.length === 0 && !job && (
                <p className="muted-sm">Watch your reel, then tell me what to change. For example: "music too loud at the start".</p>
              )}
              {d.chat.map((m) => (
                <div key={m.id} className={`bubble ${m.from}`} data-testid={`bubble-${m.from}`}>
                  {m.attachments?.length ? (
                    <div className="bubble-attachments" data-testid="bubble-attachments">
                      {m.attachments.map((a) => (
                        <AttachmentThumb key={a.asset} a={a} size="bubble" />
                      ))}
                    </div>
                  ) : null}
                  {m.text}
                  {m.from === 'editor' && m.actions?.length ? (
                    <div className="bubble-actions">
                      {m.actions.map((a) => (
                        <button
                          key={a}
                          className={`btn small${a === 'connect' ? '' : ' primary'}`}
                          onClick={() => runAction(a, m.id)}
                          disabled={!!job && a !== 'connect'}
                          data-testid={`action-${a}`}
                        >
                          {ACTION_LABELS[a]}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {job?.reply && (
                // a fast note's reply, known before its render is done; the saved copy replaces it at the end
                <div className="bubble editor reply-pending" data-testid="bubble-reply">
                  {job.reply}
                </div>
              )}
              <div ref={chatEnd} />
            </div>
            {job && (
              // Outside the scrolling chat, so the progress can never be scrolled or cut out of sight.
              <div className="job-progress" ref={progressRef} data-testid="note-progress">
                <div className="row" style={{ marginBottom: 8 }}>
                  {job.thinking ? <Thinking /> : <Spinner />} <span>{job.message}</span>
                  <span className="spacer" />
                  <span className="muted-sm" data-testid="note-time-left">{timeLeftWords(job) ?? ''}</span>
                  <button className="link" onClick={() => job.jobId && reel.jobs.cancel(job.jobId)} style={{ padding: 0, marginLeft: 12 }}>
                    Stop
                  </button>
                </div>
                <Progress pct={job.overall} label={job.message} />
              </div>
            )}
            <div className={`note-drop${noteDrop ? ' over' : ''}`} {...noteDropProps} data-testid="note-drop">
            {noteDrop && <div className="note-drop-hint">Drop to attach it to your note</div>}
            <AttachmentChips chips={att.chips} busy={att.busy} onRemove={(a) => void att.remove(a)} />
            <div className={`composer${aiOff ? ' no-ai' : ''}`} ref={composerRef}>
              <button
                className="btn attach-btn"
                onClick={att.choose}
                disabled={!!job}
                aria-label="Attach a picture or a clip"
                title="Attach a picture or a clip"
                data-testid="note-attach"
              >
                <Icon name="paperclip" size={18} />
              </button>
              <div className="composer-box">
              <textarea
                className="input composer-input"
                rows={1}
                placeholder={aiOff ? 'Connect an AI editor to change things by typing' : 'Tell your editor what to change…'}
                aria-label="Note for your editor"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onPaste={att.onPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                disabled={!!job}
                data-testid="note-input"
              />
              {aiOff && !note.trim() && (
                <button className="btn small in-box" onClick={connect} data-testid="composer-connect">
                  Connect
                </button>
              )}
              </div>
              <button className={`btn${canSend ? ' primary' : ''}`} onClick={() => void send()} disabled={!canSend} data-testid="send" aria-label="Send">
                <Icon name="send" size={16} /> Send
              </button>
            </div>
            </div>
          </section>
        </div>
      </div>

      {drawer && (
        <ShowMeHow
          d={d}
          initialTab={drawer}
          version={version ?? null}
          onClose={() => {
            setDrawer(null)
            setPreview(null)
          }}
          onChanged={() => load()}
          onRerender={(change, label) => void rerender(change, label ?? (drawer ? CHANGE_LABEL[drawer] : undefined))}
          onPreview={setPreview}
          onTab={(t) => setDrawer(t)}
        />
      )}

      {confirmDelete && (
        <Confirm
          title="Delete this video?"
          body="This removes all its versions from Reel Studio. Anything you exported stays in Finished videos."
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

      {platformPicker && version && <PlatformExportDialog slug={slug} version={version} post={d.project.post} jobId={job?.jobId || undefined} status={job?.message} onClose={() => setPlatformPicker(false)} />}
      {exporting && <ExportDialog result={exporting} phoneFirst={phoneFirst} onClose={() => setExporting(null)} onSaveCaption={(t) => savePost(t, true)} />}
    </div>
  )
}

/**
 * After Export: the file is on the computer, Instagram is on the phone. Everything needed to post
 * is in this one box: where the file is, the post caption (edit and copy it here), and how to get
 * the video to Instagram. Never "go back and export again" for text that is not in the video.
 */
function ExportDialog({
  result,
  phoneFirst,
  onClose,
  onSaveCaption
}: {
  result: 'busy' | ExportResult
  phoneFirst?: boolean
  onClose: () => void
  onSaveCaption: (t: string) => Promise<boolean>
}) {
  const [opened, setOpened] = useState(false)
  const [phone, setPhone] = useState(!!phoneFirst)
  const [caption, setCaption] = useState(result === 'busy' ? '' : result.caption)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (result !== 'busy') setCaption(result.caption)
  }, [result])

  if (result === 'busy')
    return (
      <Modal testid="export-dialog">
        <h2>Getting it ready for Instagram</h2>
        <div className="row">
          <Spinner /> <span className="muted">This takes a moment.</span>
        </div>
      </Modal>
    )

  // "Send to my phone" (components/SendToPhone.tsx): a QR code that opens this video on the phone.
  if (phone)
    return (
      <Modal onClose={onClose} wide testid="export-dialog">
        <SendToPhone video={result.video} caption={caption} onBack={() => setPhone(false)} />
      </Modal>
    )

  return (
    <Modal onClose={onClose} wide testid="export-dialog">
      <div className="export-head">
        {result.cover && <img className="cover-img" style={{ width: 84 }} src={`reel-media://f/${encodeURIComponent(result.cover)}`} alt="" />}
        <div className="stack" style={{ gap: 6, minWidth: 0 }}>
          {/* says plainly that it is saved, and where (grandma3 #8, #17) */}
          <h2 data-testid="export-saved">Saved to your computer</h2>
          <p className="muted-sm">Ready to post. Find it any time in Library › Finished videos:</p>
          <p className="file-pill" data-testid="export-name" title={result.video}>
            <Icon name="video" size={16} /> {fileName(result.video)}
          </p>
          <div className="row">
            <button
              className="btn small"
              onClick={async () => {
                await reel.app.openFolder(result.video)
                setOpened(true)
              }}
              data-testid="show-in-folder"
            >
              <Icon name="folder" size={16} /> Show in {FOLDER_APP}
            </button>
          </div>
          {opened && (
            <p className="muted-sm" data-testid="opened">
              I opened {FOLDER_APP} with your video selected.
            </p>
          )}
        </div>
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <label className="field-label" htmlFor="export-caption">
          Post caption <span className="muted-sm">(you paste this into Instagram)</span>
        </label>
        <textarea
          id="export-caption"
          className="textarea"
          style={{ minHeight: 84 }}
          value={caption}
          placeholder="Write a line or two about your video. You can also leave it empty."
          onChange={(e) => {
            setCaption(e.target.value)
            setCopied(false)
          }}
          onBlur={() => void onSaveCaption(caption)}
          data-testid="export-caption"
        />
        <div className="row">
          <button
            className="btn small"
            disabled={!caption.trim()}
            data-testid="copy-caption"
            onClick={async () => {
              await reel.app.copyText(caption)
              void onSaveCaption(caption)
              setCopied(true) // the button says "Copied"; no toast on top of the dialog
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Copied' : 'Copy caption'}
          </button>
        </div>
      </div>

      <div className="post-how">
        <p>Instagram is on your phone? Send the video there in one step. Or upload it at instagram.com.</p>
        <div className="stack" style={{ gap: 8 }}>
          <button className="btn primary big" onClick={() => setPhone(true)} data-testid="send-to-phone">
            <Icon name="send" size={16} /> Send to my phone
          </button>
          <a className="btn small" href={INSTAGRAM_URL} target="_blank" rel="noreferrer" data-testid="open-instagram">
            <Icon name="instagram" size={16} /> Open Instagram
          </a>
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={onClose} data-autofocus>
          Done
        </button>
      </div>
    </Modal>
  )
}
