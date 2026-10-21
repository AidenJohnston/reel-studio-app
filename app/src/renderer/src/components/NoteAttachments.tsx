// Pictures, GIFs and short clips on a note (0.1.2 F2): paste, drop, the paperclip button, and the chips
// above the note box. The rules (what can be attached, how many, which paste is a file and which is
// text) live in shared/attachments.ts; main copies the files through the engine and re-checks them.
import { useCallback, useRef, useState } from 'react'
import type { AttachResult, NoteAttachment } from '../../../shared/api'
import { MSG, addChips, chipBadge, planDrop, planPaste, slotsLeft, type FileLike, type IncomingPlan } from '../../../shared/attachments'
import { reel, userMessage } from '../api'
import { Icon } from './icons'
import { Spinner } from './ui'

type Notify = (text: string, kind?: 'error') => void

function fileLike(f: File): FileLike {
  let path = ''
  try {
    path = reel.app.pathForFile(f) || ''
  } catch {
    path = ''
  }
  return { name: f.name, type: f.type, size: f.size, path }
}

/** The chips of one note and every way to add to them. */
export function useNoteAttachments(slug: string, notify: Notify) {
  const [chips, setChips] = useState<NoteAttachment[]>([])
  const [busy, setBusy] = useState(0)
  const chipsRef = useRef<NoteAttachment[]>([])
  chipsRef.current = chips
  const busyRef = useRef(0)

  const take = useCallback(
    async (r: AttachResult) => {
      const { chips: next, dropped } = addChips(chipsRef.current, r.attached)
      chipsRef.current = next
      setChips(next)
      const errors = [...new Set(r.errors)]
      if (dropped) {
        // copied while the note filled up: take the extras back out of the project
        for (const a of r.attached.filter((x) => !next.some((c) => c.asset === x.asset))) void reel.notes.remove(slug, a.asset).catch(() => undefined)
        if (!errors.includes(MSG.tooMany)) errors.push(MSG.tooMany)
      }
      if (errors.length) notify(errors.join(' '), 'error')
    },
    [slug, notify]
  )

  const run = useCallback(
    async (fn: () => Promise<AttachResult>) => {
      busyRef.current++
      setBusy(busyRef.current)
      try {
        await take(await fn())
      } catch (e) {
        notify(userMessage(e), 'error')
      } finally {
        busyRef.current--
        setBusy(busyRef.current)
      }
    },
    [take, notify]
  )

  /** Carries out a paste or drop plan; `files` are the Files the plan's `blobs` point into. */
  const apply = useCallback(
    async (plan: IncomingPlan, files: File[]) => {
      if (plan.errors.length) notify([...new Set(plan.errors)].join(' '), 'error')
      let room = slotsLeft(chipsRef.current.length, busyRef.current)
      const want = plan.paths.length + plan.blobs.length + (plan.clipboard ? 1 : 0)
      if (!want) return
      if (want > room) notify(MSG.tooMany, 'error')
      const paths = plan.paths.slice(0, room).map((p) => p.path)
      room -= paths.length
      const blobs = plan.blobs.slice(0, room)
      room -= blobs.length
      const jobs: Promise<void>[] = []
      if (paths.length) jobs.push(run(() => reel.notes.attachFiles(slug, paths)))
      for (const i of blobs) {
        const f = files[i]
        jobs.push(run(async () => reel.notes.attachData(slug, { name: f.name, mime: f.type, bytes: new Uint8Array(await f.arrayBuffer()) })))
      }
      if (plan.clipboard && room > 0) jobs.push(run(() => reel.notes.attachClipboard(slug)))
      await Promise.all(jobs)
    },
    [slug, run, notify]
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const dt = e.clipboardData
      const files = Array.from(dt.files ?? [])
      const plan = planPaste({
        files: files.map(fileLike),
        items: Array.from(dt.items ?? []).map((it) => ({ kind: it.kind, type: it.type })),
        text: dt.getData('text/plain')
      })
      if (!plan.handle) return // plain text: the box pastes it as usual
      e.preventDefault()
      void apply(plan, files)
    },
    [apply]
  )

  const onDropFiles = useCallback(
    (dt: DataTransfer) => {
      const files = Array.from(dt.files ?? [])
      const types = Array.from(dt.types ?? [])
      void apply(planDrop({ files: files.map(fileLike), uriOnly: !files.length && types.includes('text/uri-list') }), files)
    },
    [apply]
  )

  const choose = useCallback(() => {
    if (!slotsLeft(chipsRef.current.length, busyRef.current)) {
      notify(MSG.tooMany, 'error')
      return
    }
    void run(() => reel.notes.choose(slug))
  }, [slug, run, notify])

  const remove = useCallback(
    async (asset: string) => {
      const next = chipsRef.current.filter((c) => c.asset !== asset)
      chipsRef.current = next
      setChips(next)
      try {
        await reel.notes.remove(slug, asset)
      } catch (e) {
        notify(userMessage(e), 'error')
      }
    },
    [slug, notify]
  )

  /** After the note is sent: its chips went with it. */
  const clear = useCallback(() => {
    chipsRef.current = []
    setChips([])
  }, [])

  return { chips, busy, onPaste, onDropFiles, choose, remove, clear }
}

/** Small thumbnail of one attached file: the still, plus "GIF" or the clip's length. */
export function AttachmentThumb({ a, size = 'chip' }: { a: NoteAttachment; size?: 'chip' | 'bubble' }) {
  const badge = chipBadge(a)
  return (
    <span className={`att-thumb ${size}`} title={a.name}>
      {a.thumbUrl ? <img src={a.thumbUrl} alt={a.name} draggable={false} /> : <Icon name={a.kind === 'video' ? 'video' : 'image'} size={18} />}
      {badge && <span className="att-badge">{badge}</span>}
    </span>
  )
}

export function AttachmentChips({ chips, busy, onRemove }: { chips: NoteAttachment[]; busy: number; onRemove: (asset: string) => void }) {
  if (!chips.length && !busy) return null
  return (
    <div className="att-chips" data-testid="note-attachments">
      {chips.map((a) => (
        <span key={a.asset} className="att-chip" data-testid="note-attachment">
          <AttachmentThumb a={a} />
          <span className="att-name">{a.name}</span>
          <button className="att-remove" onClick={() => onRemove(a.asset)} aria-label={`Remove ${a.name}`} title="Remove" data-testid="note-attachment-remove">
            <Icon name="x" size={14} stroke={2} />
          </button>
        </span>
      ))}
      {busy > 0 && (
        <span className="att-chip busy" data-testid="note-attachment-busy">
          <Spinner /> <span className="att-name">Adding your file</span>
        </span>
      )}
    </div>
  )
}
