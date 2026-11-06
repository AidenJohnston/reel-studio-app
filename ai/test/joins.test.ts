import { expect, it } from 'vitest';
import { executeTool, loadProject, newToolState, StyleStore, ToolContext } from '../src';
import { validateProject } from '../src/project';
import { FakeHost, makeProject } from './helpers';

it('set_cut saves joins, rejects invalid joins without writing, and removes them on a hard recut', async () => {
  const { root, dir } = await makeProject();
  const ctx: ToolContext = {
    projectDir: dir, host: new FakeHost(root), style: new StyleStore(() => root),
    emit: () => {}, state: newToolState(), supportsImages: false,
  };
  const keep = [
    { from: 'w0', to: 'w8' },
    { from: 'w16', to: 'w26', join: { transition: 'j', frames: 6 } },
    { from: 'w27', to: 'w34', join: { transition: 'l', frames: 12 } },
    { from: 'w35', to: 'w41', join: { transition: 'smash', frames: 0 } },
  ];
  const result = await executeTool(ctx, 'set_cut', { keep });
  expect(result.isError, result.content).toBe(false);
  expect((await loadProject(dir)).cut.keep).toEqual(keep);
  for (const bad of [
    [{ ...keep[0], join: { transition: 'j', frames: 6 } }, keep[1]],
    [keep[0], { ...keep[1], join: { transition: 'dissolve', frames: 6 } }],
    [keep[0], { ...keep[1], join: { transition: 'j', frames: -1 } }],
    [keep[0], { ...keep[1], join: { transition: 'l', frames: 1.5 } }],
  ]) {
    expect((await executeTool(ctx, 'set_cut', { keep: bad })).isError).toBe(true);
    expect((await loadProject(dir)).cut.keep).toEqual(keep);
  }
  const hard = keep.map(({ from, to }) => ({ from, to }));
  expect((await executeTool(ctx, 'set_cut', { keep: hard })).isError).toBe(false);
  expect((await loadProject(dir)).cut.keep).toEqual(hard);
});

it('project loading validates persisted joins without requiring a transcript', async () => {
  const { dir } = await makeProject();
  const p = await loadProject(dir);
  p.cut.keep = [{ from: 'w0', to: 'w8' }, { from: 'w16', to: 'w26' }];
  const malformed = {
    ...p,
    cut: { ...p.cut, keep: [p.cut.keep[0], { ...p.cut.keep[1], join: { transition: 'j', frames: 1.5 } }] },
  };
  expect(validateProject(malformed).join()).toMatch(/frames.*integer/);
  // a saved match is valid: whether it lines up is the engine's to say when it renders
  const match = { ...p, cut: { ...p.cut, keep: [p.cut.keep[0], { ...p.cut.keep[1], join: { transition: 'match', frames: 0 } }] } };
  expect(validateProject(match)).toEqual([]);
  const unknown = { ...p, cut: { ...p.cut, keep: [p.cut.keep[0], { ...p.cut.keep[1], join: { transition: 'dissolve', frames: 0 } }] } };
  expect(validateProject(unknown).join()).toMatch(/transition must be hard, j, l, smash, match, flash or action/);
  expect(validateProject(p)).toEqual([]);
});

async function joinCtx() {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  const ctx: ToolContext = { projectDir: dir, host, style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: false };
  return { ctx, host, dir };
}

it('set_cut keeps a match the engine says lines up, and refuses one that does not without changing the cut', async () => {
  const { ctx, host, dir } = await joinCtx();
  host.matchable.add('w16');
  const lines = [{ from: 'w0', to: 'w8' }, { from: 'w16', to: 'w26', join: { transition: 'match', frames: 0 } }];
  const ok = await executeTool(ctx, 'set_cut', { keep: lines });
  expect(ok.isError, ok.content).toBe(false);
  expect((await loadProject(dir)).cut.keep).toEqual(lines);
  // the engine was asked about the cut being set, not the saved one
  const asked = host.calls.find((c) => c.command === 'match-joins')!;
  expect(JSON.parse(asked.args[asked.args.indexOf('--keep') + 1])).toEqual(lines);
  expect(asked.args).not.toContain('--every');

  const moves = [{ from: 'w0', to: 'w8' }, { from: 'w27', to: 'w34', join: { transition: 'match', frames: 0 } }];
  const refused = await executeTool(ctx, 'set_cut', { keep: moves });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toMatch(/keep\[1\]: no match cut here, the speaker moves too much across the cut.*find_match_cuts/);
  expect((await loadProject(dir)).cut.keep).toEqual(lines);
});

it('a cut with no match never asks the engine to compare frames', async () => {
  const { ctx, host } = await joinCtx();
  await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w8' }, { from: 'w16', to: 'w26', join: { transition: 'smash', frames: 0 } }] });
  expect(host.calls.some((c) => c.command === 'match-joins')).toBe(false);
});

it('find_match_cuts asks about every join and reports which line up', async () => {
  const { ctx, host } = await joinCtx();
  await executeTool(ctx, 'set_cut', { keep: [{ from: 'w0', to: 'w8' }, { from: 'w16', to: 'w26' }, { from: 'w27', to: 'w34' }] });
  host.matchable.add('w27');
  const r = await executeTool(ctx, 'find_match_cuts', {});
  expect(r.isError, r.content).toBe(false);
  expect(JSON.parse(r.content as string).joins).toEqual([
    { keep: 1, at: 2, matched: false, why: 'the speaker moves too much across the cut' },
    { keep: 2, at: 4, matched: true },
  ]);
  expect(host.calls.find((c) => c.command === 'match-joins')!.args).toContain('--every');
});
