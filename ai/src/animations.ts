// Animation templates for the make_animation tool: the tool schema comes from every template's
// meta.json (via animations.generated.ts), and word-timed params are filled from the transcript so
// reveals land on the spoken word.
import { ANIMATION_TEMPLATES, AnimParamSpec, AnimTemplateSpec } from './animations.generated';
import { JSONSchema, S } from './schema';

export { ANIMATION_TEMPLATES };
export const ANIMATION_IDS = ANIMATION_TEMPLATES.map((t) => t.id);

/** Params the AI never sets: filled from the transcript (timings) or the engine (free region). */
export const ENGINE_FED = new Set(['region', 'wordTimes', 'at']);

export function templateSpec(id: string): AnimTemplateSpec | undefined {
  return ANIMATION_TEMPLATES.find((t) => t.id === id);
}

function toSchema(p: AnimParamSpec, description: string): JSONSchema {
  const types = Array.isArray(p.type) ? p.type.filter((t) => t !== 'null') : [p.type ?? 'string'];
  const t = types[0] ?? 'string';
  const extra: JSONSchema = {};
  if (p.minimum !== undefined) extra.minimum = p.minimum;
  if (p.maximum !== undefined) extra.maximum = p.maximum;
  if (t === 'array') {
    const items = p.items && (p.items.properties || p.items.type === 'array') ? toSchema(p.items, p.items.description ?? '') : { type: p.items?.type ?? 'string' };
    return S.arr(items, description,
      { ...(p.minItems !== undefined ? { minItems: p.minItems } : {}), ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}) });
  }
  if (t === 'object' && p.properties) return S.obj(fieldSchemas(p), description);
  if (p.enum) return S.enum(p.enum.filter((v): v is string => typeof v === 'string'), description);
  if (t === 'number' || t === 'integer') return S.num(description, extra);
  if (t === 'boolean') return S.bool(description);
  return S.str(description);
}

/** A nested object's fields for the tool (compose's rows and parts): strict mode lists every field,
 *  so a field the template doesn't require is nullable; engine-fed ones (a part's `at`) are left out. */
function fieldSchemas(p: AnimParamSpec): Record<string, JSONSchema> {
  const req = new Set(p.required ?? []);
  const out: Record<string, JSONSchema> = {};
  for (const [k, s] of Object.entries(p.properties ?? {})) {
    if (ENGINE_FED.has(k)) continue;
    const f = toSchema(s, s.description ?? '');
    out[k] = req.has(k) ? f : S.opt(f);
  }
  return out;
}

/** One params object covering every template (strict mode: each field nullable). Each field says
 *  which templates use it; a field another template doesn't know is dropped before rendering. */
export function animationParamsSchema(): JSONSchema {
  const merged = new Map<string, { spec: AnimParamSpec; uses: { id: string; desc: string }[] }>();
  for (const t of ANIMATION_TEMPLATES) {
    for (const [k, p] of Object.entries(t.params)) {
      if (ENGINE_FED.has(k) || p.ref) continue;
      const m = merged.get(k) ?? { spec: p, uses: [] };
      m.uses.push({ id: t.id, desc: p.description ?? '' });
      merged.set(k, m);
    }
  }
  const props: Record<string, JSONSchema> = {};
  for (const [k, { spec, uses }] of merged) {
    const all = uses.length === ANIMATION_TEMPLATES.length;
    const descs = [...new Set(uses.map((u) => u.desc))];
    const req = uses.filter((u) => templateSpec(u.id)!.required.includes(k)).map((u) => u.id);
    let d = all ? descs[0] : `${uses.map((u) => u.id).join(', ')}: ${descs.length === 1 ? descs[0] : uses.map((u) => `(${u.id}) ${u.desc}`).join(' ')}`;
    if (req.length) d += ` Required for ${req.join(', ')}.`;
    if (spec.format === 'file') d += ' A Library/... picture path, or a web picture\'s assetId from resolve_asset commit.';
    props[k] = S.opt(toSchema(spec, d));
  }
  return S.obj(props, 'Template params. Fill only what the chosen template uses; leave the rest null. Word timings and the free space above the face are added for you.');
}

