// Pins what each AI task sends the model (ai/context-budget.json): the real requests, captured by running the editor
// against a fake model and a fixed tiny project, so the user's own data is the same every run. Two shapes: "api"
// (system, messages and tool schemas as JSON) and "cli" (Claude Code's --system-prompt plus renderConversation()).
// After an intended change: UPDATE_CONTEXT_BUDGET=1 npm test -w ai, and commit the file.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import type { CompletionRequest } from '../src/types';
import { createAI, pickTakes } from '../src';
import { ClaudeCliProvider, renderConversation } from '../src/providers/cli';
import { Prompts } from '../src/prompts';
import { FakeHost, ScriptedModel, call, makeProject, tmpDir } from './helpers';

const FILE = join(__dirname, '..', 'context-budget.json');
const LINES = ['Here is the one thing about bread.', 'Wait for it to rise.'];
const claudeSystem = (() => {
  const args = (new ClaudeCliProvider() as unknown as { args(): string[] }).args();
  return args[args.indexOf('--system-prompt') + 1];
})();

const api = (r: CompletionRequest) => r.system.length + JSON.stringify(r.messages).length + JSON.stringify(r.tools).length;
const cli = (r: CompletionRequest) => claudeSystem.length + renderConversation(r).text.length;
const firstUserText = (r: CompletionRequest) => {
  const m = r.messages.find((x) => x.role === 'user');
  return m && m.role === 'user' ? m.content.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n') : '';
};

/** Every request the model gets, in order, tagged with the task it belongs to ("other" if none matches). */
async function capture(): Promise<{ kind: string; req: CompletionRequest }[]> {
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

  const { root, dir, transcript } = await makeProject({ lines: LINES });
  // One word the speech model was unsure of, and a cut that keeps it, so the caption proofread runs too.
  transcript.words[6] = { ...transcript.words[6], p: 0.5 } as typeof transcript.words[6];
  await fsp.writeFile(join(dir, 'work', 'transcript.json'), JSON.stringify(transcript));
  const model = new ScriptedModel([{ toolCalls: [call('set_cut', { keep: [{ from: 'w0', to: `w${transcript.words.length - 1}` }] })] }]);
  const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: model });
  await ai.firstEdit(dir, () => undefined).catch(() => undefined);
  await ai.applyNote(dir, 'x', () => undefined).catch(() => undefined);
  await ai.writeScript('x', () => undefined).catch(() => undefined);
  await pickTakes(transcript, model).catch(() => undefined);
  const all = model.requests.map((req) => ({ kind: kindOf(req), req }));
  expect([...new Set(all.map((x) => x.kind))].filter((k) => k !== 'other').sort(), 'every AI task was captured')
    .toEqual(['applyNote', 'firstEdit', 'pickTakes', 'postKit', 'proofread', 'writeScript']);
  return all;
}

describe('AI context budget', () => {
  it('ai/context-budget.json matches what the tasks send', async () => {
    const all = await capture();
    // Every request is pinned (retries and follow-up turns included), plus totals, so a longer or an extra request of
    // any kind raises a number the workflow compares with main.
    const measured: Record<string, number> = {};
    const n: Record<string, number> = {};
    for (const { kind, req } of all) {
      const key = `${kind} #${(n[kind] = (n[kind] ?? 0) + 1)}`;
      measured[`${key}, api (chars)`] = api(req);
      measured[`${key}, cli (chars)`] = cli(req);
    }
    measured['all requests (count)'] = all.length;
    measured['all requests, api (chars)'] = all.reduce((t, x) => t + api(x.req), 0);
    measured['all requests, cli (chars)'] = all.reduce((t, x) => t + cli(x.req), 0);
    measured['tools (count)'] = Math.max(...all.map((x) => x.req.tools.length));
    if (process.env.UPDATE_CONTEXT_BUDGET === '1') writeFileSync(FILE, JSON.stringify(measured, null, 2) + '\n');
    const pinned = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(pinned, 'ai/context-budget.json is out of date: run UPDATE_CONTEXT_BUDGET=1 npm test -w ai and commit it').toEqual(measured);
  });
});
