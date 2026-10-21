// The version menu's "what changed" line for each version (src/shared/versions.ts).
import { expect, it } from 'vitest'
import { versionChanges } from '../src/shared/versions'
import type { ChatMessage } from '../src/shared/api'

let id = 0
const you = (text: string): ChatMessage => ({ id: String(id++), from: 'you', text, at: '' })
const editor = (text: string, version?: number): ChatMessage => ({ id: String(id++), from: 'editor', text, at: '', ...(version ? { version } : {}) })

it('credits each version to the note that made it, else to what the editor said, and never to a note that made none or was stopped', () => {
  const chat = [
    editor('Your video is ready. I cut out the pauses and added subtitles.', 1),
    you('Make the captions bigger please'),
    editor('There is no AI editor connected, so I cannot change that from a note.'),
    editor('Version 2: bigger yellow subtitles, moved up.', 2),
    you('music too loud at the start'),
    editor('I made the music quieter for the first ten seconds.', 3),
    you('thanks'),
    editor('I saved your note.', 3),
    editor('Version 4 is ready.', 4),
    you('make it blue'), // stopped: no reply
    editor('Version 5: new cover.', 5)
  ]
  expect([...versionChanges(chat)]).toEqual([
    [1, 'First edit'],
    [2, 'Bigger yellow subtitles, moved up'],
    [3, '“music too loud at the start”'],
    [4, ''],
    [5, 'New cover']
  ])
})
