// "Use your own AI server": add a connection to a local OpenAI-compatible mock server through Settings, with the
// real @reelstudio/ai package. A wrong key is caught when saving; the right one is saved encrypted and never comes
// back to the page.
//
//   REELSTUDIO_CONN_SHOTS=<dir>  also save the screenshots there (PR evidence)
import { test, expect, type Page } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, passFirstRun, shot, USER_DATA } from './helpers'

const KEY = 'sk-e2e-mock-key-7f3a'
const MODELS = ['mock-small', 'mock-large']
const SHOTS = process.env.REELSTUDIO_CONN_SHOTS

let server: Server
let origin = ''
const chats: { auth?: string; model?: string }[] = []

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    const json = (status: number, obj: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
    const ok = req.headers.authorization === `Bearer ${KEY}`
    if (req.url === '/v1/models') return ok ? json(200, { data: MODELS.map((id) => ({ id })) }) : json(401, { error: { message: 'bad key' } })
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const b = await body(req)
      chats.push({ auth: req.headers.authorization, model: b?.model })
      if (!ok) return json(401, { error: { message: 'Incorrect API key provided.', code: 'invalid_api_key' } })
      if (!MODELS.includes(b?.model)) return json(404, { error: { message: `The model ${b?.model} does not exist`, code: 'model_not_found' } })
      return json(200, { choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })
    }
    res.writeHead(404).end('404 page not found')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
test.afterAll(async () => {
  server?.closeAllConnections()
  await new Promise((r) => server?.close(r))
})

async function snap(page: Page, name: string): Promise<void> {
  await shot(page, `conn-${name}`)
  if (SHOTS) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, `${name}.png`) })
  }
}

test('add a connection to your own AI server from Settings', async () => {
  const { app, page } = await launch({ REELSTUDIO_MOCK_AI: '0' })
  try {
    await passFirstRun(page)
    await page.getByTestId('nav-settings').click()
    const toggle = page.getByTestId('own-server-toggle')
    await expect(toggle).toBeVisible()
    await snap(page, '01-settings-link')

    await toggle.click()
    await page.getByTestId('connection-add').click()
    const dialog = page.getByTestId('connection-dialog')
    await expect(dialog.getByRole('heading', { name: 'Add a connection' })).toBeVisible()
    await expect(page.getByTestId('connection-kind-openai')).toBeChecked()
    await snap(page, '02-add-server')
    // keyboard: focus starts on the chosen kind, and Tab from the last button stays in the dialog
    await expect(page.getByTestId('connection-kind-openai')).toBeFocused()
    await page.getByTestId('connection-next').focus()
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true)

    await page.getByTestId('connection-next').click()
    // the suggested name is selected: typing replaces it
    await page.keyboard.type('Work')
    await expect(page.getByTestId('connection-label')).toHaveValue('Work')
    await snap(page, '03-add-name')
    await page.getByTestId('connection-next').click()

    // a wrong key: the model list cannot load, and saving says what to fix
    await page.getByTestId('connection-address').fill(`${origin}/v1`)
    await page.getByTestId('connection-key').fill('sk-wrong')
    await page.getByTestId('connection-key').blur()
    await expect(dialog.getByText('No models reported by this server yet.', { exact: false })).toBeVisible()
    await page.getByTestId('connection-model').fill('mock-small')
    await page.getByTestId('connection-save').click()
    await expect(page.getByTestId('connection-error')).toHaveText('The server did not accept that key. Check the key, then paste it again.')
    await expect(page.getByTestId('connection-key')).toBeFocused()
    await expect(page.getByTestId('connection-key')).toHaveAttribute('aria-invalid', 'true')
    await snap(page, '04-error-wrong-key')

    // the right key: the server's models fill the list
    await page.getByTestId('connection-key').fill(KEY)
    await page.getByTestId('connection-key').blur()
    await expect(page.getByTestId('connection-model-list')).toHaveValue('mock-small')
    await snap(page, '05-add-details')
    await page.getByTestId('connection-save').click()
    await expect(dialog).toHaveCount(0)

    await expect(page.getByTestId('ai-connected')).toHaveText('Connected to Work (mock-small).')
    // the sidebar says so right away, without leaving Settings
    await expect(page.getByTestId('ai-status')).toHaveText('AI editor: Work')
    await page.getByTestId('use-different-ai').click()
    const card = page.getByTestId('connection-card')
    await expect(card).toHaveCount(1)
    await expect(card).toContainText('Work')
    await expect(card).toContainText('In use')
    await expect(card).toContainText(`OpenAI-compatible · mock-small · ${origin}/v1`)
    await card.scrollIntoViewIfNeeded()
    await snap(page, '06-saved-card')

    // it is the AI editor now, and its request carried the key
    expect(await page.evaluate(() => window.reel.ai.active())).toMatchObject({ id: 'custom', label: 'Work', detail: 'mock-small' })
    expect(chats.at(-1)).toEqual({ auth: `Bearer ${KEY}`, model: 'mock-small' })

    // the key never comes back to the page, and no file holds it in plain text
    const seen = await page.evaluate(async () => JSON.stringify([await window.reel.ai.connections(), await window.reel.ai.providers(), await window.reel.ai.active()]))
    expect(seen).not.toContain(KEY)
    const aiDir = join(USER_DATA, 'ai')
    const files = readdirSync(aiDir)
    expect(files.some((f) => /^connection-c_[a-f0-9]{8}\.bin$/.test(f))).toBe(true)
    for (const f of files) expect(readFileSync(join(aiDir, f)).toString('utf8')).not.toContain(KEY)

    // editing shows that a key is stored without showing it
    await card.getByTestId('more').click()
    await page.getByTestId('connection-edit').click()
    await expect(page.getByTestId('connection-key')).toHaveValue('')
    await expect(page.getByTestId('connection-key')).toHaveAttribute('placeholder', 'Stored key. Enter a new one to replace it.')
    await snap(page, '07-edit')
    await page.getByTestId('connection-back').click()
    await expect(page.getByTestId('connection-dialog')).toHaveCount(0)

    // disconnecting updates the sidebar too, still on Settings
    await page.getByTestId('use-no-ai').click()
    await expect(page.getByTestId('ai-status')).toContainText('No AI editor connected.')
  } finally {
    await app.close()
  }
})
