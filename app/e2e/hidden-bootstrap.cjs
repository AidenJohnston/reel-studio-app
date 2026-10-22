const electron = require('electron')
const { app } = electron

app.setActivationPolicy?.('accessory')
app.dock?.hide()
app.focus = () => {}

const Original = electron.BrowserWindow
function HiddenWindow(opts = {}) {
  return new Original({
    ...opts,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { ...(opts.webPreferences ?? {}), backgroundThrottling: false }
  })
}
HiddenWindow.prototype = Original.prototype
Object.setPrototypeOf(HiddenWindow, Original)
for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'flashFrame']) Original.prototype[method] = function () {}
const Module = require('node:module')
const load = Module._load
const hiddenElectron = { ...electron, BrowserWindow: HiddenWindow }
Module._load = function (name, ...args) {
  return name === 'electron' ? hiddenElectron : load.call(this, name, ...args)
}
app.on('browser-window-created', (_e, win) => {
  win.webContents.setBackgroundThrottling(false)
  if (win.isVisible()) win.hide()
})

if (process.env.RS_E2E_OPEN_FILE) {
  app.on('will-finish-launching', () => {
    if (app.isReady()) throw new Error('open-file must arrive before ready')
    app.emit('open-file', { preventDefault() {} }, process.env.RS_E2E_OPEN_FILE)
  })
}
