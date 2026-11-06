// Every setting, once: its section, the label Settings shows, and the other words people search for it by.
// Settings draws each row's label from here, so what search finds is always what the row says.

// In spec.md section 8's order. Posting, which the spec doesn't list, sits with the reels it would post.
export const SECTIONS = {
  editor: 'Editor',
  privacy: 'Privacy',
  reels: 'Reels',
  posting: 'Posting',
  about: 'About and updates',
  advanced: 'Advanced'
} as const

export type SectionId = keyof typeof SECTIONS

const MODEL_WORDS = ['model', 'models', 'Fable', 'Opus', 'Sonnet', 'Auto']
const SHARING_WORDS = ['telemetry', 'analytics', 'data sharing']

export const SETTINGS = {
  editor: { section: 'editor', label: 'Choose your editor', synonyms: ['AI', 'AI editor', 'Claude', 'Claude Code', 'ChatGPT', 'OpenAI', 'GPT', 'provider', 'connect', 'sign in', 'log in', 'sign out', 'disconnect', 'account', 'plan', 'subscription', 'CLIProxyAPI', 'proxy', 'hub', 'accounts', 'limits', 'usage', 'reset', 'test', 'Codex'] },
  'check-edits': { section: 'editor', label: 'Double-check each edit', synonyms: ['check', 'checker', 'double check', 'review', 'second look', 'verify', 'fix', 'mistakes'] },
  'look-ups': { section: 'editor', label: 'Look things up in parallel', synonyms: ['helpers', 'helper', 'subagents', 'agents', 'parallel', 'search', 'pictures', 'b-roll', 'second AI', 'Codex', 'Claude Code'] },
  models: { section: 'editor', label: 'Models', synonyms: [...MODEL_WORDS, 'stage', 'stages', 'editor model', 'checker', 'writer', 'titles', 'planning', 'more reels', 'Try 2', 'reasoning', 'effort', 'GPT', 'small model'] },
  'own-server': { section: 'editor', label: 'Your own AI server', synonyms: ['server', 'local', 'self-hosted', 'Ollama', 'LM Studio', 'OpenAI-compatible', 'Anthropic-compatible', 'endpoint', 'base URL', 'proxy', 'custom', 'advanced'] },
  'api-key': { section: 'editor', label: 'Anthropic API key', synonyms: ['key', 'API', 'token', 'console', 'billing', 'pay as you go', 'advanced'] },
  'stock-keys': { section: 'advanced', label: 'Stock photos and footage', synonyms: ['stock', 'Pexels', 'Pixabay', 'Openverse', 'photos', 'footage', 'b-roll', 'pictures', 'key', 'API', 'advanced'] },
  youtube: { section: 'posting', label: 'YouTube', synonyms: ['post', 'posting', 'publish', 'upload', 'channel', 'Shorts', 'Google', 'connect'] },
  'posting-sign-in': { section: 'posting', label: 'This computer', synonyms: ['sign in', 'sign out', 'sign out everywhere', 'posting server', 'download key', 'computers'] },
  instagram: { section: 'posting', label: 'Instagram', synonyms: ['post', 'posting', 'publish', 'upload', 'social', 'platforms', 'TikTok', 'YouTube', 'Shorts'] },
  'library-folder': { section: 'reels', label: 'Library folder', synonyms: ['folder', 'location', 'where', 'storage', 'save', 'saved', 'path', 'directory', 'Movies', 'Documents', 'Finder', 'Explorer', 'disk', 'files', 'move'] },
  'listening-model': { section: 'reels', label: 'Listening model', synonyms: ['subtitles', 'captions', 'transcript', 'transcription', 'speech', 'speech to text', 'Whisper', 'WhisperX', 'words', 'voice', 'download', 'offline'] },
  'faster-exports': { section: 'reels', label: 'Faster versions', synonyms: ['30 fps', '30fps', '60 fps', 'fps', 'frame rate', 'export quality', 'quality', 'smooth', 'speed', 'render', 'export'] },
  notifications: { section: 'reels', label: 'Notify when a reel is ready', synonyms: ['notifications', 'alerts', 'notify', 'banner', 'finished', 'done'] },
  sharing: { section: 'privacy', label: 'Share anonymous data to help improve Reel Studio', synonyms: [...SHARING_WORDS, 'tracking', 'diagnostics', 'usage data', 'opt out', 'opt in', 'statistics', 'stats', 'privacy'] },
  'sharing-usage': { section: 'privacy', label: 'Usage', needs: 'sharing', synonyms: [...SHARING_WORDS, 'features', 'errors', 'crashes'] },
  'sharing-quality': { section: 'privacy', label: 'Quality scores', needs: 'sharing', synonyms: [...SHARING_WORDS, 'edit quality', 'scores', 'kept', 'undone'] },
  'sharing-posts': { section: 'privacy', label: 'Post results', needs: 'sharing', synonyms: [...SHARING_WORDS, 'views', 'view counts', 'results'] },
  'sharing-sample': { section: 'privacy', label: 'What would be kept', synonyms: [...SHARING_WORDS, 'what is shared', 'see my data', 'example'] },
  'sharing-kept': { section: 'privacy', label: 'Kept on this computer', needs: 'sharing', synonyms: [...SHARING_WORDS, 'what is shared', 'see my data', 'waiting', 'sent'] },
  version: { section: 'about', label: 'Version', synonyms: ['about', 'version number', 'build', 'release'] },
  licence: { section: 'about', label: 'Licence and notices', synonyms: ['license', 'AGPL', 'GNU', 'open source', 'notices', 'third party', 'credits', 'copyright'] },
  updates: { section: 'about', label: 'Check for updates', synonyms: ['update', 'updates', 'upgrade', 'new version', 'automatic updates', 'download', 'install', 'restart', 'releases'] },
  'auto-updates': { section: 'about', label: 'Automatic updates', synonyms: ['download key', 'download link', 'receipt', 'purchase', 'subscription', 'license key', 'install updates'] },
  'whats-new': { section: 'about', label: 'What’s new', synonyms: ['whats new', 'changelog', 'release notes', 'changes', 'new features'] },
  'engine-cache': { section: 'advanced', label: 'Cache', synonyms: ['clear cache', 'engine', 'disk', 'space', 'storage', 'free up', 'temporary', 'song analysis', 'delete'] },
  logs: { section: 'advanced', label: 'Logs', synonyms: ['log', 'show logs', 'diagnostics', 'debug', 'troubleshoot', 'problem', 'bug', 'report', 'crash', 'support'] },
  'first-run': { section: 'advanced', label: 'Reset first run', synonyms: ['first run', 'onboarding', 'welcome', 'sample', 'setup', 'start over', 'tutorial', 'intro', 'reset'] }
} as const satisfies Record<string, { section: SectionId; label: string; synonyms: readonly string[]; needs?: string }>

