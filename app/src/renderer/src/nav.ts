export type Screen =
  | { name: 'home' }
  /** `version`: open showing this version (Insights opens the one that was posted) instead of the newest. */
  | { name: 'reel'; slug: string; version?: number }
  | { name: 'library' }
  | { name: 'style' }
  | { name: 'insights' }
  | { name: 'settings'; section?: SettingsSection }
  | { name: 'connect'; back?: Exclude<Screen, { name: 'connect' }> }

export type Go = (s: Screen) => void

export type SettingsSection = 'ai' | 'listen' | 'where' | 'notify' | 'privacy' | 'posting' | 'about'
