// The first-run setup (renderer/src/screens/FirstRun.tsx): which stages a new person walks through, in order.
// macOS gets a "Your Mac" stage for its privacy questions; Windows and Linux ask none of them, so they skip it.

export type SetupStage = 'mac' | 'listening' | 'ai'

export const STAGE_LABELS: Record<SetupStage, string> = {
  mac: 'Your Mac',
  listening: 'Listening',
  ai: 'AI editor'
}

/**
 * The folder comes first: every video, song and picture is saved there, so macOS asks about Documents before
 * anything else, right after "Where your videos go" is explained.
 */
export function setupStages(platform: string): SetupStage[] {
  return platform === 'darwin' ? ['mac', 'listening', 'ai'] : ['listening', 'ai']
}

/** The stage after `current`, or null when `current` is the last one (setup is done). */
export function nextStage(stages: readonly SetupStage[], current: SetupStage): SetupStage | null {
  const i = stages.indexOf(current)
  if (i < 0) throw new Error(`unknown setup stage: ${current}`)
  return stages[i + 1] ?? null
}
