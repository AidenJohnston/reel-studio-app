// The plain-words check (manifesto gate 2): every string Reel Studio can put on screen, read out of the source, and
// the technical words in it. The words and which files are on the path to a first reel live in scope.ts; check.ts
// runs it. No new dependency: TypeScript's own parser reads the app's .ts/.tsx, and a small tokenizer reads the
// engine's Python for the messages it sends the app (docs/architecture.md section 4).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'

export interface Shown {
  text: string
  line: number
}

export interface Word {
  /** what the report calls it */
  name: string
  /** the forms that count, matched whole-word and case-insensitive; spaces match any run of spaces */
  forms: string[]
  /** what to say instead */
  instead: string
}

/** How a file's strings are read. `all`: every string that reads like words. `keys`: only the values of the
 * properties that reach the screen (for files that are mostly text sent to the AI, such as its tool list). */
export type Mode = 'all' | 'keys'

export interface Scope {
  words: Word[]
  /** Folders scanned, relative to the repo. Every file under them is on the path unless `offPath` names it. */
  roots: string[]
  /** The files on the path to a first reel, listed so a rename can't drop one silently. */
  defaultPath: string[]
  /** Files, folders (ending in /) or name prefixes (ending in *) that are not on the path, one reason each. Their hits are reported, not failed. */
  offPath: { path: string; reason: string }[]
  /** Files read in `keys` mode, one reason each. */
  keysOnly: { path: string; reason: string }[]
  /** One string in one file that is fine as it is, one reason each. `text` is a substring of the string. */
  allow: { file: string; text: string; reason: string }[]
}

export interface Hit {
  file: string
  line: number
  word: string
  text: string
}

export interface Report {
  /** hits on the path: these fail the check */
  failing: Hit[]
  /** hits in files off the path */
  offPath: Hit[]
  /** scope entries that point at nothing (a renamed or deleted file): these fail the check too */
  missing: string[]
  files: number
  strings: number
}

const EM_DASH: Word = { name: 'em dash', forms: ['—'], instead: 'a comma, a colon or two sentences' }

function wordPattern(w: Word): RegExp {
  const alt = w.forms
    .map((f) =>
      f
        .split(/\s+/)
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+')
    )
    .join('|')
  // whole word: no letter or digit on either side ("surrender" is not "render"; "re-render" is)
  return w.forms.every((f) => /^[—–]$/.test(f)) ? new RegExp(alt) : new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, 'iu')
}
const patterns = new WeakMap<Word, RegExp>()

/** The words a string uses, by name, in the order of the list. */
export function wordsIn(text: string, words: Word[]): string[] {
  const out: string[] = []
  for (const w of [...words, EM_DASH]) {
    let re = patterns.get(w)
    if (!re) patterns.set(w, (re = wordPattern(w)))
    if (re.test(text)) out.push(w.name)
  }
  return out
}

// ---- TypeScript and TSX ----

/** JSX attributes whose string is always shown or read aloud. */
const TEXT_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'title',
  'placeholder',
  'alt',
  'label',
  'hint',
  'heading',
  'lead',
  'description',
  'text',
  'tooltip',
  'why',
  'message',
  'caption',
  'confirm',
  'cancel',
  'ok'
])
/** JSX attributes that are never shown. */
const CODE_ATTRS = new Set(['className', 'class', 'style', 'key', 'id', 'href', 'src', 'type', 'role', 'rel', 'target', 'htmlFor', 'accept', 'autoComplete', 'inputMode', 'viewBox', 'd', 'fill', 'stroke', 'transform', 'xmlns', 'testid', 'testId', 'name', 'lang', 'dir', 'enterKeyHint', 'pattern', 'mode', 'origin', 'setting'])
/** Calls whose string arguments are never shown: logs, errors that never reach a person (userMessage does), DOM
 * lookups, storage keys, event names, file paths and processes. */
