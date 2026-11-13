// Tiny JSON-schema helpers for the strict subset our tools use (OpenAI strict mode compatible):
// every property listed in `required`, `additionalProperties: false`, optional = union with null.

export type JSONSchema = Record<string, any>;

export const S = {
  str: (description?: string, extra: JSONSchema = {}): JSONSchema => ({ type: 'string', ...(description ? { description } : {}), ...extra }),
  num: (description?: string, extra: JSONSchema = {}): JSONSchema => ({ type: 'number', ...(description ? { description } : {}), ...extra }),
  int: (description?: string, extra: JSONSchema = {}): JSONSchema => ({ type: 'integer', ...(description ? { description } : {}), ...extra }),
  bool: (description?: string): JSONSchema => ({ type: 'boolean', ...(description ? { description } : {}) }),
  enum: (values: readonly string[], description?: string): JSONSchema => ({ type: 'string', enum: [...values], ...(description ? { description } : {}) }),
  arr: (items: JSONSchema, description?: string, extra: JSONSchema = {}): JSONSchema => ({ type: 'array', items, ...(description ? { description } : {}), ...extra }),
  obj: (properties: Record<string, JSONSchema>, description?: string): JSONSchema => ({
    type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
    ...(description ? { description } : {}),
  }),
  /** Nullable (the strict-mode way to say "optional"). */
  opt: (s: JSONSchema): JSONSchema => {
    if (s.enum) return { ...s, type: [s.type, 'null'], enum: [...s.enum, null] };
    if (typeof s.type === 'string') return { ...s, type: [s.type, 'null'] };
    return { anyOf: [s, { type: 'null' }] };
  },
};

const typeOf = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
};
const matchesType = (t: string, v: unknown) => {
  const actual = typeOf(v);
  return t === actual || (t === 'number' && actual === 'integer');
};

/** Validates `value` against `schema`. Returns a list of human-readable problems. */
export function validate(schema: JSONSchema, value: unknown, at = 'args'): string[] {
  const out: string[] = [];
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s: JSONSchema) => validate(s, value, at).length === 0);
    if (!ok) out.push(`${at}: does not match any allowed shape`);
    return out;
  }
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      out.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return out;
    }
  }
  if (value === null) return out;
  if (schema.enum && !schema.enum.includes(value)) out.push(`${at}: must be one of ${schema.enum.filter((x: any) => x !== null).join(', ')}`);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${at}: must be finite`);
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${at}: must be <= ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${at}: must match ${schema.pattern}`);
  if (typeof value === 'string' && schema.minLength !== undefined && value.length < schema.minLength) out.push(`${at}: too short`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${at}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${at}: needs at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => out.push(...validate(schema.items, v, `${at}[${i}]`)));
  }
  if (typeOf(value) === 'object' && schema.properties) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) out.push(`${at}.${k}: missing`);
    for (const [k, v] of Object.entries(obj)) {
      const ps = schema.properties[k];
      if (!ps) { if (schema.additionalProperties === false) out.push(`${at}.${k}: unknown field`); continue; }
      out.push(...validate(ps, v, `${at}.${k}`));
    }
  }
  return out;
}

/**
 * Lenient pre-pass for models that do not enforce strict schemas (CLI providers): fills missing
 * nullable fields with null, so `{ "track": "x" }` works when `startAt` is nullable.
 */
export function fillNulls(schema: JSONSchema, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !schema.properties) {
    if (Array.isArray(value) && schema.items) return value.map((v) => fillNulls(schema.items, v));
    return value;
  }
  const obj: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [k, ps] of Object.entries<JSONSchema>(schema.properties)) {
    const nullable = (Array.isArray(ps.type) && ps.type.includes('null')) || ps.anyOf?.some((s: JSONSchema) => s.type === 'null');
    if (!(k in obj) && nullable) obj[k] = null;
    else if (k in obj) {
      const inner = ps.anyOf ? ps.anyOf.find((s: JSONSchema) => s.type !== 'null') : ps;
      if (inner) obj[k] = fillNulls(inner, obj[k]);
    }
  }
  return obj;
}

/** True when the schema obeys OpenAI strict-mode rules (used by tests). */
export function isStrict(schema: JSONSchema, at = '$'): string[] {
  const out: string[] = [];
  const visit = (s: JSONSchema, p: string) => {
    if (s.anyOf) { s.anyOf.forEach((x: JSONSchema, i: number) => visit(x, `${p}.anyOf[${i}]`)); return; }
    const types: string[] = Array.isArray(s.type) ? s.type : [s.type];
    if (types.includes('object')) {
      if (s.additionalProperties !== false) out.push(`${p}: additionalProperties must be false`);
      const keys = Object.keys(s.properties ?? {});
      const req = new Set(s.required ?? []);
      for (const k of keys) if (!req.has(k)) out.push(`${p}.${k}: must be required`);
      for (const k of keys) visit(s.properties[k], `${p}.${k}`);
    }
    if (types.includes('array') && s.items) visit(s.items, `${p}[]`);
  };
  visit(schema, at);
  return out;
}
