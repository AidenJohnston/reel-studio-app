# project.json schema changes

All additive (optional fields only), per docs/architecture.md section 3. Schema: `engine/reelengine/schema/project.schema.json`.

## 2026-10-22 (render identity and edit receipts)

- `notes[].receipt` (object, optional): what the version this note ended on changed since the version
  before it, copied from the engine's render result. `jobId` is the app job (null when the engine ran
  without one), `renderId` the render that made the version, `facts` a list of `{kind, before, after}`
  where `kind` is the project.json path (`cut.keep`, `cut.gapCap`, `captions.enabled`, `music.level`,
  `zooms`, ...). `captions.style` facts name the style key in `field`; `broll` and `source` facts name the
  item in `id`, with `before: null` for an added item and `after: null` for a removed one. Facts compare
  the two versions, never the steps between them, so a change made and undone is not a fact.
- `notes[].version` may now be absent. Such a note changed the video and then took the change back, so it
  made no version; the app answered "That left your video the same as before, so I didn't make a new
  version." (or passed on the AI's question). The schema never listed `version` as required, so only the
  TypeScript types change.
- Outside project.json: `versions/vN/receipts.json` lists the receipts of every final render that wrote
  into `vN` and changed something. Versions made before this have none.

## 2026-10-17 (engine-core, A1)

- `sources[].rotation`: defined as the CLOCKWISE degrees (0/90/180/270) the stored picture must be turned
  to display upright. An upright iPhone portrait MOV stored as 1920x1080 has `rotation: 90`.
- `sources[].originalName` (string), `sources[].hdr` (bool): optional, written by `init`.
- `transcript.model` (string): which speech model produced the transcript.
- `cut.source` (string): who wrote the cut (`autocut` | `ai` | `user`).
- `captions.style.outlineColor` (`#RRGGBB`), `captions.style.shadow` (number): optional style knobs.
- `captions.style.size` is in 1080-wide units (scaled for other widths).
- `captions.hidden`: optional list of word-id ranges whose captions are suppressed (e.g. under a
  full-frame card).
- `transcript.json` words may carry `ws`/`we` (whisper's raw times), `p` (probability) and `gaps`
  (silent runs inside the word). `s`/`e` are the MEASURED edges every module should use.
  It also has `segments[{source,s,e,text,from,to}]` and `nextId`.
- Unknown extra fields anywhere are allowed (the schema does not set `additionalProperties: false`).

## 2026-10-20 (0.1.2 F2, note attachments)

- `notes[].attachments` (array of project-relative paths, at most 4): the files the user attached to that
  note, each a `work/assets/attach-<8 hex>-<stem>.<ext>` written by engine `attach`, with a sidecar
  `<asset>.attach.json` next to it (`asset`, `name`, `kind` image|video, `bytes`, `width`, `height`,
  `duration`, `hasAudio`, `fromGif`, `thumb`, `createdAt`). The sidecar is not part of project.json. A note
  may have empty `text` when it has attachments.

## 2026-10-20 (mirror)

- `sources[].mirror` (boolean, absent = false): the take is mirrored (a front-camera selfie: posters, shirts and
  signs read backwards), so the engine flips the picture left to right. The flip is the LAST step of the face
  picture's chain (after crop, scale and the upright turn) in both the software and the CUDA draft path, so the
  crop window is the same and the output is its mirror image. B-roll, zooms and captions are drawn on top and are
  never flipped; every reader of the face box in output pixels mirrors x (`x' = W - x - w`). Written by the AI's
  `set_mirror` tool and by the "Flip picture (it's mirrored)" toggle in "Edit it myself"; turning it off removes
  the field, so the project matches one that never had it.
