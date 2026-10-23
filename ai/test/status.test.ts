import { expect, it } from 'vitest';
import * as fsp from 'node:fs/promises';
import { approxOutputTimes, createAI, loadProject, newToolState, saveProject, StyleStore } from '../src';
import { load, operationStatus, ToolContext } from '../src/tools';
import { call, FakeHost, makeProject, ScriptedModel, tmpDir } from './helpers';

it('fails if a note’s status line names the wrong words, moment or direction (music turned down read as taken out), drops the render’s own steps, or says the video is ready mid-note', async () => {
  const { root, dir, transcript } = await makeProject();
  const p0 = await loadProject(dir);
  p0.cut.keep = [{ from: 'w0', to: 'w8' }, { from: 'w27', to: 'w56' }];
  p0.version = 1;
  p0.music = { ...p0.music, enabled: true, track: 'Library/Music/gentle.mp3', level: 'under-voice' };
  await fsp.writeFile(`${dir}/project.json`, JSON.stringify(p0));
  await fsp.writeFile(`${root}/Library/Music/gentle.mp3`, 'x');
  const at = approxOutputTimes(transcript, p0.cut.keep, p0.cut.gapCap).get('w29')!.s;
  const model = new ScriptedModel([
    { toolCalls: [call('set_cut', { keep: [{ from: 'w0', to: 'w8' }, { from: 'w27', to: 'w28' }, { from: 'w31', to: 'w56' }] }), call('set_gap_cap', { seconds: p0.cut.gapCap + 0.2 }), call('choose_music', { track: null, startAt: null, level: 'quiet' }), call('render_draft')] },
    { toolCalls: [call('finish', { summary_for_user: 'I cut "twenty bucks".' })] },
  ]);
  const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings '), providerOverride: model });
  const said: string[] = [];
  await ai.applyNote(dir, 'cut "twenty bucks"', (e) => { if (e.type === 'status' && said.at(-1) !== e.message) said.push(e.message); });
  expect(said).toContain(`Cutting 2 words at 0:${String(Math.round(at)).padStart(2, '0')}`);
  expect(said).toContain('Giving the pauses more room');
  expect(said).toContain('Changing the music volume');
  expect(said).not.toContain('Taking out the music');
  // the Working screen moves its step list on the render's own steps
  expect(said).toContain('Making your cover');
  expect(said).not.toContain('Your video is ready');
});

it('fails if a status line names a picture for words on screen, a smaller size for subtitles turned off, or music the call does not change', async () => {
  const { root, dir } = await makeProject();
  const p = await loadProject(dir);
  p.cut.keep = [{ from: 'w0', to: 'w56' }];
  p.broll = [{ id: 'b1', anchor: { from: 'w2', to: 'w4' }, treatment: 'text-pop', asset: null } as any];
  p.music = { ...p.music, enabled: true, track: 'Library/Music/gentle.mp3' };
  await saveProject(dir, p);
  const ctx: ToolContext = { projectDir: dir, host: new FakeHost(root), style: new StyleStore(() => root), emit: () => undefined, state: newToolState(), supportsImages: true };
  await load(ctx);
  expect(operationStatus(ctx, 'remove_broll', { id: 'b1' })).toMatch(/^Taking out the words on screen/);
  expect(operationStatus(ctx, 'set_caption_style', { enabled: false, size: 84 })).toBe('Turning the subtitles off');
  expect(operationStatus(ctx, 'choose_music', {})).toBe('Taking out the music');
  ctx.project!.music.track = null;
  expect(operationStatus(ctx, 'choose_music', { track: null, level: 'quiet' })).toBeUndefined();
});
