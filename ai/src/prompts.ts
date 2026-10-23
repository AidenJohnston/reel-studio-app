// Prompts live in ai/prompts/*.md and are loaded at runtime (so they can be tuned without a rebuild).
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PromptName = 'system' | 'firstEdit' | 'applyNote' | 'writeScript' | 'pickTakes' | 'review' | 'proofread' | 'checker';

export function defaultPromptsDir(): string {
  const candidates = [
    process.env.REELSTUDIO_PROMPTS_DIR,
    path.join(__dirname, '..', 'prompts'), // dist/ or src/ -> ai/prompts
    path.join(__dirname, '..', '..', 'prompts'),
    (process as any).resourcesPath ? path.join((process as any).resourcesPath, 'ai', 'prompts') : undefined,
  ].filter(Boolean) as string[];
  return candidates.find((d) => fs.existsSync(path.join(d, 'system.md'))) ?? candidates[1];
}

export class Prompts {
  private cache = new Map<string, string>();
  constructor(private readonly dir: string = defaultPromptsDir()) {}

  raw(name: PromptName): string {
    let t = this.cache.get(name);
    if (t === undefined) {
      const file = path.join(this.dir, `${name}.md`);
      try { t = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`Missing prompt file ${file}`); }
      this.cache.set(name, t);
    }
    return t;
  }

  render(name: PromptName, vars: Record<string, string> = {}): string {
    return this.raw(name).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
  }
}
