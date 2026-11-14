// Captions follow the locked script (engine/reelengine/scriptalign.py): what the AI is told about it.
// The engine stores its word mapping in work/script-align.json under a hash of the script and the
// transcript. The AI shows that mapping only while the hash still matches the current inputs, and
// reports the words as the captions draw them, after the person's caption corrections.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { CaptionCorrection, Project, Transcript, Word, keptWords, readJson } from './project';

/** scriptalign.VERSION: a mapping made by another version is not this one's. */
export const SCRIPT_ALIGN_VERSION = 3;
const SCRIPT_FILES = ['script.txt', 'script.md'];
const SCRIPT_FILE_MAX = 200_000;

export interface ScriptAlign {
  key: string; script: string; groups: { ids: string[]; words: string[] }[]; spans: [string, string][];
}
/** The script captions follow now, and the engine's mapping for it (null until the next caption build). */
export interface ScriptFollow { script: string; align: ScriptAlign | null }

const nonBlank = (x: unknown): x is string => typeof x === 'string' && x.trim() !== '';

/** scriptalign._hooked: the app's script object, `script` with the hook said first when `script` does not hold it.
 * A reel's plan (app shared/plan.ts planAsScript) carries its hook apart from its lines; the editor's script includes it. */
function hooked(hook: unknown, script: unknown): string {
  if (!nonBlank(script)) return '';
  return nonBlank(hook) && !script.includes(hook.trim()) ? `${hook.trim()}\n${script}` : script;
}

/** The locked script, as scriptalign.script_text finds it: the plan's script once locked (the creator's
 * rewrite, else the draft), else project.json `script` (text, or {text}), else script.txt / script.md. */
export async function currentScript(projectDir: string, p: Project): Promise<string> {
  const plan = p.plan as { script?: { locked?: unknown; rewrite?: unknown; draft?: unknown } } | undefined;
  const locked = plan?.script?.locked ? (plan.script.rewrite || plan.script.draft) : null;
  if (nonBlank(locked)) return locked;
  let sc = p.script as unknown;
  if (sc && typeof sc === 'object') sc = (sc as { text?: unknown }).text || hooked((sc as { hook?: unknown }).hook, (sc as { script?: unknown }).script) || '';
  if (nonBlank(sc)) return sc;
  for (const name of SCRIPT_FILES) {
    const file = path.join(projectDir, name);
    try {
      if (fs.statSync(file).isFile() && fs.statSync(file).size < SCRIPT_FILE_MAX) {
        // the engine reads text files with universal newlines
        return (await fsp.readFile(file, 'utf8')).replace(/\r\n?/g, '\n');
      }
    } catch { /* not there */ }
  }
  return '';
}

/** scriptalign._key: sha256 of [version, script, [[id, word]...]] as compact JSON. */
export function mappingKey(script: string, words: Pick<Word, 'id' | 'w'>[]): string {
  const material = [SCRIPT_ALIGN_VERSION, script, words.map((w) => [w.id, String(w.w).trim()])];
  return createHash('sha256').update(JSON.stringify(material), 'utf8').digest('hex');
}

/** What captions follow, null when they don't follow a script. The engine's mapping counts only when it
 * was made from exactly this script and these words. */
export async function scriptFollow(projectDir: string, p: Project, t: Transcript): Promise<ScriptFollow | null> {
  if (p.captions.followScript === false) return null;
  const script = await currentScript(projectDir, p);
  if (!script.trim()) return null;
  let align: ScriptAlign | null = null;
  try {
    const a = await readJson<ScriptAlign>(path.join(projectDir, 'work', 'script-align.json'));
    if (a?.key === mappingKey(script, t.words) && Array.isArray(a.groups) && Array.isArray(a.spans)) align = a;
  } catch { /* not built yet */ }
  return { script, align };
}

