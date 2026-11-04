import { describe, it, expect } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createAI } from '../src';
import { FakeHost, tmpDir } from './helpers';

describe('a damaged My style.json', () => {
  it('is kept as a numbered copy next to a fresh My style, which saves again', async () => {
    const root = tmpDir('style ');
    const ai = createAI({ host: new FakeHost(root), settingsDir: tmpDir('settings ') });
    const file = path.join(root, 'My style.json');
    const first = '{"version":1,"rules":[{"id":"a","text":"Keep music quieter under talk';
    await fsp.writeFile(file, first);

    expect(await ai.styleRules()).toEqual([]);
    expect(await fsp.readFile(path.join(root, 'My style.damaged.json'), 'utf8')).toBe(first);
    expect(await ai.styleWasDamaged()).toBe(true);
    await ai.addStyleRule('Keep music quieter under talking.');
    expect((await ai.styleRules()).map((r) => r.text)).toEqual(['Keep music quieter under talking.']);
    expect(await ai.styleWasDamaged()).toBe(true);

    // damaged again: the first copy stays as it was, and the second takes the next number
    const second = '{"rules":"not a list"}';
    await fsp.writeFile(file, second);
    expect(await ai.addStyleRule('Use big captions.')).toMatchObject({ text: 'Use big captions.' });
    expect(await fsp.readFile(path.join(root, 'My style.damaged.json'), 'utf8')).toBe(first);
    expect(await fsp.readFile(path.join(root, 'My style.damaged 2.json'), 'utf8')).toBe(second);

    // My style says the old file is kept next to it, so once that copy is gone it stops saying so
    await fsp.rm(path.join(root, 'My style.damaged 2.json'));
    expect(await ai.styleWasDamaged()).toBe(false);
  });
});
