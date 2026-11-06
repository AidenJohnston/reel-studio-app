// What kind of device the companion page is open on: for the name it pairs under ("iPhone", "Chrome on Windows"),
// the word its messages use for itself, and which "save to Photos" steps it shows. Read from the user agent because
// the computer's Settings > Phone and browser list needs a name before any other signal exists; nothing here decides behaviour.

export type Platform = 'iphone' | 'ipad' | 'android' | 'other'

const ua = (): string => (typeof navigator === 'undefined' ? '' : navigator.userAgent)
// An iPad asks for the desktop site and says "Macintosh"; only its touch screen tells it apart from a Mac.
const touchPoints = (): number => (typeof navigator === 'undefined' ? 0 : (navigator.maxTouchPoints ?? 0))

export function platform(): Platform {
  const s = ua()
  if (/iPhone|iPod/.test(s)) return 'iphone'
  if (/iPad/.test(s) || (/Macintosh/.test(s) && touchPoints() > 1)) return 'ipad'
  if (/Android/.test(s)) return 'android'
  return 'other'
}

/** The name the computer lists this device under, at most 60 characters (POST /api/pair). */
export function deviceName(): string {
  const s = ua()
  const p = platform()
  if (p === 'iphone') return 'iPhone'
  if (p === 'ipad') return 'iPad'
  if (p === 'android') return /Mobile/.test(s) ? 'Android phone' : 'Android tablet'
  // Order matters: Edge and Opera also say Chrome, and Chrome also says Safari.
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Browser'
  const os = /Windows/.test(s) ? 'Windows' : /Macintosh|Mac OS X/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'Chromebook' : /Linux/.test(s) ? 'Linux' : null
  return (os ? `${browser} on ${os}` : browser).slice(0, 60)
}

/** How the page names itself in a sentence: "This phone can watch only." */
export function noun(): string {
  const p = platform()
  if (p === 'iphone') return 'phone'
  if (p === 'ipad') return 'iPad'
  if (p === 'android') return /Mobile/.test(ua()) ? 'phone' : 'tablet'
  return 'browser'
}
