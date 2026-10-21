/** "anim-big-quote-2.mov" -> "Moving big quote"; never a computer file name (grandma 2). */
export function animationName(asset: string): string | null {
  const m = /(?:^|[\/])(?:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}-)*anim-([a-z0-9-]+?)(?:-\d+)?\.(?:mov|webm|mp4)$/i.exec(asset)
  if (!m) return null
  return `Moving ${m[1].replace(/-/g, ' ')}`
}
