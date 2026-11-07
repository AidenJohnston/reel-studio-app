// The editors whose exports My style can learn from. Keep free of Node and DOM imports: main and the renderer share it.

/** Final Cut Pro's FCPXML, Premiere Pro's XML, DaVinci Resolve's FCPXML or EDL, and CapCut's own project. Final Cut
 * Pro is a Mac app, so elsewhere it is left out. */
export const styleEditors = (isMac: boolean): string =>
  isMac ? 'Final Cut Pro, Premiere Pro, DaVinci Resolve or CapCut' : 'Premiere Pro, DaVinci Resolve or CapCut'

/** The file picker that learns from past edits: its title and its file-type name. A CapCut project is read as it is,
 * so the title asks for edits, not exports. */
export function learnPicker(isMac: boolean): { title: string; filter: string } {
  return { title: `Choose edits from ${styleEditors(isMac)}`, filter: 'Exports and CapCut projects' }
}
