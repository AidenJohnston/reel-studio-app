// What to say when someone types a note and no AI editor is connected: plainly what they can do
// instead, plus the one button that opens the matching manual control. Simple keyword routing.
// Keep this file free of Node and DOM imports (it runs in main and is unit-tested).

export type ChatAction =
  | 'open-cut'
  | 'open-captions'
  | 'open-music'
  | 'open-broll'
  | 'open-cover'
  | 'open-post'
  | 'open-editor'
  | 'connect'
  /** "Remember this for next time?" on a My style suggestion (the message's `suggestion`). */
  | 'remember-yes'
  | 'remember-no'

export const ACTION_LABELS: Record<ChatAction, string> = {
  'open-cut': 'Open the cut',
  'open-captions': 'Open subtitle settings',
  'open-music': 'Open music',
  'open-broll': 'Open pictures',
  'open-cover': 'Open cover',
  'open-post': 'Open post caption',
  'open-editor': 'Edit it myself',
  connect: 'Connect ChatGPT',
  'remember-yes': 'Yes, remember it',
  'remember-no': 'No, just this video'
}

type Topic = Exclude<ChatAction, 'open-editor' | 'connect' | 'remember-yes' | 'remember-no'>

// Order matters: the first topic whose words match wins ("post caption" is the post, not captions).
const TOPICS: { action: Topic; re: RegExp; reply: string }[] = [
  {
    action: 'open-post',
    re: /\b(post caption|instagram caption|description|hashtags?|caption for (the |my )?post)\b/i,
    reply: 'You can write the caption for your post yourself, then copy it into Instagram.'
  },
  {
    action: 'open-captions',
    re: /\b(captions?|subtitles?|subs|text|words? on (the )?screen|font|spell(ed|ing)?|misspel\w*|wrong word|typo|misheard|yellow|bigger|smaller|higher|lower)\b/i,
    reply: 'You can change the subtitles yourself: make them bigger or smaller, move them, pick a colour, or fix a wrong word.'
  },
  {
    action: 'open-music',
    re: /\b(music|song|songs|track|beat|sound|audio|volume|loud|louder|quiet|quieter)\b/i,
    reply: 'You can pick a song and how loud it plays yourself.'
  },
  {
    action: 'open-broll',
    re: /\b(pictures?|photos?|images?|b-?roll|logos?|clips?|screenshots?)\b/i,
    reply: 'You can add a picture yourself and choose the word where it pops up.'
  },
  {
    action: 'open-cover',
    re: /\b(cover|thumbnail)\b/i,
    reply: 'You can pick the moment for your cover and the words on it yourself.'
  },
  {
    action: 'open-cut',
    re: /\b(cut|remove|delete|trim|shorter|longer|pauses?|take|takes|part where|skip|drop|beginning|ending|start|end)\b/i,
    reply: 'You can cut words yourself: click a word to cut it, click it again to bring it back.'
  }
]

export interface NoAiReply {
  text: string
  actions: ChatAction[]
}

export function noAiReply(note: string): NoAiReply {
  const why = "I can't change the video from a note yet, because no AI editor is connected."
  const hit = TOPICS.find((t) => t.re.test(note))
  if (hit) {
    return {
      text: `${why} ${hit.reply} Or connect ChatGPT and I will do it for you from notes like this one.`,
      actions: [hit.action, 'connect']
    }
  }
  return {
    text: `${why} You can change the cut, subtitles, music, pictures and cover yourself under "Edit it myself". Or connect ChatGPT and I will do it for you from notes like this one.`,
    actions: ['open-editor', 'connect']
  }
}
