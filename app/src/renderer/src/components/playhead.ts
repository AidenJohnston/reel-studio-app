import { useLayoutEffect, useSyncExternalStore } from 'react'

/**
 * Where the video is, outside React state. The player writes it every animation frame while playing.
 * What moves every frame follows it outside React (`useFollowPlayhead`); a component that renders reads
 * only what it shows (`usePlayhead(p, Math.round)` re-renders once a second). Playback then costs React
 * one commit a second, not one a frame.
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

/** Calls `write` with the playhead now and on every change, without rendering. `write` should be stable. */
export function useFollowPlayhead(p: Playhead, write: (seconds: number) => void): void {
  useLayoutEffect(() => {
    write(p.get())
    return p.subscribe(() => write(p.get()))
  }, [p, write])
}
