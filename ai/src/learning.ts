import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StyleStore, type MemoryKind, type ProposalDraft, type TrialLink } from './style';

// Provisional paired-agreement rule. There is no empirical evidence yet for these
// thresholds. TODO: validate them against real post results before relaxing them.
// Reach 300 excludes very small audiences; it does not establish significance.
export const MIN_LEARNING_REACH = 300;
// Ratio margins reject small changes; repeated agreement limits one-post wins.
// These choices are heuristics, without a significance model or validation run.
const WATCH_RATIO = 1.15;
const ACTION_RATIO = 1.10;
const MIN_AGREEING_TRIALS = 3;
const MIN_AGREEMENT = 0.75;

type Variable = 'seed' | 'hook' | 'cover' | 'caption' | 'brightness';
interface Trial { parent_version: number; variable: Variable; from: unknown; to: unknown }
interface Outcome {
  postId: string; accountId: string; reach: number; watch: number; actions: number;
}
interface Comparison { watch: number; actions: number; link: TrialLink }
interface Group { kind: MemoryKind; line: string; text: string; comparisons: Comparison[] }

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function variable(value: unknown): value is Variable {
  return value === 'seed' || value === 'hook' || value === 'cover' || value === 'caption' || value === 'brightness';
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
async function read(file: string): Promise<unknown> {
  let raw: string;
  try { raw = await fs.readFile(file, 'utf8'); } catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  try { return JSON.parse(raw); } catch { throw new Error(`Invalid learning data in ${file}`); }
}
function trials(value: unknown, file: string): Trial[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Expected a trial array in ${file}`);
  return value.map((entry) => {
    if (!object(entry) || typeof entry.parent_version !== 'number' || !Number.isSafeInteger(entry.parent_version)
      || entry.parent_version < 1 || !variable(entry.variable) || !('from' in entry) || !('to' in entry)) {
      throw new Error(`Invalid trial in ${file}`);
    }
    return { parent_version: entry.parent_version, variable: entry.variable, from: entry.from, to: entry.to };
  });
}
function outcome(value: unknown, version: number): Outcome | undefined {
  // Multiple posts cannot be paired without a post assignment in trials.json.
  if (!object(value) || Object.keys(value).length !== 1) return;
  const [postId, post] = Object.entries(value)[0];
  if (!object(post) || post.postId !== postId || post.version !== version || post.platform !== 'instagram'
    || typeof post.accountId !== 'string' || typeof post.observedAt !== 'string' || !Number.isFinite(Date.parse(post.observedAt)) || !object(post.metrics)) return;
  const m = post.metrics;
  if (!nonnegative(m.reach) || !nonnegative(m.averageWatchTimeMs) || !nonnegative(m.saves) || !nonnegative(m.shares)) return;
  if (m.reach === 0) return;
  return { postId, accountId: post.accountId, reach: m.reach, watch: m.averageWatchTimeMs, actions: (m.saves + m.shares) / m.reach };
}
function editValue(p: Record<string, unknown>, v: Variable): unknown {
  switch (v) {
    case 'brightness': return p.exposure ?? 1;
    case 'seed': return object(p.cutStyle) ? p.cutStyle.seed : undefined;
    case 'caption': return object(p.post) ? p.post.caption ?? '' : '';
    case 'cover': return p.cover;
    case 'hook': return object(p.cut) && Array.isArray(p.cut.keep) ? p.cut.keep[0] : undefined;
  }
}
function withoutVariable(p: Record<string, unknown>, v: Variable): unknown {
  const clean = { ...p };
  for (const key of ['version', 'createdAt', 'updatedAt', 'notes']) delete clean[key];
  switch (v) {
    case 'brightness': delete clean.exposure; break;
    case 'cover': delete clean.cover; break;
    case 'seed': {
      const style = object(clean.cutStyle) ? { ...clean.cutStyle } : {};
      delete style.seed; clean.cutStyle = style; break;
    }
    case 'caption': {
      const post = object(clean.post) ? { ...clean.post } : {};
      delete post.caption; clean.post = post; break;
    }
    case 'hook': {
      if (!object(clean.cut) || !Array.isArray(clean.cut.keep)) return undefined;
      clean.cut = { ...clean.cut, keep: clean.cut.keep.slice(1) }; break;
    }
  }
  return clean;
}
function short(text: string): string {
  return text.length <= 60 ? text : text.slice(0, 56).replace(/\s+\S*$/, '') + '...';
}
function preference(t: Trial, project: string): { key: string; kind: MemoryKind; line: string; text: string } | undefined {
  if (t.variable === 'brightness') {
    if (!nonnegative(t.from) || !nonnegative(t.to) || t.from === 0) return;
    const ratio = t.to / t.from;
    if (Math.abs(ratio - 1.08) > 1e-7 && Math.abs(ratio - .92) > 1e-7) return;
    const direction = ratio > 1 ? 'brighter' : 'darker';
    const text = `Prefer 8% ${direction} exposure.`;
    return { key: `brightness:${direction}`, kind: 'look', line: text, text };
  }
  // Exact caption choices can repeat. Word IDs, cover times and random seeds only
  // identify choices within their project, so they never imply a general taste.
  const key = canonical([t.variable, t.variable === 'caption' ? '' : project, t.from, t.to]);
  switch (t.variable) {
    case 'caption': {
      if (typeof t.to !== 'string' || !t.to.trim()) return;
      const text = `Prefer the post caption ${JSON.stringify(t.to)}.`;
      return { key, kind: 'captions', line: short(text), text };
    }
    case 'hook': return { key, kind: 'cuts', line: short(`Prefer the tested opening for ${project}.`), text: `For project ${JSON.stringify(project)}, prefer opening ${canonical(t.to)} over ${canonical(t.from)}.` };
    case 'cover': return { key, kind: 'look', line: short(`Prefer the tested cover for ${project}.`), text: `For project ${JSON.stringify(project)}, prefer cover ${canonical(t.to)} over ${canonical(t.from)}.` };
    case 'seed': return { key, kind: 'pacing', line: short(`Prefer the tested pace for ${project}.`), text: `For project ${JSON.stringify(project)}, prefer cut-style seed ${canonical(t.to)} over ${canonical(t.from)}.` };
  }
}
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const rounded = (value: number) => Math.round(value * 1e6) / 1e6;
const percent = (ratio: number) => `${ratio >= 1 ? '+' : ''}${Math.round((ratio - 1) * 100)}%`;

/**
 * Scores every trial and returns the drafts StyleStore.propose would keep; the caller may pass each to propose, never
 * add. Its one write: once every trial has been scored, waiting results memories the evidence no longer supports
 * are taken back (StyleStore.withdrawUnsupportedResults). A trial that can't be read throws before that, so a damaged
 * file never empties the list.
 */
export async function learn(projectsRoot: string, style = new StyleStore(() => path.dirname(path.resolve(projectsRoot)))): Promise<ProposalDraft[]> {
  let entries;
  try { entries = await fs.readdir(projectsRoot, { withFileTypes: true }); } catch (error) {
    if (object(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const groups = new Map<string, Group>();
  const usedPosts = new Set<string>();
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const dir = path.join(projectsRoot, entry.name);
    const file = path.join(dir, 'trials.json');
    const rows = trials(await read(file), file);
    if (!rows.length) continue;
    const saved = await read(path.join(dir, 'outcomes.json'));
    if (saved === undefined) continue;
    if (!object(saved) || saved.schemaVersion !== 1 || !object(saved.versions)) throw new Error(`Invalid outcomes in ${entry.name}/outcomes.json`);
    for (const [index, trial] of rows.entries()) {
      const parentVersion = trial.parent_version;
      const version = parentVersion + 1;
      const before = outcome(saved.versions[`v${parentVersion}`], parentVersion);
      const after = outcome(saved.versions[`v${version}`], version);
      if (!before || !after || before.accountId !== after.accountId || before.postId === after.postId) continue;
      // A zero baseline has no finite ratio. A zero result is still a loss.
      if (before.watch === 0 || before.actions === 0) continue;
      if (before.reach < MIN_LEARNING_REACH || after.reach < MIN_LEARNING_REACH) continue;
      // The producer gives only parent_version. Verify the next rendered edit,
      // including its unchanged body, instead of treating the next post as proof.
      const parent = await read(path.join(dir, 'versions', `v${parentVersion}`, 'project.json'));
      const child = await read(path.join(dir, 'versions', `v${version}`, 'project.json'));
      if (!object(parent) || !object(child) || canonical(trial.from) === canonical(trial.to)
        || canonical(editValue(parent, trial.variable)) !== canonical(trial.from)
        || canonical(editValue(child, trial.variable)) !== canonical(trial.to)
        || canonical(withoutVariable(parent, trial.variable)) !== canonical(withoutVariable(child, trial.variable))) continue;
      const pref = preference(trial, entry.name);
      if (!pref) continue;
      const postKeys = [before, after].map((p) => canonical([pref.key, p.accountId, p.postId]));
      if (postKeys.some((key) => usedPosts.has(key))) continue;
      postKeys.forEach((key) => usedPosts.add(key));
      let group = groups.get(pref.key);
      if (!group) { group = { kind: pref.kind, line: pref.line, text: pref.text, comparisons: [] }; groups.set(pref.key, group); }
      group.comparisons.push({ watch: after.watch / before.watch, actions: after.actions / before.actions,
        link: { project: entry.name, parentVersion, version, parentPostId: before.postId, postId: after.postId,
          href: `${encodeURIComponent(entry.name)}/trials.json#/${index}` } });
    }
  }
  const candidates = new Map<string, ProposalDraft>();
  for (const [key, group] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const all = group.comparisons;
    const wins = all.filter((c) => c.watch >= WATCH_RATIO && c.actions >= ACTION_RATIO);
    // Neutral pairs count in the denominator; a meaningful reversal vetoes the
    // suggestion even if enough wins remain. These are associations, not causation.
    if (wins.length < MIN_AGREEING_TRIALS || wins.length / all.length < MIN_AGREEMENT
      || all.some((c) => c.watch <= 1 / WATCH_RATIO || c.actions <= 1 / ACTION_RATIO)) continue;
    const watch = mean(all.map((c) => c.watch));
    const actions = mean(all.map((c) => c.actions));
    const proposal: ProposalDraft = { kind: group.kind, line: group.line, text: group.text,
      from: { kind: 'results', reels: [...new Set(all.map((c) => c.link.project))], metric: 'averageWatchTimeMs', change: rounded(watch - 1), n: all.length,
        evidence: `${wins.length} of ${all.length} trials, avg watch ${percent(watch)}, saves + shares/reach ${percent(actions)}`,
        trials: all.map((c) => c.link) } };
    candidates.set(key, proposal);
  }
  // Opposing preferences across audiences do not establish a lasting exposure rule.
  if (candidates.has('brightness:brighter') && candidates.has('brightness:darker')) {
    candidates.delete('brightness:brighter');
    candidates.delete('brightness:darker');
  }
  await style.withdrawUnsupportedResults([...candidates.values()]);
  const proposals: ProposalDraft[] = [];
  for (const proposal of candidates.values()) {
    if (await style.proposalStatus(proposal) === 'new') proposals.push(proposal);
  }
  return proposals;
}
