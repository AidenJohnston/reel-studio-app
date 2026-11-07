import { describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { applyNote, EditorDeps } from '../src/editor';
import { Harness, HarnessRun } from '../src/harness';
import { ClaudeCodeHarness } from '../src/mcp/claudeCode';
import { CodexHarness } from '../src/mcp/codex';
import { Prompts } from '../src/prompts';
import { StyleStore } from '../src/style';
import { executeTool } from '../src/tools';
import { loadProject } from '../src/project';
import { FakeHost, firstVersion, makeProject, ScriptedModel, tmpDir } from './helpers';

const pass = { ok: true, findings: [] };
const finding = { problem: 'The pauses still feel too short.', request: 'Set the gap cap to 0.5 seconds.' };

function scripted(id: Harness['id'], turns: Array<(o: HarnessRun) => Promise<void>>): Harness {
  return {
    id, supportsImages: true,
    async run(o) {
      const turn = turns.shift();
      if (!turn) throw new Error(`Unexpected ${id} run`);
      await turn(o);
      return { finished: o.ctx.state.finished, stoppedBy: o.ctx.state.finished ? 'finish' : 'no_tools', steps: 1, tokens: 0, messages: [] };
    },
  };
}

async function finishEdit(o: HarnessRun, gap: number) {
  expect((await executeTool(o.ctx, 'set_gap_cap', { seconds: gap })).isError).toBe(false);
  await executeTool(o.ctx, 'finish', { summary_for_user: `I set the pauses to ${gap} seconds.` });
}

async function report(o: HarnessRun, value: unknown) {
  const tool = o.customTools?.find((t) => t.schema.name === 'report_check');
  if (!tool) throw new Error('The checker needs report_check');
  return tool.execute(value);
}

async function setup(editor: Harness, checker?: Harness) {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  await firstVersion(dir, host);
  const before = await fsp.readFile(path.join(dir, 'project.json'));
  const deps: EditorDeps = { host, prompts: new Prompts(), style: new StyleStore(() => root), harness: editor, ...(checker ? { checkerHarness: checker } : {}), fastNotes: false };
  const run = (signal?: AbortSignal) => applyNote(deps, new ScriptedModel([]), dir, 'Give the pauses more room.', () => undefined, signal, { checkEdit: true });
  return { dir, before, run, host, deps };
}

describe('checking a note with the other harness', () => {
  it.each([['claude-code', 'codex'], ['codex', 'claude-code']] as const)('checks the private %s edit with %s before saving', async (editorId, checkerId) => {
    let checked = false;
    const temp = tmpDir('checker cli ');
    const scenario = path.join(temp, 'scenario.json');
    await fsp.writeFile(scenario, JSON.stringify({
      pidFile: path.join(temp, 'pids.json'), inbox: path.join(temp, 'inbox.txt'),
      turns: [[{ name: 'set_gap_cap', args: { seconds: 0.9 } }, { name: 'report_check', args: pass }]],
    }));
    const cliOptions = { bin: process.execPath, binArgs: [path.join(__dirname, checkerId === 'codex' ? 'fake-codex-mcp.js' : 'fake-claude-mcp.js'), '--scenario', scenario], timeoutMs: 5000 };
    const cli = checkerId === 'codex' ? new CodexHarness(cliOptions) : new ClaudeCodeHarness(cliOptions);
    const checker = scripted(checkerId, [async (o) => {
      expect(o.tools).toEqual(['get_project', 'get_transcript', 'look_at_frames', 'report_check']);
      expect(o.ctx.state.changed.size).toBe(0);
      expect((await loadProject(o.ctx.projectDir)).cut.gapCap).toBe(0.25);
      expect((await loadProject(o.ctx.projectDir, o.ctx.note!.file)).cut.gapCap).toBe(0.4);
      expect(o.task).toContain('Give the pauses more room.');
      expect(o.task).toContain('0.25');
      expect((await cli.run(o)).stoppedBy).toBe('finish');
      checked = true;
    }]);
    const s = await setup(scripted(editorId, [(o) => finishEdit(o, 0.4)]), checker);
    const result = await s.run();
    expect(checked).toBe(true);
    expect(result.version).toBe(2);
    expect((await loadProject(s.dir)).cut.gapCap).toBe(0.4);
    await fsp.rm(temp, { recursive: true, force: true });
  });

  it('returns findings to the editor and checks its repair before saving', async () => {
    const seen: number[] = [];
    const check = async (o: HarnessRun, value: unknown) => {
      seen.push((await loadProject(o.ctx.projectDir, o.ctx.note!.file)).cut.gapCap!);
      await report(o, value);
    };
    const s = await setup(scripted('claude-code', [
      (o) => finishEdit(o, 0.4),
      async (o) => { expect(o.task).toContain(finding.request); await finishEdit(o, 0.5); },
    ]), scripted('codex', [(o) => check(o, { ok: false, findings: [finding] }), (o) => check(o, pass)]));
    const result = await s.run();
    expect(seen).toEqual([0.4, 0.5]);
    expect((await loadProject(s.dir)).cut.gapCap).toBe(0.5);
    expect(result.summary).toContain('0.5 seconds');
    expect((await loadProject(s.dir)).notes?.at(-1)?.reply).toBe(result.summary);
  });

  it('lets the checker inspect frames from the current private preview', async () => {
    const s = await setup(scripted('claude-code', [(o) => finishEdit(o, 0.4)]), scripted('codex', [async (o) => {
      const frames = await executeTool(o.ctx, 'look_at_frames', { times: [1] });
      expect(frames.isError).toBe(false);
      expect(frames.images).toHaveLength(1);
      await report(o, pass);
    }]));
    expect((await s.run()).version).toBe(2);
  });

  it('gives the checker the candidate render failures and warnings', async () => {
    const s = await setup(scripted('claude-code', [(o) => finishEdit(o, 0.4)]), scripted('codex', [async (o) => {
      expect(o.task).toContain('caption overflow at 1.0 seconds');
      expect(o.task).toContain('overlay extends beyond the frame');
      await report(o, pass);
    }]));
    s.host.renderExtra = { verify: { ok: false, fails: ['caption overflow at 1.0 seconds'] }, warnings: ['overlay extends beyond the frame'] };
    expect((await s.run()).version).toBe(2);
  });

  it('keeps one token budget across editing and checking', async () => {
    const temp = tmpDir('checker budget ');
    const editorFile = path.join(temp, 'editor.json');
    const checkerFile = path.join(temp, 'checker.json');
    for (const [file, turns] of [
      [editorFile, [[{ name: 'set_gap_cap', args: { seconds: 0.4 } }, { name: 'finish', args: { summary_for_user: 'Done.' } }]]],
      [checkerFile, [[{ name: 'report_check', args: pass }]]],
    ] as const) await fsp.writeFile(file, JSON.stringify({ turns, pidFile: file + '.pids', inbox: file + '.inbox' }));
    const editor = new ClaudeCodeHarness({ bin: process.execPath, binArgs: [path.join(__dirname, 'fake-claude-mcp.js'), '--scenario', editorFile] });
    const checker = new CodexHarness({ bin: process.execPath, binArgs: [path.join(__dirname, 'fake-codex-mcp.js'), '--scenario', checkerFile] });
    const s = await setup(editor, checker);
    s.deps.tokenBudget = 20;
    await expect(s.run()).rejects.toMatchObject({ code: 'token_budget' });
    expect(await fsp.readFile(path.join(s.dir, 'project.json'))).toEqual(s.before);
  });

  it('rejects an edit if the checker ends without a verdict', async () => {
    const s = await setup(scripted('claude-code', [(o) => finishEdit(o, 0.4)]), scripted('codex', [async () => undefined]));
    await expect(s.run()).rejects.toMatchObject({ code: 'check_failed' });
    expect(await fsp.readFile(path.join(s.dir, 'project.json'))).toEqual(s.before);
    expect(await fsp.readdir(path.join(s.dir, 'work', 'notes'))).toEqual([]);
  });

  it('rejects contradictory verdicts and lets the checker correct them', async () => {
    let corrected = false;
    const s = await setup(scripted('claude-code', [(o) => finishEdit(o, 0.4)]), scripted('codex', [async (o) => {
      expect((await report(o, { ok: true, findings: [finding] })).isError).toBe(true);
      expect(o.ctx.state.finished).toBeNull();
      expect((await report(o, pass)).isError).toBe(false);
      corrected = true;
    }]));
    expect((await s.run()).version).toBe(2);
    expect(corrected).toBe(true);
  });

  it('stops after two repairs and tells the creator which findings remain', async () => {
    const reject = async (o: HarnessRun) => { await report(o, { ok: false, findings: [finding] }); };
    const s = await setup(scripted('claude-code', [(o) => finishEdit(o, 0.4), (o) => finishEdit(o, 0.45), (o) => finishEdit(o, 0.5)]),
      scripted('codex', [reject, reject, reject]));
    const result = await s.run();
    expect(result.summary).toContain(finding.problem);
    expect((await loadProject(s.dir)).notes?.at(-1)?.reply).toBe(result.summary);
    expect((await loadProject(s.dir)).cut.gapCap).toBe(0.5);
  });

  it('with no other app signed in to check it, the checker model reviews the note instead of failing it', async () => {
    const s = await setup(scripted('claude-code', [(o) => finishEdit(o, 0.4)]));
    let asked = 0;
    const scores = { asked: 5, nothingElse: 4, hook: 4, pacing: 3, captions: 4, visuals: 3, sound: 4 };
    s.deps.checker = {
      id: 'fake', supportsImages: true,
      async complete() {
        asked++;
        return { text: JSON.stringify({ verdict: 'pass', fixes: [], scores }), toolCalls: [], usage: { input: 1, output: 1 } };
      },
    };
    const r = await s.run();
    expect(r.version).toBe(2);
    expect(asked).toBeGreaterThan(0);
    expect((await loadProject(s.dir)).cut.gapCap).toBe(0.4);
  });

  it('discards a repair when its checker cannot finish', async () => {
    const s = await setup(scripted('claude-code', [(o) => finishEdit(o, 0.4), (o) => finishEdit(o, 0.5)]),
      scripted('codex', [async (o) => { await report(o, { ok: false, findings: [finding] }); }, async () => { throw new Error('checker disconnected'); }]));
    await expect(s.run()).rejects.toMatchObject({ code: 'check_failed' });
    expect(await fsp.readFile(path.join(s.dir, 'project.json'))).toEqual(s.before);
  });
});
