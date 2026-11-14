# project.json schema changes

Existing project shapes remain valid. New shapes can require a newer engine, as noted below. Schema: `engine/reelengine/schema/project.schema.json`.

## 2026-11-06 (cameras of one recording, words behind the speaker)

- `sources[].angleOf: {source, offset, confidence?}` marks a source as another camera on the recording of
  `source`: it shows that source's second t at t + offset. `reelengine sync-angles --angle sN --of sM --write`
  finds the offset by cross-correlating their sound (`engine/reelengine/angles.py`). Older builds ignore it.
- `cut.angles: "auto"` lets the engine switch the picture between those cameras at cuts; `cut.keep[].angle`
  forces one camera for a range. Words and sound always stay on the main take. Older builds ignore both and
  show the main camera.
- A b-roll item's `treatment` may be `"text-behind"`: big words drawn behind the speaker, who is cut out of the
  footage above them (`engine/reelengine/segment.py`). Older builds skip the item as an unknown treatment.

## 2026-11-06 (match cuts, joins and beat landing by hand)

- `cut.keep[].join.transition` accepts `"match"`. The engine searches the silence around that cut for the frames
  that line up (`engine/reelengine/match.py`) and cuts there; when none do, the join plays as a plain cut and the
  render warns. Older builds refuse a project with a match join (`BAD_JOIN`) rather than render something else.
- `cut.keep[].join.transition` accepts `"flash"`: the picture dips to white for 2 frames before the cut and 3 after
  it (`render.flash_layers`), drawn as a layer so every kind of render shows it.
- `cut.keep[].join.transition` accepts `"action"` (cut on action): the engine puts the cut, inside the same air
  `match` searches, where the picture moves on both sides; with no such pair it plays as a plain cut and says why.
- `beatAccents: false` now turns beat landing off even when `cutStyle.preset` is `"hyper"`. Before, false meant the
  same as absent. Neither the app nor the AI ever wrote false, so only a project edited by hand can render differently.
- "Edit it myself" sets joins (Cut > Transitions) and `beatAccents` (Cut > Pace) through the `handEdits` queue. A
  queued hand edit saved before this has no `joins` list and applies as it did.

## 2026-11-05 (pace by hand, receipts name it)

- No new field. "Edit it myself" now sets `cutStyle` (Cut > Pace) and each zoom's `kind`, through the same
  `handEdits` queue as its other changes; `cutStyle` is set or removed whole. A project saved before this opens
  as it did.
- `notes[].receipt.facts` gains a `cutStyle` fact (before and after are the whole object, or null) when the
  pace or its seed changed. Receipts written before this never list one.
- A `cut.keep[].join` with `transition: "match"` is still refused, now with its own reason: the engine has no
  measure of what two shots show, so it can't find or check a match.

## 2026-10-23 (beat accents)

- `beatAccents` (boolean, optional): `true` snaps SFX hits and b-roll starts to the nearest detected
  music beat within 0.12 s, including frame rounding. Missing or `false` preserves existing timing.
  `cutStyle.preset: "hyper"` also enables accents when present. Disabled music or a track with no
  detected beats leaves timing unchanged. Beat times follow the song's `startAt` in the mix.
  A b-roll start cannot precede its anchor word by more than its `leadIn`, or the default card lead.
  SFX tied to b-roll follow that start. Word-anchored speech cuts and word times never move.

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

## 2026-10-21 (cover picker)

- `cover.manual` (bool): the person picked `cover.atSourceTime` from the cover suggestions in the app, so the
  engine renders that exact frame and does no search around it. The app clears it when the slider moves,
  and the AI's `set_cover` clears it. `cover.exact` (the AI looked at this frame; search 0.2 s around it)
  is unchanged.

## 2026-10-22 (note queue)

- `notes[].id` is the queued note's id (app.json `queue[].id`), not a job id. Every note that finishes is
  saved, including one that changed nothing (`applied: []`, `version` unchanged): the app's queue knows a
  note ran by its id here.

## 2026-10-21 (all-or-nothing notes)

- `notes[].id` (string): the app's job id for the note. `notes[].reply` (string): what the editor told the
  user. `notes[].styleRulesAdded`, `notes[].styleSuggestions` (string arrays, only when non-empty): My style
  rules the note asked to remember or the AI proposed. They are saved with the note so that, if the app
  closes right after a note is saved, the next start posts the reply and asks about the rules once
  (`app/src/main/store.ts` `recoverInterrupted`).
- `version` is also what makes a `versions/vN` folder count: a folder above it is a note that was never
  saved (docs/versions.md).

## 2026-10-20 (mirror)

