// Reduced motion in the renderer's CSS (styles.css explains the two rules): nothing moves, and the designed fades
// keep their length. Read from the stylesheets themselves, so a new sliding keyframe without its twin fails here.
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RENDERER = join(__dirname, '..', 'src', 'renderer', 'src')

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith('.css') ? [join(dir, e.name)] : []
  )
}

interface Keyframes {
  name: string
  body: string
  at: number
  /** inside a reduced-motion block (a twin), or a full-motion one (never seen with reduced motion) */
  within: 'reduce' | 'full' | null
}

/** Every @keyframes in `source`, and which motion block it sits in. */
function keyframes(source: string): Keyframes[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: Keyframes[] = []
  const stack: ('reduce' | 'full' | null)[] = []
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '}') {
      stack.pop()
      continue
    }
    if (css[i] !== '{') continue
    const head = css.slice(Math.max(css.lastIndexOf('}', i - 1), css.lastIndexOf('{', i - 1), css.lastIndexOf(';', i - 1)) + 1, i).trim()
    const within = stack.find((b) => b !== null) ?? null
    const kf = /^@keyframes\s+([\w-]+)$/.exec(head)
    if (kf) {
      let depth = 1
      let j = i + 1
      for (; depth; j++) depth += css[j] === '{' ? 1 : css[j] === '}' ? -1 : 0
      out.push({ name: kf[1], body: css.slice(i + 1, j - 1), at: i, within })
      i = j - 1
      continue
    }
    stack.push(/^@media\b.*prefers-reduced-motion:\s*reduce/.test(head) ? 'reduce' : /^@media\b.*prefers-reduced-motion:\s*no-preference/.test(head) ? 'full' : null)
  }
  return out
}

/** Whether a keyframe body slides, scales or turns. A frame list that covers both ends moves only if its transforms
 * differ; one that names a single end runs to or from the element's own transform, none here. */
function moves(body: string): boolean {
  const values = new Set([...body.matchAll(/(?:transform|translate|scale|rotate)\s*:\s*([^;}]+)/g)].map((m) => m[1].trim().replace(/\s+/g, ' ')))
  if (!values.size) return false
  const bothEnds = /(\bfrom\b|(^|[\s,])0%)/.test(body) && /(\bto\b|100%)/.test(body)
  return bothEnds ? values.size > 1 : [...values].some((v) => v !== 'none')
}

// Nothing keeps moving under reduced motion: the spinner pulses there instead of turning (prep-for-prod round 1),
// which still reads as working where a frozen ring would read as stuck.
const STILL_TURNS = new Set<string>()

describe('reduced motion in the stylesheets', () => {
  const files = cssFiles(RENDERER).map((f) => ({ f: f.slice(RENDERER.length + 1), css: readFileSync(f, 'utf8') }))

  // fails if a blanket rule shortens every animation and transition again, which cut the designed fades to nothing
  it('has no rule that cuts every animation or transition short', () => {
    for (const { f, css } of files) expect([f, /(animation|transition)-duration\s*:\s*[01](\.\d+)?ms\s*!important/.test(css)]).toEqual([f, false])
  })

  // fails if a keyframe that slides, scales or turns has no fade-only twin later in its file's reduced-motion block
  it('gives every keyframe that moves a twin that does not, declared after it', () => {
    const missing: string[] = []
    for (const { f, css } of files) {
      const all = keyframes(css)
      for (const k of all.filter((x) => x.within === null && moves(x.body) && !STILL_TURNS.has(x.name))) {
        const twin = all.find((x) => x.within === 'reduce' && x.name === k.name && x.at > k.at)
        if (!twin || moves(twin.body)) missing.push(`${f}: ${k.name}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('reads keyframes and their blocks the way the browser does', () => {
    const css = `/* a { brace } in a comment */ @keyframes a { from { transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) { .x { color: red; } @keyframes a { from { opacity: 0; } } }
@keyframes b { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: no-preference) { @keyframes c { from { scale: .8; } } }
@keyframes d { from, to { transform: translateX(-50%); } }`
    expect(keyframes(css).map((k) => [k.name, k.within, moves(k.body)])).toEqual([
      ['a', null, true],
      ['a', 'reduce', false],
      ['b', null, true],
      ['c', 'full', true],
      ['d', null, false]
    ])
  })
})
