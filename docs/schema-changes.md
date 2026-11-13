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
  At most one effect, plus one per 8 seconds of video, plays; the rest are left out the same way.

## 2026-11-12 (beat sync, music drops, reverb throw)

- `music.beats` (`{fps, frames}`, absent = none): the song's beat grid, each beat a whole frame of SONG time,
  written by `choose_music` when it picks a song (engine `analyze-music --fps`) and removed when the song changes.
  Stored rather than re-detected so the same project always lands the same edits on the same frames.
- `music.onBeat` (array of `"cuts"`, `"zooms"`, `"broll"`, absent = none): those land on the nearest beat in
  reach. A jump cut (between kept ranges, or where a long pause was taken out) moves at most 0.15 s by changing
  only the silence before it; a zoom punches in up to
  0.15 s before its word or 0.06 s after; a b-roll entrance moves up to 0.15 s earlier or 0.1 s later.
- `music.drops` (`[{from, to}]` word ids, absent = none): the music is gone 40 ms before `from` and comes back on
  the first beat within 1 s after `to` ends (0.15 s after it with no beat in reach). The song keeps running
  underneath. Remapped after a re-transcription like the other anchors.
- `voice.reverbThrow` (boolean, absent = false): an echo tail on the last kept word (its final 0.7 s at most),
  peaking 8 dB under the voice and fading out if it is still ringing when the video ends.
- All three are written by the AI's `set_sound_moments`; turning one off removes its field.
- Defaults that change the sound of existing projects: the music no longer fades in (a 5 ms de-click instead);
  `analyze-music` now suggests a start on the song's first attack after the calm bar, and its beats sit on the
  attacks (they were 20 to 45 ms early, and could drift between the beats on a long song).
