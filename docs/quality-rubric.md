# Reel quality rubric

How we score a finished talking-head Reel, whether a person or the AI edited it. Used to compare the
AI's first edit against a hand-edited reel of the same raw take (`status/quality.md` has the scores).
Generic on purpose: nothing here is about one creator, topic or niche.

**Priority order: pacing > b-roll > captions > effects.** A tight reel with no b-roll beats a pretty
one that drags, so a 0 on criterion 2 matters more than a 0 on criterion 9.

## How to score

- Watch the export, then look at stills sampled every ~2 s **at the same spoken words** in both
  versions (side-by-side sheet), plus a dense look at the first 3 s.
- 10 criteria, each **0 / 1 / 2**: 0 = broken or missing, 1 = present but with a visible problem a
  viewer would feel, 2 = a viewer would not notice anything to fix. Total **/20**.
- Score what is ON SCREEN and IN THE SOUND, not what the project file intended (a b-roll the engine
  skipped scores as missing).
- One number per criterion, one line of evidence (timestamp + what you saw). No half points.

## The 10 criteria

### 1. Hook (first ~2 s)
- 2: in the first second the viewer knows what the video is about: a short hook line on screen (a few
  words, top of the frame, over the face, never covering eyes or mouth) OR a picture that is the topic
  itself, and the speaker's face reads within ~3 s. Nothing else competes (no fine print, disclaimer
  or second card in the first ~5 s).
- 1: the spoken hook is strong but the screen is just a face with captions, or the hook text arrives
  late (> 1.5 s), or is long/small.
- 0: the opening is unreadable, covered, starts on dead air, or opens on something unrelated.

### 2. Cut and dead air
- 2: one clean take per beat, no false starts, doubles or meta-talk; pauses tight (~0.1 s) except a
  deliberate beat before a punchline; the video ends ~0.1-0.2 s after the last word.
- 1: one or two loose pauses, a doubled line, or a slow tail.
- 0: drags; retakes left in; dead air at the start or end.

### 3. Visual cadence (no bare stretches)
- 2: no stretch longer than ~4 s with only the face (no b-roll, no zoom; a hook text card does not
  count as a visual); visuals spread across the WHOLE reel including the last 10 s; face hidden less
  than ~60% of the runtime.
- 1: one or two bare stretches of 5-8 s, or visuals clumped in one half.
- 0: long bare stretches (> 8 s) or nearly no visuals; or wall-to-wall cover with no face.

### 4. B-roll relevance
- 2: every visual SHOWS the point being made (the named thing, the place, the proof, the number, the
  example), not a literal pun on one word; real assets (the real logo, the real screenshot, the real
  photo) over stand-ins; nothing contradicts the words; no asset used twice.
- 1: one or two visuals are generic, decorative or a literal-word match that misses the point.
- 0: several visuals are wrong, invented, or fight the voice.

### 5. B-roll timing
- 2: each visual appears on the FIRST word of its phrase (or just before) and leaves when the phrase
  ends; picture cards stay up >= ~2 s; a spoken list builds one item per item-word; one idea on screen
  at a time; hard cuts.
- 1: some visuals land late/early by a word or two, flash too briefly to read, or overstay into the
  next idea.
- 0: visuals clearly out of sync with the words.

### 6. B-roll size and legibility
- 2: a card is either BIG enough to read on a phone (text >= roughly half the frame wide) or it is not
  there; nothing small parked on the face; eyes and mouth clear except during intentional full-screen
  moments; text in a card fills its box; an unclear still has a short label saying what it is.
- 1: one card too small to read, or a card nudging into the eyes/mouth.
- 0: several unreadable/small cards, or the face covered during an emotional line.

### 7. Captions
- 2: 2-3 words per chunk, one line, uniform size, high contrast, under the chin, always above b-roll;
  names, brands and numbers spelled right (numbers as digits); never paraphrased.
- 1: one or two mishearings left in, or a chunk that wraps / sits on the face.
- 0: several wrong words, unreadable, or hidden behind b-roll.

### 8. Music
- 2: the mood fits the content; the voice is clearly on top all the way through (about 18-20 dB of
  voice over music); the song enters softly (no loud first frame); one song; an optional gentle lift
  on the payoff; it ends with the video (no long fade or loud tail).
- 1: the mood is generic or slightly off, or the music is a touch loud in places.
- 0: wrong mood, fights the voice, or a jump-scare entrance.

### 9. Zooms and emphasis
- 2: a few subtle punch-ins (~1.08-1.15x) on punchlines / key lines, each spanning the whole line from
  its first word; used to break up face stretches that have no honest b-roll; never under a full-screen
  visual.
- 1: zooms present but mid-line, too strong, or none where a bare stretch needed one.
- 0: jarring, constant, or on the wrong moments.

### 10. Cover and post kit
- 2: cover = a sharp, expressive face frame (eyes open, not mid-word), full frame, optional 1-3 big
  words; post caption opens with a searchable line about the topic; EXACTLY 5 specific hashtags; no
  claim the video does not make.
- 1: cover is flat or mid-blink, or the caption/hashtags are generic.
- 0: no cover, wrong frame, or invented claims.

## Automatic numbers (support the scores, do not replace them)

From the project + render: duration; pause cap; number of b-roll moments and zooms; visual events per
10 s; % of runtime under b-roll; the longest bare stretch and every bare stretch > 4 s; time of the
first visual; music track / level / start point; caption corrections; cover time; post hashtags.
`testdata/q/compare.py` (gitignored harness) prints them and builds the side-by-side sheets.
