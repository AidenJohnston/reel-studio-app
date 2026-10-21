/// <reference lib="dom" />
import { ipcRenderer } from 'electron'
import { MAC_PERMISSION_HELPER_CHANNEL } from '../main/mac-permission'

window.addEventListener('DOMContentLoaded', () => {
  const close = (): void => ipcRenderer.send(MAC_PERMISSION_HELPER_CHANNEL, 'close')
  document.getElementById('done')?.addEventListener('click', close)
  document.getElementById('close')?.addEventListener('click', close)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })
})
