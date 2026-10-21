// The version menu's "what changed" line for each version (src/shared/versions.ts).
import { expect, it } from 'vitest'
import { versionChanges, type ProjectNote } from '../src/shared/versions'
import type { ChatMessage, VersionInfo } from '../src/shared/api'

const version = (n: number): VersionInfo => ({ n, video: '', videoPath: '', draft: false, cover: null, createdAt: '' })
const editor = (text: string, v: number): ChatMessage => ({ id: `${v}-${text}`, from: 'editor', text, at: '', version: v })
const note = (text: string, v: number, applied = ['captions']): ProjectNote => ({ version: v, text, applied, at: `${v}-${text}` })

it("credits a version to the note tagged with it that its own project.json copy does not hold yet, else to a change made by hand", () => {
  // A note's final render failed: it was saved tagged 2 (the number its edit would have got) before Version 2
  // existed, so Version 2's copy, taken when its render started, already holds it.
  const failed = note('make the subtitles pop', 2)
  // The note that made Version 2 is saved after that render, so only later copies hold it.
  const made2 = note('music too loud', 2, ['music'])
  const styleOnly = note('always use yellow', 4, [])
  const chat = [
    editor('Your video is ready.', 1),
    editor('I made your subtitles pop.', 2),
    editor('I made the music quieter.', 2),
    editor('Version 3: new cover.', 3),
    editor('I looked, but I was not sure what to change.', 4)
  ]
  const copies = { 1: [], 2: [failed], 3: [failed, made2], 4: [failed, made2] } // Version 5's copy could not be read
  const live = [failed, made2, styleOnly, note('louder voice', 5)]
  expect([...versionChanges([1, 2, 3, 4, 5].map(version), chat, live, copies)]).toEqual([
    [1, 'First edit'],
    [2, '“music too loud”'],
    [3, 'New cover'],
    [4, 'Changes not recorded'],
    [5, 'Changes not recorded']
  ])
})
