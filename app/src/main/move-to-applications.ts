import { accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'

export interface MoveContext {
  platform: NodeJS.Platform
  isPackaged: boolean
  /** REELSTUDIO_TEST=1: automated runs never get a modal. */
  test: boolean
  /** app.isInApplicationsFolder() (macOS only). */
  inApplications: boolean
  exePath: string
  writeError(dir: string): string | null
}

export function writeErrorCode(dir: string): string | null {
  try {
    accessSync(dir, constants.W_OK)
    return null
  } catch (e) {
    return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : 'UNKNOWN'
  }
}

// EROFS identifies an installer disk; EACCES alone can be a deliberately chosen external folder.
export function moveReason(c: MoveContext): 'installer-disk' | 'temporary-copy' | null {
  if (c.platform !== 'darwin' || !c.isPackaged || c.test || c.inApplications) return null
  if (c.exePath.includes('/AppTranslocation/')) return 'temporary-copy'
  const app = c.exePath.lastIndexOf('.app/Contents/MacOS/')
  if (!c.exePath.startsWith('/Volumes/') || app < 0) return null
  return c.writeError(dirname(c.exePath.slice(0, app + '.app'.length))) === 'EROFS' ? 'installer-disk' : null
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
  destinationExists(): boolean
  ask(q: Question): Promise<number>
  /** dialog.showMessageBoxSync: moveToApplicationsFolder's conflictHandler has to answer synchronously. */
  askNow(q: Question): number
  /** app.moveToApplicationsFolder. Quits and relaunches on success; false when the person cancels. */
  move(options: { conflictHandler: (conflict: 'exists' | 'existsAndRunning') => boolean }): boolean
  log(line: string): void
}

export type MoveOutcome = 'not-offered' | 'declined' | 'moving' | 'cancelled' | 'failed'

const MOVE_QUESTION: Question = {
  type: 'question',
  message: 'Move Reel Studio to Applications?',
  detail: 'Reel Studio is running from the installer disk, where it is slower and can stop working. After the move it opens again from Applications.',
  buttons: ['Move', 'Not now'],
  defaultId: 0,
  cancelId: 1
}

const MOVE_QUESTION_TEMPORARY_COPY: Question = {
  ...MOVE_QUESTION,
  detail: 'macOS is running Reel Studio from a temporary copy that goes away when you quit. After the move it opens again from Applications.'
}

const REPLACE_QUESTION: Question = {
  type: 'question',
  message: 'Replace the Reel Studio in Applications?',
  detail: 'Your projects and videos stay where they are. Only the app is replaced.',
  buttons: ['Replace', 'Not now'],
  defaultId: 0,
  cancelId: 1
}

const MOVE_FAILED: Question = {
  type: 'warning',
  message: 'Reel Studio could not move itself.',
  detail: 'Drag the original Reel Studio app into Applications in Finder, then open it from there.',
  buttons: ['OK'],
  defaultId: 0,
  cancelId: 0
}

export async function offerMoveToApplications(c: MoveContext, deps: MoveDeps): Promise<MoveOutcome> {
  const reason = moveReason(c)
  if (!reason) return 'not-offered'
  deps.log(`[move] running from ${c.exePath} (${reason}); offering to move it to Applications`)
  if ((await deps.ask(reason === 'temporary-copy' ? MOVE_QUESTION_TEMPORARY_COPY : MOVE_QUESTION)) !== 0) return 'declined'
  // Electron's privileged copy can bypass conflictHandler, so confirm before invoking it.
  let replaceConfirmed = false
  if (deps.destinationExists()) {
    if ((await deps.ask(REPLACE_QUESTION)) !== 0) return 'declined'
    replaceConfirmed = true
  }
  try {
    const moving = deps.move({
      // 'exists': an older copy sits in Applications and is not running. 'existsAndRunning': that copy is open, so
      // Electron brings it forward and quits this one, which is what the person wants.
      conflictHandler: (conflict) => conflict === 'existsAndRunning' || replaceConfirmed || deps.askNow(REPLACE_QUESTION) === 0
    })
    deps.log(moving ? '[move] moving to Applications and reopening' : '[move] cancelled')
    return moving ? 'moving' : 'cancelled'
  } catch (e) {
    deps.log(`[move] failed: ${e instanceof Error ? e.message : String(e)}`)
    await deps.ask(MOVE_FAILED)
    return 'failed'
  }
}
