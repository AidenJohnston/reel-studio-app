// Pasting files (main/intake.ts): the clipboard formats each system offers after a file-manager copy.
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { filesFromClipboardItems, type ClipboardEntry } from '../src/main/intake'

const item = (formats: Record<string, string>): ClipboardEntry => ({
  types: Object.keys(formats),
  getType: async (type) => new Blob([formats[type]])
})

describe('filesFromClipboardItems', () => {
  // What Electron 44's clipboard.read() returned on Windows 11 after Ctrl+C on two files in File Explorer
  // (captured from the packaged app, 2026-10-22). There is no CF_HDROP or FileNameW entry.
  it.runIf(process.platform === 'win32')('finds every file of a Windows File Explorer copy, with non-ASCII names intact', async () => {
    const explorer = item({
      'text/uri-list':
        'file:///C:/Users/Zo%C3%AB/Videos/%C3%BCn%C3%AF%20c%C3%B6d%C3%A9/Zo%C3%AB%20take%20%231.mp4\r\nfile:///C:/Users/Zo%C3%AB/Videos/second.mp4',
      'electron application/osclipboard;format="FileName"': 'C:\\Users\\Zo?\\Videos\\??n? c?d??\\Zo? take #1.mp4\0',
      'electron application/osclipboard;format="Shell IDList Array"': '',
      'electron application/osclipboard;format="Preferred DropEffect"': ''
    })
    expect(await filesFromClipboardItems([explorer])).toEqual([
      'C:\\Users\\Zoë\\Videos\\ünï cödé\\Zoë take #1.mp4',
      'C:\\Users\\Zoë\\Videos\\second.mp4'
    ])
  })

  it('reads file URLs from text/uri-list, skipping comments and other URLs', async () => {
    const a = join(tmpdir(), 'ünï cödé', 'Zoë take #1.mp4')
    const b = join(tmpdir(), 'second.mp4')
    const list = ['# copied files', pathToFileURL(a).href, 'https://example.com/c.mp4', pathToFileURL(b).href].join('\r\n')
    expect(await filesFromClipboardItems([item({ 'text/uri-list': list })])).toEqual([a, b])
  })

  it('finds nothing in plain text', async () => {
    expect(await filesFromClipboardItems([item({ 'text/plain': join(tmpdir(), 'a.mp4') })])).toEqual([])
  })
})
