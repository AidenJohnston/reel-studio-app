import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { EngineHost, EngineProgress, ToolContext, executeTool, Transcript, Word, withDefaults, Project, CompletionRequest, CompletionResponse, ModelProvider, ToolCall } from '../src';

export function tmpDir(prefix = 'rs ai '): string {
  // Spaces + non-ASCII on purpose (the dev box user folder has a space).
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}tést-`));
}

/** Builds a transcript from lines; each word ~0.3 s, 0.08 s gaps, `pauseAfter` seconds between lines. */
export function makeTranscript(lines: string[], pauseAfter = 0.9, source = 's1'): Transcript {
  const words: Word[] = [];
  let t = 0.1; let n = 0;
  for (const line of lines) {
    for (const w of line.split(/\s+/).filter(Boolean)) {
      words.push({ id: `w${n++}`, source, s: round(t), e: round(t + 0.3), w });
      t += 0.38;
    }
    t += pauseAfter;
  }
  return { words, language: 'en' };
}
const round = (x: number) => Math.round(x * 1000) / 1000;

export const SAMPLE_LINES = [
  'Nobody tells you the hardest part of baking bread',             // w0-w8 hook
  'okay wait let me try that again',                               // w9-w15 meta
  'Nobody tells you the hardest part of baking bread is waiting',  // w16-w26 retake of hook
  'I spent twenty bucks on a fancy flour',                          // w27-w34 (twenty bucks = w29-w30)
  'and my first loaf was a brick',                                  // w35-w41
  'so I tried the slow method',                                     // w42-w47
  'eighteen hours in the fridge',                                   // w48-w52
  'and it finally worked',                                          // w53-w56
];

export async function makeProject(opts: { root?: string; lines?: string[]; withAnalysis?: boolean; withTranscript?: boolean } = {}): Promise<{ root: string; dir: string; transcript: Transcript }> {
  const root = opts.root ?? tmpDir();
  for (const f of ['Raw takes', 'B-roll', 'Music', 'Images', 'Exports']) await fsp.mkdir(path.join(root, 'Library', f), { recursive: true });
  const dir = path.join(root, 'Projects', 'bread video');
  await fsp.mkdir(path.join(dir, 'work'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'media'), { recursive: true });
  const transcript = makeTranscript(opts.lines ?? SAMPLE_LINES);
  const p: Project = withDefaults({
    title: 'Baking bread', slug: 'baking-bread',
    sources: [{ id: 's1', path: 'media/take01.mp4', duration: 40, fps: 30, width: 1080, height: 1920, rotation: 0 }],
  });
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(p, null, 2));
  if (opts.withTranscript !== false) await fsp.writeFile(path.join(dir, 'work', 'transcript.json'), JSON.stringify(transcript));
  if (opts.withAnalysis !== false && opts.withTranscript !== false) {
    await fsp.writeFile(path.join(dir, 'work', 'analysis.json'), JSON.stringify({
      retakes: [{ id: 'r1', candidates: [{ from: 'w0', to: 'w8' }, { from: 'w16', to: 'w26' }] }],
      pauses: [{ after: 'w8', before: 'w9', s: 3.0, e: 3.9, dur: 0.9 }],
    }));
  }
  return { root, dir, transcript };
}

/** 8x8 solid PNG. */
export function tinyPng(rgb: [number, number, number] = [200, 30, 30]): Buffer {
  const w = 8, h = 8;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()])));
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Fake engine: enough of docs/architecture.md section 4 for the AI layer. Records every call. */
export class FakeHost implements EngineHost {
  calls: { command: string; args: string[] }[] = [];
  animations: { template: string; params: any; out: string }[] = [];
  failRender = false;
  searchResults: any[] = [];
  /** set to make `fetch-image` / `analyze-music` behave like a current engine (else: unknown command) */
  engineAssets = false;
  songInfo: any = { duration: 120, bpm: 92, energy: 'calm', tags: ['calm', 'warm'], suggestedStartAt: 7.5, arrivals: [{ at: 30, riseDb: 6 }], curve: [[0, -20]] };
  renderExtra: any = {};
  constructor(private readonly root: string, private readonly lines = SAMPLE_LINES) {}
  reelStudioRoot(): string { return this.root; }
  async renderAnimation(template: string, params: Record<string, unknown>, outPath: string): Promise<string> {
    this.animations.push({ template, params, out: outPath });
    await fsp.writeFile(outPath, 'fake animation');
    return outPath;
  }
  async runEngine(command: string, args: string[], onProgress?: (p: EngineProgress) => void): Promise<any> {
    this.calls.push({ command, args });
    const dir = args[args.indexOf('--project') + 1];
    const pj = path.join(dir, 'project.json');
    const p = JSON.parse(await fsp.readFile(pj, 'utf8'));
    onProgress?.({ stage: command, pct: 50, message: 'Working on it' });
    switch (command) {
      case 'transcribe': {
        await fsp.writeFile(path.join(dir, 'work', 'transcript.json'), JSON.stringify(makeTranscript(this.lines)));
        return { words: 1 };
      }
      case 'analyze': return { retakes: [], pauses: [] };
      case 'autocut': {
        const t = JSON.parse(await fsp.readFile(path.join(dir, 'work', 'transcript.json'), 'utf8'));
        p.cut.keep = [{ from: t.words[0].id, to: t.words.at(-1).id }];
        await fsp.writeFile(pj, JSON.stringify(p, null, 2));
        return { keep: p.cut.keep };
      }
      case 'render': {
        if (this.failRender) throw { code: 'RENDER_FAILED', userMessage: 'The video could not be made.' };
        // docs/versions.md: drafts overwrite versions/preview/ and never bump project.version
        const draft = args.includes('--draft');
        const v = (p.version ?? 0) + 1;
        if (!draft) {
          p.version = v;
          await fsp.writeFile(pj, JSON.stringify(p, null, 2));
        }
        const vd = path.join(dir, 'versions', draft ? 'preview' : `v${v}`);
        await fsp.mkdir(vd, { recursive: true });
        await fsp.writeFile(path.join(vd, draft ? 'draft.mp4' : 'export.mp4'), 'fake');
        return { version: v, preview: draft, draft, duration: 12.3, verify: { ok: true }, ...this.renderExtra };
      }
      case 'frames': {
        const times = args[args.indexOf('--times') + 1].split(',').map(Number);
        const fd = path.join(dir, 'work', 'frames');
        await fsp.mkdir(fd, { recursive: true });
        const frames = [];
        for (const t of times) { const f = path.join(fd, `f_${t}.png`); await fsp.writeFile(f, tinyPng()); frames.push({ time: t, path: f }); }
        return { frames };
      }
      case 'inspect-image': {
        const still = `work/thumbs/candidate-${randomUUID()}.jpg`;
        await fsp.mkdir(path.join(dir, 'work', 'thumbs'), { recursive: true });
        await fsp.writeFile(path.join(dir, still), tinyPng());
        return { previewPath: still, width: 8, height: 8 };
      }
      case 'search-images': return { results: this.searchResults };
      case 'fetch-image': {
        if (!this.engineAssets) throw { code: 'BAD_ARGS', userMessage: 'unknown command' };
        const url = args[args.indexOf('--url') + 1];
        if (!url.endsWith('.png')) throw { code: 'NOT_AN_IMAGE', userMessage: 'That link is a web page, not a picture.' };
        const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'image';
        await fsp.mkdir(path.join(dir, 'work', 'assets'), { recursive: true });
        await fsp.writeFile(path.join(dir, 'work', 'assets', `${name}.png`), tinyPng());
        return { asset: `work/assets/${name}.png`, path: path.join(dir, 'work', 'assets', `${name}.png`) };
      }
      case 'analyze-music': {
        if (!this.engineAssets) throw { code: 'BAD_ARGS', userMessage: 'unknown command' };
        return this.songInfo;
      }
      default: throw { code: 'UNKNOWN_COMMAND', userMessage: `unknown ${command}` };
    }
  }
}

/** Scripted fake model: each step returns the next canned reply (or a function of the request). */
export class ScriptedModel implements ModelProvider {
  readonly id = 'fake' as const;
  readonly supportsImages = true;
  requests: CompletionRequest[] = [];
  private i = 0;
  constructor(private readonly steps: (Partial<CompletionResponse> | ((req: CompletionRequest) => Partial<CompletionResponse>) | Error)[]) {}
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const s = this.steps[this.i++];
    if (!s) return { text: '', toolCalls: [{ id: 'auto_finish', name: 'finish', args: { summary_for_user: 'Done.' } }] };
    if (s instanceof Error) throw s;
    const r = typeof s === 'function' ? await s(req) : s;
    return { text: r.text ?? '', toolCalls: (r.toolCalls ?? []).map((c, k) => ({ id: c.id ?? `c${this.i}_${k}`, name: c.name, args: c.args })) as ToolCall[], ...(r.malformed ? { malformed: true } : {}) };
  }
}

export const call = (name: string, args: Record<string, unknown> = {}) => ({ id: undefined as any, name, args });

export async function commitImage(ctx: ToolContext, ref: string): Promise<string> {
  const staged = await executeTool(ctx, 'resolve_asset', { kind: 'image', intent: ref });
  if (staged.isError) throw new Error(staged.content);
  const candidate = JSON.parse(staged.content).candidates[0];
  const committed = await executeTool(ctx, 'resolve_asset', { kind: 'image', intent: ref, phase: 'commit', candidateId: candidate.id });
  if (committed.isError) throw new Error(committed.content);
  return JSON.parse(committed.content).asset.committedPath;
}
export function imageSteps(ref: string, placement: Record<string, unknown>) {
  const result = (req: CompletionRequest) => {
    const message = req.messages.at(-1);
    if (message?.role !== 'tool' || message.results[0].isError) throw new Error('Expected a successful asset tool result');
    return JSON.parse(message.results[0].content);
  };
  return [
    { toolCalls: [call('resolve_asset', { kind: 'image', intent: ref })] },
    (req: CompletionRequest) => ({ toolCalls: [call('resolve_asset', { kind: 'image', intent: ref, phase: 'commit', candidateId: result(req).candidates[0].id })] }),
    (req: CompletionRequest) => ({ toolCalls: [call('add_broll', { ...placement, asset: result(req).asset.assetId })] }),
  ];
}
