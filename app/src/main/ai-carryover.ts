// One-time carry-over for installs of the old local-Claude-Code builds (0.1.0 and 0.1.1).
//
// Those builds used the Claude Code app signed in on the computer WITHOUT saving that as a choice: the AI package
// fell back to it whenever nothing else was connected, and the start-up pick only wrote `aiAutoPicked: true`.
// 0.1.2 never picks Claude Code on its own, so such an install would open with no AI after the update. This keeps
// what those people were already using, once, and only when they never chose anything themselves.
// A public 0.1.0/0.1.1 install never wrote `aiAutoPicked`, so nothing changes for it.
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface CarryOverFacts {
  /** settings.json `aiAutoPicked` (only ever written by the old local-Claude-Code builds) */
  aiAutoPicked: boolean
  /** settings.json `aiCarriedOver`: this step already ran */
  carriedOver: boolean
  /** ai-settings.json has an `active` value (any choice, "No AI" included, is the person's own) */
  choiceSaved: boolean
  /** what the AI package uses right now (another AI connected = leave it) */
  activeId: string
  /** the person's own Claude Code app is installed and signed in */
  claudeCodeReady: boolean
}

export type CarryOver = 'use-claude-code' | 'not-ready-yet' | 'nothing-to-do'

export function carryOverDecision(f: CarryOverFacts): CarryOver {
  if (!f.aiAutoPicked || f.carriedOver || f.choiceSaved || f.activeId !== 'none') return 'nothing-to-do'
  return f.claudeCodeReady ? 'use-claude-code' : 'not-ready-yet'
}

/** Whether `<aiSettingsDir>/ai-settings.json` holds a saved choice. */
export async function aiChoiceSaved(aiSettingsDir: string): Promise<boolean> {
  try {
    const j = JSON.parse(await fs.readFile(join(aiSettingsDir, 'ai-settings.json'), 'utf8'))
    return typeof j?.active === 'string' && j.active.length > 0
  } catch {
    return false
  }
}
