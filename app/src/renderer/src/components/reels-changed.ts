// A reel was renamed on this screen: lists that show reels by name (the sidebar's Recent) read them again. Main sends
// no event for a project.json update, and a rename keeps the reel's slug, so nothing else tells them.
const bus = new EventTarget()

export function reelsChanged(): void {
  bus.dispatchEvent(new Event('change'))
}

export function onReelsChanged(cb: () => void): () => void {
  bus.addEventListener('change', cb)
  return () => bus.removeEventListener('change', cb)
}
