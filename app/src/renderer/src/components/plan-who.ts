// Who answers in the plan chat: the editor in use and, where the app knows it, the model for the writer role, which
// planning runs on (main/index.ts projects:planSay, ai planTurn). Read from the fields the app already has:
// ProviderInfo (ai index.ts statusOf) and Settings › Editor › Models (AppInfo.models). Keep free of DOM imports.
import type { ProviderInfo } from '../../../shared/api'

export type AnswererMark = 'claude' | 'openai' | 'server'

export interface Answerer {
  mark: AnswererMark | null
  /** what the header shows first: "Claude", "ChatGPT", a server's own name */
  name: string
  /** the model, when the app knows it; null when the editor picks its own */
  model: string | null
  /** the whole truth, for the tooltip and a screen reader */
  full: string
}

/** Claude Code's model names (ModelsAndPrivacy.tsx), shown capitalised as Settings shows them. */
const CLAUDE_CODE_MODELS = ['fable', 'opus', 'sonnet']
const shown = (m: string): string => (CLAUDE_CODE_MODELS.includes(m) ? m[0].toUpperCase() + m.slice(1) : m)

/**
 * `writer`: Settings' choice for the writer role, 'auto' or a model. The Claude Code app's `detail` is its version and
 * a Codex app's is too, so neither is shown as a model; with Auto the app does not know which model they use.
 */
export function planAnswerer(p: ProviderInfo | null, writer: string): Answerer | null {
  if (!p || !p.connected || p.id === 'none') return null
  const picked = writer && writer !== 'auto' ? writer : null
  const make = (mark: AnswererMark | null, name: string, model: string | null): Answerer => ({
    mark,
    name,
    model,
    full: `${p.label}${model ? `, ${model}` : ''}`
  })
  switch (p.id) {
    case 'claude-cli':
      return make('claude', 'Claude', picked ? shown(picked) : null)
    case 'claude':
      return make('claude', 'Claude', p.detail ?? null)
    case 'codex-cli':
      return make('openai', 'ChatGPT', null)
    case 'custom':
      return make('server', p.label, picked ?? p.detail ?? null)
    default:
      return make(null, p.label, null)
  }
}
