// The Listening setup stage with the stand-in engine: a listening model found on this computer is reused (no
// download), a missing one downloads with MB progress and Pause, and either way the short timing check runs, its
// answer is saved, and the stage moves on by itself. Skip moves on at once; only a failed check waits for Next.
// Stand-in model files are pinned through REELSTUDIO_TEST_SPEECH_PINS, so nothing reads the real Hugging Face cache
// (helpers.ts points HF_HUB_CACHE at an empty folder).
// Screenshots go to e2e/screenshots/listening/.
import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SHOTS, launch, passMacStage } from './helpers'

const OUT = join(SHOTS, 'listening')

function fresh(name: string) {
  const dir = mkdtempSync(join(BASE, `listening-${name}-`))
  return { dir, userData: join(dir, 'user data'), models: join(dir, 'models') }
}

async function snap(page: Page, name: string, settle = 400): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await page.waitForTimeout(settle) // let the stage finish sliding in
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

async function toListening(page: Page): Promise<void> {
  await page.getByTestId('get-started').click()
  await passMacStage(page)
}

const connect = (page: Page) => page.getByText('Connect your AI editor')

test('a listening model already on this computer is used without a download, then the stage moves on by itself', async () => {
  const d = fresh('found')
  // A Hugging Face cache holding the (stand-in) pinned files, as another app would have left it.
  const files: Record<string, Buffer> = {
    'config.json': Buffer.from('{"model_type": "whisper"}'),
    'model.bin': Buffer.alloc(8 << 20, 3),
    'tokenizer.json': Buffer.from('{"version": "1.0"}'),
    'vocabulary.txt': Buffer.from('a\nb\n')
  }
  const snapshot = join(d.dir, 'hf', 'models--Systran--faster-whisper-small.en', 'snapshots', 'rev1')
  mkdirSync(snapshot, { recursive: true })
  for (const [n, b] of Object.entries(files)) writeFileSync(join(snapshot, n), b)
  const pins = join(d.dir, 'pins.json')
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  writeFileSync(pins, JSON.stringify({ 'small.en': { repo: 'Systran/faster-whisper-small.en', revision: 'rev1', files: Object.entries(files).map(([name, b]) => ({ name, size: b.length, sha256: sha(b) })) } }))

  const { app, page } = await launch({
    REELSTUDIO_USER_DATA: d.userData,
    REELSTUDIO_MODELS_DIR: d.models,
    HF_HUB_CACHE: join(d.dir, 'hf'),
    REELSTUDIO_TEST_SPEECH_PINS: pins,
    FAKE_ENGINE_SPEECH_CHECK: '3'
  })
  try {
    await toListening(page)
    await expect(page.getByTestId('model-heading')).toHaveText('Ready to listen')
    await expect(page.getByText('Found the listener on this computer. Using it, no download needed.')).toBeVisible()
    await expect(page.getByTestId('download-model')).toHaveCount(0)
    await expect(page.getByTestId('speech-check')).toHaveText('Getting the listener ready for this computer')
    await snap(page, '02-timing-check')
    await expect(page.getByTestId('speech-ready')).toHaveText('Set up for this computer', { timeout: 10_000 })
    await snap(page, '01-found-done', 250) // the success beat, before the stage leaves
    await expect(page.getByTestId('model-next')).toHaveCount(0)
    await expect(connect(page)).toBeVisible() // no click

    for (const [n, b] of Object.entries(files)) expect(readFileSync(join(d.models, 'small.en', n)).equals(b)).toBe(true)
    expect(existsSync(join(snapshot, 'model.bin'))).toBe(true) // copied, never moved out of the cache
    const settings = JSON.parse(readFileSync(join(d.userData, 'settings.json'), 'utf8'))
    expect(settings.speechCheck).toMatchObject({ threads: 4 })
  } finally {
    await app.close()
  }
})

test('without one it downloads with MB progress and Pause, and says what to do when the internet drops', async () => {
  const d = fresh('download')
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: d.userData, REELSTUDIO_MODELS_DIR: d.models, FAKE_ENGINE_DOWNLOAD_STEP: '0.5' })
  try {
    await toListening(page)
    await expect(page.getByTestId('model-heading')).toHaveText('One download, about 500 MB')
    await page.getByTestId('download-model').click()
    await expect(page.getByTestId('model-progress')).toHaveText(/^Downloading [1-9]\d* of 486 MB$/)
    await snap(page, '03-downloading')
    await page.getByTestId('pause-model').click()
    await expect(page.getByTestId('model-progress')).toHaveText(/^Paused at \d+ of 486 MB$/)
    await page.getByTestId('download-model').click() // "Keep downloading"
    await expect(page.getByTestId('model-heading')).toHaveText('Ready to listen', { timeout: 20_000 })
    await expect(connect(page)).toBeVisible({ timeout: 10_000 }) // after the timing check, with no click
  } finally {
    await app.close()
  }

  const o = fresh('offline')
  const offline = await launch({ REELSTUDIO_USER_DATA: o.userData, REELSTUDIO_MODELS_DIR: o.models, FAKE_ENGINE_DOWNLOAD_STEP: '0.1', FAKE_ENGINE_OFFLINE: '1' })
  try {
    await toListening(offline.page)
    await offline.page.getByTestId('download-model').click()
    await expect(offline.page.getByTestId('model-error')).toHaveText(
      'The download stopped. Check your internet connection and try again; it will pick up where it left off.'
    )
    await expect(offline.page.getByTestId('download-model')).toHaveText('Keep downloading')
    await snap(offline.page, '04-offline')
  } finally {
    await offline.app.close()
  }
})

test('Skip moves on at once; a failed timing check waits for Next', async () => {
  const d = fresh('skip')
  const { app, page } = await launch({ REELSTUDIO_USER_DATA: d.userData, REELSTUDIO_MODELS_DIR: d.models, FAKE_ENGINE_SPEECH_CHECK: '20' })
  try {
    await toListening(page)
    await page.getByTestId('download-model').click()
    await page.getByTestId('skip-check').click()
    await expect(connect(page)).toBeVisible({ timeout: 2000 })
  } finally {
    await app.close()
  }

  const f = fresh('failed')
  const failed = await launch({ REELSTUDIO_USER_DATA: f.userData, REELSTUDIO_MODELS_DIR: f.models, FAKE_ENGINE_FAIL: 'speech-check' })
  try {
    await toListening(failed.page)
    await failed.page.getByTestId('download-model').click()
    await expect(failed.page.getByTestId('speech-ready')).toHaveText(
      "I couldn't finish getting the listener ready for this computer, so it will use its usual settings. Everything still works."
    )
    await expect(failed.page.getByTestId('model-next')).toBeFocused()
    await snap(failed.page, '05-check-failed')
    await failed.page.keyboard.press('Enter')
    await expect(connect(failed.page)).toBeVisible()
  } finally {
    await failed.app.close()
  }
})
