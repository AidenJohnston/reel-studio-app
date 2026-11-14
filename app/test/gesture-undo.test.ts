// Undo on the editing timeline (renderer components/gesture-undo.ts): the newest gesture by the queue id main gave it.
import { describe, expect, it } from 'vitest'
import { gestureUndo } from '../src/renderer/src/components/gesture-undo'

/** main's queue as queue.cancel meets it: waiting ids can be taken back; a started one answers NOT_QUEUED. */
function queue(waiting: string[], started: string[] = []) {
  const cancelled: string[] = []
  const cancel = async (id: string) => {
    if (started.includes(id) || !waiting.includes(id)) throw { code: 'NOT_QUEUED', userMessage: 'That note already started.' }
    waiting.splice(waiting.indexOf(id), 1)
    cancelled.push(id)
  }
  return { cancel, cancelled }
}

describe('timeline undo', () => {
  it('fails if two gestures sent close together are confused: Undo takes back the newer one, then the older', async () => {
    const q = queue(['h1', 'h2'])
    const undo = gestureUndo(q.cancel)
    // the second gesture's answer arrives first: the order is the order they were made, not answered
    let answerFirst!: (v: { id: string }) => void
    undo.made(new Promise((r) => (answerFirst = r)))
    undo.made(Promise.resolve({ id: 'h2' }))
    answerFirst({ id: 'h1' })
    expect(await undo.undo()).toBe('taken')
    expect(await undo.undo()).toBe('taken')
    expect(q.cancelled).toEqual(['h2', 'h1'])
    expect(await undo.undo()).toBe('nothing')
  })

  it('fails if a gesture that already started is taken back, or Undo gives no answer for it', async () => {
    const q = queue(['h2'], ['h1'])
    const undo = gestureUndo(q.cancel)
    undo.made(Promise.resolve({ id: 'h1' }))
    expect(await undo.undo()).toBe('ran')
    expect(q.cancelled).toEqual([])
  })

  it('fails if a gesture main refused counts: Undo goes on to the one before it', async () => {
    const q = queue(['h1'])
    const undo = gestureUndo(q.cancel)
    undo.made(Promise.resolve({ id: 'h1' }))
    undo.made(Promise.reject({ code: 'BUSY', userMessage: 'Busy.' }))
    expect(await undo.undo()).toBe('taken')
    expect(q.cancelled).toEqual(['h1'])
  })
})
