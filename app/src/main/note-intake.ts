// What a note from the Reel screen must pass before anything of it is written (index.ts projects:note).
import type { NoteAttachment } from '../shared/api'
import { checkNoteAttachments } from './attachments'
import type { JobManager } from './jobs'
import { projectDir } from './store'

/** The note's words and files, each file re-read from this project's own sidecars (the page is never
 * trusted). A video a job runs on, or one kept closed, refuses it here in the job lane's words, so the
 * chat never shows a note that could not run. */
export async function takeNote(jobs: Pick<JobManager, 'refuseIfBusy'>, slug: string, text: unknown, attachments: unknown): Promise<{ note: string; files: NoteAttachment[] }> {
  const note = String(text ?? '').trim()
  const files = await checkNoteAttachments(projectDir(slug), attachments)
  if (!note && !files.length) throw { code: 'EMPTY', userMessage: 'Type what you would like changed first.' }
  jobs.refuseIfBusy(slug)
  return { note, files }
}
