// Pictures, GIFs and clips on a note (0.1.2 F2): the shared rules (paste, drop, limits, chips) and the
// main-process side (sidecar checks, removing, bytes with no file, the real engine when available).
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLIP_MAX_BYTES,
  MAX_ATTACHMENTS_PER_NOTE,
  MSG,
  PICTURE_MAX_BYTES,
  addChips,
  chipBadge,
  classify,
  clipLength,
  effectiveExt,
  isAttachmentRef,
  nameWithExt,
  planDrop,
  planPaste,
  slotsLeft
} from '../src/shared/attachments'
import { noAiReply } from '../src/shared/notes'
import {
  attachBytes,
  attachPaths,
  checkNoteAttachments,
  forChat,
  pickClipboardType,
  readSidecar,
  registerAttachmentIpc,
  removeAttachment,
  withThumbUrl
} from '../src/main/attachments'
import { createEngineRunner } from '../src/main/engine'

// ---------------------------------------------------------------- shared rules

describe('classify: type and size', () => {
  it('accepts pictures, GIFs and clips by extension or by MIME type', () => {
    expect(classify('meme.PNG')).toMatchObject({ ok: true, kind: 'picture', ext: 'png' })
    expect(classify('IMG_0001.HEIC')).toMatchObject({ ok: true, kind: 'picture', ext: 'heic' })
    expect(classify('the ick.gif')).toMatchObject({ ok: true, kind: 'gif' })
    expect(classify('clip.MOV')).toMatchObject({ ok: true, kind: 'clip', ext: 'mov' })
    expect(classify('image', 'image/png')).toMatchObject({ ok: true, kind: 'picture', ext: 'png' }) // a pasted screenshot
    expect(classify('', 'video/quicktime')).toMatchObject({ ok: true, kind: 'clip', ext: 'mov' })
    expect(effectiveExt('photo.jpeg')).toBe('jpeg')
  })
  it('refuses other types in plain words', () => {
    for (const n of ['notes.pdf', 'song.mp3', 'clip.mkv', 'drawing.svg', 'noext']) expect(classify(n)).toEqual({ ok: false, message: MSG.type })
    expect(MSG.type).toBe("That file type isn't supported. Use a picture (JPG, PNG, GIF, HEIC) or a short video (MP4, MOV).")
  })
  it('limits: pictures 25 MB, clips and GIFs 200 MB', () => {
    expect(classify('a.png', '', PICTURE_MAX_BYTES)).toMatchObject({ ok: true })
    expect(classify('a.png', '', PICTURE_MAX_BYTES + 1)).toEqual({ ok: false, message: MSG.pictureBig })
    expect(classify('a.gif', '', PICTURE_MAX_BYTES + 1)).toMatchObject({ ok: true }) // a GIF has the clip limit
    expect(classify('a.gif', '', CLIP_MAX_BYTES + 1)).toEqual({ ok: false, message: MSG.clipBig })
    expect(classify('a.mp4', '', CLIP_MAX_BYTES + 1)).toEqual({ ok: false, message: MSG.clipBig })
  })
  it('names a pasted file with the right extension', () => {
    expect(nameWithExt('', 'image/png')).toBe('Pasted picture.png')
    expect(nameWithExt('image', 'image/jpeg')).toBe('image.jpg')
    expect(nameWithExt('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg')
    expect(nameWithExt('C:\\x\\shot.png', 'image/png')).toBe('shot.png')
  })
  it('user words carry no em dash', () => {
    for (const m of Object.values(MSG)) expect(m).not.toMatch(/\u2014/)
  })
})

describe('planPaste: which paste is a file and which is text', () => {
  const png = { name: 'image.png', type: 'image/png', size: 1000 }
  it('a copied file with a real path is attached, even when its name came along as text', () => {
    const p = planPaste({ files: [{ ...png, name: 'meme.png', path: 'C:\\Users\\me\\meme.png' }], items: [], text: 'meme.png' })
    expect(p).toMatchObject({ handle: true, paths: [{ path: 'C:\\Users\\me\\meme.png', name: 'meme.png' }], blobs: [], clipboard: false })
  })
  it('a screenshot or a browser "Copy image" (bytes, no path, no text) is sent as bytes', () => {
    const p = planPaste({ files: [png], items: [{ kind: 'file', type: 'image/png' }], text: '' })
    expect(p).toMatchObject({ handle: true, paths: [], blobs: [0], clipboard: false })
  })
  it('an image item with no File the page can read asks main to read the clipboard', () => {
    const p = planPaste({ files: [], items: [{ kind: 'string', type: 'text/html' }, { kind: 'file', type: 'image/png' }], text: '' })
    expect(p).toMatchObject({ handle: true, clipboard: true, paths: [], blobs: [] })
  })
  it('plain text pastes as normal', () => {
    expect(planPaste({ files: [], items: [{ kind: 'string', type: 'text/plain' }], text: 'make it louder' })).toEqual({ handle: false })
    // cells from a spreadsheet: text AND a picture of them; the person meant the text
    expect(planPaste({ files: [png], items: [{ kind: 'file', type: 'image/png' }], text: 'a\tb' })).toEqual({ handle: false })
    expect(planPaste({ files: [], items: [{ kind: 'file', type: 'image/png' }], text: 'x' })).toEqual({ handle: false })
    expect(planPaste({ files: [], items: [], text: '' })).toEqual({ handle: false })
  })
  it('an unsupported or too-big file says why and is skipped', () => {
    const p = planPaste({ files: [{ name: 'doc.pdf', type: 'application/pdf', size: 10, path: 'C:\\doc.pdf' }, { name: 'big.png', type: 'image/png', size: PICTURE_MAX_BYTES + 1, path: 'C:\\big.png' }], items: [], text: '' })
    expect(p).toMatchObject({ handle: true, paths: [], errors: [MSG.type, MSG.pictureBig] })
  })
})

describe('planDrop', () => {
  it('files with a path are copied by main, files with only bytes are sent', () => {
    const p = planDrop({ files: [{ name: 'a.mp4', type: 'video/mp4', size: 5, path: '/Users/me/a.mp4' }, { name: 'b.png', type: 'image/png', size: 5 }] })
    expect(p).toEqual({ paths: [{ path: '/Users/me/a.mp4', name: 'a.mp4' }], blobs: [1], clipboard: false, errors: [] })
  })
  it('a picture dragged out of a browser as a link only: say to save it first', () => {
    expect(planDrop({ files: [], uriOnly: true }).errors).toEqual([MSG.fromWeb])
    expect(planDrop({ files: [] }).errors).toEqual([])
  })
  it('an empty file is not sent', () => {
    expect(planDrop({ files: [{ name: 'x.png', type: 'image/png', size: 0 }] })).toMatchObject({ blobs: [], errors: [MSG.failed] })
  })
})

describe('chips', () => {
  const a = (n: number) => ({ asset: `work/assets/attach-0000000${n}-x.png` })
  it('no repeats, at most four per note', () => {
    expect(addChips([a(1)], [a(1), a(2)])).toEqual({ chips: [a(1), a(2)], dropped: 0 })
    const r = addChips([a(1), a(2), a(3)], [a(4), a(5), a(6)])
    expect(r.chips).toHaveLength(MAX_ATTACHMENTS_PER_NOTE)
    expect(r.dropped).toBe(2)
    expect(slotsLeft(3, 1)).toBe(0)
    expect(slotsLeft(1)).toBe(3)
    expect(slotsLeft(6)).toBe(0)
  })
  it('badges: GIF, clip length, nothing for a picture', () => {
    expect(chipBadge({ kind: 'video', fromGif: true, duration: 3 })).toBe('GIF')
    expect(chipBadge({ kind: 'video', duration: 7.4 })).toBe('0:07')
    expect(chipBadge({ kind: 'video', duration: 61 })).toBe('1:01')
    expect(chipBadge({ kind: 'image' })).toBeNull()
    expect(clipLength(undefined)).toBe('0:00')
  })
  it('only the engine-written shape is an attachment ref', () => {
    expect(isAttachmentRef('work/assets/attach-0a1b2c3d-the-ick.mp4')).toBe(true)
    for (const r of ['work/assets/x.png', 'work/assets/attach-0a1b2c3d-x.png.attach.json', '../attach-0a1b2c3d-x.png', 'media/attach-0a1b2c3d-x.png', 'work/assets/attach-0a1b2c3d-X.png'])
      expect(isAttachmentRef(r)).toBe(false)
  })
})

describe('no AI connected', () => {
  it('a note with a file says plainly it was kept and how to get it placed', () => {
    const r = noAiReply('', 1)
    expect(r.text).toMatch(/can't put your file in the video yet/)
    expect(r.text).toMatch(/kept it/)
    expect(r.actions).toEqual(['open-broll', 'connect'])
    expect(noAiReply('over my face', 2).text).toMatch(/your files/)
    expect(r.text).not.toMatch(/\u2014/)
    // without files: unchanged
    expect(noAiReply('music too loud').actions).toEqual(['open-music', 'connect'])
  })
})

// ---------------------------------------------------------------- main process

function project(): string {
  const base = mkdtempSync(join(tmpdir(), 'rs-att-'))
  const dir = join(base, 'Zoë Müller', 'Projects', 'my réel')
  mkdirSync(join(dir, 'work', 'assets'), { recursive: true })
  mkdirSync(join(dir, 'work', 'thumbs'), { recursive: true })
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ broll: [] }))
  return dir
}

