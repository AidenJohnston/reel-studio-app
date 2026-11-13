// Checkable My style rules: the machine form a rule can carry next to its words. The engine measures it on every
// render (engine/reelengine/lint.py, `render --rules`) and a note can't finish while one it should meet fails.
// Both sides validate the same forms: their tests share engine/tests/rule_checks.json.
import * as path from 'node:path';
import { S } from './schema';

export type RuleCheck =
  | { kind: 'captions.maxWords'; value: number }
  | { kind: 'captions.maxSize'; value: number }
  | { kind: 'captions.minSize'; value: number }
  | { kind: 'music.underVoiceDb'; value: number }
  | { kind: 'broll.keepOut'; zone: 'face' | 'eyes' };
export type RuleKind = RuleCheck['kind'];

/** The rules file `render --rules` reads. */
export const RULES_FILE_VERSION = 1;

type Field = { min: number; max: number; integer?: boolean } | { oneOf: readonly string[] };
const KINDS: Record<RuleKind, Record<string, Field>> = {
  'captions.maxWords': { value: { min: 1, max: 4, integer: true } },
  'captions.maxSize': { value: { min: 80, max: 160 } },
  'captions.minSize': { value: { min: 80, max: 160 } },
  'music.underVoiceDb': { value: { min: 12, max: 30 } },
  'broll.keepOut': { zone: { oneOf: ['face', 'eyes'] } },
};

/** The machine form, strictly validated: an unknown kind or field throws, naming the problem. */
export function parseCheck(x: unknown): RuleCheck {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error('check: expected an object');
  const c = x as Record<string, unknown>;
  const kind = c.kind as RuleKind;
  if (typeof kind !== 'string' || !Object.hasOwn(KINDS, kind)) {
    throw new Error(`check.kind: unknown kind ${JSON.stringify(c.kind)}; known kinds: ${Object.keys(KINDS).sort().join(', ')}`);
  }
  const fields = KINDS[kind];
  const extra = Object.keys(c).filter((k) => k !== 'kind' && !Object.hasOwn(fields, k));
  if (extra.length) throw new Error(`check: unknown field(s) ${extra.join(', ')} for ${kind}`);
  const out: Record<string, unknown> = { kind };
  for (const [name, f] of Object.entries(fields)) {
    if (!(name in c)) throw new Error(`check.${name}: missing for ${kind}`);
    const val = c[name];
    if ('oneOf' in f) {
      if (typeof val !== 'string' || !f.oneOf.includes(val)) throw new Error(`check.${name}: must be one of ${f.oneOf.join(', ')}`);
    } else {
      if (typeof val !== 'number' || !Number.isFinite(val) || (f.integer && !Number.isInteger(val))) {
        throw new Error(`check.${name}: expected ${f.integer ? 'a whole number' : 'a number'}`);
      }
      if (val < f.min || val > f.max) throw new Error(`check.${name}: must be between ${f.min} and ${f.max}`);
    }
    out[name] = val;
  }
  return out as RuleCheck;
}

const fmtNum = (n: number) => String(Math.round(n * 10) / 10);

/** A checked rule's words. They are the app's, never the AI's, so the rule promises only what is measured. */
export function ruleText(c: RuleCheck): string {
  switch (c.kind) {
    case 'captions.maxWords': return c.value === 1 ? 'Show captions one word at a time.' : `Show at most ${c.value} words in a caption.`;
    case 'captions.maxSize': return `Keep captions at most ${fmtNum(c.value)} px tall.`;
    case 'captions.minSize': return `Keep captions at least ${fmtNum(c.value)} px tall.`;
    case 'music.underVoiceDb': return `Keep the music at least ${fmtNum(c.value)} dB under my voice.`;
    case 'broll.keepOut': return c.zone === 'eyes' ? 'Never cover my eyes, nose or mouth with a picture.' : 'Never cover my face with a picture.';
  }
}

/** What add_style_rule may ask the app to check. The value is never the AI's: it comes from the finished video. */
export const CHECK_CHOICES = ['captions.maxWords', 'captions.maxSize', 'captions.minSize', 'music.underVoiceDb', 'broll.keepOut.face', 'broll.keepOut.eyes'] as const;
export type CheckChoice = (typeof CHECK_CHOICES)[number];

