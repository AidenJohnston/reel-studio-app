// The Plan document (plan.ts, docs/plan.md): its shape, the creator's changes, the flow (the AI proposes, the
// first edit builds only approved rows, notes keep the rows in step), markdown round trips and determinism.
import { describe, expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, Plan, PlanRow, Project, changePlan, emptyPlan, fromMarkdown, planProblems, syncPlan, toMarkdown, updatePlan, withDefaults } from '../src';
import { aiUpdateRow, followBroll, followHandEdit, proposeRows, readPlan } from '../src/plan';
import { PLAN_TOOLS } from '../src/planAgent';
import { FakeHost, ScriptedModel, call, firstVersion, makeProject, makeTranscript, SAMPLE_LINES, tinyPng, tmpDir } from './helpers';

const NOW = '2026-11-12T22:00:00.000Z';
const row = (r: Partial<PlanRow> & Pick<PlanRow, 'id'>): PlanRow => ({ visual: 'a picture', source: 'card', status: 'proposed', ...r });
/** syncPlan and the tools change rows in place: every plan gets its own copies. */
const withRows = (broll: PlanRow[], extra: Partial<Plan> = {}): Plan => structuredClone({ ...emptyPlan(), broll, ...extra });

/** A bread project with a library picture, a downloaded one, and `plan` saved in project.json. */
async function planned(plan: Plan) {
  const { root, dir } = await makeProject();
  await fsp.writeFile(path.join(root, 'Library', 'Images', 'flour.png'), tinyPng());
  await fsp.mkdir(path.join(dir, 'work', 'assets'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'work', 'assets', 'brick.png'), tinyPng([90, 40, 20]));
  const pj = path.join(dir, 'project.json');
  await fsp.writeFile(pj, JSON.stringify({ ...JSON.parse(await fsp.readFile(pj, 'utf8')), plan }, null, 2));
  const read = async (): Promise<Project> => JSON.parse(await fsp.readFile(pj, 'utf8'));
  return { root, dir, host: new FakeHost(root), settingsDir: tmpDir('settings '), read };
}

const KEEP = call('set_cut', { keep: [{ from: 'w16', to: 'w56' }] });
const finish = (s = 'Done.') => call('finish', { summary_for_user: s });
const toolNames = (m: ScriptedModel) => m.requests[0].tools.map((t) => t.name);
/** Each request repeats the conversation so far: every tool result once, by call id. */
const toolResults = (m: ScriptedModel, name: string) => [...new Map(m.requests.flatMap((r) => r.messages)
  .flatMap((x) => (x.role === 'tool' ? x.results : [])).filter((r) => r.name === name).map((r) => [r.callId, r])).values()];
const toolResult = (m: ScriptedModel, name: string) => toolResults(m, name)[0];

const FLOUR = row({ id: 'p1', words: 'fancy flour', visual: 'their bag of fancy flour', source: 'library', asset: 'Library/Images/flour.png', status: 'approved' });
const HOURS = row({ id: 'p2', words: 'eighteen hours', visual: '18 HOURS', source: 'card' });
const BRICK = row({ id: 'p3', words: 'a brick', visual: 'a brick-hard loaf', source: 'fetched', asset: 'work/assets/brick.png', status: 'rejected' });

describe('the plan\'s shape', () => {
  it('a full plan is valid', () => {
    const plan = withRows([FLOUR, HOURS, BRICK], { beats: [{ line: 'Nobody tells you.', visual: 'face', sound: 'piano' }], music: 'warm acoustic', cover: 'the brick', buildProposed: true });
    expect(planProblems(plan)).toEqual([]);
  });

  it.each([
    ['a status', { status: 'maybe' }, 'status'],
    ['a source', { source: 'stock' }, 'source'],
    ['an id', { id: 'b1' }, 'id'],
    ['a hold', { hold: 99 }, 'hold'],
    ['a file outside the project', { asset: '../secret.png' }, 'asset'],
    ['an anchor', { anchor: { from: 'w1' } }, 'anchor'],
    ['a treatment', { treatment: 'hologram' }, 'treatment'],
  ])('refuses %s it does not know', (_what, bad, field) => {
    const problems = planProblems(withRows([{ ...FLOUR, ...bad } as PlanRow]));
    expect(problems.join(' ')).toContain(field);
  });

  it('refuses two rows with one id', () => {
    expect(planProblems(withRows([FLOUR, { ...HOURS, id: 'p1' }]))).toEqual(['duplicate plan row id p1']);
  });
});

