// End to end on real raw takes, through the UI, with the real engine and a live AI.
// Skipped unless asked for:
//   REELSTUDIO_E2E_TAKES=<testset.json with {takes:[{file,path}]}>   (read in place, never copied into the repo)
//   REELSTUDIO_ENGINE_DIR=<engine folder with .venv>   REELSTUDIO_MODELS_DIR=<speech models>
//   REELSTUDIO_E2E_MUSIC=<song>;<song>   songs dropped on the Library first (read in place)
//   REELSTUDIO_E2E_ONLY=0,2              optional: only these take indexes
// The AI is the Claude Code app signed in on this computer: the run clicks "Use Claude (your Claude Code app)".
// Per take: drop -> first edit -> one note -> Export, then e2e/tools/check_export.py (verify,
// frames + contact sheet, music level in the gaps). Results: <BASE>/takes/<i>/result.json + results.jsonl.
import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { APP_DIR, BASE, ROOT, SHOTS, chooseClaudeCode, dropFiles, launch, passFirstRun, shot, writeNote } from './helpers'

const TESTSET = process.env.REELSTUDIO_E2E_TAKES
const takes: { file: string; path: string }[] = TESTSET ? JSON.parse(readFileSync(TESTSET, 'utf8')).takes : []
const only = process.env.REELSTUDIO_E2E_ONLY?.split(',').map(Number)
const OUT = process.env.REELSTUDIO_E2E_OUT ?? join(BASE, 'takes')

// One note per take, varied on purpose. REELSTUDIO_E2E_NOTES (a JSON array) overrides them, so notes
// that quote a specific take ("cut the part where I say ...") stay out of the repo.
const NOTES: string[] = process.env.REELSTUDIO_E2E_NOTES
  ? JSON.parse(process.env.REELSTUDIO_E2E_NOTES)
  : [
      'make the captions smaller',
      'the music is too loud at the start',
      'add a picture when I talk about my family',
      'move the card to the side',
      'cut the last sentence'
    ]

test.skip(!TESTSET, 'set REELSTUDIO_E2E_TAKES to run')

function newest(dir: string, filter: (n: string) => boolean): string | null {
  if (!existsSync(dir)) return null
  const all = readdirSync(dir)
    .filter(filter)
    .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return all.length ? join(dir, all[0].n) : null
}

async function logJobs(page: Page, file: string): Promise<void> {
  await page.evaluate(() => window.reel.jobs.onEvent((e) => console.log('JOB ' + JSON.stringify(e))))
  page.on('console', (m) => {
    if (m.text().startsWith('JOB ')) appendFileSync(file, `${new Date().toISOString()} ${m.text().slice(4)}\n`)
  })
}

