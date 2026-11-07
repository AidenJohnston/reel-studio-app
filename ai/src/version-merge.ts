import { CutRange, Project, ProjectError, Transcript, WordAnchor, anchorProblem, keptWords, normalizeKeep, validateProject, wordIndex } from './project';

/** Complete field ownership, including fields outside the seven selectable layers, is in docs/version-merge.md. */
export const MERGE_FIELDS = {
  cut: ['cut', 'sources', 'format', 'transcript'],
  captions: ['captions'],
  music: ['music'],
  zooms: ['zooms'],
  broll: ['broll'],
  sfx: ['sfx'],
  cover: ['cover'],
} as const;
export type MergeLayer = keyof typeof MERGE_FIELDS;
export type MergeTake = Record<MergeLayer, 'ours' | 'theirs'>;
export interface MergeRequest { ours: number; theirs: number; take: MergeTake }
export interface MergeResult { edit: Project; report: string[] }

export function validateMergeTake(take: unknown): asserts take is MergeTake {
  if (!take || typeof take !== 'object' || Array.isArray(take)) throw new ProjectError('Choose ours or theirs for every layer.');
  for (const layer of Object.keys(MERGE_FIELDS)) {
    const side = (take as Record<string, unknown>)[layer];
    if (side !== 'ours' && side !== 'theirs') throw new ProjectError(`Choose ours or theirs for ${layer}.`);
  }
  for (const layer of Object.keys(take)) if (!Object.hasOwn(MERGE_FIELDS, layer)) throw new ProjectError(`Unknown merge layer ${layer}.`);
}

export function validateMergeRequest(request: unknown): asserts request is MergeRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new ProjectError('Choose two saved versions and a side for every layer.');
  const r = request as Record<string, unknown>;
  for (const side of ['ours', 'theirs']) {
    if (!Number.isSafeInteger(r[side]) || (r[side] as number) < 1) throw new ProjectError(`Choose a saved version for ${side}.`);
  }
  if (r.ours === r.theirs) throw new ProjectError('Choose two different saved versions.');
  validateMergeTake(r.take);
}

/** The layers two versions of one video differ in: the only ones a person needs to choose between when combining them. */
export function differingLayers(ours: Project, theirs: Project): MergeLayer[] {
  return (Object.keys(MERGE_FIELDS) as MergeLayer[]).filter((layer) =>
    MERGE_FIELDS[layer].some((field) => JSON.stringify(ours[field] ?? null) !== JSON.stringify(theirs[field] ?? null)));
}

