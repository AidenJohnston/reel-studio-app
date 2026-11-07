// A home folder with Final Cut Pro and Premiere Pro edits where the editors leave them, plus the copies and
// look-alikes discovery must leave out. Used by test/past-edits.test.ts and e2e/my-style.spec.ts.
// The video folder is Movies on a Mac and Videos elsewhere, the one the finder walks there (main past-edits.ts START):
// a Windows home has no Movies, and the finder rightly never looks for one.
import { copyFileSync, cpSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'

const REF = join(__dirname, '..', '..', 'engine', 'tests', 'fixtures', 'reference-import')

/** The home's video folder on `platform`: where its Final Cut Pro exports and library sit. */
export const videoFolder = (platform: NodeJS.Platform = process.platform): string => (platform === 'darwin' ? 'Movies' : 'Videos')

/** Files written under `home`, each with the day it last changed (October 2026), newest first. */
export function makePastEditsHome(home: string, platform: NodeJS.Platform = process.platform): void {
  const movies = videoFolder(platform)
  const put = (rel: string, day: number, write: (p: string) => void): void => {
    const p = join(home, rel)
    mkdirSync(dirname(p), { recursive: true })
    write(p)
    const t = new Date(Date.UTC(2026, 9, day, 12))
    utimesSync(p, t, t)
  }
  const library = (p: string): void => {
    mkdirSync(p)
    writeFileSync(join(p, 'CurrentVersion.flexolibrary'), 'library')
  }
  const project = (p: string): void => writeFileSync(p, gzipSync('<?xml version="1.0"?><PremiereData Version="3"/>'))

  put(`${movies}/Exports/Spring launch.fcpxml`, 26, (p) => copyFileSync(join(REF, 'ntsc-lanes.fcpxml'), p))
  put(`${movies}/Untitled.fcpbundle`, 24, library)
  put('Desktop/talking-head.xml', 22, (p) => copyFileSync(join(REF, 'talking-head.xml'), p))
  put('Documents/Adobe/Premiere Pro/26.0/Interview.prproj', 20, project)
  put(`${movies}/Exports/Kitchen tour.fcpxmld`, 18, (p) => cpSync(join(REF, 'cut.fcpxmld'), p, { recursive: true }))

  // left out: the editors' own copies, a hidden folder, and XML Premiere Pro didn't write
  put('Documents/Adobe/Premiere Pro/26.0/Adobe Premiere Pro Auto-Save/Interview--1.prproj', 27, project)
  put(`${movies}/Final Cut Backups.localized/Untitled/2026-10-24.fcpbundle`, 27, library)
  put('Documents/.old/Spring launch copy.fcpxml', 27, (p) => copyFileSync(join(REF, 'ntsc-lanes.fcpxml'), p))
  put('Documents/settings.xml', 27, (p) => writeFileSync(p, '<?xml version="1.0"?><settings/>'))
}
