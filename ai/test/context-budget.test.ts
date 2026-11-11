// Pins the fixed text each AI task sends before the user's own data (ai/context-budget.json), in both shapes: "api"
// (a pasted key; tools as JSON schemas) and "cli" (Claude Code; renderConversation() plus its --system-prompt).
// After an intended change: UPDATE_CONTEXT_BUDGET=1 npm test -w ai, and commit the file.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prompts } from '../src/prompts';
import { toolSchemas } from '../src/tools';
import { DATA_BOUNDARY } from '../src/editor';
import { renderConversation } from '../src/providers/cli';

const FILE = join(__dirname, '..', 'context-budget.json');
const src = (file: string) => readFileSync(join(__dirname, '..', 'src', file), 'utf8');

// Tool lists as editor.ts passes them (undefined = every tool). Keep in step with editor.ts.
const POST_KIT_TOOLS = ['get_transcript', 'cover_candidates', 'set_cover', 'write_post', 'finish'];
const PROOFREAD_TOOLS = ['add_caption_correction', 'remove_caption_correction', 'finish'];

/** A string literal from the source, so the budget sees edits to it. Fails if the code around it changes shape. */
function literal(file: string, re: RegExp): string {
  const m = re.exec(src(file));
  if (!m) throw new Error(`context-budget.test.ts: ${re} no longer matches src/${file}; update the test`);
  return m[1];
}

function measure(): Record<string, number> {
  const prompts = new Prompts(join(__dirname, '..', 'prompts'));
  const system = `${prompts.render('system', { styleRules: '' })}\n\n${DATA_BOUNDARY}\n`;
  const claudeSystem = literal('providers/cli.ts', /'--system-prompt', '([^']+)'/);
  const postKitLead = (needCover: boolean) => {
    const [, cover, noCover] = /\$\{needCover \? '([^']+)' : '([^']+)'\}/.exec(src('editor.ts')) ?? [];
    const lead = literal('editor.ts', /const task = `(The edit of this video is saved[^$]*)\$\{needCover/);
    const tail = literal('editor.ts', /'Call write_post'\}([^$]*)\$\{deps\.prompts\.render\('firstEdit'\)/);
    if (!cover || !noCover) throw new Error('context-budget.test.ts: the post-kit lead-in in editor.ts changed shape');
    return `${lead}${needCover ? cover : noCover}${tail}`.replace(/\\n/g, '\n');
  };
  const postKitSections = prompts.render('firstEdit').split(/^## /m).filter((s) => /^\d+\. (Post kit|Cover)/.test(s)).map((s) => `## ${s}`).join('\n');
  const postKit = `${postKitLead(true)}${postKitSections}`;

  const api = (sys: string, task: string, names?: string[]) => sys.length + task.length + JSON.stringify(toolSchemas(names)).length;
  const cli = (sys: string, task: string | null, names?: string[], jsonOnly = false) =>
    claudeSystem.length + renderConversation({
      system: sys,
      messages: task === null ? [] : [{ role: 'user', content: [{ type: 'text', text: task }] }],
      tools: jsonOnly ? [] : toolSchemas(names),
      jsonOnly,
    }).text.length;

  const firstEdit = prompts.render('firstEdit');
  const applyNote = prompts.render('applyNote', { note: '' });
  const proofread = prompts.render('proofread', { captions: '' });
  return {
    'firstEdit, api (chars)': api(system, firstEdit),
    'firstEdit, cli (chars)': cli(system, firstEdit),
    'applyNote, api (chars)': api(system, applyNote),
    'applyNote, cli (chars)': cli(system, applyNote),
    'proofread, api (chars)': api(system, proofread, PROOFREAD_TOOLS),
    'proofread, cli (chars)': cli(system, proofread, PROOFREAD_TOOLS),
    'postKit, api (chars)': api(system, postKit, POST_KIT_TOOLS),
    'postKit, cli (chars)': cli(system, postKit, POST_KIT_TOOLS),
    'postKit without cover, api (chars)': api(system, `${postKitLead(false)}${postKitSections}`, POST_KIT_TOOLS),
    'writeScript, cli (chars)': cli(prompts.render('writeScript', { idea: '', styleRules: '' }), null, undefined, true),
    'pickTakes, cli (chars)': cli(prompts.render('pickTakes'), null, undefined, true),
    'system prompt (chars)': system.length,
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
