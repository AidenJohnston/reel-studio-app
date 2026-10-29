import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, loadProject, AgentEvent, AIError, runAgent, newToolState, StyleStore, Prompts, pickTakes, ReplayProvider, RecordingProvider } from '../src';
import { FakeHost, ScriptedModel, makeProject, call, tmpDir } from './helpers';

const nullP = { tilt: null, scale: null, text: null };

function firstEditScript() {
  return new ScriptedModel([
    { toolCalls: [call('get_project'), call('get_transcript')] },
    (req) => {
      const lastTool = req.messages.at(-1) as any;
      expect(lastTool.role).toBe('tool');
      expect(lastTool.results[1].content).toMatch(/RETAKE GROUPS/);
      return { toolCalls: [call('set_cut', { keep: [{ from: 'w16', to: 'w26' }, { from: 'w27', to: 'w56' }] }), call('set_gap_cap', { seconds: 0.12 }), call('list_library', { kind: 'music' })] };
    },
    { toolCalls: [
      call('choose_music', { track: 'Library/Music/gentle.mp3', startAt: 2, level: 'under-voice' }),
      call('add_broll', { anchor: { from: 'w29', to: 'w30' }, treatment: 'text-pop', asset: null, search: null, animation: null, params: { ...nullP, text: '$20' } }),
      call('set_zoom', { zooms: [{ anchor: { from: 'w53', to: 'w56' }, scale: 1.1 }] }),
      call('set_cover', { atSourceTime: 8.5, source: null, text: 'Bread' }),
      call('write_post', { caption: 'The hardest part of baking bread is waiting', hashtags: ['sourdough', 'breadtok', 'baking', 'homebaker', 'slowfood'], keywords: ['baking bread'] }),
      call('render_draft'),
    ] },
    { toolCalls: [call('look_at_frames', { times: [1], words: ['w29'] })] },
    (req) => {
      const last = (req.messages.at(-1) as any).results[0];
      expect(last.images).toHaveLength(2);
      return { toolCalls: [call('finish', { summary_for_user: 'I kept your best take of each line, cut the pauses, added soft music and put the price on screen.' })] };
    },
  ]);
}

async function setup() {
  const { root, dir } = await makeProject();
  await fsp.writeFile(path.join(root, 'Library', 'Music', 'gentle.mp3'), 'x');
  const host = new FakeHost(root);
  const settingsDir = tmpDir('settings ');
  return { root, dir, host, settingsDir };
}

