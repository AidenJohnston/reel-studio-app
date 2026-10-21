import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanupEngines } from './processes.mjs'

test('scratch registry survives an Electron crash and cleanup stops its detached engine and media child', async () => {
  const scratch = mkdtempSync('/tmp/rs-perf-crash-test-')
  const registry = join(scratch, 'engine-pids.jsonl')
  const bootstrap = fileURLToPath(new URL('./bootstrap.cjs', import.meta.url))
  const engine = join(scratch, 'engine.cjs'), media = join(scratch, 'media.cjs'), entry = join(scratch, 'entry.cjs')
  writeFileSync(media, "console.log('ready'); setInterval(() => {}, 1000)")
  writeFileSync(engine, `const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(media)}], { stdio: 'inherit' }); setInterval(() => {}, 1000)`)
  writeFileSync(entry, `const child = require('node:child_process').spawn(process.execPath, [${JSON.stringify(engine)}, 'reelengine', 'render'], { env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.pipe(process.stdout)`)
  const parentFile = join(scratch, 'electron.cjs')
  writeFileSync(parentFile, `const fake = { ipcMain: { handle() {} }, app: { on() {} } };
    new Function('require', require('node:fs').readFileSync(${JSON.stringify(bootstrap)}, 'utf8'))((id) => id === 'electron' ? fake : require(id));`)
  const parent = spawn(process.execPath, [parentFile], { env: { ...process.env, REELSTUDIO_PERF_PID_REGISTRY: registry, REELSTUDIO_PERF_ENTRY: entry }, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(parent, 'exit')
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Engine did not start')), 10000)
      parent.stdout.on('data', (chunk) => { if (chunk.toString().includes('ready')) { clearTimeout(timeout); resolve() } })
      parent.once('exit', () => { clearTimeout(timeout); reject(new Error('Parent exited before ready')) })
    })
    const [{ pid }] = readFileSync(registry, 'utf8').trim().split('\n').map(JSON.parse)
    parent.kill('SIGKILL')
    await exited
    assert.doesNotThrow(() => process.kill(pid, 0))
    const result = await cleanupEngines(scratch, registry)
    assert.equal(result.registered, 1)
    assert.ok(result.signalled.some((p) => p.pid === pid))
    assert.ok(result.signalled.some((p) => p.pid !== pid))
    assert.deepEqual(result.survivors, [])
    writeFileSync(registry, JSON.stringify({ pid: process.pid }) + '\n')
    await assert.rejects(cleanupEngines(scratch, registry), /Refusing to signal PID/)
    assert.ok(existsSync(scratch))
  } finally {
    parent.kill('SIGKILL')
    writeFileSync(registry, '')
    await cleanupEngines(scratch, registry)
    rmSync(scratch, { recursive: true, force: true })
  }
})
