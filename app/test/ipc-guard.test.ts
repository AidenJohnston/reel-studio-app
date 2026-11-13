import { afterEach, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { assertIpcSender, validateIpcArgs } from '../src/main/ipc-guard'
import { APP_DIR, PYTHON } from './helpers'

afterEach(() => vi.unstubAllGlobals())

it('accepts Cover edits built from the real engine new_project defaults', () => {
  const project = JSON.parse(execFileSync(PYTHON, ['-c',
    'import json; from reelengine.project import new_project; print(json.dumps(new_project("Fresh take")))'
  ], { cwd: join(APP_DIR, '..'), env: { ...process.env, PYTHONPATH: join(APP_DIR, '..', 'engine') }, encoding: 'utf8' }))
  for (const cover of [project.cover, { ...project.cover, atSourceTime: 4 }, { ...project.cover, text: 'Day 3' }, null, {}]) {
    expect(() => validateIpcArgs('projects:update', [project.slug, { cover }])).not.toThrow()
  }
  for (const cover of [{ atSourceTime: -1 }, { atSourceTime: NaN }, { source: 42 }, { text: false }, { exact: 'yes' }]) {
    expect(() => validateIpcArgs('projects:update', [project.slug, { cover }])).toThrow()
  }
})

it('accepts a b-roll item with no optional asset or params, while rejecting malformed items', () => {
  const broll = [{ id: 'b1', anchor: { from: 'w1', to: 'w2' }, treatment: 'text-pop' }]
  expect(() => validateIpcArgs('projects:update', ['fresh-take', { broll }])).not.toThrow()
  expect(() => validateIpcArgs('projects:update', ['fresh-take', { broll: [{ ...broll[0], asset: 42 }] }])).toThrow()
  expect(() => validateIpcArgs('projects:update', ['fresh-take', { broll: [{ ...broll[0], params: null }] }])).toThrow()
})

function sender(actual: string): { event: IpcMainInvokeEvent; contents: WebContents } {
  const mainFrame = { url: actual }
  const contents = { isDestroyed: () => false, mainFrame } as WebContents
  const event = { sender: contents, senderFrame: mainFrame } as IpcMainInvokeEvent
  return { event, contents }
}

it('accepts equivalent packaged renderer paths with different URL escaping', () => {
  const expected = pathToFileURL(join(APP_DIR, 'Reel [preview].app', 'index.html')).href
  const actual = expected.replace(/%5B/gi, '[').replace(/%5D/gi, ']')
  const { event, contents } = sender(actual)
  expect(() => assertIpcSender(event, contents, expected)).not.toThrow()
  expect(() => assertIpcSender(event, contents, expected.replace('index.html', 'other.html'))).toThrow()
})

it('compares packaged renderer paths without case differences on Windows', () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const { event, contents } = sender('file:///C:/Program%20Files/Reel/index.html')
  expect(() => assertIpcSender(event, contents, 'file:///c:/program%20files/reel/index.html')).not.toThrow()
  expect(() => assertIpcSender(event, contents, 'file:///c:/program%20files/reel/other.html')).toThrow()
})
