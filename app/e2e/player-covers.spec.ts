// Switching between versions on the Reel screen must not decode a cover it has already shown. Each switch
// replaces the <video>, and a 1080x1920 cover decoded again on every switch kept about 1.9 MiB of renderer
// memory per switch. The decodes are counted in a Chromium trace while switching back and forth.
//
// Run: npx playwright test e2e/player-covers.spec.ts (after npm run build).
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, passFirstRun } from './helpers'

async function pick(page: Page, n: number): Promise<void> {
  await page.getByRole('radio', { name: `Version ${n}`, exact: true }).click()
  await page.waitForFunction((n) => {
    const v = document.querySelector<HTMLVideoElement>('[data-testid="player"]')
    const at = new RegExp(`[\\\\/]versions[\\\\/]v${n}[\\\\/]`)
    return !!v && at.test(decodeURIComponent(v.currentSrc)) && at.test(decodeURIComponent(v.poster))
  }, n)
  // Lets the cover of this switch paint before the next one replaces it.
  await page.waitForTimeout(500)
}

async function pngDecodes(app: ElectronApplication, during: () => Promise<void>): Promise<number> {
  await app.evaluate(({ contentTracing }) => contentTracing.startRecording({ included_categories: ['disabled-by-default-devtools.timeline'] }))
  await during()
  const file = join(BASE, 'player-trace.json')
  await app.evaluate(({ contentTracing }, file) => contentTracing.stopRecording(file), file)
  const events: { name: string; ph: string; args?: { imageType?: string } }[] = JSON.parse(readFileSync(file, 'utf8')).traceEvents
  return events.filter((e) => e.name === 'Decode Image' && e.ph !== 'E' && e.args?.imageType === 'png').length
}

test('switching back to a version does not decode its cover again', async () => {
  test.setTimeout(10 * 60_000)
  const media = makeMedia()
  const { app, page } = await launch()
  await passFirstRun(page)
  await page.getByTestId('new-video').click()
  await page.getByTestId('file-input').setInputFiles([media.video])
  await expect(page.getByTestId('player')).toBeVisible({ timeout: 5 * 60_000 })
  await page.getByTestId('edit-myself').click()
  await page.getByTestId('mirror-on').check()
  await page.getByTestId('make-version').click()
  await expect(page.getByTestId('versions').getByText('Version 2')).toBeVisible({ timeout: 5 * 60_000 })

  await pick(page, 1)
  await pick(page, 2)
  const decodes = await pngDecodes(app, async () => {
    for (const n of [1, 2, 1, 2]) await pick(page, n)
  })
  expect(decodes).toBe(0)
  await app.close()
})
