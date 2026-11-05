import { describe, expect, it } from 'vitest'
import { parseTypeperf, stats } from '../perf/measure'

describe('app perf summary', () => {
  it('takes the middle of an odd count and the mean of the two middles of an even one', () => {
    expect(stats([30, 10, 20])).toEqual({ median: 20, min: 10, max: 30, spreadPct: 100, n: 3 })
    expect(stats([40, 10, 30, 20])).toEqual({ median: 25, min: 10, max: 40, spreadPct: 120, n: 4 })
  })

  it('reads the CPU sample out of typeperf output, not its header', () => {
    const out = [
      '',
      '"(PDH-CSV 4.0)","\\\\MY-PC\\Processor(_Total)\\% Processor Time"',
      '"11/05/2026 04:50:01.123","37.512345"',
      '',
      'Exiting, please wait...',
      'The command completed successfully.',
      ''
    ].join('\r\n')
    expect(parseTypeperf(out)).toBeCloseTo(0.37512345, 6)
    expect(parseTypeperf(out.replace('37.512345', '37,5'))).toBeCloseTo(0.375, 6)
    expect(parseTypeperf('Error: No valid counters.\r\n')).toBeNull()
  })
})
