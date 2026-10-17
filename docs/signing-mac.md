# Signing and notarizing Reel Studio for macOS

Until this is done, every Mac user sees "Apple could not verify..." the first time and has to use
**System Settings > Privacy & Security > Open Anyway** (see `install-mac.md`). After this is done, the
app opens with a double-click like any normal app.

You do this **once** to set up (steps 1 and 2, about 15 minutes), then **one command per release** (step 3,
about 10 minutes, most of it waiting for Apple).

> **Run all of this in a graphical session on the Mac** (sit at it, or use Screen Sharing / VNC to the
> Mac). Your signing key lives in the login keychain, and over plain SSH that keychain is locked, so
> `codesign` fails with `errSecInternalComponent`. If you must use SSH, unlock first with
> `security unlock-keychain ~/Library/Keychains/login.keychain-db` (it asks for the Mac's login password).

## What you need

* The **Apple Developer Program** membership (the paid $99/year account) and to be signed in as the
  **Account Holder**. Only the Account Holder (or an Admin) can create a *Developer ID* certificate.
* Xcode installed on that Mac . You only use it to create the certificate.
* About 3 GB free disk.

## Step 1: create the "Developer ID Application" certificate (once)

1. Open **Xcode**. Menu **Xcode > Settings...** (or press Command-comma), click the **Accounts** tab.
2. Click **+** (bottom left) > **Apple ID**, sign in with the Apple ID that owns the developer account.
   (This is the Apple ID the Developer Program is attached to. If it's your personal iCloud one, use that.)
3. Select your **Team** in the right-hand list, click **Manage Certificates...**
4. Click **+** (bottom left) > **Developer ID Application**. Wait for it to appear. Click **Done**.
5. Check it worked. In Terminal run:

   ```
   security find-identity -v -p codesigning
   ```

   You should see a line like:
   `1) ABCDEF... "Developer ID Application: Your Name (TEAMID1234)"`.
   Write down the **TEAMID** (10 characters, in the brackets). If you only see "Apple Development" lines,
   that is the wrong kind of certificate; redo step 4 and pick **Developer ID Application**.

If **+** doesn't offer *Developer ID Application*, you are not the Account Holder or Admin. Sign in as the
account holder, or create the certificate at https://developer.apple.com/account/resources/certificates
and double-click the downloaded `.cer` to install it.

## Step 2: save your notarization login (once)

Notarization is Apple scanning the app for malware and stamping it OK. It needs an *app-specific password*
(not your Apple ID password).

1. Go to https://account.apple.com > **Sign-In and Security** > **App-Specific Passwords** > **+**.
   Name it `Reel Studio notary`. Copy the password it shows (looks like `abcd-efgh-ijkl-mnop`).
2. In Terminal run (replace the two placeholders, and paste the password when it asks):

   ```
   xcrun notarytool store-credentials reelstudio-notary --apple-id YOUR_APPLE_ID_EMAIL --team-id TEAMID1234
   ```

   It prints "Credentials saved to Keychain". The name `reelstudio-notary` is what the script looks for.
3. Check: `xcrun notarytool history --keychain-profile reelstudio-notary` prints a list (maybe empty) and no error.

## Step 3: build, sign, notarize (every release)

From the repo folder, in Terminal on the Mac:

```
packaging/build-mac.sh          # builds the unsigned app (about 5 minutes the first time)
packaging/sign-mac.sh           # signs everything, notarizes, staples, builds the signed .dmg
```

When it ends it prints `DONE.` and the path to the finished installer:
`app/release/signed/Reel-Studio-<version>-arm64.dmg`. That file is what you give to people.

Practice first (no risk, uses the throw-away spike app): `packaging/build-mac.sh --spike` then
`packaging/sign-mac.sh --spike`.

### What the script does (so you can trust it)

1. Copies the unsigned `.app` to `release/signed/` (the original is never touched).
2. Signs **every** executable file inside it, deepest first: Python, ffmpeg, ffprobe, every `.so` and
   `.dylib` (numpy, OpenCV, the speech engine...), Electron's helper apps and frameworks, and finally the
   app itself. It uses the "hardened runtime" and, per file, `packaging/entitlements.main.plist` / `entitlements.inherit.plist` (or none). (Apple rejects the
   whole app if even one file is missed, which is why a plain `codesign --deep` isn't enough.)
3. `codesign --verify --deep --strict`.
4. Zips the app, sends it to Apple with `xcrun notarytool submit --wait`, then `xcrun stapler staple`
   attaches the approval ticket to the app so it also works offline.
5. Builds the `.dmg`, signs it, notarizes it, staples it.
6. Final checks: `codesign --verify --deep --strict`, `spctl -a -vv` (must say `accepted` and
   `source=Notarized Developer ID`), `xcrun stapler validate`.

Any problem stops the script with a plain message.

### Why those entitlements (least privilege, by role)

| File | Entitlements | Why |
|---|---|---|
| the app and its executable (`Contents/MacOS/Reel Studio`) | `entitlements.main.plist`: `allow-jit` | Electron's JavaScript engine (V8) generates machine code at run time. |
| Electron's helper apps (`... Helper (GPU/Renderer/Plugin).app`) | `entitlements.inherit.plist`: `allow-jit` | they run V8 too. |
| bundled Python, ffmpeg, ffprobe, every `.so`/`.dylib`, frameworks | **none** | they do not generate code at run time, and every one of them is re-signed with our own certificate, so library validation passes. Entitlements on a library are ignored by macOS anyway. |

Deliberately NOT granted (an earlier version granted all of these to every file): `allow-dyld-environment-variables` (would let
`DYLD_INSERT_LIBRARIES` inject code into the app), `disable-library-validation`, `allow-unsigned-executable-memory`. If a future
wheel needs one of them for Python, add a separate plist for `python3` only; never the main app. The one exception is the ad-hoc TEST seal (`--adhoc`): an ad-hoc signature has no Team ID, and under the hardened runtime
macOS then refuses to load any ad-hoc signed library (the first run of this split died with "Library not loaded: Electron
Framework ... different Team IDs"), so `sign-mac.sh --adhoc` adds `disable-library-validation` from temporary copies of the
plists. A Developer ID build never gets it. **Not yet proven:** a Developer ID build with the split as committed (no certificate
exists yet); expect same-Team-ID loading to work, and if Apple's first run shows otherwise, add the key to `python3` only
(see the packaging notes in this repo's history).

## If something goes wrong

| Message | Fix |
|---|---|
| `errSecInternalComponent` or a password prompt that never appears | Keychain is locked. Use a graphical session, or `security unlock-keychain ~/Library/Keychains/login.keychain-db`. |
| `No 'Developer ID Application' certificate found` | Step 1 not finished, or it's an *Apple Development* certificate. |
| `notarytool profile 'reelstudio-notary' not found` | Step 2 not finished. |
| `HTTP status code: 401` | App-specific password wrong or revoked. Make a new one and repeat step 2. |
| Apple rejects it: `The executable does not have the hardened runtime enabled` / `is not signed with a valid Developer ID certificate` / `does not include a secure timestamp` | The script prints Apple's log with the exact file names. Almost always a binary the signing pass didn't reach: send the log to whoever maintains `sign-mac.sh`. A missing timestamp means the Mac was offline during signing. |
| `The signature of the binary is invalid` | The app was changed after signing (for example by running the Python inside it and writing files). Rebuild from step 3; the build script pre-compiles Python so this does not normally happen. |
| `spctl ... rejected` right after staple | Wait a minute and retry; Apple's servers sometimes lag. |

## Checking the result like a customer would

1. Copy the signed `.dmg` to a *different* Mac (AirDrop, or upload and download it through a browser; the
   browser adds the "downloaded from the internet" mark that triggers Gatekeeper).
2. Open it, drag the app to Applications, double-click it.
3. Expected: a one-time "Reel Studio is an app downloaded from the Internet. Are you sure?" with an **Open**
   button, and then it opens. There must be no "cannot be verified" message.

After the first successful notarized release, delete the **Open Anyway** section from `docs/install-mac.md`.

## What an unsigned copy does (a local build)

* A copy you build yourself on the same Mac has no "downloaded" mark, so it opens directly (that is how the
  self-test runs).
* A copy that arrives through a browser, AirDrop, Messages or a download link gets the mark
  (`com.apple.quarantine`). macOS then refuses the first open ("Apple could not verify...") until the user
  uses **Privacy & Security > Open Anyway**, as described in `install-mac.md`. Advanced shortcut for a
  tester: `xattr -dr com.apple.quarantine "/Applications/Reel Studio.app"`.
* electron-builder's own `.dmg` (`app/release/Reel-Studio-*.dmg`) has a *broken* seal, because electron-builder
  edits the app after Electron's signature was made. A quarantined copy of that one can say "is damaged and can't
  be opened". So `build-mac.sh` finishes by running `sign-mac.sh --adhoc`, which seals the whole app with a valid
  ad-hoc signature (hardened runtime, the same per-role entitlements, no certificate needed). **The file to hand out is
  `app/release/signed/Reel-Studio-<version>-arm64.dmg`.** It shows the normal "Open Anyway" path and nothing worse.
  (Proven on a Mac: `codesign --verify --deep --strict` passes, the bundled Python and ffmpeg run under the
  hardened runtime, and the self-test passes from a mounted copy.)

## Windows

Not signed yet. A code-signing certificate for Windows (an "OV" or "EV" certificate from a certificate
authority, roughly $100 to $400 a year) removes the blue SmartScreen box (EV removes it immediately; OV
after the app builds reputation). When you have one, electron-builder signs automatically if you set
`CSC_LINK` (path to the `.pfx`) and `CSC_KEY_PASSWORD` before running `packaging/build-win.ps1`.
