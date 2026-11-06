import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatAction, QueuedNote, ScriptResult, VersionRow } from '../../../shared/api'
import { ACTION_LABELS } from '../../../shared/notes'
import { momentLabel } from '../../../shared/moments'
import { editorSaid, waitingRows, withoutNumber, type LogEntry, type LogResult } from '../../../shared/notes-log'
import { versionFact } from '../../../shared/version-diff'
import { reel, userMessage } from '../api'
import { Icon } from './icons'
import { Button, PickFiles } from './ui'
import { AttachmentThumb } from './NoteAttachments'
import { Thinking } from './ui'

/** "What changed" under a version: its before → after rows, read once when first opened. */
export function useVersionRows(slug: string): { rows: Map<number, VersionRow[] | null>; want: (n: number) => void } {
  const [rows, setRows] = useState(() => new Map<number, VersionRow[] | null>())
  const asked = useRef(new Set<number>())
  const want = useCallback(
    (n: number) => {
      if (asked.current.has(n)) return
      asked.current.add(n)
      reel.projects
        .versionRows(slug, n)
        .then((r) => setRows((m) => new Map(m).set(n, r)))
        .catch(() => setRows((m) => new Map(m).set(n, null)))
    },
    [slug]
  )
  return { rows, want }
}

export function VersionRows({ rows, asked }: { rows: VersionRow[] | null | undefined; asked?: ReactNode }) {
  return (
    <div className="detail">
      {asked}
      {rows?.map((r) => (
        <div className="drow" key={r.label}>
          <span>{r.label}</span>
          <span className="ba" title={r.title}>
            {r.before && (
              <>
                <s>{r.before}</s>
                <span className="arr" aria-label="changed to">
                  →
                </span>
              </>
            )}
            <b>{r.after}</b>
          </span>
        </div>
      ))}
    </div>
  )
}

/** Version 1 before it exists: being made, paused, or failed. */
export type FirstState =
  | { kind: 'making'; heard: string[]; editor: boolean }
  /** `why`: paused without you, and when it goes on (shared/pause.ts); null when the person pressed Stop */
  | { kind: 'paused'; why: string | null }
  /** `another`: the file is the cause (or was never copied in), so the way on is another video, not Try again */
  | { kind: 'failed'; why: string; extra?: ReactNode; another?: 'primary' | 'secondary' }

const VIDEO_TYPES = 'video/*,.mov,.mp4,.m4v'

/**
 * Notes for your editor: each thing you asked (a light bubble on the right) and what came of it (a line on the left).
 * A version's line plays it and says in a few words what its rows changed; What changed opens the rows (open on the
 * newest only), with the editor's own words above them when they say more, and Compare.
 * Older entries fold behind one line once the list is taller than its column.
 */
