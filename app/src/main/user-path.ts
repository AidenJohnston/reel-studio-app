// Test switch only (REELSTUDIO_TEST_VENDOR_HOME, Windows): OpenAI's Codex installer adds its folder to the user PATH
// and rewrites the value's type (REG_EXPAND_SZ -> REG_SZ; measured 2026-10-25). A test install into a throwaway home
// must leave the real PATH exactly as it was, so it is read before and written back after.
import { spawn } from 'node:child_process'
import { win32 } from 'node:path'

const reg = (): string => win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')

function run(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    const c = spawn(reg(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    c.stdout.on('data', (d) => (out += String(d)))
    c.on('error', () => resolve({ code: -1, out }))
    c.on('close', (code) => resolve({ code, out }))
  })
}

/** `reg query` output -> { type, value } of HKCU\Environment\Path, or null when it has none. */
export function parseRegPath(out: string): { type: 'REG_SZ' | 'REG_EXPAND_SZ'; value: string } | null {
  const m = out.match(/^\s+Path\s+(REG_EXPAND_SZ|REG_SZ)\s{4}(.*?)\r?$/m)
  return m ? { type: m[1] as 'REG_SZ' | 'REG_EXPAND_SZ', value: m[2] } : null
}

export async function withUserPathKept<T>(fn: () => Promise<T>, log: (s: string) => void): Promise<T> {
  const before = parseRegPath((await run(['query', 'HKCU\\Environment', '/v', 'Path'])).out)
  try {
    return await fn()
  } finally {
    const r = before
      ? await run(['add', 'HKCU\\Environment', '/v', 'Path', '/t', before.type, '/d', before.value, '/f'])
      : await run(['delete', 'HKCU\\Environment', '/v', 'Path', '/f'])
    log(`[vendor] test switch: user PATH put back (${before ? before.type : 'none'}), reg exit ${r.code}`)
  }
}
