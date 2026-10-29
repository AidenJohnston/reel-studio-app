// The full-screen view takes over playback from the phone and gives it back (components/handoff.ts).
import { describe, expect, it } from 'vitest'
import { applyPlay, handOff, readPlay, type Playable, type PlayState } from '../src/renderer/src/components/handoff'

/** A <video> stand-in: play() and pause() flip `paused`, like the real one. */
function fakeVideo(init: Partial<Playable> = {}): Playable & { plays: number } {
  const v = {
    currentTime: 0,
    paused: true,
    ended: false,
    muted: false,
    readyState: 4,
    plays: 0,
    play() {
      v.paused = false
      v.plays++
      return Promise.resolve()
    },
    pause() {
      v.paused = true
    },
    ...init
  }
  return v
}

const NONE: PlayState = { at: 0, playing: false, muted: false }

describe('full-screen hand-off', () => {
  it('carries position, playing and sound into the view and stops the phone', () => {
    const phone = fakeVideo({ currentTime: 3.25, paused: false, muted: true })
    const view = fakeVideo({ readyState: 0 })
    handOff(phone, view, NONE)
    expect(phone.paused).toBe(true)
    expect(view).toMatchObject({ currentTime: 3.25, paused: false, muted: true, plays: 1 })
  })

  it('a paused reel stays paused', () => {
    const phone = fakeVideo({ currentTime: 7, muted: false })
    const view = fakeVideo({ paused: false })
    handOff(phone, view, NONE)
    expect(view).toMatchObject({ currentTime: 7, paused: true, plays: 0 })
  })

  it('a reel that played to the end comes back paused', () => {
    const view = fakeVideo({ currentTime: 12, paused: false, ended: true })
    expect(readPlay(view, NONE)).toEqual({ at: 12, playing: false, muted: false })
  })

  it('gives back where the view got to, and what was changed there', () => {
    const start: PlayState = { at: 2, playing: true, muted: true }
    const phone = fakeVideo()
    const view = fakeVideo({ currentTime: 9.5, paused: false, muted: false })
    handOff(view, phone, start)
    expect(view.paused).toBe(true)
    expect(phone).toMatchObject({ currentTime: 9.5, paused: false, muted: false })
  })

  it('pausing or playing before the view has loaded is what goes back', () => {
    const start: PlayState = { at: 5.5, playing: true, muted: false }
    const view = fakeVideo({ readyState: 0 })
    applyPlay(view, start)
    view.pause()
    const phone = fakeVideo()
    handOff(view, phone, start)
    expect(phone).toMatchObject({ currentTime: 5.5, paused: true })

    const view2 = fakeVideo({ readyState: 0 })
    applyPlay(view2, { ...start, playing: false })
    void view2.play()
    handOff(view2, phone, { ...start, playing: false })
    expect(phone.paused).toBe(false)
  })

  it('closing before the view has loaded does not rewind the reel', () => {
    const start: PlayState = { at: 5.5, playing: true, muted: false }
    const view = fakeVideo({ readyState: 0, currentTime: 0 })
    applyPlay(view, start)
    view.currentTime = 0 // what an unloaded video reports
    const phone = fakeVideo()
    handOff(view, phone, start)
    expect(phone).toMatchObject({ currentTime: 5.5, paused: false })
  })
})
