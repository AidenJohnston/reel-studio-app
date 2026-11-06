// "Notes for your editor": the reel's history as one list, oldest first. Each entry is what you asked
// (your video, a note, or a change you made yourself) and what came of it. Built from app.json's chat and
// version records only. Keep free of Node and DOM imports.
import type { ChatAction, ChatMessage, NoteAttachment, NoteMoment, ReelPlan, ScriptResult, VersionInfo, VersionMade } from './api'
import { HAND_VERBS } from './describe'
import { withoutWordIds } from './moments'

export type LogAsk =
  | { kind: 'video'; text: string }
  | { kind: 'note'; text: string; moment: NoteMoment | null; attachments: NoteAttachment[] }
  | { kind: 'hand'; text: string }
  /** the reel's Plan card on its own: made in the plain form, or folded above the video once it arrived */
  | { kind: 'plan'; text: string }

export type LogResult =
  | { kind: 'version'; v: number; text: string }
  | { kind: 'making'; v: number }
  | { kind: 'failed'; text: string }
  | { kind: 'stopped'; kept: number }
  /** stopped by a plan at its limit: it waits in the queue and goes on by itself (shared/pause.ts) */
  | { kind: 'paused' }
  /** an answer that made no version: the no-AI reply, or a question back */
  | { kind: 'reply'; text: string; actions: ChatAction[]; messageId: string }
  /** the editor's script for a reel planned before it had a video, from before planning was a chat */
  | { kind: 'script'; script: ScriptResult }
  /** the editor is answering in the planning chat */
  | { kind: 'writing' }
  /** a question back in the planning chat */
  | { kind: 'question'; text: string }
  /** the editor's line with a plan it proposed; `card`: the newest one, which shows the reel's Plan card */
  | { kind: 'proposed'; text: string; card: boolean }

export interface LogEntry {
  key: string
  /** set on the first entry of each day */
  day: string | null
  ask: LogAsk
  result: LogResult | null
  /** editor lines after the result, such as "Remember this for next time?" */
  extra: ChatMessage[]
}

const DONE_FAIL = "That didn't work, and nothing changed."

/** The queued notes the log shows as waiting rows. One that did not finish (failed or stopped) keeps its place in the
 * queue to try again but shows once: as its own line, with Try again. One running shows as its progress line. */
export function waitingRows<Q extends { id: string; attempt?: unknown }>(queue: Q[], entries: Pick<LogEntry, 'key' | 'result'>[]): Q[] {
  return queue.filter((q) => !q.attempt && !entries.some((e) => e.key === q.id && (e.result?.kind === 'failed' || e.result?.kind === 'stopped')))
}

/** Version 1 failed because of the file itself: trying it again fails the same way, and a basic version needs the
 * same sound and picture. Codes from the engine (music.py, probe.py, init.py, placement.py) and the stand-in engine. */
const FILE_FAILURES: ReadonlySet<string> = new Set(['NO_AUDIO', 'SILENT', 'NOT_FOUND', 'UNREADABLE', 'NO_VIDEO', 'NOT_VIDEO', 'TOO_SHORT'])
export const failedByFile = (code: string | null | undefined): boolean => !!code && FILE_FAILURES.has(code)

/** A change made in Edit it myself, as its line in the notes: "You added a picture and a sound effect." A summary
 * saved before these were verbs ("new song …") keeps its words after "Your changes:". */
export function handLine(summary: string | undefined): string {
  const s = summary?.trim()
  if (!s) return 'You changed it yourself'
  return HAND_VERBS.has(s.split(' ')[0]) ? `You ${s}.` : `Your changes: ${s}`
}

/** What was said about a version, for What changed, or null when it says nothing the rows don't: "It is Version 3.",
 * an echo of the note ("Done: …") and a basic version's first sentence (its line says "Basic version", its rows what
 * it did) add nothing. What follows them, such as "Subtitles are lowercase, from My style.", stays. */
export function editorSaid(text: string): string | null {
  const s = withoutNumber(text).replace(/^Basic version: [^.]*\.\s*/, '')
  if (!s || /^Done: ".*"\.?$/.test(s) || /^I made your change\.?$/.test(s)) return null
  return s
}

