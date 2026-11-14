import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { EngineHost, EngineProgress, Transcript, Word, withDefaults, Project, CompletionRequest, CompletionResponse, ModelProvider, ToolCall, OWNER_LOCK, approxOutputTimes, ToolContext, executeTool } from '../src';
import { randomUUID, createHash } from 'node:crypto';

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

/** A JSON file as the engine reads it (project.py read_json): a leading byte-order mark is skipped. */
const readEngineJson = async (file: string): Promise<any> => JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));

/** A project after its first edit, as every note finds it: a cut, and (`render`) Version 1. */
export async function firstVersion(dir: string, host: FakeHost, render = true): Promise<void> {
  const pj = path.join(dir, 'project.json');
  const p = JSON.parse(await fsp.readFile(pj, 'utf8'));
  await fsp.writeFile(pj, JSON.stringify({ ...p, cut: { ...p.cut, keep: [{ from: 'w16', to: 'w56' }] } }, null, 2));
  if (render) await host.runEngine('render', ['--project', dir]);
  host.calls = [];
}

/** engine/reelengine/project.py edit_signature: what changes the rendered video. */
function editSignature(p: Record<string, unknown>): string {
  const { updatedAt: _u, version: _v, notes: _n, post: _p, createdAt: _c, ...edit } = p;
  return JSON.stringify(edit);
}