const bare = (w: string) => w.trim().replace(/^["'(\[¿¡]+/, '').replace(/[.,!?;:"')\]…]+$/, '').toLowerCase();
const heardKey = (text: string) => text.split(/\s+/).filter(Boolean).map(bare).join(' ');
const SINGLE = /^([^\p{L}\p{N}_]*)([\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)?)(.*)$/u;

/** One stretch of transcript words a caption correction rewrote: the text drawn for all of it ("" when it
 * was taken off the captions), and the id of its first word. */
export interface Fix { text: string; first: string }

/** What the person's caption corrections draw over transcript words, as captions.apply_corrections applies
 * them (a fix on one word, then phrases, then single words; a word fixed once is not fixed again): word id
 * -> the fix that covers it. */
export function correctedWords(t: Transcript, corrections: CaptionCorrection[]): Map<string, Fix> {
  const out = new Map<string, Fix>();
  const at = new Map(t.words.map((w, i) => [w.id, i]));
  const fix = (i: number, j: number, text: string) => {
    for (let k = i; k <= j; k++) out.set(t.words[k].id, { text, first: t.words[i].id });
  };
  const singles = new Map<string, string>();
  const phrases: { from: string[]; to: string }[] = [];
  for (const c of corrections ?? []) {
    const from = String(c.from ?? '').trim();
    const to = String(c.to ?? '').trim();
    if (c.at) {
      const i = at.get(c.at);
      const j = c.through ? at.get(c.through) : i;
      if (i === undefined || j === undefined) continue;
      const lo = Math.min(i, j); const hi = Math.max(i, j);
      if (heardKey(t.words.slice(lo, hi + 1).map((w) => w.w).join(' ')) === heardKey(from)) fix(lo, hi, to);
    } else if (from) {
      const hw = from.split(/\s+/); const mw = to.split(/\s+/).filter(Boolean);
      if (hw.length === 1 && mw.length === 1) singles.set(bare(hw[0]), mw[0]);
      else phrases.push({ from: hw.map(bare), to });
    }
  }
  for (let i = 0; i < t.words.length; i++) {
    for (const ph of phrases) {
      const span = t.words.slice(i, i + ph.from.length);
      if (span.length === ph.from.length && span.every((w, k) => bare(w.w) === ph.from[k] && !out.has(w.id))) {
        fix(i, i + span.length - 1, ph.to);
        i += span.length - 1;
        break;
      }
    }
  }
  for (const w of t.words) {
    const m = out.has(w.id) ? null : SINGLE.exec(String(w.w).trim());
    if (!m) continue;
    const [, lead, core, tail] = m;
    const base = core.split(/['’]/)[0];
    const text = singles.has(core.toLowerCase()) ? lead + singles.get(core.toLowerCase()) + tail
      : base !== core && singles.has(base.toLowerCase()) ? lead + singles.get(base.toLowerCase()) + core.slice(base.length) + tail
        : null;
    if (text !== null) out.set(w.id, { text, first: w.id });
  }
  return out;
}

/** The get_transcript section: the locked script, where the speech follows it, and each word the
 * captions draw differently from what was heard: the script's spelling where the cut plays the whole
 * group, or the person's correction where one covers it. */
export function scriptSection(t: Transcript, p: Project, follow: ScriptFollow, asData: (s: string) => string): string {
  let out = "\n\nLOCKED SCRIPT (the captions show the script's words wherever the speech follows it, at the audio's times; ad-libs and skipped lines show as said; caption corrections still win)\n"
    + `<script_data>\n${asData(follow.script.trim().slice(0, 2000))}\n</script_data>`;
  if (!follow.align) return `${out}\n(Which words follow it is worked out at the next caption build.)`;
  const said = new Map(t.words.map((w) => [w.id, String(w.w).trim()]));
  const fixed = correctedWords(t, p.captions.corrections);
  if (follow.align.spans.length) {
    out += `\nFOLLOWS THE SCRIPT: ${follow.align.spans.slice(0, 40).map(([x, y]) => (x === y ? x : `${x}-${y}`)).join(', ')}`;
  }
  // the words the cut plays, in order (the whole take before there is a cut)
  const kept = p.cut.keep.length ? keptWords(t, p.cut.keep).map((w) => w.id) : t.words.map((w) => w.id);
  const keptSet = new Set(kept);
  // captions.follow_script draws a group only where the cut plays all its words together, in order
  const drawn = (ids: string[]) => kept.some((id, k) => id === ids[0] && ids.every((x, n) => kept[k + n] === x));
  const pos = new Map(t.words.map((w, i) => [w.id, i]));
  const line = (ids: string[], shown: string, note = '') => {
    const range = ids.length > 1 ? `${ids[0]}-${ids[ids.length - 1]}` : ids[0];
    const heard = ids.map((i) => said.get(i) ?? '').join(' ');
    return shown === heard ? [] : [{ at: pos.get(ids[0]) ?? 0, text: `${asData(range)}: "${asData(heard)}" -> "${asData(shown)}"${note}` }];
  };
  const fixes = new Set<string>();      // corrections over words the script would draw, by their first word
  const changes = follow.align.groups.flatMap((g) => {
    const hit = g.ids.filter((i) => fixed.has(i));
    hit.forEach((i) => fixes.add(fixed.get(i)!.first));
    return hit.length || !drawn(g.ids) ? [] : line(g.ids, g.words.join(' '));
  });
  // each correction once, over every word it covers, as the engine draws it
  for (const first of fixes) {
    const ids = t.words.filter((w) => fixed.get(w.id)?.first === first).map((w) => w.id);
    if (ids.some((i) => keptSet.has(i))) changes.push(...line(ids, fixed.get(first)!.text, ' (a caption correction)'));
  }
  changes.sort((x, y) => x.at - y.at);
  if (changes.length) out += '\nCAPTIONS SHOW THE SCRIPT HERE (ids: heard -> shown)\n' + changes.slice(0, 40).map((c) => c.text).join('\n');
  return out;
}