takes.forEach((take, i) => {
  if (only && !only.includes(i)) return
  test(`take ${i}: ${take.file}`, async () => {
    test.setTimeout(90 * 60_000)
    const out = join(OUT, String(i))
    mkdirSync(out, { recursive: true })
    mkdirSync(join(SHOTS, 'takes'), { recursive: true })
    const timings: Record<string, number> = {}
    const result: Record<string, unknown> = { take: take.file, note: NOTES[i % NOTES.length], timings }
    const save = () => {
      writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2))
    }

    const { app, page } = await launch({ REELSTUDIO_MOCK_AI: '0' })
    try {
      await passFirstRun(page)
      await logJobs(page, join(out, 'events.log'))

      // Which AI is in use: the Claude Code app on this computer, chosen here (nothing picks it on its own).
      await page.getByTestId('nav-settings').click()
      await chooseClaudeCode(page, 10_000)
      const connected = page.getByTestId('ai-connected')
      await connected.waitFor({ timeout: 10_000 }).catch(() => {})
      result.ai = (await connected.isVisible()) ? await connected.innerText() : 'none'
      await shot(page, `takes/${i}-00-settings`)

      const music = (process.env.REELSTUDIO_E2E_MUSIC ?? '').split(';').filter(Boolean)
      if (music.length && i === (only?.[0] ?? 0)) {
        await page.getByTestId('nav-library').click()
        await page.getByTestId('file-input').setInputFiles(music)
        await page.waitForTimeout(3000)
      }

      await page.getByTestId('nav-home').click()
      await page.getByTestId('new-video').click()
      const t0 = Date.now()
      await dropFiles(page, 'drop-zone', [take.path])
      await expect(page.getByText('Making your reel')).toBeVisible()
      let n = 0
      const look = page.getByTestId('first-look')
      const seen = { timeLeft: new Set<string>(), thinking: false }
      // poll every 1 s: the first look's arrival, time left and "thinking" on the Working screen
      while (!(await page.getByTestId('player').isVisible())) {
        if (await page.getByTestId('screen-error').isVisible()) throw new Error('screen error')
        if (Date.now() - t0 > 60 * 60_000) throw new Error('first edit took over an hour')
        if (timings.firstLookSec === undefined && (await look.isVisible())) {
          timings.firstLookSec = Math.round((Date.now() - t0) / 1000)
          result.firstLookLabel = await look.innerText()
          result.firstLookKind = await look.getAttribute('data-kind')
          // a real, playing video: a reel-media URL, decoded frames, time moving
          await page.waitForTimeout(2500)
          result.firstLookVideo = await page.evaluate(() => {
            const v = document.querySelector('[data-testid=first-look-video]') as HTMLVideoElement | null
            return v ? { src: v.currentSrc, readyState: v.readyState, t: v.currentTime, w: v.videoWidth, h: v.videoHeight, paused: v.paused } : null
          })
          await shot(page, `takes/${i}-01-first-look`)
          save()
        }
        const tl = await page.getByTestId('time-left').innerText().catch(() => '')
        if (tl) seen.timeLeft.add(tl)
        if (!seen.thinking && (await page.getByTestId('thinking').isVisible())) {
          seen.thinking = true
          await shot(page, `takes/${i}-01-thinking`)
        }
        if (n % 60 === 0) await shot(page, `takes/${i}-01-working-${n / 60}`)
        n++
        await page.waitForTimeout(1000)
      }
      result.timeLeftSeen = [...seen.timeLeft]
      result.thinkingSeen = seen.thinking
      timings.firstEditSec = Math.round((Date.now() - t0) / 1000)
      save()
      await shot(page, `takes/${i}-02-reel`)
      result.firstSummary = await page.locator('.bubble.editor:not(.working):not(.reply-pending)').last().innerText().catch(() => '')

      const replies = page.locator('.bubble.editor:not(.working):not(.reply-pending)')
      const before = await replies.count()
      const t1 = Date.now()
      await writeNote(page, String(result.note))
      await page.keyboard.press('Enter')
      // a fast note shows its reply at once (before its render); the note progress shows time left
      const noteSeen = { timeLeft: new Set<string>() }
      while ((await replies.count()) < before + 1) {
        if (Date.now() - t1 > 40 * 60_000) throw new Error('note took over 40 minutes')
        if (timings.noteReplySec === undefined && (await page.getByTestId('bubble-reply').isVisible())) {
          timings.noteReplySec = Math.round((Date.now() - t1) / 1000)
          await shot(page, `takes/${i}-03-note-reply-early`)
        }
        const tl = await page.getByTestId('note-time-left').innerText().catch(() => '')
        if (tl) {
          if (!noteSeen.timeLeft.size) await shot(page, `takes/${i}-03-note-progress`)
          noteSeen.timeLeft.add(tl)
        }
        await page.waitForTimeout(1000)
      }
      result.noteTimeLeftSeen = [...noteSeen.timeLeft]
      await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 5 * 60_000 })
      timings.noteSec = Math.round((Date.now() - t1) / 1000)
      result.noteReply = await replies.last().innerText()
      save()
      await shot(page, `takes/${i}-03-after-note`)

      const t2 = Date.now()
      await page.getByTestId('export').click()
      await expect(page.getByText('Saved to your computer')).toBeVisible({
        timeout: 30 * 60_000
      })
      timings.exportSec = Math.round((Date.now() - t2) / 1000)
      await shot(page, `takes/${i}-04-exported`)
      await page.getByRole('button', { name: 'Done' }).click()

      const exportFile = newest(join(ROOT, 'Library', 'Exports'), (f) => f.endsWith('.mp4'))
      const project = newest(join(ROOT, 'Projects'), (f) => existsSync(join(ROOT, 'Projects', f, 'project.json')))
      expect(exportFile).toBeTruthy()
      result.exportFile = exportFile
      result.project = project
      const engineDir = resolve(process.env.REELSTUDIO_ENGINE_DIR!)
      const py = process.env.REELSTUDIO_PYTHON ?? join(engineDir, '.venv', 'Scripts', 'python.exe')
      const check = execFileSync(
        py,
        [join(APP_DIR, 'e2e', 'tools', 'check_export.py'), '--project', project!, '--export', exportFile!, '--out', join(out, 'frames')],
        { env: { ...process.env, PYTHONPATH: engineDir, PYTHONUTF8: '1' }, maxBuffer: 64 * 1024 * 1024 }
      ).toString()
      result.check = JSON.parse(check.trim().split('\n').pop()!)
      save()
      appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify(result) + '\n')
      console.log(`take ${i} done: ${JSON.stringify(timings)} -> ${join(out, 'result.json')}`)
      const v = (result.check as any).verify?.event
      expect(v?.event, 'verify finished').toBe('done')
      expect(v?.result?.ok, 'verify ok').toBe(true)
    } catch (e) {
      result.error = String((e as Error)?.stack ?? e)
      save()
      appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify(result) + '\n')
      await shot(page, `takes/${i}-99-failed`).catch(() => {})
      throw e
    } finally {
      await app.close().catch(() => {})
    }
  })
})
