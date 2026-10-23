import { expect, it } from 'vitest'
import { loadSettings, saveSettings } from '../src/main/settings'
import { setupPaths } from './helpers'

it('fails if "Double-check each edit" is on before the person turns it on, or does not stay on', async () => {
  setupPaths()
  expect((await loadSettings()).checkEdits).toBe(false)
  await saveSettings({ checkEdits: true })
  expect((await loadSettings()).checkEdits).toBe(true)
})
