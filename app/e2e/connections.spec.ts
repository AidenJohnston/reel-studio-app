// "Use your own AI server" against a local OpenAI-compatible mock, with the real @reelstudio/ai package.
import { test, expect } from '@playwright/test'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, passFirstRun, userData, openSettings } from './helpers'

const KEY = 'sk-e2e-mock-key-7f3a'
const MODELS = ['mock-small', 'mock-large']

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

test('add your own AI server from Settings', async () => {
  const { app, page } = await launch({ REELSTUDIO_MOCK_AI: '0' })
  try {
    await passFirstRun(page)
    await openSettings(page)
    // your own server sits in the editor's Advanced, closed until opened
    await page.getByTestId('ai-advanced').click()
    await page.getByTestId('own-server-toggle').click()
    const dialog = page.getByTestId('connection-dialog')
    await expect(page.getByTestId('connection-kind-openai')).toBeFocused()

    await page.getByTestId('connection-address').fill(`${origin}/v1`)
    await page.getByTestId('connection-address').blur()
    await expect(page.getByTestId('connection-model-help')).toHaveText("Add the key to see this server's models.")
    await page.getByTestId('connection-key').fill('sk-wrong')
    await page.getByTestId('connection-key').blur()
    await expect(dialog.getByText('No models reported by this server yet.', { exact: false })).toBeVisible()
    await page.getByTestId('connection-model').fill('mock-small')
    await page.getByTestId('connection-label').fill('Work')
    await page.getByTestId('connection-save').click()
    await expect(page.getByTestId('connection-error')).toHaveText('The server did not accept that key. Check the key, then paste it again.')
    await expect(page.getByTestId('connection-key')).toBeFocused()

    await page.getByTestId('connection-key').fill(KEY)
    await page.getByTestId('connection-key').blur()
    // the model typed earlier stays chosen once the list arrives
    await expect(page.getByTestId('connection-model-list')).toHaveValue('mock-small')
    await page.getByTestId('connection-key').press('Enter')
    await expect(dialog).toHaveCount(0)

    await expect(page.locator('[data-provider="custom"]')).toContainText('Work')
    await expect(page.getByTestId('ai-connected')).toHaveText('Connected')
    // the sidebar follows without leaving Settings
    await expect(page.getByTestId('ai-status')).toHaveText('Editor: Work')
    expect(chats.at(-1)).toEqual({ auth: `Bearer ${KEY}`, model: 'mock-small' })

    const seen = await page.evaluate(async () => JSON.stringify([await window.reel.ai.connections(), await window.reel.ai.providers(), await window.reel.ai.active()]))
    expect(seen).not.toContain(KEY)
    const aiDir = join(userData(), 'ai')
    const files = readdirSync(aiDir)
    expect(files.some((f) => /^connection-c_[a-f0-9]{8}\.bin$/.test(f))).toBe(true)
    for (const f of files) expect(readFileSync(join(aiDir, f)).toString('utf8')).not.toContain(KEY)

    const card = page.getByTestId('connection-card')
    await expect(card).toContainText('Connected')
    await card.getByTestId('connection-edit').click()
    await expect(page.getByTestId('connection-key')).toHaveValue('')
    await expect(page.getByTestId('connection-key')).toHaveAttribute('placeholder', 'Stored key. Enter a new one to replace it.')
    await page.getByTestId('connection-cancel').click()

    await page.getByTestId('use-no-ai').click()
    await expect(page.getByTestId('ai-status')).toHaveText('No editor')
  } finally {
    await app.close()
  }
})
