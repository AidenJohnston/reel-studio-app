// The consistency audit (layout-audit/consistency.ts) on a fixed page: each rule must flag its case and leave the near
// miss beside it alone. Every case sits in its own cell, so cells never interact.
import { test, expect } from '@playwright/test'
import { launch } from './helpers'
import { auditConsistency } from './layout-audit/consistency'
import { SCALE } from './layout-audit/consistency-allow'

const CELL = 'position:absolute;width:300px;height:140px;font:14px/18px system-ui'
const at = (i: number): string => `left:${20 + (i % 4) * 310}px;top:${20 + Math.floor(i / 4) * 150}px`
const BTN = 'border:0;padding:0 12px;background:#eee'
const cells = [
  // off-scale: a 10 px padding, a 10 px gap, 15.5 px type, a 12/17 line, 7 px corners, a 34 px button, a 17 px icon
  `<div id="pad-off" style="padding-left:10px">words</div>`,
  `<div id="pad-ok" style="padding-left:12px">words</div>`,
  `<div id="gap-off" style="display:flex;column-gap:10px"><span>a</span><span>b</span></div><div id="gap-ok" style="display:flex;column-gap:12px"><span>a</span><span>b</span></div>`,
  `<div id="fs-off" style="font-size:15.5px;line-height:20px">words</div><div id="fs-ok" style="font-size:15px;line-height:20px">words</div>`,
  `<div id="lh-off" style="font-size:12px;line-height:17px">words</div><div id="lh-ok" style="font-size:12px;line-height:16px">words</div>`,
  `<div id="rad-off" style="width:60px;height:40px;border-radius:7px;background:#eee"></div><div id="rad-ok" style="width:60px;height:40px;margin-top:8px;border-radius:8px;background:#eee"></div>`,
  `<button id="ctl-off" style="${BTN};height:34px">Go</button><button id="ctl-ok" style="${BTN};height:32px;margin-left:12px">Go</button>`,
  `<svg id="icon-off" class="icon" width="17" height="17"></svg><svg id="icon-ok" class="icon" width="16" height="16"></svg>`,
  // row-heights: a 32 px and a 28 px button side by side / two at 32 / a 32 px switch track (two 24 px buttons) beside a 32 px button
  `<div id="row-mixed" style="display:flex;gap:8px"><button style="${BTN};height:32px">A</button><button style="${BTN};height:28px">B</button></div>` +
    `<div id="row-ok" style="display:flex;gap:8px;margin-top:8px"><button style="${BTN};height:32px">A</button><button style="${BTN};height:32px">B</button></div>` +
    `<div id="row-track" style="display:flex;gap:8px;margin-top:8px"><div style="display:flex;padding:4px;background:#ddd;border-radius:999px"><button style="${BTN};height:24px">A</button><button style="${BTN};height:24px">B</button></div><button style="${BTN};height:32px">C</button></div>`,
  // sibling-gaps: 8 then 12 / grouped 4, 4 then 16 / a spacer between two groups
  `<div id="gaps-off" style="display:flex"><span>a</span><span style="margin-left:8px">b</span><span style="margin-left:12px">c</span></div>` +
    `<div id="gaps-grouped" style="display:flex;margin-top:8px"><span>a</span><span style="margin-left:4px">b</span><span style="margin-left:4px">c</span><span style="margin-left:16px">d</span></div>` +
    `<div id="gaps-spacer" style="display:flex;gap:8px;margin-top:8px;width:280px"><span>a</span><span>b</span><span style="flex:1"></span><span>c</span></div>`,
  // stack-axis: a column whose narrow children share no edge or centre / the same, centred
  `<div id="stack-off" style="display:flex;flex-direction:column;align-items:flex-start;width:280px"><div style="width:100px;height:20px;background:#ccc"></div><div style="width:120px;height:20px;margin-left:20px;background:#ccc"></div></div>` +
    `<div id="stack-ok" style="display:flex;flex-direction:column;align-items:center;width:280px;margin-top:8px"><div style="width:100px;height:20px;background:#ccc"></div><div style="width:160px;height:20px;background:#ccc"></div></div>`,
  // stack-axis near miss: a grid of two columns, narrower than it, is not one column (each column has its own edge)
  `<div id="stack-grid" style="display:grid;grid-template-columns:120px 120px;gap:8px;width:280px"><div style="height:20px;background:#ccc"></div><div style="height:20px;background:#ccc"></div><div style="height:20px;background:#ccc"></div><div style="height:20px;background:#ccc"></div></div>`,
  // edge-near-miss: two surfaces stacked 6 px off / 40 px off (a deliberate inset)
  `<div id="near-a" style="width:200px;height:20px;background:#ccc"></div><div id="near-b" style="width:200px;height:20px;margin:8px 0 0 6px;background:#ccc"></div>`,
  `<div id="far-a" style="width:200px;height:20px;background:#ccc"></div><div id="far-b" style="width:200px;height:20px;margin:8px 0 0 40px;background:#ccc"></div>`,
  // edge-near-miss near miss: a caption its column centres (110 px in) over text 115 px in is not a stack pair
  `<div style="display:flex;flex-direction:column;align-items:center;width:280px"><div style="width:100px;height:40px;background:#ccc"></div><div id="cap-centred" style="width:60px">Version 1</div></div><div id="cap-below" style="margin:8px 0 0 115px">Sound from</div>`,
  // concentric: a 14 px fill 6 px inside a 14 px surface / an 8 px one
  `<div style="width:120px;padding:6px;border-radius:14px;background:#ddd"><div id="inner-rad" style="height:30px;border-radius:14px;background:#bbb"></div></div>` +
    `<div style="width:120px;padding:6px;margin-top:8px;border-radius:14px;background:#ddd"><div id="inner-ok" style="height:30px;border-radius:8px;background:#bbb"></div></div>`
]
const PAGE = `<!doctype html><html><head><style>button { font: inherit; border-radius: 999px }</style></head><body style="margin:0;overflow:hidden">${cells.map((c, i) => `<div style="${CELL};${at(i)}">${c}</div>`).join('')}</body></html>`

