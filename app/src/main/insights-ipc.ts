import { insightsOptions, insightsSummary } from './insights'
import type { ResultsRefresh } from './results-refresh'

type Handle = (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void
export function registerInsightsIpc(d: {
  handle: Handle
  projectsRoot: () => string
  refresh: ResultsRefresh
  /** The reel's name and that version's cover for the screen; null when the project or version is gone. */
  describe: (slug: string, version: number) => Promise<{ title: string; cover: string | null } | null>
  now?: () => number
}): void {
  d.handle('insights:get', async (_event, value) => {
    const options = insightsOptions(value)
    const summary = await insightsSummary(d.projectsRoot(), { ...options, asOf: options.asOf ?? new Date((d.now ?? Date.now)()).toISOString() }, await d.refresh.audience())
    const reels = await Promise.all(summary.reels.map(async (r) => ({ ...r, ...(await d.describe(r.project, r.version)) })))
    return { ...summary, reels }
  })
  d.handle('insights:status', () => d.refresh.status())
  d.handle('insights:refresh', (_event, value) => {
    if (value !== undefined && (!value || typeof value !== 'object' || Object.keys(value).some((k) => k !== 'all') || typeof (value as { all?: unknown }).all !== 'boolean'))
      throw { code: 'INSIGHTS_INPUT', userMessage: 'Choose which results to read.' }
    return d.refresh.refresh({ all: (value as { all?: boolean } | undefined)?.all ?? true })
  })
}
