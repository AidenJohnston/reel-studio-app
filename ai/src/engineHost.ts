// A minimal EngineHost that spawns the Python engine (docs/architecture.md section 4). The Electron app has its
// own (bundled runtime, animation renderer); this one serves the CLI, dev runs and tests.
import { spawn, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { EngineHost, EngineProgress } from './types';
import { childEnv } from './safety';

export interface PythonEngineHostOptions {
  python?: string;              // default: $REELENGINE_PYTHON or "python"
  cwd?: string;                 // folder containing the `reelengine` package (engine/)
  root?: string;                // Reel Studio root; default ~/Documents/Reel Studio
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void; // stderr lines
  renderAnimation?: EngineHost['renderAnimation'];
}

export function defaultRoot(): string {
  return process.env.REELENGINE_ROOT ?? path.join(os.homedir(), 'Documents', 'Reel Studio');
}

/** Kill the engine AND its ffmpeg children. `child.kill()` on Windows ends python only; the
 * grandchildren keep encoding. Elsewhere the engine leads its own process group. */
export function killTree(pid: number | undefined, fallback: () => void): void {
  if (process.platform === 'win32' && pid) {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    if (r.status === 0) return;
  }
  if (process.platform !== 'win32' && pid) {
    try { process.kill(-pid, 'SIGTERM'); return; } catch { /* no group: the fallback */ }
  }
  fallback();
}

const groupAlive = (pid: number): boolean => {
  try { process.kill(-pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
};

/** After the engine exits (macOS/Linux): ends whatever is left in its process group, an ffmpeg a
 * crashed engine left behind, and reports whether all of it is gone. On Windows the engine's Job
 * Object ends its children with it (engine/reelengine/contain.py). */
async function drained(pid: number | undefined): Promise<boolean> {
  if (!pid || process.platform === 'win32') return true;
  for (const [signal, ms] of [['SIGTERM', 1500], ['SIGKILL', 5000]] as const) {
    if (!groupAlive(pid)) return true;
    try { process.kill(-pid, signal); } catch { /* gone meanwhile */ }
    for (const end = Date.now() + ms; Date.now() < end && groupAlive(pid);) await new Promise((r) => setTimeout(r, 50));
  }
  return !groupAlive(pid);
}

export class PythonEngineHost implements EngineHost {
  constructor(private readonly o: PythonEngineHostOptions = {}) {}
  reelStudioRoot(): string { return this.o.root ?? defaultRoot(); }

  async renderAnimation(template: string, params: Record<string, unknown>, outPath: string): Promise<string> {
    if (this.o.renderAnimation) return this.o.renderAnimation(template, params, outPath);
    throw { code: 'NO_ANIMATION_RENDERER', userMessage: 'Animations are only available in the app. Use a text card instead.' };
  }

  runEngine(command: string, args: string[], onProgress?: (p: EngineProgress) => void, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve, reject) => {
      // already cancelled: never start (an 'abort' listener added now would never fire)
      if (signal?.aborted) return reject({ code: 'cancelled', userMessage: 'Stopped.' });
      const py = this.o.python ?? process.env.REELENGINE_PYTHON ?? 'python';
      const child = spawn(py, ['-m', 'reelengine', command, ...args], {
        cwd: this.o.cwd, windowsHide: true, detached: process.platform !== 'win32',
        // no ANTHROPIC_* in the engine's environment
        env: childEnv(process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', REELENGINE_ROOT: this.reelStudioRoot(), ...(this.o.env ?? {}) }),
      });
      let buf = ''; let done: any; let error: any; let errTail = '';
      const onLine = (line: string) => {
        if (!line.trim()) return;
        let ev: any;
        try { ev = JSON.parse(line); } catch { this.o.log?.(`[stdout] ${line}`); return; }
        if (ev.event === 'progress') onProgress?.({ stage: ev.stage ?? command, pct: Number(ev.pct ?? 0), message: ev.message ?? '' });
        else if (ev.event === 'done') done = ev.result ?? {};
        else if (ev.event === 'error') error = { code: ev.code ?? 'ENGINE_ERROR', userMessage: ev.userMessage ?? 'Something went wrong making your video.', message: ev.message };
      };
      child.stdout.setEncoding('utf8').on('data', (d: string) => {
        buf += d;
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
      });
      child.stderr.setEncoding('utf8').on('data', (d: string) => {
        errTail = (errTail + d).slice(-4000);
        for (const l of d.split(/\r?\n/)) if (l) this.o.log?.(l);
      });
      const abort = () => killTree(child.pid, () => child.kill());
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', (e) => reject({ code: 'ENGINE_MISSING', userMessage: 'The video engine could not start.', message: e.message }));
      child.on('close', async (code) => {
        signal?.removeEventListener('abort', abort);
        if (buf) onLine(buf);
        if (!(await drained(child.pid))) {
          return reject({ code: 'ENGINE_STUCK', userMessage: 'Part of the video engine would not stop. Check for a leftover ffmpeg before you edit this video again.', message: `process group ${child.pid} is still alive after SIGKILL` });
        }
        if (signal?.aborted) return reject({ code: 'cancelled', userMessage: 'Stopped.' });
        if (error) return reject(error);
        if (code === 0 && done !== undefined) return resolve(done);
        reject({ code: 'ENGINE_CRASHED', userMessage: 'Something went wrong making your video. Try again.', message: `exit ${code}: ${errTail.slice(-800)}` });
      });
    });
  }
}