- `sources[].mirror` (boolean, absent = false): the take is mirrored (a front-camera selfie: posters, shirts and
  signs read backwards), so the engine flips the picture left to right. The flip is the LAST step of the face
  picture's chain (after crop, scale and the upright turn) in both the software and the CUDA draft path, so the
  crop window is the same and the output is its mirror image. B-roll, zooms and captions are drawn on top and are
  never flipped; every reader of the face box in output pixels mirrors x (`x' = W - x - w`). Written by the AI's
  `set_mirror` tool and by the "Flip picture (it's mirrored)" toggle in "Edit it myself"; turning it off removes
  the field, so the project matches one that never had it.

## 2026-10-22 (caption presets)

- `captions.style.highlight` (`#RRGGBB`, no alpha, absent = none): the word being spoken is drawn in this colour, one
  word at a time. Each word is lit from its start until the next word starts. A line whose text lost a token
  (a word that was only punctuation) is drawn without the highlight.
- `captions.style.pop` (boolean, absent = false): each line grows from 80% to full size over its first 120 ms,
  carrying on across the word events of a highlighted line.
- `captions.style.preset` names the look the line started from in "Edit it myself" (`clean`, `bold-pop`,
  `karaoke`, `boxed`, `minimal`). The engine draws only the style fields; the name is for the picker. The AI's
  `set_caption_style` removes it when it changes the look itself (pop, the highlight on or off, case, words per
  line), so the picker then matches the look by its fields.
- `captions.style.sizePicked` (boolean, absent = false): the person picked `size` in the Size row of "Edit it
  myself". Picking a look then keeps that size; without it the look's own size applies. `set_caption_style` removes
  it when it changes the size. The engine ignores it.

## 2026-10-22 (subtitle editing)

- `captions.corrections[].at` (word id, optional): the fix applies to that one word only, before any other
  correction, and only while the transcript still hears it as `from` (after a re-transcription the same id can
  be another word, and the fix then does nothing). With `through` (word id), the words from `at` through
  `through` become one word, as when the subtitle editor fixes a word a phrase correction made of several. An
  empty `to` takes the word off the captions; it is still heard, and it keeps its place, so the lines around it
  are grouped as before. Written when a word is fixed in the Subtitles list of "Edit it myself".
- `captions.split` (word ids): each starts a new caption line. `captions.join` (`{from, to}` word ranges): the
  line that starts at `to` goes onto the line before while that line still ends at `from`. Lines with a long
  silence or a hidden line between them never join. Both change only the lines they touch; every other line is
  grouped as before. Anchored on word ids, so a recut keeps them.
- `work/captions.json` cues gain `tokens` (each word as drawn, before upper-casing, with the transcript word ids
  it came from; a word taken off the captions is `""`) and `run` (lines with different runs can't be joined).

## 2026-10-23 (frozen songs)

- `music.frozen` (object, optional): `{ "track": "Library/Music/<name>", "path": "work/assets/frozen/music/<sha256>.<ext>" }`.
  When the AI places a Library song, by its path or committed through `resolve_asset`, it freezes a copy of the
  song into the project, and `music.track` keeps the Library path, so the app's checklist and Music tab still name and check the song. The engine
  plays `frozen.path` only while `frozen.track` equals `music.track`. The app switches songs by rewriting
  `track` and keeps every other field, so a frozen copy left over from another song is ignored and the engine
  plays `track`. Projects without the field play `track`, as before.

## 2026-10-22 (snap zooms)

- `zooms[].kind` is optionally `punch`, `snap`, or `drift`. Named defaults read the selected cut preset; an explicit scale remains supported. `accentGroup` optionally marks tied candidate moments for seeded selection. Drift uses an eased ramp across the span, while punch changes scale immediately.
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

## 2026-10-22 (sound effects)

- `sfx` (array, absent = none): built-in sound effects, `{at, sound, gainDb?}`. `sound` is an id from
  `engine/reelengine/sfx/pack.json`. `at` names one moment: `{word}` (that word starts, if the cut keeps it),
  `{broll}` (that b-roll appears, its lead-in included) or `{cut}` (the cut into a kept range after the first whose
  `from` is that word). The engine lines the sound's measured hit (`onsetMs`) up with that moment on the frame grid
  and plays one at a time, at most one every 2 seconds; an effect that breaks that, or whose build-up would start
  before the video, is left out with a render warning. Its level comes from the measured voice: 10 dB under the
  voice's speech loudness, 6 dB more while the voice is talking, `gainDb` (-24 to +12) on top but never above 4 dB
  under the voice, and its sample peak stays 3 dB under the voice's loudest peak. Word and cut anchors are
  remapped after a re-transcription like the others. Written by the AI's `set_sfx`; an empty list removes the field.

## 2026-10-22 (Edit it myself in the note queue)

- `handEdits` (string array, absent = none): ids of the "Edit it myself" changes saved in this project, newest last, at
  most 20. A change made while the editor is busy waits in the reel's note queue; the app writes its id here in the
  same project.json write that saves it, after its final render, and that id is the queue's proof it ran (as a note's
  id in `notes` is). Written only by the app (app/src/main/hand-edit.ts); the engine ignores it.

