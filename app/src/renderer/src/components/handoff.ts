/** The part of a <video> that moves between the phone and the full-screen view. */
export interface Playable {
  currentTime: number
  paused: boolean
  ended: boolean
  muted: boolean
  readyState: number
  play(): Promise<void>
  pause(): void
}

export interface PlayState {
  at: number
  playing: boolean
  muted: boolean
}

/**
 * Where `v` is. A video that has not loaded yet reports position 0, not the time it was told to
 * start at, so its position comes from `fallback` (what it was handed): closing the view straight
 * after opening must not rewind the reel. Play/pause and sound are already right before loading.
 */
export function readPlay(v: Playable, fallback: PlayState): PlayState {
  return { at: v.readyState < 1 ? fallback.at : v.currentTime, playing: !v.paused && !v.ended, muted: v.muted }
}

/** Puts `v` at `s`. A video that has not loaded keeps the time and starts there once it has. */
export function applyPlay(v: Playable, s: PlayState): void {
  v.muted = s.muted
  v.currentTime = s.at
  if (s.playing) void v.play().catch(() => {})
  else v.pause()
}

/** Moves playback from one video to the other; only one ever plays. */
export function handOff(from: Playable, to: Playable, fallback: PlayState): PlayState {
  const s = readPlay(from, fallback)
  from.pause()
  applyPlay(to, s)
  return s
}
