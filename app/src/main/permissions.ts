// Never imports electron, so tests drive it with fakes.
import { constants, promises as fs } from 'node:fs'
import type { FolderAccess, NotifyAccess, PermissionStatus, SettingsPane } from '../shared/api'

type Probe = (path: string) => Promise<unknown>

const listAndWrite: Probe = async (p) => {
  await fs.readdir(p)
  await fs.access(p, constants.W_OK)
}

/**
 * macOS has no API that reports Documents access without asking, so try the access and read the answer from the
 * error, like T3 Code's Safari cookie check (SafariCookies.ts): privacy (TCC) refuses with EPERM. EACCES is ordinary
 * file rights (or a read-only drive), which System Settings cannot fix, so it is `unusable`, not `denied`. A folder
 * that does not exist yet has not been asked about.
 */
export async function probeFolder(root: string, probe: Probe = listAndWrite): Promise<FolderAccess> {
  try {
    await probe(root)
    return 'allowed'
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'EPERM') return 'denied'
    if (code === 'ENOENT') return 'not-asked'
    return 'unusable'
  }
}

/**
 * Whether finished videos may show a notification. Nothing saved means nothing was chosen: installs from before this
 * setup had notifications, and so do Windows and Linux, which never ask. A new Mac user decides in setup, which
 * saves true or false when it finishes (index.ts app:finishFirstRun).
 */
export function notificationsWanted(s: { notifications: boolean | null; firstRunDone: boolean }, platform: string): boolean {
  return s.notifications ?? (platform !== 'darwin' || s.firstRunDone)
}

/** What happened to the last "Notifications are on" notification. */
export type NotifyResult = 'shown' | 'failed' | 'pending'

/**
 * Electron cannot read the macOS notification setting. All Reel Studio learns is what happened to the notification
 * it showed when the person turned them on: shown, refused (Electron's `failed` event), or no answer yet. That
 * answer lives in memory, so after a restart "on" means "on in Reel Studio".
 */
export function notifyAccess(o: { supported: boolean; wanted: boolean; result: NotifyResult | null }): NotifyAccess {
  if (!o.supported) return 'unsupported'
  if (!o.wanted) return 'off'
  if (o.result === 'failed') return 'blocked'
  if (o.result === 'pending') return 'asking'
  return 'on'
}

/** Test builds pretend macOS said no: REELSTUDIO_TEST_PERMISSIONS="folder=denied,notifications=failed". */
export interface PermissionFakes {
  folder?: 'denied' | 'unusable'
  notifications?: NotifyResult
}

export function parseFakes(spec: string | undefined): PermissionFakes {
  const out: PermissionFakes = {}
  for (const part of (spec ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
    const [k, v] = part.split('=')
    if (k === 'folder' && (v === 'denied' || v === 'unusable')) out.folder = v
    else if (k === 'notifications' && (v === 'shown' || v === 'failed' || v === 'pending')) out.notifications = v
    else throw new Error(`REELSTUDIO_TEST_PERMISSIONS: cannot read "${part}"`)
  }
  return out
}

export interface PermissionDeps {
  platform: string
  root(): string
  rootDisplay(): string
  /** The folder was touched already (an existing install), so probing it cannot be what makes macOS ask. */
  touched: boolean
  ensureRoot(): Promise<void>
  load(): Promise<{ notifications: boolean | null; firstRunDone: boolean }>
  save(patch: { notifications: boolean }): Promise<unknown>
  notificationsSupported(): boolean
  /** Show "Notifications are on". On macOS the first one is what asks. */
  showTestNotification(): Promise<NotifyResult>
  /**
   * Open this System Settings page with the helper beside it. `isGranted` (panes Reel Studio can read) is checked
   * every second and closes the helper; `onEnd` runs when the helper closes either way.
   */
  openPane(pane: SettingsPane, help: { isGranted?: () => Promise<boolean>; onEnd?: () => void }): Promise<void>
  probe?: Probe
  /** Test builds only; mutable so an e2e can "change it in System Settings". */
  fakes?: PermissionFakes
}

export function createPermissions(d: PermissionDeps) {
  let touched = d.touched
  // Allow was pressed: the person wants the folder, so once macOS lets Reel Studio in, it is made.
  let wanted = false
  // Making the folders failed for a reason other than macOS privacy (a full or read-only drive): not usable.
  let makeFailed = false
  const make = async (): Promise<void> => {
    try {
      await d.ensureRoot()
      makeFailed = false
    } catch (e) {
      makeFailed = (e as NodeJS.ErrnoException)?.code !== 'EPERM'
    }
  }
  let lastNotify: NotifyResult | null = null
  const fakes = d.fakes ?? {}

  const folder = async (): Promise<FolderAccess> => {
    // Before the person pressed Allow (or chose a folder), never look: the look itself is what makes macOS ask.
    if (!touched) return 'not-asked'
    if (fakes.folder) return fakes.folder
    let now = await probeFolder(d.root(), d.probe)
    if (now === 'not-asked' && wanted) {
      // Turned on in System Settings after a "no": the folder was never made, so make it now.
      await make()
      now = await probeFolder(d.root(), d.probe)
    }
    return now === 'allowed' && makeFailed ? 'unusable' : now
  }

  const showTest = async (): Promise<void> => {
    lastNotify = 'pending'
    lastNotify = fakes.notifications ?? (await d.showTestNotification())
  }

  const openPane = (pane: SettingsPane): void => {
    if (d.platform !== 'darwin') return
    const help =
      pane === 'folder'
        ? { isGranted: async () => (await folder()) === 'allowed' }
        : // macOS cannot be asked, so after Done (or closing Settings) one notification shows whether it is on.
          { onEnd: () => void d.load().then((s) => (notificationsWanted(s, d.platform) ? showTest() : undefined)).catch(() => undefined) }
    void d.openPane(pane, help).catch(() => undefined)
  }

  const status = async (): Promise<PermissionStatus> => {
    const s = await d.load()
    return {
      folder: await folder(),
      folderDisplay: d.rootDisplay(),
      notifications: notifyAccess({ supported: d.notificationsSupported(), wanted: notificationsWanted(s, d.platform), result: lastNotify })
    }
  }

  return {
    fakes,
    status,
    /** The system folder picker already gave Reel Studio access to the folder chosen in it. */
    markTouched(): void {
      touched = true
      makeFailed = false
    },
    async allowFolder(): Promise<PermissionStatus> {
      touched = true
      wanted = true
      // EPERM here is the "no" to the macOS question; the probe in status() tells denied from unusable.
      if (!fakes.folder) await make()
      const st = await status()
      // macOS asks only once. After a "no", Allow means: take me to where it is turned on.
      if (st.folder === 'denied') openPane('folder')
      return st
    },
    async setNotifications(on: boolean): Promise<PermissionStatus> {
      await d.save({ notifications: on })
      if (!on) {
        lastNotify = null
        return status()
      }
      await showTest()
      const st = await status()
      if (st.notifications === 'blocked') openPane('notifications')
      return st
    }
  }
}

export type Permissions = ReturnType<typeof createPermissions>
