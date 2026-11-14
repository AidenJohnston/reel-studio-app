// Pins the size of every request the AI tasks send (ai/context-budget.json). Not exercised: note attachments, image
// follow-ups, provider errors. After an intended change: UPDATE_CONTEXT_BUDGET=1 npm test -w ai, then commit the file.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import type { CompletionRequest } from '../src/types';
import { createAI, pickTakes } from '../src';
import { ClaudeCliProvider, renderConversation, renderDelta } from '../src/providers/cli';
import { Prompts } from '../src/prompts';
import { FakeHost, ScriptedModel, call, makeProject, tmpDir } from './helpers';

const FILE = join(__dirname, '..', 'context-budget.json');
const LINES = ['Here is the one thing about bread.', 'Wait for it to rise.'];
const claudeSystem = (() => {
  const args = (new ClaudeCliProvider() as unknown as { args(): string[] }).args();
  return args[args.indexOf('--system-prompt') + 1];
})();

const api = (r: CompletionRequest) => r.system.length + JSON.stringify(r.messages).length + JSON.stringify(r.tools).length;
/** Mirrors ClaudeCliProvider.sessionTurn: a continuing live session is sent only the new messages. */
const continues = (prev: CompletionRequest | undefined, r: CompletionRequest) =>
  !!prev && prev.system === r.system && r.messages.length > prev.messages.length + 1 && r.messages[prev.messages.length]?.role === 'assistant';
const cli = (r: CompletionRequest, prev?: CompletionRequest) =>
  continues(prev, r) ? renderDelta(r, prev!.messages.length + 1).text.length : claudeSystem.length + renderConversation(r).text.length;
const firstUserText = (r: CompletionRequest) => {
  const m = r.messages.find((x) => x.role === 'user');
  return m && m.role === 'user' ? m.content.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n') : '';
};

async function capture(): Promise<{ kind: string; req: CompletionRequest; prev?: CompletionRequest }[]> {
  const prompts = new Prompts(join(__dirname, '..', 'prompts'));
  const starts = (name: 'firstEdit' | 'applyNote' | 'proofread' | 'writeScript' | 'pickTakes', text: string) =>
    text.startsWith(prompts.render(name).slice(0, 60));
  const kindOf = (r: CompletionRequest) => {
    const task = firstUserText(r);
    return starts('writeScript', r.system) ? 'writeScript'
      : starts('pickTakes', r.system) ? 'pickTakes'
      : task.startsWith('The edit of this video is saved') ? 'postKit'
      : starts('proofread', task) ? 'proofread'
      : starts('applyNote', task) ? 'applyNote'
      : starts('firstEdit', task) ? 'firstEdit' : 'other';
  };

  const project = async () => {
    const p = await makeProject({ lines: LINES });
    // One word the speech model was unsure of, and a cut that keeps it, so the caption proofread runs too.
    p.transcript.words[6] = { ...p.transcript.words[6], p: 0.5 } as typeof p.transcript.words[6];
    await fsp.writeFile(join(p.dir, 'work', 'transcript.json'), JSON.stringify(p.transcript));
    return p;
  };
  const keepAll = (n: number) => call('set_cut', { keep: [{ from: 'w0', to: `w${n - 1}` }] });
  const runs: ScriptedModel[] = [];

  // 1. Every task. writeScript and pickTakes also retry: the fake model sends no JSON.
  const { root, dir, transcript } = await project();
  const model = new ScriptedModel([{ toolCalls: [keepAll(transcript.words.length)] }]);
  const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: model });
  await ai.firstEdit(dir, () => undefined).catch(() => undefined);
  await ai.applyNote(dir, 'x', () => undefined).catch(() => undefined);
  await ai.writeScript('x', () => undefined).catch(() => undefined);
  await pickTakes(transcript, model).catch(() => undefined);
  runs.push(model);

  // 2. The agent's corrections for a reply with no tool call and a malformed one.
  const second = await project();
  const misses = new ScriptedModel([{ text: 'Let me look first.' }, { text: '{"tool_calls": [', malformed: true }]);
  await createAI({ host: new FakeHost(second.root), settingsDir: tmpDir('settings '), providerOverride: misses })
    .firstEdit(second.dir, () => undefined).catch(() => undefined);
  runs.push(misses);

  const ok = new ScriptedModel([{ text: '{"hook":"h","script":"s","onScreenText":["x"]}' }]);
  await createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: ok }).writeScript('x', () => undefined).catch(() => undefined);
  runs.push(ok);

  const all = runs.flatMap((m) => m.requests.map((req, i) => ({ kind: kindOf(req), req, prev: m.requests[i - 1] })));
  expect([...new Set(all.map((x) => x.kind))].filter((k) => k !== 'other').sort(), 'every AI task was captured')
    .toEqual(['applyNote', 'firstEdit', 'pickTakes', 'postKit', 'proofread', 'writeScript']);
  return all;
}

describe('AI context budget', () => {
  it('ai/context-budget.json matches what the tasks send', async () => {
    const all = await capture();
    const measured: Record<string, number> = {};
    const n: Record<string, number> = {};
    for (const { kind, req, prev } of all) {
      const key = `${kind} #${(n[kind] = (n[kind] ?? 0) + 1)}`;
      measured[`${key}, api (chars)`] = api(req);
      measured[`${key}, cli (chars)`] = cli(req, prev);
    }
    measured['all requests (count)'] = all.length;
    measured['all requests, api (chars)'] = all.reduce((t, x) => t + api(x.req), 0);
    measured['all requests, cli (chars)'] = all.reduce((t, x) => t + cli(x.req, x.prev), 0);
    measured['tools (count)'] = Math.max(...all.map((x) => x.req.tools.length));
    if (process.env.UPDATE_CONTEXT_BUDGET === '1') writeFileSync(FILE, JSON.stringify(measured, null, 2) + '\n');
    const pinned = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(pinned, 'ai/context-budget.json is out of date: run UPDATE_CONTEXT_BUDGET=1 npm test -w ai and commit it').toEqual(measured);
  });
});