/** Fake engine: enough of docs/architecture.md section 4 for the AI layer. Records every call. */
export class FakeHost implements EngineHost {
  calls: { command: string; args: string[] }[] = [];
  animations: { template: string; params: any; out: string; fps?: number }[] = [];
  failRender = false;
  searchResults: any[] = [];
  /** the app's footage-folder import (EngineHost.importFootage); unset like the AI package on its own */
  importFootage?: (ref: string) => Promise<string>;
  /** set to make `fetch-image` / `analyze-music` behave like a current engine (else: unknown command) */
  engineAssets = false;
  songInfo: any = { duration: 120, bpm: 92, energy: 'calm', tags: ['calm', 'warm'], suggestedStartAt: 7.5, arrivals: [{ at: 30, riseDb: 6 }], curve: [[0, -20]] };
  renderExtra: any = {};
  /** merged into every `frames` answer: what the engine adds about the picture it looked at */
  framesExtra: any = {};
  /** every rules file a render was given (`--rules`) */
  rulesFiles: any[] = [];
  /** where a checked rule fails on this project, or null: the stand-in for rule_checks.py's checkers */
  ruleFails: (rule: { id: string; text: string; check: any }, p: any) => Record<string, unknown> | null = () => null;
  /** rule_checks.py `measure` for this project */
  measured: (p: any) => Record<string, unknown> = (p) => ({
    'captions.maxWords': p.captions.enabled ? p.captions.style.maxWords : null, 'captions.maxSize': p.captions.enabled ? p.captions.style.size : null,
    'captions.minSize': p.captions.enabled ? p.captions.style.size : null, 'music.underVoiceDb': p.music?.track ? 19.3 : null,
    'broll.keepOut.face': 0, 'broll.keepOut.eyes': 0,
  });
  /** `match-joins`: the first words of the ranges whose join lines up as a match cut */
  matchable = new Set<string>();
  /** runs after a render wrote its files, before it reports (Stop or a crash mid-render) */
  afterRenderFiles?: (r: { draft: boolean; dir: string }) => Promise<void> | void;
  /** what `inspect-render` answers per render id: that render's word times and layer records */
  private readonly rendered = new Map<string, { words: { id: string; s: number; e: number }[]; layers: unknown[] }>();
  constructor(private readonly root: string, private readonly lines = SAMPLE_LINES) {}
  reelStudioRoot(): string { return this.root; }
  private async fingerprint(dir: string): Promise<string> {
    const t = await fsp.stat(path.join(dir, 'work', 'transcript.json')).catch(() => null);
    return JSON.stringify(t ? [t.size, t.mtimeMs] : null);
  }
  /** --asset as the engine's safe_resolve reads it: Library/... from the root, anything else from the project */
  private assetFile(dir: string, args: string[]): string {
    const ref = args[args.indexOf('--asset') + 1];
    return path.isAbsolute(ref) ? ref : ref.startsWith('Library/') ? path.join(this.root, ref) : path.join(dir, ref);
  }
  async renderAnimation(template: string, params: Record<string, unknown>, outPath: string, fps?: number): Promise<string> {
    this.animations.push({ template, params, out: outPath, fps });
    await fsp.writeFile(outPath, 'fake animation');
    return outPath;
  }
  async runEngine(command: string, args: string[], onProgress?: (p: EngineProgress) => void): Promise<any> {
    this.calls.push({ command, args });
    const dir = args[args.indexOf('--project') + 1];
    // like engine/reelengine/owner.py: run by hand (no --owner) while Reel Studio has the project open
    if (!args.includes('--owner') && fs.existsSync(path.join(dir, OWNER_LOCK))) {
      throw { code: 'PROJECT_OPEN', userMessage: 'Reel Studio may be using this project.' };
    }
    const pj = args.includes('--project-file') ? args[args.indexOf('--project-file') + 1] : path.join(dir, 'project.json');
    const p = await readEngineJson(pj);
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
      case 'lint-edit': return { fixed: [], issues: [] };
      case 'match-joins': {
        const keep = args.includes('--keep') ? JSON.parse(args[args.indexOf('--keep') + 1]) : p.cut.keep;
        const every = args.includes('--every');
        return { joins: keep.flatMap((k: any, i: number) => (i && !('clip' in k) && (every || ['match', 'action'].includes(k.join?.transition))
          ? [this.matchable.has(k.from) ? { keep: i, matched: true, at: i * 2 } : { keep: i, matched: false, at: i * 2, why: 'the speaker moves too much across the cut' }]
          : [])) };
      }
      case 'render': {
        if (this.failRender) throw { code: 'RENDER_FAILED', userMessage: 'The video could not be made.' };
        // docs/versions.md: a draft goes to --out (default versions/preview/) and never bumps the
        // version; a final of an unchanged edit returns its saved version, else starts v(N+1) afresh,
        // snapshots the edit, then patches `version` into the project file it rendered
        const draft = args.includes('--draft');
        const mergeParent = args.includes('--merge-parent') ? Number(args[args.indexOf('--merge-parent') + 1]) : undefined;
        const parent = args.includes('--parent') ? Number(args[args.indexOf('--parent') + 1]) : p.version || null;
        const saved = path.join(dir, 'versions', `v${p.version}`);
        const snapshot = !draft && p.version ? await fsp.readFile(path.join(saved, 'project.json'), 'utf8').catch(() => null) : null;
        // render.py asset_fingerprint: the files the edit reads must be unchanged too (here the transcript);
        // a version with no assets.json is compared by its edit alone
        const files = await fsp.readFile(path.join(saved, 'assets.json'), 'utf8').catch(() => null);
        if (mergeParent === undefined && parent === p.version && snapshot && editSignature(JSON.parse(snapshot)) === editSignature(p) && (files === null || files === await this.fingerprint(dir))) {
          return { version: p.version, preview: false, draft: false, file: path.join(saved, 'export.mp4'), reused: true };
        }
        const v = (p.version ?? 0) + 1;
        // like render.py: a note's copy never renders over a version project.json saved since it was made
        if (!draft && args.includes('--project-file') && v <= (await readEngineJson(path.join(dir, 'project.json'))).version) {
          throw { code: 'PROJECT_CHANGED', userMessage: 'Your video was changed somewhere else while I worked on your note.' };
        }
        let ruleChecks: any;
        if (args.includes('--rules')) {
          const rules = JSON.parse(await fsp.readFile(args[args.indexOf('--rules') + 1], 'utf8'));
          this.rulesFiles.push({ ...rules, draft });
          const failures = rules.rules.flatMap((r: any) => {
            const place = this.ruleFails(r, p);
            return place ? [{ id: r.id, kind: r.check.kind, count: 1, places: [{ t0: 1, t1: 2, ...place }] }] : [];
          });
          ruleChecks = { ok: !failures.length, checked: rules.rules.length, checkedIds: rules.rules.map((r: any) => r.id), failures, measured: this.measured(p) };
          // render.py: a final render stops before its encode on a rule it was asked to stop on, leaving no version folder
          if (!draft && failures.some((f: any) => rules.stopOn.includes(f.id))) return { version: v, preview: false, draft, encoded: false, ruleChecks };
        }
        const vd = draft ? (args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(dir, 'versions', 'preview')) : path.join(dir, 'versions', `v${v}`);
        if (!draft) await fsp.rm(vd, { recursive: true, force: true });
        await fsp.mkdir(vd, { recursive: true });
        const file = path.join(vd, draft ? 'draft.mp4' : 'export.mp4');
        await fsp.writeFile(file, 'fake');
        await fsp.writeFile(path.join(vd, 'project.json'), JSON.stringify(p, null, 2));
        if (!draft) await fsp.writeFile(path.join(vd, 'assets.json'), await this.fingerprint(dir));
        if (!draft) await fsp.writeFile(path.join(vd, 'version.json'), JSON.stringify({ parent, ...(mergeParent === undefined ? {} : { parents: [parent, mergeParent] }) }));
        await this.afterRenderFiles?.({ draft, dir: vd });
        // like the engine: its own steps, the last one saying the video is ready
        for (const [pct, message] of [[12, 'Placing your pictures'], [90, 'Making your cover'], [100, 'Your video is ready']] as const) onProgress?.({ stage: 'render', pct, message });
        if (!draft) {
          p.version = v;
          await fsp.writeFile(pj, JSON.stringify(p, null, 2));
        }
        const renderId = `r_${randomUUID().replaceAll('-', '')}`;
        const { cut } = withDefaults(p);
        const words = await fsp.readFile(path.join(dir, 'work', 'transcript.json'), 'utf8')
          .then((s) => [...approxOutputTimes(JSON.parse(s), cut.keep, cut.gapCap)].map(([id, w]) => ({ id, ...w })), () => []);
        const layers = await fsp.readFile(path.join(dir, 'work', 'layers', 'layers.json'), 'utf8').then((s) => JSON.parse(s).items, () => []);
        this.rendered.set(renderId, { words, layers });
        await fsp.writeFile(path.join(vd, draft ? 'render_draft.json' : 'render.json'), JSON.stringify({ renderId, file: draft ? 'draft.mp4' : 'export.mp4' }));
        const jobId = args.includes('--job-id') ? args[args.indexOf('--job-id') + 1] : null;
        return { renderId, version: v, preview: draft, draft, encoded: true, file, duration: 12.3, verify: { ok: true }, receipt: { jobId, renderId, version: v, facts: [] }, ...(ruleChecks ? { ruleChecks } : {}), ...this.renderExtra };
      }
      case 'inspect-render': {
        const r = this.rendered.get(args[args.indexOf('--render-id') + 1]);
        if (!r) throw { code: 'RENDER_MISMATCH', userMessage: 'That preview was replaced by a newer one.' };
        return { timeline: { words: r.words }, layers: r.layers };
      }
      case 'frames': {
        const times = args.includes('--times') ? args[args.indexOf('--times') + 1].split(',').map(Number) : [];
        // like frames.py: without a render id, --words are found on the edit's own timeline
        if (args.includes('--words')) {
          const { cut } = withDefaults(p);
          const at = approxOutputTimes(JSON.parse(await fsp.readFile(path.join(dir, 'work', 'transcript.json'), 'utf8')), cut.keep, cut.gapCap);
          for (const id of args[args.indexOf('--words') + 1].split(',')) {
            const w = at.get(id);
            if (!w) throw { code: 'BAD_ARGS', userMessage: `Word ${id} is not in the cut.` };
            times.push(Math.round(((w.s + w.e) / 2) * 100) / 100);
          }
        }
        const fd = path.join(dir, 'work', 'frames');
        await fsp.mkdir(fd, { recursive: true });
        const frames = [];
        for (const t of times) { const f = path.join(fd, `f_${t}.png`); await fsp.writeFile(f, tinyPng()); frames.push({ time: t, path: f }); }
        return { frames, ...this.framesExtra };
      }
      case 'inspect-video':
      case 'inspect-audio':
      case 'inspect-image': {
        const file = this.assetFile(dir, args);
        const { mime } = fakeMediaKind(file, await fsp.readFile(file), command === 'inspect-video' ? 'video' : command === 'inspect-audio' ? 'music' : 'image');
        const still = args.includes('--preview') ? args[args.indexOf('--preview') + 1] : `work/thumbs/candidate-${randomUUID()}.jpg`;
        await fsp.mkdir(path.join(dir, 'work', 'thumbs'), { recursive: true });
        await fsp.writeFile(path.join(dir, still), tinyPng());
        return { previewPath: still, width: 8, height: 8, durationSec: 2, loudnessLufs: -21, sha256: await sha256File(file), mime };
      }
      case 'freeze-asset': {
        // like engine/reelengine/asset_freeze.py: copy, hash the copy, reuse a frozen file with the same bytes
        const file = this.assetFile(dir, args);
        const kind = args[args.indexOf('--kind') + 1];
        const bytes = await fsp.readFile(file);
        const { ext, mime } = fakeMediaKind(file, bytes, kind);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const expect = args.includes('--expect-sha256') ? args[args.indexOf('--expect-sha256') + 1] : null;
        if (expect && expect !== sha256) throw { code: 'ASSET_CHANGED', userMessage: 'The asset changed after its preview. Resolve it again.' };
        const frozen = path.join(dir, 'work', 'assets', 'frozen');
        const kinds = await fsp.readdir(frozen, { withFileTypes: true }).catch(() => []);
        for (const k of kinds.filter((d) => d.isDirectory())) {
          for (const f of await fsp.readdir(path.join(frozen, k.name))) {
            if (f.startsWith(`${sha256}.`) && await sha256File(path.join(frozen, k.name, f)) === sha256) {
              return { committedPath: `work/assets/frozen/${k.name}/${f}`, sha256, mime, size: bytes.length };
            }
          }
        }
        const committedPath = `work/assets/frozen/${kind}/${sha256}.${ext}`;
        await fsp.mkdir(path.join(frozen, kind), { recursive: true });
        await fsp.writeFile(path.join(dir, committedPath), bytes);
        return { committedPath, sha256, mime, size: bytes.length };
      }
      case 'hash-asset': return { sha256: await sha256File(this.assetFile(dir, args)) };
      case 'search-images': return { results: this.searchResults };
      case 'fetch-image': {
        if (!this.engineAssets) throw { code: 'BAD_ARGS', userMessage: 'unknown command' };
        const url = args[args.indexOf('--url') + 1];
        if (!url.endsWith('.png')) throw { code: 'NOT_AN_IMAGE', userMessage: 'That link is a web page, not a picture.' };
        const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'image';
        await fsp.mkdir(path.join(dir, 'work', 'assets'), { recursive: true });
        await fsp.writeFile(path.join(dir, 'work', 'assets', `${name}.png`), tinyPng());
        // like the engine: a still of the download, named after it
        const thumb = path.join(dir, 'work', 'thumbs', `${name}.jpg`);
        await fsp.mkdir(path.dirname(thumb), { recursive: true });
        await fsp.writeFile(thumb, tinyPng());
        return { asset: `work/assets/${name}.png`, path: path.join(dir, 'work', 'assets', `${name}.png`), thumb };
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
  constructor(private readonly steps: (Partial<CompletionResponse> | ((req: CompletionRequest) => Partial<CompletionResponse> | Promise<Partial<CompletionResponse>>) | Error)[]) {}
  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const s = this.steps[this.i++];
    if (!s) return { text: '', toolCalls: [{ id: 'auto_finish', name: 'finish', args: { summary_for_user: 'Done.' } }] };
    if (s instanceof Error) throw s;
    const r = typeof s === 'function' ? await s(req) : s;
    return { text: r.text ?? '', toolCalls: (r.toolCalls ?? []).map((c, k) => ({ id: c.id ?? `c${this.i}_${k}`, name: c.name, args: c.args })) as ToolCall[], ...(r.malformed ? { malformed: true } : {}), ...(r.provenance ? { provenance: r.provenance } : {}) };
  }
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex');
}
/** The engine's kind check (asset_freeze.kind_of), by magic bytes and extension. */
function fakeMediaKind(file: string, bytes: Buffer, kind: string): { ext: string; mime: string } {
  const head = bytes.subarray(0, 16).toString('latin1');
  if (kind === 'video' || kind === 'music') {
    const ext = path.extname(file).toLowerCase().slice(1);
    const table: Record<string, string> = kind === 'video' ? { mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm' }
      : { wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg' };
    const container = head.slice(4, 8) === 'ftyp' || /^(RIFF|OggS|fLaC|ID3)/.test(head) || bytes.readUInt32BE(0) === 0x1a45dfa3;
    if (!table[ext] || !container) throw { code: 'BAD_MEDIA', userMessage: 'That file is not the requested media kind.' };
    return { ext, mime: table[ext] };
  }
  if (head.startsWith('\x89PNG')) return { ext: 'png', mime: 'image/png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { ext: 'jpg', mime: 'image/jpeg' };
  if (head.startsWith('GIF8')) return { ext: 'gif', mime: 'image/gif' };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  throw { code: 'BAD_MEDIA', userMessage: 'That file is not an image. Choose a PNG, JPEG, GIF or WebP.' };
}

export const call = (name: string, args: Record<string, unknown> = {}) => ({ id: undefined as any, name, args });

export async function commitLocalAsset(ctx: ToolContext, ref: string, kind = 'image'): Promise<string> {
  const staged = await executeTool(ctx, 'resolve_asset', { kind, intent: ref });
  if (staged.isError) throw new Error(staged.content);
  const candidate = JSON.parse(staged.content).candidates[0];
  const committed = await executeTool(ctx, 'resolve_asset', { kind, intent: ref, phase: 'commit', candidateId: candidate.id });
  if (committed.isError) throw new Error(committed.content);
  return JSON.parse(committed.content).asset.committedPath;
}
export const commitImage = (ctx: ToolContext, ref: string) => commitLocalAsset(ctx, ref);
export const tinyMp3 = () => Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]);
export const tinyMp4 = () => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
export function assetSteps(ref: string, placement: Record<string, unknown>, kind = 'image') {
  const result = (req: CompletionRequest) => {
    const message = req.messages.at(-1);
    if (message?.role !== 'tool' || message.results[0].isError) throw new Error('Expected a successful asset tool result');
    return JSON.parse(message.results[0].content);
  };
  return [
    { toolCalls: [call('resolve_asset', { kind, intent: ref })] },
    (req: CompletionRequest) => ({ toolCalls: [call('resolve_asset', { kind, intent: ref, phase: 'commit', candidateId: result(req).candidates[0].id })] }),
    (req: CompletionRequest) => ({ toolCalls: [call('add_broll', { ...placement, asset: result(req).asset.assetId })] }),
  ];
}
