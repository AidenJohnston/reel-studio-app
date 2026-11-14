import { deleteThenLeave } from '../../../shared/delete-video'
import { reel, userMessage } from '../api'
import type { Go } from '../nav'

/** Deletes a video and goes home; a refusal stays on this screen and says why (shared/delete-video.ts). */
export function removeVideo(slug: string, go: Go, notify: (t: string, k?: 'error' | 'info') => void): Promise<boolean> {
  return deleteThenLeave(() => reel.projects.remove(slug), () => go({ name: 'home' }), (e) => notify(userMessage(e), 'error'))
}