const CODE_CALLS = new Set([
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'Error',
  'TypeError',
  'RangeError',
  'RegExp',
  'querySelector',
  'querySelectorAll',
  'closest',
  'matches',
  'getElementById',
  'getAttribute',
  'setAttribute',
  'removeAttribute',
  'hasAttribute',
  'addEventListener',
  'removeEventListener',
  'dispatchEvent',
  'Event',
  'CustomEvent',
  'getItem',
  'setItem',
  'removeItem',
  'join',
  'resolve',
  'basename',
  'dirname',
  'extname',
  'relative',
  'normalize',
  'readFileSync',
  'readFile',
  'writeFileSync',
  'writeFile',
  'existsSync',
  'mkdirSync',
  'mkdir',
  'rmSync',
  'rm',
  'statSync',
  'stat',
  'spawn',
  'execFile',
  'execFileSync',
  'fork',
  'require',
  'createElement',
  'mark',
  'measure'
])
/** Object keys whose values are never shown. */
const CODE_KEYS = new Set(['className', 'testid', 'code', 'kind', 'type', 'id', 'key', 'event', 'stage', 'channel', 'role', 'icon', 'tone', 'variant', 'easing', 'path', 'file', 'dir', 'url', 'href', 'src', 'slug', 'format', 'mime', 'ext', 'cmd', 'command', 'args', 'env', 'style', 'transform', 'clipPath', 'fill', 'phase'])
/** Keys whose string is shown wherever it sits. */
const SHOWN_KEYS = new Set(['userMessage', 'summary', 'message', 'label', 'text', 'title', 'status', 'detail', 'body', 'line'])
/** In keys mode, the only keys read: `text` and `body` there are mostly what is sent to the AI. */
const KEYS_MODE_KEYS = new Set(['userMessage', 'summary', 'message', 'label', 'title', 'status'])
/** Error constructors whose argument at this index is what the person reads (ai/src/types.ts AIError(code, userMessage)). */
const USER_ERROR_ARGS: Record<string, number> = { AIError: 1 }

