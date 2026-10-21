// A mock of a person's own AI server: OpenAI-compatible (Chat Completions, /v1/models) and Anthropic-compatible
// (Messages API, streamed) on one port, like a local proxy. Records every request.
import * as http from 'node:http';

export interface MockCompatibleOptions {
  /** the key the server accepts; null = it checks no key */
  key?: string | null;
  models?: string[];
  /** answer GET .../models with 404 */
  noModelList?: boolean;
  /** answer a chat request that carries a picture with 400, like a text-only model */
  rejectImages?: boolean;
}

export class MockCompatible {
  server!: http.Server;
  origin = '';
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  /** Each POST /v1/chat/completions pops the next handler (default: a plain "OK" answer). */
  chatHandlers: ((body: any, res: http.ServerResponse) => void)[] = [];
  constructor(public opts: MockCompatibleOptions = {}) {}

  get key() { return this.opts.key === undefined ? 'sk-mock-key' : this.opts.key; }
  get models() { return this.opts.models ?? ['mock-small', 'mock-large']; }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => res.writeHead(500).end(String(e))));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.origin = `http://127.0.0.1:${(this.server.address() as any).port}`;
  }
  async stop(): Promise<void> { this.server.closeAllConnections?.(); await new Promise((r) => this.server.close(r)); }

  private json(res: http.ServerResponse, status: number, obj: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    const url = new URL(req.url!, this.origin);
    this.requests.push({ method: req.method!, path: url.pathname, headers: req.headers, body });
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const apiKey = String(req.headers['x-api-key'] ?? '');

    if (url.pathname === '/v1/models' && req.method === 'GET') {
      if (this.opts.noModelList) return this.json(res, 404, { error: { message: 'not here' } });
      if (this.key && bearer !== this.key && apiKey !== this.key) return this.json(res, 401, { error: { message: 'bad key', type: 'invalid_request_error' } });
      return this.json(res, 200, { object: 'list', data: this.models.map((id) => ({ id, object: 'model' })) });
    }
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (this.key && bearer !== this.key) return this.json(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (!this.models.includes(body?.model)) return this.json(res, 404, { error: { message: `The model \`${body?.model}\` does not exist or you do not have access to it.`, type: 'invalid_request_error', code: 'model_not_found' } });
      if (this.opts.rejectImages && hasImage(body)) return this.json(res, 400, { error: { message: 'This model does not support image input.', type: 'invalid_request_error' } });
      const h = this.chatHandlers.shift();
      if (h) return h(body, res);
      return this.json(res, 200, { id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1 } });
    }
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      if (this.key && apiKey !== this.key) return this.json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      if (!this.models.includes(body?.model)) return this.json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `model: ${body?.model}` } });
      return streamText(res, body.model, 'OK');
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('404 page not found');
  }
}

export function hasImage(body: any): boolean {
  return (body?.messages ?? []).some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p?.type === 'image_url'));
}

/** An Anthropic Messages stream that answers `text`. */
export function streamText(res: http.ServerResponse, model: string, text: string) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const ev = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } });
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
  ev('content_block_stop', { index: 0 });
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
  ev('message_stop', {});
  res.end();
}
