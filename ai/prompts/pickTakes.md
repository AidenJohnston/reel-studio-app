# Task: pick the takes

You are given a raw talking-head transcript. The speaker recorded freely: lines were redone until they landed, with false starts, pauses and chatter in between. Your job is to choose which words to keep so the result plays as one clean, flowing thought: the red thread.

## Input

- words: each has an id (w0, w1, ...), start and end seconds, and its text.
- retake groups (optional): a line said more than once, with the candidate word ranges for each attempt.
- pauses (optional): gaps between words, with their length.

## Rules

1. One take per beat. A beat is one line or idea. When a line was said more than once, the LAST complete, clean take usually wins, because people redo a line until it lands. Choose an earlier take only when it is clearly better: complete where the later one is not, no stumble where the later one has one, or noticeably stronger delivery.
   When the speaker restarts the WHOLE script (the second run repeats the first from the top), the last complete run wins. Do not go back to an earlier run just because it has an extra ad-lib or a slightly different word; mixing runs breaks the flow.
2. A take is complete when it says the whole line. Never splice half of one take onto half of another unless both halves are clean and the join falls between sentences.
3. Drop false starts: a sentence that stops partway and is then restarted. Keep only the restarted version.
4. Drop stutters and mid-sentence restarts ("I was, I was going to"). Keep the clean wording.
5. Drop meta-talk: anything said ABOUT the recording rather than to the viewer. Examples: "let me try that again", "wait", "hold on", "okay so" as a reset, "one more time", "from the top", counting in ("3, 2, 1"), "is this recording", "cut that".
6. Drop filler ums and uhs when they sit at the edge of a range. Do not break a sentence into fragments just to remove one filler in the middle.
7. Keep the real content. Opinions, asides and jokes are content, not meta. Anything said only once stays, even if it is a little rough. When unsure, keep it.
8. Keep the hook: the opening line must be in the cut, using its best take.
9. Keep the speaker's beat order. Reorder only when it is obvious (for example, the clean hook was recorded at the very end).
10. Prefer whole sentences. Start a range on the first word of a sentence and end it on the last word.
11. Leave a tiny slip alone if fixing it would mean cutting inside a sentence that is otherwise clean.
12. If the speaker directs the edit out loud and it lands as a joke ("okay, you can cut here"), it may be kept as the ending.

## Output

Reply ONLY with JSON, no other text:

{"keep": [{"from": "wX", "to": "wY"}, ...], "notes": "<one short line>"}

- Ranges are inclusive word ids, listed in OUTPUT order (the order the viewer will hear them).
- Ranges never overlap and never repeat a word.
- "notes" is one short plain line on what you dropped, for example "Used the last take of the hook and dropped two false starts."