test('fails if a consistency rule misses its case or flags the near miss beside it', async () => {
  const { app, page } = await launch()
  try {
    await page.setContent(PAGE)
    const { findings } = await page.evaluate(auditConsistency, { allow: [], scale: SCALE })
    const got = findings.map((f) => `${f.rule} ${f.prop ?? ''} ${f.selector}`.replace(/ +/g, ' ')).sort()
    expect(got).toEqual(
      [
        'off-scale padding-left #pad-off',
        'off-scale column-gap #gap-off',
        'off-scale font-size #fs-off',
        'off-scale line-height #lh-off',
        'off-scale border-radius #rad-off',
        'off-scale control-height #ctl-off',
        'off-scale icon-size #icon-off',
        'row-heights #row-mixed',
        'sibling-gaps #gaps-off',
        'stack-axis #stack-off',
        'edge-near-miss #near-a',
        'concentric #inner-rad'
      ].sort()
    )

    // an allowlist entry removes exactly its finding
    const allowed = await page.evaluate(auditConsistency, { allow: [{ rule: 'off-scale' as const, selector: '#pad-off' }], scale: SCALE })
    expect(allowed.allowed).toBe(1)
    expect(allowed.findings.some((f) => f.selector === '#pad-off')).toBe(false)
    expect(allowed.findings.some((f) => f.selector === '#gap-off')).toBe(true)
    // an exact entry covers its element only, not what is inside it (#pad-off sits in its cell, a div of the page)
    const exact = await page.evaluate(auditConsistency, { allow: [{ rule: 'off-scale' as const, selector: 'body > div', exact: true }], scale: SCALE })
    expect(exact.findings.some((f) => f.selector === '#pad-off')).toBe(true)
    const inside = await page.evaluate(auditConsistency, { allow: [{ rule: 'off-scale' as const, selector: 'body > div' }], scale: SCALE })
    expect(inside.findings.some((f) => f.selector === '#pad-off')).toBe(false)
  } finally {
    await app.close()
  }
})
