import { homedir } from 'node:os'
import { join } from 'node:path'

/** The takes the runner imports: `short` by default, `long` with --long or --clip long. Each can point anywhere with
 * REELSTUDIO_PERF_SHORT_CLIP / REELSTUDIO_PERF_LONG_CLIP. */
export function clipPath(kind) {
  if (kind === 'long') return process.env.REELSTUDIO_PERF_LONG_CLIP || join(homedir(), 'Downloads/Video/IMG_7303.mov')
  return process.env.REELSTUDIO_PERF_SHORT_CLIP || join(homedir(), 'Downloads/Video/short-take.mp4')
}

export function noteFixture() {
  const calls = [
    ['set_caption_style', { size: 110 }],
    ['render_draft', {}],
    ['set_caption_style', { size: 126, color: '#FFD60A' }],
    ['render_draft', {}],
    ['finish', { summary_for_user: 'Made the subtitles bigger and yellow.' }]
  ]
  return { version: 1, recordedWith: { provider: 'synthetic benchmark', model: 'no inference' },
    task: 'two subtitle adjustments and previews', createdAt: new Date().toISOString(),
    steps: calls.map(([name, args], index) => ({ response: { text: '', toolCalls: [{ id: `perf-${index + 1}`, name, args }] } })) }
}
