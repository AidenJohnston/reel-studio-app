# Task: the first edit

Turn this raw take into a finished first draft the user would be happy to post. Work through these steps in order. Each step names the tools it uses. Keep tool calls lean: read once, decide, write once. Put every call that does not need an earlier call's result into the SAME reply (all searches together, all downloads together, all add_broll together): they run at the same time, and each extra reply costs the user a long wait.

## 1. Read

Call get_project, then get_transcript. Read the whole transcript before you cut anything. Note the retake groups (lines said more than once), the pauses, the hook, and the payoff. Decide in one sentence what the video is about.

## 2. Cut the red thread

Pick the best take of each beat using the cut rules in your doctrine: the last complete clean take usually wins, drop false starts, doubles, filler and meta-talk, keep everything said only once, keep the hook. Call set_cut once with the full keep list in output order. Then set_gap_cap: tight (about 0.12 s) for normal talk, looser (0.25 to 0.4 s) for slow, heartfelt delivery.

## 3. Captions

Call set_caption_style only if the default does not suit the video (keep 2 to 3 words, one line). Scan the kept words for mishearings (names, brands, jargon, numbers spoken as the wrong word) and call add_caption_correction for each one you are confident about.

## 4. Music

Call list_library with kind music (in the same reply as kind images and kind broll). Its songs[] tell you what each track SOUNDS like (energy, mood, bpm), measured by listening. Name the video's tone in one or two words, then pick only among the moods that tone allows: heartfelt, reflective or sad: gentle, melancholic, dreamy, light. Funny or a comedy story: upbeat, light, hype. Explainer, how-to or day story: upbeat, steady groove. Rant, opinion, hot take, announcement or hype: driving, hype, upbeat, dramatic. Within those, prefer a song whose instrument or genre matches the topic (the file name can say that; it cannot say the mood). Call choose_music with level under-voice (quiet for intimate talk) and startAt null (the engine finds a calm entry). The music ends with the last word (a short cut, never a long fade); do not add automation for the ending. If the video has a clear payoff moment, lift the music gently on those words with set_music_automation. If the library is empty, skip music.

## 5. Hook title

add_broll a text-pop over the hook sentence (first kept word to the end of the hook sentence) with params.style "label", params.tilt 0, params.text = the video's claim or question in 3 to 7 words from the speaker's own words, sentence case. See "The hook" in your doctrine.

## 6. Plan the b-roll

Walk the kept transcript in 4-second windows and write the plan in your head: for EVERY window, what will the screen show (a picture, an animation, a text-pop, or a zoom)? Then list the moments where a visual would SHOW the point being made (the named thing, a place, a proof, a number, a list item, a quote). Expect 12 to 20 b-roll moments in a 60 to 90 second video, spread across the whole video including the ending; windows with nothing to show get a zoom in step 7.

For each moment, find the asset in this order:
1. list_library with kind images and kind broll (call each once, then match from the results).
2. search_images for what the viewer should picture at each moment (the point of the line, not an incidental word), ALL searches in one reply. Query by kind: a brand, app, company, product or team: its name plus "logo" ("spotify logo"; real logos come back first, then use logo-pop or a card); a place, object, food, animal, person or event: the specific noun plus "photo" ("golden gate bridge photo"). Read titles, kind and licence, then fetch_image the results that match, ALL in one reply. Each fetch returns a small still: LOOK at it, and place only the pictures that really show the thing (a matching title can carry a wrong picture: a different dish, a different building, a diagram). Shows, films and memes are rarely there: use a text-pop with the name (within the text-pop budget) or a zoom, never a wrong picture. Pictures that need a credit are credited in the post caption automatically.
3. make_animation (stat-count-up, big-quote, list-reveal, logo-pop, price-tag, typing-terminal) for numbers, quotes, lists and typed text, or a text-pop with the key 1 to 4 words. Numbered steps each get a "N: name" label on their word.

Place each with add_broll, anchored to the words it illustrates, with the treatment that fits. Send many add_broll calls in one turn. Then count: b-roll moments should reach about one per 6 seconds of video (12 or more in 70 seconds). If you are short, go back over the longest face-only stretches and add a picture or an animation; a zoom alone is the fill only where nothing honest exists. Use each asset once. Any number, price or claim on screen must match the spoken words exactly. Never invent a fact.

## 7. Zooms

List the face-only stretches left after step 6 (from the end of one visual to the start of the next, using the word times). Call set_zoom once with every zoom: one on each punchline or key line, plus one in the MIDDLE of every face-only stretch longer than about 4 seconds, so neither side of it stays bare for more than about 4 seconds; a stretch longer than about 8 seconds needs a picture, an animation or two zooms. Each zoom spans a whole line from its first word, scale about 1.08 to 1.15, never under a b-roll that hides the face. Expect about 4 to 8 per minute.

## 8. Cover

Pick 3 to 4 strong moments (the hook's key word, the payoff, a reaction or a big expression) and call cover_candidates with their word ids, in the same reply as render_draft in step 10. Look at the stills it returns and, in your next reply, call set_cover with the atSourceTime of the best one: eyes open and on the camera, a real expression, mouth relaxed or closed, never mid-blink or mid-word. Add text only if 1 to 3 words carry the hook's key word.

## 9. Post kit

Call write_post with:
- caption: three short parts. (1) A hook line of about 60 to 80 characters that leads with the words a viewer would search for this topic and makes a small promise. (2) One or two sentences of context or payoff. (3) At most one specific ask, or none. Never "follow along to see the journey". Match the user's voice and person (I or we), casual, no filler, no em dashes, no claims the video does not make.
- hashtags: EXACTLY 5. Specific to this video's topic and audience, a mix of niche and mid-size tags. No giant generic tags. No tags unrelated to the video.
- keywords: 3 to 8 searchable phrases taken from what is actually said in the video.

## 10. Render and look

Call render_draft (with cover_candidates in the same reply). Then call look_at_frames once (with set_cover in the same reply) with 4 to 6 times: the opening (about 1 s) plus the web pictures and cards you are least sure of. Check: the hook title reads, every picture really shows what is said (a wrong web picture gets removed or replaced), text is big enough, eyes and mouth clear, numbers match the words. Fix only real problems (wrong word, face covered, unreadable text, black frame, a number that does not match). If you changed anything, call render_draft again. Do not render more than twice unless something is broken.

## 11. Finish

Call finish with a 1 to 3 sentence summary in plain, warm language. Example: "I kept your best take of each line and cut the pauses so it moves fast. I added soft music, put a picture on each thing you mention, and wrote your caption." No jargon, no times, no em dashes.

Say where every picture came from, and never say there are no pictures when you placed some. The checklist next to your summary counts pictures, animations and text cards separately, so your words must agree with it. If the Library had no pictures and you used the web, say so: "Your Library has no pictures, so I found 3 online." If you made animations or text cards instead, call them that: "I made 2 animations and a title card." Only say "voice only" or "no pictures" when you placed nothing on screen at all.
