import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compare, summarize } from './metrics.mjs'

test('median and spread retain the observed range', () => {
  assert.deepEqual(summarize([12, 1, 4, 7]), { median: 5.5, min: 1, max: 12, spread: 11, n: 4 })
  assert.throws(() => summarize([NaN]), /finite/)
})

test('comparison labels differences within the larger range as noise', () => {
  const result = (values) => ({ ref: 'fixture', method: 'test', replayNote: false,
    finishedAt: '2026-10-21T00:00:00Z', cleaned: true,
    ffmpeg: { sha256: 'ffmpeg' }, model: { sha256: 'model' }, pythonPackages: [],
    runs: [{ clip: 'clip', input: { sha256: 'clip' } }],
    summary: { clip: { ms: summarize(values) } } })
  assert.match(compare(result([90, 100, 110]), result([85, 90, 95])), /noise/)
  assert.match(compare(result([90, 100, 110]), result([40, 50, 60])), /lower/)
  assert.match(compare(result([100]), result([50])), /insufficient runs/)
  const incompatible = result([40, 50, 60])
  incompatible.runs[0].input.sha256 = 'another clip'
  assert.throws(() => compare(result([90, 100, 110]), incompatible), /Incompatible/)
  const failed = result([40, 50, 60])
  failed.error = 'render did not finish'
  assert.throws(() => compare(result([90, 100, 110]), failed), /incomplete or failed/)
  const dirty = result([40, 50, 60])
  dirty.cleanupErrors = ['worktree removal failed']
  assert.throws(() => compare(result([90, 100, 110]), dirty), /failed cleanup/)
  const changedDependencies = result([40, 50, 60])
  changedDependencies.dependencyLockSha256 = 'another lock'
  assert.throws(() => compare(result([90, 100, 110]), changedDependencies), /Incompatible/)
  assert.match(compare(result([90, 100, 110]), changedDependencies, { wholeRef: true }), /dependency locks differ/)
})
