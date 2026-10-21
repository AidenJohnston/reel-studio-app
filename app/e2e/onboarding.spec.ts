// First run as a new person sees it: welcome, "Your Mac" (macOS only), listening model, AI editor, then Home.
// Each run gets its own empty profile and a stand-in Documents folder. macOS's own questions cannot be answered from
// a test, so a test build stands in for them (main/permissions.ts parseFakes), never opens System Settings (it logs
// the page instead), and shows the permission helper at a fixed place; everything else is the real app.
//
// Screenshots go to e2e/screenshots/onboarding/. REELSTUDIO_E2E_RECORD=<file.mp4> also records the walk (needs
// ffmpeg). Playwright's own recordVideo option hangs the Electron launch, so this uses the DevTools screencast.
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SHOTS, launch } from './helpers'

const MAC = process.platform === 'darwin'
const OUT = join(SHOTS, 'onboarding')
const RECORD = process.env.REELSTUDIO_E2E_RECORD

function fresh(name: string) {
  const dir = mkdtempSync(join(BASE, `onboarding-${name}-`))
  const documents = join(dir, 'Documents')
  const userData = join(dir, 'user data')
  // No REELSTUDIO_ROOT: the default folder, "Documents › Reel Studio", inside the stand-in Documents.
  return {
    root: join(documents, 'Reel Studio'),
    userData,
    env: { REELSTUDIO_ROOT: '', REELSTUDIO_DOCUMENTS: documents, REELSTUDIO_USER_DATA: userData, REELSTUDIO_MODELS_DIR: join(dir, 'models') }
  }
}

/** System Settings pages the app would have opened. */
const opened = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as any).__reelPermLog.opened)

/** The helper window beside System Settings, once it is open. */
async function helperWindow(app: ElectronApplication, title: string): Promise<Page> {
  await expect.poll(async () => (await Promise.all(app.windows().map((w) => w.title()))).includes(title)).toBe(true)
  for (const w of app.windows()) if ((await w.title()) === title) return w
  throw new Error(`no helper window "${title}"`)
}