/** Drop nulls and params this template doesn't take; check required ones. -> [params, problems] */
export function cleanParams(id: string, params: Record<string, unknown>): [Record<string, unknown>, string[]] {
  const spec = templateSpec(id);
  if (!spec) return [{}, [`unknown animation template "${id}". Templates: ${ANIMATION_IDS.join(', ')}`]];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === null || v === undefined || !(k in spec.params) || ENGINE_FED.has(k)) continue;
    out[k] = scrub(v);
  }
  const missing = spec.required.filter((k) => out[k] === undefined || out[k] === '');
  return [out, missing.map((k) => `${id} needs params.${k}`)];
}

/** Nested nulls (strict mode's "not set") and engine-fed fields go: a replayed compose part keeps no
 *  old `at`, so a re-time lands it on its word again. */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== null && x !== undefined && !ENGINE_FED.has(k)).map(([k, x]) => [k, scrub(x)]));
}

// ---------------------------------------------------------------- compose

/** The motions each kind of compose part can take; templates/animations/compose/index.html
 *  (ALLOWED) quietly swaps any other for the kind's own, so the tool refuses it first. */
export const COMPOSE_MOTIONS: Record<string, readonly string[]> = {
  text: ['rise', 'strike'], number: ['count', 'rise', 'pop', 'strike'], stars: ['fill', 'rise'], arrow: ['draw'], rule: ['draw'],
};
/** Most parts one graphic shows (the template drops the rest), and the gap a part with no spoken
 *  word follows the one before by: both the same as compose/index.html (MAX_PARTS, STEP). */
export const COMPOSE_MAX_PARTS = 12;
const COMPOSE_STEP = 0.3;

interface ComposePart { kind?: string; text?: string; value?: number; max?: number; motion?: string; on?: string; at?: number }
const composeParts = (params: Record<string, unknown>): { part: ComposePart; at: string }[] =>
  (Array.isArray(params.rows) ? params.rows : []).flatMap((r: any, ri: number) =>
    (Array.isArray(r?.parts) ? r.parts : []).map((part: ComposePart, pi: number) => ({ part, at: `rows[${ri}].parts[${pi}]` })));

/** What the compose template would draw differently from what was asked: a motion the part's kind
 *  can't take, a text or number part with nothing to show, a rating over its scale, too many parts. */
export function composeProblems(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  const parts = composeParts(params);
  if (parts.length > COMPOSE_MAX_PARTS) out.push(`compose shows at most ${COMPOSE_MAX_PARTS} parts; this has ${parts.length}. Split it into two graphics or drop some`);
  for (const { part, at } of parts) {
    const ok = COMPOSE_MOTIONS[part.kind ?? ''];
    if (!ok) { out.push(`${at}.kind must be one of ${Object.keys(COMPOSE_MOTIONS).join(', ')}`); continue; }
    if (part.motion !== undefined && !ok.includes(part.motion)) out.push(`${at}: a ${part.kind} part can't ${part.motion}; it takes ${ok.join(' or ')}`);
    if ((part.kind === 'text' || part.kind === 'number') && !String(part.text ?? '').trim()) out.push(`${at}: a ${part.kind} part needs text`);
    if (part.kind === 'number' && part.text && !/\d/.test(part.text)) out.push(`${at}: a number part's text needs digits ("${part.text}"); use a text part for words`);
    if (part.kind === 'stars' && typeof part.value !== 'number') out.push(`${at}: a stars part needs value (the rating as said)`);
    if (part.kind === 'stars' && typeof part.value === 'number' && part.value > (part.max ?? 5)) out.push(`${at}: ${part.value} stars is more than max ${part.max ?? 5}`);
  }
  return out;
}

/** A compose part that would land after the clip has ended (an explicit `duration` shorter than the
 *  timed words, or a word past the renderer's 30 s cap): it would never be seen. */
export function composeTimingProblem(params: Record<string, unknown>): string | null {
  const ats = composeParts(params).map(({ part }) => part.at).filter((t): t is number => typeof t === 'number');
  if (!ats.length) return null;
  const last = Math.max(...ats);
  const d = typeof params.duration === 'number' ? params.duration : null;
  if (d !== null && last + 0.3 > d) return `compose: a part lands at ${last} s but the clip ends at ${d} s; leave duration out or anchor fewer words`;
  if (last + 1.8 > 30) return `compose: a part lands at ${last} s, too late for an animation (30 s at most); anchor the graphic closer to its words`;
  return null;
}

