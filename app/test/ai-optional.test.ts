import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@reelstudio/ai', () => { throw new Error('AI package is not installed') })

import { loadAI, recoverNoteStaging, withProjectLock } from '../src/main/ai'
import { readProject } from '../src/main/store'
import { setupPaths } from './helpers'

it('keeps project access and recovery working when the optional AI package is absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'rs-ai-absent-'))
  try {
    const { root } = setupPaths(home)
    const project = join(root, 'Projects', 'clip')
    await mkdir(join(project, '.staging', 'old'), { recursive: true })
    await mkdir(join(project, 'versions', 'v2'), { recursive: true })
    await writeFile(join(project, 'project.json'), JSON.stringify({ version: 1, title: 'Original' }))
    await withProjectLock(project, async () => {
      expect((await readProject('clip')).title).toBe('Original')
    })
    await recoverNoteStaging(project)
    await expect(readFile(join(project, '.staging', 'old'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(project, 'versions', 'v2'))).rejects.toMatchObject({ code: 'ENOENT' })
    const manifest = join(project, '.staging', 'pending', 'publication.json')
    await mkdir(join(project, '.staging', 'pending'), { recursive: true })
    await writeFile(manifest, '{"version":2,"assets":["work/assets/pending-image.png"]}')
    await recoverNoteStaging(project)
    expect(await readFile(manifest, 'utf8')).toContain('pending-image.png')
    const loaded = await loadAI({ settingsDir: join(home, 'settings'), host: {
      reelStudioRoot: () => root,
      runEngine: async () => { throw new Error('No engine was requested') },
      renderAnimation: async () => { throw new Error('No animation was requested') }
    } }, () => {})
    expect(loaded.source).toBe('mock')
    expect((await loaded.ai.active()).id).toBe('none')
    await expect(loaded.ai.applyNote(project, 'smaller captions', () => {})).rejects.toMatchObject({ code: 'NO_AI' })
  } finally { await rm(home, { recursive: true, force: true }) }
})