export type SettingId = keyof typeof SETTINGS

export const SETTING_IDS = Object.keys(SETTINGS) as SettingId[]

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const HAYSTACK = new Map(SETTING_IDS.map((id) => [id, words([SETTINGS[id].label, SECTIONS[SETTINGS[id].section], ...SETTINGS[id].synonyms].join(' '))]))

/**
 * The settings a search shows: every word typed starts a word of the label, the section's name or a synonym, plus
 * the switch a found setting `needs` to be usable (Usage is greyed out until sharing is on). null: no search.
 */
export function findSettings(query: string): Set<SettingId> | null {
  const typed = words(query)
  if (!typed.length) return null
  const found = SETTING_IDS.filter((id) => typed.every((w) => HAYSTACK.get(id)!.some((h) => h.startsWith(w))))
  return new Set(found.flatMap((id) => ('needs' in SETTINGS[id] ? [SETTINGS[id].needs as SettingId, id] : [id])))
}

const fold = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

/**
 * Where `query` matches inside `text`, as [start, end) ranges to highlight: the start of each word that a typed word
 * begins, as far as the typed word goes. Same rule as findSettings, so what's highlighted is why the row was found.
 */
export function matchRanges(text: string, query: string): [number, number][] {
  const typed = words(query)
  if (!typed.length) return []
  const out: [number, number][] = []
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const best = typed.filter((t) => fold(m[0]).startsWith(t)).reduce((a, t) => Math.max(a, t.length), 0)
    if (!best) continue
    // the original letters that fold to the first `best` ones: "É" is one letter, as "e"
    let n = 0
    for (let len = 0; n < m[0].length && len < best; n++) len += fold(m[0][n]).length
    out.push([m.index, m.index + n])
  }
  return out
}

/**
 * The synonym that explains a match the label doesn't show ("telemetry" finding the data-sharing switch), or null
 * when the label, or the section's name, already shows every typed word.
 */
export function matchedSynonym(id: SettingId, query: string): string | null {
  const typed = words(query)
  const shown = new Set([...words(SETTINGS[id].label), ...words(SECTIONS[SETTINGS[id].section])])
  const missing = typed.filter((t) => ![...shown].some((w) => w.startsWith(t)))
  if (!missing.length) return null
  const covers = (syn: string, need: string[]) => need.every((t) => words(syn).some((w) => w.startsWith(t)))
  const synonyms: readonly string[] = SETTINGS[id].synonyms
  return synonyms.find((syn) => covers(syn, missing)) ?? synonyms.find((syn) => covers(syn, missing.slice(0, 1))) ?? null
}