/** Sets each compose part's `at` (seconds from the clip start): the first of its `on` words, found
 *  in reading order; a part with no `on`, or one not found, follows the previous part by 0.3 s.
 *  Returns how many parts landed on a spoken word. Mutates `params.rows`. */
export function timeComposeParts(params: Record<string, unknown>, words: TimedWord[]): number {
  let j = 0, prev = -COMPOSE_STEP, hits = 0;
  for (const { part } of composeParts(params)) {
    let t: number | null = null;
    const ns = tokens(part.on ?? '').map(norm).filter(Boolean).slice(0, 2);
    if (ns.length) {
      for (let k = j; k < words.length; k++) if (ns.includes(norm(words[k].w))) { t = words[k].t; j = k + 1; hits++; break; }
    }
    prev = t !== null ? Math.max(t, prev, 0) : prev + COMPOSE_STEP;
    part.at = round(prev);
  }
  return hits;
}

// ---------------------------------------------------------------- word timing

export interface TimedWord { w: string; t: number; e?: number }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}%$]+/gu, '');
const tokens = (s: string) => String(s ?? '').trim().split(/\s+/).filter(Boolean);

/** Seconds (from the clip start) when each word of `text` is spoken. Words are matched in order
 *  against the anchor's words (spelling-insensitive, small skips allowed); a word that isn't found
 *  is placed between its neighbours. Same splitting as the templates (whitespace). */
export function alignWordTimes(text: string, words: TimedWord[]): number[] {
  const toks = tokens(text);
  if (!toks.length || !words.length) return [];
  const found: (number | null)[] = [];
  let j = 0;
  for (const tok of toks) {
    const n = norm(tok);
    let hit = -1, span = 1;
    for (let k = j; k < Math.min(words.length, j + 4) && n && hit < 0; k++) {
      if (norm(words[k].w) === n) hit = k;
      // the recogniser can split one written word: "3,000" -> "3" ",000", "-do" in "to-do"
      else if (k + 1 < words.length && norm(words[k].w + words[k + 1].w) === n) { hit = k; span = 2; }
    }
    if (hit >= 0) { found.push(words[hit].t); j = hit + span; } else found.push(null);
  }
  if (found.every((v) => v === null)) {
    // nothing matched (paraphrase): spread the words over the spoken span
    const a = words[0].t, b = words[words.length - 1].t;
    return toks.map((_, i) => round(a + ((b - a) * i) / Math.max(1, toks.length - 1)));
  }
  return fillGaps(found, words[0].t, words[words.length - 1].e ?? words[words.length - 1].t);
}

/** Seconds (from the clip start) when each list item is spoken: the first word of the item, matched
 *  in order; items not found are spread between their neighbours. */
export function itemTimes(items: string[], words: TimedWord[]): number[] {
  if (!items.length || !words.length) return [];
  const found: (number | null)[] = [];
  let j = 0;
  for (const item of items) {
    const ns = tokens(item).map(norm).filter(Boolean);
    let hit = -1;
    for (let k = j; k < words.length && hit < 0; k++) if (ns.slice(0, 2).includes(norm(words[k].w))) hit = k;
    if (hit >= 0) { found.push(words[hit].t); j = hit + 1; } else found.push(null);
  }
  return fillGaps(found, words[0].t, words[words.length - 1].e ?? words[words.length - 1].t);
}

/** Start (from the clip start) of `phrase`'s first word among `words`, or null. */
export function phraseTime(phrase: string, words: TimedWord[]): number | null {
  const first = norm(tokens(phrase)[0] ?? '');
  if (!first) return null;
  const w = words.find((x) => norm(x.w) === first);
  return w ? w.t : null;
}

function fillGaps(found: (number | null)[], start: number, end: number): number[] {
  const out = [...found];
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    let p = i - 1; while (p >= 0 && out[p] === null) p--;
    let n = i + 1; while (n < out.length && out[n] === null) n++;
    const a = p >= 0 ? (out[p] as number) : start;
    const b = n < out.length ? (out[n] as number) : Math.max(a, end);
    const pa = p >= 0 ? p : -1, nb = n < out.length ? n : out.length;
    out[i] = a + ((b - a) * (i - pa)) / (nb - pa);
  }
  // never earlier than the previous word, never before the clip starts
  let prev = 0;
  return out.map((v) => { prev = Math.max(prev, v as number, 0); return round(prev); });
}

const round = (x: number) => Math.round(x * 1000) / 1000;
