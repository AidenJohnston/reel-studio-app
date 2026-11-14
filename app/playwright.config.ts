import { defineConfig, type ReporterDescription } from '@playwright/test'

const reporter: ReporterDescription[] = [['list'], ['./e2e/cleanup-reporter.ts']]
// CI uploads this report with test-results when a shard fails (.github/workflows/ci.yml, e2e job).
if (process.env.CI) reporter.push(['html', { open: 'never' }])

export default defineConfig({
  testDir: './e2e',
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter,
  outputDir: './test-results'
})
