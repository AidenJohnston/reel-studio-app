// The fixed text each AI task sends the model before any of the user's project: prompts, the data boundary and the
// tool definitions. Every character is paid for on the user's own AI plan, on every call, so it is pinned in
// ai/context-budget.json. This test keeps that file equal to the measurement; the "AI context budget" workflow fails a
// pull request that raises a number unless a maintainer accepts it with the ai-context-increase label.
// After an intended change: UPDATE_CONTEXT_BUDGET=1 npm test -w ai, and commit the file.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prompts } from '../src/prompts';
import { toolSchemas } from '../src/tools';
import { DATA_BOUNDARY } from '../src/editor';

const FILE = join(__dirname, '..', 'context-budget.json');

// Tool lists as editor.ts passes them (undefined = every tool). Keep in step with editor.ts.
const POST_KIT_TOOLS = ['get_transcript', 'cover_candidates', 'set_cover', 'write_post', 'finish'];
const PROOFREAD_TOOLS = ['add_caption_correction', 'remove_caption_correction', 'finish'];

function measure(): Record<string, number> {
  const prompts = new Prompts(join(__dirname, '..', 'prompts'));
  // Style rules and the user's text are the user's own, so they are left out: empty here.
  const system = `${prompts.render('system', { styleRules: '' })}\n\n${DATA_BOUNDARY}\n`;
  const tools = (names?: string[]) => JSON.stringify(toolSchemas(names)).length;
  const postKitSections = prompts.render('firstEdit').split(/^## /m).filter((s) => /^\d+\. (Post kit|Cover)/.test(s)).map((s) => `## ${s}`).join('\n');
  return {
    'firstEdit (chars)': system.length + prompts.render('firstEdit').length + tools(),
    'applyNote (chars)': system.length + prompts.render('applyNote', { note: '' }).length + tools(),
    'proofread (chars)': system.length + prompts.render('proofread', { captions: '' }).length + tools(PROOFREAD_TOOLS),
    'postKit (chars)': system.length + postKitSections.length + tools(POST_KIT_TOOLS),
    'writeScript (chars)': prompts.render('writeScript', { idea: '', styleRules: '' }).length,
    'pickTakes (chars)': prompts.render('pickTakes').length,
    'system prompt (chars)': system.length,
    'all tool definitions (chars)': tools(),
    'tools (count)': toolSchemas().length,
  };
}

describe('AI context budget', () => {
  it('ai/context-budget.json matches what the tasks send', () => {
    const measured = measure();
    if (process.env.UPDATE_CONTEXT_BUDGET === '1') writeFileSync(FILE, JSON.stringify(measured, null, 2) + '\n');
    const pinned = JSON.parse(readFileSync(FILE, 'utf8'));
    expect(pinned, 'ai/context-budget.json is out of date: run UPDATE_CONTEXT_BUDGET=1 npm test -w ai and commit it').toEqual(measured);
  });
});
