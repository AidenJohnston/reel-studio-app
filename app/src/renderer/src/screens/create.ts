import { describeSorted } from '../../../shared/describe'
export { describeSorted }
import { reel, userMessage } from '../api'
import type { Go } from '../nav'

/** Starts a new video from dropped or picked files. Non-video files go to the Library. */
export async function createFromFiles(
  paths: string[],
  go: Go,
  notify: (t: string, k?: 'error' | 'info') => void,
  onError?: (message: string) => void
): Promise<boolean> {
  try {
    const r = await reel.projects.create(paths)
    go({ name: 'working', slug: r.slug })
    // After the screen change, which clears toasts: say where the other files went.
    if (r.skipped.length) notify(describeSorted(r.skipped))
    return true
  } catch (e) {
    if (onError) onError(userMessage(e))
    else notify(userMessage(e), 'error')
    return false
  }
}