let n = 0
function fakeAttach(dir: string, o: { kind?: 'image' | 'video'; asset?: string } = {}): string {
  const id = (0x2a000000 + n++).toString(16)
  const kind = o.kind ?? 'image'
  const stem = `attach-${id}-meme`
  const asset = o.asset ?? `work/assets/${stem}.${kind === 'image' ? 'png' : 'mp4'}`
  writeFileSync(join(dir, ...asset.split('/')), 'x')
  writeFileSync(join(dir, 'work', 'thumbs', `${stem}.jpg`), 'jpg')
  writeFileSync(
    join(dir, ...asset.split('/')) + '.attach.json',
    JSON.stringify({ asset, name: 'the ick.gif', kind, bytes: 1, width: 10, height: 10, ...(kind === 'video' ? { duration: 3, hasAudio: false, fromGif: true } : {}), thumb: `work/thumbs/${stem}.jpg`, thumbUrl: 'reel-media://evil' })
  )
  return asset
}

describe('main: sidecars are the only truth', () => {
  it('reads a real attachment, with a fresh URL for its still (a stored URL is ignored)', async () => {
    const dir = project()
    const a = fakeAttach(dir, { kind: 'video' })
    const s = await readSidecar(dir, a)
    expect(s).toMatchObject({ asset: a, name: 'the ick.gif', kind: 'video', duration: 3, hasAudio: false, fromGif: true })
    expect(s).not.toHaveProperty('thumbUrl')
    const u = withThumbUrl(dir, s!)
    expect(u.thumbUrl).toMatch(/^reel-media:\/\/f\//)
    expect(decodeURIComponent(u.thumbUrl!)).toContain('thumbs')
    expect(forChat(u)).not.toHaveProperty('thumbUrl')
  })
  it('a note: at most four, deduped, every ref must have its own sidecar in THIS project', async () => {
    const dir = project()
    const a = fakeAttach(dir)
    const b = fakeAttach(dir)
    expect((await checkNoteAttachments(dir, [a, b, a])).map((x) => x.asset)).toEqual([a, b])
    expect(await checkNoteAttachments(dir, undefined)).toEqual([])
    const other = project()
    const foreign = fakeAttach(other)
    for (const bad of [['work/assets/x.png'], ['../../x'], [foreign], [42], 'work/assets/x.png']) {
      await expect(checkNoteAttachments(dir, bad)).rejects.toMatchObject({ code: 'BAD_ATTACHMENT' })
    }
    const five = [1, 2, 3, 4, 5].map(() => fakeAttach(dir))
    await expect(checkNoteAttachments(dir, five)).rejects.toMatchObject({ code: 'TOO_MANY', userMessage: MSG.tooMany })
  })
  it('remove: deletes asset + sidecar + still, never one the video uses, never anything else', async () => {
    const dir = project()
    const a = fakeAttach(dir)
    const used = fakeAttach(dir)
    await expect(removeAttachment(dir, used, { broll: [{ id: 'b1', asset: used } as any] })).rejects.toMatchObject({ code: 'IN_USE' })
    expect(existsSync(join(dir, ...used.split('/')))).toBe(true)
    await removeAttachment(dir, a, { broll: [] })
    expect(readdirSync(join(dir, 'work', 'assets')).filter((f) => f.includes(a.split('/').pop()!))).toEqual([])
    // not an attachment: nothing happens
    writeFileSync(join(dir, 'work', 'assets', 'mine.png'), 'x')
    await removeAttachment(dir, 'work/assets/mine.png', null)
    await removeAttachment(dir, '../project.json', null)
    expect(existsSync(join(dir, 'work', 'assets', 'mine.png'))).toBe(true)
    expect(existsSync(join(dir, 'project.json'))).toBe(true)
  })
  it('clipboard: prefers PNG', () => {
    expect(pickClipboardType(['text/html', 'image/jpeg', 'image/png'])).toBe('image/png')
    expect(pickClipboardType(['image/tiff'])).toBe('image/tiff')
    expect(pickClipboardType(['text/plain'])).toBeNull()
  })
})

describe('main: bytes with no file (paste of a screenshot)', () => {
  it('checks type and size BEFORE writing, writes a temp file, attaches, deletes the temp', async () => {
    const dir = project()
    const calls: string[][] = []
    const runEngine: any = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      expect(existsSync(args[2])).toBe(true) // the temp copy exists while the engine reads it
      const asset = fakeAttach(dir)
      return { asset }
    }
    const deps = { runEngine, log: () => undefined }
    const r = await attachBytes(deps, dir, { name: 'image', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) })
    expect(r.errors).toEqual([])
    expect(r.attached).toHaveLength(1)
    expect(r.attached[0].thumbUrl).toMatch(/^reel-media:/)
    expect(calls[0].slice(0, 3)).toEqual(['attach', '--project', dir])
    expect(calls[0].slice(-2)).toEqual(['--name', 'image.png'])
    expect(existsSync(calls[0][3])).toBe(false) // temp deleted

    calls.length = 0
    expect((await attachBytes(deps, dir, { name: 'x.pdf', mime: 'application/pdf', bytes: new Uint8Array([1]) })).errors).toEqual([MSG.type])
    expect((await attachBytes(deps, dir, { name: 'x.png', mime: 'image/png', bytes: new Uint8Array(0) })).errors).toEqual([MSG.failed])
    expect((await attachBytes(deps, dir, { name: 'x.png', mime: 'image/png', bytes: 'nope' })).errors).toEqual([MSG.failed])
    expect(calls).toEqual([]) // nothing reached the engine
  })
  it('an engine refusal comes back as its plain words', async () => {
    const dir = project()
    const runEngine: any = async () => {
      throw { code: 'ATTACH_TOO_LONG', userMessage: 'That clip is too long. Use one that is 1 minute or shorter.' }
    }
    const r = await attachPaths({ runEngine, log: () => undefined }, dir, [{ path: 'C:\\long.mp4' }])
    expect(r).toEqual({ attached: [], errors: ['That clip is too long. Use one that is 1 minute or shorter.'] })
  })
})

