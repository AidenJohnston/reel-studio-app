# Sign-in service

A desktop app can't keep a platform's app secret: anyone can read it out of the installer. Instagram, Facebook and
TikTok all need that secret to turn a sign-in into a token, so Reel Studio runs a small service that holds the
secrets and does that one step. The app keeps the tokens (encrypted with the OS keychain) and calls each platform
itself. YouTube is different: it goes through the posting server (`app/src/main/posting.ts`), which keeps Google's
tokens on the server.

Code: `app/src/server/signin/`. Tests: `app/test/signin-service.test.ts`, and `app/e2e/social.spec.ts` runs the real
app through it. It is not deployed.

## What it does

| Call | For | What happens |
| --- | --- | --- |
| `GET /v1/platforms` | the app, on Settings › Posting and Share | Which platforms it has an app for, each app's public id, and where approval stands (`testers` until Meta approves; TikTok `audited`). |
| `POST /v1/{instagram,facebook,threads,x,linkedin}/start` | the app | Takes the app's state, its loopback address (`http://127.0.0.1:<port>/<platform>/callback`, nothing else) and a PKCE S256 challenge. Returns the platform's sign-in link. |
| `GET /v1/{instagram,facebook,threads,x,linkedin}/callback` | the platform | The registered redirect. Sends the person on to the app's loopback address with the app's state and a sealed handoff. A link it can't read gets a plain page, never a redirect. |
| `POST /v1/{instagram,facebook,threads,x,linkedin}/complete` | the app | Handoff and PKCE verifier in, token out. For X the service also runs X's own PKCE (its verifier rides in the sealed state) and returns the refresh token. Instagram's and Threads' short-lived tokens are traded for 60-day ones; Facebook's for a long-lived user token. Only the holder of the verifier can redeem a handoff. |
| `POST /v1/{instagram,threads}/uploads` | the app | Instagram and Threads fetch a video from a link, so this makes a 10-minute upload link and a 6-hour read link for one video (and cover) in object storage, after checking the token (on Instagram, that it belongs to a Business or Creator account). |
| `POST /v1/x/refresh`, `POST /v1/x/revoke` | the app | X's tokens last two hours; refreshing (X replaces the refresh token each time) and Disconnect need the client secret. |
| `POST /v1/tiktok/token` | the app | TikTok signs a desktop app in on its own loopback address with its own PKCE (docs/tiktok.md); this adds the secret to the code or refresh-token exchange. |
| `POST /v1/tiktok/revoke` | the app | Disconnect asks TikTok to end the grant. |

Instagram and Threads tokens refresh without the secret, so the app does that itself. Disconnect for Instagram and Threads forgets
the token on the computer (the person removes the app in the platform's settings to end the grant there); for Facebook it also ends the access at Facebook.

Storage links go only to accounts that signed in through the service. At `complete` for Instagram and Threads the
service also returns an `upload_pass`: the account id, sealed with its own purpose and a 90-day expiry. The uploads call
needs the pass and a token for that same account, so an Instagram token from any other app gets nothing. After 90
days, Connect again.

### Why nothing is stored

The state sent to the platform and the handoff sent to the app are sealed: AES-256-GCM under a key derived from
`SIGNIN_SECRET`, bound to their purpose ("state", "handoff" or "upload") and with their own expiry (10 and 5 minutes). The
service needs no database, so it runs as a single stateless function. The authorization code inside a handoff is
encrypted, so the loopback address never carries a readable code or a token. A platform code is single-use, so a
replayed handoff fails at the platform.

## Settings

| Variable | |
| --- | --- |
| `SIGNIN_PUBLIC_URL` | The service's own origin, e.g. `https://signin.getreelstudio.com`. Every platform's redirect is `<origin>/v1/<platform>/callback`. |
| `SIGNIN_SECRET` | base64url of at least 32 random bytes: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Changing it ends every sign-in in progress, nothing else. |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REVIEW` | The Instagram app (Instagram API with Instagram Login). `INSTAGRAM_REVIEW=approved` once Meta approves it; until then only accounts added to the app as testers can connect, and the app says so. |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_REVIEW` | The Facebook app (Facebook Login, Pages). |
| `THREADS_APP_ID`, `THREADS_APP_SECRET`, `THREADS_REVIEW` | The Threads app (`threads_basic`, `threads_content_publish`). Until Meta gives it advanced access, only Threads testers can connect. Needs the storage below. |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_AUDITED`, `TIKTOK_DIRECT_POST` | `1` or `0`. Until TikTok audits the app, posts are Only me and the app says so. |
| `X_CLIENT_ID`, `X_CLIENT_SECRET` | An X app with OAuth 2.0 as a confidential client, scopes `tweet.read tweet.write users.read media.write offline.access`. Posting through X's API is paid for on the developer account; when the credits run out the app says so. |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | A LinkedIn app with the "Share on LinkedIn" and "Sign In with LinkedIn using OpenID Connect" products (`openid profile w_member_social`). Tokens last 60 days and LinkedIn gives refresh tokens only to partner apps, so people connect again then. |
| `MEDIA_BUCKET_URL`, `MEDIA_ACCESS_KEY_ID`, `MEDIA_SECRET_ACCESS_KEY`, `MEDIA_REGION` | S3-compatible storage for Instagram's copy, as `https://<host>/<bucket>`. `MEDIA_REGION` is `auto` for R2. Instagram stays off without it. |

A platform is on when its id and secret are both set. One without the other, or Instagram or Threads without storage, stops the
service from starting with the name of the missing setting.

## Run it on this computer

```
cd app
SIGNIN_SECRET=... INSTAGRAM_APP_ID=... INSTAGRAM_APP_SECRET=... MEDIA_BUCKET_URL=... MEDIA_ACCESS_KEY_ID=... MEDIA_SECRET_ACCESS_KEY=... npm run signin
REELSTUDIO_SIGNIN_URL=http://127.0.0.1:8787 npm run dev
```

`npm run signin` needs Node 22.6 or later. A platform has to be able to reach the redirect: register
`http://127.0.0.1:8787/v1/<platform>/callback` with a developer app where the platform allows it, or run the service
behind an https tunnel and set `SIGNIN_PUBLIC_URL` to the tunnel's address. Use a test account, never a real one.

## Deploy

Not done yet. What it takes, on Cloudflare Workers (the posting server runs there too):

1. A Worker with `app/src/server/signin/worker.ts` as its entry (`main` in `wrangler.toml`; Wrangler bundles the
   `.ts` imports), on `signin.getreelstudio.com`. The variables above as Worker secrets.
2. An R2 bucket with an S3 API token limited to that bucket (Object Read and Write), and a lifecycle rule that deletes
   objects after 1 day: Instagram has the video by then.
3. A rate-limiting rule on `/v1/*`, e.g. 30 requests a minute per IP. The service checks every input, but a limit
   keeps someone from making upload links in bulk with a token they own.
4. Each platform's developer app, with the redirect above:
   - Meta: an Instagram app with `instagram_business_basic`, `instagram_business_content_publish` and
     `instagram_business_manage_insights`; a Facebook app with `pages_show_list`, `pages_read_engagement`,
     `pages_manage_posts` and `read_insights`. Both go through Meta's App Review before people outside the app's
     testers can connect.
   - TikTok: a Desktop app with Login Kit and the Content Posting API (docs/tiktok.md). TikTok's audit lifts Only me.
5. Logs: the service writes none itself. Keep Workers' request logging off for `/v1/*` query strings, since the
   callback's query holds the platform's code until it is sealed.

The same handler runs on any host with the Fetch API (Vercel functions, Deno, Node through `node.ts`).