/** Every repaint of the page as a frame, then one mp4 that keeps each frame on screen as long as it really was. */
async function record(page: Page, out: string): Promise<() => Promise<void>> {
  const dir = mkdtempSync(join(BASE, 'frames-'))
  const frames: { file: string; t: number }[] = []
  const cdp = await page.context().newCDPSession(page)
  cdp.on('Page.screencastFrame', (f) => {
    const file = join(dir, `${String(frames.length).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(f.data, 'base64'))
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 })
  return async () => {
    await cdp.send('Page.stopScreencast').catch(() => undefined)
    const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.016, (frames[i + 1]?.t ?? f.t + 1) - f.t).toFixed(3)}`)
    writeFileSync(join(dir, 'list.txt'), list.join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`)
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-fps_mode', 'vfr', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', out])
    rmSync(dir, { recursive: true, force: true })
  }
}

async function snap(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  await page.waitForTimeout(400) // let the stage finish sliding in
  await page.screenshot({ path: join(OUT, `${name}.png`) })
}

test('a fresh first run walks every stage, and the folder waits for Allow', async () => {
  const d = fresh('walk')
  const { app, page } = await launch(d.env)
  const stopRecording = RECORD ? await record(page, RECORD) : null
  try {
    await expect(page.getByTestId('get-started')).toBeVisible()
    // Nothing is made in Documents before setup has said why (macOS would ask with no explanation).
    expect(existsSync(d.root)).toBe(false)
    await snap(page, '01-welcome')
    await page.getByTestId('get-started').click()

    await expect(page.locator('.setup-step-label')).toHaveText(MAC ? ['Your Mac', 'Listening', 'AI editor'] : ['Listening', 'AI editor'])
    if (MAC) {
      await expect(page.getByTestId('stage-mac')).toHaveText('Get your Mac ready')
      await expect(page.getByTestId('stage-mac')).toBeFocused() // a screen reader starts at the new stage
      await expect(page.getByTestId('perm-folder')).toContainText('Documents › Reel Studio')
      await expect(page.getByTestId('perm-network')).toContainText('local network')
      await expect(page.getByTestId('mac-continue')).toBeDisabled()
      // The checklist re-checks every 1.5 s; none of those checks may touch the folder before Allow.
      await page.waitForTimeout(3200)
      expect(existsSync(d.root)).toBe(false)
      await snap(page, '02-mac')

      await page.getByTestId('perm-folder-allow').click()
      await expect(page.getByTestId('perm-folder')).toHaveAttribute('data-state', 'allowed')
      expect(existsSync(join(d.root, 'Projects'))).toBe(true)
      await page.getByTestId('perm-notifications-allow').click()
      await expect(page.getByTestId('perm-notifications')).toHaveAttribute('data-state', 'allowed')
      await expect(page.getByTestId('mac-continue')).toBeEnabled()
      expect(await opened(app)).toEqual([]) // nothing was refused, so System Settings never opened
      await snap(page, '03-mac-allowed')
      await page.getByTestId('mac-continue').click()
    }

    await expect(page.getByTestId('model-heading')).toHaveText('One download, about 500 MB')
    await expect(page.getByTestId('setup-step-listening')).toHaveAttribute('aria-current', 'step')
    await expect(page.getByTestId('download-model')).toBeVisible()
    await snap(page, '04-listening')
    if (MAC) {
      // An earlier stage opens again from the strip, as it was left.
      await page.getByTestId('setup-step-mac').click()
      await expect(page.getByTestId('perm-folder')).toHaveAttribute('data-state', 'allowed')
      await expect(page.getByTestId('setup-step-listening')).toBeDisabled()
      await page.getByTestId('mac-continue').click()
    }
    await page.getByTestId('later').click()

    await expect(page.getByText('Connect your AI editor')).toBeVisible()
    await expect(page.getByTestId('setup-step-ai')).toHaveAttribute('aria-current', 'step')
    await page.waitForTimeout(1500) // the Claude choice shows once the app has looked for the Claude Code app
    await snap(page, '05-ai')
    await page.getByTestId('skip').click()

    await expect(page.getByText('Your videos')).toBeVisible()
    await snap(page, '06-home')
    const settings = JSON.parse(readFileSync(join(d.userData, 'settings.json'), 'utf8'))
    expect(settings.firstRunDone).toBe(true)
    expect(settings.notifications).toBe(MAC ? true : null)
    expect(existsSync(join(d.root, 'Projects'))).toBe(true)
  } finally {
    await stopRecording?.()
    await app.close()
  }
})

test('a "no" from the Mac says what to do, and the row updates once it is allowed', async () => {
  test.skip(!MAC, 'the Your Mac stage is macOS only')
  const d = fresh('denied')
  const { app, page } = await launch({ ...d.env, REELSTUDIO_TEST_PERMISSIONS: 'folder=denied,notifications=failed' })
  try {
    await page.getByTestId('get-started').click()

    // Notifications first: macOS said no, so its page opens with a helper that has Done (Reel Studio cannot read it).
    await page.getByTestId('perm-notifications-allow').click()
    await expect(page.getByTestId('perm-notifications-problem')).toHaveText('Your Mac said no. Press Allow to turn it on in System Settings.')
    await expect.poll(() => opened(app)).toEqual(['x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=dev.reelstudio.app'])
    const notes = await helperWindow(app, 'Set up Notifications')
    await expect(notes.locator('header')).toHaveText('↑ Turn on Allow notifications')
    await expect(notes.locator('#app')).not.toHaveAttribute('draggable', 'true') // a switch pane: nothing to drag
    await notes.screenshot({ path: join(OUT, '09-helper-notifications.png'), omitBackground: true })
    await notes.locator('#done').click()
    await expect.poll(() => app.windows().length).toBe(1)

    // The folder: the "no" opens Files and Folders, and the helper names the switch.
    await page.getByTestId('perm-folder-allow').click()
    await expect(page.getByTestId('perm-folder-problem')).toHaveText('Your Mac said no. Press Allow to turn it on in System Settings.')
    await expect(page.getByTestId('perm-folder-choose')).toBeVisible()
    await expect(page.getByTestId('mac-continue')).toBeDisabled()
    expect((await opened(app))[1]).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders')
    const folder = await helperWindow(app, 'Set up Files and Folders')
    await expect(folder.locator('header')).toHaveText('↑ Turn on Documents Folder under Reel Studio')
    await expect(folder.locator('#done')).toHaveCount(0) // it closes by itself once the folder can be used
    await folder.screenshot({ path: join(OUT, '10-helper-files-and-folders.png'), omitBackground: true })
    await snap(page, '07-denied')

    // The person turns it on in System Settings: the helper sees it within a second, closes itself, and the
    // folder is made. Nothing else to click.
    await app.evaluate(() => {
      delete (globalThis as { __reelPermFakes?: { folder?: string } }).__reelPermFakes!.folder
    })
    await expect.poll(() => app.windows().length, { timeout: 5000 }).toBe(1)
    await expect(page.getByTestId('perm-folder')).toHaveAttribute('data-state', 'allowed', { timeout: 5000 })
    expect(existsSync(join(d.root, 'Projects'))).toBe(true)
    await expect(page.getByTestId('perm-folder-problem')).toHaveCount(0)
    await expect(page.getByTestId('mac-continue')).toBeEnabled()
    // Notifications are optional: still off, and setup can go on.
    await page.getByTestId('mac-continue').click()
    await expect(page.getByTestId('model-heading')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('an existing install goes straight to Home, as before', async () => {
  const d = fresh('existing')
  mkdirSync(d.userData, { recursive: true })
  writeFileSync(join(d.userData, 'settings.json'), JSON.stringify({ firstRunDone: true, root: null }))
  const { app, page } = await launch(d.env)
  try {
    await expect(page.getByText('Your videos')).toBeVisible()
    await expect(page.getByTestId('get-started')).toHaveCount(0)
    await expect(page.getByTestId('setup-steps')).toHaveCount(0)
    expect(existsSync(join(d.root, 'Projects'))).toBe(true) // made at start, the way it always was
    // Notifications were on before this setup existed, so they still are.
    const st = await page.evaluate(() => (window as any).reel.perm.status())
    expect(st).toMatchObject({ folder: 'allowed', notifications: 'on' })
    await snap(page, '08-existing-home')
    // Settings has the switch for anyone who skipped it in setup
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('notifications-toggle')).toBeChecked()
    await page.getByTestId('notifications-toggle').scrollIntoViewIfNeeded()
    await snap(page, '11-settings-notifications')
  } finally {
    await app.close()
  }
})
