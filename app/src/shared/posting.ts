// Posting a finished video to YouTube: the words and the small decisions, kept free of React, Electron and the
// network so they are unit-tested (test/posting-copy.test.ts). main/posting.ts throws these errors; the Post sheet
// (components/PostSheet.tsx) and Settings > Posting (components/PostingSettings.tsx) show this copy.
import type { ConnectOutcome, PendingPost, PostingStatus, PostPrivacy, PostProgress, UserError } from './api'
import { SITE_URL } from './config'

export type PostingErrorCode =
  | 'POSTING_OFF'
  | 'NO_KEY'
  | 'BAD_KEY'
  | 'ENDED'
  | 'SIGNED_OUT'
  | 'NOT_CONNECTED'
  | 'RECONNECT'
  | 'NO_CHANNEL'
  | 'QUOTA'
  | 'UPLOAD_LIMIT'
  | 'RATE_LIMITED'
  | 'EXPIRED'
  | 'BAD_FIELD'
  | 'OFFLINE'
  | 'PLATFORM'
  | 'NOT_CONFIGURED'
  | 'SERVER'
  | 'NOT_A_FINISHED_VIDEO'
  | 'FILE_CHANGED'
  | 'BUSY'

export const POSTING_ERRORS: Record<Exclude<PostingErrorCode, 'BAD_FIELD'>, string> = {
  POSTING_OFF: "Posting isn't turned on in this version of Reel Studio.",
  NO_KEY: 'Posting uses the download key from your receipt email. Copy the link from that email, then click Paste my download link.',
  BAD_KEY: "The posting server doesn't recognise this download key. Copy the link from your receipt email again and paste it.",
  ENDED: 'Posting needs an active subscription, and yours has ended.',
  SIGNED_OUT: 'This computer is signed out of posting. Click Sign in to post again.',
  NOT_CONNECTED: 'Connect your YouTube channel first.',
  RECONNECT:
    "YouTube needs you to connect again. Google asks for this every week until Reel Studio's YouTube access is approved, and after you remove access in your Google account.",
  NO_CHANNEL: 'That Google account has no YouTube channel yet. Create one at youtube.com, then connect again.',
  QUOTA: "YouTube's daily limit for videos posted through Reel Studio is used up. Try again tomorrow, or upload this one at studio.youtube.com.",
  UPLOAD_LIMIT: "YouTube says your channel can't take more videos today. Try again tomorrow.",
  RATE_LIMITED: 'Too many tries in a row. Wait a minute, then try again.',
  EXPIRED: 'YouTube stopped waiting for the rest of this video. Click Post to YouTube to send it again from the start.',
  OFFLINE: "Reel Studio can't reach its posting server. Check your internet connection, then click Finish posting.",
  PLATFORM: "YouTube didn't take the video. Try again in a few minutes.",
  NOT_CONFIGURED: "Posting to YouTube isn't switched on yet. Try again later.",
  SERVER: 'Something went wrong on the posting server. Try again in a few minutes.',
  NOT_A_FINISHED_VIDEO: 'Only a finished video can be posted. Export it first.',
  FILE_CHANGED: 'The video changed since this post started. Click Start over.',
  BUSY: 'Another video is being posted. Wait for it to finish.'
}

export type PostField = 'title' | 'description' | 'privacy'

export const FIELD_ERRORS: Record<PostField, string> = {
  title: 'YouTube needs a title of up to 100 characters, without < or >.',
  description: 'The description is too long for YouTube, or has < or > in it.',
  privacy: "YouTube didn't accept that choice of who can see it. Pick Only me and try again."
}

export const PRICING_URL = `${SITE_URL}/#pricing`

/** The user error for a code, with the subscribe link for ENDED. */
export function postingError(code: PostingErrorCode, field?: PostField): UserError & { field?: PostField } {
  if (code === 'BAD_FIELD') {
    const f = field ?? 'title'
    return { code, userMessage: FIELD_ERRORS[f], field: f }
  }
  return { code, userMessage: POSTING_ERRORS[code], ...(code === 'ENDED' ? { link: PRICING_URL } : {}) }
}

// ---- the form ------------------------------------------------------------------------------------

export const TITLE_MAX = 100
export const DESCRIPTION_MAX_BYTES = 5000
/** YouTube shows a square or vertical video up to 3 minutes long as a Short. */
export const SHORT_MAX_SEC = 180

export const PRIVACY_CHOICES: { value: PostPrivacy; label: string }[] = [
  { value: 'private', label: 'Only me' },
  { value: 'unlisted', label: 'Anyone with the link' },
  { value: 'public', label: 'Everyone' }
]
export const privacyLabel = (p: PostPrivacy): string => PRIVACY_CHOICES.find((c) => c.value === p)?.label ?? 'Only me'

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length

/** The inline line under Title, or null when it is fine. */
export function titleProblem(title: string): string | null {
  const t = title.trim()
  if (!t) return 'Give it a title first.'
  if (/[<>]/.test(t)) return "YouTube doesn't allow < or > in a title."
  if (t.length > TITLE_MAX) return FIELD_ERRORS.title // UTF-16 units, the same count as the input's maxLength
  return null
}

export function descriptionProblem(description: string): string | null {
  if (/[<>]/.test(description) || utf8Bytes(description) > DESCRIPTION_MAX_BYTES) return FIELD_ERRORS.description
  return null
}

/** The reel's title, made fit for YouTube: no < or >, at most 100 characters. */
export function defaultTitle(title: string): string {
  const chars = [...title.replace(/[<>]/g, '').trim()]
  while (chars.join('').length > TITLE_MAX) chars.pop() // never splits an emoji in half
  return chars.join('').trim()
}