describe('main: the IPC handlers', () => {
  function wire(dir: string, busy = false) {
    const h = new Map<string, (...a: any[]) => any>()
    const calls: string[][] = []
    const runEngine: any = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return { asset: fakeAttach(dir) }
    }
    registerAttachmentIpc({
      handle: (ch, fn) => h.set(ch, fn as any),
      runEngine,
      log: () => undefined,
      projectDir: () => dir,
      readProject: async () => ({ broll: [] }) as any,
      reserve: async (slug, fn) => {
        if (busy) throw { code: 'BUSY', userMessage: 'I am still working on this video. Give me a moment, or press Stop.' }
        return fn('test-owner')
      },
      clipboardImage: async () => null,
      choose: async () => null
    })
    return (ch: string, ...a: unknown[]) => h.get(ch)!({} as any, ...a)
  }
  it('attach, an empty clipboard, a cancelled picker, remove', async () => {
    const dir = project()
    const call = wire(dir)
    const r = await call('notes:attachFiles', 'slug', ['C:\a.png', 42])
    expect(r.attached).toHaveLength(1)
    expect(await call('notes:attachClipboard', 'slug')).toEqual({ attached: [], errors: [MSG.noPicture] })
    expect(await call('notes:chooseAttachment', 'slug')).toEqual({ attached: [], errors: [] })
    await call('notes:removeAttachment', 'slug', r.attached[0].asset)
    expect(existsSync(join(dir, ...r.attached[0].asset.split('/')))).toBe(false)
  })
  it('refuses while a job runs on the video, and for a folder with no project', async () => {
    const call = wire(project(), true)
    await expect(call('notes:attachFiles', 'slug', ['C:\a.png'])).rejects.toMatchObject({ code: 'BUSY' })
    await expect(call('notes:removeAttachment', 'slug', 'work/assets/attach-00000000-x.png')).rejects.toMatchObject({ code: 'BUSY' })
    const gone = wire(join(tmpdir(), 'no such project here'))
    await expect(gone('notes:attachData', 'slug', {})).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

// The real engine, when a dev venv is pointed at (proves main <-> engine `attach` end to end):
//   REELSTUDIO_REAL_ENGINE_DIR=<repo>/engine [REELSTUDIO_REAL_PYTHON=<python>] npx vitest run test/attachments.test.ts
const ENGINE = process.env.REELSTUDIO_REAL_ENGINE_DIR
describe.skipIf(!ENGINE)('real engine attach through the runner', () => {
  it('a pasted PNG (bytes) and a rejected file', async () => {
    const py = process.env.REELSTUDIO_REAL_PYTHON ?? join(ENGINE!, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    const runEngine = createEngineRunner({ python: () => py, env: () => ({ ...process.env, PYTHONPATH: ENGINE! }), cwd: () => ENGINE!, log: () => undefined })
    const dir = project()
    // a real 8x8 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC',
      'base64'
    )
    const r = await attachBytes({ runEngine, log: () => undefined }, dir, { name: '', mime: 'image/png', bytes: new Uint8Array(png) })
    expect(r.errors).toEqual([])
    expect(r.attached[0]).toMatchObject({ kind: 'image', name: 'Pasted picture.png', width: 8, height: 8 })
    expect(isAttachmentRef(r.attached[0].asset)).toBe(true)
    expect(existsSync(join(dir, ...r.attached[0].thumb!.split('/')))).toBe(true)
    const bad = join(dir, '..', 'broken.png')
    writeFileSync(bad, 'not a png')
    const r2 = await attachPaths({ runEngine, log: () => undefined }, dir, [{ path: bad }])
    expect(r2.attached).toEqual([])
    expect(r2.errors[0]).toMatch(/couldn't open that file/)
  }, 60_000)
})