describe('the creator\'s changes', () => {
  const draft = { hook: 'Nobody tells you the hardest part.', script: 'Nobody tells you the hardest part.\nIt is waiting.', onScreenText: ['Bread takes time'] };

  it('keeps the AI\'s draft beside the rewrite, and locking splits the script into beats', () => {
    let plan = changePlan(undefined, { kind: 'script', draft }, NOW);
    plan = changePlan(plan, { kind: 'details', beats: [{ line: 'It is waiting.', visual: 'the dough rising' }] }, NOW);
    plan = changePlan(plan, { kind: 'script', rewrite: 'Nobody warns you about this.\r\nIt is waiting.\n' }, NOW);
    plan = changePlan(plan, { kind: 'lock', locked: true }, NOW);
    expect(plan.script).toEqual({ draft: draft.script, rewrite: 'Nobody warns you about this.\nIt is waiting.', locked: true, lockedAt: NOW, hook: draft.hook, onScreenText: draft.onScreenText });
    // an unchanged line keeps its visual
    expect(plan.beats).toEqual([{ line: 'Nobody warns you about this.' }, { line: 'It is waiting.', visual: 'the dough rising' }]);
  });

  it('a locked script cannot change until it is unlocked', () => {
    const locked = changePlan(changePlan(undefined, { kind: 'script', draft: 'One line.' }, NOW), { kind: 'lock', locked: true }, NOW);
    expect(() => changePlan(locked, { kind: 'script', rewrite: 'Another.' }, NOW)).toThrow(/locked/);
    expect(() => changePlan(locked, { kind: 'import', markdown: toMarkdown({ ...locked, script: { ...locked.script, draft: 'Other.' } }) }, NOW)).toThrow(/locked/);
    const open = changePlan(locked, { kind: 'lock', locked: false }, NOW);
    expect(changePlan(open, { kind: 'script', rewrite: 'Another.' }, NOW).script).toMatchObject({ rewrite: 'Another.', locked: false });
    expect(open.script.lockedAt).toBeUndefined();
  });

  it('a row the creator adds is approved; rows are approved and rejected one by one', () => {
    let plan = changePlan(withRows([HOURS]), { kind: 'row', id: null, row: { words: 'fancy flour', visual: 'my flour', source: 'own-file' } }, NOW);
    expect(plan.broll[1]).toEqual({ id: 'p3', words: 'fancy flour', visual: 'my flour', source: 'own-file', status: 'approved' });
    plan = changePlan(plan, { kind: 'rowStatus', id: 'p2', status: 'approved' }, NOW);
    plan = changePlan(plan, { kind: 'rowStatus', id: 'p3', status: 'rejected' }, NOW);
    expect(plan.broll.map((r) => r.status)).toEqual(['approved', 'rejected']);
    expect(() => changePlan(plan, { kind: 'rowStatus', id: 'p9', status: 'approved' }, NOW)).toThrow(/no plan row p9/);
  });
});

