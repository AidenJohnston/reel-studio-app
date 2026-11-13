import { defineConfig } from '@playwright/test'

// Report-only timings of the app itself (README.md). Separate from e2e so `npm run e2e` never runs them.
export default defineConfig({
  testDir: '.',
  testMatch: '*.perf.ts',
  timeout: 60 * 60_000,
  expect: { timeout: 30_000 },
  workers: 1,
  reporter: [['list'], ['../e2e/cleanup-reporter.ts']],
  outputDir: '../test-results/perf'
})
