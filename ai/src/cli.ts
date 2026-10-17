#!/usr/bin/env node
// reelstudio-ai CLI (dev). Commands:
//   pick-takes  --provider claude-cli|codex-cli|claude|replay --model M --in transcript.json --out cut.json [--record f.json]
//   first-edit  --project DIR --provider P [--model M] [--engine-cwd DIR] [--root DIR] [--record f.json] [--draft-only]
//   apply-note  --project DIR --note "..." --provider P [...]
//   write-script --idea "..." --provider P [...]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentEvent, ModelProvider } from './types';
import { ClaudeCliProvider, CodexCliProvider } from './providers/cli';
import { AnthropicProvider } from './providers/anthropic';
import { ReplayProvider, RecordingProvider } from './providers/replay';
import { pickTakes } from './editor';
import { PythonEngineHost } from './engineHost';
import { createAI } from './index';
import { writeFileAtomic } from './project';
import { devSettingsDir as defaultSettingsDir } from './safety';

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | true> } {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) flags[k] = true; else { flags[k] = v; i++; }
  }
  return { cmd: cmd ?? 'help', flags };
}

function makeProvider(flags: Record<string, string | true>, task: string): ModelProvider {
  const id = String(flags.provider ?? 'claude-cli');
  const model = typeof flags.model === 'string' ? flags.model : undefined;
  let p: ModelProvider;
  switch (id) {
    case 'claude-cli': p = new ClaudeCliProvider({ model }); break;
    case 'codex-cli': p = new CodexCliProvider({ model }); break;
    case 'claude': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('set ANTHROPIC_API_KEY for --provider claude');
      // take the key out of the environment so no child (python, claude, codex) inherits it
      for (const k of Object.keys(process.env)) if (/^ANTHROPIC_/i.test(k)) delete process.env[k];
      p = new AnthropicProvider({ apiKey: key, model });
      break;
    }
    case 'replay': {
      if (typeof flags.fixture !== 'string') throw new Error('--fixture FILE is required for --provider replay');
      p = new ReplayProvider(flags.fixture);
      break;
    }
    default: throw new Error(`unknown provider ${id}`);
  }
  return typeof flags.record === 'string' ? new RecordingProvider(p, flags.record, task) : p;
}

const log = (e: AgentEvent) => {
  if (e.type === 'status') process.stderr.write(`[status] ${e.message}${e.pct !== undefined ? ` (${e.pct}%)` : ''}\n`);
  else if (e.type === 'tool') process.stderr.write(`[tool] ${e.name}: ${e.summary}\n`);
  else if (e.type === 'reply') process.stderr.write(`[reply] ${e.text}\n`);
  else process.stderr.write(`[render] v${e.version}${e.draft ? ' draft' : ''}\n`);
};

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd === 'pick-takes') {
    if (typeof flags.in !== 'string' || typeof flags.out !== 'string') throw new Error('--in and --out are required');
    const input = JSON.parse(fs.readFileSync(flags.in, 'utf8').replace(/^﻿/, ''));
    const provider = makeProvider(flags, 'pickTakes');
    const t0 = Date.now();
    const r = await pickTakes(input, provider);
    const out = { keep: r.keep, notes: r.notes, provider: provider.id, model: provider.model ?? null, attempts: r.attempts, ms: Date.now() - t0 };
    await writeFileAtomic(flags.out, JSON.stringify(out, null, 2) + '\n');
    process.stdout.write(JSON.stringify({ ok: true, ranges: r.keep.length, ms: out.ms, out: flags.out }) + '\n');
    return;
  }
  if (cmd === 'first-edit' || cmd === 'apply-note' || cmd === 'write-script') {
    const provider = makeProvider(flags, cmd);
    const host = new PythonEngineHost({
      cwd: typeof flags['engine-cwd'] === 'string' ? flags['engine-cwd'] : process.env.REELENGINE_CWD,
      python: typeof flags.python === 'string' ? flags.python : undefined,
      root: typeof flags.root === 'string' ? flags.root : undefined,
      log: flags.verbose ? (l) => process.stderr.write(`[engine] ${l}\n`) : undefined,
    });
    const settingsDir = typeof flags.settings === 'string' ? flags.settings : defaultSettingsDir();
    const ai = createAI({ host, settingsDir, dev: true, providerOverride: provider, finalRender: !flags['draft-only'] });
    let result: unknown;
    if (cmd === 'first-edit') result = await ai.firstEdit(String(flags.project), log);
    else if (cmd === 'apply-note') result = await ai.applyNote(String(flags.project), String(flags.note ?? ''), log);
    else result = await ai.writeScript(String(flags.idea ?? ''), log);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (cmd.startsWith('chatgpt-')) {
    // Morning manual test of "Sign in with ChatGPT" without the app. Dev only: tokens go to an
    // owner-only file in --settings (the app uses Electron safeStorage instead).
    const host = new PythonEngineHost({ root: typeof flags.root === 'string' ? flags.root : undefined });
    const settingsDir = typeof flags.settings === 'string' ? flags.settings : defaultSettingsDir();
    // no OS keychain in a plain Node CLI: tokens are only saved with an explicit --insecure-plaintext
    const ai = createAI({ host, settingsDir, siwcIssuer: typeof flags.issuer === 'string' ? flags.issuer : undefined, allowPlaintextSecrets: !!flags['insecure-plaintext'] });
    const show = (x: unknown) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');
    if (cmd === 'chatgpt-signin') {
      const st = await ai.signInChatGPT(async (url) => {
        process.stderr.write(`Opening your browser. If nothing opens, paste this link into it:\n${url}\n`);
        await openInBrowser(url);
      });
      show(st);
      if (st.connected) show({ models: await ai.chatgptModels() });
    } else if (cmd === 'chatgpt-status') show(await ai.providers());
    else if (cmd === 'chatgpt-models') show(await ai.chatgptModels());
    else if (cmd === 'chatgpt-test') {
      if (typeof flags.model === 'string') await ai.setModel('chatgpt', flags.model);
      await ai.setActive('chatgpt');
      try { show(await ai.testConnection()); } catch (e: any) { show(e?.toJSON ? e.toJSON() : { error: String(e?.message ?? e) }); process.exitCode = 2; }
    } else if (cmd === 'chatgpt-signout') { await ai.signOutChatGPT(); show(await ai.providers()); }
    return;
  }
  process.stdout.write(`reelstudio-ai <command>
  pick-takes   --provider claude-cli|codex-cli|claude|replay [--model M] --in transcript.json --out cut.json [--record session.json]
  first-edit   --project DIR --provider P [--model M] [--engine-cwd DIR] [--root DIR] [--record session.json] [--draft-only]
  apply-note   --project DIR --note TEXT --provider P [...]
  write-script --idea TEXT --provider P [...]
  chatgpt-signin  [--settings DIR] --insecure-plaintext
                  sign in with ChatGPT in your browser, then list models. The CLI has no OS keychain,
                  so tokens are kept in a PLAIN file and only with --insecure-plaintext.
                  Default settings dir: %LOCALAPPDATA%\\Reel Studio\\ai-dev (never Documents).
  chatgpt-test    [--model SLUG]       one tiny request through your ChatGPT plan
  chatgpt-status | chatgpt-models | chatgpt-signout
`);
}

function openInBrowser(url: string): Promise<void> {
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    const c = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    c.on('error', () => resolve());
    c.unref();
    resolve();
  });
}

main().catch((e) => {
  process.stderr.write(`error: ${e?.userMessage ? `${e.userMessage} ` : ''}${e?.message ?? e}\n`);
  process.exit(1);
});