describe('the plan builds b-roll deterministically', () => {
  const t = makeTranscript(SAMPLE_LINES);
  const project = (plan: Plan): Project => withDefaults({ title: 'Bread', slug: 'bread', cut: { keep: [{ from: 'w16', to: 'w56' }], gapCap: 0.2 }, plan });

  it('only approved rows with their words and file are built, anchored on the words they name', () => {
    const p = project(withRows([FLOUR, HOURS, BRICK, row({ id: 'p4', words: 'sourdough starter', visual: 'a jar', source: 'fetched', asset: 'work/assets/brick.png', status: 'approved' }), row({ id: 'p5', words: 'my first loaf', visual: 'a loaf', source: 'fetched', status: 'approved' })]));
    const unbuilt = syncPlan(p, t);
    expect(p.broll).toEqual([{ id: 'p1', anchor: { from: 'w33', to: 'w34' }, leadIn: 0.13, treatment: 'card-above-head', asset: 'Library/Images/flour.png', params: {} }]);
    expect(p.plan!.broll[0]).toMatchObject({ anchor: { from: 'w33', to: 'w34' }, broll: 'p1' });
    expect(unbuilt).toEqual([{ id: 'p4', why: 'words-not-found' }, { id: 'p5', why: 'needs-file' }]);
  });

  it('buildProposed builds proposed rows too; a card shows its visual as text', () => {
    const p = project(withRows([HOURS], { buildProposed: true }));
    syncPlan(p, t);
    expect(p.broll).toEqual([{ id: 'p2', anchor: { from: 'w48', to: 'w49' }, leadIn: 0.13, treatment: 'text-pop', asset: null, params: { text: '18 HOURS' } }]);
  });

  it('a row rejected later is taken out, and nothing the plan did not build is touched', () => {
    const p = project(withRows([FLOUR]));
    p.broll.push({ id: 'b1', anchor: { from: 'w16', to: 'w18' }, treatment: 'text-pop', asset: null, params: { text: 'Hook' } });
    syncPlan(p, t);
    expect(p.broll.map((b) => b.id)).toEqual(['b1', 'p1']);
    p.plan = changePlan(p.plan, { kind: 'rowStatus', id: 'p1', status: 'rejected' }, NOW);
    syncPlan(p, t);
    expect(p.broll.map((b) => b.id)).toEqual(['b1']);
    expect(p.plan!.broll[0].broll).toBeUndefined();
  });

  it('a note\'s change to a placed row goes back to the row, and the next sync keeps it', () => {
    const p = project(withRows([HOURS], { buildProposed: true }));
    syncPlan(p, t);
    p.broll[0] = { ...p.broll[0], anchor: { from: 'w48', to: 'w52' }, params: { text: '18 HRS', tilt: 3 } };
    followBroll(p, t, 'note');
    expect(p.plan!.broll[0]).toEqual({ ...HOURS, words: 'eighteen hours in the fridge', anchor: { from: 'w48', to: 'w52' }, visual: '18 HRS', broll: 'p2' });
    const once = JSON.stringify(p);
    syncPlan(p, t);
    expect(JSON.stringify(p)).toBe(once);
  });

  it('a row follows the take the cut keeps, and one whose words are cut out leaves the video', () => {
    // "baking bread" is said in the hook and again in its retake (w7-w8, w23-w24)
    const bread = row({ id: 'p1', words: 'baking bread', visual: 'BREAD', status: 'approved' });
    const retake = row({ id: 'p2', words: 'try that again', visual: 'AGAIN', status: 'approved' });
    const p = project(withRows([bread, retake]));
    p.cut.keep = [];
    syncPlan(p, t);
    expect(p.broll.map((b) => [b.id, b.anchor])).toEqual([['p1', { from: 'w7', to: 'w8' }], ['p2', { from: 'w13', to: 'w15' }]]);
    p.cut.keep = [{ from: 'w16', to: 'w56' }];
    expect(syncPlan(p, t)).toEqual([{ id: 'p2', why: 'words-cut' }]);
    expect(p.broll.map((b) => [b.id, b.anchor])).toEqual([['p1', { from: 'w23', to: 'w24' }]]);
    expect(p.plan!.broll.map((r) => [r.anchor, r.broll ?? null])).toEqual([[{ from: 'w23', to: 'w24' }, 'p1'], [{ from: 'w13', to: 'w15' }, null]]);
    // the take comes back into the cut: so does the picture
    p.cut.keep = [{ from: 'w9', to: 'w56' }];
    expect(syncPlan(p, t)).toEqual([]);
    expect(p.broll.map((b) => b.id)).toEqual(['p1', 'p2']);
  });

  it('outside a note the AI can change only the look of what the creator decided', () => {
    const p = project(withRows([{ ...HOURS, status: 'approved' }, row({ id: 'p3', words: 'a brick', visual: 'a brick', source: 'fetched', status: 'approved' })]));
    syncPlan(p, t);
    const before = JSON.stringify(p);
    const refused = (change: (q: Project) => void) => {
      const q = structuredClone(p);
      change(q);
      expect(() => followBroll(q, t, 'ai')).toThrow(/approved this video's b-roll plan/);
    };
    refused((q) => { q.broll[0].params = { ...q.broll[0].params, text: '20 HOURS' }; });
    refused((q) => { q.broll[0].anchor = { from: 'w48', to: 'w52' }; });
    refused((q) => { q.broll = []; });
    refused((q) => { q.broll.push({ id: 'b9', anchor: { from: 'w40', to: 'w41' }, treatment: 'text-pop', asset: null, params: { text: 'BRICK' } }); });
    const q = structuredClone(p);
    q.broll[0].params = { ...q.broll[0].params, tilt: 3 };
    q.broll[0].treatment = 'side-card';
    followBroll(q, t, 'ai');
    expect(q.plan!.broll[0]).toMatchObject({ visual: '18 HOURS', treatment: 'side-card' });
    expect(JSON.stringify(p)).toBe(before);
    // update_plan_row: an approved row's anchor and file are fixed once it has them; missing ones may be filled
    expect(() => aiUpdateRow(structuredClone(p), 'p2', { anchor: { from: 'w48', to: 'w52' } })).toThrow(/anchor cannot change/);
    const r = structuredClone(p);
    aiUpdateRow(r, 'p3', { asset: 'work/assets/brick.png' });
    expect(r.plan!.broll[1].asset).toBe('work/assets/brick.png');
    expect(() => aiUpdateRow(r, 'p3', { asset: 'work/assets/other.png' })).toThrow(/file cannot change/);
  });

  it('a new proposal without beats keeps the beats there are', () => {
    const p = project(withRows([], { beats: [{ line: 'Bread is slow.', visual: 'dough' }] }));
    proposeRows(p, { broll: [{ words: 'brick', visual: 'a brick', source: 'fetched' }] });
    expect(p.plan!.beats).toEqual([{ line: 'Bread is slow.', visual: 'dough' }]);
    expect(p.plan!.broll).toEqual([{ id: 'p1', words: 'brick', visual: 'a brick', source: 'fetched', status: 'proposed' }]);
  });

  it('the same project and transcript always give the same b-roll, and syncing again changes nothing', () => {
    const plan = withRows([FLOUR, HOURS, BRICK, row({ id: 'p4', words: 'eighteen hours in the fridge', visual: 'a fridge', source: 'library', asset: 'Library/Images/flour.png', status: 'approved', treatment: 'side-card' })], { buildProposed: true });
    const a = project(structuredClone(plan)); const b = project(structuredClone(plan));
    b.updatedAt = a.updatedAt; b.createdAt = a.createdAt; b.id = a.id;
    syncPlan(a, t); syncPlan(b, t);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const once = JSON.stringify(a);
    syncPlan(a, t);
    expect(JSON.stringify(a)).toBe(once);
  });
});

describe('the flow', () => {
  it('the AI proposes rows; it changes nothing else, and approved and rejected rows survive a new proposal', async () => {
    const { dir, host, settingsDir, read } = await planned(withRows([{ ...FLOUR }, { ...BRICK }, { ...HOURS }]));
    const before = await read();
    const proposal = { beats: [{ line: 'I spent twenty bucks on a fancy flour', visual: 'the flour', sound: null }],
      broll: [{ words: 'eighteen hours in the fridge', anchor: null, visual: 'the dough in the fridge', source: 'fetched', asset: null, hold: 2, note: null }],
      music: 'warm acoustic', cover: 'the brick loaf, text BREAD' };
    const model = new ScriptedModel([{ toolCalls: [call('propose_plan', proposal)] }, { toolCalls: [finish('Here is your plan.')] }]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).proposePlan(dir, () => undefined);
    expect(toolNames(model).sort()).toEqual([...PLAN_TOOLS].sort());
    const after = await read();
    expect(r.summary).toBe('Here is your plan.');
    // p1 (approved) is built into the video's b-roll; nothing else in the project changed
    const { plan: _a, broll: _b, updatedAt: _c, ...rest } = after;
    const { plan: _d, broll: _e, updatedAt: _f, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
    expect(after.plan!.broll.map((x) => [x.id, x.status])).toEqual([['p1', 'approved'], ['p3', 'rejected'], ['p4', 'proposed']]);
    expect(after.plan!.broll[2]).toMatchObject({ words: 'eighteen hours in the fridge', anchor: { from: 'w48', to: 'w52' }, hold: 2 });
    expect(after.plan).toMatchObject({ music: 'warm acoustic', cover: 'the brick loaf, text BREAD', beats: [{ line: 'I spent twenty bucks on a fancy flour', visual: 'the flour' }] });
    expect(after.broll.map((b) => b.id)).toEqual(['p1']);
  });

  it('the first edit builds only approved rows, and add_broll is refused', async () => {
    const { dir, host, settingsDir, read } = await planned(withRows([{ ...FLOUR }, { ...HOURS }, { ...BRICK }]));
    const model = new ScriptedModel([
      { toolCalls: [KEEP, call('add_broll', { anchor: { from: 'w38', to: 'w38' }, treatment: 'text-pop', asset: null, search: null, animation: null, params: { text: 'LOAF', tilt: null, scale: null, side: null, style: null } })] },
      { toolCalls: [finish()] },
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    const names = toolNames(model);
    expect(names).toContain('update_plan_row');
    expect(names).not.toContain('add_broll');
    expect(names).not.toContain('remove_broll');
    expect(names).not.toContain('propose_plan');
    const task = (model.requests[0].messages[0] as any).content[0].text as string;
    expect(task).toContain('## The creator\'s plan');
    expect(task).toContain('p1 "fancy flour"');
    expect(toolResult(model, 'add_broll')).toMatchObject({ isError: true });
    expect(toolResult(model, 'add_broll').content).toContain('cannot be added outside the plan');
    const p = await read();
    expect(p.broll.map((b) => [b.id, b.asset])).toEqual([['p1', 'Library/Images/flour.png']]);
    expect(r.summary).toBe('Done.');
  });

  it('with no row approved the first edit has no b-roll and asks for approval', async () => {
    const { dir, host, settingsDir, read } = await planned(withRows([{ ...HOURS }]));
    const model = new ScriptedModel([{ toolCalls: [KEEP] }, { toolCalls: [finish('I cut your video.')] }]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    expect((await read()).broll).toEqual([]);
    expect(r.summary).toBe('I cut your video. I left the pictures out: no row of your b-roll plan is approved yet. Approve the ones you want and they go in.');
  });

  it('the first edit fills an approved row\'s file with update_plan_row, and cannot change what was approved', async () => {
    const brick = row({ id: 'p1', words: 'a brick', visual: 'a brick-hard loaf', source: 'fetched', status: 'approved' });
    const { dir, host, settingsDir, read } = await planned(withRows([brick]));
    const fields = { words: null, anchor: null, source: null, treatment: null, hold: null, note: null };
    const model = new ScriptedModel([
      { toolCalls: [KEEP, call('update_plan_row', { ...fields, id: 'p1', visual: 'a croissant', asset: null })] },
      { toolCalls: [call('update_plan_row', { ...fields, id: 'p1', visual: null, asset: 'work/assets/brick.png' })] },
      { toolCalls: [finish()] },
    ]);
    await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    const results = toolResults(model, 'update_plan_row');
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0].content).toContain('cannot change');
    expect(JSON.parse(results[1].content)).toMatchObject({ ok: true, id: 'p1', placed: true });
    const p = await read();
    expect(p.broll).toEqual([{ id: 'p1', anchor: { from: 'w40', to: 'w41' }, leadIn: 0.13, treatment: 'card-above-head', asset: 'work/assets/brick.png', params: {} }]);
    expect(p.plan!.broll[0]).toMatchObject({ visual: 'a brick-hard loaf', status: 'approved', broll: 'p1' });
  });

  it('in the first edit update_broll may change an approved card\'s look, never its text or its words', async () => {
    const { dir, host, settingsDir, read } = await planned(withRows([{ ...HOURS, status: 'approved' }]));
    const nulls = { anchor: null, treatment: null, asset: null };
    const params = { text: null, tilt: null, scale: null, side: null, style: null };
    const model = new ScriptedModel([
      { toolCalls: [KEEP, call('update_broll', { ...nulls, id: 'p2', params: { ...params, text: '20 HOURS' } })] },
      { toolCalls: [call('update_broll', { ...nulls, id: 'p2', anchor: { from: 'w48', to: 'w52' }, params: null })] },
      { toolCalls: [call('update_broll', { ...nulls, id: 'p2', params: { ...params, tilt: 3 } })] },
      { toolCalls: [finish()] },
    ]);
    await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    const results = toolResults(model, 'update_broll');
    expect(results.map((r) => r.isError)).toEqual([true, true, false]);
    expect(results[0].content).toContain('text cannot change');
    expect(results[1].content).toContain('anchor cannot change');
    const p = await read();
    expect(p.broll).toEqual([{ id: 'p2', anchor: { from: 'w48', to: 'w49' }, leadIn: 0.13, treatment: 'text-pop', asset: null, params: { text: '18 HOURS', tilt: 3 } }]);
    expect(p.plan!.broll[0]).toMatchObject({ visual: '18 HOURS', words: 'eighteen hours', status: 'approved' });
  });

  it('the first edit\'s cut moves a row to the take it keeps', async () => {
    const { dir, host, settingsDir, read } = await planned(withRows([row({ id: 'p1', words: 'baking bread', visual: 'BREAD', status: 'approved' })]));
    const model = new ScriptedModel([{ toolCalls: [KEEP] }, { toolCalls: [finish()] }]);
    await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    const p = await read();
    expect(p.broll.map((b) => [b.id, b.anchor])).toEqual([['p1', { from: 'w23', to: 'w24' }]]);
    expect(p.plan!.broll[0].anchor).toEqual({ from: 'w23', to: 'w24' });
  });

  it('the no-AI edit\'s cut moves a row to the take it keeps too', async () => {
    const { dir, root, settingsDir, read } = await planned(withRows([row({ id: 'p1', words: 'baking bread', visual: 'BREAD', status: 'approved' })]));
    // the engine's autocut keeps the retake of the hook
    const host = new (class extends FakeHost {
      override async runEngine(command: string, args: string[], onProgress?: any): Promise<any> {
        if (command !== 'autocut') return super.runEngine(command, args, onProgress);
        const p = await read();
        await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({ ...p, cut: { ...p.cut, keep: [{ from: 'w16', to: 'w56' }] } }, null, 2));
        return {};
      }
    })(root);
    await createAI({ host, settingsDir }).firstEdit(dir, () => undefined);
    const p = await read();
    expect(p.broll.map((b) => [b.id, b.anchor])).toEqual([['p1', { from: 'w23', to: 'w24' }]]);
    expect(p.plan!.broll[0].anchor).toEqual({ from: 'w23', to: 'w24' });
  });

  it('a hand edit goes into the plan: a removed picture stays removed, an added or moved one is a row', async () => {
    const { dir, read } = await planned(withRows([{ ...FLOUR }, { ...HOURS, status: 'approved' }]));
    await updatePlan(dir, { kind: 'details', music: 'warm' });
    const save = async (edit: (p: Project) => void) => {
      const p = await read();
      edit(p);
      await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(await followHandEdit(dir, p), null, 2));
    };
    // the Pictures tab: take the flour out, move the card, add a word card
    await save((p) => {
      p.broll = p.broll.filter((b) => b.id !== 'p1');
      p.broll[0].anchor = { from: 'w48', to: 'w52' };
      p.broll.push({ id: 'b1', anchor: { from: 'w40', to: 'w41' }, leadIn: 0.13, treatment: 'text-pop', asset: null, params: { text: 'BRICK' } });
    });
    const expected = [
      ['p1', 'rejected', null, undefined],
      ['p2', 'approved', 'p2', { from: 'w48', to: 'w52' }],
      ['p3', 'approved', 'b1', { from: 'w40', to: 'w41' }],
    ];
    const rows = (p: Project) => p.plan!.broll.map((r) => [r.id, r.status, r.broll ?? null, r.status === 'rejected' ? undefined : r.anchor]);
    expect(rows(await read())).toEqual(expected);
    expect((await read()).plan!.broll[2]).toMatchObject({ words: 'a brick', visual: 'BRICK', source: 'card', note: 'Added by hand.' });
    // an unrelated plan change, and a re-sync, keep every one of those edits
    await updatePlan(dir, { kind: 'details', music: 'something else' });
    const p = await read();
    expect(rows(p)).toEqual(expected);
    expect(p.broll.map((b) => [b.id, b.anchor])).toEqual([['p2', { from: 'w48', to: 'w52' }], ['b1', { from: 'w40', to: 'w41' }]]);
    expect((await readPlan(dir)).unbuilt).toEqual([]);
  });

  it('a project without a plan gets the first edit it always had', async () => {
    const { root, dir } = await makeProject();
    const model = new ScriptedModel([{ toolCalls: [KEEP] }, { toolCalls: [finish()] }]);
    await createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: model }).firstEdit(dir, () => undefined);
    expect(toolNames(model)).toContain('add_broll');
    expect(toolNames(model)).not.toContain('update_plan_row');
    expect(toolNames(model)).not.toContain('propose_plan');
    expect((model.requests[0].messages[0] as any).content[0].text).not.toContain('creator\'s plan');
  });

  it('a note\'s b-roll becomes a row of the plan, and a removed one is rejected', async () => {
    const { dir, host, settingsDir, read } = await planned(withRows([{ ...FLOUR }]));
    await firstVersion(dir, host);
    // the creator's approval placed p1 (the app's plan IPC)
    await updatePlan(dir, { kind: 'rowStatus', id: 'p1', status: 'approved' });
    const ai = createAI({ host, settingsDir, providerOverride: new ScriptedModel([
      { toolCalls: [call('add_broll', { anchor: { from: 'w40', to: 'w41' }, treatment: 'text-pop', asset: null, search: null, animation: null, params: { text: 'BRICK', tilt: null, scale: null, side: null, style: null } })] },
      { toolCalls: [finish('I put BRICK on screen.')] },
    ]) });
    await ai.applyNote(dir, 'put the word BRICK on screen when I say a brick', () => undefined);
    let p = await read();
    expect(p.plan!.broll[1]).toEqual({ id: 'p2', words: 'a brick', anchor: { from: 'w40', to: 'w41' }, visual: 'BRICK', source: 'card', asset: null, treatment: 'text-pop', status: 'approved', note: 'Added for a note.', broll: p.broll[1].id });
    await createAI({ host, settingsDir, providerOverride: new ScriptedModel([
      { toolCalls: [call('remove_broll', { id: 'p1' })] }, { toolCalls: [finish('I took the flour out.')] },
    ]) }).applyNote(dir, 'take the flour picture out', () => undefined);
    p = await read();
    expect(p.plan!.broll.map((x) => [x.id, x.status, x.broll ?? null])).toEqual([['p1', 'rejected', null], ['p2', 'approved', p.broll[0].id]]);
  });
});

