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
