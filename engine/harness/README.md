# Speed harness

Measures how long a user waits while editing, and checks that faster renders still show the right
video. Every speed change to the renderer is judged by it, so it is test code only: it calls the
engine through its command line, never its internals, and changes nothing the app ships.

Run it from `engine/` with the engine's Python and the product's FFmpeg:

```
python -m harness pin                          # hashes to put in config.json (a person does this)
python -m harness run                          # setup + 5 timed replays of every loop take
python -m harness run --split held-out         # the held-out fifth, before a kept change merges
python -m harness agree runs/A/report.json runs/B/report.json
```

`--ffmpeg`/`--ffprobe` (or `REELENGINE_FFMPEG`/`REELENGINE_FFPROBE`) name the binaries. Everything
it writes goes under `testdata/harness/`, which git ignores.

## What one run does

For each take, starting from a fresh copy of its project (no render cache, no versions, an empty
song cache), each note of its session:

1. writes that note's `project.json` state;
2. `render --draft`, as the AI's `render_draft` does;
3. `frames --times` on that draft, as `look_at_frames` does (two stills at the changed moment);
4. `render --window a:b`, the 2 s around the changed moment (the app does not call this yet).

After the last note it runs `render`, the final export. Each command is timed from spawn to exit
of the child process, and its output is opened after the clock stops to confirm the file is whole.
One untimed warm-up draft per take comes first, so every timed run starts with the sources in the
OS file cache and the GPU encoder probed (the OS cache is never cleared). The report gives the
median of the runs and their spread, (max - min) / median.

The session wait, the number the speed loop lowers: for each note, the time until the changed
moment is on screen (today draft + stills, since a still needs a finished draft) plus the time
until the full draft is ready; then the final export.

## Checks

The reference is the engine at `reference.engineCommit`, written out of git's object store into
`testdata/harness/reference/` and checked blob by blob against that commit each time `setup` or
`run` starts. Its final render of each state is the truth for that state. Each reference render is
stored with a manifest of its files' sha256, the engine commit and the FFmpeg hash, and is checked
against it when `setup` or `run` starts and again just before the checks. The harness refuses to
run if FFmpeg or ffprobe do not match the hashes pinned for this platform, if the reference engine
copy was edited, or if a reference render no longer matches its manifest.

Every distinct output of every run is checked (outputs are compared by hash, so a deterministic
engine is checked once per output).

- **Final:** frame count and timestamps exact, audio packets identical in bytes and timing, per-frame PSNR above
  `final.psnrMinDb` and above `final.captionPsnrMinDb` inside the caption band.
- **Draft, window, still:** the output must first have the size `sizes` in `config.json` requires
  (drafts and windows half the output format, stills 540 wide), and every still requested, and no
  other, must exist. Then the reference scaled to that size (area averaging), and per
  frame: PSNR inside the caption band (strict), PSNR elsewhere (loose), and the largest per-channel
  difference of the frame means. The frame count comes from the requested range, not the output.
  Drafts and windows also check the audio length, its offset against the same stretch of the
  reference, and the level difference per 100 ms.

The caption band is the union of every caption box in the reference render, grown by 15% of the box
height, applied to every frame. A caption drawn where the reference has none at that moment then
falls inside the strict region too. There is no face region yet: the synthetic takes have no face
track.

Thresholds live in `config.json` with `"approved": false` until a person signs them off. A null
threshold reports its value as `unset`, never as a pass.

## Corpus

`config.json` lists the takes; `heldOut` names the fifth the speed loop never runs. Each take is a
folder:

```
<take>/project/          made by `reelengine init`, plus work/transcript.json
<take>/states/NN.json    each a full project.json, in session order
<take>/session.json      {"steps": [{"note": "...", "state": "states/00.json", "moment": {"word": "w12"}}]}
<take>/spec.json         generated takes only: the spec and generator version they were made from
```

A generated take is rebuilt when its `spec.json` is missing or differs. Every take, new or old, is
validated each time `setup` or `run` starts: the engine must read an HLG stand-in as HDR and a
rotated one as rotated, or the harness refuses.

The `synthetic` entries are generated with the pinned FFmpeg at setup: stand-ins for a 4K HEVC
SDR talking head, the same clip as 10-bit HLG, a variable-frame-rate clip, a rotated clip, a
90 s take cut to about 20 s, and a 5-minute 4K HEVC take cut to about 45 s from five stretches
spread across it (where decoding cut-away footage costs most). Their speech is shaped tones whose
word times are written straight into the transcript. They exercise decode, scale, tonemap, captions
and audio at phone-like sizes; they say nothing about how real faces and voices compress.

A real take is an entry `{"id": "...", "takeDir": "harness/<id>"}`, resolved under
`$REELENGINE_TEST_TAKES` (where the engine tests already read raw takes). Its folder has the same
shape: the project from `init` and `transcribe`, and the states of a real note round, written once
by the AI and then frozen so replays cost no AI calls. Footage never goes in git.
