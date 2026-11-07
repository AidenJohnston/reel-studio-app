# @reelstudio/ai

The AI editor for Reel Studio: providers, prompts, tools and the agent loop. It never touches media:
it edits `project.json` through a fixed tool set and asks the engine (via `EngineHost`) to render.

## Use from the Electron main process

```ts
import { createAI } from '@reelstudio/ai';
import { app, safeStorage } from 'electron';

const ai = createAI({
  host,                                                    // your EngineHost (docs/architecture.md section 8)
  settingsDir: path.join(app.getPath('userData'), 'ai'),   // provider settings + encrypted keys
  secretStore: safeStorage,                                // Claude key + connection keys encrypted at rest
  dev: process.env.REELSTUDIO_DEV === '1',                 // also shows the replay provider
});

await ai.setClaudeKey('sk-ant-...');                       // validated with a 1-token request
const r = await ai.firstEdit(projectDir, onEvent, signal); // r.notice is set if the AI stopped and a simple edit was made
await ai.applyNote(projectDir, 'music too loud at the start', onEvent);
```

Extra methods beyond docs/architecture.md section 8: `setModel(which, model)`,
`testConnection()`, `setReplayFixture(file)`, `claudeCodeStatus()`. `ProviderStatus` may carry `detail` (email / model) and `error`
(`{code, userMessage, link?}`); `AgentResult` may carry `notice` (same shape). All errors thrown are `AIError`
with a grandma-friendly `userMessage` and optional `link` (e.g. a plan's usage page).

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

## Reading long tool results

`get_transcript`, `get_project`, and `list_library` accept nullable `offset` and `limit` arguments.
`offset` defaults to 0; `limit` defaults to 8192 and must be an integer from 1 to 8192.
Offsets count UTF-16 code units in the complete formatted result. An offset beyond the result's length
returns an error. An offset at its length returns an empty final page.

Short results keep their existing format when both arguments are omitted or null. Longer results,
and any request with an explicit offset or limit, return JSON with this shape:

```json
{"text":"...","page":{"offset":0,"limit":8192,"total":24000,"nextOffset":8192}}
```

Each page contains at most 8192 code units of text, keeping its serialized JSON below 64 KiB even
when characters need escaping. Pass `nextOffset` as the next request's `offset` until it is null.
Concatenate the `text` fields before reading the transcript or parsing a project or library's JSON.
A page can split a Unicode surrogate pair; concatenating the text restores the original string.
Paging reads current state on each call, so finish a read before editing its project or library.

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
```

`pick-takes` input: documented transcript.json (`{"words":[{"id","source","s","e","w"}]}`), optionally with
`retakes` / `retakeGroups` / `retake_groups` (`[{candidates|takes:[{from,to}]}]`) and `pauses`. Output:
`{"keep":[{"from","to"}], "notes", "provider", "model", "attempts", "ms"}`. Ids are validated; bad output is
sent back to the model for a fix (max 3 attempts), then the command exits 1.

## Tests

`npm test` (vitest): tool schemas (OpenAI strict-mode rules), project API, every tool against a fake engine,
Anthropic adapter (mock HTTP SSE), CLI protocol,
agent loop with a scripted model, and replays of real recorded `claude -p` sessions (`fixtures/`).
Re-record: `RECORD_LIVE=1 npx vitest run test/fixtures.test.ts`.

## MCP runners

Settings › Editor › How notes run (`setNoteRunner('app')`) writes `harness: "claude-code"` or
`harness: "codex"` to `ai-settings.json`. It applies only while the matching app is the editor in use
(`active: "claude-cli"` or `"codex-cli"`) and that app is installed and signed in; otherwise notes
run in Reel Studio's own loop. The dev CLI also accepts `--harness claude-code|codex` on `apply-note`.
The first AI note checks a nonce round-trip through the selected CLI and relay before exposing
editing tools. Failure logs its reason in a status event and selects the existing text provider
for the rest of that app session, and `noteRunner().fellBack` reports it to Settings. Choosing the
app again forgets the failed probe. Cancelling the probe permits a new probe on the next note.

Codex flags were checked against codex-cli 0.163.0. The runner uses `exec --sandbox read-only`,
ignores user configuration and rules, and disables shell, image, browser, app, plugin and agent
features. It forwards relay credentials through environment variables, not command arguments.
This CLI still advertises `apply_patch`; no supported switch to remove it was established.
The read-only sandbox remains required. MCP image delivery in Codex
has not been verified, so its runner reports no image support.

This base does not include #73. Its backend entry point is `ApplyNoteOptions.checkEdits` or the
`checkEdits` dev setting, also exposed as `--check-edits` in the dev CLI. Claude edits are checked
by Codex and Codex edits by Claude. The checker receives only project/transcript/frame reads and
`report_check`; the main process rejects editing calls. Findings return to the editor for at most
two repairs. An incomplete check discards the note. Findings left after the repair limit appear
in the saved reply. This slice does not add the #73 settings interface or its check-history files.
