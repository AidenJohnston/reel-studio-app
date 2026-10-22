import { expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  AIError, approxOutputTimes, CompletionRequest, CompletionResponse, createAI, EditFact, EngineProgress, loadProject, ModelProvider, Project, saveProject,
} from '../src';
import { call, FakeHost, makeProject, tmpDir } from './helpers';

type Calls = ReturnType<typeof call>[];

/** The editor answers tool turns from `editor`; the checker (a JSON-only request) answers from `checker`. */
class Roles implements ModelProvider {
  readonly id = 'fake' as const;
  readonly supportsImages = true;
  editorRequests: CompletionRequest[] = [];
  checkerRequests: CompletionRequest[] = [];
  constructor(private readonly editor: (Calls | (() => Calls) | Error)[], private readonly checker: (string | Error)[]) {}
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const copy = structuredClone({ ...req, signal: undefined });
    if (req.jsonOnly) {
      this.checkerRequests.push(copy);
      const s = this.checker.shift();
      if (s === undefined) throw new Error('no checker reply scripted');
      if (s instanceof Error) throw s;
      return { text: s, toolCalls: [] };
    }
    this.editorRequests.push(copy);
    const s = this.editor.shift();
    if (s instanceof Error) throw s;
    const calls = typeof s === 'function' ? s() : s ?? [call('finish', { summary_for_user: 'Done.' })];
    return { text: '', toolCalls: calls.map((c, k) => ({ id: `c${this.editorRequests.length}_${k}`, name: c.name, args: c.args })) };
  }
}

const SCORES = { asked: 5, nothingElse: 4, hook: 4, pacing: 3, captions: 4, visuals: 3, sound: 4 };
const pass = (scores = SCORES) => JSON.stringify({ verdict: 'pass', fixes: [], scores });
const fix = (problem: string, request: string) => JSON.stringify({ verdict: 'fix', fixes: [{ problem, request }], scores: { ...SCORES, nothingElse: 2 } });

/** The engine's receipt facts for the two sections these tests change (engine project.net_changes). */
function netChanges(a: Project, b: Project): EditFact[] {
  const out: EditFact[] = [];
  if (JSON.stringify(a.cut.keep) !== JSON.stringify(b.cut.keep)) out.push({ kind: 'cut.keep', before: a.cut.keep, after: b.cut.keep });
  const sa = a.captions.style as Record<string, unknown>; const sb = b.captions.style as Record<string, unknown>;
  for (const k of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (sa[k] !== sb[k]) out.push({ kind: 'captions.style', field: k, before: sa[k], after: sb[k] });
  }
  return out;
}

/** A project already at version 1 with every word kept; renders report what changed since it. */
async function noteProject() {
  const { root, dir, transcript } = await makeProject();
  const p = await loadProject(dir);
  p.version = 1;
  p.cut.keep = [{ from: 'w0', to: 'w56' }];
  await saveProject(dir, p);
  const host = new FakeHost(root);
  const run = host.runEngine.bind(host);
  host.runEngine = async (command: string, args: string[], onProgress?: (pr: EngineProgress) => void) => {
    const r = await run(command, args, onProgress);
    if (command === 'render') r.receipt.facts = netChanges(p, await loadProject(dir));
    return r;
  };
  return { dir, host, transcript, size: p.captions.style.size };
}

const NOTE = 'cut my first take and the part about the fancy flour';
const CUT = call('set_cut', { keep: [{ from: 'w16', to: 'w26' }, { from: 'w35', to: 'w56' }] });
const text = (req: CompletionRequest) => req.messages.flatMap((m) => (m.role === 'user' ? m.content : [])).map((c) => (c.type === 'text' ? c.text : '')).join('\n');

it('fails if the checker can change the project, sees the editor conversation, or gets frames outside the changed moments', async () => {
  const { dir, host, transcript } = await noteProject();
  const model = new Roles([[CUT, call('render_draft')], [call('finish', { summary_for_user: 'I cut the flour part.' })]], [pass()]);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  await ai.applyNote(dir, NOTE, () => {});
  expect(model.checkerRequests).toHaveLength(1);
  const req = model.checkerRequests[0];
  expect(req.tools).toEqual([]);
  expect(req.messages).toHaveLength(1);
  const seen = text(req);
  expect(seen).toContain(NOTE);
  expect(seen).toContain('cut.keep');
  expect(seen).toContain('twenty bucks on a fancy flour');
  expect(seen).not.toContain('I cut the flour part.');
  const times = approxOutputTimes(transcript, [{ from: 'w16', to: 'w26' }, { from: 'w35', to: 'w56' }], (await loadProject(dir)).cut.gapCap);
  const mid = (id: string) => Math.round(((times.get(id)!.s + times.get(id)!.e) / 2) * 100) / 100;
  const frames = host.calls.filter((c) => c.command === 'frames');
  expect(frames).toHaveLength(1);
  expect(frames[0].args[frames[0].args.indexOf('--times') + 1]).toBe([mid('w16'), mid('w35')].join(','));
  expect((req.messages[0] as { content: { type: string }[] }).content.filter((c) => c.type === 'image')).toHaveLength(2);
});

