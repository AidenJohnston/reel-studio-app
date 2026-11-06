import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linkPolicy, paceFor, readEntry, readout, type ReelMeasure, type ReferenceEntry } from '../src/shared/references'
import { createReferenceLibrary } from '../src/main/references'

const measure = (o: { wps?: number | null; shot: number; count?: number; hook?: number; words?: number; cuts5?: number; seconds?: number }): ReelMeasure => ({
  version: 1, duration: o.seconds ?? 30, width: 1080, height: 1920, hasAudio: true,
  speech: o.wps === null ? null : { words: 80, wordsPerSecond: o.wps ?? 2.8, firstWordAt: 0.1, talkingSeconds: 29, pausesPerMinute: 1, hook: { seconds: o.hook ?? 2, words: o.words ?? 6, text: 'x' } },
  speechMissing: o.wps === null ? 'no-speech' : null,
  shots: { count: o.count ?? 10, medianSeconds: o.shot, perMinute: 20, cutsFirst5: o.cuts5 ?? 2 }
})
const entry = (m: ReelMeasure, i = 0): ReferenceEntry => ({ id: `0000000${i}-aaaa`, title: `r${i}`, addedAt: '2026-11-06T00:00:00Z', file: `files/${i}.mp4`, measure: m })

describe('linkPolicy', () => {
  // fails if the app downloads from a site whose terms forbid it, including through the site's own video servers
  it.each([
    ['https://www.tiktok.com/@maker/video/7300000000', 'TikTok'],
    ['https://youtu.be/abc123', 'YouTube'],
    ['https://www.youtube.com/shorts/abc123', 'YouTube'],
    ['https://www.instagram.com/reel/Cx1/', 'Instagram'],
    ['https://scontent-lax3-1.cdninstagram.com/v/t50/clip.mp4', 'Instagram'],
    ['https://v16-webapp.tiktokcdn.com/abc/video.mp4', 'TikTok'],
    ['https://x.com/maker/status/1', 'X'],
    ['https://vimeo.com/123', 'Vimeo']
  ])('keeps %s and asks for the file', (url, platform) => {
    const p = linkPolicy(url)
    expect(p).toMatchObject({ kind: 'ask-file', platform })
    expect(p.kind === 'ask-file' && p.why).toContain(`${platform}’s terms`)
  })

  it('downloads a link straight to a video file on any other site, and asks for the file for any other page', () => {
    expect(linkPolicy('https://media.example.org/talks/opening%20line.mp4')).toEqual({ kind: 'download', url: 'https://media.example.org/talks/opening%20line.mp4', title: 'opening line.mp4' })
    expect(linkPolicy('https://notyoutube.com/v.mp4').kind).toBe('download')
    expect(linkPolicy('https://example.org/watch?v=1')).toMatchObject({ kind: 'ask-file', platform: 'example.org' })
  })

  it('refuses what is not a web link', () => {
    for (const bad of ['not a link', 'file:///C:/clip.mp4', 'ftp://example.org/a.mp4', 'https://me:secret@example.org/a.mp4']) expect(linkPolicy(bad).kind).toBe('invalid')
  })
})

