// Recorded real-model sessions (claude-cli) replayed through the real agent loop, so CI and the
// macOS box can test end to end without a login. Re-record with:  RECORD_LIVE=1 npx vitest run test/fixtures.test.ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, loadProject, ReplayProvider, RecordingProvider, ClaudeCliProvider, pickTakes, ModelProvider, newToolState, StyleStore } from '../src';
import { FakeHost, makeProject, tinyPng, tmpDir, tinyMp3, commitLocalAsset } from './helpers';

const FIX = path.join(__dirname, '..', 'fixtures');
const LIVE = process.env.RECORD_LIVE === '1';
const fakeFetch = (async () => new Response(tinyPng(), { headers: { 'content-type': 'image/png' } })) as any;

async function breadSetup() {
  const { root, dir, transcript } = await makeProject();
  await fsp.writeFile(path.join(root, 'Library', 'Music', 'gentle piano.mp3'), tinyMp3());
  await fsp.writeFile(path.join(root, 'Library', 'Music', 'upbeat drums.mp3'), 'x');
  await fsp.writeFile(path.join(root, 'Library', 'Images', 'sourdough loaf.png'), tinyPng([200, 160, 90]));
  await fsp.writeFile(path.join(root, 'Library', 'Images', 'bag of flour.png'), tinyPng([240, 240, 230]));
  const host = new FakeHost(root);
  const ctx = { projectDir: dir, host, style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: true };
  const track = await commitLocalAsset(ctx, 'Library/Music/gentle piano.mp3', 'music');
  return { root, dir, transcript, host, track };
}

function model(name: string, track?: string): ModelProvider {
  const file = path.join(FIX, `${name}.json`);
  if (LIVE) return new RecordingProvider(new ClaudeCliProvider({ model: process.env.RECORD_MODEL ?? 'claude-sonnet-5-5' }), file, name);
  const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (track) for (const step of fixture.steps) for (const call of step.response.toolCalls) {
    if (call.name === 'choose_music' && call.args.track) call.args.track = track;
  }
  return new ReplayProvider(fixture);
}

const have = (name: string) => LIVE || fs.existsSync(path.join(FIX, `${name}.json`));

describe('recorded sessions (replay)', () => {
  it.runIf(have('firstEdit-bread'))('firstEdit picks the later hook take and builds a full edit', async () => {
    const { dir, host, track } = await breadSetup();
    const ai = createAI({ host, settingsDir: tmpDir(), providerOverride: model('firstEdit-bread', track), fetch: fakeFetch, lookup: async () => ['93.184.215.14'] });
    const r = await ai.firstEdit(dir, () => undefined);
    const p = await loadProject(dir);
    const kept = new Set(p.cut.keep.flatMap((a) => {
      const i = Number(a.from.slice(1)); const j = Number(a.to.slice(1));
      return Array.from({ length: j - i + 1 }, (_, k) => `w${i + k}`);
    }));
    expect(kept.has('w16')).toBe(true);      // later, complete hook take
    expect(kept.has('w0')).toBe(false);      // earlier hook take dropped
    expect(kept.has('w10')).toBe(false);     // "let me try that again" dropped
    expect(kept.has('w56')).toBe(true);      // ending kept
    expect(p.music.track).toBe(track);
    expect(p.post.hashtags).toHaveLength(5);
    expect(p.broll.length).toBeGreaterThan(0);
    expect(r.summary.length).toBeGreaterThan(20);
    expect(r.summary).not.toMatch(/—/);
  }, LIVE ? 900_000 : 20_000);

  it.runIf(have('applyNote-bread'))('applyNote changes only the music and saves one style rule', async () => {
    const { dir, host, root } = await breadSetup();
    // start from a finished first edit
    const p0 = await loadProject(dir);
    p0.cut.keep = [{ from: 'w16', to: 'w56' }];
    p0.music = { ...p0.music, enabled: true, track: 'Library/Music/upbeat drums.mp3' };
    await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(p0, null, 2));
    const ai = createAI({ host, settingsDir: tmpDir(), providerOverride: model('applyNote-bread'), fetch: fakeFetch, lookup: async () => ['93.184.215.14'], finalRender: false });
    const r = await ai.applyNote(dir, 'the music is way too loud when I talk about the fridge, and I always want it quieter under my voice', () => undefined);
    const p = await loadProject(dir);
    expect(r.changed).toContain('music');
    expect(r.changed).not.toContain('cut');
    expect(p.cut.keep).toEqual([{ from: 'w16', to: 'w56' }]);
    expect(r.styleRulesAdded.length).toBe(1);
    expect(JSON.parse(await fsp.readFile(path.join(root, 'My style.json'), 'utf8')).rules).toHaveLength(1);
  }, LIVE ? 600_000 : 20_000);

  it.runIf(have('pickTakes-bread'))('pickTakes on the synthetic transcript', async () => {
    const { transcript } = await breadSetup();
    const r = await pickTakes({ ...transcript, retakes: [{ candidates: [{ from: 'w0', to: 'w8' }, { from: 'w16', to: 'w26' }] }] }, model('pickTakes-bread'));
    expect(r.keep[0].from).toBe('w16');
    expect(r.keep.at(-1)!.to).toBe('w56');
  }, LIVE ? 300_000 : 20_000);
});
