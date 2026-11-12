import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// One still per this many seconds of the reel, and no more than MAX_FRAMES in all: a long reel spreads them out.
const EVERY_S = 1
const MAX_FRAMES = 120
// The stills' height in device pixels, enough for a 2x screen at the lane's height.
const FRAME_H = 96

/**
 * Stills of a version's video, read once from a hidden copy of it (the player's own video is never seeked), one per
 * second. They come in as they are read; the strip draws what it has.
 */
function useStills(src: string, duration: number): { every: number; frames: (ImageBitmap | null)[] } {
  const [stills, setStills] = useState<{ every: number; frames: (ImageBitmap | null)[] }>({ every: EVERY_S, frames: [] })
  useEffect(() => {
    if (!duration) return
    const n = Math.max(2, Math.min(MAX_FRAMES, Math.ceil(duration / EVERY_S) + 1))
    const every = duration / (n - 1)
    const frames: (ImageBitmap | null)[] = Array(n).fill(null)
    setStills({ every, frames: [...frames] })
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.src = src
    let stopped = false
    const seek = (t: number) =>
      new Promise<void>((resolve, reject) => {
        v.addEventListener('seeked', () => resolve(), { once: true })
        v.addEventListener('error', () => reject(new Error('the video could not be read')), { once: true })
        v.currentTime = t
      })
    void (async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          v.addEventListener('loadeddata', () => resolve(), { once: true })
          v.addEventListener('error', () => reject(new Error('the video could not be read')), { once: true })
        })
        for (let i = 0; i < n && !stopped; i++) {
          // just inside the end: the very last instant has no frame to show
          await seek(Math.min(i * every, Math.max(0, v.duration - 0.05)))
          if (stopped) return
          frames[i] = await createImageBitmap(v, { resizeHeight: FRAME_H, resizeQuality: 'medium' })
          // a few stills at a time, so the strip fills in without a render per still
          if (i % 8 === 7 || i === n - 1) setStills({ every, frames: [...frames] })
        }
      } catch {
        // no stills: the lane stays plain
      }
    })()
    return () => {
      stopped = true
      v.removeAttribute('src')
      v.load()
      for (const f of frames) f?.close()
    }
  }, [src, duration])
  return stills
}

/** The stills along your video's lane, drawn for the part of it in view: as in an editor, one tile after another. */
export function Filmstrip({ src, duration, pps, left, width }: { src: string; duration: number; pps: number; left: number; width: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const { every, frames } = useStills(src, duration)
  useLayoutEffect(() => {
    const c = canvas.current
    if (!c || !width || !pps) return
    const dpr = window.devicePixelRatio || 1
    const h = c.clientHeight
    c.width = Math.round(width * dpr)
    c.height = Math.round(h * dpr)
    const g = c.getContext('2d')
    if (!g) return
    g.clearRect(0, 0, c.width, c.height)
    const first = frames.find((f) => f)
    if (!first) return
    const tileW = (h * first.width) / first.height
    // tiles sit on fixed places along the whole reel, so scrolling slides them rather than redrawing new ones
    for (let x = Math.floor(left / tileW) * tileW; x < left + width && x < duration * pps; x += tileW) {
      const f = frames[Math.round(x / pps / every)] ?? frames.find((y) => y)
      if (f) g.drawImage(f, (x - left) * dpr, 0, tileW * dpr, h * dpr)
    }
  }, [frames, every, pps, left, width, duration])
  return <canvas className="trk-film" ref={canvas} style={{ left, width }} aria-hidden data-testid="track-film" />
}
