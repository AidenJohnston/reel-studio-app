// Where new versions are published. Confirm this owner/repo before the first public release.
export const RELEASES_REPO = 'AidenJohnston/reel-studio-app'
export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`
/** Nightly builds (shared/channel.ts) are prereleases on the fork that builds them, never on the main repo. */
export const NIGHTLY_RELEASES_REPO = 'SamGu-NRX/reel-studio-app'
/** Reel Studio's website: where the installers are sold, the update check's only server, the Help menu link. */
export const SITE_URL = 'https://getreelstudio.com'
/** Settings › About › "Download page": the site's download page (installers are no longer on GitHub). */
export const UPDATE_PAGE_URL = 'https://getreelstudio.com/update.html'

/** "Install it myself": each vendor's own install page for the person's own AI app (Connect Claude / Connect ChatGPT). */
export const VENDOR_INSTALL_PAGES = {
  claude: 'https://code.claude.com/docs/en/setup',
  chatgpt: 'https://learn.chatgpt.com/docs/codex/cli'
} as const
/** Where a Claude plan is upgraded (the free plan does not include the Claude Code app). */
export const CLAUDE_PLANS_URL = 'https://claude.ai/upgrade'
/** Billing and anything a problem report can't carry. "Report a problem" offers it when sending fails. */
export const SUPPORT_EMAIL = 'support@getreelstudio.com'
/** The posting server (main/posting.ts). Not live yet; REELSTUDIO_POSTING_URL points the app at staging or a local run. */
export const POSTING_URL = 'https://post.getreelstudio.com'
/**
 * Reel Studio's sign-in service (app/src/server/signin, docs/signin.md): holds the Instagram, Facebook and TikTok app
 * secrets and does their sign-in exchange. Not deployed yet; REELSTUDIO_SIGNIN_URL points the app at a local run.
 */
export const SIGNIN_URL = 'https://signin.getreelstudio.com'
/**
 * Where anonymous usage data goes when the person shares it (main/usage.ts). null: there is no server for it yet, so
 * nothing is sent; what would be is kept on the computer and shown in Settings › Privacy.
 */
export const USAGE_ENDPOINT: string | null = null
