// The layout audit's detectors on a fixed page: each one must flag its case and leave the near miss beside it alone.
// Every case sits in its own cell, so cells never interact.
import { test, expect } from '@playwright/test'
import { launch } from './helpers'
import { detectLayout } from './layout-audit/detect'

const CELL = 'position:absolute;width:300px;height:140px;font:14px/18px system-ui'
// a 1×1 GIF, so the picture button has a picture
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
const at = (i: number): string => `left:${20 + (i % 4) * 310}px;top:${20 + Math.floor(i / 4) * 150}px`
const cells = [
  // text-overflow: spills out of its box / truncated with an ellipsis and a title
  `<div id="spill" style="width:80px;white-space:nowrap">a line that is far too long for its box</div>`,
  `<div id="ellipsis" title="a line that is far too long for its box" style="width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">a line that is far too long for its box</div>`,
  // clipped near miss: a start-truncated path (Settings' PathLine) inside a box that clips, wider than the window
  `<div style="width:200px;overflow:hidden"><span id="path" title="/a/very/long/folder/path/that/goes/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/to/Reel Studio" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left"><bdi dir="ltr">/a/very/long/folder/path/that/goes/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/and/on/to/Reel Studio</bdi></span></div>`,
  // and a line that truncates itself, as wide as the box that clips it (More reels' hook)
  `<div style="width:200px;overflow:hidden;display:grid"><p id="hook" title="a quote from the video that is far too long for one line" style="margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">a quote from the video that is far too long for one line</p></div>`,
  // clipped: cut by an overflow-hidden box / the same inside a scroll area
  `<div style="height:40px;overflow:hidden"><button id="cut" style="margin-top:28px;height:30px;width:80px">Go</button></div>`,
  `<div style="height:40px;overflow:auto"><button id="reachable" style="margin-top:28px;height:30px;width:80px">Go</button></div>`,
  // horizontal-scroll: content wider than a sideways scroller / a scroller that fits
  `<div id="sideways" style="width:120px;overflow-x:auto"><div style="width:300px;height:20px"></div></div>`,
  `<div id="fits" style="width:120px;overflow-x:auto"><div style="width:100px;height:20px"></div></div>`,
  // nested-scroll: a scroller in a scroller, both overflowing
  `<div id="outer" style="height:120px;overflow-y:auto"><div id="inner" style="height:80px;overflow-y:auto"><div style="height:200px"></div></div><div style="height:100px"></div></div>`,
  // stacked: two scrollers one above the other in one column
  `<div style="width:200px"><div id="upper" style="height:60px;overflow-y:auto"><div style="height:120px"></div></div><div id="lower" style="height:60px;overflow-y:auto"><div style="height:120px"></div></div></div>`,
  // overlap: two text blocks on top of each other / side by side
  `<div id="over-a" style="position:absolute;left:0;top:0;width:120px">First block of words</div><div id="over-b" style="position:absolute;left:20px;top:4px;width:120px;background:#fff">Second block here</div>`,
  `<div id="side-a" style="position:absolute;left:0;top:0;width:110px">First block</div><div id="side-b" style="position:absolute;left:150px;top:0;width:110px">Second block</div>`,
  // text-collision: two flex items touching ("0:09Hold") / the same with a gap; one line of text with no space / before punctuation
  `<div style="display:flex"><span id="clock">0:09</span><span id="hint">Hold the video</span></div><div style="display:flex;gap:8px;margin-top:30px"><span id="clock-ok">0:09</span><span>Hold the video</span></div>`,
  `<p style="margin:0"><span id="inline-a">0:09</span><span>Hold</span></p><p style="margin:30px 0 0"><a href="#" id="link">a link</a>. Then words.</p>`,
  // small-target: a 16 px button / a 24 px one and an inline link in a sentence
  `<button id="tiny" style="width:16px;height:16px;padding:0">x</button><button id="big" style="width:24px;height:24px;padding:0;margin-left:40px">x</button><p>Read <a href="#" id="inline-link">this</a> first.</p>`,
  // popover-placement: a menu running out of the window, opened from a button far from it
  `<button id="trigger" aria-expanded="true" aria-controls="far-menu" style="height:30px;width:90px">Open</button><div role="menu" id="far-menu" style="position:fixed;right:-40px;bottom:10px;width:120px;height:60px;background:#eee"></div>`,
  // overlap near miss: a line that ends in its own ellipsis beside a button (the first run's footer); its laid-out
  // text runs on under the button, but nothing is drawn past the line's own box
  `<div style="display:flex;align-items:center;gap:12px;width:300px"><div style="min-width:0;display:grid;grid-template-columns:minmax(0,1fr)"><span id="own-ellipsis" title="A few seconds left. It writes down what you say, on this Mac." style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">A few seconds left. It writes down what you say, on this Mac.</span></div><span style="flex:1"></span><button id="beside" style="flex:none;height:30px;width:90px">Not now</button></div>`,
  // imbalance: the focal object sits at the left of its column
  `<div id="column" style="width:300px;height:100px"><div id="focal" style="width:60px;height:40px;background:#ccc"></div></div>`,
  // button-shape: an icon button with rounded-square corners / a circle beside it
  `<button id="square" style="width:32px;height:32px;padding:0;border:0;border-radius:8px;background:transparent">x</button><button id="circle" style="width:32px;height:32px;padding:0;margin-left:40px;border:0">x</button>`,
  // a hairline text button with 8 px corners / near misses: a row as wide as its list, a picture, a card
  `<button id="rect" style="height:30px;width:90px;border:0;border-radius:8px;box-shadow:inset 0 0 0 1px #999">Choose</button><div style="width:280px;margin-top:6px"><button id="row" style="display:block;width:100%;height:32px;border:0;border-radius:8px;background:#eee">A row</button></div><button id="tile" style="width:40px;height:40px;padding:0;border:0;border-radius:8px"><img src="${PIXEL}" width="40" height="40" alt=""></button><button id="card" style="width:120px;height:60px;border:0;border-radius:14px;background:#eee">Card</button>`
]
// every other button on the page is a pill, as the app's are, so only the button-shape cells have square corners
const PAGE = `<!doctype html><html><head><style>button { border-radius: 999px }</style></head><body style="margin:0;overflow:hidden">${cells.map((c, i) => `<div style="${CELL};${at(i)}">${c}</div>`).join('')}</body></html>`