/** Pure layer selection. The transcript resolves word ids; no clocks, model calls, or input mutation. */
export function mergeVersions(input: { ours: Project; theirs: Project; take: MergeTake }, transcript: Transcript): MergeResult {
  validateMergeTake(input.take);
  if (input.ours.id !== input.theirs.id) throw new ProjectError('Choose two versions of the same video.');
  const edit = structuredClone(input.ours);
  for (const layer of Object.keys(MERGE_FIELDS) as MergeLayer[]) {
    for (const field of MERGE_FIELDS[layer]) {
      const value = input[input.take[layer]][field];
      if (value === undefined) delete edit[field];
      else (edit as Record<string, unknown>)[field] = structuredClone(value);
    }
  }
  const problems = validateProject(edit, transcript);
  // clips (multi-source) are checked by validateProject; normalizeKeep checks the word ranges
  problems.push(...normalizeKeep(transcript, edit.cut.keep.filter((a): a is CutRange => !('clip' in a))).problems);
  if (problems.length) throw new ProjectError(problems.join('; '));
  const idx = wordIndex(transcript);
  const output = keptWords(transcript, edit.cut.keep);
  const kept = new Set(output.map((w) => w.id));
  const report: string[] = [];

  // Walk output order so a reorder cannot join two unrelated stretches of the source.
  function surviving(anchor: WordAnchor): WordAnchor[] {
    const problem = anchorProblem(idx, anchor);
    if (problem) throw new ProjectError(problem);
    const lo = idx.byId.get(anchor.from)!;
    const hi = idx.byId.get(anchor.to)!;
    const runs: WordAnchor[] = [];
    let previous = -2;
    let previousSource: string | undefined;
    for (const word of output) {
      const pos = idx.byId.get(word.id)!;
      if (pos < lo || pos > hi) { previous = -2; continue; }
      if (pos === previous + 1 && word.source === previousSource && runs.length) runs[runs.length - 1].to = word.id;
      else runs.push({ from: word.id, to: word.id });
      previous = pos;
      previousSource = word.source;
    }
    return runs;
  }
  function intersect(anchor: WordAnchor, label: string): WordAnchor[] {
    const runs = surviving(anchor);
    if (!runs.length) report.push(`Dropped ${label} because none of its words are kept.`);
    else if (runs.length !== 1 || runs[0].from !== anchor.from || runs[0].to !== anchor.to) {
      report.push(`Adjusted ${label} to the kept words ${runs.map((r) => `${r.from} through ${r.to}`).join(' and ')}.`);
    }
    return runs;
  }
  function startingAt<T extends { anchor: WordAnchor }>(item: T, label: string): T[] {
    const runs = surviving(item.anchor);
    if (!kept.has(item.anchor.from)) {
      report.push(`Dropped ${label} because its start word ${item.anchor.from} is not kept.`);
      return [];
    }
    const anchor = runs.find((r) => r.from === item.anchor.from)!;
    if (anchor.to !== item.anchor.to) report.push(`Adjusted ${label} to end at kept word ${anchor.to}.`);
    return [{ ...item, anchor }];
  }
  if (edit.captions.hidden) edit.captions.hidden = edit.captions.hidden.flatMap((a, i) => intersect(a, `caption hidden range ${i + 1}`));
  edit.music.automation = edit.music.automation.flatMap((a, i) => intersect({ from: a.fromWord, to: a.toWord }, `music volume range ${i + 1}`)
    .map((r) => ({ ...a, fromWord: r.from, toWord: r.to })));
  edit.zooms = edit.zooms.flatMap((z, i) => intersect(z.anchor, `zoom ${i + 1}`).map((anchor) => ({ ...z, anchor })));
  edit.broll = edit.broll.flatMap((b) => startingAt(b, `b-roll ${b.id}`));
  // a sound effect lands on one moment (#72): a kept word's start, the cut into a kept word, or a kept picture
  if (edit.sfx) {
    const pictures = new Set(edit.broll.map((b) => b.id));
    // A sound "at the cut into w" plays where the reel jumps to w (tools.ts isCut). The other version's cut can keep
    // w but play straight into it, with no jump: the engine then finds no moment for the sound and leaves it out.
    const jumpsTo = (wid: string): boolean => {
      const k = edit.cut.keep.findIndex((r) => 'from' in r && r.from === wid);
      if (k <= 0) return false;
      const before = edit.cut.keep[k - 1];
      if ('clip' in before) return true;
      const prev = idx.byId.get(before.to);
      const here = idx.byId.get(wid);
      return prev === undefined || here === undefined || here !== prev + 1 || idx.words[here].source !== idx.words[prev].source;
    };
    edit.sfx = edit.sfx.filter((s, i) => {
      if ('cut' in s.at) {
        if (jumpsTo(s.at.cut)) return true;
        report.push(`Dropped sound effect ${i + 1} (${s.sound}) because there is no cut into ${s.at.cut} any more.`);
        return false;
      }
      const word = 'word' in s.at ? s.at.word : null;
      if (word !== null ? kept.has(word) : pictures.has((s.at as { broll: string }).broll)) return true;
      report.push(`Dropped sound effect ${i + 1} (${s.sound}) because ${word !== null ? `its word ${word}` : `its picture ${(s.at as { broll: string }).broll}`} is not kept.`);
      return false;
    });
  }
  return { edit, report };
}