describe('readout', () => {
  // fails if the numbers on screen are not the middle of the measured reels, or the sentences claim what was not measured
  it('gives the middle value and range of each measurement, and names the pace band it falls in', () => {
    const r = readout([entry(measure({ wps: 2.4, shot: 1.8, hook: 1.6, words: 5, seconds: 22 }), 1), entry(measure({ wps: 3.1, shot: 2.6, hook: 2.4, words: 7, seconds: 41 }), 2), entry(measure({ wps: 2.8, shot: 2.2, hook: 2.0, words: 6, seconds: 30 }), 3)])
    expect(r.pace).toEqual({ median: 2.8, low: 2.4, high: 3.1, n: 3 })
    expect(r.shot).toEqual({ median: 2.2, low: 1.8, high: 2.6, n: 3 })
    expect(r.pacePreset).toBe('hyper')
    expect(r.lines).toEqual([
      'They talk at about 2.8 words a second (2.4 to 3.1 across 3 reels), an everyday talking pace.',
      'The picture changes about every 2.2 seconds (1.8 to 2.6 seconds across 3 reels), close to the Fast pace (1.5 to 3 seconds).',
      'The first sentence is over in about 2 seconds, around 6 words.',
      'They cut about 2 times in the first 5 seconds.',
      'They run 22 to 41 seconds.'
    ])
  })

  it('averages the middle two of an even count, and leaves out what no reel had', () => {
    const r = readout([entry(measure({ wps: null, shot: 4 }), 1), entry(measure({ wps: null, shot: 5 }), 2), { id: '00000009-aaaa', title: 'link', addedAt: '', link: { url: 'https://x.com/a', platform: 'X' }, needsFile: 'add it' }])
    expect(r.measured).toBe(2)
    expect(r.shot?.median).toBe(4.5)
    expect(r.pace).toBeNull()
    expect(r.hook).toBeNull()
    expect(r.lines.join(' ')).not.toMatch(/words a second|first sentence/)
  })

  it('says a reel with no cuts holds one shot instead of naming a pace', () => {
    const r = readout([entry(measure({ shot: 30, count: 1, cuts5: 0 }))])
    expect(r.pacePreset).toBeNull()
    expect(r.lines).toContain('They hold one shot the whole way through, with no cuts.')
  })

  it('picks the nearest pace band for a shot length between bands', () => {
    expect(paceFor(5.4)).toBe('standard')
    expect(paceFor(5.8)).toBe('clean')
    expect(paceFor(14)).toBe('clean')
    expect(paceFor(0.8)).toBe('hyper')
  })
})

describe('readEntry', () => {
  // fails if a hand-edited references.json can point the app's copy outside References/files
  it('drops a file path that leaves files/, and an entry with neither file nor link', () => {
    const base = { id: '12345678-abcd', title: 't', addedAt: 'now' }
    expect(readEntry({ ...base, file: 'files/../../My style.json' })).toBeNull()
    expect(readEntry({ ...base, file: 'files/a.mp4' })).toMatchObject({ file: 'files/a.mp4' })
    expect(readEntry({ ...base, id: '../x', file: 'files/a.mp4' })).toBeNull()
    expect(readEntry({ ...base, file: 'files/a.mp4', measure: { duration: 'long' } })).not.toHaveProperty('measure')
  })
})

