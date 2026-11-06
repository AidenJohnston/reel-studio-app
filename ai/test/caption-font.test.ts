import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { executeTool, loadProject, newToolState, StyleStore, type ToolContext } from '../src';
import { FakeHost, makeProject } from './helpers';

/** engine cli.py cmd_fonts, as it answers with one font of the person's own in Library › Fonts */
class FontHost extends FakeHost {
  override async runEngine(command: string, args: string[], onProgress?: Parameters<FakeHost['runEngine']>[2]) {
    if (command === 'fonts') return { fonts: [
      { names: ['Brand Sans', 'Brand Sans Bold', 'BrandSans-Bold'], file: 'BrandSans-Bold.ttf', yours: true },
      { names: ['Montserrat', 'Montserrat SemiBold', 'Montserrat-SemiBold'], file: 'Montserrat-SemiBold.ttf', yours: false },
    ], default: 'Montserrat SemiBold' };
    return super.runEngine(command, args, onProgress);
  }
}
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => fs.rm(r, { recursive: true, force: true }))); });

it('fails if a caption font the engine cannot draw is saved, or the person\'s own font cannot be chosen', async () => {
  const { root, dir } = await makeProject();
  roots.push(root);
  const ctx: ToolContext = { projectDir: dir, host: new FontHost(root), style: new StyleStore(() => root), emit: () => {}, state: newToolState(), supportsImages: false };
  const listed = JSON.parse((await executeTool(ctx, 'list_library', { kind: 'fonts' })).content);
  expect(listed.fonts[0]).toMatchObject({ file: 'BrandSans-Bold.ttf', yours: true });
  // the engine falls back to its default for an unknown name; the tool refuses it before it gets that far
  const refused = await executeTool(ctx, 'set_caption_style', { font: 'Comic Neue' });
  expect(refused.isError).toBe(true);
  // content is the JSON the model reads, so the name's quotes arrive escaped
  expect(refused.content).toContain('No caption font is called \\"Comic Neue\\"');
  const set = await executeTool(ctx, 'set_caption_style', { font: 'brand sans bold' });
  expect(set.isError, set.content).toBe(false);
  expect((await loadProject(dir)).captions.style.font).toBe('Brand Sans Bold');
});
