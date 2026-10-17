# Animation templates

Animated cards the editor uses when a moment has no real picture: a number counting up, a quote
landing word by word, a list building, a logo popping in, a price tag, text typing into a terminal or
chat. Each template is an HTML page. The renderer steps it frame by frame and writes a **transparent
video layer** that the engine overlays on the speaker.

| id | what it shows | key params | default length |
|---|---|---|---|
| `stat-count-up` | big number counts up + label | `value` ("3,000", "92%", "$1.5M"), `text` | 3 s |
| `big-quote` | sentence lands one word at a time | `text`, `highlight`, `author`, `wordTimes` | ~1.6 s after the last word |
| `list-reveal` | 2 to 5 items build one per beat | `items`, `text` (title), `at` | ~1.8 s after the last item |
| `logo-pop` | logo/image pops in with a label | `image` (file path), `text`, `background` | 2.5 s |
| `price-tag` | price tag slides in, optional struck old price | `value`, `oldValue`, `text`, `name` | 2.6 s (3.2 s with old price) |
| `typing-terminal` | text types into a terminal or chat bubble | `text`, `style`, `response`, `title` | ~1.2 s after typing ends |

Every template also takes: `layout` (`top` = card above the head, speaker visible; `full` = opaque,
covers the frame), `theme` (`light` | `dark` | `accent`), `accentColor`, `tilt`, `duration`, `drift`,
and `region` (a box the content must stay inside). The full JSON schema, a one-line description for
the AI, an example and variants are in each `<id>/meta.json`.

## Output

```
{ path, duration, width: 1080, height: 1920, fps, frames, template, layout, warnings }
```

- **File: QuickTime `.mov`, codec `qtrle` (Animation), pixel format `argb`, 1080x1920, 30 fps.** If you
  ask for `x.webm` you get `x.mov`; always use the returned `path`.
- Full frame, straight (not premultiplied) alpha. Overlay it at `0,0` for its whole length:
  ```
  ffmpeg -i speaker.mp4 -i card.mov -filter_complex "[0:v][1:v]overlay=0:0:format=auto" ...
  ```
  To start it at output time `T`: `[1:v]setpts=PTS-STARTPTS+T/TB[a];[0:v][a]overlay=0:0:format=auto:eof_action=pass`.
  No decoder flags are needed: qtrle is built into every ffmpeg, and its alpha is decoded by default.
- A sidecar `<name>.anim.json` sits next to the `.mov` (`kind: "reelstudio-animation"`, template,
  params, duration, layout, `transparent: true`). **The engine should treat a file with this sidecar
  as a ready-made full-frame layer: overlay at 0,0, no card, no scaling, no backdrop.** Running it
  through `card-above-head` would shrink the whole 1080x1920 frame into a card.
- The clip ends with a hard cut (no exit animation). If the b-roll window is longer than the clip,
  either pass `duration` to match it, or hold the last frame (`tpad=stop_mode=clone`).

Verified on both platforms: the same `.mov` overlaid on a grey frame gives a byte-identical result
with ffmpeg 7.1 on Windows and ffmpeg 9.0.2 (Homebrew) on macOS, alpha decoded with no flags.

### Determinism

Same params give the same video: `__seek` is a pure function of `t`, and rendering always goes
frame 0 to N on a freshly loaded page. Measured: three renders of each template in one browser
session, with other templates in between, hash identical, except `price-tag`, which differs on at most
12 pixels in the whole clip by at most 5/255 (Chromium anti-aliasing during its scaling price pop).

Chromium caches raster and image decodes by the scales of EARLIER frames, so anything that scales
with a CSS transform can render slightly differently for the same `t`. Rules that follow from that,
measured, not guessed:
- small text (words, labels, rows) enters with a move only (`RS.pop(t, at, { from: 1 })`); cards may scale;
- images never scale with a transform: `RS.imageSprite` draws them into a fixed-size CPU canvas and
  repaints at the current scale (`logo-pop`). A transform-scaled logo differed in 1 of 3 renders;
- no `will-change` anywhere.

### Why qtrle `.mov`

Measured on a 3 s card: qtrle 15.5 MB, PNG-in-MOV 9.6 MB, ProRes 4444 31 MB, VP9 WebM 0.2 MB.
VP9 is tiny, but ffmpeg's built-in VP9 decoder **drops the alpha channel** unless the input is opened
with `-c:v libvpx-vp9`. Forgetting that flag gives a black box instead of an error, and the engine
would have to remember it on every input on both platforms. qtrle is lossless (crisp type), decodes
fastest, needs no external library, and its alpha just works with `overlay`. The files live in the
project's `work/` folder (safe to delete) and are only ever a few seconds long, so size is fine.

## Using it

### From the Electron main process

```js
import { BrowserWindow } from 'electron';
import { createElectronAdapter, renderAnimation } from '<resources>/templates/animations/render.mjs';

const adapter = createElectronAdapter(BrowserWindow);   // offscreen, transparent, never shown
try {
  const r = await renderAnimation({
    template: 'stat-count-up',
    params: { value: '3,000', text: 'people signed up' },
    outPath: '/path/to/project/work/assets/anim-stat-count-up-1.mov',
    adapter,
    ffmpeg: process.env.REELENGINE_FFMPEG,               // bundled ffmpeg path
    onProgress: (pct) => {},
    signal,                                               // AbortSignal, optional
  });
} finally { await adapter.close(); }
```

