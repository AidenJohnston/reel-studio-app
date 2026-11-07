import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { AIError, ChatMessage } from '../types';
import { Harness, HarnessRun } from '../harness';
import { DEFAULT_TOKEN_BUDGET, RunAgentResult, effectiveTokens, preloadText } from '../agent';
import { cliEnv } from '../safety';
import { endTree } from '../engineHost';
import { ClaudeCodeOptions, RELAY_SCRIPT, TOOL_TIMEOUT_MS } from './claudeCode';
import { McpRun } from './run';

export type CodexOptions = Pick<ClaudeCodeOptions, 'bin' | 'binArgs' | 'model' | 'extraArgs' | 'relay' | 'timeoutMs' | 'env'>;
type Outcome = { stoppedBy: RunAgentResult['stoppedBy'] } | { error: unknown };

/** codex exec owns its native loop; only the note's MCP tools can write the edit. Keep this dev
 * only: feature switches are CLI-version dependent, and read-only is the second boundary. */
export class CodexHarness implements Harness {
  readonly id = 'codex' as const;
  // MCP image delivery has not been measured with Codex, so do not promise image input.
  readonly supportsImages = false;
  /** unset: the Codex app's own default for the person's plan (no --model), as the Codex editor runs it */
  readonly model?: string;
  constructor(private readonly o: CodexOptions = {}) { this.model = o.model; }

