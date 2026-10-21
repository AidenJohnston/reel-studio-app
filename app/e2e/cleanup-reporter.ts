import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default class CleanupReporter implements Reporter {
  private root = mkdtempSync(join(tmpdir(), 'rs-e2e-run-'))
  private failed = new Set<number>()
  private error = false

  constructor() {
    process.env.REELSTUDIO_E2E_TMP = this.root
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    if (result.status !== 'passed' && result.status !== 'skipped') this.failed.add(result.workerIndex)
  }

  onError(): void {
    this.error = true
  }

  onEnd(): void {
    let kept = false
    for (const name of readdirSync(this.root)) {
      const dir = join(this.root, name)
      if (process.env.KEEP_E2E_TMP === '1' || this.error || [...this.failed].some((i) => name.startsWith(`rs-e2e-${i}-`))) {
        console.log(`Kept e2e files: ${dir}`)
        kept = true
      } else rmSync(dir, { recursive: true, force: true })
    }
    if (!kept) rmSync(this.root, { recursive: true, force: true })
  }
}
