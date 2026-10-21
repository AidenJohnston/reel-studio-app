import { describe, expect, it } from 'vitest'
import { NO_LAYERS, layersReducer, type LayerEvent, type Layers } from '../src/renderer/src/components/videoLayers'

const run = (...events: LayerEvent[]): Layers => events.reduce(layersReducer, NO_LAYERS)
const want = (src: string): LayerEvent => ({ type: 'want', src, poster: null })

describe('player source switching', () => {
  it('a late load from an earlier switch never replaces a newer source', () => {
    const s = run(want('v1'), want('v2'), want('v3'), { type: 'ready', id: 2 })
    expect(s.shown?.src).toBe('v1')
    expect(s.next?.src).toBe('v3')
    expect(run(want('v1'), want('v2'), want('v3'), { type: 'ready', id: 2 }, { type: 'ready', id: 3 }).shown?.src).toBe('v3')
  })

  it('keeps the old video on screen until the new one is ready, then lets it fade out', () => {
    const loading = run(want('v1'), want('v2'))
    expect([loading.shown?.src, loading.next?.src, loading.leaving]).toEqual(['v1', 'v2', null])
    const swapped = layersReducer(loading, { type: 'ready', id: 2 })
    expect([swapped.shown?.src, swapped.next, swapped.leaving?.src]).toEqual(['v2', null, 'v1'])
    expect(layersReducer(swapped, { type: 'gone', id: 1 }).leaving).toBeNull()
  })
})
