import { it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createAI, ClaudeCodeHarness, ClaudeCliProvider, listVersions } from '../src';
import { CodexHarness } from '../src/mcp/codex';
import { SessionHarness } from '../src/mcp/session';
import { FakeHost, ScriptedModel, firstVersion, makeProject, tmpDir } from './helpers';

async function setup(kind: 'claude' | 'codex', scenario: Record<string, unknown>) {
  const { root, dir } = await makeProject();
  const host = new FakeHost(root);
  await firstVersion(dir, host);
  const work = tmpDir('harness session ');
  const file = path.join(work, 'scenario.json');
  const argvFile = path.join(work, 'argv.json');
  const starts = path.join(work, 'starts');
  await fs.writeFile(file, JSON.stringify({ ...scenario, argvFile, starts, pidFile: path.join(work, 'pids'), inbox: path.join(work, 'inbox') }));
  const options = { bin: process.execPath, binArgs: [path.join(__dirname, `fake-${kind}-mcp.js`)], extraArgs: ['--scenario', file], timeoutMs: 5000 };
  const harness = kind === 'claude' ? new ClaudeCodeHarness(options) : new CodexHarness(options);
  return { root, dir, host, harness, argvFile, starts };
}

it('probes Claude once before editing, without exposing the note to the probe', async () => {
  const s = await setup('claude', { probe: 'pass', turns: [[{ name: 'set_caption_style', args: { case: 'lower' } }, { name: 'finish', args: { summary_for_user: 'Lowercase.' } }]] });
  const model = new ScriptedModel([]);
  const ai = createAI({ host: s.host, settingsDir: tmpDir(), providerOverride: model, harnessOverride: new SessionHarness(s.harness, () => model) });
  await ai.applyNote(s.dir, 'lowercase subtitles', () => undefined);
  await ai.applyNote(s.dir, 'lowercase subtitles', () => undefined);
  expect((await fs.readFile(s.starts, 'utf8')).trim().split('\n')).toEqual(['probe', 'note', 'note']);
  expect(model.requests).toHaveLength(0);
  const firstInput = (await fs.readFile(path.join(path.dirname(s.starts), 'inbox'), 'utf8')).split('\n---\n')[0];
  expect(firstInput).toMatch(/Call harness_probe with nonce/);
  expect(firstInput).not.toContain('lowercase subtitles');
  expect(JSON.parse(await fs.readFile(path.join(s.dir, 'project.json'), 'utf8')).captions.style.case).toBe('lower');
});

it.each(['refused', 'no-roundtrip'])('falls back for the whole session when the startup probe is %s', async (probe) => {
  const s = await setup('claude', { probe, turns: [] });
  const model = new ScriptedModel([
    { toolCalls: [{ id: 'f1', name: 'finish', args: { summary_for_user: 'Fallback one.' } }] },
    { toolCalls: [{ id: 'f2', name: 'finish', args: { summary_for_user: 'Fallback two.' } }] },
  ]);
  const ai = createAI({ host: s.host, settingsDir: tmpDir(), providerOverride: model, harnessOverride: new SessionHarness(s.harness, () => model) });
  const statuses: string[] = [];
  const event = (e: { type: string; message?: string }) => { if (e.type === 'status') statuses.push(e.message ?? ''); };
  expect((await ai.applyNote(s.dir, 'one', event)).summary).toMatch(/^Fallback one\./);
  expect((await ai.applyNote(s.dir, 'two', event)).summary).toMatch(/^Fallback two\./);
  expect((await fs.readFile(s.starts, 'utf8')).trim().split('\n')).toEqual(['probe']);
  expect(statuses.join('\n')).toMatch(/claude-code.*self-test.*(?:failed|harness_|round.trip)/i);
  expect(model.requests).toHaveLength(2);
});

it('runs Codex through the relay under read-only sandbox with shell and image tools switched off', async () => {
  const s = await setup('codex', { turns: [[{ name: 'set_caption_style', args: { case: 'lower' } }, { name: 'finish', args: { summary_for_user: 'Codex lowercase.' } }]] });
  const model = new ScriptedModel([]);
  const ai = createAI({ host: s.host, settingsDir: tmpDir(), providerOverride: model, harnessOverride: s.harness });
  const result = await ai.applyNote(s.dir, 'lowercase subtitles', () => undefined);
  expect(result.summary).toBe('Codex lowercase.');
  expect(await listVersions(s.dir)).toEqual([1, 2]);
  expect(model.requests).toHaveLength(0);
  const argv: string[] = JSON.parse(await fs.readFile(s.argvFile, 'utf8'));
  expect(argv.slice(0, 2)).toEqual(['--no-daemon', 'exec']);
  expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
  expect(argv).toEqual(expect.arrayContaining(['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules']));
  for (const name of ['shell_tool', 'unified_exec', 'memories', 'apps', 'plugins', 'multi_agent', 'view_image']) {
    expect(argv.some((value, i) => value === '--disable' && argv[i + 1] === name)).toBe(true);
  }
  expect(argv.some((x) => /bypass|danger-full-access/.test(x))).toBe(false);
  expect(argv).toContain('--strict-config');
  expect(argv.some((x) => x.startsWith('mcp_servers.reelstudio.enabled_tools='))).toBe(true);
});