it("fails if a passing check's rubric scores are not stored with the version it checked", async () => {
  const { dir, host } = await noteProject();
  const model = new Roles([[CUT, call('render_draft')], [call('finish', { summary_for_user: 'I cut the flour part.' })]], [pass()]);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  const r = await ai.applyNote(dir, NOTE, () => {});
  expect(r.version).toBe(2);
  expect(r.summary).toBe('I cut the flour part.');
  const stored = JSON.parse(await fsp.readFile(path.join(dir, 'versions', 'v2', 'check.json'), 'utf8'));
  expect(stored).toMatchObject({ verdict: 'pass', repairs: 0, rounds: [{ verdict: 'pass', fixes: [], scores: SCORES }] });
  expect(stored.cost.tokens).toBeGreaterThan(0);
});

it('fails if a fix request does not reach the editor or the re-check looks at the stale candidate', async () => {
  const { dir, host, size } = await noteProject();
  const model = new Roles([
    [CUT, call('set_caption_style', { size: 84 }), call('render_draft')],
    [call('finish', { summary_for_user: 'I cut the flour part and made the captions smaller.' })],
    [call('set_caption_style', { size })],
    [call('finish', { summary_for_user: 'I cut your first take and the flour part.' })],
  ], [fix('The captions got smaller, which you did not ask for.', `Set caption size back to ${size}.`), pass()]);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  const r = await ai.applyNote(dir, NOTE, () => {});
  const repairTask = text(model.editorRequests[2]);
  expect(repairTask).toContain(`Set caption size back to ${size}.`);
  expect(repairTask).toContain(NOTE);
  expect(model.checkerRequests).toHaveLength(2);
  expect(text(model.checkerRequests[0])).toContain('captions.style');
  expect(text(model.checkerRequests[1])).not.toContain('captions.style');
  expect((await loadProject(dir)).captions.style.size).toBe(size);
  expect(r.summary).toBe('I cut your first take and the flour part.');
  expect(r.check).toMatchObject({ verdict: 'pass', repairs: 1 });
});

it('fails if more than two repair rounds run or an unresolved disagreement is reported as success', async () => {
  const { dir, host } = await noteProject();
  const sizes = [90, 95, 100];
  const model = new Roles([
    [CUT, call('render_draft')],
    [call('finish', { summary_for_user: 'I cut the flour part.' })],
    ...sizes.flatMap((s) => [[call('set_caption_style', { size: s })], [call('finish', { summary_for_user: 'I cut the flour part.' })]]),
  ], [0, 1, 2, 3].map(() => fix('The video still opens on the flour line.', 'Cut w27 to w34.')));
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  const r = await ai.applyNote(dir, NOTE, () => {});
  expect(model.checkerRequests).toHaveLength(3);
  expect(r.check).toMatchObject({ verdict: 'unresolved', repairs: 2 });
  expect(r.summary).toContain('The video still opens on the flour line.');
  expect(r.summary).not.toBe('I cut the flour part.');
  expect(host.calls.filter((c) => c.command === 'render' && !c.args.includes('--draft'))).toHaveLength(1);
  const stored = JSON.parse(await fsp.readFile(path.join(dir, 'versions', `v${r.version}`, 'check.json'), 'utf8'));
  expect(stored.verdict).toBe('unresolved');
});

it("fails if the editor declining a fix is reported as success or its reason replaces the note's summary", async () => {
  const { dir, host } = await noteProject();
  const model = new Roles([
    [CUT, call('render_draft')],
    [call('finish', { summary_for_user: 'I cut the flour part.' })],
    [call('finish', { summary_for_user: 'Putting the first take back would undo the note.' })],
  ], [fix('Your first take is gone.', 'Bring back w0 to w15.'), pass()]);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  const r = await ai.applyNote(dir, NOTE, () => {});
  expect(r.check).toMatchObject({ verdict: 'unresolved', repairs: 1 });
  expect(r.summary).toMatch(/^I cut the flour part\. /);
  expect(r.summary).toContain('Your first take is gone.');
});

it('fails if an unreadable checker reply blocks the version or is recorded as a pass', async () => {
  const { dir, host } = await noteProject();
  const model = new Roles([[CUT, call('render_draft')], [call('finish', { summary_for_user: 'I cut the flour part.' })]],
    ['looks good to me', '{"verdict": "pass"}']);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  const r = await ai.applyNote(dir, NOTE, () => {});
  expect(r.version).toBe(2);
  expect(r.summary).toBe('I cut the flour part.');
  expect(r.check?.verdict).toBe('error');
  expect(JSON.parse(await fsp.readFile(path.join(dir, 'versions', 'v2', 'check.json'), 'utf8')).verdict).toBe('error');
});

it('fails if a repair run that stops with an AI error loses the checked edit or keeps half a repair', async () => {
  const { dir, host, size } = await noteProject();
  const model = new Roles([
    [CUT, call('render_draft')],
    [call('finish', { summary_for_user: 'I cut the flour part.' })],
    [call('set_caption_style', { size: 90 })],
    new AIError('cli_limited', 'The AI hit its usage limit. Try again later.'),
  ], [fix('The captions are hard to read.', 'Make the captions bigger.')]);
  const ai = createAI({ host, settingsDir: tmpDir('settings '), providerOverride: model });
  const r = await ai.applyNote(dir, NOTE, () => {});
  const p = await loadProject(dir);
  expect(p.cut.keep).toEqual([{ from: 'w16', to: 'w26' }, { from: 'w35', to: 'w56' }]);
  expect(p.captions.style.size).toBe(size);
  expect(r.version).toBe(2);
  expect(r.check).toMatchObject({ verdict: 'unresolved', repairs: 1 });
  expect(r.summary).toContain('The captions are hard to read.');
});
