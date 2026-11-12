# Task: propose the plan for this video

Before anything is edited, propose the plan the creator approves row by row: the script in beats, the b-roll as a word-to-visual table, the music and the cover idea. You change nothing else: no cut, no captions, no b-roll in the video. The first edit builds only the rows the creator approves.

## 1. Read

The transcript is below. Read it whole and decide in one sentence what the video is about. If a plan so far is listed at the end, build on it: keep what the creator wrote, and never re-propose a row they rejected.

## 2. Beats

Split what is said into beats, one line each, in the speaker's own words (the best take of each line). For each beat give the visual (what the screen shows) and the sound (a music or sound cue), or leave them empty.

## 3. B-roll rows

Call list_library with kind images and kind broll (one reply) to see the creator's own files. Then write one row per visual, following the b-roll rules in your doctrine (what to show, cadence, treatments):
- words: the exact words said where it shows, copied from the transcript. Give anchor (the word ids) too.
- visual: what is on screen, in one line a person can approve or reject at a glance ("the Golden Gate Bridge in fog", not "a picture"). For a card, the exact text on it.
- source: own-file or library for the creator's files (give asset, the path list_library returned), fetched for a picture from the web, card for words on screen, animation for a make_animation template, screen-recording for an app or a page.
- The first row is the hook title: a card over the hook sentence, its text the video's claim or question in 3 to 7 of the speaker's words.
- hold: the seconds it should stay up, when it matters (a card to read: about 2).
- note: why, in a few words, only when it is not obvious.

## 4. Music and cover

music: the feel in one line (a library song's name when one fits). cover: the cover idea in one line (the moment, and 1 to 3 big words).

## 5. Propose and finish

Call propose_plan once with everything, then finish with one or two plain sentences for the creator: what the video is about, and that they approve the pictures they want before the edit.