/** Reads like words a person sees, not an identifier, a path, a class list or a CSS value. */
export function readsAsWords(s: string): boolean {
  const t = s.trim()
  if (!/\p{L}/u.test(t)) return false
  if (/var\(--|cubic-bezier|rgba?\(|translate[XY(]|scale\(|inset\(|calc\(|:\/\/|^[./\\#[@]|\\/.test(t)) return false
  if (/^-?[\d.]+(px|ms|s|%|em|rem|vh|vw|fr|deg)?(\s+-?[\d.]+(px|ms|s|%|em|rem|vh|vw|fr|deg)?)*$/.test(t)) return false
  // one token with no spaces: shown only if it is a capitalised word ("Export", "Render"), not "render" or "a-b"
  if (!/\s/.test(t)) return /^\p{Lu}[\p{Ll}'’]+[.!?…:]?$/u.test(t)
  // several tokens that are all class-like ("btn primary big") are a class list
  if (/^[a-z0-9_-]+(\s+[a-z0-9_-]+)+$/.test(t) && t.split(/\s+/).every((p) => /[-_]/.test(p) || /^[a-z]+$/.test(p)) && !/\b(the|a|an|to|of|is|and|your|you|it|in|on|for|this|with)\b/.test(t)) return false
  return true
}

function calleeName(e: ts.Expression): string | null {
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return null
}

function propName(n: ts.PropertyName): string | null {
  return ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null
}

function objectHas(o: ts.ObjectLiteralExpression, key: string): boolean {
  return o.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name && propName(p.name) === key)
}

/** Text of a string-ish node, with each `${...}` as {}. */
function textOf(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => `{}${s.literal.text}`).join('')
  return null
}

type Verdict = 'skip' | 'shown' | 'maybe'

/** Why this string is or isn't on screen, from where it sits. */
function placeOf(n: ts.Node, mode: Mode): Verdict {
  let child: ts.Node = n
  let p: ts.Node | undefined = n.parent
  while (p) {
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isImportTypeNode(p) || ts.isExternalModuleReference(p) || ts.isLiteralTypeNode(p)) return 'skip'
    if (ts.isTypeNode(p) && !ts.isTypeQueryNode(p)) return 'skip'
    if (ts.isPropertyAssignment(p) && p.name === child) return 'skip'
    if (ts.isElementAccessExpression(p) && p.argumentExpression === child) return 'skip'
    if (ts.isComputedPropertyName(p)) return 'skip'
    if (ts.isCaseClause(p) && p.expression === child) return 'skip'
    if (ts.isBinaryExpression(p)) {
      const k = p.operatorToken.kind
      if (k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken || k === ts.SyntaxKind.InKeyword) return 'skip'
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && child !== p.expression) {
      const name = calleeName(p.expression)
      if (p.expression.kind === ts.SyntaxKind.ImportKeyword) return 'skip'
      if (name && name in USER_ERROR_ARGS && p.arguments?.indexOf(child as ts.Expression) === USER_ERROR_ARGS[name]) return 'shown'
      if (name && CODE_CALLS.has(name)) {
        // console.error('...') and log.error('...') are logs; a component's onError('...') is not in the list
        return 'skip'
      }
    }
    if (ts.isTaggedTemplateExpression(p)) return 'skip'
    if (ts.isJsxAttribute(p)) {
      const name = ts.isIdentifier(p.name) ? p.name.text : p.name.getText()
      if (CODE_ATTRS.has(name) || name.startsWith('data-')) return 'skip'
      if (TEXT_ATTRS.has(name)) return 'shown'
      return mode === 'keys' ? 'skip' : 'maybe'
    }
    if (ts.isPropertyAssignment(p) && p.initializer === child) {
      const key = propName(p.name)
      if (key && CODE_KEYS.has(key)) return 'skip'
      const obj = p.parent
      // an error's `message` is the developer's detail when a userMessage sits beside it
      if (key === 'message' && ts.isObjectLiteralExpression(obj) && (objectHas(obj, 'userMessage') || objectHas(obj, 'code'))) return 'skip'
      // in the AI package, a chat message for the AI ({ role, content: [{ type: 'text', text }] }) is never shown;
      // elsewhere a role can sit beside a shown label (an Electron menu item)
      if (mode === 'keys' && ts.isObjectLiteralExpression(obj) && objectHas(obj, 'role')) return 'skip'
      if (mode === 'keys') return key && KEYS_MODE_KEYS.has(key) ? 'shown' : 'skip'
      if (key && SHOWN_KEYS.has(key)) return 'shown'
    }
    if (ts.isJsxExpression(p) || ts.isJsxElement(p) || ts.isJsxFragment(p)) return mode === 'keys' ? 'skip' : 'maybe'
    if (ts.isBlock(p) || ts.isSourceFile(p)) return mode === 'keys' ? 'skip' : 'maybe'
    child = p
    p = p.parent
  }
  return mode === 'keys' ? 'skip' : 'maybe'
}

/** The strings in a .ts or .tsx file that can reach the screen, with their lines. */
export function stringsOfTs(source: string, file: string, mode: Mode = 'all'): Shown[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Shown[] = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const visit = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      const t = n.text.replace(/\s+/g, ' ').trim()
      if (t && mode === 'all' && /\p{L}/u.test(t)) out.push({ text: t, line: lineOf(n) })
      return
    }
    const t = textOf(n)
    if (t !== null) {
      const v = placeOf(n, mode)
      if (v === 'shown' ? /\p{L}/u.test(t) : v === 'maybe' && readsAsWords(t)) out.push({ text: t, line: lineOf(n) })
      if (!ts.isTemplateExpression(n)) return
      // a template's ${...} can hold strings of its own
      for (const s of n.templateSpans) visit(s.expression)
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

// ---- Python (the engine's messages to the app) ----

interface PyTok {
  kind: 'str' | 'open' | 'close' | 'comma' | 'eq' | 'name' | 'other'
  text: string
  line: number
}

function pyTokens(src: string): PyTok[] {
  const out: PyTok[] = []
  let i = 0
  let line = 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    const m = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 5))
    if (m && (m[1] === '' || !/[\w]/.test(src[i - 1] ?? ''))) {
      const q = m[2]
      const start = line
      let j = i + m[0].length
      let body = ''
      while (j < src.length && !src.startsWith(q, j)) {
        if (src[j] === '\\' && !/[rR]/.test(m[1])) {
          body += src[j + 1] === 'n' ? '\n' : (src[j + 1] ?? '')
          j += 2
          continue
        }
        if (src[j] === '\n') line++
        body += src[j]
        j++
      }
      // an f-string's {expr} reads as {}
      if (/[fF]/.test(m[1])) body = body.replace(/\{\{|\}\}|\{[^{}]*\}/g, (x) => (x === '{{' ? '{' : x === '}}' ? '}' : '{}'))
      out.push({ kind: 'str', text: body, line: start })
      i = j + q.length
      continue
    }
    if ('([{'.includes(c)) out.push({ kind: 'open', text: c, line })
    else if (')]}'.includes(c)) out.push({ kind: 'close', text: c, line })
    else if (c === ',') out.push({ kind: 'comma', text: c, line })
    else if (c === '=' && src[i + 1] !== '=' && !'!<>='.includes(src[i - 1])) out.push({ kind: 'eq', text: c, line })
    else if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[\w.]/.test(src[j])) j++
      out.push({ kind: 'name', text: src.slice(i, j), line })
      i = j
      continue
    } else if (!/\s/.test(c)) out.push({ kind: 'other', text: c, line })
    i++
  }
  return out
}

/** Calls whose argument at this index is shown to the person (proto.py, compose_util.py). */
const PY_CALLS: Record<string, number> = { EngineError: 2, progress: 2, ready: 2 }
const PY_KEYWORDS = new Set(['user_message', 'userMessage'])

/** Module-level string constants (`MSG = "..."`, or several strings in parentheses), by name. */
export function pyConstants(source: string): Map<string, string> {
  const toks = pyTokens(source)
  const out = new Map<string, string>()
  let depth = 0
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if (t.kind === 'open') depth++
    else if (t.kind === 'close') depth = Math.max(0, depth - 1)
    if (depth || t.kind !== 'name' || toks[i + 1]?.kind !== 'eq' || (i > 0 && toks[i - 1].line === t.line)) continue
    let k = i + 2
    const wrapped = toks[k]?.kind === 'open' && toks[k].text === '('
    if (wrapped) k++
    let text = ''
    while (toks[k]?.kind === 'str') text += toks[k++].text
    if (text && (!wrapped || toks[k]?.kind === 'close')) out.set(t.text, text)
  }
  return out
}

/** The engine's strings that reach the screen: error messages for the person and progress lines. A message held in a
 * constant (`constants`, from pyConstants over the engine) counts where it is used. */
export function stringsOfPy(source: string, constants: Map<string, string> = new Map()): Shown[] {
  const toks = pyTokens(source)
  const out: Shown[] = []
  const strsIn = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      const t = toks[k]
      if (t.kind === 'str' && /\p{L}/u.test(t.text)) out.push({ text: t.text, line: t.line })
      const named = t.kind === 'name' ? constants.get(t.text.split('.').pop()!) : undefined
      if (named) out.push({ text: named, line: t.line })
    }
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    // "userMessage": "..." in a dict
    if (t.kind === 'str' && PY_KEYWORDS.has(t.text) && toks[i + 1]?.text === ':' && toks[i + 2]?.kind === 'str') strsIn(i + 2, i + 3)
    if (t.kind !== 'name' || toks[i + 1]?.kind !== 'open' || toks[i + 1].text !== '(') continue
    // proto.progress, ctx.progress and progress are one call; a bare error() is proto's (proto.py), log.error is not
    const last = t.text.split('.').pop()!
    const idx = last === 'error' ? (t.text === 'error' || t.text === 'proto.error' ? 2 : undefined) : PY_CALLS[last]
    // the call's top-level arguments, as token ranges
    const args: [number, number][] = []
    let depth = 0
    let start = i + 2
    let k = i + 2
    for (; k < toks.length; k++) {
      const x = toks[k]
      if (x.kind === 'open') depth++
      else if (x.kind === 'close') {
        if (depth === 0) break
        depth--
      } else if (x.kind === 'comma' && depth === 0) {
        args.push([start, k])
        start = k + 1
      }
    }
    if (start < k) args.push([start, k])
    let positional = 0
    for (const [a, b] of args) {
      const kw = toks[a]?.kind === 'name' && toks[a + 1]?.kind === 'eq' ? toks[a].text : null
      // progress(..., note=...) is shown beside the step (proto.progress)
      const shownKw = kw && (PY_KEYWORDS.has(kw) || (idx !== undefined && last !== 'EngineError' && (kw === 'message' || kw === 'note')))
      if (kw ? shownKw : idx !== undefined && positional === idx) strsIn(kw ? a + 2 : a, b)
      if (!kw) positional++
    }
  }
  return out
}