describe('the reference library', () => {
  const setup = (engine: (cmd: string, args: string[]) => Promise<unknown>) => {
    const root = mkdtempSync(join(tmpdir(), 'rs-refs-'))
    const changed: number[] = []
    const lib = createReferenceLibrary({ root: () => root, runEngine: (c, a) => engine(c, a), onChange: () => changed.push(1), log: () => undefined, mediaUrl: (p) => `media:${p}` })
    const src = join(root, '..', `${root.split(/[\\/]/).pop()}-mine`)
    mkdirSync(src, { recursive: true })
    return { root, lib, src, changed }
  }
  const until = async (fn: () => Promise<boolean>) => {
    for (let i = 0; i < 200 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 10))
  }

  // fails if an added reel is not copied in, measured and written with the readout the editor's tool reads
  it('copies a video in, measures it, and stores the readout beside it', async () => {
    const { root, lib, src, changed } = setup(async (cmd, args) => {
      if (cmd === 'probe') return { duration: 30 }
      if (cmd === 'measure-reel') {
        const still = args[args.indexOf('--poster') + 1]
        mkdirSync(dirname(still), { recursive: true })
        writeFileSync(still, 'jpg')
        return { ...measure({ shot: 2.2 }), poster: still }
      }
      throw new Error(cmd)
    })
    const reel = join(src, 'Their reel.mp4')
    writeFileSync(reel, 'video bytes')
    writeFileSync(join(src, 'notes.txt'), 'x')
    const r = await lib.addFiles([reel, join(src, 'notes.txt'), reel])
    expect(r.added).toBe(1)
    expect(r.skipped.map((s) => s.name)).toEqual(['notes.txt', 'Their reel.mp4'])
    await until(async () => changed.length > 0)
    const { references, readout: shown } = await lib.list()
    expect(references).toMatchObject([{ title: 'Their reel', state: 'measured', original: 'Their reel.mp4' }])
    expect(references[0].posterUrl).toMatch(/^media:.*\.jpg$/)
    const stored = JSON.parse(readFileSync(join(root, 'References', 'references.json'), 'utf8'))
    expect(stored.readout).toEqual(shown)
    expect(stored.references[0].measure).not.toHaveProperty('poster')
    expect(readFileSync(join(root, 'References', stored.references[0].file), 'utf8')).toBe('video bytes')
  })

  // fails if a reel the engine can't measure keeps showing "measuring", or is retried forever
  it('keeps the engine’s words when a reel cannot be measured', async () => {
    let tries = 0
    const { lib, src, changed } = setup(async (cmd) => {
      if (cmd === 'probe') return { duration: 12 }
      tries++
      throw { code: 'NOT_VIDEO', userMessage: 'That file isn’t a video Reel Studio can read.' }
    })
    writeFileSync(join(src, 'odd.mov'), 'x')
    await lib.addFiles([join(src, 'odd.mov')])
    await until(async () => changed.length > 0)
    await lib.list()
    expect((await lib.list()).references[0]).toMatchObject({ state: 'problem', problem: 'That file isn’t a video Reel Studio can read.' })
    expect(tries).toBe(1)
  })

  // fails if a TikTok link is downloaded, or its file can't be added afterwards
  it('keeps a platform link without downloading it, then takes its file', async () => {
    const commands: string[] = []
    const { lib, src } = setup(async (cmd) => {
      commands.push(cmd)
      return cmd === 'probe' ? { duration: 20 } : measure({ shot: 3 })
    })
    const link = await lib.addLink('https://www.tiktok.com/@maker/video/1')
    expect(link).toMatchObject({ link: { platform: 'TikTok' }, needsFile: expect.stringContaining('Save video') })
    expect(commands).not.toContain('download-media')
    await expect(lib.addLink('https://www.tiktok.com/@maker/video/1')).rejects.toMatchObject({ code: 'ALREADY' })
    expect((await lib.list()).references[0].state).toBe('needs-file')
    writeFileSync(join(src, 'saved.mp4'), 'x')
    await lib.attach(link.id, join(src, 'saved.mp4'))
    const after = (await lib.list()).references[0]
    expect(after).not.toHaveProperty('needsFile')
    expect(after.file).toMatch(/^files\/.*\.mp4$/)
  })

  // fails if removing a reference deletes the person's own file, or leaves the app's copy behind
  it('removes the app’s copy and never the original', async () => {
    const { root, lib, src } = setup(async (cmd) => (cmd === 'probe' ? { duration: 20 } : measure({ shot: 3 })))
    writeFileSync(join(src, 'mine.mp4'), 'x')
    await lib.addFiles([join(src, 'mine.mp4')])
    const [r] = (await lib.list()).references
    await lib.remove(r.id)
    expect(existsSync(join(root, 'References', r.file!))).toBe(false)
    expect(existsSync(join(src, 'mine.mp4'))).toBe(true)
    expect((await lib.list()).references).toEqual([])
  })

  // fails if a damaged references.json stops the list instead of being set aside
  it('sets a damaged list aside and starts over', async () => {
    const { root, lib } = setup(async () => ({}))
    mkdirSync(join(root, 'References'), { recursive: true })
    writeFileSync(join(root, 'References', 'references.json'), '{"references": [')
    expect((await lib.list()).references).toEqual([])
    expect(existsSync(join(root, 'References', 'references.json'))).toBe(false)
  })
})
