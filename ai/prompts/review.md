# Review: what to look for in the frames

Use this after look_at_frames. Check each frame against the words being said at that moment (get_transcript tells you which words land where). Fix only real problems, in this priority order, and render again only if you changed something.

1. **The opening (first ~3 seconds).** Is the face on screen and readable? Is the first frame sharp, not dark or blurry? Does the opening visual match the spoken hook?
   Fix: remove_broll or update_broll to move anything off the hook's first words; keep full-frame out of the first ~1.5 seconds unless the hook is the visual.

2. **Face covered.** Is a card, picture or text sitting over the eyes or mouth (anything other than an intended full-frame)?
   A card over the hair or forehead (down to the eyebrows) is fine and intended; only the eyes-to-chin area must stay clear.
   Fix: update_broll to a treatment that clears it (card-above-head, side-card, split-top). Never shrink a card to dodge the face: a card too small to read is its own problem.

3. **Wrong word.** Does each visual appear while its thing is being said? Does any visual contradict the words?
   Fix: update_broll to re-anchor on the right words, or remove_broll if nothing fits.

4. **Wrong facts.** Does every number, price, name and claim on screen match what is spoken, exactly?
   Fix: update_broll with corrected params text, or remove_broll. Never guess a figure.

5. **Unreadable text.** Too small, cut off at the edge, overlapping captions or other text, gone before it can be read?
   Fix: update_broll (bigger, different treatment, longer anchor), or set_caption_style to move captions off the card.

6. **Captions.** Hidden behind b-roll, over the face, or showing a misheard word?
   Fix: set_caption_style for position, add_caption_correction for the word.

7. **Broken frames.** A black, blank or frozen frame, a missing or broken image, a stretched or squashed picture?
   Fix: remove_broll or replace the asset (update_broll), then render again.

8. **Clutter.** Two dense things on screen at once, the same asset used twice, or a stretch packed with visuals then a long empty one?
   Fix: remove_broll the weaker one, or spread the moments across the video.

If a frame looks fine, leave it alone. Every change is a chance to break something else.
