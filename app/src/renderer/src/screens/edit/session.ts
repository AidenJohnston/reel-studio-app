// What "Edit it myself" holds while it is open, and after it closes: closing asks nothing, and the changes stay
// until Undo or Make Version (ux-foundation-b.md section 6). One session per reel for as long as the app runs.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectDetail, ProjectJson, QueuedNote } from '../../../../shared/api'
import { keptIds } from '../../../../shared/cut'
import { applyHandEdit, countChanges, diffProject, type HandEdit } from '../../../../shared/hand-edit'
import type { Draft } from '../../../../shared/timeline-edit'

export type { Draft }

export interface Session {
  /** the project the changes are measured from: the newest one seen, so the preview shows what the next version will */
  base: Draft
  /** the waiting hand edit being changed, and its edit as it waits */
  queued: { id: string; edit: HandEdit } | null
  /** that edit once it started, until project.json says it landed (`handEdits`): the base includes it meanwhile */
  landing: { id: string; edit: HandEdit } | null
  /** every state, oldest first; Undo steps back one */
  history: Draft[]
  /** a run of typing in one box is one step of Undo */
  lastKey: string | null
}

/** By reel, and by the waiting edit being changed (`slug:id`), so opening one never drops the other. */
const sessions = new Map<string, Session>()
const keyOf = (slug: string, queued: QueuedNote | null): string => `${slug}:${queued?.id ?? ''}`

const draftOf = (d: ProjectDetail, p: ProjectJson): Draft => ({ p, kept: new Set(keptIds(d.words, p.cut?.keep)) })

/** The same changes, measured again from a newer project (a note landed while they waited). */
function rebase(s: Session, d: ProjectDetail, to: ProjectJson): Session {
  const moved = (x: Draft): Draft => draftOf(d, applyHandEdit(to, diffProject(s.base.p, x.p, s.base.kept, x.kept), d.words))
  return { ...s, base: draftOf(d, to), history: s.history.map(moved) }
}

/** The waiting edit started: from now on the changes are measured from what it makes, so undoing one of its
 * changes is kept as a change of its own. */
function started(s: Session, d: ProjectDetail): Session {
  return { ...s, queued: null, landing: s.queued, base: draftOf(d, applyHandEdit(s.base.p, s.queued!.edit, d.words)) }
}

/** The session after `d` arrived: measured from its project, and from what a waiting edit makes once it started. */
export function follow(cur: Session, d: ProjectDetail): Session {
  let s = cur.queued && !d.queue.some((q) => q.id === cur.queued!.id && !q.attempt) ? started(cur, d) : cur
  const landed = (d.project.handEdits as string[] | undefined)?.includes(s.landing?.id ?? '')
  if (landed) s = { ...s, landing: null }
  const to = s.landing ? applyHandEdit(d.project, s.landing.edit, d.words) : d.project
  return JSON.stringify(s.base.p) === JSON.stringify(to) ? s : rebase(s, d, to)
}

export function open(d: ProjectDetail, queued: QueuedNote | null): Session {
  const had = sessions.get(keyOf(d.slug, queued))
  if (had) return follow(had, d)
  const base = draftOf(d, d.project)
  if (queued?.hand) {
    const start = draftOf(d, applyHandEdit(d.project, queued.hand.edit, d.words))
    return { base, queued: { id: queued.id, edit: queued.hand.edit }, landing: null, history: [start], lastKey: null }
  }
  return { base, queued: null, landing: null, history: [base], lastKey: null }
}

export function useEditSession(d: ProjectDetail, queued: QueuedNote | null) {
  // the panel keeps one session while it is open, even after the waiting edit it opened on starts
  const [key] = useState(() => keyOf(d.slug, queued))
  const [s, setS] = useState(() => open(d, queued))
  const live = useRef(s)
  live.current = s
  useEffect(() => {
    sessions.set(key, s)
  }, [key, s])
  // a version landed while the panel is open: the changes stay, measured from it
  useEffect(() => {
    setS((cur) => follow(cur, d))
  }, [d])

  const now = s.history[s.history.length - 1]
  /** One step of Undo; with `key`, steps with the same key in a row are one (typing in a box). */
  const change = useCallback((fn: (x: Draft) => Draft, key?: string) => {
    setS((cur) => {
      const next = fn(cur.history[cur.history.length - 1])
      const merge = key !== undefined && key === cur.lastKey && cur.history.length > 1
      return { ...cur, history: [...cur.history.slice(0, merge ? -1 : undefined), next], lastKey: key ?? null }
    })
  }, [])
  const undo = useCallback(() => setS((cur) => (cur.history.length > 1 ? { ...cur, history: cur.history.slice(0, -1), lastKey: null } : cur)), [])
  /** Ends a run of typing, so the next keystroke is its own step. */
  const settle = useCallback(() => setS((cur) => (cur.lastKey ? { ...cur, lastKey: null } : cur)), [])
  const edit = useMemo(() => diffProject(s.base.p, now.p, s.base.kept, now.kept), [s.base, now])
  const changes = useMemo(() => countChanges(edit, d.words), [edit, d.words])
  return {
    base: s.base,
    now,
    edit,
    changes,
    queued: s.queued,
    canUndo: s.history.length > 1,
    change,
    undo,
    settle,
    /** The edit was made into a version or queued: nothing is left to keep. */
    finish: () => sessions.delete(key),
    /** The edit to send again on top of a waiting one that started before it could be changed. */
    onTopOfQueued: (): HandEdit => {
      const after = started(live.current, d).base
      return diffProject(after.p, now.p, after.kept, now.kept)
    }
  }
}
