// Ported from T3 Code: apps/desktop/src/permissions/MacPermission.ts and the page and placement in
// MacPermissionHelper.ts / MacSettingsWindow.ts. No electron import, so tests run it directly.
import type { SettingsPane } from '../shared/api'

/** packaging/electron-builder.yml appId; the Notifications deep link opens this app's own page. */
const BUNDLE_ID = 'dev.reelstudio.app'
const APP_NAME = 'Reel Studio'
export const MAC_PERMISSION_HELPER_CHANNEL = 'mac-permission-helper'

export interface MacPane {
  url: string
  title: string
  /** If Reel Studio can read the answer, the helper closes by itself once it is on; if not, it has Done. */
  readable: boolean
}

export const MAC_PANES: Record<SettingsPane, MacPane> = {
  folder: { url: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders', title: 'Files and Folders', readable: true },
  notifications: {
    url: `x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=${BUNDLE_ID}`,
    title: 'Notifications',
    readable: false
  }
}

/**
 * Both panes list an app once it has asked, with a switch to turn on; dragging the app in does nothing there.
 * Files and Folders shows one switch per protected folder under the app's name.
 */
export function helperInstruction(pane: SettingsPane, folderDisplay = ''): string {
  if (pane === 'notifications') return 'Turn on Allow notifications'
  const top = /^(Documents|Desktop|Downloads)\b/.exec(folderDisplay)?.[1]
  return top ? `Turn on ${top} Folder under ${APP_NAME}` : `Turn on ${APP_NAME} in the list above`
}

export interface SettingsWindowBounds {
  x: number
  y: number
  width: number
  height: number
  frontmost: boolean
}

/** Bottom of the System Settings window, centred over its content (right of the sidebar), as in T3 Code. */
export function settingsHelperBounds(settings: SettingsWindowBounds): { x: number; y: number; width: number; height: number } {
  const sidebarWidth = 216
  const inset = 16
  const width = Math.min(560, settings.width - sidebarWidth - inset * 2)
  return {
    x: Math.round(settings.x + sidebarWidth + (settings.width - sidebarWidth - width) / 2),
    y: Math.round(settings.y + settings.height - 140 - inset),
    width: Math.round(width),
    height: 140
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? '&#39;')

export function helperHtml(pane: MacPane, instruction: string, icon: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>Set up ${escapeHtml(pane.title)}</title><style>
:root { color-scheme: light dark; --base: #fff; --row: #e7e7e7; --text: #292929; --line: #e3e3e3; --button: #fff; }
@media (prefers-color-scheme: dark) { :root { --base: #242424; --row: #383838; --text: #f5f5f5; --line: #484848; --button: #5a5a5a; } }
* { box-sizing: border-box; }
html { background: transparent; }
body { margin: 0; background: transparent; color: var(--text); font: 15px/22px -apple-system, BlinkMacSystemFont, sans-serif; user-select: none; }
#panel { position: relative; margin: 2px; padding: 20px; height: 136px; border: 1px solid var(--line); border-radius: 24px; background: var(--base); }
header { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 16px; }
button { font: inherit; color: inherit; }
button:focus-visible { outline: 2px solid #007aff; outline-offset: -2px; }
#close { position: absolute; right: 7px; top: 5px; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 50%; background: var(--base); font-size: 18px; cursor: pointer; opacity: 0; }
#panel:hover #close, #close:focus-visible { opacity: 1; }
#app { display: flex; align-items: center; gap: 12px; width: 100%; height: 52px; margin-top: 20px; padding: 8px 12px; border-radius: 10px; background: var(--row); font-size: 16px; font-weight: 600; }
#app span { flex: 1; }
#done { margin-left: auto; padding: 3px 14px; border: 0; border-radius: 7px; background: var(--button); font-size: 14px; font-weight: 500; box-shadow: 0 0 0 .5px rgba(0,0,0,.12), 0 1px 1px rgba(0,0,0,.08); cursor: default; }
#done:active { filter: brightness(.94); }
img { width: 32px; height: 32px; pointer-events: none; }
</style></head><body><main id="panel">
<button id="close" aria-label="Close permission helper">×</button>
<header>↑ ${escapeHtml(instruction)}</header>
<div id="app"><img src="${escapeHtml(icon)}" alt="" draggable="false"><span>${escapeHtml(APP_NAME)}</span>${pane.readable ? '' : '<button id="done">Done</button>'}</div>
</main></body></html>`
}
