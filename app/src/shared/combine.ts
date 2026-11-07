// Combining two versions (Versions > Combine): the parts in the person's words, and the line the notes show for it.
// Keep free of Node and DOM imports.
import { MERGE_LAYERS, type MergeLayer, type MergeRequest } from './api'

/** What each part is called on screen, in the order the Combine dialog lists them. */
export const LAYER_WORDS: Record<MergeLayer, string> = {
  cut: 'The cut',
  captions: 'Subtitles',
  music: 'Music',
  zooms: 'Zooms',
  broll: 'Pictures and animations',
  sfx: 'Sound effects',
  cover: 'Cover'
}

/** "Version 4, with the music and subtitles from Version 6": what was asked, as the notes say it. */
export function mergeWords(r: MergeRequest): string {
  const theirs = MERGE_LAYERS.filter((l) => r.take[l] === 'theirs').map((l) => LAYER_WORDS[l].toLowerCase().replace(/^the /, ''))
  if (!theirs.length) return `Version ${r.ours} again, as a new version`
  const list = theirs.length === 1 ? theirs[0] : `${theirs.slice(0, -1).join(', ')} and ${theirs.at(-1)}`
  return `Version ${r.ours}, with the ${list} from Version ${r.theirs}`
}
