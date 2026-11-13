/** Reel Studio's website: where the installers are sold, the update check's only server, the Help menu link. */
export const SITE_URL = 'https://getreelstudio.com'
/** Settings > "Check for a newer version": the site's download page (installers are no longer on GitHub). */
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