export function NotesLog({
  slug,
  madeWith,
  entries,
  queue,
  held,
  latest,
  first,
  shown,
  making,
  busy,
  aiOn,
  basic,
  landed,
  unwatched,
  empty,
  plan,
  versionRows,
  onPlay,
  onCompare,
  onAction,
  onRetry,
  onEditHand,
  onResume,
  onBasic,
  onAnotherVideo,
  onCopy,
  onError,
  answerError,
  pausedWhy,
  label = 'Notes for your editor'
}: {
  slug: string
  /** the model that made each version, by its number (VersionInfo.madeWith): its line names it */
  madeWith?: Record<number, string>
  entries: LogEntry[]
  queue: QueuedNote[]
  held: boolean
  latest: number
  first: FirstState | null
  /** the version on screen */
  shown: number | null
  /** the version being made now, if any */
  making: number | null
  busy: boolean
  aiOn: boolean
  /** Version 1 was made without an editor */
  basic: boolean
  /** the version that just landed: its line enters */
  landed: number | null
  /** a version that landed while you compared or edited by hand */
  unwatched: number | null
  /** shown when there is nothing yet (a reel with no video) */
  empty?: ReactNode
  /** the reel's Plan card: under the editor's newest plan, or on its own (made in the form, or folded above the video) */
  plan?: ReactNode
  versionRows: ReturnType<typeof useVersionRows>
  onPlay: (n: number) => void
  onCompare: (n: number) => void
  onAction: (a: ChatAction, messageId: string) => void
  onRetry: (e: LogEntry) => void
  /** Opens Edit it myself on a waiting hand edit. */
  onEditHand: (id: string) => void
  onResume: () => void
  onBasic: () => void
  /** Version 1 failed because of its video: another one starts it again */
  onAnotherVideo: (paths: string[]) => void
  onCopy: (text: string) => void
  onError: (message: string) => void
  /** saving a "Remember this for next time?" answer failed: the question keeps its buttons */
  answerError: { id: string; text: string } | null
  /** a note paused without you (a plan at its limit): why, and when it goes on */
  pausedWhy: string | null
  /** The log's accessible name: planning a reel reuses this log as its chat. */
  label?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const [folded, setFolded] = useState(0)
  const [unfolded, setUnfolded] = useState(false)
  const waiting = waitingRows(queue, entries)

  // The newest version shows what changed until the person folds it. Every version line says what its rows changed,
  // so each one's rows are read once.
  const isOpen = (n: number) => open[n] ?? n === latest
  const { want } = versionRows
  const versionsShown = entries.flatMap((e) => (e.result?.kind === 'version' ? [e.result.v] : [])).join()
  useEffect(() => {
    for (const v of versionsShown.split(',')) if (v) want(Number(v))
  }, [versionsShown, want])

  // Older entries fold behind one line while the list is taller than its column; new ones are added at the bottom.
  // It stays at the bottom only while the person is there: scrolling up to read stays put while a job reports.
  const size = `${entries.length}:${waiting.length}:${first?.kind ?? ''}`
  const lastSize = useRef(size)
  const atBottom = useRef(true)
  useLayoutEffect(() => {
    if (lastSize.current !== size) {
      lastSize.current = size
      setFolded(0)
      return
    }
    const el = box.current
    if (!el) return
    if (!unfolded && el.scrollHeight > el.clientHeight + 1 && folded < entries.length - 2) setFolded((f) => f + 1)
    else if (atBottom.current) el.scrollTop = el.scrollHeight
  })
  const onScroll = () => {
    const el = box.current
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  const toggle = (n: number) => setOpen((o) => ({ ...o, [n]: !isOpen(n) }))

  const version = (e: LogEntry, v: number, said: string) => {
    const on = isOpen(v)
    const rows = versionRows.rows.get(v)
    // Version 1 made without an editor says so; the rows say what it did
    const fact = v === 1 && basic ? 'Basic version' : rows ? versionFact(rows) : ''
    // What was said about it, when that says something the rows don't (a note's reply, a style rule it used). A change
    // made by hand is all in its rows. With no rows to show (nothing on the list changed, or an old version's
    // snapshot is gone) its words are all there is.
    const words = e.ask.kind === 'hand' || rows === undefined ? null : rows === null || !rows.length ? withoutNumber(said) || null : editorSaid(said)
    return (
      <>
        <div className={`nt-res${shown === v ? ' cur' : ''}${landed === v ? ' enter' : ''}`} data-v={v}>
          <span className="nk ok">
            <Icon name="check" size={12} stroke={2.4} />
          </span>
          <button className="v" onClick={() => onPlay(v)} aria-label={`Play Version ${v}`} data-testid={`log-play-${v}`}>
            Version {v}
          </button>
          <span className="sep" aria-hidden>
            ·
          </span>
          {fact && (
            <>
              <span className="t fact" data-testid={`version-fact-${v}`}>
                {fact}
              </span>
              <span className="sep" aria-hidden>
                ·
              </span>
            </>
          )}
          {madeWith?.[v] && (
            <>
              <span className="t by" title={`Made with ${madeWith[v]}`} data-testid={`version-model-${v}`}>
                {madeWith[v]}
              </span>
              <span className="sep" aria-hidden>
                ·
              </span>
            </>
          )}
          {unwatched === v ? (
            <button className="lk" onClick={() => onPlay(v)} data-testid="log-watch">
              Is ready · Watch
            </button>
          ) : (
            <button className="lk" aria-expanded={on} onClick={() => toggle(v)} data-testid={`what-changed-${v}`}>
              What changed
            </button>
          )}
          {shown === v && shown !== latest && <span className="onscreen">On screen</span>}
        </div>
        <div className={`acc${on ? ' open' : ''}`} inert={!on || undefined}>
          <div>
            <VersionRows rows={rows} asked={words && <p className="said selectable">{words}</p>} />
            {v > 1 && (
              <div className="dacts">
                <button className="lk" onClick={() => onCompare(v)} data-testid={`compare-${v}`}>
                  <Icon name="compare" size={14} /> Compare with Version {v - 1}
                </button>
              </div>
            )}
          </div>
        </div>
      </>
    )
  }

  const firstLine = (f: FirstState) => {
    if (f.kind === 'making')
      return (
        <>
          <div className="nt-res quiet" aria-busy>
            {/* pending, not live: the tray under the log has the one spinner and the time left */}
            <span className="nk">
              <span className="wait-dot" />
            </span>
            <span className="t">Making Version 1</span>
          </div>
          {f.heard.length > 0 && (
            <p className="heard selectable" data-testid="heard">
              <b>{f.editor ? 'I heard' : 'Heard'}</b> {f.heard.slice(0, 80).join(' ')}
              {f.heard.length > 80 ? '…' : ''}
            </p>
          )}
        </>
      )
    if (f.kind === 'paused')
      return (
        <div className="nt-res paused" data-testid="first-paused">
          <span className="nk pause">
            <Icon name="pause" size={10} stroke={2.4} />
          </span>
          <span className="t wrap full" data-testid="first-paused-why">
            Paused. {f.why ?? 'Resume continues where it stopped.'}
          </span>
          <Button kind="primary" size="small" onClick={onResume} data-testid="resume">
            {f.why ? 'Resume now' : 'Resume'}
          </Button>
        </div>
      )
    return (
      <>
        <div className="nt-res" role="alert" data-testid="first-failed">
          <span className="nk err">
            <Icon name="x" size={12} stroke={2.4} />
          </span>
          <span className="t wrap">Didn't finish. {f.why}</span>
        </div>
        <div className="nt-acts">
          {f.another ? (
            <PickFiles kind={f.another} size="small" label="Choose another video" accept={VIDEO_TYPES} onFiles={onAnotherVideo} testid="another-video" />
          ) : (
            <>
              <Button kind="primary" size="small" onClick={onResume} data-testid="retry-first">
                Try again
              </Button>
              <Button size="small" onClick={onBasic} data-testid="basic-first">
                Make a basic version
              </Button>
            </>
          )}
        </div>
        {f.extra}
      </>
    )
  }

  const result = (e: LogEntry, r: LogResult) => {
    switch (r.kind) {
      case 'version':
        return version(e, r.v, r.text)
      case 'making':
        return (
          <div className="nt-res quiet" aria-busy>
            <span className="nk">
              <span className="wait-dot" />
            </span>
            <span className="t">Making Version {r.v}</span>
          </div>
        )
      case 'writing':
        // the strip under the log names the step or the wait, with Stop
        return (
          <div className="nt-res quiet pl-answering" aria-busy data-testid="plan-answering">
            <span className="nk" />
            <Thinking />
          </div>
        )
      case 'question':
        return (
          <div className="nt-res reply asks pl-said" data-testid="plan-question">
            <span className="nk" />
            <span className="t wrap selectable">{r.text}</span>
          </div>
        )
      case 'proposed':
        return (
          <>
            <div className="nt-res quiet reply pl-said" data-testid="plan-said">
              <span className="nk" />
              <span className="t wrap selectable">{r.text}</span>
            </div>
            {r.card && <div className="pl-wrap">{plan}</div>}
          </>
        )
      case 'script':
        return <Script s={r.script} onCopy={onCopy} />
      case 'failed':
        return (
          <div className="nt-res" role="alert">
            <span className="nk err">
              <Icon name="x" size={12} stroke={2.4} />
            </span>
            <span className="t wrap">{r.text}</span>
            {e.ask.kind === 'note' && aiOn && (
              <button className="lk" disabled={busy} onClick={() => onRetry(e)} data-testid="log-retry">
                Try again
              </button>
            )}
          </div>
        )
      case 'paused':
        return (
          <div className="nt-res paused" data-testid="log-paused">
            <span className="nk pause">
              <Icon name="pause" size={10} stroke={2.4} />
            </span>
            <span className="t wrap full">Paused. {pausedWhy ?? 'It waits below.'}</span>
          </div>
        )
      case 'stopped':
        return (
          <div className="nt-res" data-testid="log-stopped">
            <span className="nk stop">
              <Icon name="stop" size={10} stroke={2.4} />
            </span>
            <span className="t">Stopped. {r.kept ? `Version ${r.kept} is unchanged.` : 'Nothing changed.'}</span>
            {e.ask.kind === 'note' && aiOn && (
              <button className="lk" disabled={busy} onClick={() => onRetry(e)} data-testid="log-retry">
                Send again
              </button>
            )}
          </div>
        )
      case 'reply':
        return <Reply text={r.text} actions={r.actions} id={r.messageId} busy={busy} onAction={onAction} />
    }
  }

  const foldedVersions = entries.slice(0, folded).filter((e) => e.result?.kind === 'version').length
  const shownEntries = unfolded ? entries : entries.slice(folded)
  return (
    <div className="log" ref={box} onScroll={onScroll} role="log" aria-label={label} data-testid="chat">
      {!unfolded && folded > 0 && (
        <button className="fold" aria-expanded={false} onClick={() => setUnfolded(true)} data-testid="log-unfold">
          <Icon name="chevron-down" size={14} />
          {foldedVersions === folded ? `${folded} earlier ${folded === 1 ? 'version' : 'versions'}` : `${folded} earlier ${folded === 1 ? 'note' : 'notes'}`}
        </button>
      )}
      {entries.length === 0 && empty}
      {shownEntries.map((e) => (
        <article key={e.key} className="nt" data-testid={`log-${e.ask.kind}`}>
          {e.day && <div className="nday">{e.day}</div>}
          {e.ask.kind === 'plan' ? (
            plan
          ) : (
            <div className="nt-ask">
              <p className="bubble selectable">
                {e.ask.kind === 'video' && <Icon name="video" size={14} stroke={1.75} />}
                {e.ask.kind === 'hand' && <Icon name="sliders" size={14} stroke={1.75} />}
                {e.ask.kind === 'note' && e.ask.moment && <span className="tm">{momentLabel(e.ask.moment)}</span>}
                {e.ask.text}
                {e.ask.kind === 'note' && e.ask.attachments.length > 0 && (
                  <span className="q-att">
                    {e.ask.attachments.map((a) => (
                      <AttachmentThumb key={a.asset} a={a} size="chip" />
                    ))}
                  </span>
                )}
              </p>
            </div>
          )}
          {e.key === 'video' && first ? firstLine(first) : e.result && result(e, e.result)}
          {e.extra.map((m) => (
            <Reply
              key={m.id}
              text={m.text}
              actions={m.actions ?? []}
              id={m.id}
              busy={busy}
              onAction={onAction}
              question={!!(m.suggestion || m.proposal)}
              scope={m.proposal?.source.version}
              error={answerError?.id === m.id && m.actions?.length ? answerError.text : undefined}
            />
          ))}
        </article>
      ))}
      {waiting.map((q, i) => (
        <QueuedRow key={q.id} slug={slug} q={q} i={i} count={waiting.length} held={held} on={latest + (making ? 1 : 0) + i} onEditHand={onEditHand} onError={onError} />
      ))}
    </div>
  )
}

/** The editor's script for a reel planned before it had a video: the hook, what to say, the words on screen. */
function Script({ s, onCopy }: { s: ScriptResult; onCopy: (t: string) => void }) {
  const all = [s.hook, s.script, ...(s.onScreenText.length ? ['', 'On screen:', ...s.onScreenText] : [])].join('\n')
  return (
    <div className="script" data-testid="script">
      <p className="sc-hook selectable">{s.hook}</p>
      <p className="sc-body selectable">{s.script}</p>
      {s.onScreenText.length > 0 && (
        <p className="sc-screen">
          <span>On screen</span> {s.onScreenText.join(' · ')}
        </p>
      )}
      <button className="lk" onClick={() => onCopy(all)} data-testid="script-copy">
        <Icon name="copy" size={14} /> Copy
      </button>
    </div>
  )
}

function Reply({
  text,
  actions,
  id,
  busy,
  onAction,
  question,
  scope,
  error
}: {
  text: string
  actions: ChatAction[]
  id: string
  busy: boolean
  onAction: (a: ChatAction, id: string) => void
  /** a "Remember this for next time?" question: focus returns here once it is answered */
  question?: boolean
  /** the version a typed My style rule comes from */
  scope?: number
  error?: string
}) {
  const shown = actions.filter((a) => a !== 'connect')
  // a reply that asks something waits on the person: it reads as the editor talking, not as a hint
  const asks = question || /\?["”’)]?\s*$/.test(text)
  return (
    <div className={`nt-res reply${asks ? ' asks' : ' quiet'}`} id={`msg-${id}`} tabIndex={question ? -1 : undefined} data-testid="bubble-editor">
      <span className="nk" />
      <span className="t wrap selectable">
        {text}
        {scope !== undefined && (
          <span className="bubble-meta" data-testid="remember-scope">
            For new reels. From Version {scope} of this reel.
          </span>
        )}
        {error && (
          <span className="bubble-meta error" role="alert" data-testid="remember-error">
            {error}
          </span>
        )}
        {shown.length > 0 && (
          <span className="reply-acts">
            {shown.map((a) => (
              <button key={a} className="lk" disabled={busy} onClick={() => onAction(a, id)} data-testid={`action-${a}`}>
                {a === 'remember-yes' && error ? 'Try again' : ACTION_LABELS[a]}
              </button>
            ))}
          </span>
        )}
      </span>
    </div>
  )
}

/** A note waiting its turn: its words can change, it can go, and with others waiting it can move (grip, or arrow keys on it). */
function QueuedRow({ slug, q, i, count, held, on, onEditHand, onError }: { slug: string; q: QueuedNote; i: number; count: number; held: boolean; on: number; onEditHand: (id: string) => void; onError: (m: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const act = (p: Promise<unknown>) => void p.catch((e) => onError(userMessage(e)))
  const move = async (to: number) => {
    const by = to > i ? 1 : -1
    for (let k = i; k !== to; k += by) await reel.queue.move(slug, q.id, by)
  }
  const many = count > 1
  const save = () => {
    const t = (draft ?? '').trim()
    setDraft(null)
    if (t && t !== q.text) act(reel.queue.edit(slug, q.id, t))
  }
  return (
    <article
      className={`nt queued${over ? ' over' : ''}`}
      data-testid="queue-row"
      draggable={many && draft === null}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-rs-queue', String(i))
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('application/x-rs-queue')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const from = Number(e.dataTransfer.getData('application/x-rs-queue'))
        if (!Number.isInteger(from) || from === i) return
        e.preventDefault()
        e.stopPropagation()
        act(
          (async () => {
            const by = i > from ? 1 : -1
            const id = (await reel.projects.get(slug)).queue.filter((x) => !x.attempt)[from]?.id
            if (!id) return
            for (let k = from; k !== i; k += by) await reel.queue.move(slug, id, by)
          })()
        )
      }}
    >
      <div className="nt-ask">
        {many && (
          <button
            className="grip"
            aria-label="Move this note. Use the up and down arrow keys."
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
              e.preventDefault()
              const to = i + (e.key === 'ArrowUp' ? -1 : 1)
              if (to >= 0 && to < count) act(move(to))
            }}
            data-testid="queue-grip"
          >
            <Icon name="grip" size={14} />
          </button>
        )}
        {q.hand ? (
          <p className="bubble waiting" data-testid="queue-hand">
            Your edit ({q.hand.changes} {q.hand.changes === 1 ? 'change' : 'changes'})
          </p>
        ) : draft === null ? (
          <p className="bubble waiting">
            {q.moment && <span className="tm">{momentLabel(q.moment)}</span>}
            {q.text}
          </p>
        ) : (
          <input
            className="input q-edit"
            autoFocus
            value={draft}
            aria-label="Change this note"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save()
              if (e.key === 'Escape') setDraft(null)
            }}
            data-testid="queue-edit-input"
          />
        )}
      </div>
      <div className="nt-res quiet">
        <span className="nk">
          <span className="wait-dot" />
        </span>
        <span className="t">{held ? 'Held until you send it' : `${i === 0 ? 'Next' : 'Then'}, on Version ${on}`}</span>
        {draft === null && (
          <>
            <button className="lk" onClick={() => (q.hand ? onEditHand(q.id) : setDraft(q.text))} data-testid="queue-edit">
              Edit
            </button>
            <button className="lk" onClick={() => act(reel.queue.cancel(slug, q.id))} data-testid="queue-cancel">
              Cancel
            </button>
          </>
        )}
      </div>
    </article>
  )
}
