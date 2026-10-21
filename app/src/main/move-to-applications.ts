// "Move Reel Studio to Applications?" at start-up, when someone opens the app straight from the installer disk.
//
// From the mounted disk image every file the app reads comes out of a compressed image, and ejecting the disk pulls
// the app out from under itself. Sam's logs show the app running from /Volumes/Reel Studio with slow file picking and
// a crash on Add Song. Electron's moveToApplicationsFolder copies the app, quits and opens the copy.
//
// This file never imports electron: index.ts passes in app.moveToApplicationsFolder and the dialog calls, and
// tests drive it with fakes.

export interface MoveContext {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** REELSTUDIO_TEST=1: automated runs never get a modal. */
  test: boolean
  /** app.isInApplicationsFolder() (macOS only). */
  inApplications: boolean
  /** process.execPath */
  exePath: string
}

/** Only a packaged Mac app running from a mounted disk is offered the move. Dev runs, tests and a copy anywhere
 * else (~/Downloads after unzipping, a test folder, ~/Applications) are left alone. */
export function shouldOfferMove(c: MoveContext): boolean {
  return c.platform === 'darwin' && c.isPackaged && !c.test && !c.inApplications && c.exePath.startsWith('/Volumes/')
}

export interface Question {
  type: 'question' | 'warning'
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

export interface MoveDeps {
  /** dialog.showMessageBox, resolving to the index of the button pressed. */
  ask(q: Question): Promise<number>
  /** dialog.showMessageBoxSync: moveToApplicationsFolder's conflictHandler has to answer synchronously. */
  askNow(q: Question): number
  /** app.moveToApplicationsFolder. Quits and relaunches on success; false when the person cancels. */
  move(options: { conflictHandler: (conflict: 'exists' | 'existsAndRunning') => boolean }): boolean
  log(line: string): void
}

export type MoveOutcome = 'not-offered' | 'declined' | 'moving' | 'cancelled' | 'failed'

export const MOVE_QUESTION: Question = {
  type: 'question',
  message: 'Move Reel Studio to Applications?',
  detail: 'Reel Studio is running from the installer disk, where it is slower and can stop working. After the move it opens again from Applications.',
  buttons: ['Move', 'Not now'],
  defaultId: 0,
  cancelId: 1
}

export const REPLACE_QUESTION: Question = {
  type: 'question',
  message: 'Replace the Reel Studio in Applications?',
  detail: 'Your projects and videos stay where they are. Only the app is replaced.',
  buttons: ['Replace', 'Not now'],
  defaultId: 0,
  cancelId: 1
}

export const MOVE_FAILED: Question = {
  type: 'warning',
  message: 'Reel Studio could not move itself.',
  detail: 'Drag Reel Studio from the installer window into Applications, then open it from there.',
  buttons: ['OK'],
  defaultId: 0,
  cancelId: 0
}

export async function offerMoveToApplications(c: MoveContext, deps: MoveDeps): Promise<MoveOutcome> {
  if (!shouldOfferMove(c)) return 'not-offered'
  deps.log(`[move] running from ${c.exePath}; offering to move it to Applications`)
  if ((await deps.ask(MOVE_QUESTION)) !== 0) return 'declined'
  try {
    const moving = deps.move({
      // 'exists': an older copy sits in Applications and is not running. 'existsAndRunning': that copy is open, so
      // Electron brings it forward and quits this one, which is what the person wants.
      conflictHandler: (conflict) => conflict === 'existsAndRunning' || deps.askNow(REPLACE_QUESTION) === 0
    })
    deps.log(moving ? '[move] moving to Applications and reopening' : '[move] cancelled')
    return moving ? 'moving' : 'cancelled'
  } catch (e) {
    deps.log(`[move] failed: ${e instanceof Error ? e.message : String(e)}`)
    await deps.ask(MOVE_FAILED)
    return 'failed'
  }
}
