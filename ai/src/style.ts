// "My style": durable user preferences, persisted in <Reel Studio root>/My style.json.
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJson, styleFile, writeFileAtomic } from './project';

export interface StyleRule { id: string; text: string; createdAt: string }
export interface StyleFile { version: 1; rules: StyleRule[] }

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();

/** A rule as it is shown and stored: one sentence, capitalised, ending in a full stop. */
export function cleanRuleText(text: string): string {
  let clean = String(text ?? '').replace(/\s*—\s*/g, ', ').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('empty rule');
  if (!/[.!?]$/.test(clean)) clean += '.';
  return clean[0].toUpperCase() + clean.slice(1);
}

/** The user's note itself asks for a lasting habit ("always...", "from now on...", "remember...",
 * "in every video..."). Only then is a rule saved without asking; otherwise it is only proposed
 * (novice test: "I also saved this to My style" for a note that never asked was surprising). */
export function noteAsksToRemember(note: string | undefined): boolean {
  return !!note && /\b(always|never again|from now on|going forward|in (the )?future|remember|every (video|time|reel)|all (my|of my|future) (videos|reels)|for next time|next time)\b/i.test(note);
}

export class StyleStore {
  constructor(private readonly rootDir: () => string) {}

  /** add/remove are read-modify-write of one file shared by every project: run them one at a time
   * (two edits saving a rule at once used to drop one of them; review finding 36). */
  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.catch(() => undefined).then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  get file(): string { return styleFile(this.rootDir()); }

  async list(): Promise<StyleRule[]> {
    if (!fs.existsSync(this.file)) return [];
    try {
      const data = await readJson<StyleFile>(this.file);
      return Array.isArray(data?.rules) ? data.rules.filter((r) => r && typeof r.text === 'string') : [];
    } catch { return []; }
  }

  private async write(rules: StyleRule[]): Promise<void> {
    await writeFileAtomic(this.file, JSON.stringify({ version: 1, rules } satisfies StyleFile, null, 2) + '\n');
  }

  /** Adds a rule unless an equivalent one already exists. */
  async add(text: string): Promise<{ added: boolean; rule: StyleRule }> {
    return this.serial(() => this.addNow(text));
  }

  /** The saved rule equivalent to `text`, if any. */
  async find(text: string): Promise<StyleRule | undefined> {
    const n = normalize(cleanRuleText(text));
    return (await this.list()).find((r) => normalize(r.text) === n);
  }

  private async addNow(text: string): Promise<{ added: boolean; rule: StyleRule }> {
    const clean = cleanRuleText(text);
    const rules = await this.list();
    const dup = rules.find((r) => normalize(r.text) === normalize(clean));
    if (dup) return { added: false, rule: dup };
    const rule: StyleRule = { id: randomUUID(), text: clean, createdAt: new Date().toISOString() };
    await this.write([...rules, rule]);
    return { added: true, rule };
  }

  async remove(id: string): Promise<void> {
    return this.serial(async () => {
      const rules = await this.list();
      await this.write(rules.filter((r) => r.id !== id));
    });
  }

  async asPromptText(): Promise<string> {
    const rules = await this.list();
    return rules.length ? rules.map((r) => `- ${r.text}`).join('\n') : '(none yet)';
  }
}
