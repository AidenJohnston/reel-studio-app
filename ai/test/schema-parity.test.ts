import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOLS } from '../src/tools';
import { JSONSchema } from '../src/schema';

const engine = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../engine/reelengine/schema/project.schema.json'), 'utf8'));
const p = engine.properties;
const tool = (name: string): JSONSchema => TOOLS.find((t) => t.name === name)!.parameters.properties;
const captions = tool('set_caption_style');
const pairs: [string, JSONSchema, JSONSchema][] = [
  ...['size', 'maxWords', 'case', 'position'].map((field): [string, JSONSchema, JSONSchema] =>
    [`captions.${field}`, captions[field], p.captions.properties.style.properties[field]]),
  ['caption color', captions.color, engine.$defs.color],
  ['gapCap', tool('set_gap_cap').seconds, p.cut.properties.gapCap],
  ['music startAt', tool('choose_music').startAt, p.music.properties.startAt],
  ['music gainDb', tool('set_music_automation').automation.items.properties.gainDb, p.music.properties.automation.items.properties.gainDb],
  ['zoom scale', tool('set_zoom').zooms.items.properties.scale, p.zooms.items.properties.scale],
  ['cover time', tool('set_cover').atSourceTime, p.cover.properties.atSourceTime],
  ['correction from', tool('add_caption_correction').from, p.captions.properties.corrections.items.properties.from],
];
for (const name of ['set_cut', 'add_broll', 'update_broll', 'make_animation', 'set_zoom']) {
  const args = tool(name);
  const anchor = args.keep?.items ?? args.zooms?.items.properties.anchor ?? args.anchor;
  for (const field of ['from', 'to']) pairs.push([`${name} ${field}`, anchor.properties[field], engine.$defs.wordId]);
}
for (const field of ['fromWord', 'toWord']) pairs.push([`automation ${field}`, tool('set_music_automation').automation.items.properties[field], engine.$defs.wordId]);
for (const name of ['update_broll', 'remove_broll']) pairs.push([`${name} id`, tool(name).id, p.broll.items.properties.id]);

const constraints = (schema: JSONSchema) => Object.fromEntries(
  ['pattern', 'minLength', 'enum'].filter((key) => schema[key] !== undefined)
    .map((key) => [key, key === 'enum' ? new Set(schema[key].filter((v: unknown) => v !== null)) : schema[key]]),
);

describe('hand-mirrored engine constraints', () => {
  it.each(pairs)('fails if %s drifts outside the engine schema', (_name, ai, authoritative) => {
    expect(constraints(ai)).toEqual(constraints(authoritative));
    if (authoritative.minimum !== undefined) expect(ai.minimum).toBeGreaterThanOrEqual(authoritative.minimum);
    if (authoritative.maximum !== undefined) expect(ai.maximum).toBeLessThanOrEqual(authoritative.maximum);
    if (authoritative.type === 'integer') expect(ai.type).toContain('integer');
  });
});
