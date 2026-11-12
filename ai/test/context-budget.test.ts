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

async function capture(): Promise<Record<string, CompletionRequest>> {
  const prompts = new Prompts(join(__dirname, '..', 'prompts'));
  const starts = (name: 'firstEdit' | 'applyNote' | 'proofread' | 'writeScript' | 'pickTakes', text: string) =>
    text.startsWith(prompts.render(name).slice(0, 60));
  const seen: Record<string, CompletionRequest> = {};
  const take = (r: CompletionRequest) => {
    const task = firstUserText(r);
    const kind = starts('writeScript', r.system) ? 'writeScript'
      : starts('pickTakes', r.system) ? 'pickTakes'
      : task.startsWith('The edit of this video is saved') ? 'postKit'
      : starts('proofread', task) ? 'proofread'
      : starts('applyNote', task) ? 'applyNote'
      : starts('firstEdit', task) ? 'firstEdit' : null;
    if (kind && !seen[kind]) seen[kind] = r;
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
  model.requests.forEach(take);
  expect(Object.keys(seen).sort(), 'every AI task was captured').toEqual(['applyNote', 'firstEdit', 'pickTakes', 'postKit', 'proofread', 'writeScript']);
  return seen;
}

describe('AI context budget', () => {
  it('ai/context-budget.json matches what the tasks send', async () => {
    const seen = await capture();
    const measured: Record<string, number> = {};
    for (const kind of Object.keys(seen).sort()) {
      measured[`${kind}, api (chars)`] = api(seen[kind]);
      measured[`${kind}, cli (chars)`] = cli(seen[kind]);
    }
    measured['tools (count)'] = seen.firstEdit.tools.length;
    if (process.env.UPDATE_CONTEXT_BUDGET === '1') writeFileSync(FILE, JSON.stringify(measured, null, 2) + '\n');
    const pinned = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(pinned, 'ai/context-budget.json is out of date: run UPDATE_CONTEXT_BUDGET=1 npm test -w ai and commit it').toEqual(measured);
  });
});
