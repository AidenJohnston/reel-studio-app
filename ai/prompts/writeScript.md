# Task: turn an idea into a script

You are writing a short talking-head Reel script for the user to film themselves. Write it in THEIR voice: first person, casual, the way they would say it to a friend. It will be spoken, so write it SAID, not argued.

The idea:

> {{idea}}

## The hook (first 1 to 3 seconds)

Viewers decide in under 2 seconds. The hook is the first spoken line, and its only job is to make a stranger want to hear the next one.
- No throat clearing. Never open with "hey guys", "so", "today I want to talk about", or your name. Start mid-thought.
- Open a curiosity gap: make the question clear without answering it.
- One idea, one question. A 10-year-old should get it. Summarize it in 10 words or fewer.
- Be specific: a number, a date, a name, a real moment. "45 days ago" beats "a while back".
- Struggle beats success. Lead with the hard part, the loss, the mistake. A brag alienates; a confession relates.
- Lead with words a viewer would actually search for this topic.

Proven shapes to start from (fill in the blanks with the idea):
- Exact method: "Here's exactly how I [result]."
- The only one: "The one thing I did to [result]."
- Numbered: "3 things I wish I knew before [situation]."
- Time collapse: "It took me [long time] to learn what I'll tell you in a minute."
- Contrarian: "Everyone tells you [common advice]. It's wrong."
- Transformation: "A year ago I [before]. Now I [after]."
- Confession: "I have a confession. I [regret or loss]."
- Curiosity question: "Why is it so hard to [thing everyone struggles with]?"
- Identity call-out: "If you're [very specific person] and you [problem], this is for you."
- Story cold open: "So yesterday [specific event], and [person] said [quote]."
- Comparison: "[Option A] or [option B]? I've done both."

## The spoken script

- The hook makes a promise; the rest pays it off in full. A promise with no payoff feels like bait.
- One main point per video. No tangents.
- Short sentences, two at most per beat. Texting cadence, contractions, plain words. No buzzwords, no filler.
- Confession over résumé. Lead with what something cost, not with credentials. A credential appears only to make a loss hurt more.
- Never invent facts about the user: no made-up numbers, prices, dates, events or quotes. Use only what the idea gives you. Where a specific detail would make a line land and you do not have it, leave a short blank in square brackets for the user to fill, like [how much you spent] or [what they said].
- Use real moments and make them specific: numbers, places, what was said, what it felt like. For stories, tell it as it happened ("I was walking home and I started to notice...") and reveal details in the order they happened.
- Say the keywords out loud; spoken words get indexed.
- If a beat will show a list or a chart, say out loud which item to look at.
- End on one takeaway the viewer will remember, or a quiet moment of calm. Not a summary.
- A call to action is optional and often better left out. If you use one, make it one specific ask. Never "follow along to see the journey".
- Default length: about 15 to 30 seconds of talking. Go longer only if the story truly earns it.
- No em dashes. Use commas or periods. Numbers you want on screen are written as digits.

## On-screen text

Short text overlays for viewers watching on mute, in the order they appear.
- 2 to 5 words each.
- The first one is the text hook: it carries the searchable key word and ADDS context to the spoken hook. It never repeats it word for word.
- Numbers and prices exactly as spoken, as digits.
- Only claims the script makes. Nothing invented.

## Output

Reply ONLY with JSON, no other text:

{"hook": string, "script": string, "onScreenText": string[]}

"hook" is the first spoken line. "script" is the full spoken script including the hook, one line per sentence, separated by newlines. "onScreenText" is the list of overlays in order.

## The user's saved style rules (always follow these; they override defaults)
{{styleRules}}
