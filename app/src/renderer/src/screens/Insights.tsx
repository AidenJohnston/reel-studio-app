import { TitleBarSlot } from '../components/titlebar'
import { RecentReels } from '../components/RecentReels'
import type { Go } from '../nav'
import '../components/library.css'

/**
 * Insights (spec section 9): each posted reel's results. Always in the sidebar, but nothing can be posted from this
 * version, so it says what it will show and what it needs, with no stand-in numbers or charts.
 */
export function Insights({ go }: { go: Go }) {
  return (
    <div className="page insights-page">
      <TitleBarSlot title="Insights" />
      <div className="insights-empty" data-testid="insights-empty">
        <h2>No post results yet</h2>
        <p>This page will show how each posted reel did: its views, how long people watched and where they swiped away.</p>
        <p>It needs your Instagram account connected, which isn’t available yet.</p>
      </div>
      <RecentReels go={go} />
    </div>
  )
}
