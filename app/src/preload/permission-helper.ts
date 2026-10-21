// The permission helper window's only bridge (main/mac-permission-helper.ts): a few fixed words, nothing else.
/// <reference lib="dom" />
import { ipcRenderer } from 'electron'
import { MAC_PERMISSION_HELPER_CHANNEL } from '../main/mac-permission'

window.addEventListener('DOMContentLoaded', () => {
  const send = (action: 'drag' | 'finder' | 'close' | 'done'): void => ipcRenderer.send(MAC_PERMISSION_HELPER_CHANNEL, action)
  const row = document.getElementById('app')
  // Only a drag pane's row is a button (main/mac-permission.ts helperHtml).
  if (row instanceof HTMLButtonElement) {
    row.addEventListener('dragstart', (event) => {
      event.preventDefault()
      send('drag')
    })
    row.addEventListener('click', () => send('finder'))
  }
  document.getElementById('done')?.addEventListener('click', () => send('done'))
  document.getElementById('close')?.addEventListener('click', () => send('close'))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') send('close')
  })
})
