# @reelstudio/ai

The AI editor for Reel Studio: providers, prompts, tools and the agent loop. It never touches media:
it edits `project.json` through a fixed tool set and asks the engine (via `EngineHost`) to render.

## Use from the Electron main process

```ts
import { createAI } from '@reelstudio/ai';
import { app, safeStorage, shell } from 'electron';

const ai = createAI({
  host,                                                    // your EngineHost (docs/architecture.md section 8)
  settingsDir: path.join(app.getPath('userData'), 'ai'),   // provider settings + encrypted tokens
  secretStore: safeStorage,                                // tokens + Claude key encrypted at rest
  dev: process.env.REELSTUDIO_DEV === '1',                 // also shows codex-cli / replay
});

await ai.signInChatGPT((url) => shell.openExternal(url));  // system browser, loopback redirect
await ai.setClaudeKey('sk-ant-...');                       // validated with a 1-token request
const r = await ai.firstEdit(projectDir, onEvent, signal); // r.notice is set if the AI stopped and a simple edit was made
await ai.applyNote(projectDir, 'music too loud at the start', onEvent);
```

Extra methods beyond docs/architecture.md section 8: `cancelSignInChatGPT()`, `chatgptModels()`, `setModel(which, model)`,
`testConnection()`, `setReplayFixture(file)`, `claudeCodeStatus()`. `ProviderStatus` may carry `detail` (email / model) and `error`
(`{code, userMessage, link?}`); `AgentResult` may carry `notice` (same shape). All errors thrown are `AIError`
with a grandma-friendly `userMessage` and optional `link` (e.g. the ChatGPT usage page).

`claude-cli` is **"Claude (your Claude Code app)"**: the person's own Claude Code app (Anthropic's `claude` CLI),
offered to everyone and always listed in its real state. `claudeCodeStatus()` is a fresh look and returns
`{state: 'missing' | 'broken' | 'signed_out' | 'ready', installed, signedIn, bin?, version?, plan?, authMethod?, reason?}`.
The binary is searched for on PATH, `~/.local/bin` (Anthropic's native installer), `~/.claude/local`, then on macOS
`/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/.nvm/versions/node/*/bin`, `~/.volta/bin`,
`~/.bun/bin` and last the login shell (`$SHELL -ilc 'command -v claude'`, 5 s cap; a Finder-launched app has a
bare PATH); on Windows also `%LOCALAPPDATA%\Microsoft\WinGet\Links`, WinGet `Packages\Anthropic.ClaudeCode_*` and the
native `claude.exe` that npm installs under `%APPDATA%\npm\node_modules\@anthropic-ai\` (never the `.cmd` shim).
Installed = `claude --version` exits 0; ready = `claude auth status` says `loggedIn: true`. No credential file is
ever read: the answer is the CLI's own, and only the yes/no, the version and the plan kind are kept (never the
e-mail or organization; `ProviderStatus.detail` is the version). `setActive('claude-cli')` refuses unless it is
ready, and `active()` never falls back to it on its own: it spends the person's own Claude plan, so only their
click turns it on. A saved `active: 'claude-cli'` keeps working. Detection is cached for 60 s. Children get
`childEnv()` (no `ANTHROPIC_*`), so a stray API key variable never changes what the person's CLI reports or bills.

Prompts are plain markdown in `ai/prompts/`, loaded at runtime. Packaged apps: ship the folder next to
`dist/` (works inside asar) or at `<resources>/ai/prompts`; override with `REELSTUDIO_PROMPTS_DIR` or `promptsDir`.

## Engine commands used

All with `--project <dir>`: `transcribe`, `analyze` (reads `work/analysis.json`), `autocut`, `render [--draft]`,
`frames --times a,b`, `search-images --query Q` -> `{results:[{url,title,source,width,height,license}]}`,
`fetch-image --url U [--name N]` -> `{asset: "work/assets/x.png", path}`, `analyze-music <abs path> --no-beats`
(tempo, energy, `suggestedStartAt`). An engine without them degrades: no search -> text / animation treatments,
no fetch-image -> in-process download, no analyze-music -> start at 0. Versions vs previews: `docs/versions.md`. Animations go through
`host.renderAnimation(template, params, outPath)`.

## CLI (dev)

```
node dist/cli.js pick-takes --provider claude-cli|codex-cli|claude|replay [--model M] --in transcript.json --out cut.json
node dist/cli.js first-edit --project DIR --provider claude-cli [--engine-cwd engine/] [--python PY] [--root ROOT] [--record s.json]
node dist/cli.js apply-note --project DIR --note "..." --provider claude-cli [...]
node dist/cli.js write-script --idea "..." --provider claude-cli
node dist/cli.js chatgpt-signin | chatgpt-test | chatgpt-models | chatgpt-status | chatgpt-signout  [--settings DIR]
```

`pick-takes` input: documented transcript.json (`{"words":[{"id","source","s","e","w"}]}`), optionally with
`retakes` / `retakeGroups` / `retake_groups` (`[{candidates|takes:[{from,to}]}]`) and `pauses`. Output:
`{"keep":[{"from","to"}], "notes", "provider", "model", "attempts", "ms"}`. Ids are validated; bad output is
sent back to the model for a fix (max 3 attempts), then the command exits 1.

## Tests

`npm test` (vitest): tool schemas (OpenAI strict-mode rules), project API, every tool against a fake engine,
Anthropic adapter (mock HTTP SSE), Sign in with ChatGPT (mock OAuth/OIDC server: PKCE, registration, JWKS,
refresh rotation, revocation, errors), Responses API (namespaced tools, SSE, usage limit, retries), CLI protocol,
agent loop with a scripted model, and replays of real recorded `claude -p` sessions (`fixtures/`).
Re-record: `RECORD_LIVE=1 npx vitest run test/fixtures.test.ts`.
