// The version menu's "what changed" line for each version (src/shared/versions.ts).
import { expect, it } from 'vitest'
import { versionChanges } from '../src/shared/versions'
import type { ChatMessage, ProjectJson, VersionInfo } from '../src/shared/api'

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 21, 9, minute)).toISOString()
const version = (n: number, minute: number): VersionInfo => ({ n, video: '', videoPath: '', draft: false, cover: null, createdAt: at(minute) })
const editor = (text: string, v: number, minute: number): ChatMessage => ({ id: `${v}-${minute}`, from: 'editor', text, at: at(minute), version: v })
type Note = NonNullable<ProjectJson['notes']>[number]
const note = (text: string, v: number, minute: number, applied = ['captions']): Note => ({ version: v, text, applied, at: at(minute) })

it('takes a line only from what was recorded once the final render made that version', () => {
  const versions = [version(1, 0), version(2, 20), version(3, 30), version(4, 40)]
  const chat = [
    editor('Your video is ready.', 1, 1),
    // a note whose final render failed: its reply and note entry carry the number the edit would have got
    editor('I made your subtitles pop.', 2, 10),
    editor('I made the music quieter.', 2, 21),
    editor('Version 3: new cover.', 3, 31),
    // no announcement for Version 4, only a later reply that changed nothing
    editor('I looked, but I was not sure what to change.', 4, 45)
  ]
  const notes = [note('make the subtitles pop', 2, 10), note('music too loud', 2, 21, ['music']), note('thanks', 4, 45, [])]
  expect([...versionChanges(versions, chat, notes)]).toEqual([
    [1, 'First edit'],
    [2, '“music too loud”'],
    [3, 'New cover'],
    [4, 'Changes not recorded']
  ])
})
