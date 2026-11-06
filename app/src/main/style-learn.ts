// "Learn from my past edits": each export through the engine's import-reference, then shared/learn-style.ts.
// Nothing here writes My style; the person keeps the rules they want (style:keepLearned).
import { basename, dirname } from 'node:path'
import { idOf } from './past-edits'
import type { StyleLesson } from '../shared/api'
import { ADAPTERS, editorOf, learnStyle, type ImportRecord } from '../shared/learn-style'

/** The engine's import record, checked where it comes in: a different shape is a bug in one of the two sides. */
function asRecord(x: unknown, file: string): ImportRecord {
  const r = x as Partial<ImportRecord> | null
  if (!r || !(ADAPTERS as readonly unknown[]).includes(r.source?.adapter) || !Array.isArray(r.timelines)) {
    throw new Error(`import-reference returned no timelines record for ${file}`)
  }
  return r as ImportRecord
}

/** The name a lesson lists: the file's, or for a CapCut project its folder and the draft read in it
 * ("Bread reel/draft_content.json"), so the line says which project; shared/memory.ts knows it by that name. */
function nameOf(file: string, record: ImportRecord): string {
  if (record.source.adapter !== 'capcut') return basename(file)
  const read = (record.source as { path?: unknown }).path
  const draft = typeof read === 'string' ? read : file
  return `${basename(dirname(draft))}/${basename(draft)}`
}

export async function readLesson(
  files: string[],
  importReference: (file: string) => Promise<unknown>,
  onProgress?: (p: { done: number; total: number }) => void
): Promise<StyleLesson> {
  const records: ImportRecord[] = []
  const read: StyleLesson['files'] = []
  const skipped: StyleLesson['skipped'] = []
  for (const [done, file] of files.entries()) {
    onProgress?.({ done, total: files.length })
    try {
      const record = asRecord(await importReference(file), file)
      records.push(record)
      read.push({ id: idOf(file), name: nameOf(file, record), editor: editorOf(record) })
    } catch (e) {
      const reason = (e as { userMessage?: unknown })?.userMessage
      if (typeof reason !== 'string') throw e
      skipped.push({ name: basename(file), reason })
    }
  }
  const lesson = learnStyle(records)
  return { files: read, timelines: lesson.timelines, shots: lesson.shots, rules: lesson.rules, skipped }
}
