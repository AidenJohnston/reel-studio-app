// The helper's instruction (main/mac-permission.ts) and the System Settings window tracker
// (main/mac-settings-window.ts), the latter with T3 Code's test for it.
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { helperInstruction } from '../src/main/mac-permission'

const spawned = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawned.spawn }))
const { watchMacSettingsWindow } = await import('../src/main/mac-settings-window')

it('names the switch to turn on: Files and Folders lists one per protected folder', () => {
  expect(helperInstruction('folder', 'Documents › Reel Studio')).toBe('Turn on Documents Folder under Reel Studio')
  expect(helperInstruction('folder', 'Movies › Reel Studio')).toBe('Turn on Reel Studio in the list above')
  expect(helperInstruction('notifications')).toBe('Turn on Allow notifications')
})

it('reads the tracker line by line, and tells a bad line from a tracker that died', () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    kill: vi.fn()
  })
  spawned.spawn.mockReturnValue(child)
  const changed = vi.fn()
  const unavailable = vi.fn()
  const stop = watchMacSettingsWindow(changed, unavailable)
  const state = { x: 10, y: 20, width: 723, height: 719, frontmost: true }
  const line = JSON.stringify(state)
  child.stdout.emit('data', line.slice(0, 8))
  expect(changed).not.toHaveBeenCalled()
  child.stdout.emit('data', line.slice(8) + '\nnull\n{"x":"bad"}\n')
  expect(changed.mock.calls).toEqual([[state], [null]])
  child.emit('exit', 1)
  expect(unavailable.mock.calls).toEqual([[false], [true]])
  stop()
  expect(child.kill).toHaveBeenCalledOnce()
})
