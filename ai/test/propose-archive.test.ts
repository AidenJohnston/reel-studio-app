import { expect, it } from 'vitest';
import { checkArchiveProposal, formatArchive, proposeFromArchive, type ArchiveRequest } from '../src/propose-archive';
import { Prompts } from '../src/prompts';

// two files: a sourdough take with four 5 s lines, and a shorter one on the same starter
const line = (s: number, text: string) => ({ s, e: s + 5, text });
const REQ: ArchiveRequest = {
  files: [
    { ref: 'Footage/src-0123abcd/day 1/a.mp4', name: 'a.mp4', duration: 40, lines: [
      line(0, 'Is this recording?'), line(5, 'My starter died twice before I learned this.'),
      line(10, 'Feed it at the same time every day.'), line(15, 'Warm water, not hot.'),
    ] },
    { ref: 'Library/Raw takes/b.mp4', name: 'b.mp4', duration: 20, lines: [
      line(2, 'Once it doubles in four hours, it is ready.'), line(7, 'That is the whole trick.'),
    ] },
  ],
};

it('fails if line ranges are not turned into the exact times, files and opening line the reel is cut from', () => {
  const r = checkArchiveProposal({ candidates: [{ title: 'Keep your starter alive', lines: ['F1:L2-L4', 'F2:L1'], why: 'I joined the feeding routine to the sign it is ready.' }], notes: '' }, REQ);
  expect(r).toEqual({ proposal: { notes: '', candidates: [{
    id: 'r1', title: 'Keep your starter alive', hook: 'My starter died twice before I learned this.',
    why: 'I joined the feeding routine to the sign it is ready.', seconds: 20,
    spans: [
      { ref: 'Footage/src-0123abcd/day 1/a.mp4', t0: 5, t1: 20, said: 'My starter died twice before I learned this. Feed it at the same time every day. Warm water, not hot.' },
      { ref: 'Library/Raw takes/b.mp4', t0: 2, t1: 7, said: 'Once it doubles in four hours, it is ready.' },
    ],
  }] } });
});

it('fails if a reply the app cannot cut is accepted', () => {
  const reel = (lines: unknown, more: object = {}) => ({ title: 'Starter', lines, why: 'I kept the routine.', ...more });
  const cases: [unknown, RegExp][] = [
    [[reel(['F1:L2-L4']), reel(['F1:L4', 'F2:L1-L2'], { title: 'Ready' })], /r2: lines\[0\] uses F1:L4, which r1 uses/],
    [[reel(['F3:L1'])], /names F3, which is not in the footage/],
    [[reel(['F1:L3-L9'])], /not a range of F1's lines L1-L4/],
    [[reel(['F1:L4-L2'])], /not a range/],
    [[reel(['the second file'])], /must look like "F2:L3-L7"/],
    [[reel(['F1:L2'])], /plays for 5\.0 s; a reel plays for 15 to 90 s/],
    [[reel(['F1:L2-L3'], { why: 'Two sentences. Not one.' })], /why must be one sentence/],
    [[reel(['F1:L2-L4']), reel(['F2:L1-L2'])], /title is the same as r1's/],
  ];
  for (const [candidates, problem] of cases) {
    const r = checkArchiveProposal({ candidates }, REQ);
    expect('problems' in r && r.problems.join('; '), JSON.stringify(candidates)).toMatch(problem);
  }
  const many = { files: [0, 1, 2, 3].map((n) => ({ ref: `Library/Raw takes/${n}.mp4`, name: `${n}.mp4`, duration: 10, lines: [line(0, `Line ${n}.`)] })) };
  const four = checkArchiveProposal({ candidates: [reel(['F1:L1', 'F2:L1', 'F3:L1', 'F4:L1'])] }, many);
  expect('problems' in four && four.problems.join()).toMatch(/uses 4 files; a reel draws from at most 3/);
  // nothing that stands on its own is a proposal, not an error
  expect(checkArchiveProposal({ candidates: [], notes: 'All short asides.' }, REQ)).toEqual({ proposal: { candidates: [], notes: 'All short asides.' } });
});

it('fails if the editor is not shown every line with its file, number and time, or a bad first reply is not asked again', async () => {
  expect(formatArchive(REQ)).toContain('F2 "b.mp4" (20 s)\n  L1 2.0-7.0 Once it doubles in four hours, it is ready.');
  const replies = [
    '{"candidates": [{"title": "Starter", "lines": ["F1:L2"], "why": "I kept it."}], "notes": ""}',
    '{"candidates": [{"title": "Starter", "lines": ["F1:L2-L4"], "why": "I kept it."}], "notes": ""}',
  ];
  const asked: string[] = [];
  const provider = {
    id: 'claude', reportsWaits: false,
    async complete(req: { messages: { content?: { text: string }[] }[] }) {
      asked.push(JSON.stringify(req.messages.at(-1)));
      return { text: replies[asked.length - 1], raw: null, toolCalls: [] };
    },
  } as never;
  const r = await proposeFromArchive(new Prompts(), provider, REQ);
  expect(r.attempts).toBe(2);
  expect(asked[1]).toMatch(/plays for 5\.0 s/);
  expect(r.candidates[0].spans).toEqual([expect.objectContaining({ t0: 5, t1: 20 })]);
});