One adapter can render many animations in a row (reuse it; creating a window costs ~1 s). After a
`TIMEOUT` error, close the adapter and make a new one. The module never imports `electron` itself,
and it serves the templates folder on `127.0.0.1` (random port) for the length of a render, so it
works from inside an asar-unpacked resources folder and from paths with spaces or non-ASCII
characters. `templates/` must be shipped unpacked (asar-unpacked or extraResources) together with
`templates/fonts/`.

Electron gotcha handled by the adapter: a window taller than the display is clamped at creation,
even offscreen (a 1392 px tall screen gave a 1080x1392 page). The adapter resizes after creation,
checks `innerWidth/innerHeight` after every load, and refuses a non-uniform resize rather than
stretching frames. Frames from Electron 44 and from Playwright's Chromium were compared pixel by
pixel: identical.

### From Node (dev, tests, CI)

```
cd templates/animations
npm install                          # playwright (dev only)
npx playwright install chromium      # once
node render.mjs --list
node render.mjs stat-count-up --params '{"value":"3,000","text":"people signed up"}' --out "out dir/stat.mov"
npm test                             # determinism + param checks
node tools/proof.mjs --take "<a talking-head video>"   # renders everything, overlays, contact sheet
```

`renderWithPlaywright(opts)` and `renderManyWithPlaywright(jobs)` do the same as above with a
headless Chromium.

### Errors

Errors carry `code` and a plain `userMessage`: `BAD_TEMPLATE`, `BAD_PARAMS` (message says which
param and why), `ASSET_MISSING`, `NO_FFMPEG`, `ENCODE_FAILED`, `TEMPLATE_FAILED`, `TIMEOUT`,
`RENDER_SIZE`, `CANCELLED`, `NO_RENDERER`. Unknown params are dropped with a warning (in
`result.warnings`), not an error, so an extra field from the AI never costs the animation.

## How the AI should use a template

1. Pick the template whose `description` matches what is being said. One idea per card.
2. Fill params with the words **as said**, numbers as digits ("3,000", never "three thousand").
3. Leave `duration` out unless the b-roll window needs a specific length. For word-by-word
   templates, pass `wordTimes` / `at` (seconds from the clip start, taken from the transcript) so
   each word or item lands on the spoken word.
4. `layout: "top"` keeps the speaker visible (the default). `full` is for a moment that deserves the
   whole screen.

## Adding a template

1. Make `templates/animations/<id>/` (lowercase, dashes). Ids starting with `_` are ignored.
2. `index.html`:
   ```html
   <link rel="stylesheet" href="../_lib/base.css">
   <div id="stage"><div id="content"></div></div>
   <script src="../_lib/runtime.js"></script>
   <script>
     RS.define({
       fonts: ['700 60px Inter'],          // must load before the first frame
       tilt: -2,                           // default tilt for layout top
       duration: (p) => 3,                 // used when params.duration is not given
       build(p, ctx) { ctx.content.innerHTML = '...'; },   // final state, everything visible
       seek(t, p, ctx) { RS.applyPop(el, RS.pop(t, 0.2)); }, // pure function of t
     });
   </script>
   ```
   `RS.define` provides `window.__setup(params)` (applies meta.json defaults, theme, region, waits
   for fonts, builds, then shrinks or grows the type scale `--k` until the content fits its region)
   and `window.__seek(t)`. Size everything with `calc(var(--k) * Npx)` so fitting works.
3. Rules for `seek`: a pure function of `t`. No timers, no `requestAnimationFrame`, no
   `Math.random`, no CSS transitions or animations (base.css disables them). Never change layout in
   `seek` (only transforms, opacity, colour, text that is already measured): `build` must lay out the
   final state so nothing jumps. Use `RS.pop` for entrances: opaque on its first frame, settled in
   ~0.2 s. No slow fades.
   **A card enters WITH its content, never as an empty box.** If the first words/items can be timed
   to speech (`wordTimes`, `at`, `typeAt`, `labelAt`), add `enterAt(p, ctx)` returning when the first
   content lands and pop the card at `ctx.enter`; before it the whole layer (even the `full` page) is
   transparent. `npm test` checks that every template's first drawn frame shows words.
4. `meta.json`: `id`, `name`, one-line `description` (what it shows + when to use it, the AI reads
   it), `defaultDuration`, `params` (JSON schema; copy the shared params from an existing template;
   mark file paths with `"format": "file"` so the renderer inlines them), `example`, `variants`.
5. Run `node tools/proof.mjs --only <id> --take <video>` and look at the frames.

## Style rules baked in

Big type that reads in under a second; one idea per card; hard, quick entrances (~0.2 s) that are
fully visible on their first frame; items build one per beat in reading order with the newest in
focus; numbers as digits; logos never tilted; a barely visible push-in (`drift`, 1.5%) so a held card
never reads as a frozen frame; content kept out of the caption band (y 1250-1500) in every layout and
off the face in `top` (a card's soft shadow may touch the hairline).

Fonts are in `templates/fonts/` (Inter, Fraunces, Montserrat, JetBrains Mono; SIL OFL 1.1, see
`OFL.txt`). No library is vendored: the easing is ~10 lines in `_lib/runtime.js`. GSAP was not used
because its current license is not an OSI license and restricts some competing tools, which does not
sit well inside an MIT app.
