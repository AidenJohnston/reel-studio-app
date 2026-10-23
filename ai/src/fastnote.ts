// Fast path for notes whose meaning is unambiguous and whole-video ("smaller captions", "quieter
// music", "no music"). They become one direct tool call and the final render: no model turns at all.
// Anything with a place in the video, a second request, a lasting preference or a word we are not
// sure about goes to the full AI editor instead. Missing a fast path costs ~20 s; a wrong one costs
// the user's trust, so this list stays short and strict.
import { captionsUnderInstagram, lowestCaptionPosition, type Project } from './project';

const UNDER_INSTAGRAM = 'Where they sit, a two-line caption reaches under Instagram\'s own caption and username, so part of it can be hidden on Instagram. Say "captions higher" to move them up.';

export interface FastCall { name: string; args: Record<string, unknown> }
export interface FastPlan { kind: string; calls: FastCall[]; summary: string }

/** Words that mean "a specific place", "more than one thing", or "remember this": never fast. */
const NOT_FAST = /\b(when|where|while|whenever|start|starting|beginning|begin|intro|end|ending|middle|part|parts|after|before|during|first|last|second|seconds|minute|word|words|say|says|said|saying|line|always|every|everywhere|from now|next time|remember|future|and|but|also|plus|then|instead|except|picture|photo|image|cover|zoom|cut|font|color|colour|hashtag|post|song|track|different|change|another|why)\b|\d|["“”?]/;

const CAPTIONS = /\b(captions?|subtitles?|subs|words on screen|text)\b/;
const MUSIC = /\b(music|background music|beat)\b/;

function clamp(v: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, v)); }

export function planFastNote(note: string, p: Project): FastPlan | null {
  const n = note.toLowerCase().replace(/[.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!n || n.length > 60 || NOT_FAST.test(n)) return null;
  const caps = CAPTIONS.test(n); const music = MUSIC.test(n);
  if (caps === music) return null;                 // neither, or both: let the AI read it

  if (caps) {
    const style: any = p.captions?.style ?? {};
    const size = Number(style.size) || 105;
    if (/\b(no|remove|turn off|take out|get rid of|hide|without)\b/.test(n) && !/\b(smaller|bigger|larger|higher|lower|up|down)\b/.test(n)) {
      if (!p.captions.enabled) return null;
      return { kind: 'captions-off', calls: [{ name: 'set_caption_style', args: { enabled: false } }], summary: 'I took the captions off.' };
    }
    if (/\b(smaller|too big|too large|tinier|less big|shrink)\b/.test(n)) {
      const next = Math.round(clamp(size * 0.85, 80, 160));
      if (next >= size) return null;               // already at the smallest readable size: the AI explains
      return { kind: 'captions-smaller', calls: [{ name: 'set_caption_style', args: { size: next, enabled: true } }], summary: 'I made the captions a bit smaller.' };
    }
    if (/\b(bigger|larger|too small|too tiny|hard to read|enlarge)\b/.test(n)) {
      const next = Math.round(clamp(size * 1.15, 80, 160));
      if (next <= size) return null;
      // a bigger line is taller and can reach Instagram's caption: say so, but never move them unasked
      const under = !captionsUnderInstagram(p.format, style) && captionsUnderInstagram(p.format, { ...style, size: next });
      const summary = under ? `I made the captions a bit bigger. ${UNDER_INSTAGRAM}` : 'I made the captions a bit bigger.';
      return { kind: 'captions-bigger', calls: [{ name: 'set_caption_style', args: { size: next, enabled: true } }], summary };
    }
    const pos = Number(style.position) || 0.75;
    if (/\b(higher|up|too low)\b/.test(n)) {
      const next = Math.round(clamp(pos - 0.06, 0.5, 0.85) * 100) / 100;
      if (next >= pos) return null;
      return { kind: 'captions-up', calls: [{ name: 'set_caption_style', args: { position: next } }], summary: 'I moved the captions up a little.' };
    }
    if (/\b(lower|down|too high)\b/.test(n)) {
      const next = Math.round(clamp(pos + 0.06, 0.5, lowestCaptionPosition(p.format, style)) * 100) / 100;
      if (next <= pos) return null;
      return { kind: 'captions-down', calls: [{ name: 'set_caption_style', args: { position: next } }], summary: 'I moved the captions down a little.' };
    }
    if (/\b(add|turn on|put back|bring back|show)\b/.test(n) && !p.captions.enabled) {
      const summary = captionsUnderInstagram(p.format, style) ? `I put the captions back on. ${UNDER_INSTAGRAM}` : 'I put the captions back on.';
      return { kind: 'captions-on', calls: [{ name: 'set_caption_style', args: { enabled: true } }], summary };
    }
    return null;
  }

  // music
  const m = p.music;
  const hasSong = !!(m?.enabled && m.track);
  if (/\b(no|remove|turn off|take out|get rid of|without|kill|mute)\b/.test(n) && !/\b(quieter|louder|softer|down|up)\b/.test(n)) {
    if (!hasSong) return null;
    return { kind: 'music-off', calls: [{ name: 'choose_music', args: { track: null } }], summary: 'I took the music out.' };
  }
  if (!hasSong) return null;
  if (/\b(quieter|softer|too loud|lower|turn (it |the music )?down|down a bit|less loud|drowning|overpower)/.test(n)) {
    if (m.level === 'quiet') return null;          // already the quiet level: finer moves need the AI
    return { kind: 'music-quieter', calls: [{ name: 'choose_music', args: { track: m.track, level: 'quiet' } }], summary: 'I turned the music down so your voice comes through.' };
  }
  if (/\b(louder|too quiet|too soft|can'?t hear (the )?music|turn (it |the music )?up|up a bit|more music)\b/.test(n)) {
    if (m.level !== 'quiet') return null;          // under-voice is the loudest level that keeps you clear
    return { kind: 'music-louder', calls: [{ name: 'choose_music', args: { track: m.track, level: 'under-voice' } }], summary: 'I turned the music up a little, still under your voice.' };
  }
  return null;
}