  async run(o: HarnessRun): Promise<RunAgentResult> {
    if (o.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
    const pre = o.preload?.length ? await preloadText(o.ctx, o.preload) : '';
    let decide: (result: Outcome) => void = () => undefined;
    const outcome = new Promise<Outcome>((resolve) => {
      let done = false;
      decide = (result) => { if (!done) { done = true; resolve(result); } };
    });
    const run = await McpRun.open({
      ctx: o.ctx, tools: o.tools, customTools: o.customTools, maxSteps: o.maxSteps, onEvent: o.onEvent,
      onStop: (why) => decide(why === 'steps' ? { stoppedBy: 'steps' } : { error: run.failure }),
    });
    try {
      const systemFile = path.join(run.dir, 'system.txt');
      await fsp.writeFile(systemFile, o.system, { mode: 0o600 });
      // A fresh empty cwd keeps project config and instructions out. Auth still uses CODEX_HOME;
      // --ignore-user-config suppresses its servers, hooks and user feature choices.
      const cwd = path.join(run.dir, 'cwd');
      await fsp.mkdir(cwd, { mode: 0o700 });
      const relay = this.o.relay ?? { command: process.execPath, args: [RELAY_SCRIPT] };
      const config = {
        'mcp_servers.reelstudio.command': relay.command,
        'mcp_servers.reelstudio.args': relay.args,
        'mcp_servers.reelstudio.env_vars': ['ELECTRON_RUN_AS_NODE', 'REELSTUDIO_SOCKET', 'REELSTUDIO_RUN', 'REELSTUDIO_RUN_TOKEN'],
        'mcp_servers.reelstudio.enabled_tools': o.tools,
        'mcp_servers.reelstudio.required': true,
        'mcp_servers.reelstudio.tool_timeout_sec': TOOL_TIMEOUT_MS / 1000,
        'model_instructions_file': systemFile,
        'project_doc_max_bytes': 0,
        'web_search': 'disabled',
        'approval_policy': 'never',
      };
      const args = [
        ...(this.o.binArgs ?? []), '--no-daemon', 'exec', '--strict-config', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--sandbox', 'read-only',
        ...['shell_tool', 'unified_exec', 'memories', 'apps', 'plugins', 'multi_agent', 'view_image', 'hooks', 'browser_use', 'computer_use', 'skill_search', 'image_generation'].flatMap((f) => ['--disable', f]),
        ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
        ...(this.model ? ['--model', this.model] : []), ...(this.o.extraArgs ?? []), '-',
      ];
      return await this.drive(o, run, args, cwd, pre, outcome, decide);
    } finally { await run.close(); }
  }

  private async drive(o: HarnessRun, run: McpRun, args: string[], cwd: string, pre: string, outcome: Promise<Outcome>, decide: (result: Outcome) => void): Promise<RunAgentResult> {
    const child = spawn(this.o.bin ?? 'codex', args, {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: cliEnv(this.o.env, { ELECTRON_RUN_AS_NODE: '1', REELSTUDIO_SOCKET: run.socket, REELSTUDIO_RUN: run.id, REELSTUDIO_RUN_TOKEN: run.token }),
    });
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: o.task + pre }] }];
    let tokens = 0; let turns = 0; let errTail = '';
    const budget = o.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const budgetError = () => new AIError('token_budget', 'This edit was taking too much AI work, so I stopped to protect your AI usage.', { detail: `${tokens} effective tokens > budget ${budget}` });
    child.stdin.on('error', () => undefined);
    child.stderr.setEncoding('utf8').on('data', (text: string) => { errTail = (errTail + text).slice(-800); });
    child.on('error', () => decide({ error: new AIError('cli_missing', 'The codex command line tool is not installed or not on PATH.') }));
    child.on('close', (code) => {
      if (tokens > budget) decide({ error: budgetError() });
      else if (code !== 0) decide({ error: new AIError('cli_error', 'Codex did not finish the edit.', { detail: `exit ${code}: ${errTail}` }) });
      else decide({ stoppedBy: o.ctx.state.finished !== null ? 'finish' : 'no_tools' });
    });
    let buf = '';
    const event = (j: unknown) => {
      if (!j || typeof j !== 'object' || !('type' in j)) return;
      if (j.type === 'turn.completed') {
        turns++;
        if ('usage' in j && j.usage && typeof j.usage === 'object') {
          const u = j.usage;
          const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
          const input = num('input_tokens' in u ? u.input_tokens : 0);
          const output = num('output_tokens' in u ? u.output_tokens : 0);
          const cached = num('cached_input_tokens' in u ? u.cached_input_tokens : 0);
          // Codex's input_tokens includes cached_input_tokens; effectiveTokens expects uncached input.
          tokens += effectiveTokens({ input: Math.max(0, input - cached), output, cacheRead: cached }, 0);
          if (tokens > budget) decide({ error: budgetError() });
        }
      } else if (j.type === 'turn.failed' || j.type === 'error') {
        const detail = 'error' in j ? JSON.stringify(j.error) : 'message' in j ? String(j.message) : '';
        const limited = /quota|rate.?limit|usage.?limit/i.test(detail);
        if (/at capacity|overloaded/i.test(detail)) return decide({ error: new AIError('cli_unavailable', 'Codex is at capacity. Try again later.', { retryable: true }) });
        decide({ error: new AIError(limited ? 'cli_limited' : 'cli_error', limited ? 'Codex hit its usage limit. Try again later.' : 'Codex had a problem answering.') });
      } else if ((j.type === 'item.started' || j.type === 'item.completed') && 'item' in j && j.item && typeof j.item === 'object') {
        const item = j.item;
        if (!('type' in item)) return;
        if (item.type === 'command_execution' || item.type === 'file_change') {
          decide({ error: new AIError('harness_tools', 'Codex used a tool Reel Studio does not control, so I stopped.') });
        } else if (j.type === 'item.completed' && item.type === 'agent_message' && 'text' in item && typeof item.text === 'string') {
          messages.push({ role: 'assistant', text: item.text, toolCalls: [] });
        } else if (j.type === 'item.completed' && item.type === 'mcp_tool_call') {
          if (!('server' in item) || item.server !== 'reelstudio') decide({ error: new AIError('harness_tools', 'Codex called another MCP server, so I stopped.') });
        }
      }
    };
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      buf += text;
      let end: number;
      while ((end = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, end); buf = buf.slice(end + 1);
        try { event(JSON.parse(line)); } catch { /* ignore non-JSON CLI notices */ }
      }
    });
    const abort = () => decide({ error: new AIError('cancelled', 'Stopped.') });
    o.signal?.addEventListener('abort', abort, { once: true });
    if (o.signal?.aborted) abort();
    const timer = setTimeout(() => decide({ error: new AIError('cli_timeout', 'Codex took too long to answer.') }), this.o.timeoutMs ?? 30 * 60_000);
    try {
      child.stdin.end(o.task + pre);
      const result = await outcome;
      await run.idle();
      const alive = child.exitCode === null && child.signalCode === null;
      if (alive || process.platform !== 'win32') await endTree(child.pid, () => { if (alive) child.kill('SIGKILL'); });
      await exited;
      if ('error' in result) throw result.error;
      if (o.signal?.aborted) throw new AIError('cancelled', 'Stopped.');
      return { finished: o.ctx.state.finished, steps: turns, messages, tokens, stoppedBy: result.stoppedBy };
    } finally { clearTimeout(timer); o.signal?.removeEventListener('abort', abort); }
  }
}