it('does not save a Codex note over its token budget', async () => {
  const s = await setup('codex', { turns: [[{ name: 'set_caption_style', args: { case: 'lower' } }, { name: 'finish', args: { summary_for_user: 'Done.' } }]] });
  const before = await fs.readFile(path.join(s.dir, 'project.json'), 'utf8');
  const ai = createAI({ host: s.host, settingsDir: tmpDir(), providerOverride: new ScriptedModel([]), harnessOverride: s.harness, tokenBudget: 1 });
  await expect(ai.applyNote(s.dir, 'lowercase', () => undefined)).rejects.toMatchObject({ code: 'token_budget' });
  expect(await fs.readFile(path.join(s.dir, 'project.json'), 'utf8')).toBe(before);
});

it('Stop drains a Codex process and relay without saving', async () => {
  const s = await setup('codex', { turns: [[{ name: 'set_gap_cap', args: { seconds: 0.4 } }, 'hang']] });
  const before = await fs.readFile(path.join(s.dir, 'project.json'), 'utf8');
  const ac = new AbortController();
  const ai = createAI({ host: s.host, settingsDir: tmpDir(), providerOverride: new ScriptedModel([]), harnessOverride: s.harness });
  await expect(ai.applyNote(s.dir, 'slower', (e) => { if (e.type === 'tool') ac.abort(); }, ac.signal)).rejects.toMatchObject({ code: 'cancelled' });
  const pids = JSON.parse(await fs.readFile(path.join(path.dirname(s.argvFile), 'pids'), 'utf8'));
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  expect([alive(pids.codex), alive(pids.relay)]).toEqual([false, false]);
  expect(await fs.readFile(path.join(s.dir, 'project.json'), 'utf8')).toBe(before);
});

it('logs why Codex is unavailable before using the session text fallback', async () => {
  const s = await setup('codex', { error: 'Selected model is at capacity. Please try a different model.', turns: [] });
  const model = new ScriptedModel([{ toolCalls: [{ id: 'f', name: 'finish', args: { summary_for_user: 'Fallback.' } }] }]);
  const ai = createAI({ host: s.host, settingsDir: tmpDir(), providerOverride: model, harnessOverride: new SessionHarness(s.harness, () => model) });
  const statuses: string[] = [];
  const result = await ai.applyNote(s.dir, 'hello', (e) => { if (e.type === 'status') statuses.push(e.message); });
  expect(result.summary).toMatch(/^Fallback\./);
  expect(statuses.join('\n')).toMatch(/self-test failed.*capacity/i);
});

it('keeps concurrent text fallbacks in separate CLI sessions', async () => {
  const s = await setup('claude', { probe: 'refused', turns: [] });
  const other = await makeProject();
  await firstVersion(other.dir, s.host);
  const work = path.dirname(s.starts);
  const script = path.join(work, 'text-claude.cjs');
  const ready = path.join(work, 'text-ready');
  const gate = path.join(work, 'text-gate');
  const interrupted = path.join(work, 'text-interrupted');
  const release = path.join(work, 'text-release');
  await fs.writeFile(script, `
    const fs = require('node:fs');
    const ready = ${JSON.stringify(ready)}, gate = ${JSON.stringify(gate)};
    let replied = false, second = false;
    const answer = () => {
      if (replied || !fs.existsSync(gate) || (second && !fs.existsSync(${JSON.stringify(release)}))) return;
      replied = true;
      process.stdout.write(JSON.stringify({type:'result',is_error:false,result:JSON.stringify({tool_calls:[{name:'finish',arguments:{summary_for_user:'Separate fallback.'}}]})})+'\\n');
      watcher.close();
    };
    const watcher = fs.watch(${JSON.stringify(work)}, answer);
    process.stdin.once('data', (data) => {
      second = data.toString().includes('second note');
      fs.appendFileSync(ready, 'ready\\n');
      if (fs.readFileSync(ready, 'utf8').trim().split('\\n').length === 2) fs.writeFileSync(gate, 'go');
      answer();
    });
    process.stdin.on('end', () => { if (!replied) fs.appendFileSync(${JSON.stringify(interrupted)}, 'interrupted\\n'); process.exit(0); });
  `);
  const ai = createAI({ host: s.host, settingsDir: tmpDir(), providerOverride: new ScriptedModel([]),
    harnessOverride: new SessionHarness(s.harness, () => new ClaudeCliProvider({ bin: process.execPath, binArgs: [script], session: true })) });
  const first = ai.applyNote(s.dir, 'first note', () => undefined);
  const second = ai.applyNote(other.dir, 'second note', () => undefined);
  const results = [await first];
  await fs.writeFile(release, 'go');
  results.push(await second);
  expect(results.map((r) => r.summary)).toEqual(['Separate fallback.', 'Separate fallback.']);
  expect(await fs.readFile(interrupted, 'utf8').catch(() => '')).toBe('');
});
