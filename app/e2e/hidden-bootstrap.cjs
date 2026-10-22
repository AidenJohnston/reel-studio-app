// Test-harness only (electron -r): every window stays hidden and never takes focus.
const electron = require('electron')
const { app } = electron

app.setActivationPolicy?.('accessory')
app.dock?.hide()
app.focus = () => {}

const Original = electron.BrowserWindow
class HiddenWindow extends Original {
  constructor(opts = {}) {
    super({
      ...opts,
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: { ...(opts.webPreferences ?? {}), backgroundThrottling: false }
    })
  }
  show() {}
  showInactive() {}
  focus() {}
  moveTop() {}
  flashFrame() {}
}
let replaced = false
try {
  Object.defineProperty(electron, 'BrowserWindow', { value: HiddenWindow, configurable: true, enumerable: true })
  replaced = electron.BrowserWindow === HiddenWindow
} catch {}
if (!replaced) {
  // the export could not be swapped: neutralise the original class instead
  for (const k of ['show', 'showInactive', 'focus', 'moveTop', 'flashFrame']) Original.prototype[k] = function () {}
}
app.on('browser-window-created', (_e, win) => {
  win.webContents.setBackgroundThrottling(false)
  if (win.isVisible()) win.hide()
})
process.env.RS_HIDDEN_BOOTSTRAP = replaced ? 'class' : 'prototype'
