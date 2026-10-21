import { useSyncExternalStore } from 'react'

/**
 * Where the video is, outside React state. The player writes it every animation frame while playing;
 * a component reads only what it shows (`usePlayhead(p, Math.round)` re-renders once a second), so
 * playback does not re-render the whole Reel screen.
 */
export interface Playhead {
  get(): number
  set(seconds: number): void
  subscribe(listener: () => void): () => void
}

export function createPlayhead(): Playhead {
  let at = 0
  const listeners = new Set<() => void>()
  return {
    get: () => at,
    set(seconds) {
      if (seconds === at) return
      at = seconds
      for (const l of listeners) l()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

/** `pick` must return a primitive: the component re-renders only when it changes. */
export function usePlayhead<T extends string | number>(p: Playhead, pick: (seconds: number) => T): T {
  return useSyncExternalStore(p.subscribe, () => pick(p.get()))
}
