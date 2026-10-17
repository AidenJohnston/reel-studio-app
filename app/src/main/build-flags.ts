// Flags baked into the bundle at build time (electron.vite.config.ts `define`).
// REELSTUDIO_LOCAL_CLAUDE_CODE_BUILD=1 at build time = the local Claude Code build: it may use the
// Claude Code already logged in on this computer. The public build never offers that.
//
// For convenience an UNPACKAGED app (npm run dev / npm start / e2e) also honours the variable at
// run time. A packaged app (what users install) only ever reads the baked value, so a public
// installer cannot be switched into the local Claude Code build by setting an environment variable.
declare const __REELSTUDIO_LOCAL_CLAUDE_CODE_BUILD__: boolean | undefined

export const LOCAL_CLAUDE_CODE_BUILD_BAKED: boolean =
  typeof __REELSTUDIO_LOCAL_CLAUDE_CODE_BUILD__ !== 'undefined' && __REELSTUDIO_LOCAL_CLAUDE_CODE_BUILD__ === true

export function localClaudeCodeBuild(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return LOCAL_CLAUDE_CODE_BUILD_BAKED || (!isPackaged && env.REELSTUDIO_LOCAL_CLAUDE_CODE_BUILD === '1')
}