## 2026-10-23 (cut vocabulary)

- `cutStyle` (optional): `{preset, seed}` selects the reel's fixed cut vocabulary. Presets are `clean`, `standard`, `hyper`, and `punchline`; the seed is an integer used for repeatable within-style choices. The preset values are defined in `engine/reelengine/cut_style.py` and mirrored in the AI package.

## 2026-10-23 (per-join transitions)

- Each `cut.keep[]` range after the first may carry `join: {transition, frames}`.
  `transition` is `hard`, `j`, `l` or `smash`; `frames` is a non-negative integer in
  output-frame units. Missing joins and explicit `hard` retain hard-cut timing.
  Request 6-12 frames as a starting range, not a measured optimum.
- J adds source audio before the incoming picture starts. L keeps the outgoing
  source audio after its picture ends. The engine clamps these handles at adjacent
  transcript words, source bounds and the neighboring output segment, then rounds
  down to whole output frames. A continuous source span or no room means no bridge.
- Picture timing, kept-word audio timing and total duration do not move. The voice
  renderer overlaps the handles with the existing 6 ms edge fades instead of
  concatenating extra time. Word-anchored captions therefore keep their timestamps.
- `smash` keeps a hard picture cut, derives an `impact-hit` at `at.cut`, and adds a
  200 ms, -6 dB dip through the music automation curve. These sound choices are
  starting values without listening-test evidence. The existing SFX spacing and
  loudness limits still apply; skipped hits produce the existing render warnings.
  An explicit SFX at that cut replaces the automatic hit. The dip uses the existing
  gain smoothing and only applies when a music track plays.
- `frames` has no effect for hard or smash. Derived effects do not modify the saved
  project. Removing a join removes its automatic effects on the next render.
  The AI's `set_cut` accepts joins and forbids J/L with beat accents on the same join
  in its editing guidance; beat-accent scheduling is not part of this schema.
## 2026-10-23 (multi-source engine)

- `cut.keep[]` accepts a word range `{from, to}` or a clip
  `{clip: "c1", source: "s2", in: 12.4, out: 16.8}` in output order. Clip ids are unique
  within the cut and match `^c[0-9]+$`. Bounds are source seconds, start included and end excluded,
  inside the named source. The engine snaps them to the source frame grid and rejects clips
  shorter than one frame. Clips retain silence and never merge with adjacent word ranges.
  The first item may be a clip. A word range's `join` (per-join transitions) bridges two spoken
  ranges; on the first word range after a clip it plays as a hard cut.
- `broll[].anchor` also accepts `{source: "s2", s: 13.0, e: 14.5}` in source seconds.
  Both endpoints map through the cut, so a recut moves the overlay with the footage. An endpoint
  removed by trimming leaves no overlay. Repeated source moments use their first output occurrence.
  Existing lead-in and hold rules still apply. Zooms, captions and music keep their word anchors.
- All-clip cuts render without `work/transcript.json`. When a transcript exists, words intersecting
  clips are captioned on the clip's output clock. Mixed cuts still require a transcript for their
  word ranges. Sources with no audio stream contribute silence, including during `init`.
- Source paths may use the existing `Library/...` form. Indexed footage references, per-clip audio
  controls and framing overrides are outside this slice.
- `schemaVersion` remains 1 and existing projects are not rewritten. Older builds, including main
  at `31382f9`, reject clip items and source-time b-roll anchors with `BAD_PROJECT` because they
  require word-range fields. They must refuse rather than ignore the clips and render a different
  video. Open these projects in a build that supports multi-source cuts.

## 2026-10-23 (music fade-in)

- `music.fadeIn` (number, 0 to 30 seconds, absent = 0.6, or 0.05 with `level: "loud-intro"`): how long the song takes
  to come in. Below 0.01 s it is 0.01 s, so the first sample never clicks. Until now the fade-in was fixed; `fadeOut`
  was already a field. Set by "Edit it myself" (0 to 2 seconds there).

## 2026-11-12 (the Plan document)

- `plan` (object, optional): the Plan document ([plan.md](plan.md)). `script` {`draft`, `rewrite` (text or null),
  `locked`, `lockedAt`, `hook`, `onScreenText`}, `beats[]` {`line`, `visual`, `sound`}, `broll[]` {`id` (`p1`...),
  `words`, `anchor` (word range), `visual`, `source` (own-file | library | fetched | card | animation |
  screen-recording), `asset`, `treatment`, `status` (proposed | approved | rejected), `hold` (seconds, a hint),
  `note`, `broll` (the b-roll item it built), `look` ({`leadIn`, `params`}: its picture's look while it is out of
  the video)}, `music`, `cover` (one line each), `buildProposed` (build proposed
  rows as if approved). The engine renders only `broll`, which the AI layer derives from the rows; its edit
  signature counts only `plan.script`.
