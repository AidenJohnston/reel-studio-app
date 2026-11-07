// What "Let other AI apps use Reel Studio" lets an outside agent do (outside-access.ts): the person's own controls on
// the Reel screen, answered as text the agent reads. Reads come from the same files the Reel screen reads; a note goes
// through the same send (main/index.ts sendNote) and Stop through the same queue, so both show in the app at once.
// Answers carry reel ids, titles, version numbers and note words: never a file path or a media URL.
import { describeFacts, versionTitle } from '../shared/describe'
import { versionChanges } from '../shared/versions'
import type { JobKind } from '../shared/api'
import type { OutsideControls } from './outside-access'
import { listProjects, listVersions, projectDir, readAppState, readProject, readWords, summary } from './store'

export interface OutsideReelDeps {
  /** main/index.ts sendNote, as the Reel screen's Send calls it */
  send(slug: string, text: string, base?: number, steer?: boolean): Promise<{ jobId: string | null; queued?: boolean; added?: boolean; noEditor?: true }>
  /** the job running on a reel, if any */
  running(slug: string): { id: string; kind: JobKind } | undefined
  /** Stop on the Reel screen (note-queue.ts stop) */
  stop(jobId: string, slug: string): Promise<void>
}

const NOT_FOUND = { code: 'NOT_FOUND', userMessage: 'There is no reel with that id. Call list_reels for the ids.' }
/** lines of the notes get_reel returns, newest last */
const RECENT = 8
/** the newest versions and the first waiting notes get_reel lists: its answer stays far under the relay's 1 MiB line
 * (each note is at most 4000 characters), with the totals so the agent knows what it did not see */
const VERSIONS = 40
const WAITING = 20
/** reels list_reels returns, newest first: far under the relay's 1 MiB line, with the total */
const REELS = 200
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const WORKING: Record<JobKind, string> = {
  'first-edit': 'making Version 1', note: 'running a note', rerender: 'making a version again', export: 'exporting', script: 'writing a plan', propose: 'looking for more reels'
}

export function createOutsideReels(deps: OutsideReelDeps): OutsideControls {
  async function exists(slug: string): Promise<void> {
    if (!(await summary(slug).catch(() => null))) throw NOT_FOUND
  }

  return {
    async listReels() {
      const all = await listProjects()
      const reels = all.slice(0, REELS).map((p) => ({
        reel: p.slug,
        title: p.title,
        status: p.status,
        newest_version: p.version || null,
        notes_waiting: p.waiting,
        working_on: deps.running(p.slug) ? WORKING[deps.running(p.slug)!.kind] : null
      }))
      return JSON.stringify({ reels_total: all.length, reels })
    },

    async getReel(slug) {
      const s = await summary(slug).catch(() => null)
      if (!s) throw NOT_FOUND
      const st = await readAppState(slug)
      const versions = await listVersions(projectDir(slug)).catch(() => [])
      // the titles the Reel screen shows: the editor's rewording, else the app's own words from the receipts
      const words = versions.some((v) => v.facts?.length) ? await readProject(slug).then((p) => readWords(projectDir(slug), p)).catch(() => []) : []
      // what made each version, as the version menu says it: the note's own words, or the change made by hand
      const madeBy = versionChanges(versions, st.versionsMade ?? [])
      const job = deps.running(slug)
      // the note running now: a note job, and its queue entry (a hand edit or a stale entry is not one to add to)
      const ran = job?.kind === 'note' ? st.queue?.find((q) => q.attempt && !q.hand) : undefined
      return JSON.stringify({
        reel: slug,
        title: s.title,
        status: s.status,
        versions_total: versions.filter((v) => v.n > 0).length,
        versions: versions.filter((v) => v.n > 0).slice(-VERSIONS).map((v) => ({
          version: v.n,
          title: v.wording?.title ?? (v.facts?.length ? versionTitle(v.facts, words) : madeBy.get(v.n)),
          made_by: madeBy.get(v.n),
          ...(v.facts?.length ? { changed: v.wording?.summary ?? describeFacts(v.facts, words) } : {}),
          made_from: v.parents ?? v.parent,
          ...(v.madeWith ? { made_with: v.madeWith } : {})
        })),
        working_on: job ? WORKING[job.kind] : null,
        running_note: ran ? { text: clip(ran.text, 4000), ...(ran.branch ? { base_version: ran.branch } : {}) } : null,
        notes_waiting_total: (st.queue ?? []).filter((q) => !q.attempt).length,
        notes_waiting: (st.queue ?? []).filter((q) => !q.attempt).slice(0, WAITING).map((q) => ({ text: clip(q.hand ? `Edit it myself: ${q.text}` : q.text, 4000), ...(q.branch ? { base_version: q.branch } : {}) })),
        queue_held: !!st.queueHeld && !!st.queue?.length,
        recent_notes: st.chat.filter((m) => !m.plan && !m.planTurn).slice(-RECENT).map((m) => ({ from: m.from, text: clip(m.text, 500), ...(m.version ? { version: m.version } : {}) }))
      })
    },

    async sendNote(slug, text, base) {
      await exists(slug)
      const r = await deps.send(slug, text, base)
      if (r.noEditor) return 'Reel Studio has no AI editor connected, so the note was not applied. It shows in the reel\'s notes. The person can connect one in Settings › Editor.'
      if (r.jobId) return 'Sent. Your note is running now; call get_reel to see it finish and the version it makes.'
      const st = await readAppState(slug)
      const ahead = (st.queue ?? []).length - 1
      if (st.queueHeld) return `Sent. It waits with ${ahead} other note${ahead === 1 ? '' : 's'}: this reel's notes are held after a Stop or a failed note, until the person sends them on in Reel Studio.`
      return `Sent. It waits its turn behind ${ahead} note${ahead === 1 ? '' : 's'}.`
    },

    async addToRunningNote(slug, text) {
      await exists(slug)
      // nothing to add to: a note of its own would start, which is send_note's job, not this tool's
      if (deps.running(slug)?.kind !== 'note') throw { code: 'NOT_RUNNING', userMessage: 'No note is running on that reel. Use send_note to send this as a note of its own.' }
      const r = await deps.send(slug, text, undefined, true)
      if (r.noEditor) return 'Reel Studio has no AI editor connected, so nothing was added. The words show in the reel\'s notes.'
      if (r.added) return 'Added. The note running now reads your words before it finishes, and its version includes them. Call get_reel to see it.'
      // it ended between the check and the send: the words started as a note of their own
      if (r.jobId) return 'That note had just finished, so your words started as a note of their own. Call get_reel to see it.'
      // too late (it was being saved), or the running note changes another version: the words wait as their own note
      const held = (await readAppState(slug)).queueHeld
      return held
        ? 'The running note could not take more words, so they wait as a note of their own. This reel\'s notes are held after a Stop or a failed note, until the person sends them on in Reel Studio.'
        : 'The running note could not take more words (it was finishing, or it changes a different version), so they wait as a note of their own, next in line.'
    },

    async stopNote(slug) {
      await exists(slug)
      const job = deps.running(slug)
      if (!job) return 'Nothing is running on that reel.'
      await deps.stop(job.id, slug)
      return job.kind === 'note' ? 'Stopped. Unless it was already saved, the note waits again at the top, and the notes behind it hold until the person sends them on.' : `Stopped ${WORKING[job.kind]}.`
    }
  }
}
