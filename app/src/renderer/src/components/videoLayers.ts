/**
 * The player's stacked <video> elements while it changes source. The one on screen stays until the
 * next one has a frame to show, then the next fades in over it and the old one is let go. At most
 * three exist: on screen, loading, and fading out.
 */
export interface Layer {
  id: number
  src: string
  poster: string | null
}

export interface Layers {
  shown: Layer | null
  /** loading over the one on screen, invisible */
  next: Layer | null
  /** the one being faded over */
  leaving: Layer | null
  lastId: number
}

export const NO_LAYERS: Layers = { shown: null, next: null, leaving: null, lastId: 0 }

export type LayerEvent =
  | { type: 'want'; src: string | null; poster: string | null }
  /** layer `id` has a decoded frame */
  | { type: 'ready'; id: number }
  /** layer `id` has finished fading out */
  | { type: 'gone'; id: number }

export function layersReducer(s: Layers, e: LayerEvent): Layers {
  switch (e.type) {
    case 'want': {
      if (!e.src) return { ...NO_LAYERS, lastId: s.lastId }
      if (s.shown?.src === e.src) {
        if (!s.next && s.shown.poster === e.poster) return s
        return { ...s, shown: { ...s.shown, poster: e.poster }, next: null }
      }
      if (s.next?.src === e.src) return s
      const layer = { id: s.lastId + 1, src: e.src, poster: e.poster }
      // nothing on screen yet: nothing to hold, show it as it loads
      if (!s.shown) return { ...s, shown: layer, lastId: layer.id }
      return { ...s, next: layer, lastId: layer.id }
    }
    case 'ready':
      // a load for a source asked for before the current one never takes the screen
      if (s.next?.id !== e.id) return s
      return { ...s, shown: s.next, next: null, leaving: s.shown }
    case 'gone':
      return s.leaving?.id === e.id ? { ...s, leaving: null } : s
  }
}

/**
 * The version the person is looking at: the one whose video the player has on screen (`onShown`), not the one
 * just picked, which plays only once it has loaded. null when something else is on screen, such as a change's
 * quick preview.
 */
export function versionOnScreen<V extends { video?: string | null }>(versions: V[], shownSrc: string | null): V | null {
  return (shownSrc && versions.find((v) => v.video === shownSrc)) || null
}