describe('agent loop with a scripted model', () => {
  it('firstEdit: tools mutate project.json, draft then final render, events, summary', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = firstEditScript();
    const ai = createAI({ host, settingsDir, providerOverride: model });
    const events: AgentEvent[] = [];
    const r = await ai.firstEdit(dir, (e) => events.push(e));
    expect(r.summary).toMatch(/best take/);
    expect(r.version).toBe(1); // the draft is a preview (versions/preview), the final is v1
    expect(r.changed.sort()).toEqual(['broll', 'cover', 'cut', 'music', 'post', 'zooms']);
    const p = await loadProject(dir);
    expect(p.cut.keep[0]).toEqual({ from: 'w16', to: 'w26' });
    expect(p.music.track).toBe('Library/Music/gentle.mp3');
    expect(p.broll).toHaveLength(1);
    expect(p.post.hashtags).toHaveLength(5);
    // the no-AI first look (a preview, never saved), then the AI's preview, then the one final render
    const renders = host.calls.filter((c) => c.command === 'render');
    expect(renders.map((c) => c.args.includes('--draft'))).toEqual([true, true, false]);
    expect(renders[0].args).toEqual(expect.arrayContaining(['--first-look', '--no-cover', '--music', 'Library/Music/gentle.mp3']));
    expect(events.filter((e) => e.type === 'render').map(({ file: _, ...e }: any) => e)).toEqual([
      { type: 'render', version: 1, draft: true, firstLook: true }, { type: 'render', version: 1, draft: true }, { type: 'render', version: 1, draft: false }]);
    // the project and transcript were handed to the model up front, not fetched in a turn
    expect((model.requests[0].messages[0] as any).content[0].text).toMatch(/Already loaded for you[\s\S]*result of get_project[\s\S]*result of get_transcript/);
    expect(events.some((e) => e.type === 'status' && e.message === 'Picking your best takes')).toBe(true);
    expect(events.some((e) => e.type === 'tool' && e.summary === 'Added a visual on "twenty bucks"')).toBe(true);
    // system prompt carries doctrine + style placeholder filled
    expect(model.requests[0].system).toMatch(/red thread/i);
    expect(model.requests[0].system).not.toMatch(/\{\{styleRules\}\}/);
    expect(model.requests[0].tools.length).toBe(26);   // docs/architecture.md section 6 + set_mirror
    await fsp.access(path.join(dir, 'versions', 'v1', 'project.json'));
    await fsp.access(path.join(dir, 'versions', 'preview', 'draft.mp4'));
    expect((await fsp.readdir(path.join(dir, 'versions'))).sort()).toEqual(['preview', 'v1']);
  });

  it('applyNote: changes only what the note asks, PROPOSES a style rule (saved only on Yes), records the note', async () => {
    const { dir, host, settingsDir, root } = await setup();
    const model = new ScriptedModel([
      (req) => {
        expect((req.messages[0] as any).content[0].text).toMatch(/music too loud at the start/);
        return { toolCalls: [call('get_project')] };
      },
      { toolCalls: [call('set_music_automation', { automation: [{ fromWord: 'w0', toWord: 'w8', gainDb: -6 }] }), call('add_style_rule', { rule: 'Keep music quieter under talking' })] },
      { toolCalls: [call('render_draft')] },
      { toolCalls: [call('finish', { summary_for_user: "I turned the music down at the start. I'll remember that for next time." })] },
    ]);
    const ai = createAI({ host, settingsDir, providerOverride: model, finalRender: false });
    const before = await loadProject(dir);
    const r = await ai.applyNote(dir, 'music too loud at the start', () => undefined);
    expect(r.changed).toEqual(['music']);
    // the note never asked to remember anything: the rule is a proposal, My style is untouched
    expect(r.styleRulesAdded).toEqual([]);
    expect(r.styleSuggestions).toEqual(['Keep music quieter under talking.']);
    expect(r.summary).not.toMatch(/My style|saved/i);
    expect(await ai.styleRules()).toEqual([]);
    const p = await loadProject(dir);
    expect(p.cut).toEqual(before.cut);
    expect(p.music.automation).toEqual([{ fromWord: 'w0', toWord: 'w8', gainDb: -6 }]);
    expect(p.notes).toEqual([expect.objectContaining({ version: r.version, text: 'music too loud at the start', applied: ['music'] })]);
    // the user said Yes in the app
    await ai.addStyleRule(r.styleSuggestions[0]);
    const rules = await ai.styleRules();
    expect(rules.map((x) => x.text)).toEqual(['Keep music quieter under talking.']);
    expect(JSON.parse(await fsp.readFile(path.join(root, 'My style.json'), 'utf8')).rules).toHaveLength(1);
    // next task sees the rule in its system prompt
    const m2 = new ScriptedModel([{ toolCalls: [call('finish', { summary_for_user: 'ok' })] }]);
    await createAI({ host, settingsDir, providerOverride: m2 }).applyNote(dir, 'x', () => undefined);
    expect(m2.requests[0].system).toMatch(/Keep music quieter under talking\./);
    await ai.removeStyleRule(rules[0].id);
    expect(await ai.styleRules()).toEqual([]);
  });

  it('model mistakes are fed back, not fatal; nudges when the model stops calling tools', async () => {
    const { dir, host } = await setup();
    const model = new ScriptedModel([
      { toolCalls: [call('set_cut', { keep: [{ from: 'w0', to: 'w999' }] })] },
      (req) => {
        expect((req.messages.at(-1) as any).results[0].content).toMatch(/unknown word id w999/);
        return { text: 'thinking out loud' };
      },
      (req) => {
        expect((req.messages.at(-1) as any).content[0].text).toMatch(/call finish/);
        return { toolCalls: [call('finish', { summary_for_user: 'done' })] };
      },
    ]);
    const ctx = { projectDir: dir, host, style: new StyleStore(() => host.reelStudioRoot()), emit: () => undefined, state: newToolState(), supportsImages: true };
    const r = await runAgent({ provider: model, system: 's', task: 't', ctx, onEvent: () => undefined });
    expect(r.finished).toBe('done');
  });

  it('part of the first look would not stop: the first edit ends with that error and renders nothing more', async () => {
    const { dir, host, settingsDir } = await setup();
    let renders = 0;
    host.afterRenderFiles = () => {
      if (renders++ === 0) throw { code: 'ENGINE_STUCK', userMessage: "Part of Reel Studio's video engine would not stop." };
    };
    const ai = createAI({ host, settingsDir, providerOverride: firstEditScript() });
    await expect(ai.firstEdit(dir, () => undefined)).rejects.toMatchObject({ code: 'ENGINE_STUCK' });
    expect(host.calls.filter((c) => c.command === 'render')).toHaveLength(1);
  });

  it('part of a note\'s preview render would not stop: the note ends with that error at once, nothing else runs, and nothing is rolled back under it', async () => {
    const { dir, host, settingsDir } = await setup();
    host.afterRenderFiles = ({ draft }) => {
      if (draft) throw { code: 'ENGINE_STUCK', userMessage: "Part of Reel Studio's video engine would not stop." };
    };
    const m = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.4 }), call('render_draft')] },
      { toolCalls: [call('finish', { summary_for_user: 'I gave the pauses more room.' })] },
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: m }).applyNote(dir, 'slower', () => undefined)).rejects.toMatchObject({ code: 'ENGINE_STUCK' });
    expect(m.requests).toHaveLength(1);
    expect(host.calls.map((c) => c.command)).toEqual(['render']);
    // the engine may still be writing: the note's change stays where it was, and the app keeps the video closed
    expect(JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8')).cut.gapCap).toBe(0.4);
  });

  it('cancel stops the loop', async () => {
    const { dir, host, settingsDir } = await setup();
    const ac = new AbortController();
    const model = new ScriptedModel([() => { ac.abort(); return { toolCalls: [call('get_project')] }; }]);
    const ai = createAI({ host, settingsDir, providerOverride: model });
    await expect(ai.firstEdit(dir, () => undefined, ac.signal)).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('usage limit mid-edit: falls back to the simple edit and says why (no other paid provider used)', async () => {
    const { dir, host, settingsDir } = await setup();
    const limit = new AIError('chatgpt_usage_limit', "You have reached your ChatGPT plan's limit for now, so I stopped.", { link: 'https://chatgpt.com/settings/usage' });
    const model = new ScriptedModel([{ toolCalls: [call('get_project')] }, limit]);
    const ai = createAI({ host, settingsDir, providerOverride: model });
    const r = await ai.firstEdit(dir, () => undefined);
    expect(r.notice).toMatchObject({ code: 'chatgpt_usage_limit', link: 'https://chatgpt.com/settings/usage' });
    expect(r.summary).toMatch(/limit/);
    expect(r.summary).toMatch(/simple version/);
    expect(host.calls.map((c) => c.command)).toContain('autocut');
  });
});

