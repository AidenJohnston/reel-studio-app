// First run with the REAL engine: the speech model downloads through the UI with real progress.
// Skipped unless REELSTUDIO_E2E_FIRSTRUN=1 and REELSTUDIO_ENGINE_DIR point at the real engine.
// Uses REELENGINE_MODEL (default tiny.en here, ~78 MB) into a fresh, empty models folder.
import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SHOTS, launch, passMacStage, shot } from './helpers'

test.skip(process.env.REELSTUDIO_E2E_FIRSTRUN !== '1', 'set REELSTUDIO_E2E_FIRSTRUN=1 to run')

test('first run downloads the listening model with progress', async () => {
  test.setTimeout(30 * 60_000)
  mkdirSync(join(SHOTS, 'firstrun'), { recursive: true })
  const models = join(BASE, 'fresh models ü')
  const model = process.env.REELENGINE_MODEL ?? 'tiny.en'
  const { app, page } = await launch({ REELSTUDIO_MODELS_DIR: models, REELENGINE_MODEL: model })
  try {
    await page.getByTestId('get-started').click()
    await passMacStage(page)
    await shot(page, 'firstrun/01-download')
    const t0 = Date.now()
    await page.getByTestId('download-model').click()
    const seen = new Set<number>()
    // When the download finishes the screen moves on to "Connect your AI editor" by itself.
    const connect = page.getByText('Connect your AI editor')
    // A dropped connection stops the download with an error banner and a "Keep downloading" button, like a
    // person would see it. Click it, as they would; the engine resumes the .part file with an HTTP Range request.
    const again = page.getByTestId('download-model')
    let retries = 0
    while (!(await connect.isVisible())) {
      if ((await again.isVisible()) && (await page.locator('.banner.error').count()) > 0) {
        const why = await page.locator('.banner.error').first().innerText().catch(() => '')
        if (++retries > 5) throw new Error(`download stopped ${retries} times: ${why}`)
        console.log(`download stopped (${why}); clicking "${await again.innerText()}" (retry ${retries})`)
        await shot(page, `firstrun/02-stopped-${retries}`)
        await again.click()
        await page.waitForTimeout(2000)
      }
      const txt = (await page.locator('text=/Downloading\\S* \\d+%/').first().innerText().catch(() => '')) || ''
      const m = /(\d+)%/.exec(txt)
      if (m) seen.add(Number(m[1]))
      if (seen.size === 3) await shot(page, 'firstrun/02-progress')
      if (Date.now() - t0 > 25 * 60_000) throw new Error('download took over 25 minutes')
      await page.waitForTimeout(300)
    }
    const secs = Math.round((Date.now() - t0) / 1000)
    const pcts = [...seen].sort((a, b) => a - b)
    console.log(`model ${model} downloaded in ${secs}s (${retries} resumed after a stop), progress seen: ${pcts.join(',')}`)
    expect(pcts.length, 'saw the progress move').toBeGreaterThan(2)
    expect(readdirSync(join(models, model))).toEqual(expect.arrayContaining(['model.bin', 'config.json']))
    expect(existsSync(join(models, model, 'model.bin.part'))).toBe(false)
    await shot(page, 'firstrun/03-connect')
  } finally {
    await app.close()
  }
})
