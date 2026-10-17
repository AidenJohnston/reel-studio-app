export type Screen =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'script' }
  | { name: 'working'; slug: string }
  | { name: 'reel'; slug: string; fresh?: boolean }
  | { name: 'library' }
  | { name: 'style' }
  | { name: 'settings' }
  | { name: 'connect'; back?: { name: 'reel'; slug: string } }

export type Go = (s: Screen) => void
