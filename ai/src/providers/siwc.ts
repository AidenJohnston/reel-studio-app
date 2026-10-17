// "Sign in with ChatGPT" for open-source apps (ChatGPT plan usage / token sharing).
// Implemented from the public docs (developers.openai.com/siwc/token-sharing-open-source/*):
// dynamic registration, PKCE (S256) in the system browser, loopback redirect on 127.0.0.1,
// plan-usage scopes, a stable per-install host id, ID-token validation against JWKS,
// rotating refresh (serialized), revocation on sign-out. One account per install (v1).
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as http from 'node:http';
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';
import { AIError, SecretStore } from '../types';
import { writeFileAtomic } from '../project';

export const SIWC_ISSUER = 'https://auth.openai.com';
export const SIWC_RESOURCE = 'https://api.openai.com/v1';
export const SIWC_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const USAGE_URL = 'https://chatgpt.com/settings/usage';
export const DYNAMIC_CLIENT = 'dynamic_agent_client';
const CALLBACK_PATH = '/auth/callback';
const DEFAULT_PORT = 1455;
const UNUSABLE_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

export interface SiwcOptions {
  settingsDir: string;
  secretStore?: SecretStore;
  appName?: string;
  /** override for tests (mock server origin) */
  issuer?: string;
  /** resource / API base; defaults to https://api.openai.com/v1 */
  resource?: string;
  redirectPort?: number;
  fetch?: typeof fetch;
  signInTimeoutMs?: number;
  now?: () => number;
  /** Without an OS keychain, tokens are only written to a plain file when this is set (the dev CLI's
   * --insecure-plaintext). Default: refuse. 0o600 is ignored on Windows. */
  allowPlaintextSecrets?: boolean;
}

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; revocation_endpoint?: string; jwks_uri: string }

/** Non-secret registration metadata (plain JSON). */
export interface ChatGPTAccount {
  clientId: string; subject?: string; email?: string; name?: string; scopes: string[];
  connectedAt?: string; signedOut?: boolean;
}
/** Secret credential record (encrypted at rest via SecretStore). */
interface Credentials {
  id_token: string; access_token: string; refresh_token?: string; token_type: string;
  expires_at: number; earliest_refresh_at?: number; scopes: string[]; saved_at: string;
}

export interface ChatGPTSession { connected: boolean; planUsage: boolean; email?: string; name?: string; needsSignIn: boolean }

const b64url = (b: Buffer) => b.toString('base64url');
const randomValue = () => b64url(randomBytes(32));

export class SiwcAuth {
  private readonly o: Required<Pick<SiwcOptions, 'appName' | 'issuer' | 'resource' | 'redirectPort' | 'signInTimeoutMs'>> & SiwcOptions;
  private discoveryCache?: Promise<Discovery>;
  private jwksCache?: { uri: string; keys: any[]; at: number };
  private refreshing?: Promise<Credentials>;
  private pendingSignIn?: AbortController;

