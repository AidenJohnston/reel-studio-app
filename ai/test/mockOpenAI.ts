// A mock of auth.openai.com (OIDC + dynamic registration + PKCE) and api.openai.com/v1 (Responses SSE).
import * as http from 'node:http';
import { createHash, createSign, generateKeyPairSync, randomBytes, KeyObject } from 'node:crypto';

export interface MockOptions {
  deny?: boolean;
  omitPlanScope?: boolean;
  refreshError?: string;          // e.g. 'invalid_grant'
  wrongAudience?: boolean;
  badSignature?: boolean;
  accessTtl?: number;
}

export class MockOpenAI {
  server!: http.Server;
  origin = '';
  opts: MockOptions = {};
  authorizeRequests: URLSearchParams[] = [];
  tokenRequests: URLSearchParams[] = [];
  revokeRequests: URLSearchParams[] = [];
  responseBodies: any[] = [];
  /** Each call to /v1/responses pops the next handler. */
  responseHandlers: ((req: any, res: http.ServerResponse) => void)[] = [];
  private codes = new Map<string, { challenge: string; redirect: string; clientId: string; nonce: string; scope: string }>();
  private refreshTokens = new Map<string, string>(); // token -> clientId
  validAccess = new Set<string>();
  private key: { privateKey: KeyObject; publicKey: KeyObject };
  private otherKey: { privateKey: KeyObject; publicKey: KeyObject };
  issuedClientId = 'oaiapp_mock123';

  constructor() {
    this.key = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => { res.writeHead(500).end(String(e)); }));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    const a = this.server.address() as any;
    this.origin = `http://127.0.0.1:${a.port}`;
  }
  async stop(): Promise<void> { this.server.closeAllConnections?.(); await new Promise((r) => this.server.close(r)); }

  idToken(claims: Record<string, unknown>): string {
    const header = { alg: 'RS256', kid: 'k1', typ: 'JWT' };
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = `${enc(header)}.${enc(claims)}`;
    const sig = createSign('RSA-SHA256').update(data).sign(this.opts.badSignature ? this.otherKey.privateKey : this.key.privateKey).toString('base64url');
    return `${data}.${sig}`;
  }

  private tokens(clientId: string, scope: string, nonce?: string) {
    const access = `at_${randomBytes(8).toString('hex')}`;
    const refresh = `rt_${randomBytes(8).toString('hex')}`;
    this.validAccess.add(access);
    this.refreshTokens.set(refresh, clientId);
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: this.opts.accessTtl ?? 3600, scope,
      earliest_refresh_at: undefined,
      id_token: this.idToken({ iss: this.origin, aud: this.opts.wrongAudience ? 'someone_else' : clientId, sub: 'user-sub-1', email: 'person@example.com', name: 'Test Person', iat: now, exp: now + 3600, ...(nonce ? { nonce } : {}) }),
    };
  }

  private async body(req: http.IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  private json(res: http.ServerResponse, status: number, obj: unknown) {
    res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req_mock' }).end(JSON.stringify(obj));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, this.origin);
    if (url.pathname === '/.well-known/openid-configuration') {
      return this.json(res, 200, {
        issuer: this.origin, authorization_endpoint: `${this.origin}/api/accounts/authorize`, token_endpoint: `${this.origin}/api/accounts/oauth/token`,
        revocation_endpoint: `${this.origin}/api/accounts/oauth/revoke`, jwks_uri: `${this.origin}/.well-known/jwks.json`,
      });
    }
    if (url.pathname === '/.well-known/jwks.json') {
      return this.json(res, 200, { keys: [{ ...this.key.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' }] });
    }
    if (url.pathname === '/api/accounts/authorize') {
      const q = url.searchParams;
      this.authorizeRequests.push(q);
      const redirect = new URL(q.get('redirect_uri')!);
      redirect.searchParams.set('state', q.get('state')!);
      if (this.opts.deny) { redirect.searchParams.set('error', 'access_denied'); }
      else {
        const dynamic = q.get('client_id') === 'dynamic_agent_client';
        const clientId = dynamic ? this.issuedClientId : q.get('client_id')!;
        const code = `code_${randomBytes(6).toString('hex')}`;
        let scope = q.get('scope')!;
        if (this.opts.omitPlanScope) scope = scope.split(' ').filter((s) => s !== 'chatgpt.tokens.use.direct').join(' ');
        this.codes.set(code, { challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')!, clientId, nonce: q.get('nonce')!, scope });
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('scope', scope);
        if (dynamic) redirect.searchParams.set('client_id', clientId);
      }
      res.writeHead(302, { location: redirect.toString() }).end();
      return;
    }
    if (url.pathname === '/api/accounts/oauth/token' && req.method === 'POST') {
      const f = new URLSearchParams(await this.body(req));
      this.tokenRequests.push(f);
      if (f.get('resource') !== 'https://api.openai.com/v1' && f.get('resource') !== `${this.origin}/v1`) return this.json(res, 400, { error: 'invalid_target' });
      if (f.get('grant_type') === 'authorization_code') {
        const c = this.codes.get(f.get('code')!);
        this.codes.delete(f.get('code')!);
        if (!c) return this.json(res, 400, { error: 'invalid_grant' });
        const challenge = createHash('sha256').update(f.get('code_verifier')!).digest('base64url');
        if (challenge !== c.challenge || f.get('redirect_uri') !== c.redirect || f.get('client_id') !== c.clientId) return this.json(res, 400, { error: 'invalid_grant' });
        return this.json(res, 200, this.tokens(c.clientId, c.scope, c.nonce));
      }
      if (f.get('grant_type') === 'refresh_token') {
        if (this.opts.refreshError) return this.json(res, 400, { error: this.opts.refreshError });
        const rt = f.get('refresh_token')!;
        const cid = this.refreshTokens.get(rt);
        if (!cid || cid !== f.get('client_id')) return this.json(res, 400, { error: 'invalid_grant' });
        this.refreshTokens.delete(rt); // rotation: old token is single-use
        const t: any = this.tokens(cid, 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke');
        return this.json(res, 200, t);
      }
      return this.json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/api/accounts/oauth/revoke' && req.method === 'POST') {
      this.revokeRequests.push(new URLSearchParams(await this.body(req)));
      res.writeHead(200).end();
      return;
    }
    if (url.pathname === '/v1/models') {
      const tok = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!this.validAccess.has(tok)) return this.json(res, 401, { detail: 'bad token' });
      return this.json(res, 200, { models: [{ slug: 'gpt-mock-1', display_name: 'GPT Mock', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] });
    }
    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      const body = JSON.parse(await this.body(req));
      this.responseBodies.push({ body, auth: req.headers.authorization });
      const tok = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!this.validAccess.has(tok)) return this.json(res, 401, { detail: 'The required signed identity was not accepted.' });
      const h = this.responseHandlers.shift();
      if (!h) return sse(res, [{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { output: [] } }]);
      return h(body, res);
    }
    res.writeHead(404).end();
  }
}

export function sse(res: http.ServerResponse, events: any[], opts: { status?: number; cut?: boolean } = {}) {
  res.writeHead(opts.status ?? 200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_sse' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  if (opts.cut) { setTimeout(() => res.destroy(), 30); return; }
  res.end();
}

/** Simulates the system browser: follow the authorize redirect to the loopback callback. */
export function fakeBrowser(log: string[] = []) {
  return async (url: string) => {
    log.push(url);
    const r = await fetch(url, { redirect: 'manual' });
    const loc = r.headers.get('location');
    if (!loc) throw new Error('no redirect');
    setTimeout(() => { fetch(loc).catch(() => undefined); }, 5);
  };
}
