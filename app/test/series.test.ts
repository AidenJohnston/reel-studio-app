import { expect, it } from 'vitest'
import { pickSeries, type SeriesReel } from '../src/main/series'

const reel = (slug: string, words: string, more: Partial<SeriesReel> = {}): SeriesReel => ({
  slug, title: slug.replace(/-/g, ' '), createdAt: `2026-11-0${slug.length % 9}T00:00:00Z`, series: null, chosen: false, words, ...more
})

const SOURDOUGH = 'so today the sourdough starter needs feeding the starter rises overnight and the dough proofs in the fridge'
const SOURDOUGH_2 = 'my sourdough loaf came out flat because the starter was weak so feed the starter twice before the dough'
const BIKE = 'the bike chain keeps slipping so we adjust the derailleur and the gears shift cleanly on the climb'
// only everyday words in common with SOURDOUGH
const CHAT = 'so today I really want to talk about something going on this week and what it means for you'

it('fails if two reels about the same thing stay apart, or the new series is not named after the older reel', () => {
  const older = reel('sourdough-basics', SOURDOUGH, { createdAt: '2026-11-01T00:00:00Z' })
  const newer = reel('flat-loaf', SOURDOUGH_2, { createdAt: '2026-11-03T00:00:00Z' })
  // only two reels: a word both say must still count (no idf of zero)
  expect(pickSeries(newer, [older])).toEqual({ series: 'sourdough basics', alsoSet: 'sourdough-basics' })
})

it('fails if reels that share only everyday words are grouped, or a reel joins the wrong series', () => {
  const bread = reel('bread', SOURDOUGH, { series: 'Bread' })
  const bike = reel('bike', BIKE, { series: 'Bikes' })
  expect(pickSeries(reel('chat', CHAT), [bread, bike])).toBeNull()
  expect(pickSeries(reel('loaf', SOURDOUGH_2), [bread, bike])).toEqual({ series: 'Bread', alsoSet: null })
})

it('fails if a reel the person took out of every series is pulled back into one', () => {
  const out = reel('bread', SOURDOUGH, { chosen: true, series: null })
  expect(pickSeries(reel('loaf', SOURDOUGH_2), [out])).toBeNull()
  // a series the person picked is still one to join
  expect(pickSeries(reel('loaf', SOURDOUGH_2), [{ ...out, series: 'My bread' }])).toEqual({ series: 'My bread', alsoSet: null })
})