  constructor(opts: SiwcOptions) {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) as SiwcOptions;
    this.o = { appName: 'Reel Studio', issuer: SIWC_ISSUER, resource: SIWC_RESOURCE, redirectPort: DEFAULT_PORT, signInTimeoutMs: 10 * 60_000, ...given };
  }

  private get fetch(): typeof fetch { return this.o.fetch ?? fetch; }
  private now(): number { return this.o.now ? this.o.now() : Date.now(); }
  private file(name: string) { return path.join(this.o.settingsDir, name); }

  // ------------------------------------------------------------ host id + storage

  /** Stable, opaque per-install id (urn:uuid:<v4>), created once before the first sign-in. */
  async hostId(): Promise<string> {
    const f = this.file('chatgpt-host.json');
    try {
      const j = JSON.parse(await fsp.readFile(f, 'utf8'));
      if (typeof j.ext_agent_host_id === 'string' && /^urn:uuid:[0-9a-f-]{36}$/i.test(j.ext_agent_host_id)) return j.ext_agent_host_id;
    } catch { /* create */ }
    const id = `urn:uuid:${randomUUID()}`;
    await writeFileAtomic(f, JSON.stringify({ ext_agent_host_id: id, createdAt: new Date(this.now()).toISOString() }, null, 2), 0o600);
    return id;
  }

  async account(): Promise<ChatGPTAccount | null> {
    try { return JSON.parse(await fsp.readFile(this.file('chatgpt-account.json'), 'utf8')); } catch { return null; }
  }
  private async saveAccount(a: ChatGPTAccount): Promise<void> {
    await writeFileAtomic(this.file('chatgpt-account.json'), JSON.stringify(a, null, 2), 0o600);
  }

  private async loadCredentials(): Promise<Credentials | null> {
    const enc = this.file('chatgpt-credentials.bin');
    const plain = this.file('chatgpt-credentials.json');
    try {
      if (fs.existsSync(enc) && this.o.secretStore) return JSON.parse(this.o.secretStore.decryptString(await fsp.readFile(enc)));
      if (this.o.allowPlaintextSecrets && fs.existsSync(plain)) return JSON.parse(await fsp.readFile(plain, 'utf8'));
    } catch { /* unreadable = signed out */ }
    return null;
  }
  private async saveCredentials(c: Credentials): Promise<void> {
    const ss = this.o.secretStore;
    if (ss && ss.isEncryptionAvailable()) {
      await writeFileAtomic(this.file('chatgpt-credentials.bin'), ss.encryptString(JSON.stringify(c)), 0o600);
      await fsp.rm(this.file('chatgpt-credentials.json'), { force: true });
    } else if (this.o.allowPlaintextSecrets) {
      // Explicitly allowed (dev CLI --insecure-plaintext): a plain file. Never logged.
      await writeFileAtomic(this.file('chatgpt-credentials.json'), JSON.stringify(c), 0o600);
    } else {
      throw new AIError('no_secure_storage', 'This computer has no safe place to keep your ChatGPT sign-in, so I did not save it. Sign in again from the Reel Studio app.');
    }
  }
  private async clearCredentials(): Promise<void> {
    await fsp.rm(this.file('chatgpt-credentials.bin'), { force: true });
    await fsp.rm(this.file('chatgpt-credentials.json'), { force: true });
  }

  // ------------------------------------------------------------ discovery + JWKS

  private async discovery(): Promise<Discovery> {
    this.discoveryCache ??= (async () => {
      const issuer = this.o.issuer.replace(/\/$/, '');
      let res: Response;
      try { res = await this.fetch(`${issuer}/.well-known/openid-configuration`, { headers: { accept: 'application/json' } }); } catch (e: any) {
        throw new AIError('offline', 'I could not reach ChatGPT. Check your internet connection and try again.', { retryable: true, detail: e?.message });
      }
      const d: any = await res.json().catch(() => null);
      const origin = new URL(issuer).origin;
      const sameOrigin = (u: unknown) => typeof u === 'string' && new URL(u).origin === origin;
      if (!res.ok || !d || d.issuer !== issuer || !sameOrigin(d.authorization_endpoint) || !sameOrigin(d.token_endpoint) || !sameOrigin(d.jwks_uri) ||
          (d.revocation_endpoint !== undefined && !sameOrigin(d.revocation_endpoint))) {
        throw new AIError('chatgpt_discovery', 'ChatGPT sign-in is not available right now. Try again in a few minutes.', { retryable: true, detail: 'discovery document failed validation' });
      }
      return d as Discovery;
    })().catch((e) => { this.discoveryCache = undefined; throw e; });
    return this.discoveryCache;
  }

  private async jwks(force = false): Promise<any[]> {
    const d = await this.discovery();
    if (!force && this.jwksCache && this.jwksCache.uri === d.jwks_uri && this.now() - this.jwksCache.at < 3600_000) return this.jwksCache.keys;
    const unavailable = () => new AIError('chatgpt_identity_unavailable', 'ChatGPT could not confirm your account right now. Your connection is saved. Try again shortly.', { retryable: true });
    let body: any;
    try {
      const res = await this.fetch(d.jwks_uri, { headers: { accept: 'application/json' } });
      if (res.status !== 200) throw unavailable();
      body = await res.json();
    } catch { throw unavailable(); }
    if (!body || !Array.isArray(body.keys)) throw unavailable();
    this.jwksCache = { uri: d.jwks_uri, keys: body.keys, at: this.now() };
    return body.keys;
  }

  /** Validates an RS256 ID token: signature (JWKS), iss, aud, exp, sub, nonce, azp. Returns claims. */
  async verifyIdToken(idToken: string, clientId: string, nonce?: string): Promise<Record<string, any>> {
    const bad = (why: string) => new AIError('chatgpt_invalid_identity', 'ChatGPT returned an account I could not verify. Please sign in again.', { detail: why });
    const parts = idToken.split('.');
    if (parts.length !== 3) throw bad('malformed jwt');
    let header: any; let claims: any;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { throw bad('undecodable jwt'); }
    if (header.alg !== 'RS256') throw bad(`alg ${header.alg}`);
    let keys = await this.jwks();
    let jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) { keys = await this.jwks(true); jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 && !header.kid ? keys[0] : undefined); }
    if (!jwk) throw new AIError('chatgpt_identity_unavailable', 'ChatGPT could not confirm your account right now. Try again shortly.', { retryable: true, detail: 'no matching jwk' });
    let ok = false;
    try {
      const key = createPublicKey({ key: jwk, format: 'jwk' });
      ok = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    } catch { ok = false; }
    if (!ok) throw bad('signature');
    const d = await this.discovery();
    const nowSec = this.now() / 1000;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== d.issuer) throw bad('iss');
    if (!aud.includes(clientId)) throw bad('aud');
    if (aud.length > 1 && claims.azp !== clientId) throw bad('azp');
    if (claims.azp !== undefined && claims.azp !== clientId) throw bad('azp');
    if (typeof claims.exp !== 'number' || claims.exp < nowSec - 5) throw bad('expired');
    if (typeof claims.iat !== 'number') throw bad('iat');
    if (typeof claims.sub !== 'string' || !claims.sub) throw bad('sub');
    if (nonce !== undefined && claims.nonce !== nonce) throw bad('nonce');
    return claims;
  }

  // ------------------------------------------------------------ token endpoint

  private async tokenRequest(body: URLSearchParams, signal?: AbortSignal): Promise<any> {
    const d = await this.discovery();
    let res: Response;
    try {
      res = await this.fetch(d.token_endpoint, {
        method: 'POST', body, signal, redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      });
    } catch (e: any) {
      throw new AIError('offline', 'I could not reach ChatGPT. Check your internet connection and try again.', { retryable: true, detail: e?.message });
    }
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      const code = typeof data?.error === 'string' ? data.error : (data?.error?.code ?? `http_${res.status}`);
      const err = new AIError(code, 'ChatGPT sign-in did not finish. Please try again.', { status: res.status, requestId: res.headers.get('x-request-id') ?? undefined, retryable: res.status >= 500, detail: `token endpoint: ${code}` });
      throw err;
    }
    if (!data || typeof data !== 'object') throw new AIError('chatgpt_invalid_token_response', 'ChatGPT sent back something unexpected. Please sign in again.');
    return data;
  }

  private credentialsFrom(data: any, fallbackScopes: string[], prev?: Credentials): Credentials {
    const scopes = typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : fallbackScopes;
    if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || data.expires_in <= 0 ||
        String(data.token_type ?? '').toLowerCase() !== 'bearer') {
      throw new AIError('chatgpt_invalid_token_response', 'ChatGPT sent back incomplete sign-in details. Please sign in again.');
    }
    if (scopes.includes('offline_access') && (typeof data.refresh_token !== 'string' || !data.refresh_token)) {
      throw new AIError('chatgpt_invalid_token_response', 'ChatGPT sent back incomplete sign-in details. Please sign in again.');
    }
    const earliest = data.earliest_refresh_at;
    const earliestMs = typeof earliest === 'number' ? (earliest < 1e12 ? earliest * 1000 : earliest) : typeof earliest === 'string' ? Date.parse(earliest) : undefined;
    return {
      id_token: typeof data.id_token === 'string' ? data.id_token : (prev?.id_token ?? ''),
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? prev?.refresh_token,
      token_type: 'Bearer',
      expires_at: this.now() + data.expires_in * 1000,
      ...(earliestMs && Number.isFinite(earliestMs) ? { earliest_refresh_at: earliestMs } : {}),
      scopes,
      saved_at: new Date(this.now()).toISOString(),
    };
  }

  // ------------------------------------------------------------ sign in

  /**
   * Runs the browser sign-in. `openExternal` must open the URL in the user's SYSTEM browser
   * (Electron: shell.openExternal). Resolves when the account is connected and verified.
   */
  async signIn(openExternal: (url: string) => Promise<void>, opts: { signal?: AbortSignal; newAccount?: boolean } = {}): Promise<ChatGPTSession> {
    this.pendingSignIn?.abort();
    const ac = new AbortController();
    this.pendingSignIn = ac;
    const signal = opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal;
    const hostId = await this.hostId();
    const prevAccount = opts.newAccount ? null : await this.account();
    const savedClientId = prevAccount?.clientId;
    const d = await this.discovery();
    const state = randomValue(); const nonce = randomValue(); const verifier = randomValue();
    const listener = await listenForCallback(this.o.redirectPort, state, savedClientId, signal, this.o.signInTimeoutMs);
    try {
      const url = new URL(d.authorization_endpoint);
      const q = url.searchParams;
      q.set('client_id', savedClientId ?? DYNAMIC_CLIENT);
      q.set('response_type', 'code');
      q.set('redirect_uri', listener.redirectUri);
      q.set('scope', SIWC_SCOPES);
      q.set('resource', this.o.resource);
      q.set('state', state);
      q.set('nonce', nonce);
      q.set('code_challenge_method', 'S256');
      q.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
      q.set('ext_agent_host_id', hostId);
      if (!savedClientId) q.set('agent_name_hint', this.o.appName);
      if (savedClientId && prevAccount?.email) q.set('login_hint', prevAccount.email);
      // id_token_hint is intentionally not sent: browser openers expose URLs in process arguments.
      try { await openExternal(url.toString()); } catch (e: any) {
        throw new AIError('browser_unavailable', 'I could not open your web browser. Check that you have a default browser, then try again.', { detail: e?.message });
      }
      const cb = await listener.result;
      // Save the issued registration BEFORE the one-time code exchange, so a failed exchange
      // never causes a second registration of the same app.
      const account: ChatGPTAccount = { ...(prevAccount ?? { scopes: [] }), clientId: cb.clientId, scopes: prevAccount?.scopes ?? [] };
      if (!savedClientId) await this.saveAccount({ clientId: cb.clientId, scopes: [] });
      let data: any;
      try {
        data = await this.tokenRequest(new URLSearchParams({
          grant_type: 'authorization_code', client_id: cb.clientId, code: cb.code, code_verifier: verifier,
          redirect_uri: listener.redirectUri, resource: this.o.resource,
        }), signal);
      } catch (e: any) {
        if (e?.code === 'invalid_grant') throw new AIError('chatgpt_code_expired', 'Sign-in took too long to finish. Please try again.', { detail: e.message });
        throw e;
      }
      if (typeof data.id_token !== 'string') throw new AIError('chatgpt_invalid_identity', 'ChatGPT did not confirm your account. Please sign in again.');
      const claims = await this.verifyIdToken(data.id_token, cb.clientId, nonce);
      if (prevAccount?.subject && prevAccount.subject !== claims.sub && savedClientId) {
        throw new AIError('chatgpt_account_mismatch', 'That is a different ChatGPT account than the one connected before. Sign in with the original account, or choose "Use a different account".');
      }
      const creds = this.credentialsFrom(data, []);
      creds.id_token = data.id_token;
      await this.saveCredentials(creds);
      await this.saveAccount({
        ...account, clientId: cb.clientId, subject: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : account.email,
        name: typeof claims.name === 'string' ? claims.name : account.name,
        scopes: creds.scopes, connectedAt: new Date(this.now()).toISOString(), signedOut: false,
      });
      return this.session();
    } finally {
      listener.close();
      if (this.pendingSignIn === ac) this.pendingSignIn = undefined;
    }
  }

  cancelSignIn(): void { this.pendingSignIn?.abort(); }

  async session(): Promise<ChatGPTSession> {
    const a = await this.account();
    const c = await this.loadCredentials();
    const connected = !!(a && c && c.access_token);
    return { connected, planUsage: connected && c!.scopes.includes(PLAN_SCOPE), email: a?.email, name: a?.name, needsSignIn: !connected };
  }

  // ------------------------------------------------------------ tokens

  /** Returns a valid access token, refreshing (serialized) near expiry. Throws a friendly AIError if signed out. */
  async accessToken(opts: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<string> {
    const c = await this.loadCredentials();
    if (!c) throw signedOut();
    if (!c.scopes.includes(PLAN_SCOPE)) throw planNotEnabled();
    const fresh = c.expires_at - this.now() > 60_000;
    if (fresh && !opts.forceRefresh) return c.access_token;
    if (c.earliest_refresh_at && c.earliest_refresh_at > this.now() && c.expires_at > this.now()) return c.access_token;
    const next = await this.refresh(c, opts.signal);
    return next.access_token;
  }

  private refresh(c: Credentials, signal?: AbortSignal): Promise<Credentials> {
    this.refreshing ??= (async () => {
      const a = await this.account();
      if (!a?.clientId || !c.refresh_token) { await this.clearCredentials(); throw signedOut(); }
      let data: any;
      try {
        data = await this.tokenRequest(new URLSearchParams({
          grant_type: 'refresh_token', client_id: a.clientId, refresh_token: c.refresh_token, resource: this.o.resource,
        }), signal);
      } catch (e: any) {
        if (UNUSABLE_REFRESH.has(e?.code)) { await this.clearCredentials(); throw signedOut(e?.code); }
        if (e?.code === 'invalid_client') throw new AIError('chatgpt_invalid_client', 'This copy of Reel Studio is no longer registered with ChatGPT. Choose "Use a different account" in Settings to connect again.', { detail: 'invalid_client' });
        throw e; // network / 5xx: keep credentials, retry later
      }
      const next = this.credentialsFrom(data, c.scopes, c);
      if (typeof data.id_token === 'string' && data.id_token) {
        const claims = await this.verifyIdToken(data.id_token, a.clientId);
        if (a.subject && claims.sub !== a.subject) throw new AIError('chatgpt_account_mismatch', 'ChatGPT returned a different account. Please sign in again.');
        next.id_token = data.id_token;
      }
      // Access token, expiry, scopes and the rotating refresh token are replaced together.
      await this.saveCredentials(next);
      await this.saveAccount({ ...a, scopes: next.scopes });
      return next;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  /** Revokes the renewable session, then clears tokens locally. Keeps the registration + host id. */
  async signOut(): Promise<{ remoteRevoked: boolean }> {
    const c = await this.loadCredentials();
    const a = await this.account();
    let remoteRevoked = !c?.refresh_token;
    if (c?.refresh_token && a?.clientId) {
      try {
        const d = await this.discovery();
        if (d.revocation_endpoint) {
          for (let attempt = 0; attempt < 3 && !remoteRevoked; attempt++) {
            try {
              const res = await this.fetch(d.revocation_endpoint, {
                method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: c.refresh_token, token_type_hint: 'refresh_token', client_id: a.clientId }),
              });
              if (res.status === 200) remoteRevoked = true;
              else if (res.status < 500) break;
            } catch { /* network: retry */ }
            if (!remoteRevoked) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
          }
        }
      } catch { /* discovery failed */ }
    }
    await this.clearCredentials();
    if (a) await this.saveAccount({ ...a, signedOut: true });
    return { remoteRevoked };
  }

  /** Called when the API confirms the session is dead (e.g. disconnected in ChatGPT settings). */
  async markDisconnected(): Promise<void> { await this.clearCredentials(); }
}

export function signedOut(detail?: string): AIError {
  return new AIError('chatgpt_signed_out', 'Your ChatGPT sign-in has ended. Sign in with ChatGPT again in Settings.', { detail });
}
export function planNotEnabled(): AIError {
  return new AIError('chatgpt_plan_not_enabled', 'You are signed in, but Reel Studio was not allowed to use your ChatGPT plan. Sign in again and allow it, or add a Claude key in Settings.');
}

// ---------------------------------------------------------------- loopback listener

interface CallbackResult { code: string; clientId: string }

export async function listenForCallback(port: number, state: string, savedClientId: string | undefined, signal: AbortSignal, timeoutMs: number) {
  let done!: (v: CallbackResult) => void; let fail!: (e: Error) => void; let settled = false;
  const result = new Promise<CallbackResult>((res, rej) => { done = res; fail = rej; });
  result.catch(() => undefined);
  const finish = (v: CallbackResult | Error) => { if (settled) return; settled = true; v instanceof Error ? fail(v) : done(v); };
  let actualPort = port;
  const page = (title: string, body: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><style>body{font:17px system-ui,sans-serif;max-width:32rem;margin:18vh auto;padding:24px;color:#1d1b18;background:#f7f5f1}h1{font-size:26px}</style><h1>${title}</h1><p>${body}</p></html>`;
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    let url: URL;
    try { url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`); } catch { res.writeHead(400).end(); return; }
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH || settled) { res.writeHead(404).end('Not found'); return; }
    const got = Buffer.from(url.searchParams.get('state') ?? '');
    const want = Buffer.from(state);
    if (url.searchParams.getAll('state').length !== 1 || got.length !== want.length || !timingSafeEqual(got, want)) {
      // Unrelated requests must not consume the pending sign-in.
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Sign-in link expired', 'Go back to Reel Studio and click Sign in with ChatGPT again.'));
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Not connected', 'You can close this tab and go back to Reel Studio.'));
      finish(error === 'access_denied'
        ? new AIError('chatgpt_declined', 'ChatGPT was not connected because the permission was not allowed. You can try again any time.')
        : new AIError(`chatgpt_${error}`, 'ChatGPT sign-in did not finish. Please try again.', { detail: url.searchParams.get('error_description') ?? error }));
      return;
    }
    const code = url.searchParams.get('code');
    const returned = url.searchParams.get('client_id');
    const clientId = returned ?? savedClientId;
    if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('client_id').length > 1 ||
        !clientId || clientId === DYNAMIC_CLIENT || !/^[A-Za-z0-9_-]{1,200}$/.test(clientId) ||
        (savedClientId && returned && returned !== savedClientId)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('Not connected', 'Something went wrong. Go back to Reel Studio and try again.'));
      finish(new AIError('chatgpt_registration_incomplete', 'ChatGPT did not finish connecting Reel Studio. Please try signing in again.'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('You are connected', 'You can close this tab and go back to Reel Studio.'));
    finish({ code, clientId });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const listen = (p: number) => new Promise<void>((resolve, reject) => {
    const onErr = (e: Error) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen({ port: p, host: '127.0.0.1' });
  });
  try {
    await listen(port);
  } catch (e: any) {
    // Only the port may vary between sign-ins; scheme, host and path stay fixed.
    if (e?.code !== 'EADDRINUSE' || port === 0) throw new AIError('chatgpt_port', 'Reel Studio could not start sign-in. Close other copies of the app and try again.', { detail: e?.message });
    await listen(0);
  }
  const addr = server.address();
  if (addr && typeof addr === 'object') actualPort = addr.port;
  const timer = setTimeout(() => finish(new AIError('chatgpt_timeout', 'Sign-in timed out. Click Sign in with ChatGPT to try again.')), timeoutMs);
  timer.unref?.();
  const onAbort = () => finish(new AIError('cancelled', 'Sign-in was cancelled.'));
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const close = () => {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    server.close();
    server.closeAllConnections?.();
  };
  return { result, close, redirectUri: `http://127.0.0.1:${actualPort}${CALLBACK_PATH}` };
}