describe('no AI connected', () => {
  it('firstEdit runs the deterministic path (transcribe, analyze, autocut, first library song, render)', async () => {
    const { root, dir } = await makeProject({ withTranscript: false });
    await fsp.writeFile(path.join(root, 'Library', 'Music', 'b song.mp3'), 'x');
    await fsp.writeFile(path.join(root, 'Library', 'Music', 'a song.mp3'), 'x');
    const host = new FakeHost(root);
    const ai = createAI({ host, settingsDir: tmpDir() });
    expect((await ai.active()).id).toBe('none');
    const r = await ai.firstEdit(dir, () => undefined);
    // the face track is found beside the transcription (analyze --faces-only), then the rest in order
    expect(host.calls.map((c) => c.command + (c.args.includes('--faces-only') ? ':faces' : ''))).toEqual(['analyze:faces', 'transcribe', 'analyze', 'autocut', 'render']);
    expect(r.summary).toMatch(/Connect ChatGPT/);
    expect(r.summary).toMatch(/"a song"/);
    expect(r.summary).not.toMatch(/—/);
    expect((await loadProject(dir)).music.track).toBe('Library/Music/a song.mp3');
    await expect(ai.applyNote(dir, 'x', () => undefined)).rejects.toMatchObject({ code: 'no_ai' });
    await expect(ai.writeScript('x', () => undefined)).rejects.toMatchObject({ code: 'no_ai' });
  });

  it('provider list hides dev providers unless dev: true', async () => {
    const host = new FakeHost(tmpDir());
    const localClaude = { bin: null }; // no Claude Code app here (never runs the real one)
    const localCodex = { bin: null }; // nor the real Codex app
    expect((await createAI({ host, settingsDir: tmpDir(), localClaude, localCodex }).providers()).map((p) => p.id)).toEqual(['claude', 'claude-cli', 'codex-cli', 'none']);
    expect((await createAI({ host, settingsDir: tmpDir(), dev: true, localClaude, localCodex }).providers()).map((p) => p.id)).toEqual(['claude', 'claude-cli', 'codex-cli', 'chatgpt', 'replay', 'none']);
    await expect(createAI({ host, settingsDir: tmpDir(), localClaude, localCodex }).setActive('claude-cli')).rejects.toMatchObject({ code: 'not_available' });
    await expect(createAI({ host, settingsDir: tmpDir(), localClaude, localCodex }).setActive('codex-cli')).rejects.toMatchObject({ code: 'not_available' });
    // the retired in-app ChatGPT sign-in can no longer be chosen outside dev mode
    await expect(createAI({ host, settingsDir: tmpDir(), localClaude, localCodex }).setActive('chatgpt')).rejects.toMatchObject({ code: 'not_available' });
  });
});

