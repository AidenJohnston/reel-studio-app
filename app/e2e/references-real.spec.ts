// A reference reel measured by the real engine and the real listening model, through the app: the readout's talking
// pace, shot length and opening line come from faster-whisper words and the scene-change finder (engine measure.py),
// not the stand-in's made-up numbers. Opt-in, because it needs the engine's Python, a downloaded listening model and a
// reel with speech:
//   REELSTUDIO_REAL_REFERENCE  a video file with clear speech you may use (a Creative Commons reel)
//   REELSTUDIO_ENGINE_DIR, REELSTUDIO_PYTHON  the real engine and its Python (not dev/fake-engine)
//   REELSTUDIO_MODELS_DIR  a folder with the listening model already in it
// It prints what was stored, so a run's evidence is the numbers themselves.
//
// Run: npm run build && npx playwright test e2e/references-real.spec.ts
import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, passFirstRun, root, shot } from './helpers'

const REEL = process.env.REELSTUDIO_REAL_REFERENCE

test('a real reel is listened to and measured, and the readout says what it found', async () => {
  test.skip(!REEL || !process.env.REELSTUDIO_ENGINE_DIR || /fake-engine/.test(process.env.REELSTUDIO_ENGINE_DIR), 'needs the real engine and a reel with speech')
  test.setTimeout(15 * 60_000)
  const { app, page } = await launch()
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-style').click()
    const section = page.getByTestId('references')
    await section.getByTestId('file-input').first().setInputFiles(REEL!)
    const numbers = section.getByTestId('reference-numbers')
    // fails if the reel was not listened to (no model, no speech found) or not measured at all
    await expect(numbers).toContainText('words a second', { timeout: 10 * 60_000 })
    await expect(section).not.toContainText('not listened to')
    await numbers.first().scrollIntoViewIfNeeded()
    await shot(page, 'references-real-01-measured')

    const stored = JSON.parse(readFileSync(join(root(), 'References', 'references.json'), 'utf8'))
    const m = stored.references[0].measure
    console.log(`[evidence] references.json: ${JSON.stringify(stored, null, 1).slice(0, 4000)}`)
    expect(m.speechMissing ?? null).toBeNull()
    expect(m.speech?.words).toBeGreaterThan(5)
    expect(m.speech?.wordsPerSecond).toBeGreaterThan(0.5)
    expect(m.shots?.count).toBeGreaterThanOrEqual(1)
  } finally {
    await app.close().catch(() => {})
  }
})
