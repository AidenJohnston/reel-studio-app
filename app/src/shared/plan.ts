// The Plan document as the app sees it: a mirror of @reelstudio/ai plan.ts (project.json `plan`, docs/plan.md).

export type PlanSource = 'own-file' | 'library' | 'fetched' | 'card' | 'animation' | 'screen-recording'
export type RowStatus = 'proposed' | 'approved' | 'rejected'

export interface PlanScript {
  /** the AI's draft, kept beside the rewrite for a redline */
  draft: string | null
  /** the creator's own rewrite; null until they rewrite it */
  rewrite: string | null
  /** locked to shoot */
  locked: boolean
  lockedAt?: string
  hook?: string
  onScreenText?: string[]
}
export interface PlanBeat {
  line: string
  visual?: string
  sound?: string
}
export interface PlanRow {
  id: string
  words?: string
  anchor?: { from: string; to: string }
  visual: string
  source: PlanSource
  asset?: string | null
  treatment?: string
  status: RowStatus
  /** seconds it should stay up (a hint) */
  hold?: number
  note?: string
  /** the b-roll item this row built: set while the row is in the video */
  broll?: string
}
export interface Plan {
  script: PlanScript
  beats: PlanBeat[]
  broll: PlanRow[]
  music?: string
  cover?: string
  /** build proposed rows as if approved */
  buildProposed?: boolean
}
export interface PlanView {
  plan: Plan | null
  /** approved rows not in the video yet, and why */
  unbuilt: { id: string; why: 'needs-file' | 'words-not-found' }[]
}

export type RowFields = Partial<Pick<PlanRow, 'words' | 'anchor' | 'visual' | 'source' | 'asset' | 'treatment' | 'hold' | 'note'>>
export type PlanChange =
  | { kind: 'script'; draft?: string | { hook: string; script: string; onScreenText: string[] } | null; rewrite?: string | null }
  | { kind: 'lock'; locked: boolean }
  | { kind: 'rowStatus'; id: string; status: RowStatus }
  | { kind: 'row'; id: string | null; row: RowFields; status?: RowStatus }
  | { kind: 'details'; beats?: PlanBeat[]; music?: string | null; cover?: string | null; buildProposed?: boolean }
  | { kind: 'import'; markdown: string }

export const PLAN_CHANGE_KINDS: readonly PlanChange['kind'][] = ['script', 'lock', 'rowStatus', 'row', 'details', 'import']
