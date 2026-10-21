import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, linkSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { diskBytes, trialLoad, waitForTrialLoad } from './resources.mjs'

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
