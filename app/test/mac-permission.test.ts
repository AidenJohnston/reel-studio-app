// The System Settings pages and helper page (main/mac-permission.ts) and the Settings window tracker
// (main/mac-settings-window.ts), ported with T3 Code's tests for them.
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLE_ID, helperHtml, helperInstruction, macAppBundlePath, MAC_PANES, settingsHelperBounds } from '../src/main/mac-permission'

const spawned = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: spawned.spawn }))
const { decodeSettingsWindow, watchMacSettingsWindow } = await import('../src/main/mac-settings-window')

describe('System Settings pages', () => {
  it('deep-links each pane, and Notifications opens Reel Studio’s own page', () => {
    for (const p of Object.values(MAC_PANES)) expect(p.url).toMatch(/^x-apple\.systempreferences:com\.apple\./)
    expect(MAC_PANES.folder.url).toMatch(/Privacy_FilesAndFolders$/)
    expect(MAC_PANES.network.url).toMatch(/Privacy_LocalNetwork$/)
    expect(MAC_PANES.notifications.url).toBe(`x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${BUNDLE_ID}`)
  })

  it('only needs panes that take a switch, never a drag', () => {
    expect(Object.values(MAC_PANES).map((p) => p.kind)).toEqual(['toggle', 'toggle', 'toggle'])
    // the folder can be read, so its helper closes by itself; the other two cannot, so they have Done
    expect(MAC_PANES.folder.readable).toBe(true)
    expect(MAC_PANES.notifications.readable).toBe(false)
    expect(MAC_PANES.network.readable).toBe(false)
  })

  it('names the switch to turn on', () => {
    expect(helperInstruction('folder', 'Documents › Reel Studio')).toBe('Turn on Documents Folder under Reel Studio')
    expect(helperInstruction('folder', 'Desktop › Reel Studio')).toBe('Turn on Desktop Folder under Reel Studio')
    expect(helperInstruction('folder', 'Movies › Reel Studio')).toBe('Turn on Reel Studio in the list above')
    expect(helperInstruction('notifications')).toBe('Turn on Allow notifications')
    expect(helperInstruction('network')).toBe('Turn on Reel Studio in the list above')
  })
})

describe('helper page', () => {
  const icon = 'data:image/png;base64,abc'

  it('a switch pane shows the app to look for, not something to drag', () => {
    const html = helperHtml(MAC_PANES.folder, helperInstruction('folder', 'Documents › Reel Studio'), icon)
    expect(html).toContain('<header>↑ Turn on Documents Folder under Reel Studio</header>')
    expect(html).not.toContain('draggable="true"')
    expect(html).not.toContain('id="done"') // closes by itself once the folder can be used
    expect(html).toContain(`<img src="${icon}"`)
  })

  it('a pane Reel Studio cannot read has Done', () => {
    expect(helperHtml(MAC_PANES.network, helperInstruction('network'), icon)).toContain('<button id="done">Done</button>')
  })

  it('a drag pane offers the app to drag, with T3 Code’s words', () => {
    const drag = { ...MAC_PANES.folder, kind: 'drag' as const }
    const html = helperHtml(drag, 'Drag Reel Studio into the list above', icon)
    expect(html).toContain('<button id="app" draggable="true"')
    expect(html).toContain('↑ Drag Reel Studio into the list above')
  })

  it('cannot be broken out of by the icon or the words', () => {
    const html = helperHtml(MAC_PANES.folder, '<script>x</script>', 'data:"onerror="x')
    expect(html).not.toContain('<script>')
    expect(html).toContain('data:&quot;onerror=&quot;x')
  })
})

describe('placement', () => {
  it('finds the .app bundle of the running binary', () => {
    expect(macAppBundlePath('/Applications/Reel Studio.app/Contents/MacOS/Reel Studio')).toBe('/Applications/Reel Studio.app')
    expect(macAppBundlePath('/usr/local/bin/electron')).toBeUndefined()
  })

  it('sits at the bottom of the Settings window, over its content', () => {
    expect(settingsHelperBounds({ x: 100, y: 50, width: 900, height: 620, frontmost: true })).toEqual({ x: 378, y: 514, width: 560, height: 140 })
    // a narrow window: the helper narrows with it
    expect(settingsHelperBounds({ x: 0, y: 0, width: 600, height: 400, frontmost: true }).width).toBe(352)
  })
})

describe('watchMacSettingsWindow', () => {
  let child: EventEmitter & { stdout: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> }; kill: ReturnType<typeof vi.fn> }
  beforeEach(() => {
    child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      kill: vi.fn()
    })
    spawned.spawn.mockReset().mockReturnValue(child)
  })

  it('decodes partial updates and stops the one watcher process on disposal', () => {
    const changed = vi.fn()
    const unavailable = vi.fn()
    const stop = watchMacSettingsWindow(changed, unavailable)
    expect(spawned.spawn).toHaveBeenCalledOnce()
    const state = { x: 10, y: 20, width: 723, height: 719, frontmost: true }
    const line = JSON.stringify(state)
    child.stdout.emit('data', line.slice(0, 8))
    expect(changed).not.toHaveBeenCalled()
    child.stdout.emit('data', line.slice(8) + '\nnull\n')
    expect(changed.mock.calls).toEqual([[state], [null]])
    stop()
    expect(child.kill).toHaveBeenCalledOnce()
    child.emit('exit', 0)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(unavailable).not.toHaveBeenCalled()
  })

  it('distinguishes unavailable tracking from a valid absent window', () => {
    const changed = vi.fn()
    const unavailable = vi.fn()
    const stop = watchMacSettingsWindow(changed, unavailable)
    child.stdout.emit('data', '{"x":"bad"}\n')
    expect(changed).not.toHaveBeenCalled()
    expect(unavailable.mock.calls).toEqual([[false]])
    child.emit('error', new Error('spawn failed'))
    expect(changed).not.toHaveBeenCalled()
    expect(unavailable.mock.calls).toEqual([[false], [true]])
    stop()
  })

  it('rejects anything that is not a window or null', () => {
    expect(decodeSettingsWindow('null')).toBeNull()
    expect(() => decodeSettingsWindow('{"x":1,"y":2,"width":3,"height":4}')).toThrow(/not a settings window/)
    expect(() => decodeSettingsWindow('[1]')).toThrow()
  })
})