describe('markdown', () => {
  const full: Plan = {
    script: { draft: 'Nobody tells you this.\n# not a heading\nIt is | waiting.', rewrite: 'Nobody warns you.\nIt is waiting.', locked: true, lockedAt: NOW, hook: 'Nobody tells you this.', onScreenText: ['Bread takes time', 'Day 2'] },
    beats: [{ line: 'Nobody warns you.', visual: 'face, close', sound: 'piano | soft' }, { line: 'It is waiting.' }],
    broll: [
      { ...FLOUR, anchor: { from: 'w33', to: 'w34' }, hold: 2, note: 'their photo', broll: 'p1', treatment: 'side-card' },
      { ...HOURS, visual: '18\nHOURS' },
      { ...BRICK },
      row({ id: 'p4', words: 'my screen', visual: 'the app', source: 'screen-recording' }),
      row({ id: 'p5', visual: 'a count-up', source: 'animation', status: 'approved' }),
      row({ id: 'p6', words: 'my clip', visual: 'my own clip', source: 'own-file' }),
    ],
    music: 'warm acoustic',
    cover: 'the brick loaf, text BREAD',
    buildProposed: true,
  };

  it('uses the script plan and b-roll table formats', () => {
    const md = toMarkdown(full);
    expect(md).toContain('| # | Line | Visual | Sound |\n|---|---|---|---|\n| 1 | Nobody warns you. | face, close | piano \\| soft |\n| 2 | It is waiting. |  |  |');
    expect(md).toContain('| id | words | visual | source | status |\n|---|---|---|---|---|\n| p1 | fancy flour | their bag of fancy flour | library | approved |');
    expect(md).toContain('| p2 | eighteen hours | 18<br>HOURS | card | proposed |');
    expect(md).toContain('| p4 | my screen | the app | screen recording | proposed |');
    expect(md).toContain('Locked to shoot.');
  });

  it('round-trips onto the same plan exactly, keeping what the tables have no column for', () => {
    expect(fromMarkdown(toMarkdown(full), full, NOW)).toEqual(full);
  });

  it('round-trips on its own: a plan read from markdown writes the same markdown', () => {
    const md = toMarkdown(full);
    const read = fromMarkdown(md, emptyPlan(), NOW);
    expect(toMarkdown(read)).toBe(md);
    expect(read.broll[0]).toEqual({ id: 'p1', words: 'fancy flour', visual: 'their bag of fancy flour', source: 'library', status: 'approved' });
    expect(read.script.draft).toBe(full.script.draft);
  });

  it('reads a table written elsewhere: numbered rows, any spacing, plain words', () => {
    const md = [
      '## Beats', '', '| #  | Line | Visual | Sound |', '| :- | :--- | :----- | :---- |', '| 1 | Bread is slow. | dough | lo-fi |', '',
      '## B-roll', '', '|id|words|visual|source|status|', '|--|--|--|--|--|',
      '| 1 | fancy flour | a bag of flour | Own file | Approved |', '|  | brick | a brick | Screen Recording |  |',
    ].join('\n');
    const plan = fromMarkdown(md, emptyPlan(), NOW);
    expect(plan.beats).toEqual([{ line: 'Bread is slow.', visual: 'dough', sound: 'lo-fi' }]);
    expect(plan.broll).toEqual([
      { id: 'p1', words: 'fancy flour', visual: 'a bag of flour', source: 'own-file', status: 'approved' },
      { id: 'p2', words: 'brick', visual: 'a brick', source: 'screen-recording', status: 'proposed' },
    ]);
  });

  it('an import that leaves a row out rejects it, and changed words are anchored again', () => {
    const base = withRows([{ ...FLOUR, anchor: { from: 'w33', to: 'w34' } }, { ...HOURS }]);
    const md = toMarkdown(base).replace('| p1 | fancy flour |', '| p1 | twenty bucks |').replace(/\| p2 .*\n/, '');
    const plan = fromMarkdown(md, base, NOW);
    expect(plan.broll).toEqual([{ ...FLOUR, words: 'twenty bucks' }, { ...HOURS, status: 'rejected' }]);
  });

  it('refuses a table it cannot read, saying which row', () => {
    expect(() => fromMarkdown('## B-roll\n\n| id | words | visual | source | status |\n|---|---|---|---|---|\n| p1 | x | y | stock | approved |')).toThrow(/b-roll row 1: source "stock"/);
    expect(() => fromMarkdown('## B-roll\n\n| id | words | visual | source | status |\n|---|---|---|---|---|\n| p1 | x |  | card | approved |')).toThrow(/visual/);
  });
});
