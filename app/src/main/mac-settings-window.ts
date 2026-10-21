// Where the System Settings window is, so the permission helper can sit on it. Ported from T3 Code
// (apps/desktop/src/permissions/MacSettingsWindow.ts): one long-running JXA process prints the window's bounds as a
// JSON line whenever they change, and `null` when it is gone.
import { spawn } from 'node:child_process'
import type { SettingsWindowBounds } from './mac-permission'

export type SettingsWindow = SettingsWindowBounds | null

// Window bounds and owner PIDs are readable without Screen Recording access. Found by bundle identifier, not the
// localized app or window title. One process, so moving Settings around never launches osascript again and again.
const SETTINGS_WINDOW_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run() {
  let previous = "";
  while (true) {
    const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.systempreferences");
    let result = null;
    if (apps.count > 0) {
      const pid = apps.objectAtIndex(0).processIdentifier;
      const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
      const list = $.CGWindowListCopyWindowInfo(
        $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements,
        $.kCGNullWindowID
      );
      if (list) {
        $.CFMakeCollectable(list);
        const count = $.CFArrayGetCount(list);
        for (let i = 0; i < count; i++) {
          const w = ObjC.castRefToObject($.CFArrayGetValueAtIndex(list, i));
          if (w.objectForKey("kCGWindowOwnerPID").js !== pid || w.objectForKey("kCGWindowLayer").js !== 0) continue;
          const b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
          if (b.Width < 500 || b.Height < 350) continue;
          result = { x: b.X, y: b.Y, width: b.Width, height: b.Height, frontmost: !front.isNil() && front.processIdentifier === pid };
          break;
        }
      }
    }
    const line = JSON.stringify(result);
    if (line !== previous) {
      const data = $(line + "\\n").dataUsingEncoding($.NSUTF8StringEncoding);
      $.NSFileHandle.fileHandleWithStandardOutput.writeData(data);
      previous = line;
    }
    $.NSThread.sleepForTimeInterval(result && result.frontmost ? 0.5 : 1);
  }
}`

/** One JSON line from the script, checked field by field; anything else throws. */
export function decodeSettingsWindow(line: string): SettingsWindow {
  const v: unknown = JSON.parse(line)
  if (v === null) return null
  const o = v as Record<string, unknown>
  const finite = (k: string) => typeof o[k] === 'number' && Number.isFinite(o[k])
  if (typeof v !== 'object' || !['x', 'y', 'width', 'height'].every(finite) || typeof o.frontmost !== 'boolean') {
    throw new Error(`not a settings window: ${line}`)
  }
  return { x: o.x as number, y: o.y as number, width: o.width as number, height: o.height as number, frontmost: o.frontmost }
}

/**
 * Calls onChange with each new position (null = no Settings window), and onUnavailable when the tracker cannot
 * say: `ended` false for one bad line (the next may be fine), true when osascript failed or quit (nothing more will
 * come). Returns a stop function that ends the one process.
 */
export function watchMacSettingsWindow(onChange: (w: SettingsWindow) => void, onUnavailable: (ended: boolean) => void): () => void {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SETTINGS_WINDOW_SCRIPT], { stdio: ['ignore', 'pipe', 'ignore'] })
  let pending = ''
  let closed = false
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    pending += chunk
    let end: number
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      if (closed) return
      let settings: SettingsWindow
      try {
        settings = decodeSettingsWindow(line)
      } catch {
        onUnavailable(false)
        continue
      }
      onChange(settings)
    }
  })
  const onExit = (): void => {
    if (!closed) onUnavailable(true)
  }
  child.on('error', onExit)
  child.on('exit', onExit)
  return () => {
    closed = true
    child.stdout!.removeAllListeners('data')
    child.kill()
  }
}