// ---- the repo ----

const norm = (p: string) => p.split(sep).join('/')

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === '__pycache__' || name === 'tests' || name === 'test') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|py)$/.test(name) && !/\.(test|spec)\.tsx?$|\.d\.ts$/.test(name)) out.push(p)
  }
}

/** A scope entry ending in / or * names every file it starts; any other names one file. */
const under = (file: string, entry: string) => (entry.endsWith('/') ? file.startsWith(entry) : entry.endsWith('*') ? file.startsWith(entry.slice(0, -1)) : file === entry)

export function scan(repo: string, scope: Scope): Report {
  const files: string[] = []
  const missing: string[] = []
  for (const r of scope.roots) {
    try {
      walk(join(repo, r), files)
    } catch {
      missing.push(r)
    }
  }
  const rel = files.map((f) => norm(relative(repo, f))).sort()
  const known = new Set(rel)
  for (const f of scope.defaultPath) if (!known.has(f)) missing.push(f)
  for (const e of [...scope.offPath, ...scope.keysOnly]) if (!rel.some((f) => under(f, e.path))) missing.push(e.path)
  for (const a of scope.allow) if (!known.has(a.file)) missing.push(a.file)
  const failing: Hit[] = []
  const offPath: Hit[] = []
  let strings = 0
  const usedAllow = new Set<number>()
  // the engine's message constants, by name, from every Python file (a message is often imported, e.g. proto.NO_SPACE_MESSAGE)
  const constants = new Map<string, string>()
  for (const file of rel) if (file.endsWith('.py')) for (const [k, v] of pyConstants(readFileSync(join(repo, file), 'utf8'))) constants.set(k, v)
  for (const file of rel) {
    const src = readFileSync(join(repo, file), 'utf8')
    const mode: Mode = scope.keysOnly.some((e) => under(file, e.path)) ? 'keys' : 'all'
    const shown = file.endsWith('.py') ? stringsOfPy(src, constants) : stringsOfTs(src, file, mode)
    strings += shown.length
    const off = scope.offPath.some((e) => under(file, e.path))
    for (const s of shown) {
      const words = wordsIn(s.text, scope.words)
      if (!words.length) continue
      const ok = scope.allow.findIndex((a) => a.file === file && s.text.includes(a.text))
      if (ok >= 0) {
        usedAllow.add(ok)
        continue
      }
      for (const word of words) (off ? offPath : failing).push({ file, line: s.line, word, text: s.text })
    }
  }
  // an allow entry that no longer matches anything is stale: the string changed, so the reason may not hold
  scope.allow.forEach((a, i) => {
    if (!usedAllow.has(i) && known.has(a.file)) missing.push(`allow "${a.text}" in ${a.file}`)
  })
  return { failing, offPath, missing, files: rel.length, strings }
}
