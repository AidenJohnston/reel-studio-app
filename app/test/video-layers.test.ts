import { describe, expect, it } from 'vitest'
import { NO_LAYERS, layersReducer, versionOnScreen, type LayerEvent, type Layers } from '../src/renderer/src/components/videoLayers'

const run = (...events: LayerEvent[]): Layers => events.reduce(layersReducer, NO_LAYERS)
const want = (src: string): LayerEvent => ({ type: 'want', src, poster: null })

describe('player source switching', () => {
  it('a late load from an earlier switch never replaces a newer source', () => {
    const s = run(want('v1'), want('v2'), want('v3'), { type: 'ready', id: 2 })
    expect(s.shown?.src).toBe('v1')
    expect(s.next?.src).toBe('v3')
    expect(run(want('v1'), want('v2'), want('v3'), { type: 'ready', id: 2 }, { type: 'ready', id: 3 }).shown?.src).toBe('v3')
  })

  it('while a picked version loads, the marks, change pop-up and original read the version still on screen', () => {
    const versions = [
      { n: 1, video: 'v1' },
      { n: 2, video: 'v2' }
    ]
    const picked2 = run(want('v1'), want('v2'))
    expect(versionOnScreen(versions, picked2.shown?.src ?? null)?.n).toBe(1)
    expect(versionOnScreen(versions, layersReducer(picked2, { type: 'ready', id: 2 }).shown?.src ?? null)?.n).toBe(2)
  })
})