describe('writeScript and pickTakes', () => {
  it('writeScript returns hook/script/onScreenText and retries bad JSON', async () => {
    const host = new FakeHost(tmpDir());
    const model = new ScriptedModel([{ text: 'Sure! here it is' }, { text: '```json\n{"hook":"Nobody tells you this — about bread","script":"Line one.","onScreenText":["WAIT"]}\n```' }]);
    const r = await createAI({ host, settingsDir: tmpDir(), providerOverride: model }).writeScript('bread takes forever', () => undefined);
    expect(r).toEqual({ hook: 'Nobody tells you this, about bread', script: 'Line one.', onScreenText: ['WAIT'] });
    expect(model.requests[0].jsonOnly).toBe(true);
  });

  it('pickTakes validates ids and asks for a fix', async () => {
    const { transcript } = await makeProject();
    const model = new ScriptedModel([
      { text: '{"keep":[{"from":"w16","to":"w9999"}]}' },
      (req) => {
        expect((req.messages.at(-1) as any).content[0].text).toMatch(/unknown word id w9999/);
        return { text: '{"keep":[{"from":"w16","to":"w56"}],"notes":"last take of the hook"}' };
      },
    ]);
    const r = await pickTakes({ ...transcript, retakes: [{ candidates: [{ from: 'w0', to: 'w8' }, { from: 'w16', to: 'w26' }] }] }, model);
    expect(r).toEqual({ keep: [{ from: 'w16', to: 'w56' }], notes: 'last take of the hook', attempts: 2 });
    expect((model.requests[0].messages[0] as any).content[0].text).toMatch(/RETAKE GROUPS/);
    expect(model.requests[0].system).toMatch(/red thread|take/i);
  });
});

