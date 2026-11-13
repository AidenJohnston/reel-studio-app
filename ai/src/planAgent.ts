// The AI proposes the plan (plan.ts) before the first edit: one short run whose only change is propose_plan.
import { AgentEvent, AIError, ModelProvider } from './types';
import { runAgent } from './agent';
import { EditorDeps, ensureAnalyzed, systemPrompt } from './editor';
import { loadProject } from './project';
import { Plan, toMarkdown } from './plan';
import { newToolState, ToolContext } from './tools';

/** Reads the words and the library, then proposes; nothing else in the project changes. */
export const PLAN_TOOLS = ['get_transcript', 'list_library', 'propose_plan', 'finish'];

export async function proposePlan(deps: EditorDeps, provider: ModelProvider | null, projectDir: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<{ summary: string; plan: Plan }> {
  if (!provider) throw new AIError('no_ai', 'Connect ChatGPT or Claude in Settings so I can plan your video.');
  await ensureAnalyzed(deps, projectDir, onEvent, signal);
  onEvent({ type: 'status', message: 'Planning your video', pct: 10, phase: 'edit' });
  const before = await loadProject(projectDir);
  const ctx: ToolContext = {
    projectDir, host: deps.host, style: deps.style, emit: onEvent, signal, state: newToolState(),
    supportsImages: provider.supportsImages, fetchImpl: deps.fetchImpl, lookupImpl: deps.lookup,
  };
  // the plan so far is the creator's own text and the AI's earlier proposal: what to keep and build on
  const task = deps.prompts.render('plan') + (before.plan ? `\n\n## The plan so far\n\n${toMarkdown(before.plan)}` : '');
  const r = await runAgent({ provider, system: await systemPrompt(deps), task, ctx, onEvent, signal, maxSteps: 8, tokenBudget: deps.tokenBudget, tools: PLAN_TOOLS, preload: ['get_transcript'] });
  const plan = (await loadProject(projectDir)).plan;
  if (!ctx.state.changed.has('plan') || !plan) throw new AIError('plan_failed', 'I could not plan this video this time. Try again.');
  onEvent({ type: 'status', message: 'Done', pct: 100 });
  return { summary: r.finished ?? 'Here is a plan for your video. Approve the pictures you want, and I will edit it.', plan };
}
