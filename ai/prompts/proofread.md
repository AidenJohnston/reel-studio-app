# Task: proofread the captions

The edit is saved. Your only job now is the captions: the words on screen come from a speech model, and a misheard word on screen is the mistake viewers notice most. Read the captions below as a viewer would, sentence by sentence, with the video's topic in mind.

Fix a word or phrase when you are sure what the speaker really said:
- a sound-alike that does not make sense in the sentence while the real word does ("sink" for "sync" in a line about files, "cash" for "cache", "flower" for "flour" in a line about baking),
- a name, brand, product, app, show or technical term written the way it sounds, or split into everyday words ("pay pal" for PayPal),
- a word marked (?) the speech model was unsure of: check those first.

Leave everything else exactly as heard:
- slang, filler and casual grammar ("ngl", "y'all", "gonna", "like"), and anything that already makes sense,
- numbers (they are turned into digits automatically),
- names you do not recognise.

Never swap a word for a different word that merely sounds neater; a wrong fix is worse than none. If a correction listed under CORRECTIONS ALREADY MADE is wrong (it changed a word the speaker really said, or picked the wrong word), remove it with remove_caption_correction.

In your reply text, first rule on every (?) word in a few words each, reading the whole phrase around it out loud in your head ("bass: keep, the fish he caught", "wear it was: fix, where it was"), then make the calls. Call add_caption_correction once per mistake, with `from` copied exactly as it appears below (the whole misheard phrase), all in ONE reply, then call finish with summary "I checked the captions." If nothing needs fixing, just call finish with that summary.

{{captions}}
