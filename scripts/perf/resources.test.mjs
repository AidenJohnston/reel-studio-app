import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, linkSync, rmSync, statSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { diskBytes, trialLoad, waitForTrialLoad, requireAdmission, parseSwapUsage, createScratch } from './resources.mjs'

test('disk accounting counts a hard-linked inode once', () => {
  const scratch = mkdtempSync('/tmp/rs-perf-disk-test-')
  try {
    const file = join(scratch, 'file')
    writeFileSync(file, 'unique bytes')
    linkSync(file, join(scratch, 'link'))
    assert.deepEqual(diskBytes(scratch), { logical: 12, allocated: statSync(file).blocks * 512, files: 1, apfsClonePhysicalUsage: 'not measured' })
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})

test('load at the threshold is refused and retried before measurement', async () => {
  const readings = [8, 26.44, 4].map(trialLoad)
  const recorded = []
  const accepted = await waitForTrialLoad({ signal: new AbortController().signal, checkResources() {},
    readLoad: () => readings.shift(), record: (load) => recorded.push(load), retryMs: 1 })
  assert.equal(accepted.oneMinute, 4)
  assert.deepEqual(recorded.map((load) => load.accepted), [false, false, true])
})

test('admission refuses a busy host before setup and swap occupancy is contextual', () => {
  const swap = parseSwapUsage('total = 9200.00M  used = 8200.00M  free = 1000.00M')
  assert.ok(swap.usedFraction > 0.89)
  assert.equal(swap.usedBytes, 8200 * 1024 ** 2)
  const recorded = []
  const options = { signal: new AbortController().signal, checkResources() {}, record: (load) => recorded.push(load) }
  assert.throws(() => requireAdmission({ ...options, readLoad: () => ({ oneMinute: 8, threshold: 8, accepted: false, swap }) }), /REFUSED before build/)
  const accepted = requireAdmission({ ...options, readLoad: () => trialLoad(4, swap) })
  assert.equal(accepted.accepted, true)
  assert.deepEqual(recorded.map((load) => load.accepted), [false, true])
})

test('scratch creation returns its canonical filesystem path', () => {
  const scratch = createScratch()
  try {
    assert.equal(scratch, realpathSync(scratch))
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
