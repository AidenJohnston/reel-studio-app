// The dev CLI's engine host (engineHost.ts) against a stand-in engine that crashes and leaves a child
// running, as a crashed render leaves its ffmpeg (app/test/fixtures/sleeper).
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { PythonEngineHost } from '../src';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('PythonEngineHost', () => {
  // Windows has no process groups: there the engine's Job Object ends its children (engine contain.py)
  it.skipIf(process.platform === 'win32')('an engine that crashes settles only after what it started has been stopped', async () => {
    const host = new PythonEngineHost({ python: process.env.REELENGINE_PYTHON ?? 'python3', cwd: path.join(__dirname, '..', '..', 'app', 'test', 'fixtures', 'sleeper') });
    let child = 0;
    await expect(host.runEngine('crash', [], (p) => { child = Number(p.message); })).rejects.toMatchObject({ code: 'ENGINE_CRASHED' });
    expect(child).toBeGreaterThan(0);
    expect(alive(child)).toBe(false);
  }, 30000);
});
