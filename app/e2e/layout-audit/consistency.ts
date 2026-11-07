// The consistency audit: what a program can say about "one system" on the screen in view. `auditConsistency` runs
// inside the page (page.evaluate serialises it), so it stays self-contained: no imports, nothing from outside its body.
//
// Rules (each finding names one):
//   off-scale        a padding, margin, gap, font size, line height, corner radius, control height or icon size that is
//                    not on the design scale below
//   row-heights      controls laid side by side in one row with different heights
//   sibling-gaps     the gaps between the children of one row or column differ, and not as a deliberate grouping
//   edge-near-miss   two boxes stacked one above the other whose left or right edges miss each other by 1 to 12 px,
//                    while not centred on one axis (near-misses are the bugs; a deliberate offset is larger)
//   stack-axis       the children of one column share neither a left edge, a right edge nor a centre
//   concentric       a rounded fill inside a rounded surface whose radius is not the surface's radius minus the inset
//
// The scale lives here so the audit and the stylesheet's tokens can be compared in one place (styles.css :root).

export type ConsistencyRule = 'off-scale' | 'row-heights' | 'sibling-gaps' | 'edge-near-miss' | 'stack-axis' | 'concentric'

export interface ConsistencyFinding {
  rule: ConsistencyRule
  /** A CSS path to the element, anchored on the nearest data-testid or id. */
  selector: string
  /** For pairwise findings: the other element. */
  other?: string
  /** off-scale: which property (padding-left, font-size, ...). */
  prop?: string
  value?: string
  detail: string
  box: { x: number; y: number; w: number; h: number }
}

export interface ConsistencyAllow {
  rule: ConsistencyRule
  /** Matched with closest(): the element or anything inside it, unless `exact`. */
  selector: string
  /** Only the matched element itself: an exception about a container's own box (its top padding under the title bar)
   * must not cover everything inside it. */
  exact?: boolean
  /** off-scale only: limit the entry to these properties. */
  props?: string[]
}

export interface ConsistencyScale {
  space: number[]
  font: number[]
  /** font size -> its line height */
  leading: Record<string, number>
  radius: number[]
  control: number[]
  icon: number[]
}

export interface ConsistencyResult {
  findings: ConsistencyFinding[]
  allowed: number
  /** The distinct values in use on this screen (Space and Craft metrics). */
  distinct: { space: number[]; radius: number[]; font: number[]; control: number[] }
}

