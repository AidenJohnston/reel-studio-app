export type Screen =
  | { name: 'home' }
  | { name: 'new' }
  | { name: 'script' }
  | { name: 'working'; slug: string }
  | { name: 'reel'; slug: string; fresh?: boolean }
  | { name: 'library' }
  | { name: 'style' }
  | { name: 'settings' }
  /** `back`: the screen the person came from; the back link returns there (default: My videos) */
  | { name: 'connect'; back?: Exclude<Screen, { name: 'connect' }> }

export type Go = (s: Screen) => void
