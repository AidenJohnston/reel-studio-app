// Where new versions are published. Confirm this owner/repo before the first public release.
export const RELEASES_REPO = 'AidenJohnston/reel-studio-app'
export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`

/** "Install it myself": each vendor's own install page for the person's own AI app (Connect Claude / Connect ChatGPT). */
export const VENDOR_INSTALL_PAGES = {
  claude: 'https://code.claude.com/docs/en/setup',
  chatgpt: 'https://learn.chatgpt.com/docs/codex/cli'
} as const
/** Where a Claude plan is upgraded (the free plan does not include the Claude Code app). */
export const CLAUDE_PLANS_URL = 'https://claude.ai/upgrade'
