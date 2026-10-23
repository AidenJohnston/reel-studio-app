// What a note from the Reel screen must pass before anything of it is written (index.ts projects:note).
import type { NoteAttachment } from '../shared/api'
import { checkNoteAttachments } from './attachments'
import type { JobManager } from './jobs'
import { noteStagingDir } from './paths'
import { projectDir } from './store'

/** The note's words and files, each file re-read from this project's own sidecars or its staging folder
 * (the page is never trusted). A video kept closed refuses it here in the job lane's words, so neither
 * the queue nor the chat shows a note that could not run. A note sent while a job runs is not refused:
 * it waits in the queue (note-queue.ts). */
export async function takeNote(jobs: Pick<JobManager, 'refuseIfKeptClosed'>, slug: string, text: unknown, attachments: unknown): Promise<{ note: string; files: NoteAttachment[] }> {
  const note = String(text ?? '').trim()
  const dir = projectDir(slug)
  const files = await checkNoteAttachments(dir, attachments, noteStagingDir(dir))
  if (!note && !files.length) throw { code: 'EMPTY', userMessage: 'Type what you would like changed first.' }
  jobs.refuseIfKeptClosed(slug)
  return { note, files }
}
