import { clipboard } from 'electron'
import { spawn } from 'node:child_process'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function filesFromArgv(argv: string[], cwd: string, defaultApp: boolean): string[] {
  return argv.slice(defaultApp ? 2 : 1).filter((arg) => !arg.startsWith('-')).map((arg) => isAbsolute(arg) ? arg : resolve(cwd, arg))
}

export async function clipboardFiles(): Promise<string[]> {
  const paths: string[] = []
  for (const item of await clipboard.read()) {
    for (const type of item.types) {
      if (type === 'electron application/osclipboard;format="public.file-url"') {
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