/** The export caption, made fit for YouTube's description (no < or >, at most 5,000 bytes). */
export function defaultDescription(caption: string): string {
  let d = caption.replace(/[<>]/g, '').trim()
  while (utf8Bytes(d) > DESCRIPTION_MAX_BYTES) d = [...d].slice(0, -1).join('')
  return d
}

// ---- the sheet -----------------------------------------------------------------------------------

export type SheetState = 'loading' | 'no_key' | 'ended' | 'signed_out' | 'not_connected' | 'reconnect' | 'connecting' | 'resume' | 'form' | 'sending' | 'retrying' | 'failed' | 'done'

/**
 * Which screen the Post sheet shows. A running or finished post wins (its progress), then the account problems
 * in the order the person has to fix them, then a stopped post of this version, then the form.
 */
export function sheetState(s: PostingStatus | null, o: { progress?: PostProgress | null; pending?: PendingPost | null; connecting?: boolean; editing?: boolean }): SheetState {
  const p = o.progress
  if (p && !o.editing) {
    if (p.step === 'starting' || p.step === 'sending') return 'sending'
    if (p.step === 'retrying') return 'retrying'
    if (p.step === 'done') return 'done'
    if (p.step === 'failed') return 'failed'
  }
  if (!s) return 'loading'
  if (o.connecting || s.connecting) return 'connecting'
  if (s.ended) return 'ended'
  if (!s.hasKey && !s.signedIn) return 'no_key'
  if (s.signedOutByServer && !s.signedIn) return 'signed_out'
  if (!s.youtube) return 'not_connected'
  if (s.youtube.state === 'reconnect') return 'reconnect'
  if (o.pending) return 'resume'
  return 'form'
}

/** The note above Connect YouTube after a connect that didn't work. null = nothing to say. */
export const CONNECT_NOTES: Record<ConnectOutcome, string | null> = {
  connected: null,
  cancelled: null,
  denied: "You didn't allow it, so nothing changed.",
  missing_permission: 'Google didn\'t give permission to upload videos. Click Connect YouTube and leave "Manage your YouTube videos" ticked.',
  no_channel: 'That Google account has no YouTube channel yet. Create one at youtube.com, then connect again.',
  expired: 'That took too long. Click Connect YouTube to try again.',
  failed: "YouTube couldn't be connected. Try again in a minute."
}

export const POST_COPY = {
  heading: 'Post to YouTube',
  noKey: 'Posting uses the download key from your receipt email, so the posting server knows you subscribe. Copy the link from that email, then paste it here.',
  ended: 'Posting needs an active subscription, and yours has ended.',
  signedOut: 'This computer was signed out of posting, maybe with Sign out everywhere. Sign in again to post.',
  notConnected: 'Connect your YouTube channel once. You sign in on Google\'s own page, and Reel Studio never sees your password. Reel Studio posts only when you click Post.',
  reconnect: "YouTube needs you to connect again. Google asks for this every week until Reel Studio's YouTube access is approved.",
  connecting: "Finish in your browser. I opened Google's page: pick your channel, then click Allow.",
  notThisChannel: 'Not this channel? Change it in Settings.',
  descriptionHelp: 'Shown under your video on YouTube.',
  privacyHelp: 'Start with Only me: check it in YouTube Studio, then make it public there.',
  kidsHelp: 'YouTube asks every channel to say this. Tick it only if the video is made for children.',
  notAShort: 'This video is longer than 3 minutes, so YouTube will show it as a regular video, not a Short.',
  keepOpen: "Keep Reel Studio open until it's done.",
  stopTitle: 'Stop posting?',
  stopBody: "What's been sent so far is thrown away.",
  doneHeading: 'Posted to YouTube',
  getsReady: 'YouTube takes a few minutes to get it ready to play.'
} as const

export const TERMS_URL = 'https://www.youtube.com/t/terms'

/** What the done screen says about who can see it. */
export const DONE_PRIVACY: Record<PostPrivacy, string> = {
  private: "It's on your channel as Only me. Check it in YouTube Studio, then make it public there when you're ready.",
  unlisted: 'Anyone with the link can watch it.',
  public: "It's live on your channel."
}

/** YouTube set something other than what was asked (it can, for a project it hasn't verified). */
export function privacyChanged(asked: PostPrivacy, got: PostPrivacy): string | null {
  return asked === got ? null : `YouTube set it to ${privacyLabel(got)} instead. You can change it in YouTube Studio.`
}

export const pct = (sent: number, total: number): number => (total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0)
export const megabytes = (n: number): string => `${Math.round(n / 1_000_000)}`

export const SETTINGS_COPY = {
  heading: 'Posting',
  intro: 'Post a finished video to your channels from Reel Studio. It posts only when you click Post.',
  coming: 'Instagram, TikTok, Facebook, LinkedIn and X are coming.',
  privacy: "Your Google sign-in stays on Reel Studio's posting server, never on this computer. Your video passes through it to YouTube and isn't kept.",
  noKey: 'Signing in uses the download key from your receipt email.',
  disconnectTitle: 'Disconnect YouTube?',
  everywhereTitle: 'Sign out everywhere?',
  everywhereBody: 'Every computer that posts with your download key is signed out, this one too. Your YouTube connection stays. Sign in again to post.'
} as const

export const disconnectBody = (channelName: string | null): string =>
  `Reel Studio removes its access to ${channelName ?? 'your channel'} and deletes what it kept. Your videos stay on YouTube.`

export function signedInLine(otherComputers: number): string {
  if (otherComputers <= 0) return 'Signed in on this computer.'
  return `Signed in on this computer. And on ${otherComputers} other computer${otherComputers === 1 ? '' : 's'}.`
}