/** What a note sends again: the person's note as stored, never the log's line for it. Throws when the log's entry
 * names no note of theirs, rather than sending something else. */
export function noteToRetry(chat: ChatMessage[], key: string): string {
  const m = chat.find((c) => c.id === key && c.from === 'you')
  if (!m) throw new Error(`no note of yours with id ${key} to send again`)
  return m.text
}

/** The words said about a version without "It is Version 3.", which its line already says. */
export const withoutNumber = (text: string): string => text.replace(/\s*It is Version \d+\.?/g, '').trim()

export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' })
}

/** The first row: the file the person brought in, or each of them for a reel cut from several (at most three by name). */
function yourVideos(sources: { path: string; originalName?: string }[]): string {
  const names = sources.map((x) => x.originalName || x.path.split(/[\\/]/).pop() || x.path)
  if (names.length <= 1) return names.length ? `Your video, ${names[0]}` : 'Your video'
  const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names
  return `Your ${names.length} videos, ${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

export function notesLog(input: {
  chat: ChatMessage[]
  made: VersionMade[]
  versions: VersionInfo[]
  /** the job running now, if any, and whether it is the first edit, a change made by hand or a script */
  running: { id: string; kind: 'first-edit' | 'note' | 'hand' | 'script' } | null
  /** the reel has no video yet: only its planning shows */
  planned?: boolean
  /** the reel's plan (app.json `plan`): once the video is in, its planning folds into the one Plan card */
  plan?: ReelPlan | null
  /** the raw takes as project.json lists them: `originalName` is the file the person brought in, `path` the copy (media/take01.mp4) */
  sources: { path: string; originalName?: string }[]
  now: Date
}): LogEntry[] {
  const { made, versions, running, now } = input
  // the guard: the moment wrapper and words lists the app writes for the AI never show in an editor's line, whatever an
  // editor or an old build saved. The person's own notes are shown and retried exactly as they wrote them.
  const chat = input.chat.map((m) => (m.from === 'editor' && withoutWordIds(m.text) !== m.text ? { ...m, text: withoutWordIds(m.text) } : m))
  const latest = versions[versions.length - 1]?.n ?? 0
  const first: LogEntry & { at: string } = {
    key: 'video',
    day: null,
    at: versions[0]?.createdAt ?? chat.find((m) => !m.plan)?.at ?? now.toISOString(),
    ask: { kind: 'video', text: yourVideos(input.sources) },
    result: null,
    extra: []
  }
  type Entry = LogEntry & { at: string; outcome?: ChatMessage['outcome']; jobId?: string }
  // what was said while planning comes first: the idea, then the script the editor wrote for it
  const plan: Entry[] = []
  for (const m of chat.filter((x) => x.plan)) {
    const last = plan[plan.length - 1]
    if (m.from === 'you') {
      const result: LogResult | null = running && m.jobId === running.id ? { kind: 'writing' } : m.outcome === 'stopped' ? { kind: 'stopped', kept: 0 } : null
      plan.push({ key: m.id, day: null, at: m.at, ask: { kind: 'note', text: m.text, moment: null, attachments: [] }, result, extra: [], outcome: m.outcome, jobId: m.jobId })
    } else if (last && !last.result)
      last.result = m.script
        ? { kind: 'script', script: m.script }
        : m.planTurn === 'question'
          ? { kind: 'question', text: m.text }
          : m.planTurn === 'plan'
            ? { kind: 'proposed', text: m.text, card: false }
            : { kind: 'failed', text: m.text }
    else last?.extra.push(m)
  }
  if (input.plan) {
    const newest = [...plan].reverse().find((e) => e.result?.kind === 'proposed')
    if (!input.planned) {
      // planning is done: the conversation folds into the plan it made, above the video
      const at = plan[0]?.at ?? first.at
      plan.splice(0, plan.length, { key: 'plan', day: null, at, ask: { kind: 'plan', text: input.plan.topic }, result: null, extra: [] })
    } else if (newest?.result?.kind === 'proposed') newest.result = { ...newest.result, card: true }
    // made in the plain form: no editor proposed it
    else plan.push({ key: 'plan', day: null, at: now.toISOString(), ask: { kind: 'plan', text: input.plan.topic }, result: null, extra: [] })
  }
  const entries: Entry[] = input.planned ? plan : [...plan, first]
  let open: Entry | null = input.planned ? null : first

  for (const m of chat.filter((x) => !x.plan)) {
    // more reels from this video: its job has no note, so its lines follow whatever the log shows last
    if (m.reels) {
      entries[entries.length - 1]?.extra.push(m)
      continue
    }
    if (m.from === 'you') {
      open = { key: m.id, day: null, at: m.at, ask: { kind: 'note', text: m.text, moment: m.moment ?? null, attachments: m.attachments ?? [] }, result: null, extra: [], outcome: m.outcome, jobId: m.jobId }
      entries.push(open)
      continue
    }
    // A job's reply carries its id (main/jobs.ts). Try again runs a note again under a new job and moves the note's
    // line to that job, so: a reply goes to the note whose current attempt wrote it, wherever it landed in the chat,
    // and an earlier attempt's reply (no version, under a note now tried again) is not shown. Replies from before
    // jobs tagged them pair by order, as below.
    if (m.from === 'editor' && m.jobId !== undefined) {
      const owner = entries.find((e) => e.ask.kind === 'note' && e.jobId === m.jobId)
      if (owner) {
        // "Remember this for next time?" keeps its Yes and No under the note; it is never what came of it
        if (owner.result || m.suggestion || m.proposal) owner.extra.push(m)
        else if (m.version === undefined) owner.result = owner.outcome === 'failed' ? { kind: 'failed', text: m.text } : { kind: 'reply', text: m.text, actions: m.actions ?? [], messageId: m.id }
        else if (owner.outcome !== 'stopped' && owner.outcome !== 'failed' && owner.outcome !== 'paused') owner.result = { kind: 'version', v: m.version, text: m.text }
        else owner.extra.push(m)
        continue
      }
      if (m.version === undefined && open?.ask.kind === 'note' && !open.result && open.jobId !== undefined) continue
    }
    if (m.version !== undefined) {
      // a stopped or failed note made no version: one that follows it was made some other way
      if (open && !open.result && open.outcome !== 'stopped' && open.outcome !== 'failed' && open.outcome !== 'paused') open.result = { kind: 'version', v: m.version, text: m.text }
      else {
        const record = made.find((r) => r.version === m.version && r.by === 'hand')
        const what = record?.summary.trim()
        open = { key: m.id, day: null, at: m.at, ask: { kind: 'hand', text: handLine(what) }, result: { kind: 'version', v: m.version, text: m.text }, extra: [] }
        entries.push(open)
      }
      continue
    }
    const last = entries[entries.length - 1]
    if (!last) continue
    if (open && open.ask.kind === 'note' && !open.result && !m.suggestion && !m.proposal) {
      open.result = open.outcome === 'failed' ? { kind: 'failed', text: m.text } : { kind: 'reply', text: m.text, actions: m.actions ?? [], messageId: m.id }
    } else last.extra.push(m)
  }

  for (const e of entries.slice(plan.length)) {
    if (e.result) continue
    if (e === first) {
      if (versions.length) e.result = { kind: 'version', v: versions[0].n, text: 'First edit' }
      else if (running?.kind === 'first-edit') e.result = { kind: 'making', v: 1 }
    } else if (running && e.jobId === running.id) e.result = { kind: 'making', v: latest + 1 }
    else if (e.outcome === 'stopped') e.result = { kind: 'stopped', kept: latest }
    else if (e.outcome === 'paused') e.result = { kind: 'paused' }
    else if (e.outcome === 'failed') e.result = { kind: 'failed', text: DONE_FAIL }
  }
  if (running?.kind === 'hand') entries.push({ key: running.id, day: null, at: now.toISOString(), ask: { kind: 'hand', text: 'Your changes' }, result: { kind: 'making', v: latest + 1 }, extra: [] })

  let day = ''
  return entries.map(({ key, at, ask, result, extra }) => {
    const label = dayLabel(at, now)
    const e: LogEntry = { key, day: label !== day ? label : null, ask, result, extra }
    day = label
    return e
  })
}
