# Instagram backend

API version **v26.0**, checked against Meta's official documentation on 2026-10-23:

- [Business Login for Instagram](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
- [Account fields](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started)
- [Content publishing](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
- [Media container creation and cover specifications](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media)
- [Media insights](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights/)
- [Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/)
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)

This backend connects one Professional account per installation. It uses Instagram Login on `graph.instagram.com`, without a Facebook Page. The required permissions are exactly:

```
instagram_business_basic
instagram_business_content_publish
instagram_business_manage_insights
```

The app rejects Personal accounts before saving a connection or uploading a video. A Business or Creator account is required. Some insights can be delayed by 48 hours; absent values remain `null`, never invented zeros.

## Connecting

Settings › Posting › Instagram has Connect, and Share has Post to Instagram. Both go through Reel Studio's sign-in
service (`docs/signin.md`), which holds the Instagram App Secret: the app asks it for Instagram's sign-in link,
Instagram sends the person back through it to the app's loopback listener with a sealed handoff, and the app trades the
handoff and its PKCE verifier for the long-lived token. The app opens only `https://www.instagram.com/oauth/authorize`
for the app id the service lists, with the service's own callback as the redirect. Videos go up through the service's
short-lived storage links (`POST /v1/instagram/uploads`), since Instagram Login fetches a reel from a URL: Meta allows
direct (resumable) upload only with Facebook Login for Business.

Until Meta approves the app, only accounts added to it as testers can connect, and Settings and the post sheet say so.
When the service can't be reached, or has no Instagram app, the row says that and Share keeps Save for Instagram (the
reel saved, its caption copied).

A developer can point the app at their own Instagram app with `REELSTUDIO_DEV=1` and the saved settings below
(`reel.instagram.configure`); they win over the service's list:

```ts
await reel.instagram.configure({
  instagramEnabled: true,
  instagramAppId: '<Instagram app ID>',
  instagramBrokerUrl: 'https://<your sign-in service>',
  instagramUploadOrigins: ['https://<its storage host>']
})
```

`session` returns account ID, username, picture and expiry without exposing credentials. `connect` opens the system
browser, `cancelConnect` closes its pending callback, and `disconnect` cancels current work and deletes the local
encrypted token. Disconnect is local sign-out; it does not revoke Meta permissions. Removing access in Instagram also
invalidates the connection.

Publishing reads the finished `versions/vN/export.mp4`. An image cover reads that version's `cover.png` and converts it
to JPEG because Meta requires JPEG covers; a frame cover passes `thumb_offset`. `trial: { graduation: 'MANUAL' }` (or
`SS_PERFORMANCE`) posts it as a trial reel, shown first to people who don't follow the account; outcomes.json keeps
`trial` on the post. Caption length is limited to 2,200 Unicode code points. Meta validates the remaining media
constraints; the backend does not transcode.

Tokens are encrypted with Electron's safeStorage in `instagram-credentials.bin` under app data, written atomically with
owner-only file permissions. There is no plaintext fallback. Linux `basic_text` storage is rejected.

Refresh happens before API work when at most seven days remain. Seven days is a conservative maintenance window, not a
measured optimum. Meta permits refresh only while the long-lived token is valid and at least 24 hours old, and the
refresh needs no app secret, so the app calls Meta's `/refresh_access_token` itself. An expired or revoked connection
requires a new sign-in. There is no background network activity or automatic posting.

## Publishing and outcomes

The client creates `POST /v26.0/<account-id>/media` with `media_type=REELS`, `video_url`, caption and `cover_url` or `thumb_offset`. It checks `GET /v26.0/<container-id>?fields=status_code` immediately and then once per minute for up to five minutes. Only `FINISHED` permits `POST /v26.0/<account-id>/media_publish` with `creation_id`. Processing can resume on a later call for the same version without reuploading it. A saved SHA-256 fingerprint binds the container to its caption and cover choice; changed settings are rejected instead of silently publishing old metadata.

`instagram-publish.json` records the account, container and publish state before issuing the publish call. One publish is allowed per project version. A repeated call returns the recorded post. Concurrent calls in this main process are serialized. After a lost response or a crash during publishing, the saved `publishing` state blocks another attempt because the reel might already be public. Support must reconcile the container and Instagram account before clearing that record. A definite rejected request, such as a rate limit, leaves the processed container available for retry. A local write failure after success reports the returned post ID. Do not blindly retry by creating a new version.

`outcomes.json` has this shape, preserving other versions and post IDs on each atomic update:

```json
{
  "schemaVersion": 1,
  "versions": {
    "v1": {
      "<post-id>": {
        "version": 1,
        "accountId": "<Instagram account ID>",
        "postId": "<post-id>",
        "publishedAt": "<ISO timestamp>",
        "platform": "instagram",
        "apiVersion": "v26.0",
        "observedAt": "<ISO timestamp or null>",
        "metrics": {
          "plays": 100,
          "reach": 80,
          "likes": 10,
          "comments": 2,
          "shares": 3,
          "saves": 4,
          "averageWatchTimeMs": 4500,
          "totalWatchTimeMs": 450000,
          "skipRatePercent": 12.5
        }
      }
    }
  }
}
```

Before collection, `metrics` and `observedAt` are `null`. Join `trials.json` on the rendered version number and the recorded Instagram post ID. No `trials.json` writer exists on this base branch; this contract does not change a trial schema maintained by another branch.

Insights request `views,reach,likes,comments,shares,saved,ig_reels_avg_watch_time,ig_reels_video_view_total_time,reels_skip_rate` at `/<post-id>/insights`, with `period=lifetime`. `plays` retains the current `views` value because that is the v26.0 name. Watch times retain Meta's millisecond values. `reels_skip_rate` is Meta's estimated percentage of initial views skipped in the first three seconds, not an inferred retention score. Empty or omitted metrics remain `null`; zero stays zero. A malformed response or unreadable existing outcomes file fails without replacing the previous data.

## Meta dashboard setup

- Create or choose the Meta app and add the Instagram product with API setup using Instagram Login.
- Put the Instagram App ID and App Secret in the sign-in service's settings (`docs/signin.md`), never in the app.
- Register the sign-in service's exact HTTPS `/v1/instagram/callback` URI under Instagram business login settings.
- Configure deauthorization and data deletion callback URLs and the app's privacy policy URL.
- Add the owned Professional test accounts and required app roles for Standard Access testing.
- Request Advanced Access and complete App Review for the three permissions before serving accounts outside the app's roles.
- Complete any business verification requirements shown by Meta and select the supported API version for the app.
