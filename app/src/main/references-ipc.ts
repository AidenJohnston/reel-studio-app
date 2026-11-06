// My style › Reference reels: the page's calls into the reference library (references.ts).
import type { ReferenceLibrary } from './references'

type Handle = (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void

export function registerReferencesIpc(d: {
  handle: Handle
  library: ReferenceLibrary
  ensureRoot: () => Promise<unknown>
  openExternal: (url: string) => Promise<void>
  showItemInFolder: (file: string) => void
}): void {
  const { handle, library } = d
  const entry = async (id: string) => {
    const found = await library.get(id)
    if (!found) throw { code: 'NOT_FOUND', userMessage: 'That reference is not in the list any more.' }
    return found
  }

  handle('refs:list', async () => {
    await d.ensureRoot()
    return library.list()
  })
  handle('refs:add', async (_e, paths: string[]) => {
    await d.ensureRoot()
    return library.addFiles(paths)
  })
  handle('refs:addLink', async (_e, url: string) => {
    await d.ensureRoot()
    return library.addLink(url)
  })
  // the file for a link the app would not download, picked on its row
  handle('refs:attach', (_e, id: string, path: string) => library.attach(id, path))
  handle('refs:remove', (_e, id: string) => library.remove(id))
  handle('refs:openLink', async (_e, id: string) => {
    const url = (await entry(id)).entry.link?.url
    // only the http(s) links linkPolicy kept; anything else in a hand-edited file is never opened
    if (!url || !/^https?:\/\//i.test(url)) throw { code: 'NO_LINK', userMessage: 'That reference has no link to open.' }
    await d.openExternal(url)
  })
  handle('refs:reveal', async (_e, id: string) => {
    const file = (await entry(id)).file
    if (!file) throw { code: 'NO_FILE', userMessage: 'That reference has no file yet.' }
    d.showItemInFolder(file)
  })
}