test('fails if a layout detector misses its case or flags the near miss beside it', async () => {
  const { app, page } = await launch()
  try {
    await page.setContent(PAGE)
    const { findings } = await page.evaluate(detectLayout, { allow: [], focal: '#focal', column: '#column' })
    const got = findings.map((f) => `${f.detector} ${f.selector}${f.other ? ` / ${f.other}` : ''}`).sort()
    expect(got).toEqual(
      [
        'text-overflow #spill',
        'clipped #cut / div > div',
        'horizontal-scroll #sideways',
        'nested-scroll #inner / #outer',
        'nested-scroll #upper / #lower',
        'overlap #over-b / #over-a',
        'text-collision #clock / #hint',
        'text-collision #inline-a / div > p > span',
        'small-target #tiny',
        'popover-placement #far-menu',
        'popover-placement #far-menu / #trigger',
        'imbalance #focal / #column',
        'button-shape #square',
        'button-shape #rect'
      ].sort()
    )

    // an allowlist entry removes exactly its finding
    const allowed = await page.evaluate(detectLayout, { allow: [{ detector: 'small-target' as const, selector: '#tiny' }] })
    expect(allowed.allowed).toBe(1)
    expect(allowed.findings.some((f) => f.selector === '#tiny')).toBe(false)
    expect(allowed.findings.some((f) => f.selector === '#spill')).toBe(true)
  } finally {
    await app.close()
  }
})