describe('record + replay', () => {
  it('a recorded session replays through the same loop', async () => {
    const { dir, host, settingsDir } = await setup();
    const fixture = path.join(tmpDir(), 'session.json');
    const rec = new RecordingProvider(firstEditScript(), fixture, 'firstEdit');
    await createAI({ host, settingsDir, providerOverride: rec }).firstEdit(dir, () => undefined);
    const again = await setup();
    const replay = new ReplayProvider(fixture);
    const r = await createAI({ host: again.host, settingsDir: again.settingsDir, providerOverride: replay }).firstEdit(again.dir, () => undefined);
    expect(r.summary).toMatch(/best take/);
    expect(replay.remaining).toBe(0);
    expect((await loadProject(again.dir)).cut.keep).toEqual((await loadProject(dir)).cut.keep);
  });
});

describe('prompts', () => {
  it('load from ai/prompts and contain no em dashes or source-specific content', () => {
    const pr = new Prompts();
    for (const n of ['system', 'firstEdit', 'applyNote', 'writeScript', 'pickTakes', 'review'] as const) {
      const t = pr.raw(n);
      expect(t.length).toBeGreaterThan(500);
      expect(t).not.toMatch(/—/);
      // Banned source names are stored base64 so this file passes the repo-wide grep itself.
      const banned = new RegExp(Buffer.from('Y3VyYXRlfHN1cGFiYXNlfHV0ZXhhc3x1dCBhdXN0aW58YWlkZW58ZGF0aW5nIGFwcA==', 'base64').toString(), 'i');
      expect(t).not.toMatch(banned);
    }
    expect(pr.render('applyNote', { note: 'NOTE_X' })).toMatch(/NOTE_X/);
  });
});

describe('failure handling', () => {
  it('applyNote that fails halfway restores project.json', async () => {
    const { dir, host, settingsDir } = await setup();
    const before = await fsp.readFile(path.join(dir, 'project.json'), 'utf8');
    const model = new ScriptedModel([
      { toolCalls: [call('set_gap_cap', { seconds: 0.5 })] },
      new AIError('chatgpt_usage_limit', 'limit', { link: 'https://chatgpt.com/settings/usage' }),
    ]);
    await expect(createAI({ host, settingsDir, providerOverride: model }).applyNote(dir, 'slower', () => undefined)).rejects.toMatchObject({ code: 'chatgpt_usage_limit' });
    expect(await fsp.readFile(path.join(dir, 'project.json'), 'utf8')).toBe(before);
  });

  it('firstEdit that stops after a preview keeps the work and reports the notice', async () => {
    const { dir, host, settingsDir } = await setup();
    const model = new ScriptedModel([
      { toolCalls: [call('set_cut', { keep: [{ from: 'w16', to: 'w56' }] }), call('render_draft')] },
      new AIError('chatgpt_usage_limit', 'You have reached your ChatGPT limit.', {}),
    ]);
    const r = await createAI({ host, settingsDir, providerOverride: model }).firstEdit(dir, () => undefined);
    expect(r.notice?.code).toBe('chatgpt_usage_limit');
    expect(r.summary).toMatch(/most of the way/);
    expect((await loadProject(dir)).cut.keep).toEqual([{ from: 'w16', to: 'w56' }]);
    expect(host.calls.map((c) => c.command)).not.toContain('autocut');
  });

  it('two edits on the same project run one after another', async () => {
    const { dir, host, settingsDir } = await setup();
    const order: string[] = [];
    let n = 0;
    const slow = { id: 'fake' as const, supportsImages: false, async complete() {
      const tag = `e${++n}`; order.push(`${tag}-start`); await new Promise((r) => setTimeout(r, 50)); order.push(`${tag}-end`);
      return { text: '', toolCalls: [{ id: tag, name: 'finish', args: { summary_for_user: tag } }] };
    } };
    const a = createAI({ host, settingsDir, providerOverride: slow });
    await Promise.all([a.applyNote(dir, 'x', () => undefined), a.applyNote(dir, 'y', () => undefined)]);
    expect(order).toEqual(['e1-start', 'e1-end', 'e2-start', 'e2-end']);
  });
});