export function auditConsistency(opts: { allow: ConsistencyAllow[]; scale: ConsistencyScale }): ConsistencyResult {
  const { scale } = opts
  const W = innerWidth
  const H = innerHeight
  const findings: ConsistencyFinding[] = []
  let allowed = 0
  const seen = { space: new Set<number>(), radius: new Set<number>(), font: new Set<number>(), control: new Set<number>() }

  const styleCache = new Map<Element, CSSStyleDeclaration>()
  const css = (el: Element): CSSStyleDeclaration => {
    let s = styleCache.get(el)
    if (!s) styleCache.set(el, (s = getComputedStyle(el)))
    return s
  }
  const px = (v: string): number => (v.endsWith('px') ? parseFloat(v) : NaN)
  const round = (n: number): number => Math.round(n * 10) / 10
  const toBox = (r: DOMRect) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })

  const selectorOf = (el: Element): string => {
    const parts: string[] = []
    for (let e: Element | null = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      const tid = e.getAttribute('data-testid')
      if (tid) {
        parts.unshift(`[data-testid="${tid}"]`)
        break
      }
      if (e.id && !/^(:|_r_|radix-)/.test(e.id) && !/\d{3,}/.test(e.id)) {
        parts.unshift(`#${CSS.escape(e.id)}`)
        break
      }
      let p = e.tagName.toLowerCase()
      const cls = Array.from(e.classList).slice(0, 2)
      if (cls.length) p += '.' + cls.map((c) => CSS.escape(c)).join('.')
      parts.unshift(p)
    }
    return parts.join(' > ')
  }

  const isAllowed = (rule: ConsistencyRule, el: Element, prop?: string, other?: Element): boolean =>
    opts.allow.some((a) => {
      if (a.rule !== rule) return false
      if (a.props && prop && !a.props.includes(prop)) return false
      try {
        const hit = (e: Element) => (a.exact ? e.matches(a.selector) : !!e.closest(a.selector))
        return hit(el) || (!!other && hit(other))
      } catch {
        return false
      }
    })
  const report = (f: ConsistencyFinding, el: Element, other?: Element): void => {
    if (isAllowed(f.rule, el, f.prop, other)) {
      allowed++
      return
    }
    findings.push(f)
  }

  // ---- what is on screen -------------------------------------------------------------------------------
  const visible = (el: Element): boolean => {
    const s = css(el)
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false
    if (parseFloat(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    if (r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) return false
    if (el.classList.contains('sr-only')) return false
    return true
  }
  const all: Element[] = []
  const walk = (el: Element): void => {
    for (const c of Array.from(el.children)) {
      const s = css(c)
      if (s.display === 'none') continue
      // a hidden ancestor hides its subtree, opacity 0 too (a closed popover)
      if (s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue
      if (s.display !== 'contents' && visible(c)) all.push(c)
      walk(c)
    }
  }
  walk(document.body)
  const onPage = new Set(all)

  const onScale = (v: number, list: number[], tol = 0.25): boolean => list.some((s) => Math.abs(Math.abs(v) - s) <= tol)
  const isControl = (el: Element): boolean =>
    el.matches('button, input:not([type="checkbox"], [type="radio"], [type="range"], [type="file"], [type="hidden"]), select, textarea, a.btn, [role="button"], [role="tab"], .segmented')
  const isIcon = (el: Element): boolean => el.tagName.toLowerCase() === 'svg' && (el.classList.contains('icon') || !!el.closest('button'))
  const hasOwnText = (el: Element): boolean => Array.from(el.childNodes).some((n) => n.nodeType === 3 && /\S/.test(n.textContent ?? ''))
  const painted = (el: Element): boolean => {
    const s = css(el)
    const bg = s.backgroundColor
    const hasBg = !!bg && bg !== 'transparent' && !/rgba\(\d+, \d+, \d+, 0\)/.test(bg)
    // a shadow drawn in a see-through colour (a tab's resting underline) paints nothing
    const shadow = s.boxShadow !== 'none' && s.boxShadow !== '' && !/^(\s*rgba\(\d+, \d+, \d+, 0\)[^,]*,?)+$/.test(s.boxShadow)
    return hasBg || shadow || parseFloat(s.borderTopWidth) > 0 || s.backgroundImage !== 'none'
  }
  const radiusOf = (el: Element): number => px(css(el).borderTopLeftRadius)
  // the layout box: a rotating spinner or a turned chevron has a wider bounding box than the room it takes
  const boxOf = (el: Element): DOMRect => {
    const r = el.getBoundingClientRect()
    if (css(el).transform === 'none' || !(el instanceof HTMLElement)) return r
    const w = el.offsetWidth
    const h = el.offsetHeight
    return new DOMRect(r.left + r.width / 2 - w / 2, r.top + r.height / 2 - h / 2, w, h)
  }

  // ---- off-scale --------------------------------------------------------------------------------------
  for (const el of all) {
    const s = css(el)
    const r = el.getBoundingClientRect()
    const flag = (prop: string, value: number, list: number[], what: string) => {
      if (Number.isNaN(value) || value === 0) return
      if (onScale(value, list)) return
      report({ rule: 'off-scale', selector: selectorOf(el), prop, value: `${round(value)}px`, detail: `${what} ${round(value)}px is not on the scale (${list.join(', ')})`, box: toBox(r) }, el)
    }
    for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
      const p = px(s[`padding${side}`])
      seen.space.add(round(p))
      flag(`padding-${side.toLowerCase()}`, p, scale.space, 'padding')
      const m = px(s[`margin${side}`])
      // a margin of auto resolves to its used length: over 64 px, or equal on both sides of a centred block, it is one
      const pair = side === 'Left' || side === 'Right' ? [px(s.marginLeft), px(s.marginRight)] : [px(s.marginTop), px(s.marginBottom)]
      const centred = pair[0] === pair[1] && pair[0] > 24
      if (!(Math.abs(m) > 64 || centred)) {
        seen.space.add(round(Math.abs(m)))
        flag(`margin-${side.toLowerCase()}`, m, scale.space, 'margin')
      }
    }
    if (/flex|grid/.test(s.display)) {
      for (const g of ['rowGap', 'columnGap'] as const) {
        const v = px(s[g])
        if (!Number.isNaN(v)) seen.space.add(round(v))
        flag(g === 'rowGap' ? 'row-gap' : 'column-gap', v, scale.space, 'gap')
      }
    }
    if (hasOwnText(el) || el.matches('input:not([type="checkbox"], [type="radio"], [type="range"]), textarea, select')) {
      const fs = px(s.fontSize)
      seen.font.add(round(fs))
      flag('font-size', fs, scale.font, 'font size')
      const lh = px(s.lineHeight)
      // the leading steps are the type tokens' own (styles.css --lh-*); a size may take a looser step than its pair
      // (a line of word chips needs the room), never a value between steps such as 1.385 times 12
      const steps = [...new Set(Object.values(scale.leading))].sort((a, b) => a - b)
      // a single-line control centres its text by its height, so its line height carries no rhythm
      const oneLine = isControl(el) && r.height <= 44
      if (!oneLine && !Number.isNaN(lh) && !onScale(lh, steps, 0.5)) {
        report({ rule: 'off-scale', selector: selectorOf(el), prop: 'line-height', value: `${round(lh)}px`, detail: `line height ${round(lh)}px (${round(fs)}px type) is not a leading step (${steps.join(', ')})`, box: toBox(r) }, el)
      }
    }
    const rad = radiusOf(el)
    if (!Number.isNaN(rad) && rad > 0 && painted(el)) {
      // a pill (999px, 50%) is "fully round": its used radius is half the short side or more
      const pill = rad >= Math.min(r.width, r.height) / 2 - 0.5
      if (!pill) {
        seen.radius.add(round(rad))
        flag('border-radius', rad, scale.radius, 'corner radius')
      } else seen.radius.add(999)
    }
    // a control taller than the tallest step holds two lines (a share destination, the account row): a row, not a button
    if (isControl(el) && !el.matches('textarea') && r.height <= 44.5) {
      seen.control.add(round(r.height))
      if (!onScale(r.height, scale.control, 0.5)) {
        report({ rule: 'off-scale', selector: selectorOf(el), prop: 'control-height', value: `${round(r.height)}px`, detail: `control ${round(r.height)}px tall; controls are ${scale.control.join(', ')} px`, box: toBox(r) }, el)
      }
    }
    if (isIcon(el)) {
      const size = Math.max(r.width, r.height)
      if (!onScale(size, scale.icon, 0.5)) {
        report({ rule: 'off-scale', selector: selectorOf(el), prop: 'icon-size', value: `${round(size)}px`, detail: `icon ${round(size)}px; icons are ${scale.icon.join(', ')} px`, box: toBox(r) }, el)
      }
    }
  }

  // ---- rows: control heights, and gaps ------------------------------------------------------------------
  // an empty element that paints nothing (a flex spacer) is space between items, not an item
  const spacer = (c: Element): boolean => !c.children.length && !/\S/.test(c.textContent ?? '') && !painted(c) && !isControl(c) && !c.matches('img, video, canvas, svg')
  const kids = (el: Element): Element[] =>
    Array.from(el.children)
      .flatMap((c) => (css(c).display === 'contents' ? Array.from(c.children) : [c]))
      .filter((c) => onPage.has(c) && css(c).position !== 'absolute' && css(c).position !== 'fixed' && !spacer(c))

  for (const el of all) {
    const s = css(el)
    if (!/flex|grid/.test(s.display)) continue
    const ch = kids(el)
    if (ch.length < 2) continue
    const boxes = ch.map(boxOf)
    // a grid lays its children out as a row when they sit side by side: none overlaps another horizontally
    const sideBySide = () => {
      const byX = [...boxes].sort((a, b) => a.left - b.left)
      return byX.every((b, i) => i === 0 || b.left >= byX[i - 1].right - 1)
    }
    const isRow = s.display.includes('flex') ? !s.flexDirection.startsWith('column') : sideBySide()
    const wraps = s.flexWrap === 'wrap'

    // controls side by side in this row: one height (a control nested one level down counts, so a group of buttons
    // in a wrapper still lines up with the button beside it)
    if (isRow) {
      const controls: Element[] = []
      for (const c of ch) {
        if (isControl(c)) controls.push(c)
        else {
          const inner = kids(c).filter(isControl)
          // a painted track of controls (a segmented switch) stands beside its neighbours at the track's height
          if (inner.length && kids(c).length === inner.length) controls.push(...(painted(c) ? [c] : inner))
        }
      }
      // a text area grows with what is typed; its height is its content's, not a control height
      const visibleControls = controls.filter((c) => boxOf(c).height <= 64 && !c.matches('textarea'))
      if (visibleControls.length >= 2) {
        const hs = visibleControls.map((c) => round(boxOf(c).height))
        const distinct = [...new Set(hs)]
        if (distinct.length > 1 && Math.max(...hs) - Math.min(...hs) >= 1) {
          report({ rule: 'row-heights', selector: selectorOf(el), detail: `controls in one row are ${hs.join(', ')} px tall`, box: toBox(el.getBoundingClientRect()) }, el)
        }
      }
    }

    // gaps between consecutive children, along the row or the column
    if (ch.length >= 3 && !wraps) {
      const sorted = [...boxes].sort((a, b) => (isRow ? a.left - b.left : a.top - b.top))
      const gaps: number[] = []
      for (let i = 1; i < sorted.length; i++) gaps.push(round(isRow ? sorted[i].left - sorted[i - 1].right : sorted[i].top - sorted[i - 1].bottom))
      if (gaps.every((g) => g >= 0)) {
        const distinct = [...new Set(gaps.map((g) => Math.round(g)))].sort((a, b) => a - b)
        // one gap everywhere, or groups within groups: each larger gap at least twice the one below it (4, 8, then a
        // spacer is a deliberate grouping; 10 beside 14 is a near-miss)
        const grouped = distinct.every((g, i) => i === 0 || g >= 2 * Math.max(distinct[i - 1], 4))
        const spaced = s.justifyContent.includes('space-')
        if (distinct.length > 1 && !grouped && !spaced && distinct[distinct.length - 1] - distinct[0] > 2) {
          report({ rule: 'sibling-gaps', selector: selectorOf(el), detail: `gaps between its ${isRow ? 'items' : 'rows'} are ${gaps.join(', ')} px`, box: toBox(el.getBoundingClientRect()) }, el)
        }
      }
    }

    // a column whose children are narrower than it: they share an edge or a centre. Only a true column, each child
    // below the one before; a grid of two or more columns (Pace's 2 x 2 version buttons) has an edge per column.
    const oneColumn = () => {
      const byY = [...boxes].sort((a, b) => a.top - b.top)
      return byY.every((b, i) => i === 0 || b.top >= byY[i - 1].bottom - 1)
    }
    if (!isRow && ch.length >= 2 && oneColumn()) {
      const pr = el.getBoundingClientRect()
      const narrow = boxes.filter((b) => b.width < pr.width - 2)
      if (narrow.length >= 2) {
        const lefts = boxes.map((b) => b.left)
        const rights = boxes.map((b) => b.right)
        const centres = boxes.map((b) => b.left + b.width / 2)
        const spread = (v: number[]) => Math.max(...v) - Math.min(...v)
        if (spread(lefts) > 1 && spread(rights) > 1 && spread(centres) > 1) {
          report({ rule: 'stack-axis', selector: selectorOf(el), detail: `its children share no edge or centre: left ${lefts.map(round).join('/')}, right ${rights.map(round).join('/')}, centre ${centres.map(round).join('/')}`, box: toBox(pr) }, el)
        }
      }
    }
  }

  // ---- edge near-misses between stacked boxes -------------------------------------------------------------
  // Two kinds of object line up: boxes (painted surfaces, media, icon buttons) by both edges, and text (text blocks,
  // text buttons, links) by its content edge (ragged right is not an edge). A box and a text block are not compared:
  // a ghost row's wash rightly sticks out past the text above it.
  type Obj = { el: Element; r: DOMRect; kind: 'box' | 'text'; left: number; right: number | null; surface: Element | null }
  // things line up within one surface: the canvas, a popover, the note box. Text in a box is not meant to start where
  // text outside it does.
  const surfaceOf = (el: Element): Element | null => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (painted(p)) return p
    return null
  }
  const contentLeft = (el: Element, r: DOMRect): number => r.left + (parseFloat(css(el).borderLeftWidth) || 0) + (parseFloat(css(el).paddingLeft) || 0)
  const centredBy = (child: Element, p: Element): boolean => {
    const ps = css(p)
    const flex = /flex/.test(ps.display)
    const column = flex && ps.flexDirection.startsWith('column')
    return (column && (/center/.test(ps.alignItems) || /center/.test(css(child).alignSelf))) || (flex && !column && /center/.test(ps.justifyContent)) ||
      (/grid/.test(ps.display) && (/center/.test(ps.justifyItems) || /center/.test(css(child).justifySelf)))
  }
  // text centred on its own, or inside a box its parent centres (a caption under a centred picture): it starts wherever
  // the centring puts it, so its left edge is no one's stack partner
  const centred = (el: Element): boolean => {
    if (/center/.test(css(el).textAlign) || (/flex|grid/.test(css(el).display) && /center/.test(css(el).justifyContent))) return true
    let node: Element = el
    for (let i = 0; i < 3 && node.parentElement && node.parentElement !== document.body; i++, node = node.parentElement) if (centredBy(node, node.parentElement)) return true
    return false
  }
  const objs: Obj[] = []
  for (const el of all) {
    const r = boxOf(el)
    if (r.width < 24 || r.height < 8) continue
    // overlays and decorations (a switch's moving thumb, a badge) are placed on purpose, not in the flow
    if (/absolute|fixed/.test(css(el).position) && !el.matches('[role="menu"], [role="dialog"], .pop, .modal')) continue
    const surface = surfaceOf(el)
    const text = hasOwnText(el) || (isControl(el) && /\S/.test(el.textContent ?? ''))
    if (painted(el) || el.matches('video, img, canvas') || (isControl(el) && !text)) objs.push({ el, r, kind: 'box', left: r.left, right: r.right, surface })
    // an inline-block token in running text (a heard word, a pause) starts wherever the line wraps it
    else if (text && !/^inline/.test(css(el).display) && !centred(el)) objs.push({ el, r, kind: 'text', left: contentLeft(el, r), right: null, surface })
  }
  const reported = new Set<string>()
  for (const a of objs) {
    for (const b of objs) {
      if (a === b || a.kind !== b.kind || a.surface !== b.surface) continue
      if (b.r.top < a.r.bottom - 1) continue
      if (b.r.top - a.r.bottom > 48) continue
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const overlap = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      if (overlap < 0.6 * Math.min(a.r.width, b.r.width)) continue
      // a small box under a much wider one (one frame of a strip under a button) is not its stack partner
      if (a.kind === 'box' && Math.min(a.r.width, b.r.width) < 0.5 * Math.max(a.r.width, b.r.width)) continue
      const dl = Math.abs(a.left - b.left)
      const dr = a.right !== null && b.right !== null ? Math.abs(a.right - b.right) : null
      const dc = a.kind === 'box' ? Math.abs(a.r.left + a.r.width / 2 - (b.r.left + b.r.width / 2)) : Infinity
      if (dc < 1 || dl < 1 || (dr !== null && dr < 1)) continue
      const near = (d: number | null) => d !== null && d >= 1 && d <= 12
      if (!(near(dl) || near(dr))) continue
      const key = [selectorOf(a.el), selectorOf(b.el)].join('|')
      if (reported.has(key)) continue
      reported.add(key)
      const where = [near(dl) ? `${round(dl)} px on the left` : '', near(dr) ? `${round(dr!)} px on the right` : ''].filter(Boolean).join(' and ')
      report({ rule: 'edge-near-miss', selector: selectorOf(a.el), other: selectorOf(b.el), detail: `stacked ${a.kind === 'box' ? 'boxes' : 'text blocks'} miss by ${where}`, box: toBox(a.r) }, a.el, b.el)
    }
  }

  // ---- concentric corners ---------------------------------------------------------------------------------
  for (const el of all) {
    const rad = radiusOf(el)
    if (Number.isNaN(rad) || rad <= 0 || !painted(el)) continue
    const r = el.getBoundingClientRect()
    if (rad >= Math.min(r.width, r.height) / 2 - 0.5) continue
    let p = el.parentElement
    while (p && p !== document.body && !(painted(p) && radiusOf(p) > 0)) p = p.parentElement
    if (!p || p === document.body) continue
    const pr = p.getBoundingClientRect()
    const R = radiusOf(p)
    if (R >= Math.min(pr.width, pr.height) / 2 - 0.5) continue
    // only a fill that sits in a corner of its surface: the inset is its distance to both edges at one corner
    const corners = [
      [r.left - pr.left, r.top - pr.top],
      [pr.right - r.right, r.top - pr.top],
      [r.left - pr.left, pr.bottom - r.bottom],
      [pr.right - r.right, pr.bottom - r.bottom]
    ]
    const inCorner = corners.filter(([dx, dy]) => dx >= 0 && dy >= 0 && Math.abs(dx - dy) <= 1 && dx < R)
    if (!inCorner.length) continue
    const d = inCorner[0][0]
    const want = Math.max(0, R - d)
    if (Math.abs(rad - want) > 1) {
      report({ rule: 'concentric', selector: selectorOf(el), other: selectorOf(p), detail: `radius ${round(rad)}px at ${round(d)}px inside a ${round(R)}px surface; concentric is ${round(want)}px`, box: toBox(r) }, el, p)
    }
  }

  const sorted = (s: Set<number>) => [...s].filter((v) => v > 0).sort((a, b) => a - b)
  return { findings, allowed, distinct: { space: sorted(seen.space), radius: sorted(seen.radius), font: sorted(seen.font), control: sorted(seen.control) } }
}
