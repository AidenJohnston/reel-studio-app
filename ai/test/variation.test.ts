import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, executeTool, loadProject, newToolState, StyleStore, ToolContext } from '../src';
import { saveProject } from '../src/project';
import { FakeHost, ScriptedModel, call, firstVersion, makeProject, tmpDir } from './helpers';

class RealVariantHost extends FakeHost {
  override async runEngine(command: string, args: string[]) {
    if (command !== 'make-variant') return super.runEngine(command, args);
    this.calls.push({ command, args });
    const { stdout } = await promisify(execFile)('uv', ['run', '--no-project', '--python', '3.11',
      '--with-editable', './engine[dev]', 'python', '-m', 'reelengine', command, ...args],
      { cwd: path.resolve(__dirname, '../..') });
    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line));
    const done = messages.find((m) => m.event === 'done');
    if (!done) throw new Error(stdout);
    return done.result;
  }
}

async function setup() {
  const { root, dir } = await makeProject();
  const p = await loadProject(dir);
  p.cutStyle = { preset: 'standard', seed: 42 };
  p.cut.keep = [{ from: 'w0', to: 'w8' }, { from: 'w27', to: 'w56' }];
  await saveProject(dir, p);
  const ctx: ToolContext = { projectDir: dir, host: new RealVariantHost(root),
    style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: false };
  return { ctx, dir };
}

it.each([
  { variable: 'seed' },
  { variable: 'hook', hook: { from: 'w16', to: 'w26' } },
  { variable: 'cover', cover: { atSourceTime: 2, source: 's1', text: 'Bread' } },
  { variable: 'caption', caption: 'Try a slower rise' },
  { variable: 'brightness', brightness: -8 },
])('saves and logs a $variable trial through the engine', async (args) => {
  const { ctx, dir } = await setup();
  const result = await executeTool(ctx, 'make_variant', args);
  expect(result.isError, result.content).toBe(false);
  const output = JSON.parse(result.content);
  expect(output.trial.variable).toBe(args.variable);
  expect(await loadProject(dir)).toEqual(ctx.project);
  expect(JSON.parse(await fsp.readFile(path.join(dir, 'trials.json'), 'utf8'))).toEqual([output.trial]);
  expect(ctx.state.changed.has(args.variable === 'caption' ? 'post' : args.variable)).toBe(true);
});

// fails if a trial inside a note writes project.json instead of the note's copy: the note then finds
// project.json changed under it and is not saved
it('saves a note whose editor made a trial', async () => {
  const { root, dir } = await makeProject();
  const host = new RealVariantHost(root);
  await firstVersion(dir, host);
  const model = new ScriptedModel([
    { toolCalls: [call('make_variant', { variable: 'caption', caption: 'Try a slower rise' })] },
    { toolCalls: [call('finish', { summary_for_user: 'I made a trial with a new post line.' })] },
  ]);
  await createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model })
    .applyNote(dir, 'make a trial with a different post line', () => undefined);
  const trial = host.calls.find((c) => c.command === 'make-variant')!;
  expect(trial.args[trial.args.indexOf('--project-file') + 1]).toMatch(/[\\/]work[\\/]notes[\\/][^\\/]+[\\/]edit\.json$/);
  expect((await loadProject(dir)).post.caption).toBe('Try a slower rise');
  const trials = JSON.parse(await fsp.readFile(path.join(dir, 'trials.json'), 'utf8'));
  expect(trials).toMatchObject([{ variable: 'caption', to: 'Try a slower rise' }]);
});

it('renders a fresh preview after a seed change', async () => {
  const { ctx } = await setup();
  const host = new FakeHost(ctx.host.reelStudioRoot());
  ctx.host = host;
  await executeTool(ctx, 'render_draft', {});
  await executeTool(ctx, 'set_cut_style', { preset: 'standard', seed: 43 });
  const result = JSON.parse((await executeTool(ctx, 'render_draft', {})).content);
  expect(result.skipped).toBeUndefined();
  expect(host.calls.filter((c) => c.command === 'render')).toHaveLength(2);
});

it('preserves editor-supplied accent ties for seeded selection', async () => {
  const { ctx, dir } = await setup();
  const result = await executeTool(ctx, 'set_zoom', { zooms: [
    { anchor: { from: 'w27', to: 'w34' }, scale: 1.15, accentGroup: 'payoff' },
    { anchor: { from: 'w35', to: 'w41' }, scale: 1.15, accentGroup: 'payoff' },
  ] });
  expect(result.isError, result.content).toBe(false);
  expect((await loadProject(dir)).zooms.map((z) => z.accentGroup)).toEqual(['payoff', 'payoff']);
});
