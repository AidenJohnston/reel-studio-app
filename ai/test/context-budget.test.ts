// The fixed text each AI task sends the model before any of the user's project: prompts, the data boundary and the
// tool definitions. Two shapes: "api" (a pasted API key; tools go as JSON schemas) and "cli" (the user's Claude Code or
// Codex; tools go as the text catalog protocolPrompt() writes). Preloaded project data is the user's own, so it is
// left out; so is the one-line post-kit lead-in editor.ts writes inline. Every character is paid for on the user's own AI plan, on every call, so it is pinned in
// ai/context-budget.json. This test keeps that file equal to the measurement; the "AI context budget" workflow fails a
// pull request that raises a number unless a maintainer accepts it with the ai-context-increase label.
// After an intended change: UPDATE_CONTEXT_BUDGET=1 npm test -w ai, and commit the file.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prompts } from '../src/prompts';
import { toolSchemas } from '../src/tools';
import { DATA_BOUNDARY } from '../src/editor';
import { protocolPrompt } from '../src/providers/cli';

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
  const cli = (names?: string[], jsonOnly = false) => protocolPrompt(jsonOnly ? [] : toolSchemas(names), jsonOnly).length;
  const firstEdit = system.length + prompts.render('firstEdit').length;
  const applyNote = system.length + prompts.render('applyNote', { note: '' }).length;
  const proofread = system.length + prompts.render('proofread', { captions: '' }).length;
  const postKit = system.length + postKitSections.length;
  const writeScript = prompts.render('writeScript', { idea: '', styleRules: '' }).length;
  const pickTakes = prompts.render('pickTakes').length;
  return {
    'firstEdit, api (chars)': firstEdit + tools(),
    'firstEdit, cli (chars)': firstEdit + cli(),
    'applyNote, api (chars)': applyNote + tools(),
    'applyNote, cli (chars)': applyNote + cli(),
    'proofread, api (chars)': proofread + tools(PROOFREAD_TOOLS),
    'proofread, cli (chars)': proofread + cli(PROOFREAD_TOOLS),
    'postKit, api (chars)': postKit + tools(POST_KIT_TOOLS),
    'postKit, cli (chars)': postKit + cli(POST_KIT_TOOLS),
    'writeScript, cli (chars)': writeScript + cli(undefined, true),
    'pickTakes, cli (chars)': pickTakes + cli(undefined, true),
    'system prompt (chars)': system.length,
    'all tool definitions, api (chars)': tools(),
    'all tool definitions, cli (chars)': cli(),
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
