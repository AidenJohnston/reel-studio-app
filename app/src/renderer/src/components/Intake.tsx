import { useRef } from 'react'
import { Icon } from './icons'
import { usePresence } from './motion'
import { IS_MAC } from './ui'
import './intake.css'

// the same list as main/library.ts VIDEO_EXT
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|3gp)$/i
const PICTURE_EXT = /\.(jpe?g|png|heic|heif|gif|webp|tiff?)$/i
const SONG_EXT = /\.(mp3|m4a|aac|wav|aiff?|flac|ogg)$/i

/** "a picture", "a PDF file": what a dropped thing is, when it is not a video. */
function whatItIs(path: string): string {
  if (PICTURE_EXT.test(path)) return 'a picture'
  if (SONG_EXT.test(path)) return 'a song'
  if (/\.pdf$/i.test(path)) return 'a PDF file'
  if (/\.(txt|md|rtf)$/i.test(path)) return 'a text file'
  const ext = /\.([a-z0-9]{1,4})$/i.exec(path)?.[1]
  return ext ? `a ${ext.toUpperCase()} file` : 'a file'
}

/** The same, from a dragged item's type: while a file is over the window, its name is not readable yet. */
function whatType(mime: string): string {
  if (mime.startsWith('image/')) return 'a picture'
  if (mime.startsWith('audio/')) return 'a song'
  if (mime === 'application/pdf') return 'a PDF file'
  if (mime.startsWith('text/')) return 'a text file'
  return 'a file'
}

type Kind = 'video' | 'media' | 'other'
const kindOf = (path: string): Kind => (VIDEO_EXT.test(path) ? 'video' : PICTURE_EXT.test(path) || SONG_EXT.test(path) ? 'media' : 'other')
// a type the system did not name (some cameras' .mts) may well be a video: the drop itself checks the file name
const kindOfType = (mime: string): Kind =>
  !mime || mime.startsWith('video/') ? 'video' : mime.startsWith('image/') || mime.startsWith('audio/') ? 'media' : 'other'

/** What a drop will do, said before it happens (ux-foundation-b.md section 8, "Drop overlay"). */
export type Intent =
  | { kind: 'reel' }
  | { kind: 'note'; rect: DOMRect }
  /** a reel with no video yet, under the pointer: the video becomes this reel's */
  | { kind: 'this-reel'; rect: DOMRect }
  | { kind: 'library' }
  | { kind: 'refuse'; what: string; where: 'reel' | 'anywhere' }

/**
 * `screen`: the screen under the drag. `note`: the reel's notes column, when the pointer is over it (an element
 * marked `data-note-drop`, which takes the drop itself; on a reel with no video yet it is marked `data-video-drop`). One video among
 * the files makes a reel; the rest go to the Library.
 */
export function intentFor(files: { kind: Kind; what: string }[], screen: string, note: Element | null): Intent {
  const video = files.some((f) => f.kind === 'video')
  const media = files.some((f) => f.kind === 'media')
  if (note?.hasAttribute('data-video-drop')) return video ? { kind: 'this-reel', rect: note.getBoundingClientRect() } : { kind: 'refuse', what: files[0]?.what ?? 'a file', where: 'anywhere' }
  if (note && (video || media)) return { kind: 'note', rect: note.getBoundingClientRect() }
  if (screen === 'library') return { kind: 'library' }
  if (video) return { kind: 'reel' }
  if (media && screen !== 'reel') return { kind: 'library' }
  return { kind: 'refuse', what: files[0]?.what ?? 'a file', where: media ? 'reel' : 'anywhere' }
}

export const draggedFiles = (dt: DataTransfer): { kind: Kind; what: string }[] =>
  Array.from(dt.items)
    .filter((i) => i.kind === 'file')
    .map((i) => ({ kind: kindOfType(i.type), what: whatType(i.type) }))

export const droppedFiles = (paths: string[]): { kind: Kind; what: string }[] => paths.map((p) => ({ kind: kindOf(p), what: whatItIs(p) }))

export type Veil = { kind: 'over'; intent: Intent } | { kind: 'refused'; intent: Extract<Intent, { kind: 'refuse' }> }

const HERE = IS_MAC ? 'this Mac' : 'this PC'

function Words({ intent }: { intent: Intent }) {
  if (intent.kind === 'reel')
    return (
      <>
        <h2>Make a reel</h2>
        <p>Your video stays on {HERE}.</p>
      </>
    )
  if (intent.kind === 'library')
    return (
      <>
        <h2>Add to Library</h2>
        <p>Pictures and songs your editor can use in any reel.</p>
      </>
    )
  if (intent.kind === 'note') return <h2>Attach to your note</h2>
  if (intent.kind === 'this-reel') return <h2>Use it for this reel</h2>
  return (
    <>
      <h2>That’s {intent.what}, not a video</h2>
      <p>{intent.where === 'reel' ? 'Drop it on your notes to use it in this reel.' : 'Drop a video, like a .mov from your phone.'}</p>
    </>
  )
}