export const CHECK_PARAM = S.opt(S.enum(CHECK_CHOICES, [
  'Only when the rule is exactly one of these measurable habits; null for anything else (taste, wording, pacing).',
  'captions.maxWords = few words per caption; captions.maxSize = captions no bigger; captions.minSize = captions no smaller;',
  'music.underVoiceDb = music stays this far under the voice; broll.keepOut.face = no picture on the face at all, full-frame',
  'pictures included; broll.keepOut.eyes = nothing over the eyes, nose and mouth. The app takes the number from the',
  'finished video and checks it after every render from then on.',
].join(' ')));

/** What a render measured (lint.py `measure`). */
export interface Measured {
  'captions.maxWords': number | null; 'captions.maxSize': number | null; 'captions.minSize': number | null;
  'music.underVoiceDb': number | null; 'broll.keepOut.face': number; 'broll.keepOut.eyes': number;
}

/** A rule for `choice` that the measured video already meets, or null when this video can't give one (no captions,
 * no music, a picture already on the face, or a number outside what a rule allows). */
export function checkFromMeasured(choice: CheckChoice, m: Partial<Measured> | null | undefined): RuleCheck | null {
  if (!m) return null;
  const fits = (c: RuleCheck) => { try { return parseCheck(c); } catch { return null; } };
  switch (choice) {
    case 'broll.keepOut.face':
    case 'broll.keepOut.eyes':
      return m[choice] === 0 ? { kind: 'broll.keepOut', zone: choice === 'broll.keepOut.face' ? 'face' : 'eyes' } : null;
    case 'captions.maxWords': return m[choice] ? fits({ kind: choice, value: m[choice]! }) : null;
    // rounded toward what the video already does, so it meets its own rule
    case 'captions.maxSize': return m[choice] ? fits({ kind: choice, value: Math.max(80, Math.ceil(m[choice]!)) }) : null;
    case 'captions.minSize': return m[choice] ? fits({ kind: choice, value: Math.min(160, Math.floor(m[choice]!)) }) : null;
    case 'music.underVoiceDb': return m[choice] != null ? fits({ kind: choice, value: Math.min(30, Math.floor(m[choice]!)) }) : null;
  }
}

/** One rule a render broke (lint.py), and where. */
export interface LintPlace { t0: number; t1: number; text?: string; words?: number; px?: number; db?: number; item?: string; treatment?: string; hides?: boolean; unmeasured?: boolean }
export interface LintFailure { id: string; kind: RuleKind; count: number; places: LintPlace[] }
/** `checkedIds`: every rule this render measured. Missing from renders made before it existed. */
export interface Lint { ok: boolean; checked: number; checkedIds?: string[]; failures: LintFailure[]; measured: Measured }

/** A checked rule to ask about: Yes = addStyleRule(text, check). The words are ruleText(check). */
export interface StyleCheckProposal { text: string; check: RuleCheck }

/** An active checked rule, as the rules file lists it. */
export interface CheckedRule { id: string; text: string; check: RuleCheck }

export function rulesFile(rules: CheckedRule[], stopOn: string[]): string {
  return JSON.stringify({ version: RULES_FILE_VERSION, rules, stopOn });
}
export const rulesFilePath = (projectDir: string) => path.join(projectDir, 'work', 'rules.json');

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Where a rule failed, in plain words: for the AI's next step and for the person's summary. */
export function failureText(f: LintFailure, check?: RuleCheck): string {
  const at = (p: LintPlace) => `at ${clock(p.t0)}`;
  const first = f.places.slice(0, 3);
  const more = f.count > first.length ? ` and ${f.count - first.length} more` : '';
  switch (f.kind) {
    case 'captions.maxWords': return `${f.count} caption${f.count > 1 ? 's show' : ' shows'} too many words (${first.map((p) => `"${p.text}" ${at(p)}`).join(', ')}${more})`;
    case 'captions.maxSize':
    case 'captions.minSize': return `${f.count} caption${f.count > 1 ? 's are' : ' is'} ${f.kind === 'captions.maxSize' ? 'too big' : 'too small'} (${first.map((p) => `${p.px} px ${at(p)}`).join(', ')}${more})`;
    case 'music.underVoiceDb': return f.places[0]?.unmeasured ? 'the music level could not be measured' : `the music is only ${f.places[0]?.db} dB under the voice`;
    case 'broll.keepOut': return `${f.count === 1 ? 'a picture covers' : `${f.count} pictures cover`} ${check?.kind === 'broll.keepOut' && check.zone === 'eyes' ? 'the eyes, nose or mouth' : 'the face'} (${first.map((p) => `${p.item}${p.hides ? ` (${p.treatment}, hides the speaker)` : ''} ${at(p)}`).join(', ')}${more})`;
  }
}
