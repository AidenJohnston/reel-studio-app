import { describe, it, expect } from 'vitest';
import { momentSection } from '../src/editor';
import { withDefaults, type Transcript } from '../src/project';

// ten one-second words, all kept: output time is about the same as source time
const t: Transcript = { words: Array.from({ length: 10 }, (_, i) => ({ id: `w${i}`, source: 's1', s: i, e: i + 0.8, w: `word${i}` })) };
const p = withDefaults({ cut: { keep: [{ from: 'w0', to: 'w9' }], gapCap: 0.25 } });

describe('a note asked at a moment', () => {
  it('names the kept words said around that time', () => {
    const s = momentSection('At 0:05: cut this part', p, t);
    expect(s).toContain('0:05');
    expect(s).toContain('w5:word5');
    expect(s).not.toContain('w0:');
    expect(s).not.toContain('w9:');
  });

  it('after the last word, names the last words', () => {
    expect(momentSection('At 0:30: zoom in here', p, t)).toContain('w9:word9');
  });

  it('adds nothing to a note about the whole reel', () => {
    expect(momentSection('Make the subtitles bigger', p, t)).toBe('');
  });
});