/**
 * While a file is dragged over the window, the window says what letting go will do. Over a reel's notes column only
 * that column answers, so the reel stays in view. A refused drop keeps the reason up for a moment.
 */
export function DropVeil({ veil }: { veil: Veil | null }) {
  const { mounted, leaving } = usePresence(!!veil, 150)
  // what it said stays while it fades out
  const kept = useRef(veil)
  if (veil) kept.current = veil
  const last = kept.current
  if (!mounted || !last) return null
  const intent = last.intent
  const bad = intent.kind === 'refuse'
  const r = intent.kind === 'note' || intent.kind === 'this-reel' ? intent.rect : null
  return (
    <div
      className={`dropveil${leaving ? ' leave' : ''}${r ? ' on-note' : ''}${bad ? ' bad' : ''}`}
      data-testid="drop-overlay"
      data-intent={intent.kind}
      role={last.kind === 'refused' ? 'alert' : undefined}
      aria-hidden={last.kind === 'over' || undefined}
    >
      <div className="target" style={r ? { left: r.left, top: r.top, width: r.width, height: r.height } : undefined}>
        <Icon name={bad ? 'alert' : intent.kind === 'note' ? 'paperclip' : intent.kind === 'library' ? 'image' : 'video'} size={18} />
        <Words intent={intent} />
      </div>
    </div>
  )
}

/** The player a new reel opens in (components/Phone.tsx): where a dropped video's thumbnail lands. */
export const LANDS = 'data-lands'

const FLY_MS = 220
const FLY_EASE = 'cubic-bezier(.2, .8, .2, 1)'
/** How long the flight waits for the reel's screen to show its player before it fades where it is. */
const WAIT_MS = 600

export interface Flight {
  land(): void
  cancel(): void
}

/**
 * A dropped video's thumbnail: it appears under the pointer, then, once the new reel's screen is up, flies into its
 * player (transform and opacity only) and hands over to it. Any click or key finishes it at once.
 */
export function launchFlight(file: File | null, x: number, y: number): Flight {
  const node = document.createElement('div')
  node.className = 'flyer'
  node.setAttribute('aria-hidden', 'true')
  const w = 72
  const h = 128
  Object.assign(node.style, { left: `${x - w / 2}px`, top: `${y - h / 2}px`, width: `${w}px`, height: `${h}px` })
  let url: string | null = null
  if (file) {
    url = URL.createObjectURL(file)
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'metadata'
    v.src = `${url}#t=0.1`
    v.addEventListener('loadeddata', () => node.classList.add('framed'), { once: true })
    node.append(v)
  }
  document.body.append(node)
  const running: Animation[] = [node.animate([{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 120, easing: FLY_EASE })]
  let done = false
  let shown: HTMLElement | null = null
  const end = () => {
    if (done) return
    done = true
    for (const a of running) a.cancel()
    node.remove()
    if (shown) shown.style.opacity = ''
    if (url) URL.revokeObjectURL(url)
    window.removeEventListener('pointerdown', end, true)
    window.removeEventListener('keydown', end, true)
  }
  window.addEventListener('pointerdown', end, true)
  window.addEventListener('keydown', end, true)
  const fade = () => {
    const a = node.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: 'ease-out', fill: 'forwards' })
    running.push(a)
    a.onfinish = end
  }
  return {
    cancel: () => (done ? undefined : fade()),
    land: () => {
      const t0 = performance.now()
      const seek = () => {
        if (done) return
        const el = document.querySelector<HTMLElement>(`[${LANDS}]`)
        const to = el?.getBoundingClientRect()
        if (!el || !to || to.width < 8) return performance.now() - t0 < WAIT_MS ? void requestAnimationFrame(seek) : fade()
        const from = node.getBoundingClientRect()
        // the flyer takes the player's box at once and starts scaled down onto where it was: one scale, no reflow
        Object.assign(node.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` })
        const k = from.width / to.width
        const dx = from.left + from.width / 2 - (to.left + to.width / 2)
        const dy = from.top + from.height / 2 - (to.top + to.height / 2)
        shown = el
        el.style.opacity = '0'
        const a = node.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${k})` }, { transform: 'none' }], { duration: FLY_MS, easing: FLY_EASE, fill: 'forwards' })
        running.push(a)
        a.onfinish = () => {
          if (shown) shown.style.opacity = ''
          fade()
        }
      }
      requestAnimationFrame(seek)
    }
  }
}
