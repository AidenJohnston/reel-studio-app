# TikTok backend

For developers wiring Reel Studio's TikTok controls and hosting its authorization
broker. TikTok Login Kit, Content Posting and Display endpoints use API **v2**.
Official contracts checked on October 23, 2026:

- [Desktop Login Kit](https://developers.tiktok.com/doc/login-kit-desktop/)
- [Token exchange and refresh](https://developers.tiktok.com/doc/oauth-user-access-token-management/)
- [OAuth errors](https://developers.tiktok.com/doc/oauth-error-handling/)
- [Creator permissions](https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info/)
- [Direct Post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/)
- [Inbox upload](https://developers.tiktok.com/doc/content-posting-api-reference-upload-video/)
- [Chunk transfer](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide/)
- [Post status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status/)
- [Video statistics](https://developers.tiktok.com/doc/tiktok-api-v2-video-query/)
- [Basic account information](https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info/)

## Developer configuration

TikTok is disabled by default and restricted to the existing developer provider
mode. `window.reel.tiktok` has configuration, session, connect, cancelConnect,
disconnect, creator, publish and insights methods. No controls or background uploads are added. A publish call requires `consent: true` and all post settings.

Configure these non-secret settings through `tiktok.configure`:

| Setting | Meaning |
| --- | --- |
| `tiktokEnabled` | Enables explicit TikTok actions in developer mode. |
| `tiktokClientKey` | Public client key of the TikTok app. |
| `tiktokBrokerUrl` | HTTPS origin hosting the token handler. |
| `tiktokDirectPost` | Requests `video.publish` and permits Direct Post attempts. Defaults to false. |
| `tiktokAudited` | Set true only after TikTok approves the audit. Defaults to false because unaudited clients can publish only privately. |

## Portal setup for Sam

- Register a TikTok developer app with a Desktop platform and Login Kit.
- Register `http://127.0.0.1:*/tiktok/callback` as the Desktop redirect URI. TikTok documents wildcard ports for random loopback listeners.
- Add Content Posting API with Upload enabled. Enable Direct Post if needed.
- Request `user.info.basic`, `video.upload` and `video.list`; add `video.publish` for Direct Post. Configure Display API access for video statistics.
- Put the client key and secret in the sign-in service's settings (`docs/signin.md`); the app reads only the public key from it.
- Complete the required app and scope reviews. Obtain the Content Posting audit before enabling public Direct Post; unaudited clients remain private-only and TikTok may require a private creator account.

## Authorization through the sign-in service

Settings › Posting › TikTok has Connect, and Share has Post to TikTok. The client key and whether the app is audited
come from Reel Studio's sign-in service (`docs/signin.md`, `GET /v1/platforms`), which holds the client secret and
adds it at `POST /v1/tiktok/token` (code and refresh exchanges) and `POST /v1/tiktok/revoke` (Disconnect). The
developer settings above still win under `REELSTUDIO_DEV=1`.

The desktop generates a fresh state and verifier per connection, listens on
127.0.0.1, and opens TikTok's v2 authorization URL. TikTok specifies a **hex**
SHA-256 challenge for Desktop PKCE. The listener rejects a wrong or repeated
state and accepts one authorization code. It sends the code, redirect URI and
verifier to the sign-in service, which adds the secret and exchanges them at
`/v2/oauth/token/`. The code is decoded by URLSearchParams once.

Inbox upload plus stats requests `user.info.basic,video.list,video.upload`.
Enabling Direct Post adds `video.publish`; inbox permission remains necessary
for the explicit `direct-or-inbox` fallback. No profile or account-level stats
scopes are requested. The display name comes from `user.info.basic` rather than
the separately scoped username field.

Electron safeStorage encrypts access and refresh tokens in
`tiktok-credentials.bin`. Plaintext fallback storage is refused. Sessions returned
to the renderer contain no tokens. Refresh goes through the sign-in service, uses the
rotated refresh token, and verifies that the account did not change. Disconnect
aborts queued and running operations, clears credentials, then asks TikTok through
the sign-in service to revoke the grant (best effort, 5 seconds at most).

## Publishing and recovery

Before a Direct Post, call `creator()` to show current privacy options, duration
limit and interaction restrictions. `publish()` queries these again before init.
The caller supplies the exported duration, caption, explicit privacy selection,
interaction switches, commercial disclosures and AI disclosure. Caption length
uses TikTok's UTF-16 limit. Creator-disabled interactions remain disabled.

`mode: 'direct-or-inbox'` authorizes both routes. Direct Post is attempted only
when enabled and granted `video.publish`. A creator permission rejection allows
inbox fallback. Rate limits, bans and ambiguous responses do not trigger another
route. `mode: 'inbox'` always creates an inbox draft. Inbox init has no post_info;
the creator must select the final caption and settings inside TikTok.

Unaudited Direct Post requires an explicit `SELF_ONLY` selection. A public choice
fails with a private-only explanation before init. Publication messages retain
that restriction. The backend does not infer audit approval from a successful
request. TikTok remains the final authority on account eligibility.

The export reader opens the file, checks that its resolved path stays in the
project, then compares exact bigint device and inode values with the descriptor.
It hashes and uploads through that same descriptor. This also catches an ancestor
swapped to an outside directory during open and restored before validation.

FILE_UPLOAD uses sequential 10,000,000-byte chunks. The final chunk includes the
remainder, as required by TikTok's floor-based chunk count. Small files use one
chunk. The chosen chunk size is within the documented limits; it has not been
benchmarked. Each PUT carries Content-Length and Content-Range and sends no OAuth
header. Upload URLs must be HTTPS addresses on documented TikTok upload hosts;
redirects are refused.

`tiktok-publish.json` records the account, input and export hash, publish ID,
upload address, expiry and confirmed byte offset. Files use mode 0600. Treat the
signed upload address as a credential. A marker saved before init blocks another
init if its response is lost. A definite rejection clears that marker. Resume
checks TikTok's received byte count before transferring remaining chunks, which
also handles a lost chunk acknowledgement. Changed exports or settings cannot
resume the previous attempt.

Status requests run two seconds apart, up to five further checks per invocation.
A processing result remains resumable. Inbox delivery returns `state: 'inbox'`
and a message explaining how to finish in TikTok. Another explicit publish call
checks that existing draft's status and records the video IDs if the creator has
published it. A confirmed published result is returned unchanged on retries.
An upload cannot be restarted automatically after expiry or an uncertain init.

## Outcome records

`outcomes.json` keeps schemaVersion 1 and `versions.vN`. TikTok entries use keys
`tiktok:<postId>` so a platform-local ID cannot overwrite an Instagram ID. The
entry itself has the same version, accountId, postId, publishedAt, observedAt and
metrics fields as Instagram, with `platform: 'tiktok'` and `apiVersion: 'v2'`.
Both services share the atomic writer and serialize outcome updates.

`view_count` maps to `metrics.plays`; likes, comments and shares keep their
Instagram names. Unsupported metrics and omitted counters are null. A missing
video is reported as unavailable rather than written as zero. Insights require a
post ID linked to the saved version and account. TikTok returns public IDs only
after publication and moderation. Private posts and inbox drafts get no invented
ID or fabricated stats. Confirmed posts with no public ID remain in the publish
receipt, outside outcomes.json.

## Verification

All remote HTTP fixtures and credentials are fabricated. The callback test uses
an actual loopback listener. The safeStorage test substitute encrypts with an
ephemeral AES-GCM key; this does not verify a real OS keychain. No TikTok API call,
portal action, login or posting was performed.

Every new test was observed failing after the corresponding behavior was
removed, then restored. These are regression mutations, not claims that the
entire suite was authored before its implementation. The cancellation test also
caught a real raw AbortError before its correction. The unknown-error test caught
a TypeError for a prototype property name before the lookup was restricted to
own properties.

| Test, abbreviated | Observed failure without its behavior |
| --- | --- |
| State-bound hex PKCE and encrypted tokens | Base64url challenge rejected by the fixture; opaque codes with reserved characters also failed with HTTP 400 before the callback fix. |
| Declined consent and missing stats permission | Wrong error code replaced TT_DECLINED. |
| Cancelled token write | Connection resolved after cancellation. |
| Developer mode gate | Authorization browser work started with developer mode off. |
| Enabled setting gate | Authorization browser work started with the setting off. |
| Secure storage | Authorization started with plaintext fallback selected. |
| FILE_UPLOAD and outcome stats | Stored plays was null instead of 100. |
| Missing direct scope uses inbox | Unexpected creator request replaced inbox init. |
| Creator permission fallback | TT_PERMISSION escaped instead of returning a draft. |
| Inbox reconciliation | Returned inbox after TikTok reported publication. |
| Unaudited private-only state | Creator result claimed privateOnly false. |
| Expired access token refresh | Expired bearer request replaced the required token exchange. |
| Invalid-token retry | TT_TOKEN escaped instead of retrying after refresh. |
| Expired refresh token | HTTP exchange started instead of asking to reconnect. |
| Sequential chunk resume | Incorrect byte range resent the first chunk. |
| Lost final chunk response | Another PUT was attempted after confirmed publication. |
| Status polling | Returned processing instead of published. |
| Rate limit preserves stats | Wrong error code replaced TT_RATE_LIMIT. |
| Uncertain init prevents duplicates | Another init was attempted instead of TT_PUBLISH_UNKNOWN. |
| Failed video status | Wrong error code replaced TT_FORMAT. |
| Changed export and outside paths | A changed export reached status instead of TT_PUBLISH_CHANGED. |
| Swapped ancestor descriptor | Outside file reached HTTP instead of TT_PATH; the restored code closes its descriptor. |
| Unapproved upload host | Upload progressed instead of TT_UPLOAD_HOST. |
| Explicit consent, duration and privacy | HTTP started without consent. |
| Disconnect during refresh | Raw cancellation escaped instead of TT_CANCELLED. |
| Corrupt outcomes and wrong version | Corrupt JSON was overwritten instead of rejected. |
| Concurrent platform outcomes | Only TikTok remained; the Instagram entry was lost. |
| IPC publish and insights | IPC returned processing instead of published. |
| Broker input validation | Two upstream calls escaped the rejected-input boundary. |

The following individual error tests each failed when the HTTP error translator
was removed. Each expected its own code and a plain message; every case instead
received TT_MUTANT. The `__proto__` case separately failed with TypeError before
its lookup fix. String OAuth errors and nested API errors are both exercised.

| Provider error or HTTP status | Expected application code |
| --- | --- |
| `access_token_invalid` | `TT_TOKEN` |
| `invalid_grant` | `TT_TOKEN` |
| `auth_removed` | `TT_TOKEN` |
| `scope_not_authorized` | `TT_PERMISSION` |
| `invalid_scope` | `TT_PERMISSION` |
| `access_denied` | `TT_DECLINED` |
| `unaudited_client_can_only_post_to_private_accounts` | `TT_PRIVATE_ONLY` |
| `privacy_level_option_mismatch` | `TT_PRIVACY` |
| `spam_risk_too_many_pending_share` | `TT_DRAFT_LIMIT` |
| `spam_risk_too_many_posts` | `TT_POST_LIMIT` |
| `reached_active_user_cap` | `TT_APP_LIMIT` |
| `spam_risk_user_banned_from_posting` | `TT_BANNED` |
| `spam_risk_text` | `TT_CAPTION` |
| `spam_risk` | `TT_REJECTED` |
| `file_format_check_failed` | `TT_FORMAT` |
| `duration_check_failed` | `TT_DURATION` |
| `frame_rate_check_failed` | `TT_FRAME_RATE` |
| `picture_size_check_failed` | `TT_SIZE` |
| `video_pull_failed` | `TT_TRANSFER` |
| `photo_pull_failed` | `TT_TRANSFER` |
| `publish_cancelled` | `TT_CANCELLED` |
| `invalid_publish_id` | `TT_PUBLISH_ID` |
| `token_not_authorized_for_specified_publish_id` | `TT_ACCOUNT` |
| `url_ownership_unverified` | `TT_URL` |
| `rate_limit_exceeded` | `TT_RATE_LIMIT` |
| `invalid_client` | `TT_SETUP` |
| `unauthorized_client` | `TT_SETUP` |
| `unsupported_grant_type` | `TT_SETUP` |
| `unsupported_response_type` | `TT_SETUP` |
| `invalid_param` | `TT_INPUT` |
| `invalid_request` | `TT_INPUT` |
| `server_error` | `TT_API` |
| `temporarily_unavailable` | `TT_API` |
| `internal` | `TT_API` |
| `internal_error` | `TT_API` |
| `__proto__` | `TT_API` |
| Non-JSON HTTP 400 | `TT_API` |
| Non-JSON HTTP 403 | `TT_PERMISSION` |
| Non-JSON HTTP 404 | `TT_API` |
| Non-JSON HTTP 413 | `TT_API` |
| Non-JSON HTTP 416 | `TT_API` |
| Non-JSON HTTP 429 | `TT_RATE_LIMIT` |
| Non-JSON HTTP 500 | `TT_API` |
