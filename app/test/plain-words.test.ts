// Manifesto gate 2: no technical word on the path to a first reel (scripts/plain-words). The repo test is the gate;
// the others pin the reader, because a reader that drops strings passes everything.
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { scan, stringsOfPy, stringsOfTs, wordsIn } from '../../scripts/plain-words/scan.ts'
import { scope } from '../../scripts/plain-words/scope.ts'

const REPO = resolve(__dirname, '..', '..')

describe('the plain-words check', () => {
  it('finds no technical word on the path to a first reel, and every scope entry still matches a file', () => {
    const report = scan(REPO, scope)
    const lines = report.failing.map((h) => `${h.file}:${h.line} "${h.word}" in ${JSON.stringify(h.text)}`)
    expect(lines).toEqual([])
    expect(report.missing).toEqual([])
  })
})

describe('reading what a screen shows', () => {
  const texts = (src: string, file = 'x.tsx') => stringsOfTs(src, file).map((s) => s.text)

  it('reads JSX text that runs over several lines as one sentence', () => {
    expect(texts('const A = () => <p>\n  Your video is being\n  rendered now\n</p>')).toEqual(['Your video is being rendered now'])
  })

  it('reads the props a person sees or hears, and the strings a component shows', () => {
    const src = `const A = ({ ok }) => (
      <button aria-label="Close the preview" title="Stop" className="btn render-x" data-testid="render" kind="primary">
        {ok ? 'Keep it' : 'Try again'}
      </button>
    )
    const LEADS = { sample: 'How a reel gets made' }`
    expect(texts(src)).toEqual(['Close the preview', 'Stop', 'Keep it', 'Try again', 'How a reel gets made'])
  })

  it('skips what never reaches a screen: comparisons, imports, logs, events and an error detail beside its userMessage', () => {
    const src = `import x from 'some module'
    if (e.type === 'render done') log.info('render started now')
    window.dispatchEvent(new Event('reel:render'))
    throw { code: 'NO_AUDIO', message: 'ffmpeg exit 1 in render', userMessage: 'This video has no sound. Try another one.' }`
    expect(texts(src, 'x.ts')).toEqual(['This video has no sound. Try another one.'])
  })

  it('reads the engine messages the app shows, and not the developer detail', () => {
    const py = `raise EngineError("NO_AUDIO", f"{path.name}: no audio stream", "This video has no sound. Try another one.")
progress("render", 40, "Putting it together")
log("render took 3 s")`
    expect(stringsOfPy(py).map((s) => s.text)).toEqual(['This video has no sound. Try another one.', 'Putting it together'])
  })
})

describe('which words count', () => {
  it('matches whole words in any case, and not inside other words', () => {
    expect(wordsIn('Rendering your reel', scope.words)).toEqual(['render'])
    expect(wordsIn('Never surrender, it is a remodel', scope.words)).toEqual([])
    expect(wordsIn('Paste your API key', scope.words)).toEqual(['API'])
    expect(wordsIn('Version 2 — shorter', scope.words)).toEqual(['em dash'])
  })
})
