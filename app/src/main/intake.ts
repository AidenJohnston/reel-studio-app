import { clipboard } from 'electron'
import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function filesFromArgv(argv: string[], cwd: string, defaultApp: boolean): string[] {
  return argv.slice(defaultApp ? 2 : 1).filter((arg) => !arg.startsWith('-')).map((arg) => isAbsolute(arg) ? arg : resolve(cwd, arg))
}

export async function clipboardFiles(): Promise<string[]> {
  return filesFromClipboardItems(await clipboard.read())
}

/** One entry of Electron's clipboard.read(). */
export interface ClipboardEntry {
  types: readonly string[]
  getType(type: string): Promise<unknown>
}

export async function filesFromClipboardItems(items: readonly ClipboardEntry[]): Promise<string[]> {
  const paths: string[] = []
  for (const item of items) {
    for (const type of item.types) {
      // A File Explorer copy reaches Electron 44 on Windows as text/uri-list (one file:// URL per line) plus the
      // ANSI "FileName" format, which garbles non-ASCII paths and holds only the first file. CF_HDROP and
      // FileNameW are not offered there, so without text/uri-list Ctrl+V finds no files on Windows.
      if (type === 'electron application/osclipboard;format="public.file-url"' || type === 'text/uri-list') {
        const value = await item.getType(type)
        if (!(value instanceof Blob)) continue
        for (const url of (await value.text()).replace(/\0+$/, '').split(/[\r\n]+/)) {
          try {
            paths.push(fileURLToPath(url))
          } catch {}
        }
      } else if (type === 'electron application/osclipboard;format="NSFilenamesPboardType"') {
        const value = await item.getType(type)
        if (!(value instanceof Blob)) continue
        const filenames = await new Promise<string>((resolve, reject) => {
          const child = spawn('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'])
          let output = ''
          child.stdout.on('data', (data) => { output += data })
          child.on('error', reject)
          child.on('close', (code) => code === 0 ? resolve(output) : resolve('[]'))
          child.stdin.on('error', reject)
          void value.arrayBuffer().then((data) => child.stdin.end(Buffer.from(data)), reject)
        })
        const parsed: unknown = JSON.parse(filenames)
        if (Array.isArray(parsed)) paths.push(...parsed.filter((path): path is string => typeof path === 'string' && isAbsolute(path)))
      } else if (type === 'electron application/osclipboard;format="CF_HDROP"' || type === 'electron application/osclipboard;format="FileNameW"') {
        const value = await item.getType(type)
        if (!(value instanceof Blob)) continue
        const data = Buffer.from(await value.arrayBuffer())
        if (type.endsWith('"FileNameW"')) paths.push(...data.toString('utf16le').split('\0').filter(Boolean))
        else if (data.length >= 20) {
          const offset = data.readUInt32LE(0)
          if (offset >= 20 && offset < data.length) paths.push(...data.subarray(offset).toString(data.readUInt32LE(16) ? 'utf16le' : 'latin1').split('\0').filter(Boolean))
        }
      }
    }
  }
  return [...new Set(paths)]
}
