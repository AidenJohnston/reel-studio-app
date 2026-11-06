// What the companion page says about a reel and its job, in the words the desktop's Home cards use
// (screens/Home.tsx lineOf, screens/home-state.ts stateOf), so the phone and the computer name a state the same way.
import type { JobDto, ReelStatus, ReelSummaryDto } from '../../../shared/contract'
import { timeLeftText } from '../../../shared/progress'

/** The status line and the badge colour (styles.css .badge) for one reel. */
export function statusOf(r: Pick<ReelSummaryDto, 'status' | 'latest' | 'waiting'>): { words: string; tone: '' | 'ready' | 'new' | 'interrupted' | 'failed' } {
  const waiting = r.waiting > 0 ? ` · ${r.waiting === 1 ? '1 note' : `${r.waiting} notes`} waiting` : ''
  const by: Record<ReelStatus, { words: string; tone: '' | 'ready' | 'new' | 'interrupted' | 'failed' }> = {
    planned: { words: 'Waiting for your video', tone: 'new' },
    new: { words: `Making Version ${r.latest + 1}`, tone: '' },
    working: { words: `Making Version ${r.latest + 1}`, tone: '' },
    interrupted: { words: 'Paused', tone: 'interrupted' },
    failed: { words: "Didn't finish", tone: 'failed' },
    ready: { words: r.latest > 0 ? `Version ${r.latest}` : 'Ready', tone: 'ready' }
  }
  const s = by[r.status]
  return { words: s.words + waiting, tone: s.tone }
}

export const isMaking = (status: ReelStatus): boolean => status === 'working' || status === 'new'

/** A job's one line: what it is doing now, or that it is waiting for another reel's render. */
export const jobWords = (job: JobDto): string => (job.waiting ? 'Waiting for another reel to finish' : job.message)

export const jobTimeLeft = (job: JobDto): string | null => (job.waiting ? null : timeLeftText(job.secondsLeft))
