// The layout detectors. `detectLayout` runs inside the page (page.evaluate serialises it), so it must stay
// self-contained: no imports and no references to anything outside its own body.

export type Detector =
  | 'text-overflow'
  | 'clipped'
  | 'horizontal-scroll'
  | 'nested-scroll'
  | 'overlap'
  | 'text-collision'
  | 'small-target'
  | 'popover-placement'
  | 'imbalance'
  | 'button-shape'

export type Severity = 'P1' | 'P2' | 'P3'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface RawFinding {
  detector: Detector
  severity: Severity
  /** A CSS path to the offending element, anchored on the nearest data-testid or id. */
  selector: string
  /** The other element, for pairwise findings (overlap, collision, nested scroll, popover and its trigger). */
  other?: string
  /** What it says: its own text, or its accessible name. */
  text: string
  otherText?: string
  detail: string
  boxes: Box[]
  /** Class names and test ids on the element and its ancestors, for finding its source file. */
  hints: string[]
}

export interface AllowEntry {
  detector: Detector
  selector: string
  /** For pairwise findings: the other element must match this too. */
  with?: string
}

export interface DetectOptions {
  allow: AllowEntry[]
  /** The screen's focal object and the column it should sit centred in (imbalance). */
  focal?: string
  column?: string
}

export function detectLayout(opts: DetectOptions): { findings: RawFinding[]; allowed: number } {
  // Hit testing stands in for painting order: with every box hit-testable, elementsFromPoint lists what is drawn at
  // a point, top first, including layers that let clicks through.
  const force = document.createElement('style')
  force.textContent = '*, *::before, *::after { pointer-events: auto !important }'
  document.head.appendChild(force)
  try {
    return run()
  } finally {
    force.remove()
  }

  function run(): { findings: RawFinding[]; allowed: number } {
  const W = innerWidth
  const H = innerHeight
  const TOL = 1.5
  const findings: RawFinding[] = []
  let allowed = 0

  type R = { left: number; top: number; right: number; bottom: number }
  const toBox = (r: R): Box => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.right - r.left), h: Math.round(r.bottom - r.top) })
  const area = (r: R): number => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top)
  const intersect = (a: R, b: R): R => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) })
  const empty = (r: R): boolean => r.right - r.left <= 0.5 || r.bottom - r.top <= 0.5
  const styleCache = new Map<Element, CSSStyleDeclaration>()
  const css = (el: Element): CSSStyleDeclaration => {
    let s = styleCache.get(el)
    if (!s) styleCache.set(el, (s = getComputedStyle(el)))
    return s
  }

  // ---- identity ------------------------------------------------------------------------------------
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
      const cls = Array.from(e.classList).filter((c) => !/^(on|open|active|busy|leave|enter|is-|has-)$/.test(c)).slice(0, 2)
      if (cls.length) p += '.' + cls.map((c) => CSS.escape(c)).join('.')
      parts.unshift(p)
    }
    return parts.join(' > ')
  }
  const nameOf = (el: Element): string => {
    const label = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? (el as HTMLInputElement).placeholder ?? ''
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    return (text || label).slice(0, 80)
  }
  const hintsOf = (el: Element): string[] => {
    const out: string[] = []
    for (let e: Element | null = el; e && e !== document.body && out.length < 12; e = e.parentElement) {
      const tid = e.getAttribute('data-testid')
      if (tid) out.push(`testid:${tid}`)
      for (const c of Array.from(e.classList)) out.push(`class:${c}`)
    }
    return out
  }

  // ---- allowlist -----------------------------------------------------------------------------------
  const matches = (el: Element | null | undefined, selector: string): boolean => {
    if (!el) return false
    try {
      return !!el.closest(selector)
    } catch {
      return false
    }
  }
  const isAllowed = (detector: Detector, el: Element, other?: Element): boolean =>
    opts.allow.some(
      (a) =>
        a.detector === detector &&
        ((matches(el, a.selector) && (!a.with || matches(other, a.with))) || (!!other && matches(other, a.selector) && (!a.with || matches(el, a.with))))
    )
  const report = (f: Omit<RawFinding, 'selector' | 'text' | 'hints' | 'other' | 'otherText'>, el: Element, other?: Element): void => {
    if (isAllowed(f.detector, el, other)) {
      allowed++
      return
    }
    findings.push({
      ...f,
      selector: selectorOf(el),
      text: nameOf(el),
      hints: hintsOf(el),
      ...(other ? { other: selectorOf(other), otherText: nameOf(other) } : {})
    })
  }

  // ---- visibility ----------------------------------------------------------------------------------
  // The top open modal: everything outside it is behind its backdrop and is audited in another state.
  const modals = Array.from(document.querySelectorAll('[aria-modal="true"]')).filter((m) => {
    const r = m.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && css(m).visibility !== 'hidden'
  })
  // a dialog counts as over the page only when its backdrop covers the window; one laid out inside a column (a
  // transformed ancestor captures its fixed backdrop) is part of that column, and is reported below
  const backdropOf = (m: Element): Element => {
    for (let e: Element | null = m; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).position === 'fixed') return e
    return m
  }
  const coversWindow = (m: Element): boolean => {
    const r = backdropOf(m).getBoundingClientRect()
    return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9
  }
  const trapped = modals.filter((m) => !coversWindow(m))
  const modal = modals.filter(coversWindow).pop() ?? null
  const overDialogs = (el: Element): boolean => !!el.closest('[data-over-dialogs]')
  // the boxes the dialog sits in still lay it out and can clip or scroll it
  const inScope = (el: Element): boolean => !modal || modal.contains(el) || el.contains(modal) || overDialogs(el)

  const hiddenCache = new Map<Element, boolean>()
  const hidden = (el: Element): boolean => {
    const known = hiddenCache.get(el)
    if (known !== undefined) return known
    const s = css(el)
    let h =
      s.display === 'none' ||
      s.visibility === 'hidden' ||
      s.visibility === 'collapse' ||
      Number(s.opacity) < 0.05 ||
      s.contentVisibility === 'hidden' ||
      // visually-hidden text for screen readers
      (s.position === 'absolute' && /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(s.clip)) ||
      /inset\(50%\)/.test(s.clipPath)
    if (!h && el.parentElement && el.parentElement !== document.documentElement) h = hidden(el.parentElement)
    hiddenCache.set(el, h)
    return h
  }

  const isScroller = (s: CSSStyleDeclaration, axis: 'x' | 'y'): boolean => /auto|scroll/.test(axis === 'x' ? s.overflowX : s.overflowY)
  const clipsAxis = (s: CSSStyleDeclaration, axis: 'x' | 'y'): boolean => (axis === 'x' ? s.overflowX : s.overflowY) !== 'visible'
  const createsContainingBlock = (s: CSSStyleDeclaration): boolean =>
    s.position !== 'static' || s.transform !== 'none' || s.filter !== 'none' || /paint|layout|strict|content/.test(s.contain) || s.willChange.includes('transform')
  const fixedContainer = (s: CSSStyleDeclaration): boolean =>
    s.transform !== 'none' || s.filter !== 'none' || /paint|layout|strict|content/.test(s.contain) || s.willChange.includes('transform')

  /**
   * The ancestors whose overflow can clip `el`: an absolutely positioned box skips static ancestors up to its
   * containing block, and a fixed one skips everything up to a transformed ancestor or the window.
   */
  const clippingAncestors = (el: Element): Element[] => {
    const out: Element[] = []
    let pos = css(el).position
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = css(a)
      if (pos === 'fixed') {
        if (!fixedContainer(s)) continue
      } else if (pos === 'absolute') {
        if (!createsContainingBlock(s)) continue
      }
      out.push(a)
      pos = s.position === 'static' || s.position === 'relative' || s.position === 'sticky' ? 'static' : s.position
    }
    return out
  }

  const paddingBox = (a: Element): R => {
    const r = a.getBoundingClientRect()
    const s = css(a)
    const bl = parseFloat(s.borderLeftWidth) || 0
    const bt = parseFloat(s.borderTopWidth) || 0
    return { left: r.left + bl, top: r.top + bt, right: r.left + bl + a.clientWidth, bottom: r.top + bt + a.clientHeight }
  }

  const rootScrolls = (axis: 'x' | 'y'): boolean => {
    const de = document.documentElement
    const s = css(de)
    const b = css(document.body)
    const can = axis === 'y' ? de.scrollHeight > H + 1 : de.scrollWidth > W + 1
    return can && (axis === 'y' ? s.overflowY : s.overflowX) !== 'hidden' && (axis === 'y' ? b.overflowY : b.overflowX) !== 'hidden'
  }

  /** The part of a box that can be seen right now: clipped by every overflow ancestor and the window. */
  const visiblePart = (el: Element, r: R): R => {
    let v = r
    for (const a of clippingAncestors(el)) {
      const s = css(a)
      if (!clipsAxis(s, 'x') && !clipsAxis(s, 'y')) continue
      const p = paddingBox(a)
      v = { left: clipsAxis(s, 'x') ? Math.max(v.left, p.left) : v.left, right: clipsAxis(s, 'x') ? Math.min(v.right, p.right) : v.right, top: clipsAxis(s, 'y') ? Math.max(v.top, p.top) : v.top, bottom: clipsAxis(s, 'y') ? Math.min(v.bottom, p.bottom) : v.bottom }
      if (empty(v)) return v
    }
    return intersect(v, { left: 0, top: 0, right: W, bottom: H })
  }

  const alpha = (c: string): number => {
    if (!c || c === 'transparent') return 0
    const m = c.match(/rgba?\(([^)]+)\)/)
    if (!m) return 1
    const parts = m[1].split(/[ ,/]+/).filter(Boolean)
    return parts.length >= 4 ? parseFloat(parts[3]) : 1
  }
  /** Whether a box draws something that hides what is under it (a fill, a picture, a field), not just its children. */
  const paints = (el: Element): boolean => {
    if (/^(IMG|VIDEO|CANVAS|IFRAME|INPUT|TEXTAREA|SELECT|svg)$/i.test(el.tagName)) return true
    const s = css(el)
    return alpha(s.backgroundColor) > 0.3 || s.backgroundImage !== 'none' || (s.backdropFilter ?? 'none') !== 'none'
  }
  /** Whether any of five points of the box shows the element, rather than something opaque drawn over it. */
  const seen = (el: Element, r: R): boolean => {
    const w = r.right - r.left
    const h = r.bottom - r.top
    const pts = [[0.5, 0.5], [0.2, 0.3], [0.8, 0.3], [0.2, 0.7], [0.8, 0.7]]
    for (const [fx, fy] of pts) {
      const x = r.left + w * fx
      const y = r.top + h * fy
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      let shown = true
      for (const top of document.elementsFromPoint(x, y)) {
        if (top === el || el.contains(top) || top.contains(el)) break
        if (top.id === '__layout_audit_overlay' || paints(top)) {
          shown = false
          break
        }
      }
      if (shown) return true
    }
    return false
  }

  /**
   * Whether a box is cut where nothing can scroll it into view: by an overflow-hidden ancestor, or by the window.
   * Inside a scroll area the box can be scrolled to; what matters then is whether the scroll area's own viewport is cut.
   */
  const unreachableCut = (el: Element, r0: R): { by: Element | 'window'; axis: 'x' | 'y'; amount: number } | null => {
    let r = r0
    // text that truncates itself with an ellipsis is drawn no wider than its own box (More reels' hook line)
    const own = css(el)
    if (own.textOverflow === 'ellipsis' && clipsAxis(own, 'x')) {
      const p = paddingBox(el)
      r = { ...r, left: Math.max(r.left, p.left), right: Math.min(r.right, p.right) }
    }
    let reachX = false
    let reachY = false
    for (const a of clippingAncestors(el)) {
      const s = css(a)
      const p = paddingBox(a)
      for (const axis of ['x', 'y'] as const) {
        if (!clipsAxis(s, axis)) continue
        const scrollable = isScroller(s, axis) && (axis === 'x' ? a.scrollWidth > a.clientWidth + 1 : a.scrollHeight > a.clientHeight + 1)
        if (scrollable || isScroller(s, axis)) {
          // inside a scroll area: reachable by scrolling; from here on only the area's own viewport matters
          if (axis === 'x') reachX = true
          else reachY = true
          continue
        }
        if ((axis === 'x' && reachX) || (axis === 'y' && reachY)) continue
        // truncated on purpose with an ellipsis: the text-overflow check asks for its full text instead. What is drawn
        // ends at this box, so an outer clip only cuts what reaches past it (a path in a card was reported cut by the page)
        if (axis === 'x' && s.textOverflow === 'ellipsis') {
          r = { ...r, left: Math.max(r.left, p.left), right: Math.min(r.right, p.right) }
          continue
        }
        const over = axis === 'x' ? Math.max(p.left - r.left, r.right - p.right) : Math.max(p.top - r.top, r.bottom - p.bottom)
        if (over > 2) return { by: a, axis, amount: Math.round(over) }
      }
      if (reachX || reachY) {
        // the scroll area's viewport replaces the box on the axis it scrolls
        r = { left: reachX ? Math.max(p.left, Math.min(r.left, p.right)) : r.left, right: reachX ? Math.min(p.right, Math.max(r.right, p.left)) : r.right, top: reachY ? Math.max(p.top, Math.min(r.top, p.bottom)) : r.top, bottom: reachY ? Math.min(p.bottom, Math.max(r.bottom, p.top)) : r.bottom }
        reachX = false
        reachY = false
      }
    }
    const overX = rootScrolls('x') ? 0 : Math.max(-r.left, r.right - W)
    const overY = rootScrolls('y') ? 0 : Math.max(-r.top, r.bottom - H)
    if (overY > 2) return { by: 'window', axis: 'y', amount: Math.round(overY) }
    if (overX > 2) return { by: 'window', axis: 'x', amount: Math.round(overX) }
    return null
  }

  // ---- collect text runs and controls --------------------------------------------------------------
  interface Run {
    node: Text
    owner: Element
    /** The nearest box that is not inline: runs in the same one share one line of text and space themselves. */
    block: Element
    rects: R[]
    visible: R[]
  }
  const blockCache = new Map<Element, Element>()
  const blockOf = (el: Element): Element => {
    const known = blockCache.get(el)
    if (known) return known
    let found: Element = document.body
    for (let e: Element | null = el; e; e = e.parentElement) {
      const d = css(e).display
      if (d !== 'inline' && d !== 'contents') {
        found = e
        break
      }
    }
    blockCache.set(el, found)
    return found
  }
  const runs: Run[] = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const t = n.data
    const start = t.search(/\S/)
    if (start < 0) continue
    const owner = n.parentElement
    if (!owner || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|TEXTAREA)$/.test(owner.tagName)) continue
    if (!inScope(owner) || hidden(owner)) continue
    const end = t.length - (t.length - t.trimEnd().length)
    const range = document.createRange()
    range.setStart(n, start)
    range.setEnd(n, end)
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0.5 && r.height > 0.5)
      .map((r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }))
    if (!rects.length) continue
    // the text's own box clips it too (a line ending in its ellipsis): clippingAncestors starts above the owner, so
    // without this the hidden rest of the line counted as drawn, over whatever sits beside the box
    const own = css(owner)
    const ownBox = clipsAxis(own, 'x') || clipsAxis(own, 'y') ? paddingBox(owner) : null
    const inOwn = (r: R): R =>
      ownBox
        ? {
            left: clipsAxis(own, 'x') ? Math.max(r.left, ownBox.left) : r.left,
            right: clipsAxis(own, 'x') ? Math.min(r.right, ownBox.right) : r.right,
            top: clipsAxis(own, 'y') ? Math.max(r.top, ownBox.top) : r.top,
            bottom: clipsAxis(own, 'y') ? Math.min(r.bottom, ownBox.bottom) : r.bottom
          }
        : r
    const visible = rects.map((r) => visiblePart(owner, inOwn(r))).filter((r) => !empty(r) && seen(owner, r))
    // drawn under something opaque everywhere it would show: not on screen
    if (!visible.length && rects.some((r) => !empty(visiblePart(owner, r)))) continue
    runs.push({ node: n, owner, block: blockOf(owner), rects, visible })
  }

  const CONTROL =
    'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="menuitemradio"], [role="slider"], [role="option"], [contenteditable="true"]'
  interface Control {
    el: Element
    rect: R
    visible: R
  }
  const controls: Control[] = []
  for (const el of Array.from(document.querySelectorAll(CONTROL))) {
    if (!inScope(el) || hidden(el)) continue
    // a control nested in another control is part of it
    if (el.parentElement?.closest(CONTROL) && !el.matches('input, select, textarea')) continue
    const b = el.getBoundingClientRect()
    if (b.width < 1 || b.height < 1) continue
    const rect = { left: b.left, top: b.top, right: b.right, bottom: b.bottom }
    const visible = visiblePart(el, rect)
    if (empty(visible) || !seen(el, visible)) continue
    controls.push({ el, rect, visible })
  }

  // ---- 1. text-overflow ----------------------------------------------------------------------------
  // Text wider than the box it is laid out in: cut by that box without an ellipsis, or spilling out of it (or out of
  // an ancestor, up to the first one that clips, which the clipped check covers).
  const seenOverflow = new Set<Element>()
  for (const run of runs) {
    if (!run.visible.length) continue
    const box = run.block
    if (seenOverflow.has(box) || box === document.body) continue
    let right = Math.max(...run.rects.map((r) => r.right))
    let left = Math.min(...run.rects.map((r) => r.left))
    const chain = [box, ...clippingAncestors(box)]
    for (const a of chain) {
      if (a === document.body) break
      const s = css(a)
      if (s.display === 'inline' || s.display === 'contents') continue
      const b = a.getBoundingClientRect()
      const spill = Math.max(b.left - left, right - b.right)
      const clipsX = clipsAxis(s, 'x')
      if (spill > TOL) {
        seenOverflow.add(box)
        if (isScroller(s, 'x')) break // horizontal-scroll reports it
        if (clipsX && a !== box) break // cut by an ancestor: the clipped check reports it
        if (clipsX) {
          const ellipsis = s.textOverflow === 'ellipsis' || css(run.owner).textOverflow === 'ellipsis'
          if (ellipsis) {
            // truncated on purpose: its full text must still be somewhere a person can get at (rule 4)
            const full = run.owner.closest('[title], [aria-label]')
            if (!full) report({ detector: 'text-overflow', severity: 'P3', detail: 'truncated with an ellipsis, but no title or accessible name holds the full text', boxes: [toBox(b)] }, box)
          } else {
            report({ detector: 'text-overflow', severity: 'P1', detail: `text is ${Math.round(spill)} px wider than its box and is cut without an ellipsis`, boxes: [toBox(b)] }, box)
          }
          break
        }
        const spillRect = { left: Math.min(left, b.left), top: Math.min(...run.rects.map((r) => r.top)), right: Math.max(right, b.right), bottom: Math.max(...run.rects.map((r) => r.bottom)) }
        report(
          { detector: 'text-overflow', severity: 'P1', detail: `text spills ${Math.round(spill)} px out of ${a === box ? 'its box' : selectorOf(a)}`, boxes: [toBox(b), toBox(spillRect)] },
          box,
          a === box ? undefined : a
        )
        break
      }
      // an absolutely positioned box (a menu, a badge) does not size its parent: spilling past it is placement
      if (/absolute|fixed/.test(s.position)) break
      if (clipsX && a !== box) break
      if (clipsX) {
        // the box clips its own text: what can spill further out is the box itself (a flex child without min-width: 0)
        left = Math.max(left, b.left)
        right = Math.min(right, b.right)
      }
    }
  }

  // ---- 2. clipped ----------------------------------------------------------------------------------
  const clippedSeen = new Set<Element>()
  const clipReport = (el: Element, r: R, what: string, severity: Severity): void => {
    const cut = unreachableCut(el, r)
    if (!cut) return
    const key = cut.by === 'window' ? el : cut.by
    if (clippedSeen.has(el) || (cut.by !== 'window' && clippedSeen.has(key) && what === 'text')) return
    clippedSeen.add(el)
    const by = cut.by === 'window' ? 'the window' : selectorOf(cut.by)
    report(
      { detector: 'clipped', severity, detail: `${what} is cut ${cut.amount} px on ${cut.axis} by ${by}, and no scroll area brings it into view`, boxes: [toBox(r), ...(cut.by === 'window' ? [] : [toBox(paddingBox(cut.by))])] },
      el,
      cut.by === 'window' ? undefined : cut.by
    )
  }
  for (const c of controls) clipReport(c.el, c.rect, 'a control', 'P1')
  for (const run of runs) {
    if (!run.visible.length) continue // wholly out of sight: a scroll area or a collapsed panel hides it
    const r = { left: Math.min(...run.rects.map((x) => x.left)), top: Math.min(...run.rects.map((x) => x.top)), right: Math.max(...run.rects.map((x) => x.right)), bottom: Math.max(...run.rects.map((x) => x.bottom)) }
    if (run.owner.closest(CONTROL) && clippedSeen.has(run.owner.closest(CONTROL)!)) continue
    clipReport(run.owner, r, 'text', 'P1')
  }

  // ---- 3. horizontal-scroll and 4. nested-scroll ---------------------------------------------------
  const scrollersY: Element[] = []
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (!inScope(el)) continue
    const s = css(el)
    if (s.display === 'none' || s.display === 'inline') continue
    const ox = isScroller(s, 'x')
    const oy = isScroller(s, 'y')
    if (!ox && !oy) continue
    if (hidden(el)) continue
    const b = el.getBoundingClientRect()
    if (b.width < 2 || b.height < 2) continue
    if (ox && el.scrollWidth > el.clientWidth + 1) {
      report({ detector: 'horizontal-scroll', severity: 'P1', detail: `scrolls sideways: ${el.scrollWidth} px of content in ${el.clientWidth} px`, boxes: [toBox(b)] }, el)
    }
    if (oy && el.scrollHeight > el.clientHeight + 1) scrollersY.push(el)
  }
  if (document.documentElement.scrollWidth > W + 1 && css(document.documentElement).overflowX !== 'hidden' && css(document.body).overflowX !== 'hidden') {
    report({ detector: 'horizontal-scroll', severity: 'P1', detail: `the window scrolls sideways: ${document.documentElement.scrollWidth} px in ${W} px`, boxes: [{ x: 0, y: 0, w: W, h: H }] }, document.body)
  }
  for (const inner of scrollersY) {
    const outer = scrollersY.find((o) => o !== inner && o.contains(inner))
    if (!outer) continue
    report(
      { detector: 'nested-scroll', severity: 'P1', detail: `scrolls up and down inside ${selectorOf(outer)}, which scrolls too`, boxes: [toBox(inner.getBoundingClientRect()), toBox(outer.getBoundingClientRect())] },
      inner,
      outer
    )
  }

  // two scroll areas stacked in one column: each scrolls on its own, so the column has two scroll bars (rule 3)
  for (let i = 0; i < scrollersY.length; i++) {
    for (let j = i + 1; j < scrollersY.length; j++) {
      const a = scrollersY[i]
      const b = scrollersY[j]
      if (a.contains(b) || b.contains(a)) continue
      const ra = a.getBoundingClientRect()
      const rb = b.getBoundingClientRect()
      const xOverlap = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
      if (xOverlap < 0.6 * Math.min(ra.width, rb.width)) continue
      const yOverlap = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
      if (yOverlap > 4) continue
      // one column: their nearest shared box is about as wide as they are (not the page holding two columns)
      let shared: Element | null = a.parentElement
      while (shared && !shared.contains(b)) shared = shared.parentElement
      if (!shared || shared === document.body || shared === document.documentElement) continue
      if (shared.getBoundingClientRect().width > 1.5 * Math.max(ra.width, rb.width)) continue
      const [upper, lower] = ra.top <= rb.top ? [a, b] : [b, a]
      report(
        { detector: 'nested-scroll', severity: 'P1', detail: `two scroll areas stacked in one column: this one and ${selectorOf(lower)} under it each scroll on their own`, boxes: [toBox(upper.getBoundingClientRect()), toBox(lower.getBoundingClientRect())] },
        upper,
        lower
      )
    }
  }

  // ---- 5. overlap and 6. text-collision ------------------------------------------------------------
  const related = (a: Element, b: Element): boolean => a === b || a.contains(b) || b.contains(a)
  const controlOf = (el: Element): Element | null => el.closest(CONTROL)
  // the box a person reads as one thing: a control, else the text's own block
  const unitOf = (run: Run): Element => controlOf(run.owner) ?? run.block
  const pairSeen = new Set<string>()
  const pairKey = (d: string, a: Element, b: Element): string => {
    const sa = selectorOf(a)
    const sb = selectorOf(b)
    return `${d}|${sa < sb ? sa : sb}|${sa < sb ? sb : sa}`
  }
  const lineOverlap = (a: R, b: R): number => Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) / Math.max(1, Math.min(a.bottom - a.top, b.bottom - b.top))
  const topAt = (x: number, y: number): Element | null => {
    if (x < 0 || y < 0 || x >= W || y >= H) return null
    return document.elementFromPoint(x, y)
  }

  interface Item {
    el: Element
    unit: Element
    r: R
    kind: 'text' | 'control'
  }
  const items: Item[] = []
  for (const run of runs) for (const r of run.visible) items.push({ el: run.owner, unit: unitOf(run), r, kind: 'text' })
  for (const c of controls) items.push({ el: c.el, unit: c.el, r: c.visible, kind: 'control' })

  // open popovers, offers and toasts: what they cover is judged on its own below, not as a pair of overlapping items
  const POPOVER = '[role="menu"], [role="listbox"], [role="tooltip"], [role="dialog"]:not([aria-modal="true"]), [data-testid$="popover"], [data-testid="toast"]'
  const popovers = Array.from(document.querySelectorAll(POPOVER)).filter((p) => !hidden(p) && p.getAttribute('aria-hidden') !== 'true' && inScope(p) && !empty(visiblePart(p, p.getBoundingClientRect())))
  const popOf = (el: Element): Element | null => popovers.find((p) => p.contains(el)) ?? null
  const stickyOf = (el: Element): Element | null => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) if (css(e).position === 'sticky') return e
    return null
  }
  const voiced = new Set<Element>()
  for (const run of runs) if (run.visible.length) for (const c of controls) if (c.el.contains(run.owner)) voiced.add(c.el)
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      // both checks below need the boxes to share a line and sit within 3 px of each other
      if (b.r.left > a.r.right + 3 || a.r.left > b.r.right + 3 || b.r.top >= a.r.bottom || a.r.top >= b.r.bottom) continue
      if (related(a.el, b.el)) continue
      // collision: two runs from separate boxes on one line, closer than 3 px
      if (a.kind === 'text' && b.kind === 'text' && lineOverlap(a.r, b.r) >= 0.5) {
        const gap = a.r.left < b.r.left ? b.r.left - a.r.right : a.r.left - b.r.right
        const blockA = blockOf(a.el)
        const blockB = blockOf(b.el)
        // separate boxes need 3 px; inside one line of text, runs from two elements need at least a space between
        // them, except before punctuation ("link." is fine, "0:09Hold" is not)
        const [l, rr] = a.r.left < b.r.left ? [a, b] : [b, a]
        const punct = /^[.,;:!?)\]}’”'"…%]/.test(nameOf(rr.el)) || /[(\[{‘“'"/]$/.test(nameOf(l.el))
        const limit = blockA !== blockB ? 3 : punct ? -Infinity : 1.5
        if (gap < limit && gap > -3) {
          const k = pairKey('text-collision', a.unit, b.unit)
          if (!pairSeen.has(k)) {
            pairSeen.add(k)
            const [first, second] = a.r.left < b.r.left ? [a, b] : [b, a]
            report(
              { detector: 'text-collision', severity: 'P1', detail: `"${nameOf(first.el).slice(-24)}" and "${nameOf(second.el).slice(0, 24)}" sit ${gap.toFixed(1)} px apart on one line`, boxes: [toBox(first.r), toBox(second.r)] },
              first.el,
              second.el
            )
          }
          continue
        }
      }
      if (related(a.unit, b.unit)) continue
      if (popOf(a.el) !== popOf(b.el)) continue
      const x = intersect(a.r, b.r)
      if (x.right - x.left < 3 || x.bottom - x.top < 3) continue
      // a label stacked on its own field, a field's text inside it: same unit already skipped; a control's label
      // element (<label for>) is part of the control
      if ((a.el as HTMLElement).closest('label')?.contains(b.el) || (b.el as HTMLElement).closest('label')?.contains(a.el)) continue
      // a see-through hit area with no text of its own (press and hold on the phone) hides nothing under it
      const ghost = (it: Item): boolean => it.kind === 'control' && !paints(it.el) && !voiced.has(it.el)
      if ((ghost(a) && b.kind === 'text') || (ghost(b) && a.kind === 'text')) continue
      const k = pairKey('overlap', a.unit, b.unit)
      if (pairSeen.has(k)) continue
      pairSeen.add(k)
      const cx = (x.left + x.right) / 2
      const cy = (x.top + x.bottom) / 2
      const top = topAt(cx, cy)
      const onTop = top && (a.el.contains(top) || a.unit.contains(top)) ? a : top && (b.el.contains(top) || b.unit.contains(top)) ? b : null
      const under = onTop === a ? b : a
      // content scrolled under a sticky header is how scrolling looks; a heading left under it after a jump is not
      const sticky = onTop ? stickyOf(onTop.el) : null
      if (sticky && !sticky.contains(under.el) && !under.el.closest('h1, h2, h3, h4, h5, h6')) continue
      report(
        {
          detector: 'overlap',
          severity: 'P1',
          detail: `${a.kind} "${nameOf(a.el).slice(0, 30)}" and ${b.kind} "${nameOf(b.el).slice(0, 30)}" overlap by ${Math.round(x.right - x.left)}×${Math.round(x.bottom - x.top)} px${onTop ? `; "${nameOf(onTop.el).slice(0, 30)}" is drawn over the other` : ''}`,
          boxes: [toBox(a.r), toBox(b.r)]
        },
        (onTop ?? a).el,
        under.el
      )
    }
  }

  /** What opened a popover: what controls it, what it describes, a control beside it in a shared wrapper, or an open button. */
  const triggerOf = (p: Element): Element | null => {
    const id = p.id
    let trigger: Element | null = (id && document.querySelector(`[aria-controls="${CSS.escape(id)}"]`)) || null
    if (!trigger) trigger = Array.from(document.querySelectorAll('[aria-describedby]')).find((e) => (e.getAttribute('aria-describedby') ?? '').split(/\s+/).some((d) => d && p.querySelector(`#${CSS.escape(d)}`))) ?? null
    for (let up: Element | null = p.parentElement, n = 0; !trigger && up && up !== document.body && n < 3; up = up.parentElement, n++) {
      const near = Array.from(up.querySelectorAll(CONTROL)).filter((c) => !p.contains(c) && !hidden(c))
      if (near.length > 3) break
      trigger = near[0] ?? null
    }
    if (!trigger) trigger = Array.from(document.querySelectorAll('[aria-expanded="true"]')).find((e) => !hidden(e) && !p.contains(e)) ?? null
    return trigger
  }
  for (const p of popovers) {
    const pr = p.getBoundingClientRect()
    // a menu or panel the person opened with a click (its button says expanded) covers what is under it while open
    const opened = p.matches('[role="menu"], [role="listbox"]') || triggerOf(p)?.getAttribute('aria-expanded') === 'true'
    const kind = p.matches('[data-testid="toast"]') ? 'toast' : opened ? 'menu' : 'popover'
    for (const c of controls) {
      if (p.contains(c.el) || c.el.contains(p)) continue
      const x = intersect(pr, c.visible)
      if (x.right - x.left < 3 || x.bottom - x.top < 3) continue
      // only where it is drawn over the control, not under it
      const top = topAt((x.left + x.right) / 2, (x.top + x.bottom) / 2)
      if (!top || !p.contains(top)) continue
      const primary = c.el.matches('.btn.primary')
      // an open menu covers what is under it while it is open, as menus do; covering the screen's main action is still wrong
      if (kind === 'menu' && !primary) continue
      report(
        { detector: 'overlap', severity: primary ? 'P1' : 'P2', detail: `the ${kind} covers ${primary ? 'the main action ' : 'the control '}"${nameOf(c.el).slice(0, 30)}"`, boxes: [toBox(pr), toBox(c.visible)] },
        p,
        c.el
      )
    }
  }

  // ---- 7. small-target -----------------------------------------------------------------------------
  for (const c of controls) {
    const el = c.el
    if (el.matches('input[type="range"]') || el.matches('textarea, select, [contenteditable="true"]')) {
      // a slider's hit area is its track; fields are sized by their content
      if (!el.matches('input[type="range"]')) continue
    }
    // an inline link inside a run of text is sized by the text around it
    const s = css(el)
    if (s.display === 'inline' && el.parentElement && Array.from(el.parentElement.childNodes).some((n) => n.nodeType === 3 && /\S/.test(n.textContent ?? ''))) continue
    // a checkbox or radio inside its label: the label is the target
    let target: R = c.rect
    const label = el.matches('input') ? el.closest('label') : null
    if (label) {
      const lr = label.getBoundingClientRect()
      target = { left: lr.left, top: lr.top, right: lr.right, bottom: lr.bottom }
    }
    const w = target.right - target.left
    const h = target.bottom - target.top
    if (w >= 24 - 0.5 && h >= 24 - 0.5) continue
    // only what is in sight now
    if (empty(c.visible)) continue
    report({ detector: 'small-target', severity: 'P2', detail: `target is ${Math.round(w)}×${Math.round(h)} px, under 24×24`, boxes: [toBox(target)] }, el)
  }

  // ---- 8. popover-placement ------------------------------------------------------------------------
  for (const p of popovers) {
    if (p.matches('[data-testid="toast"]')) continue
    const pr = p.getBoundingClientRect()
    const outX = Math.max(-pr.left, pr.right - W)
    const outY = Math.max(-pr.top, pr.bottom - H)
    if (outX > 1 || outY > 1) {
      report({ detector: 'popover-placement', severity: 'P1', detail: `the popover runs ${Math.round(Math.max(outX, outY))} px out of the window`, boxes: [toBox(pr)] }, p)
    }
    const trigger = triggerOf(p)
    if (!trigger) continue
    const tr = trigger.getBoundingClientRect()
    const dx = Math.max(0, tr.left - pr.right, pr.left - tr.right)
    const dy = Math.max(0, tr.top - pr.bottom, pr.top - tr.bottom)
    const gap = Math.hypot(dx, dy)
    if (gap > 16) {
      report({ detector: 'popover-placement', severity: 'P2', detail: `opens ${Math.round(gap)} px away from its trigger "${nameOf(trigger).slice(0, 30)}"`, boxes: [toBox(pr), toBox(tr)] }, p, trigger)
    }
  }

  for (const m of trapped) {
    const b = backdropOf(m).getBoundingClientRect()
    const holder = clippingAncestors(m).find((a) => clipsAxis(css(a), 'x') || clipsAxis(css(a), 'y'))
    report(
      { detector: 'popover-placement', severity: 'P1', detail: `a dialog is laid out inside ${holder ? selectorOf(holder) : 'the page'} (${Math.round(b.width)}×${Math.round(b.height)} px) instead of over the window`, boxes: [toBox(b), toBox(m.getBoundingClientRect())] },
      m,
      holder
    )
  }

  // ---- 9. imbalance --------------------------------------------------------------------------------
  if (opts.focal && opts.column) {
    const col = Array.from(document.querySelectorAll(opts.column)).find((e) => !hidden(e))
    const focal = Array.from(document.querySelectorAll(opts.focal)).find((e) => !hidden(e) && inScope(e))
    if (col && focal) {
      const cr = paddingBox(col)
      const s = css(col)
      const inner = { left: cr.left + (parseFloat(s.paddingLeft) || 0), right: cr.right - (parseFloat(s.paddingRight) || 0) }
      const fr = focal.getBoundingClientRect()
      const width = inner.right - inner.left
      const off = (fr.left + fr.right) / 2 - (inner.left + inner.right) / 2
      if (width > 0 && Math.abs(off) > 0.12 * width) {
        report(
          { detector: 'imbalance', severity: 'P3', detail: `the focal object sits ${Math.round(off)} px (${Math.round((Math.abs(off) / width) * 100)}% of the column) ${off < 0 ? 'left' : 'right'} of the column's centre`, boxes: [toBox(fr), toBox({ ...cr, left: inner.left, right: inner.right })] },
          focal,
          col
        )
      }
    }
  }

  // ---- 10. button-shape ----------------------------------------------------------------------------
  // spec.md section 1: a text button is a pill and an icon button a circle; no rounded squares. Checked on every
  // button laid out, shown or not, so a control that appears on hover (the player's scrub row) is checked too.
  // Left out: rows that fill their list (nav, menus, pickers), which the spec gives a soft wash; anything taller
  // than 48 px (cards and tiles); a button that is mostly a picture, whose shape is the picture's; tabs, which draw
  // an underline, not a box.
  // A drawn box: a fill, a ring (a box-shadow with no offset and a spread, the app's hairline) or a border all round.
  // A tab's underline (inset 0 -2px 0) is not one.
  const clear = (c: string): boolean => /rgba\(\d+, \d+, \d+, 0\)|transparent/.test(c)
  const ring = (shadow: string): boolean =>
    shadow !== 'none' &&
    shadow.split(/,(?![^(]*\))/).some((one) => {
      const color = /rgba?\([^)]*\)/.exec(one)?.[0] ?? ''
      const [x, y, , spread] = (one.replace(color, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat)
      return !clear(color) && x === 0 && y === 0 && (spread ?? 0) > 0
    })
  const painted = (s: CSSStyleDeclaration): boolean =>
    !clear(s.backgroundColor) ||
    s.backgroundImage !== 'none' ||
    ring(s.boxShadow) ||
    ['top', 'right', 'bottom', 'left'].every((e) => parseFloat(s.getPropertyValue(`border-${e}-width`)) > 0 && !clear(s.getPropertyValue(`border-${e}-color`)))
  const cornerPx = (v: string, side: number): number => {
    const first = v.split(' ')[0]
    return first.endsWith('%') ? (parseFloat(first) / 100) * side : parseFloat(first) || 0
  }
  for (const el of Array.from(document.querySelectorAll('button, [role="button"], a.btn'))) {
    if (!(el instanceof HTMLElement) || !el.checkVisibility({ visibilityProperty: true })) continue
    if (el.parentElement?.closest('button, [role="button"]')) continue
    const s = css(el)
    if (s.display === 'inline' || s.display === 'contents') continue
    const b = el.getBoundingClientRect()
    if (b.width < 1 || b.height < 1 || b.height > 48) continue
    const side = Math.min(b.width, b.height)
    const [tl, tr, br, bl] = (['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'] as const).map((k) => cornerPx(s[k], side))
    const round = (c: number): boolean => c >= side / 2 - 1
    // a pill, a circle, or one end of a split pill (the moment chip and its menu), whose other end meets its twin
    if ((round(tl) && round(bl)) || (round(tr) && round(br))) continue
    const r = Math.min(tl, tr, br, bl)
    const media = Array.from(el.querySelectorAll('img, video, canvas')).some((m) => {
      const mb = m.getBoundingClientRect()
      return mb.width * mb.height >= 0.7 * b.width * b.height
    })
    if (media) continue
    const squareish = b.width / b.height < 1.5
    if (squareish ? r <= 0 && !painted(s) : !painted(s)) continue
    if (!squareish && el.parentElement) {
      const ps = css(el.parentElement)
      const inner = el.parentElement.clientWidth - (parseFloat(ps.paddingLeft) || 0) - (parseFloat(ps.paddingRight) || 0)
      if (b.width >= 0.9 * inner) continue
    }
    report(
      {
        detector: 'button-shape',
        severity: 'P2',
        detail: `a ${Math.round(b.width)}×${Math.round(b.height)} button with ${Math.round(r)} px corners: make it a ${squareish ? 'circle' : 'pill'} (border-radius: 999px)`,
        boxes: [toBox(b)]
      },
      el
    )
  }

  return { findings, allowed }
}
}
