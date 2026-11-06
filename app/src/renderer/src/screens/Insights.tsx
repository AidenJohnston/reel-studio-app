import { Icon, type IconName } from '../components/icons'
import { TitleBarSlot } from '../components/titlebar'
import '../components/library.css'

/** What each posted reel's row will hold: the page's own shape, said in words (no stand-in numbers or charts). */
const MEASURES: { icon: IconName; line: string; what: string }[] = [
  { icon: 'eye', line: 'Views', what: 'How many people saw it, and how many of them follow you' },
  { icon: 'timer', line: 'How long people watched', what: 'The average, and how many watched to the end' },
  { icon: 'chart', line: 'Where they swiped away', what: 'The moment most people left, marked on the reel' }
]

/**
 * Insights (spec section 9): each posted reel's results. Always in the sidebar, but nothing can be posted from this
 * version, so it says what it will show and what it needs, with no stand-in numbers or charts. What it will show is
 * laid out as My style's empty page lays out its examples, so the page has its shape before it has data.
 */
export function Insights() {
  return (
    <div className="page insights-page">
      <TitleBarSlot title="Insights" />
      <div className="insights-empty" data-testid="insights-empty">
        <h2>No post results yet</h2>
        <p>This page will show how each posted reel did. It needs your Instagram account connected, which isn’t available yet.</p>
        <figure className="style-example">
          <figcaption>For each posted reel</figcaption>
          <ul>
            {MEASURES.map((m) => (
              <li key={m.line}>
                <Icon name={m.icon} size={16} />
                <span>
                  <b>{m.line}</b>
                  <span>{m.what}</span>
                </span>
              </li>
            ))}
          </ul>
        </figure>
      </div>
    </div>
  )
}
