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
    [keep[0], { ...keep[1], join: { transition: 'match', frames: 6 } }],
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
  // fails if a saved match cut is refused without saying why
  const match = { ...p, cut: { ...p.cut, keep: [p.cut.keep[0], { ...p.cut.keep[1], join: { transition: 'match', frames: 6 } }] } };
  expect(validateProject(match).join()).toMatch(/match cuts are not available: the engine can't tell whether two shots match/);
  expect(validateProject(p)).toEqual([]);
});
