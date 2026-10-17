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
  dev: process.env.REELSTUDIO_DEV === '1',                 // shows claude-cli / codex-cli / replay
  allowLocalClaudeCode: LOCAL_CLAUDE_CODE_BUILD,                     // offer "Claude Code on this computer" (default false)
});

await ai.signInChatGPT((url) => shell.openExternal(url));  // system browser, loopback redirect
await ai.setClaudeKey('sk-ant-...');                       // validated with a 1-token request
const r = await ai.firstEdit(projectDir, onEvent, signal); // r.notice is set if the AI stopped and a simple edit was made
await ai.applyNote(projectDir, 'music too loud at the start', onEvent);
```

Extra methods beyond docs/architecture.md section 8: `cancelSignInChatGPT()`, `chatgptModels()`, `setModel(which, model)`,
`testConnection()`, `setReplayFixture(file)`. `ProviderStatus` may carry `detail` (email / model) and `error`
(`{code, userMessage, link?}`); `AgentResult` may carry `notice` (same shape). All errors thrown are `AIError`
with a grandma-friendly `userMessage` and optional `link` (e.g. the ChatGPT usage page).

`allowLocalClaudeCode: true` (a local Claude Code build; the public installers leave it false) lists `claude-cli`
as **"Claude Code on this computer"** when a `claude` binary is found (PATH, `~/.local/bin`, `~/.claude/local`,
`/opt/homebrew/bin`, `/usr/local/bin`) and answers `--version`. It is `connected` only when `claude auth status`
reports `loggedIn: true` (signed out = listed with a "run claude and sign in" `error`, not selectable). With
nothing else connected it becomes the active provider. Detection is cached for 60 s. Independent of `dev`.

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
