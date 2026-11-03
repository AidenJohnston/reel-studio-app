# project.json schema changes

All additive (optional fields only), per docs/architecture.md section 3. Schema: `engine/reelengine/schema/project.schema.json`.

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

## 2026-10-22 (snap zooms)

- `zooms[].style` (`"snap"`, absent = the hard punch-in as before): the zoom eases in over about 0.22 s
  (ease-out) and back over about 0.3 s (a critically damped spring), with motion blur only while the scale
  moves. Motion never runs across a jump cut. Either end falls back to the hard cut of a default zoom where
  easing would look wrong: the punch-in when the zoom directly follows another zoom or a cut falls inside
  it; the release when the zoom runs into the next one, ends under face-hiding b-roll, is too short to
  hold (under about 0.8 s) or has a cut inside its release. A cut right after the last word takes the
  release itself. A snap whose fixed point (the point the picture grows out of) is far enough from the
  face to carry the eyes more than 9% of the frame's width punches in and releases hard, like a default
  zoom. A face-centred zoom gets there when the face sits high and off centre.
  Written by the AI's `set_zoom` tool.
