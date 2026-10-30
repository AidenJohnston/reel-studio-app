import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BASE, ROOT, launch, passFirstRun } from './helpers'

test('fails if the faster exports setting is not saved or applied to new projects', async () => {
  test.skip(!process.env.REELSTUDIO_PYTHON, 'set REELSTUDIO_PYTHON to a Python with engine dependencies')
  const video = join(BASE, 'phone.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x284:rate=60:duration=2',
    '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', video])
  const env = { REELSTUDIO_ENGINE_DIR: resolve(__dirname, '../../engine'), REELENGINE_MODEL_MIRROR: 'http://127.0.0.1:9' }
  let running = await launch(env)
  try {
    await passFirstRun(running.page)
    await running.page.getByTestId('nav-settings').click()
    const toggle = running.page.getByTestId('faster-exports')
    await expect(toggle).not.toBeChecked()
    await toggle.focus()
    await running.page.keyboard.press('Space')
    await expect(toggle).toBeChecked()
    await running.app.close()
    running = await launch(env)
    await running.page.getByTestId('nav-settings').click()
    await expect(running.page.getByTestId('faster-exports')).toBeChecked()
    const created = await running.page.evaluate((file) => window.reel.projects.create([file]), video)
    const file = join(ROOT, 'Projects', created.slug, 'project.json')
    await expect.poll(() => existsSync(file)).toBe(true)
    await running.page.evaluate((id) => window.reel.jobs.cancel(id), created.jobId)
    expect(JSON.parse(readFileSync(file, 'utf8')).format.fps).toBe(30)
    await running.page.getByTestId('faster-exports').uncheck()
    await expect(running.page.getByTestId('faster-exports')).not.toBeChecked()
    const next = await running.page.evaluate((file) => window.reel.projects.create([file]), video)
    const nextFile = join(ROOT, 'Projects', next.slug, 'project.json')
    await expect.poll(() => existsSync(nextFile)).toBe(true)
    await running.page.evaluate((id) => window.reel.jobs.cancel(id), next.jobId)
    expect(JSON.parse(readFileSync(nextFile, 'utf8')).format.fps).toBe(60)
    expect(JSON.parse(readFileSync(file, 'utf8')).format.fps).toBe(30)
  } finally {
    await running.app.close().catch(() => {})
    rmSync(BASE, { recursive: true, force: true })
  }
})
