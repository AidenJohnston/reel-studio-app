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
  if (t === 'array') return S.arr({ type: p.items?.type ?? 'string' }, description,
    { ...(p.minItems !== undefined ? { minItems: p.minItems } : {}), ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}) });
  if (p.enum) return S.enum(p.enum.filter((v): v is string => typeof v === 'string'), description);
  if (t === 'number' || t === 'integer') return S.num(description, extra);
  if (t === 'boolean') return S.bool(description);
  return S.str(description);
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
    if (spec.format === 'file') d += ' A file path from list_library / fetch_image (Library/... or work/assets/...).';
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
    out[k] = v;
  }
  const missing = spec.required.filter((k) => out[k] === undefined || out[k] === '');
  return [out, missing.map((k) => `${id} needs params.${k}`)];
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
