# Sign-in service

A desktop app can't keep a platform's app secret: anyone can read it out of the installer. Instagram, Facebook,
Threads, TikTok, X and LinkedIn all need that secret to turn a sign-in into a token, so Reel Studio runs a small service that holds the
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

## Before you go live

Everything Sam has to create or submit before people outside each app's testers can post. Nothing here is done yet.
The app already points at `https://signin.getreelstudio.com` (`SIGNIN_URL` in `app/src/shared/config.ts`); use that
host or change the constant. Every platform's redirect below is `https://signin.getreelstudio.com/v1/<platform>/callback`,
except TikTok's, which returns to the app itself. Register each one exactly, with no trailing slash: Meta's dashboard
sometimes adds one, and a redirect that differs by a slash is refused.

### Once, for every platform

- [ ] A privacy policy page and a terms page on getreelstudio.com. Meta, TikTok, X, LinkedIn and Google each ask for
      their links.
- [ ] A data-deletion page for Meta: it says the service keeps nothing (tokens live encrypted on the person's computer,
      video copies are deleted after a day) and how to remove Reel Studio in each platform's settings.
- [ ] A test account on each platform that is not anyone's real account, for the first post through each app.

### The sign-in service (Cloudflare Workers, like the posting server)

- [ ] A Worker with `app/src/server/signin/worker.ts` as its entry (`main` in `wrangler.toml`; Wrangler bundles the
      `.ts` imports), routed at `signin.getreelstudio.com`.
- [ ] An R2 bucket, an S3 API token limited to it (Object Read and Write), and a lifecycle rule that deletes objects
      after 1 day. Instagram and Threads have fetched the video by then.
- [ ] Worker secrets: `SIGNIN_SECRET` (32 random bytes, see Settings), `MEDIA_BUCKET_URL`, `MEDIA_ACCESS_KEY_ID`,
      `MEDIA_SECRET_ACCESS_KEY`, and each platform's id and secret below. Plain variables: `SIGNIN_PUBLIC_URL`,
      `MEDIA_REGION=auto`, and the `*_REVIEW`, `TIKTOK_AUDITED` and `TIKTOK_DIRECT_POST` flags as approvals come in.
- [ ] A rate-limiting rule on `/v1/*`, e.g. 30 requests a minute per IP. The service checks every input, but a limit
      keeps someone from making upload links in bulk with a token they own.
- [ ] Request logging off for `/v1/*` query strings: the callback's query holds the platform's code until it is sealed.
- [ ] Check: `curl https://signin.getreelstudio.com/v1/platforms` lists every platform whose secrets are set. A half-set
      platform stops the service from starting and names the missing setting.

### Instagram (Meta app with the Instagram API with Instagram Login)

- [ ] Redirect under Instagram › API setup with Instagram login › Business login settings: `…/v1/instagram/callback`.
- [ ] Permissions: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_insights`.
- [ ] Secrets: `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`. Needs the R2 bucket.
- [ ] App Review for advanced access to all three, with a screencast of each in use; Meta may also ask for Business
      Verification. Then publish the app and set `INSTAGRAM_REVIEW=approved`. Until then only accounts added as
      Instagram testers can connect, and the app says so.

### Facebook (Meta app with Facebook Login)

- [ ] Valid OAuth Redirect URI under Facebook Login › Settings: `…/v1/facebook/callback`.
- [ ] Permissions: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` to post; `read_insights` and
      `pages_manage_engagement` so Insights can read a reel's numbers (Graph's video_insights requires both).
- [ ] Secrets: `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`.
- [ ] App Review for advanced access to the five, then publish and set `FACEBOOK_REVIEW=approved`.

### Threads (Meta app with the Threads use case)

- [ ] Redirect in the Threads use case's settings: `…/v1/threads/callback`. If those settings insist on Uninstall or
      Delete callback URLs, the service has no endpoint for them yet; adding one is small.
- [ ] Permissions: `threads_basic`, `threads_content_publish`.
- [ ] Secrets: `THREADS_APP_ID`, `THREADS_APP_SECRET` (the Threads app id and secret, not the Meta app's). Needs the
      R2 bucket.
- [ ] App Review for both permissions, then publish the app and set `THREADS_REVIEW=approved`. Until then testers
      invited under App roles (they accept in Threads' settings) can connect.

### TikTok

- [ ] A developer app with a Desktop platform, Login Kit and the Content Posting API (Upload and Direct Post on).
- [ ] Desktop redirect `http://127.0.0.1:*/tiktok/callback`: TikTok returns to the app on this computer, and the service
      only adds the secret to the token exchange (docs/tiktok.md).
- [ ] Scopes: `user.info.basic`, `video.list`, `video.upload`, `video.publish`.
- [ ] Secrets: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`; `TIKTOK_DIRECT_POST=1`.
- [ ] TikTok's app review to go live, then the Content Posting audit; set `TIKTOK_AUDITED=1` once it passes. Until
      then posts can only be Only me, and the app says so.

### X

- [ ] A Project and App in the X developer portal. User authentication settings: OAuth 2.0, type Web App (a
      confidential client), Read and write, callback `…/v1/x/callback`, website getreelstudio.com.
- [ ] Scopes: `tweet.read tweet.write users.read media.write offline.access`.
- [ ] Secrets: `X_CLIENT_ID`, `X_CLIENT_SECRET`.
- [ ] Credits on the developer account: posting through X's API is paid from them, and when they run out X answers
      402 and the app says so. There is no review step.

### LinkedIn

- [ ] An app on LinkedIn Developers, tied to a LinkedIn Page, with the products Share on LinkedIn and Sign In with
      LinkedIn using OpenID Connect (both self-serve). Authorized redirect URL: `…/v1/linkedin/callback`.
- [ ] Scopes: `openid profile w_member_social`.
- [ ] Secrets: `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`.
- [ ] The first test post confirms the Videos API (`/rest/videos`) accepts a Share on LinkedIn token. LinkedIn
      documents it under Community Management with `w_member_social` covering a member's own videos; if it refuses
      with 403, apply for the Community Management API product.

### YouTube (posting server, not this service)

- [ ] post.getreelstudio.com deployed (`app/src/main/posting.ts` describes what the app expects of it).
- [ ] Google's OAuth consent screen verified for the YouTube upload scope. Until then Google shows its unverified-app
      warning, which the post sheet explains, and Testing-mode connections end after a week.
- [ ] The Google Cloud project's YouTube Data API quota checked against expected uploads; more needs Google's
      quota extension form and its YouTube API Services audit.

The same handler runs on any host with the Fetch API (Vercel functions, Deno, Node through `node.ts`).
