export function summarize(values) {
  if (!values.length || values.some((v) => !Number.isFinite(v))) throw new Error('Expected finite, nonempty measurements')
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted.at(-1), spread: sorted.at(-1) - sorted[0], n: sorted.length }
}

export function aggregate(runs) {
  const clips = {}
  for (const clip of new Set(runs.map((r) => r.clip))) {
    const selected = runs.filter((r) => r.clip === clip && !r.error)
    if (!selected.length) continue
    const keys = Object.keys(selected[0].metrics)
    clips[clip] = Object.fromEntries(keys.map((key) => [key, summarize(selected.map((r) => r.metrics[key]))]))
  }
  return clips
}

export function report(result) {
  const rows = ['| Clip | Metric | Median | Min | Max | Runs |', '|---|---|---:|---:|---:|---:|']
  for (const [clip, metrics] of Object.entries(result.summary)) {
    for (const [key, s] of Object.entries(metrics)) rows.push(`| ${clip} | ${key} | ${s.median.toFixed(2)} | ${s.min.toFixed(2)} | ${s.max.toFixed(2)} | ${s.n} |`)
  }
  const error = result.error ? `\nBenchmark stopped: ${result.error.split('\n')[0]}\n` : ''
  const cleanup = result.cleanupErrors?.length ? `\nCleanup failed: ${result.cleanupErrors.join('; ')}\n` : ''
  return `# ${result.ref} at ${result.sha}\n\n${result.runs.filter((r) => r.error).length} failed runs. See results.json for events, IPC responses, engine commands, output checks, and machine load.\n${error}${cleanup}\n${rows.join('\n')}\n`
}

export function compare(before, after, { wholeRef = false } = {}) {
  for (const side of [before, after]) {
    if (side.error || side.runs.some((r) => r.error) || !Object.keys(side.summary).length) throw new Error(`Cannot compare an incomplete or failed benchmark: ${side.ref}`)
    if (!side.finishedAt || side.cleaned !== true || side.cleanupErrors?.length) throw new Error(`Cannot compare an unfinished benchmark or failed cleanup: ${side.ref}`)
  }
  const rows = ['| Clip | Metric | Before | After | Delta | Delta % | Spread before / after | Verdict |', '|---|---|---:|---:|---:|---:|---:|---|']
  for (const [clip, metrics] of Object.entries(before.summary)) {
    const aClip = before.runs.find((r) => r.clip === clip && !r.error)
    const bClip = after.runs.find((r) => r.clip === clip && !r.error)
    if (!bClip) continue
    const sameConfig = ['method', 'harnessSha256', 'replayNote', 'adoptModel'].every((key) => before[key] === after[key])
      && (wholeRef || before.dependencyLockSha256 === after.dependencyLockSha256)
      && before.ffmpeg.sha256 === after.ffmpeg.sha256 && before.model.sha256 === after.model.sha256
      && JSON.stringify(before.pythonPackages) === JSON.stringify(after.pythonPackages)
    if (aClip.input.sha256 !== bClip.input.sha256 || !sameConfig) throw new Error(`Incompatible benchmark inputs, dependencies or method for ${clip}`)
    for (const [key, a] of Object.entries(metrics)) {
      const b = after.summary[clip]?.[key]
      if (!b) continue
      if (before.expectedRuns && a.n !== before.expectedRuns || after.expectedRuns && b.n !== after.expectedRuns) throw new Error(`Incomplete run count for ${clip} ${key}`)
      const delta = b.median - a.median
      const verdict = a.n < 2 || b.n < 2 ? 'insufficient runs' : Math.abs(delta) <= Math.max(a.spread, b.spread) ? 'noise' : delta < 0 ? 'lower' : 'higher'
      rows.push(`| ${clip} | ${key} | ${a.median.toFixed(2)} | ${b.median.toFixed(2)} | ${delta.toFixed(2)} | ${a.median ? (100 * delta / a.median).toFixed(1) : 'n/a'} | ${a.spread.toFixed(2)} / ${b.spread.toFixed(2)} | ${verdict} |`)
    }
  }
  const dependencyNote = before.dependencyLockSha256 !== after.dependencyLockSha256 ? '\nJavaScript dependency locks differ. This compares the whole refs as built; it cannot attribute a change to one feature alone.\n' : ''
  return `# ${before.ref} → ${after.ref}\n\nA difference at or below the larger full observed range is noise. Single runs cannot establish a gain. Shared-machine load and thermal drift are not controlled.\n${dependencyNote}\n${rows.join('\n')}\n`
}
